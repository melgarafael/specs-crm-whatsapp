# 04 — Schema universal: as 5 tabelas do CRM-core

> **Resumo:** SQL completo, idempotente, das 5 tabelas que sustentam qualquer CRM nichado: `crm_pipelines`, `crm_stages`, `crm_leads`, `crm_lead_activities`, `crm_lead_links`. Cada coluna tem **bloco de relacionamentos potenciais** apontando com quem ela conecta no ecossistema. Triggers, RLS e Realtime publication inclusos.

---

## 1. Visão geral das 5 tabelas

```
crm_pipelines (org tem N pipelines)
    │
    └── crm_stages (pipeline tem N stages)
            │
            └── crm_leads (stage tem N leads)
                    │
                    ├── crm_lead_activities (timeline polimórfica)
                    └── crm_lead_links (vínculos polimórficos com qualquer entidade)
```

A relação com módulos satélites (`contacts`, `conversations`, `messages`, `appointments`, `email_threads`, etc.) acontece sempre via:

- **`crm_leads.contact_id`** — FK direta pra pessoa
- **`crm_lead_activities.source_module + source_id`** — ponteiro polimórfico (logging)
- **`crm_lead_links.target_kind + target_id`** — ponteiro polimórfico (vínculo persistente)

---

## 2. `crm_pipelines`

```sql
create table if not exists public.crm_pipelines (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  name            text not null,
  slug            text not null,
  is_default      boolean not null default false,
  position        int not null default 0,
  color           text,
  icon            text,

  vocabulary      jsonb not null default '{}'::jsonb,
  settings        jsonb not null default '{}'::jsonb,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint crm_pipelines_unique_slug_per_org unique (organization_id, slug)
);

create index if not exists idx_crm_pipelines_org
  on public.crm_pipelines (organization_id);

create index if not exists idx_crm_pipelines_org_default
  on public.crm_pipelines (organization_id) where is_default;

comment on table public.crm_pipelines is 'Funis de trabalho. Cada org pode ter N pipelines (vendas, suporte, recrutamento etc.).';
comment on column public.crm_pipelines.vocabulary is 'JSON com labels customizados: {lead, lead_plural, deal, won_label, ...}';
comment on column public.crm_pipelines.settings is 'JSON com config: {fields:[...], rules:[...], wip_global, ...}';
```

⭐ **Relacionamentos potenciais — `crm_pipelines`**

| Coluna | Conecta com (módulo / tabela) | Padrão | Nota |
|--------|------------------------------|--------|------|
| `id` | `crm_stages.pipeline_id`, `crm_leads.pipeline_id`, `crm_pipeline_permissions.pipeline_id` | FK rígida CASCADE | Núcleo da hierarquia |
| `organization_id` | `organizations.id` | FK rígida CASCADE | Multi-tenant boundary |
| `slug` | URLs (`/crm/{slug}/board`), MCP tool argument, webhooks externos | Convenção em URL | Único por org |
| `vocabulary` (jsonb) | UI labels, prompts de IA, templates de e-mail | Lido em tempo real pela UI/agentes | Mergea com defaults |
| `settings.fields` | UI form dinâmico (`<LeadForm>`), validação Zod, filtros | Consumido por componentes | Define schema custom_fields |
| `settings.rules` | Engine de automação, edge functions, workers de fila | Consumido fora da UI | Pode disparar webhooks |
| `is_default` | Auto-binding em mensagens novas, lógica de fallback | Trigger garante 1 por org | — |

**Indexes recomendados:**

```sql
-- Já criados acima:
-- idx_crm_pipelines_org
-- idx_crm_pipelines_org_default

-- Para busca por slug (em routing de URL):
create index if not exists idx_crm_pipelines_slug
  on public.crm_pipelines (organization_id, slug);
```

---

## 3. `crm_stages`

