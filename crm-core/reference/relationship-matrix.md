# Reference — Matriz canônica de relacionamentos

> **Resumo:** matriz N×N entre os módulos típicos de um CRM nichado completo. Para cada par, indica o campo de ligação e o padrão usado (FK rígida, FK soft, polimórfica, denormalizado, evento, materialized view). Após a matriz, exemplos SQL de cada par importante.

---

## Notação

| Símbolo | Significado |
|--------|-------------|
| `FK→` | FK rígida apontando direção |
| `soft FK→` | FK sem constraint (cross-DB / cross-schema) |
| `poly→` | polimórfica (`target_kind` + `target_id`) |
| `denorm` | denormalização via trigger ou MV |
| `event` | comunicação por `event_log` + consumer worker |
| `MV` | materialized view |
| `—` | sem relação direta canônica |

---

## Matriz N×N

|             | **CRM**         | **Chat**          | **WhatsApp**       | **Email**         | **Calendar**       | **Documents**      | **Billing**       | **Files**          |
|-------------|-----------------|-------------------|--------------------|-------------------|--------------------|--------------------|-------------------|--------------------|
| **CRM**     | self            | poly→ via `crm_lead_links` | indireto (via Chat) | poly→ + `email_threads.lead_id FK→` | `appointments.lead_id FK→` | `documents.lead_id FK→` | `invoices.lead_id FK→` | `files.lead_id soft FK→` |
| **Chat**    | event → `crm_lead_activities`; poly← | self | `conversations.channel_session_id FK→` | irmão | poly via crm_lead_links | poly via crm_lead_links | indireto | `messages.media_url` denorm |
| **WhatsApp**| indireto via Chat | `conversations.channel_session_id FK←` | self | — | — | — | — | — |
| **Email**   | `email_threads.lead_id FK→`; event → activity | denorm em `crm_lead_activities` | — | self | — | poly via crm_lead_links | indireto | `email_attachments.email_id FK→` |
| **Calendar**| `appointments.lead_id FK→`; `appointments.contact_id FK→` | event → activity | — | event → email confirm | self | poly | `appointments.invoice_id soft FK→` | — |
| **Documents**| `documents.lead_id FK→` | poly via crm_lead_links | — | poly | poly | self | — | `documents.file_id FK→` |
| **Billing** | `invoices.lead_id FK→`; event "payment.received" → activity | denorm em `crm_lead_activities` | — | event → email recibo | event → cancelar appointment se inadimplência | `invoice.contract_id FK→` | self | `invoice.pdf_file_id FK→` |
| **Files**   | `files.lead_id soft FK→` | `messages.media_url` denorm | — | `email_attachments` FK | — | `documents.file_id FK→` | `invoices.pdf_file_id FK→` | self |

---

## Pares importantes — exemplos SQL

### CRM → Chat (lead vinculado a conversation)

```sql
-- Vincular lead a conversation principal
insert into crm_lead_links (lead_id, target_kind, target_id, link_kind)
values ('{lead-id}', 'conversation', '{conversation-id}', 'primary')
on conflict (lead_id, target_kind, target_id, link_kind) do nothing;

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

### CRM ← Calendar (appointment aponta lead)

```sql
create table if not exists public.appointments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id         uuid references public.crm_leads(id) on delete set null,
  contact_id      uuid references public.contacts(id) on delete set null,
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  status          text not null default 'scheduled'
                  check (status in ('scheduled', 'completed', 'cancelled', 'no_show')),
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_appointments_lead on public.appointments (lead_id);
create index if not exists idx_appointments_starts on public.appointments (organization_id, starts_at);

