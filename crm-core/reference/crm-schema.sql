-- =====================================================================
-- CRM-CORE SCHEMA — universal, multi-tenant, idempotente
-- =====================================================================
-- Roda em Postgres (Supabase). Pode ser aplicado múltiplas vezes —
-- todos os CREATE são idempotentes.
--
-- Pressupõe que JÁ EXISTEM:
--   - public.organizations (id uuid pk, ...)
--   - public.user_organizations (user_id uuid, organization_id uuid, role text)
--   - public.contacts (id uuid pk, organization_id uuid, ...)
--
-- Cria:
--   - crm_pipelines, crm_stages, crm_leads,
--     crm_lead_activities, crm_lead_links
--   - event_log (canal de comunicação inter-módulos)
--   - webhook_subscriptions (notificação externa)
--   - Triggers, RLS, realtime publication
-- =====================================================================

-- =====================================================================
-- 0. EXTENSIONS / HELPERS
-- =====================================================================
create extension if not exists "pgcrypto";

-- Helper RLS: organizations do user logado
create or replace function public.fn_user_org_ids()
returns table(organization_id uuid)
language sql stable security definer as $$
  select organization_id
  from public.user_organizations
  where user_id = auth.uid()
$$;

-- Helper updated_at automático
create or replace function public.fn_crm_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- =====================================================================
-- 1. crm_pipelines
-- =====================================================================
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
create index if not exists idx_crm_pipelines_slug
  on public.crm_pipelines (organization_id, slug);

comment on table public.crm_pipelines is
  'Funis de trabalho. Cada org pode ter N pipelines (vendas, suporte, recrutamento etc).';
comment on column public.crm_pipelines.vocabulary is
  'JSON com labels customizados: {lead, lead_plural, deal, won_label, ...}';
comment on column public.crm_pipelines.settings is
  'JSON com config: {fields:[...], rules:[...], wip_global, ...}. fields define schema de custom_fields.';

-- updated_at trigger
drop trigger if exists trg_crm_pipelines_updated_at on public.crm_pipelines;
create trigger trg_crm_pipelines_updated_at
  before update on public.crm_pipelines
  for each row execute function public.fn_crm_set_updated_at();

-- Garantir 1 default por org
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

-- Primeiro pipeline da org vira default automaticamente
create or replace function public.fn_first_pipeline_is_default()
returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from public.crm_pipelines
    where organization_id = new.organization_id
  ) then
    new.is_default := true;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_first_pipeline_default on public.crm_pipelines;
create trigger trg_first_pipeline_default
  before insert on public.crm_pipelines
  for each row execute function public.fn_first_pipeline_is_default();