```sql
create table if not exists public.crm_stages (
  id                  uuid primary key default gen_random_uuid(),
  pipeline_id         uuid not null references public.crm_pipelines(id) on delete cascade,

  name                text not null,
  position            int not null,
  is_won              boolean not null default false,
  is_lost             boolean not null default false,
  color               text,
  win_probability     numeric(4, 3),                      -- 0.000 a 1.000
  automation_config   jsonb not null default '{}'::jsonb,
  wip_limit           int,                                -- null = sem limite

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint crm_stages_no_won_and_lost check (not (is_won and is_lost)),
  constraint crm_stages_win_prob_range check (
    win_probability is null
    or (win_probability >= 0 and win_probability <= 1)
  ),
  constraint crm_stages_wip_positive check (wip_limit is null or wip_limit > 0)
);

create index if not exists idx_crm_stages_pipeline_position
  on public.crm_stages (pipeline_id, position);

comment on table public.crm_stages is 'Colunas do kanban. Cada pipeline tem N stages ordenadas.';
comment on column public.crm_stages.automation_config is 'JSON com gatilhos: {on_enter:[...], on_exit:[...], on_idle:[...]}';
comment on column public.crm_stages.wip_limit is 'Limite de leads em aberto na coluna; null = ilimitado.';
```

⭐ **Relacionamentos potenciais — `crm_stages`**

| Coluna | Conecta com | Padrão | Nota |
|--------|------------|--------|------|
| `id` | `crm_leads.stage_id` | FK rígida (sem cascade — exige migrar leads antes de deletar stage) | — |
| `pipeline_id` | `crm_pipelines.id` | FK rígida CASCADE | — |
| `is_won` / `is_lost` | Endpoint `move` (fecha lead automaticamente), relatórios | Lido por triggers/edge functions | Estados terminais |
| `win_probability` | Forecast de pipeline, weighted value em relatórios | Multiplicador sobre `crm_leads.value_cents` | — |
| `automation_config.on_enter` | Edge function `crm-stage-automation` (envia mensagem, agenda follow-up, cria task) | Worker/edge dispara | Gatilho event-driven |
| `automation_config.on_idle` | Worker periódico que detecta leads parados N dias | Cron + edge function | Gera tasks/notifications |
| `wip_limit` | UI (badge vermelha), endpoint `move` (alerta/bloqueia) | Validação na app | — |

⚠️ **Gotcha:** se você usar `ON DELETE CASCADE` em `crm_leads.stage_id`, deletar uma stage apaga todos os leads dela. Quase nunca é o que você quer. Use `ON DELETE RESTRICT` (padrão sem cascade) e force o usuário a mover os leads antes.

```sql
-- A FK em crm_leads abaixo é RESTRICT (default sem cascade)
-- crm_leads.stage_id references crm_stages(id)
```

---

## 4. `crm_leads`

```sql
create table if not exists public.crm_leads (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations(id) on delete cascade,

  pipeline_id           uuid not null references public.crm_pipelines(id) on delete cascade,
  stage_id              uuid not null references public.crm_stages(id),

  contact_id            uuid references public.contacts(id) on delete set null,

  title                 text not null,
  value_cents           bigint not null default 0,
  currency              text not null default 'BRL',

  status                text not null default 'open'
                        check (status in ('open', 'won', 'lost')),

  owner_user_id         uuid,                              -- references auth.users(id) (soft FK pra evitar acoplamento)

  source                text,                              -- 'whatsapp_inbound', 'web_form', 'manual', 'api', 'email_inbound', etc.
  source_metadata       jsonb not null default '{}'::jsonb,

  custom_fields         jsonb not null default '{}'::jsonb,
  tags                  text[] not null default '{}'::text[],

  position_in_stage     numeric not null default 1.0,

  lost_reason           text,
  expected_close_date   date,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  closed_at             timestamptz,
  last_activity_at      timestamptz
);

create index if not exists idx_crm_leads_org_stage
  on public.crm_leads (organization_id, stage_id) where status = 'open';

create index if not exists idx_crm_leads_org_status
  on public.crm_leads (organization_id, status);

create index if not exists idx_crm_leads_pipeline_stage_position
  on public.crm_leads (pipeline_id, stage_id, position_in_stage)
  where status = 'open';

create index if not exists idx_crm_leads_contact
  on public.crm_leads (contact_id);

create index if not exists idx_crm_leads_owner
  on public.crm_leads (owner_user_id);

create index if not exists idx_crm_leads_last_activity
  on public.crm_leads (organization_id, last_activity_at desc nulls last);

create index if not exists idx_crm_leads_tags_gin
  on public.crm_leads using gin (tags);

create index if not exists idx_crm_leads_custom_fields_gin
  on public.crm_leads using gin (custom_fields jsonb_path_ops);

comment on table public.crm_leads is 'Cards do kanban. A entidade central do CRM-core. Toda atividade orbita ao redor de um lead.';
```

