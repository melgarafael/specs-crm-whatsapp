# 06 — Data Relationship Doctrine ⭐

> **Resumo:** o doc central da seção. Toda decisão de "como gravar esse dado" passa por aqui. Princípio universal, heurística DIRC (Duplicar/Integrar/Referenciar/Calcular), padrões de relação canônicos (FK rígida, FK soft, denorm, evento, MV), matriz N×N entre módulos do CRM, exemplo trabalhado completo do `lead.whatsapp` (do contact_id ao chatId), anti-patterns nomeados, checklist de 5 perguntas pra cada novo campo.

---

## 1. O princípio

> **Todo dado é uma ilha conectada.** Antes de criar um campo, antes de inserir um valor, antes de duplicar uma string em um lugar — pergunte: "esse dado já existe em outra tabela do ecossistema? deveria? como ele se mantém sincronizado?"

A maioria dos bugs de CRM em produção é **bug de relacionamento**. Não é bug de UI. Não é bug de validação. É bug de **dois lugares que tinham que falar e não estavam falando**, ou **um lugar que duplicou o que devia ter referenciado**.

O CRM-core falha quando você esquece que ele é o centro de um grafo. Cada coluna nova é uma decisão de relacionamento. E essa decisão tem 4 caminhos possíveis.

---

## 2. A heurística DIRC

Ao criar um campo, escolha um dos 4 caminhos. Sempre.

### D — Duplicar

Você guarda o valor explicitamente, mesmo que ele exista em outro lugar.

```sql
crm_leads.contact_name text   -- também existe em contacts.full_name
```

**Quando:**
- O dado original pode mudar e você quer **snapshot histórico** (ex: "qual era o nome do cliente no momento da venda?")
- Performance crítica de leitura: query precisa ser instantânea sem JOIN

**Trade-off:** sincronia manual ou via trigger. Risco de divergir.

### I — Integrar (denormalizar com origem clara)

Você guarda o valor, mas com **metadados que apontam pra fonte da verdade**.

```sql
crm_leads.last_activity_at timestamptz   -- mantido por trigger sobre crm_lead_activities
```

**Quando:**
- Performance crítica + você consegue manter sincronia automática (trigger ou MV)
- Você precisa do dado num lugar mas a fonte da verdade é outra

**Trade-off:** menos lugares pra sincronia falhar do que D. Trigger garante consistência.

### R — Referenciar (FK)

Você guarda só o ID. Lê via JOIN sempre.

```sql
crm_leads.contact_id uuid references contacts(id)
```

**Quando:**
- Padrão default. **Comece sempre por R**. Migra pra D ou I se medir que JOIN dói.
- Dado original pode mudar e você quer **sempre o valor atualizado**.

**Trade-off:** JOIN custa. Pode ser caro em tabelas grandes sem índices certos.

### C — Calcular (não armazenar)

Você não armazena o campo. Calcula on-demand.

```sql
-- View: total de leads ganhos por org no mês
create or replace view v_org_wins_this_month as
select organization_id, count(*) as wins
from crm_leads
where status = 'won' and closed_at >= date_trunc('month', now())
group by organization_id;
```

**Quando:**
- Cálculo é barato OU usado raramente
- Composição de muitos campos (sum/avg) que evolui com o tempo

**Trade-off:** custo de CPU em cada leitura. Pode usar MATERIALIZED VIEW se ficar caro.

---

### Tabela de decisão DIRC

| Situação | Escolha |
|---------|---------|
| Default sem requisito de performance | **R** (referência) |
| Snapshot histórico (preço no momento da venda) | **D** (duplicar) |
| Hot path de UI (lista lateral, kanban header) | **I** (integrar via trigger) |
| Métrica agregada (sum, count, avg) | **C** (calcular) ou MV |
| Dado em outro DB (BYO Supabase) — sem FK possível | **D** ou **I** com sync via evento |
| Dado externo (API de terceiro) | **D** com TTL ou cache |

---

## 3. Padrões de relação canônicos

Vamos detalhar cada padrão com sintaxe SQL/TS pronta.

