# PROMPT 05 — CRM Binding (Pipeline + Deals)

> **Última fase. Cole após Fase 04. Liga as conversas ao funil do CRM.**

---

## Contexto

Fase **5 de 5**. Você já tem: scaffolding (1), WAHA + sessões (2), webhook + envio (3), UI de chat live com realtime (4). Mensagens fluem dos dois lados, UI bonita.

Falta o que torna isso um CRM real: **binding com pipeline**. Mensagem nova de número novo → cria contato + deal + activity. Operador vê o deal vinculado no painel lateral e move pelo funil.

## Sua missão

1. Schema CRM: `crm_pipelines`, `crm_stages`, `crm_deals`, `crm_activities`
2. Seed default: 1 pipeline com 4 estágios
3. Função `bindMessageToCrm` chamada no webhook
4. Painel lateral (`CRMSidePanel`) integrado à thread
5. UI de mover deal entre estágios

## Princípios

- **Não duplicar deals.** Se contato tem deal aberto, vincula a esse. Se não tem, cria um novo.
- **Não criar deal pra grupos.** Mensagem em grupo não vira deal automaticamente.
- **Activity log.** Cada mensagem inbound gera uma activity vinculada ao deal — pra timeline.
- **CRM Side Panel realtime.** Mudança no deal aparece sem reload.

## Tasks

### 1. Migration adicional

Crie `supabase/migrations/00002_crm_pipeline.sql`:

```sql
-- Pipelines
create table if not exists public.crm_pipelines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  is_default boolean default false,
  position int default 0,
  created_at timestamptz default now()
);
create index if not exists idx_pipelines_org on public.crm_pipelines (organization_id);

-- Stages
create table if not exists public.crm_stages (
  id uuid primary key default gen_random_uuid(),
  pipeline_id uuid not null references public.crm_pipelines(id) on delete cascade,
  name text not null,
  position int not null,
  is_won boolean default false,
  is_lost boolean default false,
  color text default '#94a3b8',
  created_at timestamptz default now()
);
create index if not exists idx_stages_pipeline on public.crm_stages (pipeline_id, position);

-- Deals
create table if not exists public.crm_deals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  pipeline_id uuid not null references public.crm_pipelines(id),
  stage_id uuid not null references public.crm_stages(id),
  contact_id uuid not null references public.contacts(id) on delete cascade,
  title text not null,
  value_cents bigint default 0,
  currency text default 'BRL',
  owner_user_id uuid,
  source text,
  source_conversation_id uuid references public.conversations(id),
  status text default 'open' check (status in ('open', 'won', 'lost')),
  closed_at timestamptz,
  custom_fields jsonb default '{}'::jsonb,
  tags text[] default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_deals_org_stage on public.crm_deals (organization_id, stage_id);
create index if not exists idx_deals_contact on public.crm_deals (contact_id);
create index if not exists idx_deals_owner on public.crm_deals (owner_user_id);

-- Activities
create table if not exists public.crm_activities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  contact_id uuid references public.contacts(id),
  deal_id uuid references public.crm_deals(id),
  type text not null,
  title text,
  body text,
  performed_by_user_id uuid,
  performed_at timestamptz default now(),
  created_at timestamptz default now()
);
create index if not exists idx_activities_contact on public.crm_activities (contact_id, performed_at desc);
create index if not exists idx_activities_deal on public.crm_activities (deal_id, performed_at desc);

-- Trigger updated_at
drop trigger if exists trg_set_updated_at_deals on public.crm_deals;
create trigger trg_set_updated_at_deals before update on public.crm_deals for each row execute function public.fn_set_updated_at();

-- RLS
alter table public.crm_pipelines enable row level security;
alter table public.crm_stages enable row level security;
alter table public.crm_deals enable row level security;
alter table public.crm_activities enable row level security;

-- Pipelines/Stages têm RLS via pipeline.organization_id
do $$
begin
  drop policy if exists "tenant_pipelines_all" on public.crm_pipelines;
  create policy "tenant_pipelines_all" on public.crm_pipelines for all
    using (organization_id in (select organization_id from public.fn_user_org_ids()))
    with check (organization_id in (select organization_id from public.fn_user_org_ids()));

  drop policy if exists "tenant_stages_all" on public.crm_stages;
  create policy "tenant_stages_all" on public.crm_stages for all
    using (exists (
      select 1 from public.crm_pipelines p where p.id = crm_stages.pipeline_id
        and p.organization_id in (select organization_id from public.fn_user_org_ids())
    ))
    with check (exists (
      select 1 from public.crm_pipelines p where p.id = crm_stages.pipeline_id
        and p.organization_id in (select organization_id from public.fn_user_org_ids())
    ));

  drop policy if exists "tenant_deals_all" on public.crm_deals;
  create policy "tenant_deals_all" on public.crm_deals for all
    using (organization_id in (select organization_id from public.fn_user_org_ids()))
    with check (organization_id in (select organization_id from public.fn_user_org_ids()));

  drop policy if exists "tenant_activities_all" on public.crm_activities;
  create policy "tenant_activities_all" on public.crm_activities for all
    using (organization_id in (select organization_id from public.fn_user_org_ids()))
    with check (organization_id in (select organization_id from public.fn_user_org_ids()));
end $$;

-- Realtime
do $$
begin
  begin alter publication supabase_realtime add table public.crm_deals; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.crm_activities; exception when duplicate_object then null; end;
end $$;
```

