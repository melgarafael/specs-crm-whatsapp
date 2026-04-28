# 07 — Eventos e comunicação inter-módulos

> **Resumo:** como o CRM-core publica e consome eventos. Padrão `event_log` + Postgres triggers + LISTEN/NOTIFY ou Supabase Realtime; webhooks externos com idempotência cross-modular; padrão de atividades polimórficas (`crm_lead_activities` recebe eventos de qualquer módulo via `source_module` + `source_id`); exemplo end-to-end (mensagem WhatsApp recebida → lead activity → notifica owner); webhooks de saída pra Zapier/Make.

---

## 1. Por que eventos

CRM-core **não chama** os módulos satélites diretamente. Acopla via **eventos**. Razões:

| Sem eventos (chamada direta) | Com eventos |
|------------------------------|-------------|
| Cada módulo precisa importar lib do outro | Módulos não se conhecem |
| Falha em cascata (chat caiu → CRM trava) | Falhas isoladas (event fica na fila) |
| Acoplamento N×N | Acoplamento 1×N (cada módulo só fala com o bus) |
| Replay impossível | Replay trivial (re-processa a tabela) |
| Auditoria custa migrar | Auditoria nativa (event_log é imutável) |

🎯 **Decisão:** todo módulo do ecossistema **publica eventos** quando algo importante acontece. Quem precisa, **consome**. CRM-core consome muitos (pra timeline) e publica muitos (pra automações).

---

## 2. Tabela `event_log` canônica

```sql
create table if not exists public.event_log (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  event_type      text not null,                       -- 'lead.stage_changed', 'message.received', etc.
  entity_kind     text not null,                       -- 'lead', 'message', 'contact', 'appointment'...
  entity_id       text not null,                       -- ID livre (UUID, string composta)

  payload         jsonb not null default '{}'::jsonb,
  metadata        jsonb not null default '{}'::jsonb,  -- {emitted_by, source_module, idempotency_key, ...}

  emitted_at      timestamptz not null default now(),
  -- consumer tracking (opcional, ver 5.2)
  consumed_by     text[] not null default '{}'::text[]
);

create index if not exists idx_event_log_emitted on public.event_log (emitted_at desc);
create index if not exists idx_event_log_org_type
  on public.event_log (organization_id, event_type, emitted_at desc);
create index if not exists idx_event_log_entity
  on public.event_log (entity_kind, entity_id, emitted_at desc);

-- Eventos não consumidos por workers (índice parcial = barato)
create index if not exists idx_event_log_unconsumed
  on public.event_log (event_type, emitted_at)
  where coalesce(array_length(consumed_by, 1), 0) = 0;

comment on table public.event_log is 'Log imutável de eventos de domínio. Fonte da verdade pra reprocessamento, auditoria e comunicação inter-módulos.';
```

⭐ **Relacionamentos potenciais — `event_log`**

| Coluna | Conecta com | Padrão |
|--------|------------|--------|
| `organization_id` | `organizations.id` | FK rígida CASCADE |
| `entity_kind` + `entity_id` | qualquer tabela do ecossistema | poly soft FK |
| `event_type` | enum-like text canônico (vide §4) | padronizar por contrato |
| `payload` | snapshot dos campos relevantes no momento do evento | jsonb com schema por `event_type` |
| `metadata.idempotency_key` | dedupe em consumers | jsonb |
| `consumed_by` | nomes de workers que processaram (ex: `['agent-runtime', 'webhook-dispatcher']`) | string array |

⚠️ **Gotcha:** `event_log` cresce rápido. Particionar por mês ou ter retenção (90 dias) é boa prática. Use `pg_partman` ou rotação manual via cron.

---

## 3. Convenção de nomenclatura de eventos

```
{entity}.{action}
```

Ex:

```
lead.created
lead.updated
lead.stage_changed
lead.won
lead.lost
lead.assigned
lead.unassigned
lead_activity.recorded

contact.created
contact.merged
contact.anonymized            -- LGPD

message.received
message.sent
message.failed
message.read
conversation.opened
conversation.assigned
conversation.resolved

appointment.scheduled
appointment.cancelled
appointment.completed
appointment.no_show

invoice.created
invoice.paid
invoice.overdue
payment.received
```

