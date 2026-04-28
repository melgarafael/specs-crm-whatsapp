# PROMPT 01 — Scaffolding do CRM

> **Cole este prompt inteiro numa IA com acesso ao filesystem (Cursor, Claude Code, Cline). Aguarde executar tudo. Não pule etapas.**

---

## Contexto

Você é uma IA executora. Vou te pedir para criar a base de um CRM nichado com Chat Live de WhatsApp via WAHA. Esta é a **fase 1 de 5**: scaffolding e banco de dados. Não pule pra fases seguintes — termine esta primeiro.

## Stack obrigatório (não substitua)

- **Frontend:** Next.js 14+ com App Router, TypeScript, Tailwind CSS, shadcn/ui
- **Backend:** Next.js API Routes / Server Actions (no mesmo repo)
- **DB:** Supabase (Postgres + Auth + Realtime + Storage)
- **WhatsApp:** WAHA (será adicionado na fase 2)

## Sua missão

1. Criar projeto Next.js
2. Instalar dependências
3. Configurar Supabase client (browser, server, admin)
4. Aplicar schema SQL universal de chat
5. Configurar variáveis de ambiente
6. Garantir que `npm run dev` roda

## Tasks detalhadas

### 1. Inicializar projeto

```bash
npx create-next-app@latest meucrm --typescript --tailwind --app --src-dir --no-eslint --import-alias "@/*"
cd meucrm
```

### 2. Instalar dependências

```bash
npm install @supabase/supabase-js @supabase/ssr zod date-fns lucide-react uuid
npm install -D @types/uuid
```

### 3. Inicializar shadcn/ui e adicionar componentes base

```bash
npx shadcn@latest init -y
npx shadcn@latest add button input textarea avatar tabs dialog separator scroll-area badge
```

### 4. Criar estrutura de pastas

```
src/
├── app/
│   ├── (crm)/
│   │   ├── chat/
│   │   │   ├── layout.tsx
│   │   │   ├── page.tsx
│   │   │   └── [conversationId]/page.tsx
│   │   └── settings/
│   │       └── whatsapp/page.tsx
│   ├── api/
│   │   └── wa/
│   │       ├── send/
│   │       ├── webhook/
│   │       ├── upload/
│   │       ├── qr/[id]/
│   │       └── sessions/
│   ├── layout.tsx
│   └── page.tsx
├── components/
│   ├── ui/                  (já criado pelo shadcn)
│   ├── chat/
│   └── whatsapp/
├── hooks/
├── lib/
│   ├── supabase/
│   │   ├── browser.ts
│   │   ├── server.ts
│   │   └── admin.ts
│   ├── waha/
│   │   ├── client.ts
│   │   ├── index.ts
│   │   ├── handlers/
│   │   ├── hmac.ts
│   │   ├── media.ts
│   │   └── webhook-processor.ts
│   └── utils.ts
└── types/
```

Crie pastas vazias mesmo (para organização). Arquivos virão depois.

### 5. Crie os 3 clients Supabase

**`src/lib/supabase/browser.ts`:**

```typescript
import { createBrowserClient } from '@supabase/ssr';

let cached: ReturnType<typeof createBrowserClient> | null = null;

export function getSupabaseBrowserClient() {
  if (cached) return cached;
  cached = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
  return cached;
}
```

**`src/lib/supabase/server.ts`:**

```typescript
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export function getSupabaseServerClient() {
  const cookieStore = cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get: (name) => cookieStore.get(name)?.value,
        set: (name, value, options) => cookieStore.set(name, value, options as any),
        remove: (name, options) => cookieStore.set(name, '', { ...options, maxAge: 0 } as any),
      },
    },
  );
}
```

**`src/lib/supabase/admin.ts`:**

```typescript
import { createClient } from '@supabase/supabase-js';

export function getSupabaseAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}
```

### 6. Criar `.env.local`

```bash
NEXT_PUBLIC_APP_URL="http://localhost:3001"
NEXT_PUBLIC_SUPABASE_URL=""
NEXT_PUBLIC_SUPABASE_ANON_KEY=""
SUPABASE_SERVICE_ROLE_KEY=""

# WAHA (preenchido na fase 2)
WAHA_BASE_URL="http://localhost:3000"
WAHA_API_KEY_PLAINTEXT=""

# Storage
SUPABASE_MEDIA_BUCKET="whatsapp-media"
```

### 7. Aplicar schema no Supabase

Crie `supabase/migrations/00001_init_chat_schema.sql` com EXATAMENTE este conteúdo:

```sql
create extension if not exists pgcrypto;

-- =============================================================================
-- ORGANIZATIONS (se não existe)
-- =============================================================================
create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  created_at timestamptz default now()
);

create table if not exists public.user_organizations (
  user_id uuid references auth.users(id) on delete cascade,
  organization_id uuid references public.organizations(id) on delete cascade,
  role text not null default 'member',
  created_at timestamptz default now(),
  primary key (user_id, organization_id)
);

-- =============================================================================
-- CHANNEL SESSIONS
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
-- CONTACTS
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
-- CONVERSATIONS
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

-- =============================================================================
-- MESSAGES
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
  ack int default 0 check (ack between -1 and 5),
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

-- =============================================================================
-- WEBHOOK EVENTS LOG
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

-- =============================================================================
-- TRIGGERS
-- =============================================================================
create or replace function public.fn_set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists trg_set_updated_at_contacts on public.contacts;
create trigger trg_set_updated_at_contacts before update on public.contacts for each row execute function public.fn_set_updated_at();

drop trigger if exists trg_set_updated_at_conversations on public.conversations;
create trigger trg_set_updated_at_conversations before update on public.conversations for each row execute function public.fn_set_updated_at();

drop trigger if exists trg_set_updated_at_sessions on public.channel_sessions;
create trigger trg_set_updated_at_sessions before update on public.channel_sessions for each row execute function public.fn_set_updated_at();

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
create trigger trg_message_inserted after insert on public.messages for each row execute function public.fn_update_conversation_on_message();

-- =============================================================================
-- RLS
-- =============================================================================
alter table public.contacts enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.channel_sessions enable row level security;

create or replace function public.fn_user_org_ids()
returns table(organization_id uuid) language sql stable security definer set search_path = public as $$
  select organization_id from public.user_organizations where user_id = auth.uid()
$$;

do $$
declare tbl text;
begin
  for tbl in select unnest(array['contacts', 'conversations', 'messages', 'channel_sessions']) loop
    execute format('drop policy if exists "tenant_all_%I" on public.%I', tbl, tbl);
    execute format('create policy "tenant_all_%I" on public.%I for all using (organization_id in (select organization_id from public.fn_user_org_ids())) with check (organization_id in (select organization_id from public.fn_user_org_ids()))', tbl, tbl);
  end loop;
end $$;

-- =============================================================================
-- REALTIME PUBLICATION
-- =============================================================================
do $$
begin
  begin alter publication supabase_realtime add table public.messages; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.conversations; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.channel_sessions; exception when duplicate_object then null; end;
end $$;
```

Aplicar este SQL via Supabase SQL Editor (manual) ou via Supabase CLI.

### 8. Criar bucket de storage

Via Supabase Dashboard → Storage → New bucket:
- Name: `whatsapp-media`
- Public: false
- File size limit: 16 MB

### 9. Seed de dados de teste

Crie `supabase/seed.sql`:

```sql
insert into public.organizations (name, slug) values ('Empresa Teste', 'empresa-teste') on conflict do nothing;
-- Substitua <SEU_USER_ID> pelo seu auth.users.id (pegue em Authentication → Users)
-- insert into public.user_organizations (user_id, organization_id, role)
-- select '<SEU_USER_ID>', id, 'admin' from public.organizations where slug = 'empresa-teste';
```

### 10. Atualizar `package.json` scripts

```json
{
  "scripts": {
    "dev": "next dev -p 3001",
    "build": "next build",
    "start": "next start -p 3001",
    "lint": "next lint"
  }
}
```

A porta 3001 deixa 3000 livre pro WAHA.

## Definition of Done

Antes de declarar pronto, confirme:

- [ ] `npm run dev` sobe em http://localhost:3001 sem erro
- [ ] Não há erros TypeScript em arquivos criados
- [ ] Migration SQL foi aplicada (você ou o usuário rodou)
- [ ] Bucket `whatsapp-media` existe no Supabase
- [ ] `.env.local` tem todas as keys (mesmo que algumas vazias)
- [ ] Estrutura de pastas em `src/` corresponde à listada acima

## Não faça

- ❌ Não crie endpoints de WAHA — isso é fase 2
- ❌ Não crie UI de chat — isso é fase 4
- ❌ Não substitua Next.js por outro framework
- ❌ Não use Pages Router (use App Router)
- ❌ Não crie tabelas extras além das listadas

## Comandos finais para rodar

```bash
npm run dev
```

Ao terminar, responda: **"Fase 01 completa. Pode prosseguir para a fase 02 (WAHA Integration)."**
