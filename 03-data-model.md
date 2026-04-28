# 03 — Data Model: o schema universal

> **Resumo:** as 5 tabelas mínimas que sustentam Chat Live + WhatsApp + binding com CRM. Schema executável (Postgres). Decisões de modelagem comentadas.

---

## 1. Princípios de modelagem

1. **Conversation vs Message são separadas.** Uma conversation é o "thread" estável (com um contato), uma message é cada balão. Isso permite atribuição, status de leitura, marcação como resolvida, sem mexer nas mensagens.
2. **External IDs em todo lugar.** Toda entidade que vem do WhatsApp tem `external_id` (o ID que o WAHA retorna). Permite idempotência de webhooks.
3. **Contact é independente da conversation.** Mesma pessoa pode ter várias conversations (ex: número de WhatsApp pessoal e comercial). Contact é único por `phone_number normalizado`.
4. **Multi-tenant via `organization_id`.** Toda tabela de conteúdo carrega `organization_id` e tem RLS.
5. **Status soft-delete no lugar de DELETE.** Conversa "arquivada" é flag, não deleção — você nunca quer perder histórico.

---

## 2. As 5 tabelas mínimas

```
organizations          (você já tem do CRM)
├── channel_sessions   (1 sessão WAHA = 1 número conectado)
│
├── contacts           (pessoa física na WhatsApp)
│   └── conversations  (thread com 1 contact)
│       └── messages   (balões da thread)
```

E você já tem do CRM:
- `crm_pipelines`, `crm_stages`, `crm_deals` — discutido em [09-binding-crm.md](09-binding-crm.md)

---

## 3. Schema completo (Postgres / Supabase)

> Versão completa pronta pra rodar em [reference/schema.sql](reference/schema.sql).

### 3.1 `channel_sessions`

```sql
create table public.channel_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  
  -- Identificação WAHA
  provider text not null default 'waha',           -- 'waha', 'evolution', 'meta_official', etc.
  waha_session_name text not null,                  -- ex: "clinic-acme-1"
  waha_base_url text,                               -- só pra BYO (cliente roda WAHA próprio)
  waha_api_key_encrypted text,                      -- só pra BYO; em SaaS-mode é nulo
  
  -- Identificação do número
  phone_number text,                                -- ex: +5511999999999 (preenchido após autenticação)
  display_name text,                                -- nome do WhatsApp Business
  
  -- Estado
  status text not null default 'pending',           -- pending, scan_qr, working, stopped, failed
  qr_code text,                                     -- base64 atual; null quando autenticado
  last_status_at timestamptz default now(),
  
  -- Webhook
  webhook_secret text not null,                     -- usado pra HMAC; gere com gen_random_bytes(32)
  
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  
  unique (organization_id, waha_session_name)
);

create index on public.channel_sessions (organization_id);
create index on public.channel_sessions (status);
```

**Decisões:**
- `waha_session_name` é gerado por você (ex: `org-{slug}-1`). É o que vai no path da API WAHA.
- `webhook_secret` é por sessão pra que se vazar um, só compromete uma.
- `phone_number` só é populado depois que o WAHA autentica via QR — antes disso é null.

### 3.2 `contacts`

```sql
create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  
  -- Identidade
  phone_number text not null,                       -- E.164: +5511999999999
  whatsapp_id text,                                  -- formato WAHA: 5511999999999@c.us (sem '+')
  full_name text,
  push_name text,                                    -- nome que o contato definiu no WhatsApp
  profile_picture_url text,
  
  -- CRM enrichment (opcional, pode ser nulo)
  email text,
  company text,
  notes text,
  tags text[] default '{}',
  
  -- Lifecycle
  is_blocked boolean default false,
  first_message_at timestamptz,
  last_message_at timestamptz,
  
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  
  unique (organization_id, phone_number)
);

create index on public.contacts (organization_id);
create index on public.contacts (whatsapp_id);
create index on public.contacts (last_message_at desc);
```

**Decisões:**
- `phone_number` é único por org. Mesma pessoa pode ser contact de múltiplas orgs (cliente de duas clínicas, por exemplo).
- `whatsapp_id` é separado pq é o formato que o WAHA usa (`@c.us` para individual, `@g.us` para grupo).
- `tags` como array TEXT[] cobre 90% dos casos. Se você precisa de tag com cor/owner/etc., faça uma tabela separada.

### 3.3 `conversations`