🎯 **Decisão:** snake_case nas duas partes. Minúsculo. Sem versionamento no nome (use `metadata.version` se precisar evoluir).

---

## 4. Como o CRM-core **publica** eventos

Dois padrões: trigger (preferido) ou app (quando trigger é complicado).

### 4.1 Via trigger Postgres

```sql
create or replace function public.fn_emit_lead_event()
returns trigger language plpgsql as $$
declare
  v_event_type text;
  v_payload    jsonb;
begin
  if (tg_op = 'INSERT') then
    v_event_type := 'lead.created';
    v_payload := to_jsonb(new);
  elsif (tg_op = 'UPDATE') then
    if new.stage_id is distinct from old.stage_id then
      v_event_type := 'lead.stage_changed';
      v_payload := jsonb_build_object(
        'lead_id', new.id,
        'from_stage_id', old.stage_id,
        'to_stage_id', new.stage_id,
        'previous_status', old.status,
        'new_status', new.status,
        'updated_at', new.updated_at
      );
    elsif new.status = 'won' and old.status != 'won' then
      v_event_type := 'lead.won';
      v_payload := jsonb_build_object('lead_id', new.id, 'value_cents', new.value_cents, 'closed_at', new.closed_at);
    elsif new.status = 'lost' and old.status != 'lost' then
      v_event_type := 'lead.lost';
      v_payload := jsonb_build_object('lead_id', new.id, 'lost_reason', new.lost_reason, 'closed_at', new.closed_at);
    elsif new.owner_user_id is distinct from old.owner_user_id then
      v_event_type := 'lead.assigned';
      v_payload := jsonb_build_object('lead_id', new.id, 'old_owner', old.owner_user_id, 'new_owner', new.owner_user_id);
    else
      return new; -- não emite se mudança não é interessante
    end if;
  end if;

  insert into public.event_log (organization_id, event_type, entity_kind, entity_id, payload, metadata)
  values (
    new.organization_id, v_event_type, 'lead', new.id::text, v_payload,
    jsonb_build_object('source_module', 'crm', 'tg_op', tg_op)
  );

  return new;
end;
$$;

drop trigger if exists trg_emit_lead_event on public.crm_leads;
create trigger trg_emit_lead_event
  after insert or update on public.crm_leads
  for each row execute function public.fn_emit_lead_event();
```

### 4.2 Via app (Server Action / Edge Function)

Quando você quer enriquecer o payload com dados que não estão no row sendo modificado:

```ts
import { getSupabaseServerClient } from '@/lib/supabase/server';

export async function emitEvent(args: {
  organizationId: string;
  eventType: string;
  entityKind: string;
  entityId: string;
  payload: Record<string, any>;
  metadata?: Record<string, any>;
}) {
  const supa = getSupabaseServerClient();
  await supa.from('event_log').insert({
    organization_id: args.organizationId,
    event_type: args.eventType,
    entity_kind: args.entityKind,
    entity_id: args.entityId,
    payload: args.payload,
    metadata: args.metadata ?? {},
  });
}

// Uso:
await emitEvent({
  organizationId,
  eventType: 'lead.assigned',
  entityKind: 'lead',
  entityId: leadId,
  payload: { lead_id: leadId, new_owner: userId, assigned_by: actorId },
  metadata: { source_module: 'crm', via: 'manual_ui' },
});
```

⚠️ **Gotcha:** trigger e app **não devem ambos emitir** o mesmo evento — duplica. Escolha um caminho por evento.

---

## 5. Como **consumir** eventos

3 mecanismos principais.

### 5.1 Supabase Realtime (frontend)

```ts
const supa = getSupabaseBrowserClient();

const ch = supa.channel('events-org')
  .on(
    'postgres_changes',
    {
      event: 'INSERT',
      schema: 'public',
      table: 'event_log',
      filter: `organization_id=eq.${orgId}`,
    },
    (payload) => {
      const ev = payload.new;
      if (ev.event_type === 'lead.stage_changed') {
        // Toast, refetch board, etc.
      }
    },
  )
  .subscribe();
```

🎯 **Decisão:** ótimo pra atualizações de UI em tempo real. **Não use** Realtime pra disparar lógica crítica (ex: enviar e-mail). Browser pode estar fechado.

### 5.2 Worker pull-loop (server-side, robusto)