⭐ **Relacionamentos potenciais — `crm_leads`**

| Coluna | Conecta com (módulo / tabela) | Padrão | Nota |
|--------|------------------------------|--------|------|
| `id` | `crm_lead_activities.lead_id`, `crm_lead_links.lead_id`, `appointments.lead_id`, `email_threads.lead_id`, `invoices.lead_id`, `tickets.lead_id`, `agent_memory.lead_id` | FK rígida (cascade ou set null dependendo do módulo) | Center do grafo |
| `organization_id` | `organizations.id` | FK rígida CASCADE | — |
| `pipeline_id` | `crm_pipelines.id` | FK rígida CASCADE | — |
| `stage_id` | `crm_stages.id` | FK rígida RESTRICT | — |
| `contact_id` | `contacts.id` (chat module) | FK soft `SET NULL` | Pessoa pode ser deletada/anonimizada (LGPD) sem perder lead |
| `title` | UI, busca, prompts de IA, notificações | Texto livre | Frequentemente derivado do contact name no momento da criação |
| `value_cents` | Relatórios financeiros, forecast, weighted pipeline | Aritmética simples | Multi-currency: ver `currency` |
| `currency` | Conversão FX em relatórios consolidados | Tabela `fx_rates` (opcional) | ISO 4217 |
| `status` | Reports, edge functions de fechamento, automações | Triggers em UPDATE | Imutável após `won`/`lost`? Decisão de negócio |
| `owner_user_id` | `auth.users.id` (Supabase Auth), `user_organizations`, RLS | FK soft (sem constraint p/ flexibilidade) | Notificações vão pra ele |
| `source` | Relatórios de aquisição, atribuição de marketing | Enum-like text | Padronize uma lista |
| `source_metadata` | UTMs, IDs de campanha, webhook payload | jsonb | Evita criar colunas pra cada novo source |
| `custom_fields` | UI form dinâmico, validação Zod por pipeline, filtros, IA prompts | jsonb com schema em `crm_pipelines.settings.fields` | Promove para coluna se virar query quente |
| `tags` | Filtros, segmentação, automações de mensagem | `text[]` com índice GIN | — |
| `position_in_stage` | Ordenação no kanban (drag-drop) | numeric (fractional indexing) | Veja doc 03 |
| `lost_reason` | Análise de perda, retreinamento de IA, retargeting | enum-like text | Padronize lista por pipeline |
| `expected_close_date` | Forecast de fechamento, alertas de atraso, calendário | date | Comparar com `closed_at` p/ medir acerto |
| `closed_at` | Tempo médio de fechamento, SLA, reports | timestamptz | Preenchido em UPDATE quando status muda |
| `last_activity_at` | Ordenação "mais recente", alerta "lead frio", IA priorizar | timestamptz denormalizado | Mantido por trigger de `crm_lead_activities` |

**Decisões críticas:**