### 3.1 FK rígida (`ON DELETE CASCADE` / `RESTRICT` / `SET NULL`)

```sql
-- CASCADE: deletar pai apaga filhos
crm_leads.pipeline_id uuid references crm_pipelines(id) on delete cascade

-- RESTRICT (default): impede deletar se tem filho
crm_leads.stage_id uuid references crm_stages(id) on delete restrict

-- SET NULL: deleta pai, filho fica órfão (com null)
crm_leads.contact_id uuid references contacts(id) on delete set null
```

**Quando usar cada:**

| Política | Use quando |
|---------|-----------|
| `CASCADE` | Filho **não faz sentido** sem o pai (stage sem pipeline, lead activity sem lead) |
| `RESTRICT` | Filho mantém histórico mesmo se pai sumir (lead em stage — quer migrar antes) |
| `SET NULL` | Pai é opcional / pode ser anonimizado (LGPD: deletar contato sem perder lead) |

⚠️ **Gotcha:** `CASCADE` em tabelas de auditoria (activities) é tentador, mas perigoso. Se você deletar um lead, perde toda a história. Considere **soft delete** (`deleted_at timestamptz`) em vez de DELETE.

### 3.2 FK soft (mesmo ID, sem CONSTRAINT)

```sql
-- Owner aponta pra auth.users mas sem FK rígida
crm_leads.owner_user_id uuid    -- soft FK pra auth.users.id
```

**Quando usar:**
- Cross-database (BYO Supabase: `auth.users` está em outro DB)
- Tabela referenciada não está sob seu controle (Supabase `auth` schema)
- Você quer flexibilidade de "limpar" o ID sem cascata

**Como validar:** check na app (TypeScript) ou trigger custom no DB.

### 3.3 FK polimórfica (`target_kind + target_id`)

```sql
crm_lead_links (lead_id, target_kind text, target_id text)
-- target_kind = 'conversation', 'invoice', 'document', etc.
```

**Quando usar:**
- Você precisa vincular a **N tipos diferentes** de entidade (chat, calendar, billing, ...)
- Adicionar novo tipo no futuro **sem migração**

**Trade-off:** sem garantia referencial. Job noturno valida + apaga órfãos.

### 3.4 Denormalização proposital com trigger

```sql
-- last_message_at é mantido por trigger sobre messages
create trigger trg_update_conv_on_message
  after insert on messages
  for each row execute function fn_update_conversation_on_message();
```

**Quando usar:**
- Hot path de leitura (lista lateral ordenada por `last_message_at`)
- Origem é estável e trigger é simples

**Trade-off:** trigger pode falhar silenciosamente. Sempre tem JOB de reconciliação noturno.

### 3.5 Eventos pub/sub via tabela `event_log`

```sql
create table public.event_log (
  id            uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  event_type    text not null,                    -- 'lead.stage_changed', 'message.received', etc.
  entity_kind   text not null,                    -- 'lead', 'message', 'contact'
  entity_id     text not null,
  payload       jsonb not null,
  emitted_at    timestamptz not null default now(),
  consumed_by   text[] not null default '{}'::text[]
);

create index idx_event_log_unconsumed on event_log (event_type, emitted_at)
  where coalesce(array_length(consumed_by, 1), 0) = 0;
```

**Quando usar:**
- Comunicação assíncrona entre módulos
- Vários consumers (frontend realtime + worker + webhook externo)
- Auditoria/replay

**Como consumir:** worker faz `SELECT ... FOR UPDATE SKIP LOCKED` ou Supabase Realtime escuta a tabela.

### 3.6 Materialized view (snapshot calculado)

```sql
create materialized view mv_pipeline_metrics as
select
  pipeline_id,
  count(*) filter (where status = 'open') as open_count,
  count(*) filter (where status = 'won') as won_count,
  sum(value_cents) filter (where status = 'won') as won_value_cents
from crm_leads
group by pipeline_id;

create unique index on mv_pipeline_metrics (pipeline_id);

-- Refresh periódico (cron)
refresh materialized view concurrently mv_pipeline_metrics;
```