Aplique no Supabase SQL Editor.

### 2. Seed default

Rode (substituindo pelo `<ORG_ID>` da sua org de teste):

```sql
-- Pipeline default
insert into public.crm_pipelines (id, organization_id, name, is_default, position)
values ('00000000-0000-0000-0000-000000000001', '<ORG_ID>', 'Funil Principal', true, 0)
on conflict do nothing;

-- 4 estágios
insert into public.crm_stages (pipeline_id, name, position, color, is_won, is_lost) values
  ('00000000-0000-0000-0000-000000000001', 'Lead novo', 0, '#3b82f6', false, false),
  ('00000000-0000-0000-0000-000000000001', 'Qualificado', 1, '#8b5cf6', false, false),
  ('00000000-0000-0000-0000-000000000001', 'Negociação', 2, '#eab308', false, false),
  ('00000000-0000-0000-0000-000000000001', 'Ganhou', 3, '#10b981', true, false)
on conflict do nothing;
```

### 3. CRM Binding lib

`src/lib/crm/binding.ts`:

```typescript
import type { SupabaseClient } from '@supabase/supabase-js';

export async function bindMessageToCrm(args: {
  supabase: SupabaseClient;
  organizationId: string;
  contactId: string;
  conversationId: string;
  isInbound: boolean;
  isGroup: boolean;
  messageBody: string | null;
}) {
  const { supabase, organizationId, contactId, conversationId, isInbound, isGroup, messageBody } = args;
  if (!isInbound || isGroup) return;

  // 1. Pipeline default + primeiro stage
  const { data: pipeline } = await supabase
    .from('crm_pipelines')
    .select('id, crm_stages(id, position)')
    .eq('organization_id', organizationId)
    .eq('is_default', true)
    .single();
  if (!pipeline) return;

  const stages = (pipeline as any).crm_stages.sort((a: any, b: any) => a.position - b.position);
  if (!stages.length) return;
  const firstStageId = stages[0].id;

  // 2. Deal aberto pra esse contato?
  const { data: existingDeals } = await supabase
    .from('crm_deals')
    .select('id')
    .eq('contact_id', contactId)
    .eq('status', 'open')
    .limit(1);

  let dealId: string | null = existingDeals?.[0]?.id ?? null;

  if (!dealId) {
    // Cria novo
    const { data: contact } = await supabase
      .from('contacts')
      .select('full_name, push_name, phone_number')
      .eq('id', contactId)
      .single();
    const title = `Novo contato: ${contact?.full_name ?? contact?.push_name ?? contact?.phone_number ?? 'Sem nome'}`;
    const { data: newDeal } = await supabase
      .from('crm_deals')
      .insert({
        organization_id: organizationId,
        pipeline_id: pipeline.id,
        stage_id: firstStageId,
        contact_id: contactId,
        title,
        source: 'whatsapp_inbound',
        source_conversation_id: conversationId,
      })
      .select('id')
      .single();
    dealId = newDeal?.id ?? null;
  }

  if (dealId) {
    // Vincula conversation
    await supabase
      .from('conversations')
      .update({ primary_deal_id: dealId })
      .eq('id', conversationId)
      .is('primary_deal_id', null);

    // Activity
    await supabase.from('crm_activities').insert({
      organization_id: organizationId,
      contact_id: contactId,
      deal_id: dealId,
      type: 'whatsapp',
      title: 'Mensagem recebida',
      body: messageBody?.slice(0, 200) ?? null,
    });
  }
}
```

### 4. Atualizar handler de mensagem

Em `src/lib/waha/handlers/message.ts`, no final da função `handleIncomingMessage`, adicione:

```typescript
import { bindMessageToCrm } from '@/lib/crm/binding';

// ... (depois do INSERT da message, dentro da função)
if (!fromMe) {
  await bindMessageToCrm({
    supabase,
    organizationId: channelSession.organization_id,
    contactId: contact.id,
    conversationId: conv.id,
    isInbound: true,
    isGroup,
    messageBody: p.body ?? p.caption ?? null,
  });
}
```

### 5. Hook `useDeal`

`src/hooks/useDeal.ts`:

```typescript
'use client';
import { useState, useEffect } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { useRealtimeChannel } from './useRealtimeChannel';

export function useDealsForContact(contactId: string) {
  const [deals, setDeals] = useState<any[]>([]);
  const [stages, setStages] = useState<any[]>([]);

  const fetchData = async () => {
    if (!contactId) return;
    const supa = getSupabaseBrowserClient();
    const { data: dealsData } = await supa
      .from('crm_deals')
      .select('id, title, value_cents, status, stage_id, stage:crm_stages(id, name, color), pipeline_id')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false });
    setDeals(dealsData ?? []);

    if (dealsData && dealsData.length > 0) {
      const { data: stagesData } = await supa
        .from('crm_stages')
        .select('id, name, position, color')
        .eq('pipeline_id', (dealsData[0] as any).pipeline_id)
        .order('position');
      setStages(stagesData ?? []);
    }
  };

  useEffect(() => { fetchData(); }, [contactId]);

  useRealtimeChannel({
    channelName: `deals_contact_${contactId}`,
    table: 'crm_deals',
    filter: `contact_id=eq.${contactId}`,
    onChange: () => fetchData(),
  });

  const moveStage = async (dealId: string, newStageId: string) => {
    const supa = getSupabaseBrowserClient();
    await supa.from('crm_deals').update({ stage_id: newStageId }).eq('id', dealId);
  };

  return { deals, stages, moveStage, refresh: fetchData };
}
```

### 6. Componente `CRMSidePanel`

`src/components/chat/CRMSidePanel.tsx`:

```typescript
'use client';
import { useEffect, useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { ContactSection } from './sidepanel/ContactSection';
import { DealsSection } from './sidepanel/DealsSection';
import { ActivitiesSection } from './sidepanel/ActivitiesSection';

export function CRMSidePanel({ conversationId }: { conversationId: string }) {
  const [conv, setConv] = useState<any>(null);

  useEffect(() => {
    const supa = getSupabaseBrowserClient();
    supa
      .from('conversations')
      .select('id, contact_id, primary_deal_id, contact:contacts(*)')
      .eq('id', conversationId)
      .single()
      .then(({ data }) => setConv(data));
  }, [conversationId]);

  if (!conv) return null;

  return (
    <aside className="w-96 border-l border-border bg-card overflow-y-auto">
      <ContactSection contact={(conv as any).contact} />
      <DealsSection contactId={conv.contact_id} primaryDealId={conv.primary_deal_id} />
      <ActivitiesSection contactId={conv.contact_id} />
    </aside>
  );
}
```

### 7. ContactSection

`src/components/chat/sidepanel/ContactSection.tsx`:

```typescript
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';

export function ContactSection({ contact }: { contact: any }) {
  if (!contact) return null;
  const name = contact.full_name ?? contact.push_name ?? contact.phone_number;

  return (
    <section className="p-4 border-b border-border">
      <div className="flex items-center gap-3 mb-3">
        <Avatar className="w-12 h-12">
          {contact.profile_picture_url && <AvatarImage src={contact.profile_picture_url} />}
          <AvatarFallback>{name.charAt(0).toUpperCase()}</AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <div className="font-semibold truncate">{name}</div>
          <div className="text-xs text-muted-foreground">{contact.phone_number}</div>
        </div>
      </div>
      {contact.email && (
        <div className="text-sm text-muted-foreground">📧 {contact.email}</div>
      )}
      {contact.company && (
        <div className="text-sm text-muted-foreground">🏢 {contact.company}</div>
      )}
      {contact.tags?.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {contact.tags.map((t: string) => (
            <span key={t} className="bg-accent text-accent-foreground text-xs px-2 py-0.5 rounded">{t}</span>
          ))}
        </div>
      )}
    </section>
  );
}
```

### 8. DealsSection

`src/components/chat/sidepanel/DealsSection.tsx`:

```typescript
'use client';
import { useDealsForContact } from '@/hooks/useDeal';
import { Button } from '@/components/ui/button';

export function DealsSection({ contactId, primaryDealId }: { contactId: string; primaryDealId: string | null }) {
  const { deals, stages, moveStage } = useDealsForContact(contactId);

  return (
    <section className="border-b border-border p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-sm">Negócios ({deals.length})</h3>
      </div>
      {deals.length === 0 && (
        <p className="text-xs text-muted-foreground">Nenhum negócio vinculado.</p>
      )}
      <div className="space-y-2">
        {deals.map((d) => (
          <div key={d.id} className="border rounded-md p-3 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium truncate">{d.title}</span>
              {d.id === primaryDealId && (
                <span className="text-[10px] px-1.5 py-0.5 bg-primary/10 text-primary rounded">Principal</span>
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              {(d.value_cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
            </div>
            <select
              value={d.stage_id}
              onChange={(e) => moveStage(d.id, e.target.value)}
              className="w-full text-xs rounded border bg-background px-2 py-1"
            >
              {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        ))}
      </div>
    </section>
  );
}
```

### 9. ActivitiesSection

`src/components/chat/sidepanel/ActivitiesSection.tsx`:

```typescript
'use client';
import { useEffect, useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { formatDistanceToNowStrict } from 'date-fns';
import { ptBR } from 'date-fns/locale';

export function ActivitiesSection({ contactId }: { contactId: string }) {
  const [activities, setActivities] = useState<any[]>([]);

  useEffect(() => {
    if (!contactId) return;
    const supa = getSupabaseBrowserClient();
    supa
      .from('crm_activities')
      .select('id, type, title, body, performed_at')
      .eq('contact_id', contactId)
      .order('performed_at', { ascending: false })
      .limit(20)
      .then(({ data }) => setActivities(data ?? []));
  }, [contactId]);

  return (
    <section className="p-4">
      <h3 className="font-semibold text-sm mb-3">Histórico</h3>
      {activities.length === 0 && (
        <p className="text-xs text-muted-foreground">Sem atividades.</p>
      )}
      <ul className="space-y-3">
        {activities.map((a) => (
          <li key={a.id} className="border-l-2 border-border pl-3">
            <div className="text-sm font-medium">{a.title}</div>
            {a.body && <div className="text-xs text-muted-foreground line-clamp-2">{a.body}</div>}
            <div className="text-[10px] text-muted-foreground mt-0.5">
              {formatDistanceToNowStrict(new Date(a.performed_at), { addSuffix: true, locale: ptBR })}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

### 10. Atualizar página da conversa pra incluir SidePanel

Edite `src/app/(crm)/chat/[conversationId]/page.tsx`:

```typescript
import { ConversationList } from '@/components/chat/ConversationList';
import { ChatThread } from '@/components/chat/ChatThread';
import { CRMSidePanel } from '@/components/chat/CRMSidePanel';

export default function ConversationPage({ params }: { params: { conversationId: string } }) {
  return (
    <>
      <ConversationList activeConversationId={params.conversationId} />
      <ChatThread conversationId={params.conversationId} />
      <CRMSidePanel conversationId={params.conversationId} />
    </>
  );
}
```

## Testar

1. Mande mensagem do celular pro número conectado (de número que ainda não tinha contato)
2. Deve criar:
   - 1 row em `contacts`
   - 1 row em `conversations` com `primary_deal_id` preenchido
   - 1 row em `crm_deals` com stage = "Lead novo"
   - 1 row em `crm_activities` tipo "whatsapp"
3. Abra a conversa no `/chat/[id]`
4. SidePanel direito mostra contato + 1 deal + 1 activity
5. Mude o estágio do deal pelo select → atualiza no DB

## Definition of Done

- [ ] Mensagem de número novo cria deal automaticamente
- [ ] Deal aparece no SidePanel marcado como "Principal"
- [ ] Selecionar outro estágio no select muda o `stage_id` no DB (verificar via SQL)
- [ ] Activity é criada a cada mensagem inbound
- [ ] Mensagem em grupo NÃO cria deal
- [ ] Segunda mensagem do mesmo contato NÃO cria deal duplicado (vincula ao existente)

## Bonus (opcional)

- Criar página `/pipeline` com kanban drag & drop usando `@hello-pangea/dnd`
- Auto-assignment round-robin de operador
- Webhook outbound: notificar URL externa quando deal muda de estágio

## Não faça

- ❌ Substituir o schema. Mantenha exatamente como descrito.

Ao terminar: **"Fase 05 completa. CRM com Chat Live + WhatsApp + Binding está pronto para uso."**

Cheque [12-checklist-implementacao.md](../12-checklist-implementacao.md) para próximos passos de produção (segurança, robustez, deploy).