```ts
// Edge Function ou serviço Node rodando em loop
import { getSupabaseServerClient } from '@/lib/supabase/server';

const WORKER_NAME = 'webhook-dispatcher';

export async function processNextBatch() {
  const supa = getSupabaseServerClient();

  const { data: events } = await supa
    .from('event_log')
    .select('*')
    .not('consumed_by', 'cs', `{${WORKER_NAME}}`)   // ainda não processou
    .order('emitted_at', { ascending: true })
    .limit(50);

  for (const ev of events ?? []) {
    try {
      await dispatchToSubscribers(ev);
      // Marca como consumido
      await supa
        .from('event_log')
        .update({ consumed_by: [...(ev.consumed_by ?? []), WORKER_NAME] })
        .eq('id', ev.id);
    } catch (err) {
      console.error('Failed to dispatch event', ev.id, err);
      // Mantém para retry no próximo loop
    }
  }
}
```

⚠️ **Gotcha:** sem `FOR UPDATE SKIP LOCKED`, dois workers podem pegar o mesmo evento. Em escala, considere fila real (Inngest, BullMQ, AWS SQS).

### 5.3 LISTEN/NOTIFY (push do Postgres)

```sql
create or replace function public.fn_notify_event()
returns trigger language plpgsql as $$
begin
  perform pg_notify('events', json_build_object(
    'id', new.id,
    'organization_id', new.organization_id,
    'event_type', new.event_type
  )::text);
  return new;
end;
$$;

drop trigger if exists trg_notify_event on public.event_log;
create trigger trg_notify_event
  after insert on public.event_log
  for each row execute function public.fn_notify_event();
```

Cliente Node:

```ts
import { Client } from 'pg';

const client = new Client({ connectionString: process.env.PG_URL });
await client.connect();
await client.query('LISTEN events');
client.on('notification', (msg) => {
  const data = JSON.parse(msg.payload!);
  // processa
});
```

🎯 **Decisão:** LISTEN/NOTIFY é elegante mas Supabase Realtime já cobre o caso 90% dos times. Use LISTEN/NOTIFY só se você tem worker Node próprio com conexão direta ao Postgres.

---

## 6. Atividades polimórficas: o ponto de unificação

`crm_lead_activities` é **o** consumidor canônico de eventos. Cada satélite que afeta um lead **deveria** emitir uma activity.

📦 **`lib/crm/activity-emitter.ts`**:

```ts
import { getSupabaseServerClient } from '@/lib/supabase/server';

export interface ActivityEvent {
  organizationId: string;
  leadId?: string | null;
  contactId?: string | null;
  type: string;                          // 'whatsapp_inbound', 'email_outbound', 'meeting', etc.
  title?: string;
  body?: string;
  performedAt?: string;                  // ISO
  performedByUserId?: string | null;
  performedByKind?: 'user' | 'agent' | 'system' | 'webhook';
  sourceModule: string;
  sourceId: string;
  metadata?: Record<string, any>;
}

export async function recordActivity(ev: ActivityEvent) {
  const supa = getSupabaseServerClient();

  // Resolve leadId via crm_lead_links se não vier explícito
  let leadId = ev.leadId ?? null;
  if (!leadId && ev.contactId) {
    const { data: link } = await supa
      .from('crm_lead_links')
      .select('lead_id')
      .eq('target_kind', ev.sourceModule === 'whatsapp' ? 'conversation' : 'contact')
      .eq('target_id', ev.sourceId)
      .eq('link_kind', 'primary')
      .maybeSingle();
    leadId = link?.lead_id ?? null;
  }

  // Idempotência: se já existe activity com mesmo source_module + source_id + type, skip
  const { data: existing } = await supa
    .from('crm_lead_activities')
    .select('id')
    .eq('source_module', ev.sourceModule)
    .eq('source_id', ev.sourceId)
    .eq('type', ev.type)
    .maybeSingle();
  if (existing) return existing.id;

  const { data: created } = await supa
    .from('crm_lead_activities')
    .insert({
      organization_id: ev.organizationId,
      lead_id: leadId,
      contact_id: ev.contactId ?? null,
      type: ev.type,
      title: ev.title ?? null,
      body: ev.body ?? null,
      performed_at: ev.performedAt ?? new Date().toISOString(),
      performed_by_user_id: ev.performedByUserId ?? null,
      performed_by_kind: ev.performedByKind ?? 'system',
      source_module: ev.sourceModule,
      source_id: ev.sourceId,
      metadata: ev.metadata ?? {},
    })
    .select('id')
    .single();

  return created?.id ?? null;
}
```