- `contact_id` é nullable e `ON DELETE SET NULL` — pra cumprir LGPD (deletar contato sem perder histórico do lead).
- `tags` é `text[]` por simplicidade. Se você precisa de tag com cor/owner, use tabela `crm_tags` separada.
- `custom_fields jsonb` + GIN index permite filtros eficientes via `@>`.
- `position_in_stage numeric` (não int) — fractional indexing.

⚠️ **Gotcha:** o índice GIN em `custom_fields` é caro pra escrita. Em pipelines com >100k leads, mantenha apenas se você realmente filtra por jsonb no board. Senão, troque por `BTREE` em campos específicos quando virem hot path.

---

## 5. `crm_lead_activities`

```sql
create table if not exists public.crm_lead_activities (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations(id) on delete cascade,

  lead_id                 uuid references public.crm_leads(id) on delete cascade,
  contact_id              uuid references public.contacts(id) on delete set null,

  type                    text not null,                -- 'note', 'call', 'meeting', 'whatsapp_inbound', 'whatsapp_outbound', 'email_inbound', 'email_outbound', 'task', 'stage_changed', 'value_changed', 'system'
  title                   text,
  body                    text,

  performed_by_user_id    uuid,                          -- soft FK pra auth.users
  performed_by_kind       text not null default 'user' check (performed_by_kind in ('user', 'agent', 'system', 'webhook')),
  performed_at            timestamptz not null default now(),

  source_module           text,                          -- 'whatsapp', 'email', 'calendar', 'crm', 'agent', 'webhook', 'billing', 'manual'
  source_id               text,                          -- ID livre que aponta pro registro original (ex: messages.id, email_threads.id)

  metadata                jsonb not null default '{}'::jsonb,

  created_at              timestamptz not null default now()
);

create index if not exists idx_crm_lead_activities_lead_time
  on public.crm_lead_activities (lead_id, performed_at desc);

create index if not exists idx_crm_lead_activities_contact_time
  on public.crm_lead_activities (contact_id, performed_at desc);

create index if not exists idx_crm_lead_activities_org_time
  on public.crm_lead_activities (organization_id, performed_at desc);

create index if not exists idx_crm_lead_activities_source
  on public.crm_lead_activities (source_module, source_id) where source_id is not null;

create index if not exists idx_crm_lead_activities_type
  on public.crm_lead_activities (organization_id, type, performed_at desc);

comment on table public.crm_lead_activities is 'Timeline polimórfica. Toda interação com um lead/contact vira uma row aqui, independente do módulo de origem.';
```

⭐ **Relacionamentos potenciais — `crm_lead_activities`**

| Coluna | Conecta com | Padrão | Nota |
|--------|------------|--------|------|
| `lead_id` | `crm_leads.id` | FK rígida CASCADE | Permite ordenar timeline por lead |
| `contact_id` | `contacts.id` | FK soft SET NULL | Permite atividades sem lead (ex: contato sem deal aberto) |
| `type` | UI render (ícone diferente por tipo), filtros, IA prompts | enum-like text | Padronize lista canônica |
| `performed_by_user_id` | `auth.users.id`, ranking de produtividade, atribuição | Soft FK | — |
| `performed_by_kind` | UI (avatar humano vs bot), auditoria | check constraint | Distingue ação humana de automação |
| `source_module` | Roteamento de telemetria, filtros, joins ad hoc com módulo originador | enum-like text | Lista canônica: ver doc 07 |
| `source_id` | Drilldown pro registro original (ex: clicar em activity de WhatsApp leva pra `messages.id`) | text livre | UUID ou string composta |
| `metadata` (jsonb) | Payloads específicos por tipo (call duration, email subject, etc.) | jsonb | Schema por `type` |

**Tipos canônicos sugeridos:**