-- Trigger: ao criar appointment, gera activity no CRM
create or replace function public.fn_appointment_to_crm_activity()
returns trigger language plpgsql as $$
begin
  if new.lead_id is not null then
    insert into public.crm_lead_activities (
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

drop trigger if exists trg_appointment_log on public.appointments;
create trigger trg_appointment_log
  after insert on public.appointments
  for each row execute function public.fn_appointment_to_crm_activity();
```

### CRM ← Billing (invoice aponta lead)

```sql
create table if not exists public.invoices (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id         uuid references public.crm_leads(id) on delete set null,
  contact_id      uuid references public.contacts(id) on delete set null,
  amount_cents    bigint not null,
  currency        text not null default 'BRL',
  status          text not null default 'draft'
                  check (status in ('draft', 'sent', 'paid', 'overdue', 'cancelled')),
  due_date        date,
  paid_at         timestamptz,
  external_id     text,                          -- Stripe id, asaas id, etc.
  pdf_file_id     uuid,                          -- soft FK pra files(id)
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_invoices_lead on public.invoices (lead_id);
create index if not exists idx_invoices_status on public.invoices (organization_id, status);

-- Trigger: invoice paga → activity + auto-won (opcional)
create or replace function public.fn_invoice_paid_to_crm()
returns trigger language plpgsql as $$
declare
  default_won_stage_id uuid;
begin
  if new.status = 'paid' and old.status != 'paid' and new.lead_id is not null then
    insert into public.crm_lead_activities (organization_id, lead_id, type, title, body, source_module, source_id, performed_at, performed_by_kind, metadata)
    values (
      new.organization_id, new.lead_id,
      'payment_received',
      'Pagamento recebido',
      (new.amount_cents / 100.0)::text || ' ' || new.currency,
      'billing', new.id::text, now(), 'system',
      jsonb_build_object('amount_cents', new.amount_cents, 'currency', new.currency)
    );

    -- Auto-won opcional, só se invoice tem flag em settings
    select s.id into default_won_stage_id
    from public.crm_stages s
    join public.crm_leads l on l.pipeline_id = s.pipeline_id
    where l.id = new.lead_id and s.is_won = true
    limit 1;

    if default_won_stage_id is not null then
      update public.crm_leads
      set stage_id = default_won_stage_id
      where id = new.lead_id and status = 'open';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_invoice_paid on public.invoices;
create trigger trg_invoice_paid
  after update of status on public.invoices
  for each row execute function public.fn_invoice_paid_to_crm();
```

### CRM ← Email (email thread aponta lead)

```sql
create table if not exists public.email_threads (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id         uuid references public.crm_leads(id) on delete set null,
  contact_id      uuid references public.contacts(id) on delete set null,
  subject         text not null,
  participants    text[] not null default '{}'::text[],
  last_message_at timestamptz,
  unread_count    int not null default 0,
  status          text not null default 'open'
                  check (status in ('open', 'archived', 'spam')),
  created_at      timestamptz not null default now()
);

create table if not exists public.email_messages (
  id              uuid primary key default gen_random_uuid(),
  thread_id       uuid not null references public.email_threads(id) on delete cascade,
  organization_id uuid not null,
  from_address    text not null,
  to_addresses    text[] not null,
  cc_addresses    text[] not null default '{}'::text[],
  subject         text,
  body_html       text,
  body_text       text,
  received_at     timestamptz not null default now(),
  external_id     text,                          -- Resend id, IMAP message-id
  direction       text not null check (direction in ('inbound', 'outbound')),
  status          text not null default 'sent'
);

create index if not exists idx_email_threads_lead on public.email_threads (lead_id);
create index if not exists idx_email_messages_thread on public.email_messages (thread_id, received_at desc);
```

### Chat ↔ Files (mensagens com mídia)

```sql
-- messages.media_url denormalizado pra evitar JOIN em chat live (hot path)
-- Source of truth ainda é tabela files; messages só aponta o URL.

create table if not exists public.files (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id         uuid,                                      -- soft FK
  contact_id      uuid,                                      -- soft FK
  bucket          text not null,                              -- 'whatsapp-media', 'documents', etc.
  path            text not null,
  url             text not null,
  mime_type       text,
  size_bytes      bigint,
  created_at      timestamptz not null default now(),
  unique (bucket, path)
);

-- messages.media_url ← denorm de files.url, mantido na app no momento do INSERT
```

---

## Casos especiais

### Cross-database (BYO Supabase)

Quando o cliente roda Supabase próprio (BYO), `auth.users` está em **outro DB**. Não há FK possível.

| Padrão | Cenário | Implementação |
|--------|---------|--------------|
| Soft FK | `crm_leads.owner_user_id uuid` sem constraint | Validar na app |
| Sync por evento | Auth emite `user.updated` → BYO Supabase consome via webhook | event_log → worker → upsert local |
| Espelho local | Tabela `auth_users_mirror` no Client DB | Cron sync |

### Mesmo módulo, múltiplos provedores (e-mail)

Se você suporta IMAP + Resend + Gmail API ao mesmo tempo:

```
email_threads.provider text   -- 'imap' | 'resend' | 'gmail'
email_threads.external_thread_id text
```

E `crm_lead_activities.source_module = 'email'` independente do provedor (consumidor não precisa saber).

### Polimorfismo com FK rígida (alternativa)

Em vez de `target_kind + target_id` polimórfico, alguns projetos preferem **N tabelas link**:

```
crm_lead_conversation_links (lead_id, conversation_id)
crm_lead_appointment_links (lead_id, appointment_id)
crm_lead_invoice_links (lead_id, invoice_id)
...
```

🎯 **Decisão:** o padrão polimórfico (`crm_lead_links`) é melhor pra **extensibilidade** (módulos novos sem migração) e pior pra **integridade referencial** (sem FK). Em sistemas pequenos com até 4-5 tipos de link, N tabelas pode ser razoável. **Padrão da aula é polimórfico** porque o ecossistema de módulos cresce com o tempo.

---

## Tabela: padrão preferido por par

| Par | Padrão | Justificativa |
|-----|--------|--------------|
| CRM ← appointments | FK rígida | appointment não faz sentido sem lead em 99% dos casos |
| CRM ← invoices | FK rígida + ON DELETE SET NULL | invoice tem vida própria pós-fechamento; soft cascade preserva audit |
| CRM ↔ conversations | poly via crm_lead_links | conversa pode existir sem lead; lead pode ter várias conversas |
| CRM ← email_threads | FK rígida + ON DELETE SET NULL | email thread tem identidade própria mas se relaciona com lead |
| CRM ← documents | FK rígida + ON DELETE SET NULL | documento pode sobreviver ao lead (LGPD: anonimizar lead, manter doc) |
| CRM → activities | FK rígida + CASCADE | activity sem lead-pai não faz sentido (ou é "órfã" intencional) |
| billing → CRM (lead.status='won') | event | tx separada; auto-won é regra opcional, não constraint |
| chat → CRM (activity de mensagem) | event + idempotente | webhook reentrega; idempotency_key evita duplicar |

---

## Diagrama macro

```
                            ┌─────────────────┐
                            │   organizations │
                            └────────┬────────┘
                                     │
            ┌────────────────────────┼────────────────────────┐
            │                        │                        │
       ┌────▼──────┐         ┌───────▼────────┐       ┌───────▼──────┐
       │  contacts │         │ crm_pipelines  │       │  user_orgs   │
       └────┬──────┘         └───────┬────────┘       └──────────────┘
            │                        │
            │                ┌───────▼────────┐
            │                │   crm_stages   │
            │                └───────┬────────┘
            │                        │
            │                ┌───────▼────────┐
            └───────────────►│   crm_leads    │◄──────┐
                             └───────┬────────┘       │
                  ┌──────────────────┼─────────────┐  │
                  │                  │             │  │
       ┌──────────▼─────┐    ┌──────▼─────┐  ┌────▼──┴────────┐
       │ crm_lead_      │    │crm_lead_   │  │  appointments  │
       │ activities     │    │links       │  │  invoices      │
       │                │    │(poly→ qq)  │  │  documents     │
       └──────────┬─────┘    └────────────┘  │  email_threads │
                  │                          │  files         │
                  │                          │  ...           │
              source_id                      └────────────────┘
              source_module
                  │
                  ▼
          (qualquer módulo)
                  │
       ┌──────────▼─────────┐
       │   conversations    │   ← chat module (já existente)
       │   messages         │
       │   channel_sessions │
       └────────────────────┘
```

---

## Fim