⚠️ **Gotcha:** idempotência importa. Webhook do WhatsApp pode reentregar. Sem o check, você cria duplicatas.

---

## 7. Exemplo end-to-end: mensagem WhatsApp → activity → notifica owner

### Cenário

```
1. Cliente envia "Quero agendar consulta" no WhatsApp
2. WAHA chama webhook do backend
3. Backend grava em `messages`
4. Backend resolve lead pelo `crm_lead_links`
5. Backend cria `crm_lead_activity (type='whatsapp_inbound', ...)`
6. Trigger atualiza `crm_leads.last_activity_at`
7. event_log emite 'lead_activity.recorded'
8. Worker consome e:
    a. Manda push notification pro owner do lead
    b. Cria task "Responder cliente" se time SLA expirou
9. Frontend recebe via Realtime e atualiza lista de leads (re-ordena)
```

### Código resumido

```ts
// Step 3: webhook handler
async function handleIncomingMessage(payload: WahaWebhookPayload) {
  const orgId = await resolveOrgFromSession(payload.session);

  // Upsert contact, conversation, message (vide doc 05 da aula original)
  const { contactId, conversationId, messageId } =
    await processIncomingMessage(orgId, payload);

  // Step 5: registra activity
  await recordActivity({
    organizationId: orgId,
    contactId,
    type: 'whatsapp_inbound',
    title: 'Mensagem recebida',
    body: payload.payload.body?.slice(0, 200) ?? null,
    performedAt: new Date(payload.payload.timestamp * 1000).toISOString(),
    performedByKind: 'user',
    sourceModule: 'whatsapp',
    sourceId: messageId,
    metadata: { conversation_id: conversationId, from: payload.payload.from },
  });

  // Step 7: trigger AFTER INSERT em crm_lead_activities → emit event_log
  // Step 8a: worker pega event_log row e dispara push
}
```

### Trigger que emite o evento

```sql
create or replace function public.fn_emit_activity_event()
returns trigger language plpgsql as $$
begin
  insert into public.event_log (organization_id, event_type, entity_kind, entity_id, payload, metadata)
  values (
    new.organization_id,
    'lead_activity.recorded',
    'lead_activity',
    new.id::text,
    jsonb_build_object(
      'activity_id', new.id,
      'lead_id', new.lead_id,
      'contact_id', new.contact_id,
      'type', new.type,
      'source_module', new.source_module,
      'source_id', new.source_id
    ),
    jsonb_build_object('source_module', 'crm')
  );
  return new;
end;
$$;

drop trigger if exists trg_emit_activity_event on public.crm_lead_activities;
create trigger trg_emit_activity_event
  after insert on public.crm_lead_activities
  for each row execute function public.fn_emit_activity_event();
```

### Worker que notifica owner

```ts
async function processActivityRecorded(ev: any) {
  const supa = getSupabaseServerClient();

  // Resolve owner
  const { data: lead } = await supa
    .from('crm_leads')
    .select('owner_user_id, title')
    .eq('id', ev.payload.lead_id)
    .single();

  if (!lead?.owner_user_id) return;

  // Cria notificação in-app
  await supa.from('notifications').insert({
    user_id: lead.owner_user_id,
    organization_id: ev.organization_id,
    kind: 'lead_activity',
    title: 'Nova mensagem',
    body: `${lead.title}: ${ev.payload.type}`,
    deep_link: `/crm/leads/${ev.payload.lead_id}`,
  });

  // Push (web push, OneSignal, etc.) — fora do escopo
}
```

---

## 8. Webhooks externos (notificar Zapier/Make/sistema do cliente)

Quando o cliente quer ouvir eventos do CRM em sistemas dele, expõe **webhooks subscription**.

### Schema

```sql
create table if not exists public.webhook_subscriptions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  url             text not null,
  events          text[] not null,                    -- ['lead.won', 'message.received', ...]
  secret          text not null,                       -- pra HMAC
  is_active       boolean not null default true,

  description     text,
  created_at      timestamptz not null default now(),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  failure_count   int not null default 0
);

create index on public.webhook_subscriptions (organization_id, is_active);
```