| `type` | Quando | `source_module` típico |
|--------|--------|------------------------|
| `note` | Nota manual | `manual` |
| `whatsapp_inbound` | Mensagem WhatsApp recebida | `whatsapp` |
| `whatsapp_outbound` | Mensagem WhatsApp enviada | `whatsapp` |
| `email_inbound` | E-mail recebido | `email` |
| `email_outbound` | E-mail enviado | `email` |
| `call` | Ligação registrada | `phone` ou `vapi` |
| `meeting` | Reunião realizada | `calendar` |
| `task` | Tarefa criada/concluída | `crm` |
| `stage_changed` | Lead mudou de stage | `crm` |
| `value_changed` | Valor mudou | `crm` |
| `tag_added` / `tag_removed` | Tags alteradas | `crm` |
| `assigned` | Atribuição mudou | `crm` |
| `payment_received` | Pagamento confirmado | `billing` |
| `agent_action` | IA executou ação | `agent` |
| `system` | Sistema fez algo (importação, merge) | `system` |

---

## 6. `crm_lead_links` (tabela polimórfica universal)

```sql
create table if not exists public.crm_lead_links (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid not null references public.crm_leads(id) on delete cascade,

  target_kind   text not null,                          -- 'conversation', 'message', 'email_thread', 'appointment', 'invoice', 'document', 'ticket', etc.
  target_id     text not null,                          -- string para suportar UUID e IDs externos

  link_kind     text not null default 'related',        -- 'primary', 'related', 'parent', 'child', 'mentioned'
  metadata      jsonb not null default '{}'::jsonb,

  created_at    timestamptz not null default now(),

  constraint crm_lead_links_unique unique (lead_id, target_kind, target_id, link_kind)
);

create index if not exists idx_crm_lead_links_lead
  on public.crm_lead_links (lead_id);

create index if not exists idx_crm_lead_links_target
  on public.crm_lead_links (target_kind, target_id);

create index if not exists idx_crm_lead_links_lead_kind
  on public.crm_lead_links (lead_id, link_kind);

comment on table public.crm_lead_links is 'Vínculos polimórficos. Conecta um lead a qualquer entidade do ecossistema (chat, email, calendar, billing, etc.).';
```

⭐ **Relacionamentos potenciais — `crm_lead_links`**

| Coluna | Conecta com | Padrão | Nota |
|--------|------------|--------|------|
| `lead_id` | `crm_leads.id` | FK rígida CASCADE | — |
| `target_kind` + `target_id` | qualquer tabela do ecossistema (`conversations.id`, `messages.id`, `appointments.id`, `invoices.id`, `documents.id`, ...) | FK polimórfica (sem constraint) | Padroniza valores em `target_kind` |
| `link_kind` | UI render (highlight do principal), regras de negócio (qual é a conversa "principal") | enum-like text | `primary`, `related`, etc. |
| `metadata` | Payload específico por tipo (ex: para `email_thread`: `{subject, last_message_at}`) | jsonb | Cache opcional |

**Valores canônicos sugeridos para `target_kind`:**

```
conversation     — uma thread WhatsApp (chat module)
message          — uma mensagem específica (raro, prefer conversation)
email_thread     — uma thread de e-mail
appointment      — agendamento no calendar
invoice          — fatura/cobrança no billing
document         — arquivo no storage
ticket           — ticket no suporte
asset            — propriedade (imobiliária)
case             — caso jurídico (advocacia)
order            — pedido (e-commerce)
contract         — contrato assinado
custom:<key>     — qualquer outro vínculo customizado
```

⚠️ **Gotcha:** sem FK rígida, é responsabilidade da app garantir que `target_id` aponta pra algo que existe. Considere job de validação noturno que apaga links órfãos.

---

## 7. Triggers essenciais

### 7.1 `updated_at` automático