**Quando usar:**
- Dashboards / forecasts
- Agregações pesadas que não precisam ser realtime

**Trade-off:** dados ficam "atrasados" até o próximo refresh. Use `concurrently` pra não travar leituras.

---

## 4. A matriz canônica de relações

Tabela N×N entre módulos do CRM nichado típico. Para cada par, indica o **campo que conecta** e o **padrão usado**.

### Notação

| Símbolo | Padrão |
|--------|--------|
| `FK→` | FK rígida apontando direção |
| `soft FK→` | FK sem constraint |
| `poly→` | polimórfica (`target_kind + target_id`) |
| `denorm` | denormalização via trigger/MV |
| `event` | comunicação por evento (event_log + consumer) |
| `MV` | materialized view |
| `—` | sem relação direta canônica |

### Matriz CRM × satélites

| | CRM | Chat | WhatsApp | Email | Calendar | Documents | Billing | Files |
|---|-----|------|----------|-------|----------|-----------|---------|-------|
| **CRM** (leads) | self | `crm_lead_links poly→ conversation` | indireto via Chat | `crm_lead_links poly→ email_thread` | `appointments.lead_id FK→` | `documents.lead_id FK→` | `invoices.lead_id FK→` | `files.lead_id FK→` |
| **Chat** (conversations, messages) | `crm_lead_activities source_module='whatsapp' source_id=message.id` (event) | self | `conversations.channel_session_id FK→ channel_sessions` | `email_threads` (irmão) | `crm_lead_links` (chat→lead→appointment) | poly→ `crm_lead_links` | indireto | `messages.media_url denorm` |
| **WhatsApp** (channel_sessions) | indireto via Chat | `conversations.channel_session_id FK→` | self | — | — | — | — | — |
| **Email** | `email_threads.lead_id FK→ crm_leads` | denorm pra `crm_lead_activities` | — | self | — | poly→ `crm_lead_links` | indireto | `email_attachments.email_id FK→` |
| **Calendar** | `appointments.lead_id FK→ crm_leads`; `appointments.contact_id FK→ contacts` | event "appointment.created" → `crm_lead_activities` | — | event → email confirm | self | `appointment_attachments` poly | `appointment.invoice_id soft FK→` | — |
| **Documents** | `documents.lead_id FK→ crm_leads` | poly→ `crm_lead_links` | — | poly | poly | self | — | denorm `documents.file_id FK→ files` |
| **Billing** | `invoices.lead_id FK→ crm_leads`; event "payment.received" → activity | denorm em `crm_lead_activities` | — | event → email recibo | event → cancelar appointment se inadimplência | `invoice.contract_id FK→` | self | `invoice.pdf_file_id FK→ files` |
| **Files** | `files.lead_id soft FK→` | `messages.media_url denorm` | — | `email_attachments` FK | — | `documents.file_id FK→` | `invoices.pdf_file_id FK→` | self |

---

### Exemplos detalhados de pares importantes

#### 4.1 CRM ↔ Chat (lead → conversation)

```sql
-- Vínculo: 1 lead pode ter N conversations associadas, 1 principal
insert into crm_lead_links (lead_id, target_kind, target_id, link_kind)
values (
  '{lead-id}',
  'conversation',
  '{conversation-id}',
  'primary'
);

-- Resolver: conversation principal de um lead
select c.*
from crm_lead_links l
join conversations c on c.id::text = l.target_id
where l.lead_id = '{lead-id}'
  and l.target_kind = 'conversation'
  and l.link_kind = 'primary';

-- Resolver: lead a partir de uma conversation
select cl.*
from crm_lead_links l
join crm_leads cl on cl.id = l.lead_id
where l.target_kind = 'conversation'
  and l.target_id = '{conversation-id}'
  and l.link_kind = 'primary'
limit 1;
```

#### 4.2 CRM ↔ Calendar (lead ← appointment)