⭐ **Relacionamentos potenciais — `webhook_subscriptions`**

| Coluna | Conecta com | Padrão |
|--------|------------|--------|
| `organization_id` | `organizations.id` | FK rígida CASCADE |
| `events` | `event_log.event_type` (filtro) | text array |
| `secret` | HMAC do payload (consumidor valida) | gerar com gen_random_bytes |
| `failure_count` | Auto-disable em 10+ falhas consecutivas | reset em sucesso |

### Worker dispatcher

```ts
import crypto from 'crypto';

async function dispatchToSubscribers(ev: any) {
  const supa = getSupabaseServerClient();

  const { data: subs } = await supa
    .from('webhook_subscriptions')
    .select('*')
    .eq('organization_id', ev.organization_id)
    .eq('is_active', true)
    .contains('events', [ev.event_type]);

  await Promise.allSettled((subs ?? []).map(async (sub) => {
    const body = JSON.stringify({
      id: ev.id,
      organization_id: ev.organization_id,
      event_type: ev.event_type,
      entity_kind: ev.entity_kind,
      entity_id: ev.entity_id,
      emitted_at: ev.emitted_at,
      payload: ev.payload,
    });

    const sig = crypto.createHmac('sha256', sub.secret).update(body).digest('hex');

    try {
      const res = await fetch(sub.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': `sha256=${sig}`,
          'X-Event-Type': ev.event_type,
          'X-Idempotency-Key': ev.id,
        },
        body,
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      await supa
        .from('webhook_subscriptions')
        .update({
          last_success_at: new Date().toISOString(),
          failure_count: 0,
        })
        .eq('id', sub.id);
    } catch (err) {
      const newFail = sub.failure_count + 1;
      await supa
        .from('webhook_subscriptions')
        .update({
          last_failure_at: new Date().toISOString(),
          failure_count: newFail,
          is_active: newFail < 10,    // auto-disable após 10 falhas
        })
        .eq('id', sub.id);
    }
  }));
}
```

⚠️ **Gotcha:** nunca dispare webhook **dentro de transação Postgres** (trigger emitindo HTTP). Use o pattern `event_log` + worker. Caso contrário, sua tx pode travar 30s esperando uma URL lenta.

---

## 9. Idempotência cross-modular

Quando dois módulos podem registrar a mesma coisa (ex: WhatsApp e Email recebem confirmação do mesmo pagamento), você precisa **deduplicar**.

### Padrão: idempotency_key

Em cada evento, o emissor inclui um `idempotency_key` em `metadata`:

```ts
await emitEvent({
  organizationId,
  eventType: 'payment.received',
  entityKind: 'invoice',
  entityId: invoiceId,
  payload: { amount_cents, paid_at },
  metadata: {
    idempotency_key: `payment:${invoiceId}:${paidAtUnix}`,
    source_module: 'billing',
  },
});
```

E o consumer/dispatcher faz dedupe via `metadata->>idempotency_key`:

```sql
-- No consumer worker:
select * from event_log
where event_type = 'payment.received'
  and not exists (
    select 1 from event_log e2
    where e2.metadata->>'idempotency_key' = event_log.metadata->>'idempotency_key'
      and e2.id < event_log.id
      and e2.metadata->>'source_module' = 'billing'
  );
```

Ou via constraint:

```sql
create unique index if not exists idx_event_log_idem
  on public.event_log ((metadata->>'idempotency_key'))
  where metadata ? 'idempotency_key';
```

---

## 10. Versionamento de eventos

Quando o schema do payload muda, **adicione campos** mas **não remova**. Use `metadata.version`:

```json
{
  "event_type": "lead.stage_changed",
  "metadata": { "version": 2 },
  "payload": {
    "lead_id": "...",
    "from_stage_id": "...",
    "to_stage_id": "...",
    "win_probability": 0.7    // novo na v2
  }
}
```

Consumers fazem fallback:

```ts
const winProb = ev.payload.win_probability ?? null;
```

---

## 11. Eventos canônicos do CRM-core (lista de referência)

Esta é a lista que outros módulos podem assumir que existe. Estabelece um **contrato**.