```sql
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  channel_session_id uuid not null references public.channel_sessions(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  
  -- WhatsApp identity
  whatsapp_chat_id text not null,                   -- ex: 5511999999999@c.us
  is_group boolean default false,
  group_name text,                                   -- preenchido se is_group
  
  -- Atribuição (CRM)
  assigned_user_id uuid,                             -- references auth.users(id)
  
  -- Estado da conversa (CRM)
  status text not null default 'open',              -- open, pending, resolved, archived
  unread_count int not null default 0,
  last_message_preview text,                        -- snippet pra lista lateral
  last_message_at timestamptz,
  last_inbound_at timestamptz,                      -- útil pra calcular janela de 24h
  last_outbound_at timestamptz,
  
  -- Binding com CRM
  primary_deal_id uuid,                              -- references crm_deals(id) nullable
  
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  
  unique (organization_id, channel_session_id, whatsapp_chat_id)
);

create index on public.conversations (organization_id, last_message_at desc);
create index on public.conversations (assigned_user_id);
create index on public.conversations (status);
create index on public.conversations (contact_id);
```

**Decisões:**
- Unique por `(org, session, chat_id)`: o mesmo contato em sessões diferentes (números diferentes do negócio) = conversations diferentes.
- `last_message_preview` denormalizado pra evitar JOIN na lista lateral.
- `unread_count` denormalizado é polêmico — alternativa é calcular via SELECT, mas em escala dói.
- `primary_deal_id` é o "deal principal" associado (pq um contato pode ter vários deals).

### 3.4 `messages`

```sql
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  
  -- Identificação no WAHA/WhatsApp
  external_id text,                                 -- ID que o WAHA retorna (ex: "true_5511...@c.us_3EB0...")
  external_session text,                            -- session name na qual a mensagem nasceu
  
  -- Direção e remetente
  from_me boolean not null,                         -- true = enviei (operador), false = cliente
  sender_user_id uuid,                              -- só preenchido se from_me=true (auth.users.id)
  sender_phone text,                                 -- útil em grupos pra identificar quem mandou
  
  -- Conteúdo
  type text not null,                               -- text, image, video, audio, document, sticker, location, contact, reaction, system
  body text,                                        -- texto puro ou caption
  media_url text,                                   -- URL pública (Supabase Storage ou S3) se type != text
  media_mime_type text,
  media_size_bytes int,
  media_filename text,
  media_duration_seconds int,                       -- pra audio/video
  metadata jsonb default '{}'::jsonb,               -- payloads extras: location, quoted_message_id, reactions, etc.
  
  -- Status (ack)
  status text not null default 'sending',           -- sending, sent, delivered, read, failed
  ack int default 0,                                 -- 0..5 (vide doc 01)
  failed_reason text,
  
  -- Timestamps
  sent_at timestamptz,                              -- quando foi enviada (cliente para nós) ou despachada (nós pro cliente)
  delivered_at timestamptz,
  read_at timestamptz,
  created_at timestamptz default now(),
  
  -- Idempotência
  unique (organization_id, external_id) deferrable initially deferred
);

create index on public.messages (conversation_id, sent_at desc);
create index on public.messages (organization_id, created_at desc);
create index on public.messages (external_id);
create index on public.messages (status) where status in ('sending', 'failed');
```

**Decisões críticas:**
- `external_id` é o **único campo idempotente**. Se o WAHA reentrega o webhook, o INSERT falha por unique (você captura o erro e ignora).
- `metadata` jsonb é o "saco de coisas" — dá flexibilidade sem migração para cada novo tipo de evento.
- `media_url` aponta pra **seu storage**, não pro WAHA. Você baixa a mídia do WAHA e re-uploada (ver doc 05). WAHA Plus permite S3 direto.
- `ack` separado de `status` porque alguns sistemas distinguem "delivered" (chegou no servidor WhatsApp) de "device delivered" (chegou no aparelho).

### 3.5 `webhook_events_log` (auditoria)

```sql
create table public.webhook_events_log (
  id uuid primary key default gen_random_uuid(),
  channel_session_id uuid references public.channel_sessions(id) on delete set null,
  
  event_type text not null,                         -- message, message.ack, session.status, etc.
  external_id text,                                 -- pra correlacionar
  payload jsonb not null,
  
  processed_at timestamptz,
  processing_error text,
  
  received_at timestamptz default now()
);

create index on public.webhook_events_log (received_at desc);
create index on public.webhook_events_log (event_type, received_at desc);
create index on public.webhook_events_log (external_id) where external_id is not null;
```

**Decisões:**
- Loga TUDO que vem do WAHA antes de processar. Salva sua vida em debugging de produção.
- Faça purge automático após 30-90 dias (pg_cron).