```sql
create table appointments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  lead_id uuid references crm_leads(id) on delete set null,
  contact_id uuid references contacts(id) on delete set null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null,                          -- 'scheduled', 'completed', 'cancelled', 'no_show'
  ...
);

-- Trigger: ao criar appointment, gera activity no CRM
create or replace function fn_appointment_log_to_crm()
returns trigger language plpgsql as $$
begin
  if new.lead_id is not null then
    insert into crm_lead_activities (
      organization_id, lead_id, contact_id,
      type, title, body,
      source_module, source_id,
      performed_at, performed_by_kind,
      metadata
    ) values (
      new.organization_id, new.lead_id, new.contact_id,
      'meeting',
      'Agendamento criado',
      'Em ' || to_char(new.starts_at, 'DD/MM/YYYY HH24:MI'),
      'calendar', new.id::text,
      now(), 'system',
      jsonb_build_object('starts_at', new.starts_at, 'status', new.status)
    );
  end if;
  return new;
end;
$$;
```

#### 4.3 CRM ↔ Billing (lead ← invoice)

```sql
create table invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  lead_id uuid references crm_leads(id) on delete set null,
  contact_id uuid references contacts(id),
  amount_cents bigint not null,
  status text not null,                          -- 'draft', 'sent', 'paid', 'overdue', 'cancelled'
  paid_at timestamptz,
  ...
);

-- Quando invoice vira 'paid', o lead pode ser marcado como 'won' automaticamente (se config permitir)
create or replace function fn_invoice_paid_to_crm()
returns trigger language plpgsql as $$
declare
  default_won_stage_id uuid;
begin
  if new.status = 'paid' and old.status != 'paid' and new.lead_id is not null then
    -- Atividade
    insert into crm_lead_activities (organization_id, lead_id, type, title, body, source_module, source_id, performed_at, performed_by_kind)
    values (new.organization_id, new.lead_id, 'payment_received',
            'Pagamento recebido',
            (new.amount_cents / 100.0)::text || ' BRL',
            'billing', new.id::text, now(), 'system');

    -- Auto-won (opcional, controlado por settings da pipeline)
    select s.id into default_won_stage_id
    from crm_stages s
    join crm_leads l on l.pipeline_id = s.pipeline_id
    where l.id = new.lead_id and s.is_won = true
    limit 1;

    update crm_leads
    set stage_id = default_won_stage_id
    where id = new.lead_id and status = 'open';
  end if;
  return new;
end;
$$;
```

---

## 5. Exemplo trabalhado completo: `lead.whatsapp`

A pergunta clássica: "como descubro o WhatsApp de um lead?"

### Passo 0 — Onde mora o quê

```
┌────────────────────────────────────────────────────────────────────┐
│                                                                    │
│    crm_leads.contact_id ──────► contacts.id                        │
│                                      │                             │
│                                      └─► contacts.whatsapp_id      │
│                                          contacts.phone_number     │
│                                                                    │
│    conversations.contact_id ───► contacts.id                       │
│    conversations.channel_session_id ──► channel_sessions.id        │
│                                              │                     │
│                                              └─► channel_sessions  │
│                                                  .phone_number     │
│                                                  (do número do     │
│                                                   negócio)         │
│                                                                    │
│    crm_lead_links (lead_id, target_kind='conversation',            │
│                    target_id, link_kind='primary')                 │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

### Passo 1 — Resolver telefone do cliente a partir do `lead_id`

```sql
-- Caminho R (referência via JOIN)
select c.phone_number, c.whatsapp_id
from crm_leads l
join contacts c on c.id = l.contact_id
where l.id = '{lead-id}';
```

📦 TypeScript:

```ts
const { data } = await supa
  .from('crm_leads')
  .select('contact:contacts(phone_number, whatsapp_id)')
  .eq('id', leadId)
  .single();

const phone = (data?.contact as any)?.phone_number;
const wid = (data?.contact as any)?.whatsapp_id;
```

### Passo 2 — Resolver a conversa principal do lead

```sql
select c.*
from crm_lead_links lk
join conversations c on c.id::text = lk.target_id
where lk.lead_id = '{lead-id}'
  and lk.target_kind = 'conversation'
  and lk.link_kind = 'primary'