| Evento | Quando emitido | Payload mínimo |
|--------|---------------|---------------|
| `lead.created` | INSERT em crm_leads | id, organization_id, pipeline_id, stage_id, contact_id |
| `lead.updated` | UPDATE em colunas relevantes | id, changed_fields |
| `lead.stage_changed` | UPDATE de stage_id | id, from_stage_id, to_stage_id |
| `lead.won` | UPDATE status pra 'won' | id, value_cents, closed_at |
| `lead.lost` | UPDATE status pra 'lost' | id, lost_reason, closed_at |
| `lead.assigned` | UPDATE owner_user_id | id, old_owner, new_owner |
| `lead.unassigned` | UPDATE owner_user_id pra null | id, old_owner |
| `lead_activity.recorded` | INSERT em crm_lead_activities | id, lead_id, type, source_module, source_id |
| `pipeline.created` | INSERT em crm_pipelines | id, name, slug |
| `pipeline.updated` | UPDATE em crm_pipelines | id, changed_fields |

---

## 12. Anti-pattern comum: trigger faz HTTP

```sql
-- ❌ NÃO FAÇA
create trigger trg_send_email_on_won
  after update on crm_leads
  for each row execute function fn_call_resend_api();   -- HTTP DENTRO DA TRANSAÇÃO
```

**Por que ruim:**
- Tx fica esperando rede
- Falha do HTTP **rolla a transação** (lead não muda de status no DB)
- Retry impossível sem fila

✅ **Padrão correto:**

```sql
-- Trigger só insere em event_log (super rápido)
create trigger trg_emit_lead_event ...

-- Worker separado lê event_log e faz HTTP
```

---

## 13. Visualizando: timeline do lead

A UI da timeline do lead lê de `crm_lead_activities` ordenado por `performed_at desc`. Cada row vira um item visual diferente baseado em `type` e `source_module`.

```tsx
function ActivityIcon({ type, sourceModule }: { type: string; sourceModule: string }) {
  const map: Record<string, JSX.Element> = {
    'whatsapp_inbound': <MessageCircle />,
    'whatsapp_outbound': <MessageCircle className="rotate-180" />,
    'email_inbound': <Mail />,
    'email_outbound': <Send />,
    'meeting': <Calendar />,
    'call': <Phone />,
    'task': <CheckSquare />,
    'stage_changed': <ArrowRight />,
    'payment_received': <DollarSign />,
    'agent_action': <Bot />,
    'note': <StickyNote />,
  };
  return map[type] ?? <Activity />;
}
```

E filtros laterais permitem fatiar por `type`, `source_module`, `performed_by_kind` (humano vs IA).

---

## 14. Checklist de implementação eventos

- [ ] Tabela `event_log` criada com indexes
- [ ] Trigger emite eventos de lead (created, stage_changed, won, lost, assigned)
- [ ] Trigger emite `lead_activity.recorded` em INSERT
- [ ] `recordActivity()` faz dedupe por `source_module + source_id`
- [ ] `event_log` está em retenção (cron/partman)
- [ ] Webhook subscriptions com HMAC
- [ ] Worker dispatcher fora da transação
- [ ] Auto-disable em 10 falhas consecutivas
- [ ] Idempotency key em eventos cross-module críticos
- [ ] Versionamento via `metadata.version`
- [ ] Frontend Realtime escuta `event_log` filtrado por org

---

## 15. Para onde vai daqui

Este foi o último doc da Parte 1 (arquitetura + UI).

A Parte 2 (Agent A — REST API) consome o schema desta seção. A Parte 3 (Agent B — MCP server) consome também. Ambos respeitam a doutrina do doc 06.

Os artefatos prontos pra colar estão em:

- [reference/crm-schema.sql](../reference/crm-schema.sql) — schema completo executável
- [reference/10-niches-fields.md](../reference/10-niches-fields.md) — referência detalhada por nicho
- [reference/relationship-matrix.md](../reference/relationship-matrix.md) — matriz N×N
- [prompts/prompt-06-crm-core-scaffolding.md](../prompts/prompt-06-crm-core-scaffolding.md) — prompt pra IA executar a Parte 1

---

## Próximo: prompt 06 (scaffolding) ou Parte 2 (REST API)