-- =====================================================================
-- 2. crm_stages
-- =====================================================================
create table if not exists public.crm_stages (
  id                  uuid primary key default gen_random_uuid(),
  pipeline_id         uuid not null references public.crm_pipelines(id) on delete cascade,

  name                text not null,
  position            int not null,
  is_won              boolean not null default false,
  is_lost             boolean not null default false,
  color               text,
  win_probability     numeric(4, 3),
  automation_config   jsonb not null default '{}'::jsonb,
  wip_limit           int,

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

comment on table public.crm_stages is
  'Colunas do kanban. Cada pipeline tem N stages ordenadas.';

drop trigger if exists trg_crm_stages_updated_at on public.crm_stages;
create trigger trg_crm_stages_updated_at
  before update on public.crm_stages
  for each row execute function public.fn_crm_set_updated_at();

-- =====================================================================
-- 3. crm_leads
-- =====================================================================
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

  owner_user_id         uuid,                              -- soft FK pra auth.users(id)

  source                text,
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

-- Constraints adicionais
alter table public.crm_leads
  add constraint if not exists crm_leads_value_non_negative
  check (value_cents >= 0);

alter table public.crm_leads
  add constraint if not exists crm_leads_currency_format
  check (currency ~ '^[A-Z]{3}$');

-- Indexes
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

comment on table public.crm_leads is
  'Cards do kanban. Entidade central do CRM-core. Toda atividade orbita ao redor de um lead.';
comment on column public.crm_leads.contact_id is
  'FK soft-cascade pra contacts. ON DELETE SET NULL: anonimização LGPD não destrói histórico.';
comment on column public.crm_leads.owner_user_id is
  'Soft FK pra auth.users.id (sem constraint para evitar acoplamento cross-schema).';
comment on column public.crm_leads.position_in_stage is
  'Fractional indexing (numeric). Calcule via midpoint(prev, next). Não use INTEGER.';
comment on column public.crm_leads.last_activity_at is
  'Denormalizado de crm_lead_activities. Mantido por trigger fn_crm_lead_touch_activity.';
comment on column public.crm_leads.custom_fields is
  'jsonb cujo schema é declarado em crm_pipelines.settings.fields. Promove pra coluna gerada se virar query quente.';

-- updated_at
drop trigger if exists trg_crm_leads_updated_at on public.crm_leads;
create trigger trg_crm_leads_updated_at
  before update on public.crm_leads
  for each row execute function public.fn_crm_set_updated_at();

-- Auto-fechar / reabrir lead por stage
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

-- =====================================================================
-- 4. crm_lead_activities (timeline polimórfica)
-- =====================================================================
create table if not exists public.crm_lead_activities (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations(id) on delete cascade,

  lead_id                 uuid references public.crm_leads(id) on delete cascade,
  contact_id              uuid references public.contacts(id) on delete set null,

  type                    text not null,
  title                   text,
  body                    text,

  performed_by_user_id    uuid,
  performed_by_kind       text not null default 'user'
                          check (performed_by_kind in ('user', 'agent', 'system', 'webhook')),
  performed_at            timestamptz not null default now(),

  source_module           text,
  source_id               text,

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

comment on table public.crm_lead_activities is
  'Timeline polimórfica. Toda interação com um lead vira row aqui (chat, email, calendar, billing, agent, manual).';
comment on column public.crm_lead_activities.source_module is
  'whatsapp | email | calendar | billing | crm | agent | webhook | manual | system';
comment on column public.crm_lead_activities.source_id is
  'ID do registro original no módulo de origem (ex: messages.id, appointments.id).';

-- Manter crm_leads.last_activity_at atualizado
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

-- =====================================================================
-- 5. crm_lead_links (FK polimórfica universal)
-- =====================================================================
create table if not exists public.crm_lead_links (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid not null references public.crm_leads(id) on delete cascade,

  target_kind   text not null,
  target_id     text not null,

  link_kind     text not null default 'related',
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

comment on table public.crm_lead_links is
  'Vínculos polimórficos. Conecta lead a qualquer entidade do ecossistema (chat, email, calendar, billing, etc.).';
comment on column public.crm_lead_links.target_kind is
  'conversation | message | email_thread | appointment | invoice | document | ticket | asset | order | contract | custom:<key>';
comment on column public.crm_lead_links.link_kind is
  'primary | related | parent | child | mentioned';

-- =====================================================================
-- 6. event_log (canal pub/sub canônico)
-- =====================================================================
create table if not exists public.event_log (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  event_type      text not null,
  entity_kind     text not null,
  entity_id       text not null,

  payload         jsonb not null default '{}'::jsonb,
  metadata        jsonb not null default '{}'::jsonb,

  emitted_at      timestamptz not null default now(),
  consumed_by     text[] not null default '{}'::text[]
);

create index if not exists idx_event_log_emitted
  on public.event_log (emitted_at desc);
create index if not exists idx_event_log_org_type
  on public.event_log (organization_id, event_type, emitted_at desc);
create index if not exists idx_event_log_entity
  on public.event_log (entity_kind, entity_id, emitted_at desc);
create index if not exists idx_event_log_unconsumed
  on public.event_log (event_type, emitted_at)
  where coalesce(array_length(consumed_by, 1), 0) = 0;

create unique index if not exists idx_event_log_idem
  on public.event_log ((metadata->>'idempotency_key'))
  where metadata ? 'idempotency_key';

comment on table public.event_log is
  'Log imutável de eventos de domínio. Fonte da verdade para reprocessamento, auditoria e comunicação inter-módulos.';

-- Emit lead events
create or replace function public.fn_emit_lead_event()
returns trigger language plpgsql as $$
declare
  v_event_type text;
  v_payload    jsonb;
begin
  if (tg_op = 'INSERT') then
    v_event_type := 'lead.created';
    v_payload := jsonb_build_object(
      'lead_id', new.id,
      'pipeline_id', new.pipeline_id,
      'stage_id', new.stage_id,
      'contact_id', new.contact_id,
      'value_cents', new.value_cents
    );
  elsif (tg_op = 'UPDATE') then
    if new.stage_id is distinct from old.stage_id then
      v_event_type := 'lead.stage_changed';
      v_payload := jsonb_build_object(
        'lead_id', new.id,
        'from_stage_id', old.stage_id,
        'to_stage_id', new.stage_id,
        'previous_status', old.status,
        'new_status', new.status
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
      return new;
    end if;
  end if;

  if v_event_type is not null then
    insert into public.event_log (organization_id, event_type, entity_kind, entity_id, payload, metadata)
    values (
      new.organization_id, v_event_type, 'lead', new.id::text, v_payload,
      jsonb_build_object('source_module', 'crm', 'tg_op', tg_op)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_emit_lead_event on public.crm_leads;
create trigger trg_emit_lead_event
  after insert or update on public.crm_leads
  for each row execute function public.fn_emit_lead_event();

-- Emit activity event
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

-- =====================================================================
-- 7. webhook_subscriptions (notificação externa)
-- =====================================================================
create table if not exists public.webhook_subscriptions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  url             text not null,
  events          text[] not null,
  secret          text not null,
  is_active       boolean not null default true,

  description     text,
  created_at      timestamptz not null default now(),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  failure_count   int not null default 0
);

create index if not exists idx_webhook_subs_org_active
  on public.webhook_subscriptions (organization_id, is_active);

-- =====================================================================
-- 8. RLS — Row Level Security
-- =====================================================================
alter table public.crm_pipelines enable row level security;
alter table public.crm_stages enable row level security;
alter table public.crm_leads enable row level security;
alter table public.crm_lead_activities enable row level security;
alter table public.crm_lead_links enable row level security;
alter table public.event_log enable row level security;
alter table public.webhook_subscriptions enable row level security;

-- crm_pipelines
drop policy if exists "pipelines_org_members" on public.crm_pipelines;
create policy "pipelines_org_members"
  on public.crm_pipelines for all
  using (organization_id in (select organization_id from public.fn_user_org_ids()))
  with check (organization_id in (select organization_id from public.fn_user_org_ids()));

-- crm_stages
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
drop policy if exists "leads_org_members" on public.crm_leads;
create policy "leads_org_members"
  on public.crm_leads for all
  using (organization_id in (select organization_id from public.fn_user_org_ids()))
  with check (organization_id in (select organization_id from public.fn_user_org_ids()));

-- crm_lead_activities
drop policy if exists "activities_org_members" on public.crm_lead_activities;
create policy "activities_org_members"
  on public.crm_lead_activities for all
  using (organization_id in (select organization_id from public.fn_user_org_ids()))
  with check (organization_id in (select organization_id from public.fn_user_org_ids()));

-- crm_lead_links
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

-- event_log: read-only pra org members (insert via trigger ou service role)
drop policy if exists "event_log_org_select" on public.event_log;
create policy "event_log_org_select"
  on public.event_log for select
  using (organization_id in (select organization_id from public.fn_user_org_ids()));

-- webhook_subscriptions: gerenciado por admin/manager
drop policy if exists "webhook_subs_org_members" on public.webhook_subscriptions;
create policy "webhook_subs_org_members"
  on public.webhook_subscriptions for all
  using (
    organization_id in (
      select uo.organization_id from public.user_organizations uo
      where uo.user_id = auth.uid() and uo.role in ('owner', 'admin', 'manager')
    )
  )
  with check (
    organization_id in (
      select uo.organization_id from public.user_organizations uo
      where uo.user_id = auth.uid() and uo.role in ('owner', 'admin', 'manager')
    )
  );

-- =====================================================================
-- 9. Realtime publication (idempotente)
-- =====================================================================
do $$
begin
  begin
    execute 'alter publication supabase_realtime add table public.crm_pipelines';
  exception when duplicate_object then null;
  end;
  begin
    execute 'alter publication supabase_realtime add table public.crm_stages';
  exception when duplicate_object then null;
  end;
  begin
    execute 'alter publication supabase_realtime add table public.crm_leads';
  exception when duplicate_object then null;
  end;
  begin
    execute 'alter publication supabase_realtime add table public.crm_lead_activities';
  exception when duplicate_object then null;
  end;
  begin
    execute 'alter publication supabase_realtime add table public.crm_lead_links';
  exception when duplicate_object then null;
  end;
  begin
    execute 'alter publication supabase_realtime add table public.event_log';
  exception when duplicate_object then null;
  end;
end $$;

-- =====================================================================
-- 10. Seed default pipeline ao criar organização
-- =====================================================================
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

-- =====================================================================
-- FIM
-- =====================================================================