limit 1;
```

Se não existir link primário, fallback: a conversation mais recente do contato no canal WhatsApp.

```sql
select c.*
from conversations c
join channel_sessions cs on cs.id = c.channel_session_id
where c.contact_id = (select contact_id from crm_leads where id = '{lead-id}')
  and cs.provider in ('waha', 'meta_official')
order by c.last_message_at desc nulls last
limit 1;
```

### Passo 3 — Resolver o número do negócio (canal)

```sql
select cs.id, cs.phone_number, cs.waha_session_name, cs.provider, cs.status
from conversations c
join channel_sessions cs on cs.id = c.channel_session_id
where c.id = '{conversation-id}';
```

### Passo 4 — Enviar mensagem ao lead via WhatsApp

```ts
// 1. Resolve dados
const ctx = await resolveLeadWhatsappContext(leadId);
// {
//   contactWhatsappId: '5511999999999@c.us',
//   conversationId: 'uuid',
//   channelSessionId: 'uuid',
//   wahaSessionName: 'org-acme-1',
// }

// 2. Dispatcher
await dispatchSend({
  organizationId,
  channelSessionId: ctx.channelSessionId,
  toChatId: ctx.contactWhatsappId,
  body: 'Olá!',
});
```

### Passo 5 — A mensagem que voltou cria activity no lead

```ts
// Em handleIncomingMessage:
const { data: message } = await supa
  .from('messages')
  .insert({...})
  .select()
  .single();

// Resolve lead via primary link
const { data: link } = await supa
  .from('crm_lead_links')
  .select('lead_id')
  .eq('target_kind', 'conversation')
  .eq('target_id', conversationId)
  .eq('link_kind', 'primary')
  .maybeSingle();

if (link?.lead_id) {
  await supa.from('crm_lead_activities').insert({
    organization_id: organizationId,
    lead_id: link.lead_id,
    contact_id: contactId,
    type: 'whatsapp_inbound',
    title: 'Mensagem recebida',
    body: messageBody?.slice(0, 200) ?? null,
    source_module: 'whatsapp',
    source_id: message.id,
    performed_at: message.sent_at ?? message.created_at,
    performed_by_kind: 'user',
  });
}
```

E o `last_activity_at` do lead se atualiza pelo trigger `fn_crm_lead_touch_activity` (vide doc 04).

### Passo 6 — UI do lead exibe o telefone via JOIN

```tsx
// LeadDetail.tsx
const { data } = await supa
  .from('crm_leads')
  .select(`
    *,
    contact:contacts ( id, full_name, phone_number, whatsapp_id, profile_picture_url ),
    primary_conversation_link:crm_lead_links!inner ( target_id ),
    activities:crm_lead_activities ( id, type, title, body, performed_at, source_module )
  `)
  .eq('id', leadId)
  .eq('crm_lead_links.target_kind', 'conversation')
  .eq('crm_lead_links.link_kind', 'primary')
  .single();
```

### Resumo do hop chain

```
lead_id
  └─► crm_leads.contact_id
        └─► contacts.id
              └─► contacts.whatsapp_id (= "5511...@c.us")

lead_id
  └─► crm_lead_links (target_kind=conversation, link_kind=primary)
        └─► conversations.id
              └─► conversations.channel_session_id
                    └─► channel_sessions.id (= o número do negócio)
```

🎯 **Decisão:** o caminho oficial é via `crm_lead_links`. A "conversa mais recente" é só fallback. Sempre tente o link primário primeiro — ele captura intenção do operador (ex: lead tem 2 conversas: uma de venda e uma de suporte; o primary link aponta a relevante).

---

## 6. Anti-patterns nomeados

Cada um desses bugs tem nome porque você vai vê-los em produção, e nomeá-los acelera a comunicação no time.

### 6.1 String que deveria ser FK

```sql
-- ❌ ANTI-PATTERN
crm_leads.owner_email text   -- e se mudar o e-mail do dono?