---

## 4. Triggers úteis

### 4.1 Atualizar `conversations.last_message_*` quando insere mensagem

```sql
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

create trigger trg_message_inserted
  after insert on public.messages
  for each row execute function public.fn_update_conversation_on_message();
```

### 4.2 Atualizar `contacts.last_message_at`

```sql
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

create trigger trg_message_inserted_contact
  after insert on public.messages
  for each row execute function public.fn_update_contact_on_message();
```

### 4.3 `updated_at` automático

```sql
create or replace function public.fn_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Aplicar em todas as tabelas que tem updated_at
create trigger trg_set_updated_at_contacts
  before update on public.contacts
  for each row execute function public.fn_set_updated_at();

create trigger trg_set_updated_at_conversations
  before update on public.conversations
  for each row execute function public.fn_set_updated_at();

create trigger trg_set_updated_at_sessions
  before update on public.channel_sessions
  for each row execute function public.fn_set_updated_at();
```

---

## 5. Row-Level Security (RLS)

⚠️ **Não pular.** Sem RLS, qualquer usuário autenticado vê dados de qualquer org.

```sql
alter table public.contacts enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.channel_sessions enable row level security;

-- Helper: pega organization_id do usuário logado (assumindo tabela user_organizations)
-- Se você não tem essa tabela ainda, crie uma simples: (user_id, organization_id, role)

create or replace function public.fn_user_org_ids()
returns table(organization_id uuid) language sql stable as $$
  select organization_id from public.user_organizations where user_id = auth.uid()
$$;

-- Política exemplo (replicar para as 4 tabelas)
create policy "org_members_select_messages"
  on public.messages for select
  using (organization_id in (select organization_id from public.fn_user_org_ids()));

create policy "org_members_insert_messages"
  on public.messages for insert
  with check (organization_id in (select organization_id from public.fn_user_org_ids()));

create policy "org_members_update_messages"
  on public.messages for update
  using (organization_id in (select organization_id from public.fn_user_org_ids()));
```

**Service role bypass:** Edge Functions e webhook handlers usam `service_role` key, que ignora RLS. RLS é pra cliente autenticado no frontend.

---

## 6. Realtime: o que publicar

```sql
-- Adicionar ao publication padrão do Supabase
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.conversations;
alter publication supabase_realtime add table public.channel_sessions;
```

Frontend escuta:
- `messages` filtrado por `organization_id` → atualiza thread aberta + lista lateral
- `conversations` filtrado por `organization_id` → atualiza ordering, unread_count, atribuição
- `channel_sessions` filtrado por `organization_id` → atualiza status do número (autenticado, caiu, etc.)

---

## 7. Decisões de modelagem comentadas

### Por que não guardar mensagens em jsonb num campo da conversation?

Tentação comum. Não faça. Razões:
- Lista lateral precisa de query rápida → indexação só funciona em colunas top-level
- Search em mensagens (procurar "boleto" em todas as conversas) → impossível em jsonb sem GIN
- Realtime de mensagens individuais → Supabase publica linhas, não diffs em jsonb
- Soft-delete e edit history → versionar campo jsonb é inferno

### Por que `external_id` nullable?

Para mensagens **outbound** que ainda estão `status='sending'`, você ainda não tem o ID do WAHA. Ele vem na resposta do `POST /sendText`. Antes disso, ID nulo.

### Por que separar `sent_at` de `created_at`?

- `created_at` = quando você gravou no DB
- `sent_at` = timestamp que o WhatsApp registra (vem no payload)

Mensagens fora de ordem (você gravou tarde, mas a mensagem é antiga, ex: replay de webhook) precisam ordenar por `sent_at` na UI.

### Por que `type` é text e não enum?

Enums em Postgres são chatos pra estender (precisa de `ALTER TYPE`). Text + check constraint é igualmente performático e flexível.

```sql
alter table public.messages add constraint messages_type_check
  check (type in ('text', 'image', 'video', 'audio', 'document', 'sticker', 'location', 'contact', 'reaction', 'system'));
```

---

## 8. Migração inicial (ordem)

```
1. Crie organizations e user_organizations (se ainda não existe)
2. Rode reference/schema.sql (cria channel_sessions, contacts, conversations, messages, webhook_events_log)
3. Rode os triggers
4. Habilite RLS e crie policies
5. Adicione tabelas ao publication realtime
6. Seed: insira 1 organization de teste e 1 user_organization
```

---

## Próximo: [04-waha-setup.md](04-waha-setup.md)