```sql
create or replace function public.fn_crm_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_crm_pipelines_updated_at on public.crm_pipelines;
create trigger trg_crm_pipelines_updated_at
  before update on public.crm_pipelines
  for each row execute function public.fn_crm_set_updated_at();

drop trigger if exists trg_crm_stages_updated_at on public.crm_stages;
create trigger trg_crm_stages_updated_at
  before update on public.crm_stages
  for each row execute function public.fn_crm_set_updated_at();

drop trigger if exists trg_crm_leads_updated_at on public.crm_leads;
create trigger trg_crm_leads_updated_at
  before update on public.crm_leads
  for each row execute function public.fn_crm_set_updated_at();
```

### 7.2 Manter `crm_leads.last_activity_at` em dia

```sql
create or replace function public.fn_crm_lead_touch_activity()
returns trigger language plpgsql as $$
begin
  if new.lead_id is not null then
    update public.crm_leads
    set last_activity_at = greatest(coalesce(last_activity_at, '-infinity'::timestamptz), new.performed_at)
    where id = new.lead_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_crm_lead_activity_touch on public.crm_lead_activities;
create trigger trg_crm_lead_activity_touch
  after insert on public.crm_lead_activities
  for each row execute function public.fn_crm_lead_touch_activity();
```

### 7.3 Auto-fechamento ao mudar pra stage `is_won` / `is_lost`

```sql
create or replace function public.fn_crm_lead_close_on_stage()
returns trigger language plpgsql as $$
declare
  stage_won boolean;
  stage_lost boolean;
begin
  if new.stage_id is distinct from old.stage_id then
    select is_won, is_lost into stage_won, stage_lost
    from public.crm_stages where id = new.stage_id;

    if stage_won then
      new.status := 'won';
      new.closed_at := coalesce(new.closed_at, now());
    elsif stage_lost then
      new.status := 'lost';
      new.closed_at := coalesce(new.closed_at, now());
    elsif old.status in ('won', 'lost') then
      -- reabrir lead caso volte pra stage não-terminal
      new.status := 'open';
      new.closed_at := null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_crm_lead_close on public.crm_leads;
create trigger trg_crm_lead_close
  before update of stage_id on public.crm_leads
  for each row execute function public.fn_crm_lead_close_on_stage();
```

### 7.4 Log automático de mudança de stage como `crm_lead_activity`

```sql
create or replace function public.fn_crm_lead_log_stage_change()
returns trigger language plpgsql as $$
declare
  old_stage_name text;
  new_stage_name text;
begin
  if new.stage_id is distinct from old.stage_id then
    select name into old_stage_name from public.crm_stages where id = old.stage_id;
    select name into new_stage_name from public.crm_stages where id = new.stage_id;

    insert into public.crm_lead_activities (
      organization_id, lead_id, contact_id,
      type, title, body,
      performed_by_user_id, performed_by_kind,
      source_module, source_id,
      metadata
    ) values (
      new.organization_id, new.id, new.contact_id,
      'stage_changed',
      'Etapa alterada',
      coalesce(old_stage_name, '?') || ' → ' || coalesce(new_stage_name, '?'),
      new.owner_user_id, 'system',
      'crm', new.id::text,
      jsonb_build_object(
        'from_stage_id', old.stage_id,
        'to_stage_id', new.stage_id,
        'from_stage_name', old_stage_name,
        'to_stage_name', new_stage_name
      )
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_crm_lead_log_stage on public.crm_leads;
create trigger trg_crm_lead_log_stage
  after update of stage_id on public.crm_leads
  for each row execute function public.fn_crm_lead_log_stage_change();
```

### 7.5 Garantir 1 default pipeline por org (vide doc 02)

```sql
-- (já apresentado em 02, repetido aqui pra ficar self-contained no schema canônico)
create or replace function public.fn_ensure_single_default_pipeline()
returns trigger language plpgsql as $$
begin
  if new.is_default then
    update public.crm_pipelines
    set is_default = false, updated_at = now()
    where organization_id = new.organization_id
      and id <> new.id
      and is_default = true;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_pipelines_single_default on public.crm_pipelines;
create trigger trg_pipelines_single_default
  after insert or update of is_default on public.crm_pipelines
  for each row when (new.is_default = true)
  execute function public.fn_ensure_single_default_pipeline();
```

