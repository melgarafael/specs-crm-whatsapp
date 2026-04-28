-- =============================================================================
-- SCHEMA UNIVERSAL — CHAT LIVE + WHATSAPP (WAHA) + BINDING CRM
-- Pronto pra rodar em Postgres / Supabase. Idempotente (CREATE IF NOT EXISTS).
-- Versão: 1.0
-- =============================================================================

-- Pré-requisitos: extensão pgcrypto pra gen_random_uuid e gen_random_bytes
create extension if not exists pgcrypto;

-- =============================================================================
-- 1. PRÉ-REQUISITOS DO SEU CRM (assumidos — descomente se ainda não tem)
-- =============================================================================

-- create table if not exists public.organizations (
--   id uuid primary key default gen_random_uuid(),
--   name text not null,
--   slug text unique not null,
--   created_at timestamptz default now()
-- );
--
-- create table if not exists public.user_organizations (
--   user_id uuid references auth.users(id) on delete cascade,
--   organization_id uuid references public.organizations(id) on delete cascade,
--   role text not null default 'member',
--   created_at timestamptz default now(),
--   primary key (user_id, organization_id)
-- );

-- =============================================================================
-- 2. CHANNEL SESSIONS (1 sessão WAHA = 1 número conectado)
-- =============================================================================

create table if not exists public.channel_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  provider text not null default 'waha',
  waha_session_name text not null,
  waha_base_url text,
  waha_api_key_encrypted text,

  phone_number text,
  display_name text,

  status text not null default 'pending',
  qr_code text,
  last_status_at timestamptz default now(),

  webhook_secret text not null default encode(gen_random_bytes(32), 'hex'),

  created_at timestamptz default now(),
  updated_at timestamptz default now(),

  unique (organization_id, waha_session_name)
);

create index if not exists idx_channel_sessions_org on public.channel_sessions (organization_id);
create index if not exists idx_channel_sessions_status on public.channel_sessions (status);

-- =============================================================================
-- 3. CONTACTS
-- =============================================================================

create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  phone_number text not null,
  whatsapp_id text,
  full_name text,
  push_name text,
  profile_picture_url text,

  email text,
  company text,
  notes text,
  tags text[] default '{}',

  is_blocked boolean default false,
  first_message_at timestamptz,
  last_message_at timestamptz,

  created_at timestamptz default now(),
  updated_at timestamptz default now(),

  unique (organization_id, phone_number)
);

create index if not exists idx_contacts_org on public.contacts (organization_id);
create index if not exists idx_contacts_whatsapp_id on public.contacts (whatsapp_id);
create index if not exists idx_contacts_last_msg on public.contacts (last_message_at desc nulls last);

-- =============================================================================
-- 4. CONVERSATIONS
-- =============================================================================

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  channel_session_id uuid not null references public.channel_sessions(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,

  whatsapp_chat_id text not null,
  is_group boolean default false,
  group_name text,

  assigned_user_id uuid,

  status text not null default 'open' check (status in ('open', 'pending', 'resolved', 'archived')),
  unread_count int not null default 0,
  last_message_preview text,
  last_message_at timestamptz,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,

  primary_deal_id uuid,

  created_at timestamptz default now(),
  updated_at timestamptz default now(),

  unique (organization_id, channel_session_id, whatsapp_chat_id)
);

create index if not exists idx_conversations_org_lastmsg on public.conversations (organization_id, last_message_at desc nulls last);
create index if not exists idx_conversations_assigned on public.conversations (assigned_user_id);
create index if not exists idx_conversations_status on public.conversations (status);
create index if not exists idx_conversations_contact on public.conversations (contact_id);

-- =============================================================================
-- 5. MESSAGES
-- =============================================================================

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,

  external_id text,
  external_session text,

  from_me boolean not null,
  sender_user_id uuid,
  sender_phone text,

  type text not null check (type in ('text', 'image', 'video', 'audio', 'document', 'sticker', 'location', 'contact', 'reaction', 'system')),
  body text,
  media_url text,
  media_mime_type text,
  media_size_bytes int,
  media_filename text,
  media_duration_seconds int,
  metadata jsonb default '{}'::jsonb,

  status text not null default 'sending' check (status in ('sending', 'sent', 'delivered', 'read', 'failed')),
  ack int default 0 check (ack between 0 and 5),
  failed_reason text,

  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  created_at timestamptz default now(),

  unique (organization_id, external_id) deferrable initially deferred
);

create index if not exists idx_messages_conv_sent on public.messages (conversation_id, sent_at desc nulls last);
create index if not exists idx_messages_org_created on public.messages (organization_id, created_at desc);
create index if not exists idx_messages_external on public.messages (external_id);
create index if not exists idx_messages_pending on public.messages (status) where status in ('sending', 'failed');