-- ✅ CORRETO
crm_leads.owner_user_id uuid -- referência ao auth.users.id
```

**Sintoma:** valores divergentes em telas. Uma tela mostra "joao@old.com", outra "joao@new.com".

### 6.2 Duplicação sem source of truth

```sql
-- ❌ Lead tem nome do contato duplicado, e contato muda → lead fica desatualizado
crm_leads.contact_name text  -- sem trigger pra manter sincronia

-- ✅ Ou referencia (R), ou denormaliza com trigger explícito (I), nunca duplica sem nada
```

**Sintoma:** "no CRM tá errado, no chat tá certo".

### 6.3 Evento sem consumer

```sql
-- ❌ Você emite "lead.stage_changed" mas nenhum worker escuta
insert into event_log (event_type, ...) values ('lead.stage_changed', ...);
-- ... e ninguém faz nada com isso
```

**Sintoma:** automation_config configurado mas "nada acontece".

### 6.4 FK ausente que vira inferência por nome

```ts
// ❌ buscar lead "do número 11999..." procurando string no body
const lead = await findLeadByPhoneInTitle(phone);

// ✅ relação explícita
const lead = await findLeadByContactPhone(phone);  // via JOIN com contacts
```

**Sintoma:** quando o nome do lead muda, "perde" o vínculo. Performance ruim. Falsos positivos.

### 6.5 Campo sincronizado por cron quando devia ser realtime

```ts
// ❌ rodar a cada 1h "atualiza last_activity_at de todos os leads"
cron('0 * * * *', updateLastActivityForAllLeads);

// ✅ trigger no INSERT de crm_lead_activities (vide doc 04)
```

**Sintoma:** lista de leads ordenada por atividade, mas atualizações chegam atrasadas. UI parece "quebrada".

### 6.6 Lock-in implícito de jsonb

```sql
-- ❌ a UI lê custom_fields->>'mrr_cents' diretamente sem schema
-- Quando muda o type pra "monthly_revenue", precisa caçar todos os lugares

-- ✅ schema declarativo em crm_pipelines.settings.fields + helper centralizado
```

**Sintoma:** mudar nome de field quebra 8 telas que ninguém lembrava existirem.

### 6.7 Cascade fantasma

```sql
-- ❌ contacts CASCADE em messages (deletar contato apaga histórico)
messages.contact_id references contacts(id) on delete cascade

-- ✅ SET NULL + retenção controlada por LGPD
messages.contact_id references contacts(id) on delete set null
```

**Sintoma:** auditoria perde histórico de conversa quando cliente é "deletado".

### 6.8 Polimórfico sem padronização

```sql
-- ❌ target_kind cada lugar grava de um jeito diferente: 'Conversation', 'conv', 'whatsapp_chat'
crm_lead_links.target_kind text   -- sem CHECK constraint

-- ✅ check constraint OU constante centralizada na app
alter table crm_lead_links add constraint chk_target_kind
  check (target_kind in ('conversation', 'message', 'email_thread', 'appointment', 'invoice', 'document', 'ticket', 'asset', 'order', 'contract'));
```

**Sintoma:** queries com `WHERE target_kind = 'conversation'` retornam 60% dos esperados (resto está com 'Conversation' ou 'conv').

---

## 7. Checklist universal: as 5 perguntas antes de criar um campo

Imprime e cola no monitor.

### 1. Esse dado já existe em outra tabela?

Se sim, o caminho default é **referenciar (R)**, não duplicar. Justifique se for duplicar.

### 2. Se eu mudar lá, como esse aqui sabe?

- **R:** automático (JOIN sempre lê o atual).
- **I:** trigger ou MV mantém sincronia.
- **D:** ninguém atualiza — é snapshot proposital. Documente que é histórico.
- **C:** ninguém atualiza — calcula de novo.

Sem resposta clara → você está criando um bug.

### 3. Se eu deletar lá, o que acontece aqui?

- `CASCADE`: some junto.
- `SET NULL`: vira órfão (com null).
- `RESTRICT`: bloqueia o delete.
- Soft FK: nada acontece (e isso pode ser bug ou feature).

Sem resposta → você vai descobrir em produção quando o cliente reclamar.

### 4. Esse campo é fonte da verdade ou cópia?

Se é cópia, **diga isso no nome ou no comment**.

```sql
crm_leads.last_activity_at timestamptz
  -- Denormalizado de crm_lead_activities (mantido por trigger fn_crm_lead_touch_activity)