---

## 8. RLS canônica

```sql
-- Helper (caso ainda não exista)
create or replace function public.fn_user_org_ids()
returns table(organization_id uuid) language sql stable security definer as $$
  select organization_id from public.user_organizations where user_id = auth.uid()
$$;

-- crm_pipelines
alter table public.crm_pipelines enable row level security;

drop policy if exists "pipelines_org_members" on public.crm_pipelines;
create policy "pipelines_org_members"
  on public.crm_pipelines for all
  using (organization_id in (select organization_id from public.fn_user_org_ids()))
  with check (organization_id in (select organization_id from public.fn_user_org_ids()));

-- crm_stages
alter table public.crm_stages enable row level security;

drop policy if exists "stages_via_pipeline_org" on public.crm_stages;
create policy "stages_via_pipeline_org"
  on public.crm_stages for all
  using (
    pipeline_id in (
      select id from public.crm_pipelines
      where organization_id in (select organization_id from public.fn_user_org_ids())
    )
  )
  with check (
    pipeline_id in (
      select id from public.crm_pipelines
      where organization_id in (select organization_id from public.fn_user_org_ids())
    )
  );

-- crm_leads
alter table public.crm_leads enable row level security;

drop policy if exists "leads_org_members" on public.crm_leads;
create policy "leads_org_members"
  on public.crm_leads for all
  using (organization_id in (select organization_id from public.fn_user_org_ids()))
  with check (organization_id in (select organization_id from public.fn_user_org_ids()));

-- crm_lead_activities
alter table public.crm_lead_activities enable row level security;

drop policy if exists "activities_org_members" on public.crm_lead_activities;
create policy "activities_org_members"
  on public.crm_lead_activities for all
  using (organization_id in (select organization_id from public.fn_user_org_ids()))
  with check (organization_id in (select organization_id from public.fn_user_org_ids()));

-- crm_lead_links (sem organization_id direto — herda via lead_id)
alter table public.crm_lead_links enable row level security;

drop policy if exists "links_via_lead_org" on public.crm_lead_links;
create policy "links_via_lead_org"
  on public.crm_lead_links for all
  using (
    lead_id in (
      select id from public.crm_leads
      where organization_id in (select organization_id from public.fn_user_org_ids())
    )
  )
  with check (
    lead_id in (
      select id from public.crm_leads
      where organization_id in (select organization_id from public.fn_user_org_ids())
    )
  );
```

⚠️ **Gotcha:** RLS bloqueia também service role? **Não** — service role bypassa RLS. Edge functions e webhook handlers que rodam com service key ignoram policies. RLS protege o cliente direto (frontend autenticado).

---

## 9. Realtime publication

```sql
-- Adiciona ao publication padrão do Supabase
alter publication supabase_realtime add table public.crm_pipelines;
alter publication supabase_realtime add table public.crm_stages;
alter publication supabase_realtime add table public.crm_leads;
alter publication supabase_realtime add table public.crm_lead_activities;
alter publication supabase_realtime add table public.crm_lead_links;
```

⚠️ **Gotcha:** `alter publication ... add table ...` falha se a tabela já está no publication. Use bloco `do $$` se quiser idempotente:

```sql
do $$
begin
  begin
    execute 'alter publication supabase_realtime add table public.crm_leads';
  exception when duplicate_object then null;
  end;
end $$;
```

---

## 10. Constraints adicionais úteis

### 10.1 `value_cents` não negativo

```sql
alter table public.crm_leads
  add constraint if not exists crm_leads_value_non_negative
  check (value_cents >= 0);
```

### 10.2 Campo `currency` em ISO-4217 (3 letras maiúsculas)

```sql
alter table public.crm_leads
  add constraint if not exists crm_leads_currency_format
  check (currency ~ '^[A-Z]{3}$');
```