-- =============================================================================
-- 6. WEBHOOK EVENTS LOG (auditoria)
-- =============================================================================

create table if not exists public.webhook_events_log (
  id uuid primary key default gen_random_uuid(),
  channel_session_id uuid references public.channel_sessions(id) on delete set null,

  event_type text not null,
  external_id text,
  payload jsonb not null,

  processed_at timestamptz,
  processing_error text,

  received_at timestamptz default now()
);

create index if not exists idx_webhook_log_received on public.webhook_events_log (received_at desc);
create index if not exists idx_webhook_log_event on public.webhook_events_log (event_type, received_at desc);
create index if not exists idx_webhook_log_external on public.webhook_events_log (external_id) where external_id is not null;

-- =============================================================================
-- 7. TRIGGERS
-- =============================================================================

-- updated_at automático
create or replace function public.fn_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_set_updated_at_contacts on public.contacts;
create trigger trg_set_updated_at_contacts
  before update on public.contacts
  for each row execute function public.fn_set_updated_at();

drop trigger if exists trg_set_updated_at_conversations on public.conversations;
create trigger trg_set_updated_at_conversations
  before update on public.conversations
  for each row execute function public.fn_set_updated_at();

drop trigger if exists trg_set_updated_at_sessions on public.channel_sessions;
create trigger trg_set_updated_at_sessions
  before update on public.channel_sessions
  for each row execute function public.fn_set_updated_at();

-- Atualizar conversation ao inserir mensagem
create or replace function public.fn_update_conversation_on_message()
returns trigger language plpgsql as $$
begin
  update public.conversations
  set
    last_message_at = coalesce(new.sent_at, new.created_at),
    last_message_preview = case
      when new.type = 'text' then left(new.body, 120)
      when new.type = 'image' then '📷 Imagem'
      when new.type = 'video' then '🎥 Vídeo'
      when new.type = 'audio' then '🎵 Áudio'
      when new.type = 'document' then '📄 ' || coalesce(new.media_filename, 'Documento')
      when new.type = 'sticker' then 'Figurinha'
      when new.type = 'location' then '📍 Localização'
      when new.type = 'contact' then '👤 Contato'
      else new.type
    end,
    last_inbound_at = case when not new.from_me then coalesce(new.sent_at, new.created_at) else last_inbound_at end,
    last_outbound_at = case when new.from_me then coalesce(new.sent_at, new.created_at) else last_outbound_at end,
    unread_count = case when not new.from_me then unread_count + 1 else unread_count end,
    updated_at = now()
  where id = new.conversation_id;
  return new;
end;
$$;

drop trigger if exists trg_message_inserted on public.messages;
create trigger trg_message_inserted
  after insert on public.messages
  for each row execute function public.fn_update_conversation_on_message();

-- Atualizar contact ao inserir mensagem
create or replace function public.fn_update_contact_on_message()
returns trigger language plpgsql as $$
begin
  update public.contacts c
  set
    last_message_at = coalesce(new.sent_at, new.created_at),
    first_message_at = coalesce(c.first_message_at, new.created_at),
    updated_at = now()
  from public.conversations conv
  where conv.id = new.conversation_id and conv.contact_id = c.id;
  return new;
end;
$$;

drop trigger if exists trg_message_inserted_contact on public.messages;
create trigger trg_message_inserted_contact
  after insert on public.messages
  for each row execute function public.fn_update_contact_on_message();

-- =============================================================================
-- 8. ROW LEVEL SECURITY
-- =============================================================================

alter table public.contacts enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.channel_sessions enable row level security;

-- Helper: organizations do usuário logado
create or replace function public.fn_user_org_ids()
returns table(organization_id uuid) language sql stable security definer set search_path = public as $$
  select organization_id from public.user_organizations where user_id = auth.uid()
$$;

-- Policies (replicar pattern em todas)
do $$
declare
  tbl text;
begin
  for tbl in select unnest(array['contacts', 'conversations', 'messages', 'channel_sessions']) loop
    execute format($f$
      drop policy if exists "org_members_all_%I" on public.%I;
      create policy "org_members_all_%I" on public.%I
        for all
        using (organization_id in (select organization_id from public.fn_user_org_ids()))
        with check (organization_id in (select organization_id from public.fn_user_org_ids()));
    $f$, tbl, tbl, tbl, tbl);
  end loop;
end $$;

-- =============================================================================
-- 9. REALTIME PUBLICATION
-- =============================================================================

-- Não falha se já estiverem publicadas
do $$
begin
  begin
    alter publication supabase_realtime add table public.messages;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.conversations;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.channel_sessions;
  exception when duplicate_object then null;
  end;
end $$;

-- =============================================================================
-- FIM
-- =============================================================================