```

Quando alguém ler o schema daqui a 6 meses, **precisa saber que isso é cache, não verdade**.

### 5. Outro módulo precisaria deste campo? Como ele acessaria?

Pense além do imediato. Se o dado é interessante pra **outros módulos** (chat, calendar, IA), pergunte:

- A pessoa que vai construir o módulo X vai descobrir esse campo?
- Por que canal? (FK direta? Evento? MCP tool?)
- Se a tabela mudar, quantos lugares quebram?

Se a resposta for "vou ter que documentar no Notion pra alguém saber", coloque um `comment on column` e referencie no diagrama.

---

## 8. Aplicando a doutrina: revisão de schema

Pegue o schema do doc 04 e responda as 5 perguntas pra cada coluna importante. Aqui um exemplo:

### `crm_leads.owner_user_id uuid`

1. Existe em outra tabela? **Sim, `auth.users.id`.**
2. Se mudar lá, como sabe? **Não se aplica — `auth.users.id` não muda. Soft FK basta.**
3. Se deletar `auth.users`? **Aqui fica órfão (NULL).** Ajuste app pra mostrar "(usuário removido)".
4. Source of truth? **`auth.users` é a verdade. Aqui é referência.**
5. Outro módulo precisaria? **Sim — calendar (quem agendou), email (quem enviou). Todos referenciam o mesmo `auth.users.id`.**

✅ Caminho **R** com soft FK. Documentado.

### `crm_leads.last_activity_at timestamptz`

1. Existe em outra tabela? **Implicitamente — é o MAX de `crm_lead_activities.performed_at` filtrado por lead.**
2. Como mantém? **Trigger `fn_crm_lead_touch_activity` em INSERT.**
3. Se deletar atividade? **Não recalcula. Ficaria desatualizado em DELETE.** Solução: trigger AFTER DELETE também (recalcula).
4. Source of truth? **Não — é cache.** Comment SQL deixa explícito.
5. Outro módulo? **Hot path: lista lateral, kanban header.** Vale o cache.

✅ Caminho **I**. Trigger documentado. Adicionar trigger AFTER DELETE pra robustez.

---

## 9. Quando quebrar a doutrina

Toda regra tem exceção. Você quebra a doutrina quando:

| Situação | Exceção justificada |
|---------|---------------------|
| Cross-DB (BYO Supabase) — não há FK possível | Soft FK + sync por evento via webhook |
| Snapshot histórico (price at time of sale) | Duplicação proposital com nome explícito (`price_at_creation_cents`) |
| Performance medida e doendo | Promova field jsonb pra coluna gerada |
| Integração com sistema externo legado | Replicar dado externo localmente (espelho) com TTL |

**Regra meta:** quebrar a doutrina **sempre tem comment SQL ou ADR explicando o porquê**. Não justifique no PR — justifique no schema.

---

## 10. ADR template pra decisão de relacionamento

Quando você tomar uma decisão não-óbvia, registre:

```markdown
# ADR-XXXX: [Decisão]

## Context
Qual o problema? Que dado, que tabela?

## Options
- A) Referenciar (R)
- B) Duplicar (D)
- C) Denormalizar via trigger (I)
- D) Calcular (C)

## Decision
Escolhemos [X] porque [razão técnica].

## Consequences
- Sincronia: [como mantemos atualizado]
- Performance: [trade-off]
- LGPD/auditoria: [implicação]
- Migração futura: [reversibilidade]
```

---

## 11. O resumo de 1 frase

> **Antes de gravar um campo: pergunte se ele já existe em outro lugar. Se sim, refira (R). Se a referência dói no hot path, denormalize com trigger (I). Se você precisa de snapshot histórico, duplique (D) e diga isso no schema. Se é agregado, calcule (C). Sempre escolha — nunca grave por inércia.**

---

## Próximo: [07-eventos-e-comunicacao.md](07-eventos-e-comunicacao.md)