### 10.3 `lost_reason` obrigatório quando `status = 'lost'`

Aplique via trigger (check constraint não acessa coluna sibling de forma confiável):

```sql
create or replace function public.fn_crm_lead_require_lost_reason()
returns trigger language plpgsql as $$
begin
  if new.status = 'lost' and (new.lost_reason is null or trim(new.lost_reason) = '') then
    raise exception 'lost_reason is required when status is lost';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_crm_lead_lost_reason on public.crm_leads;
create trigger trg_crm_lead_lost_reason
  before insert or update on public.crm_leads
  for each row execute function public.fn_crm_lead_require_lost_reason();
```

🎯 **Decisão:** essa regra é opcional. Alguns produtos preferem permitir "perdido sem motivo" e tratar via UI obrigatória. Avalie a UX do seu nicho.

---

## 11. Seed de pipeline default no signup da org

Quando uma org é criada, semeie 1 pipeline padrão pra ela não ficar sem CRM funcional:

```sql
create or replace function public.fn_seed_default_pipeline_for_org()
returns trigger language plpgsql as $$
declare
  pipeline_id uuid;
begin
  insert into public.crm_pipelines (organization_id, name, slug, is_default, position, color, icon)
  values (new.id, 'Vendas', 'sales', true, 0, '#3b82f6', 'TrendingUp')
  returning id into pipeline_id;

  insert into public.crm_stages (pipeline_id, name, position, color)
  values
    (pipeline_id, 'Novo', 0, '#94a3b8'),
    (pipeline_id, 'Qualificando', 1, '#60a5fa'),
    (pipeline_id, 'Proposta', 2, '#a78bfa'),
    (pipeline_id, 'Negociação', 3, '#f59e0b');

  insert into public.crm_stages (pipeline_id, name, position, color, is_won)
  values (pipeline_id, 'Fechado', 4, '#10b981', true);

  insert into public.crm_stages (pipeline_id, name, position, color, is_lost)
  values (pipeline_id, 'Perdido', 5, '#ef4444', true);

  return new;
end;
$$;

drop trigger if exists trg_seed_default_pipeline on public.organizations;
create trigger trg_seed_default_pipeline
  after insert on public.organizations
  for each row execute function public.fn_seed_default_pipeline_for_org();
```

---

## 12. Ordem de migração

```
1. Criar/garantir organizations e user_organizations
2. Criar fn_user_org_ids() (helper RLS)
3. Criar crm_pipelines (+ trigger updated_at, single_default)
4. Criar crm_stages (+ trigger updated_at)
5. Criar crm_leads (+ triggers updated_at, close_on_stage)
6. Criar crm_lead_activities (+ trigger touch_activity)
7. Criar crm_lead_links
8. Habilitar RLS em todas (5 policies)
9. Adicionar tabelas ao publication realtime
10. Criar trigger seed default pipeline em organizations
11. (Opcional) trigger lost_reason obrigatório
12. (Opcional) trigger log de stage_change como activity
```

SQL completo, idempotente, está em [reference/crm-schema.sql](../reference/crm-schema.sql).

---

## 13. Checklist de schema

- [ ] Todas as 5 tabelas criadas
- [ ] Indexes mínimos: `(org, stage)`, `(pipeline, stage, position)`, `(contact_id)`, `(owner_user_id)`, GIN tags, GIN custom_fields
- [ ] Triggers: updated_at, touch_activity, close_on_stage, log_stage_change, single_default_pipeline
- [ ] RLS habilitada em todas
- [ ] Policies cobrem: select, insert, update, delete
- [ ] Realtime publication inclui as 5 tabelas
- [ ] Seed default pipeline ao criar org
- [ ] Constraints: value >=0, currency ISO, status enum, win_probability range
- [ ] Comments em colunas estratégicas (linka p/ módulos satélites)

---

## Próximo: [05-custom-fields-por-nicho.md](05-custom-fields-por-nicho.md)
