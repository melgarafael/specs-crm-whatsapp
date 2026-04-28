# 09 — Binding CRM: conversa → contato → pipeline

> **Resumo:** como uma conversa de WhatsApp se conecta ao funil do CRM. Match por número, criação automática de deals, atribuição, automações de roteamento. Universal pra qualquer nicho.

---

## 1. O que é "binding"

Binding é a ligação semântica entre o **mundo da mensagem** (conversation, message) e o **mundo do CRM** (contact, deal, pipeline, stage).

Sem binding, você tem um inbox de WhatsApp bonito. **Com binding, você tem um CRM**.

Os 3 binds que importam:
1. **Mensagem ↔ Contato** — toda mensagem é de/para alguém. Resolva ASAP.
2. **Conversa ↔ Deal** — uma conversa pode estar resolvendo um deal específico (ou criando um).
3. **Conversa ↔ Operador** — quem está cuidando dessa conversa.

---

## 2. Schema CRM mínimo (ajuste pro seu nicho)

A maior parte dos CRMs nichados tem essa espinha dorsal — só muda o vocabulário.

```sql
-- Pipelines (você pode ter um por equipe ou um geral)
create table if not exists public.crm_pipelines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  is_default boolean default false,
  position int default 0,
  created_at timestamptz default now()
);

-- Estágios (colunas do funil)
create table if not exists public.crm_stages (
  id uuid primary key default gen_random_uuid(),
  pipeline_id uuid not null references public.crm_pipelines(id) on delete cascade,
  name text not null,
  position int not null,
  is_won boolean default false,        -- estágio terminal positivo
  is_lost boolean default false,       -- estágio terminal negativo
  color text,
  created_at timestamptz default now()
);

-- Deals (oportunidades / cards do kanban)
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
  source text,                         -- 'whatsapp_inbound', 'web_form', 'manual', etc.
  source_conversation_id uuid references public.conversations(id),
  
  status text default 'open' check (status in ('open', 'won', 'lost')),
  closed_at timestamptz,
  
  custom_fields jsonb default '{}'::jsonb,
  tags text[] default '{}',
  
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index on public.crm_deals (organization_id, stage_id);
create index on public.crm_deals (contact_id);
create index on public.crm_deals (owner_user_id);

-- Notas e atividades (timeline)
create table if not exists public.crm_activities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  contact_id uuid references public.contacts(id),
  deal_id uuid references public.crm_deals(id),
  
  type text not null,                  -- 'note', 'call', 'meeting', 'whatsapp', 'task'
  title text,
  body text,
  
  performed_by_user_id uuid,
  performed_at timestamptz default now(),
  
  created_at timestamptz default now()
);

create index on public.crm_activities (contact_id, performed_at desc);
create index on public.crm_activities (deal_id, performed_at desc);
```

Nichos comuns só renomeiam:
| Nicho | Contact é... | Deal é... |
|-------|-------------|-----------|
| Clínica | Paciente | Consulta/Tratamento |
| Imobiliária | Lead | Imóvel/Contrato |
| Advocacia | Cliente | Caso |
| Autoescola | Aluno | Pacote/Matrícula |
| Infoproduto | Lead | Compra |
| E-commerce | Cliente | Pedido |
| Agência | Prospect | Projeto |

---

## 3. Estratégia de binding na entrada (mensagem chega)

Toda vez que uma mensagem inbound entra ([05-receber-mensagens.md](05-receber-mensagens.md)), você executa:

```
1. UPSERT contact (já feito no handler)
2. UPSERT conversation (já feito)
3. INSERT message (já feito)
4. ━━━━━ NOVO: BINDING CRM ━━━━━
   Se contact.created_at == agora (acabou de nascer):
     → Cria deal padrão no estágio "Lead novo" do pipeline default
     → Vincula conversation.primary_deal_id
   Senão se contact não tem deal aberto:
     → Cria deal nesse mesmo estágio (lead voltou a interagir)
   Senão (contact tem deal aberto):
     → Apenas log da mensagem como activity vinculada ao deal
```

📦 **`lib/waha/crm-binding.ts`**:

```typescript
import type { SupabaseClient } from '@supabase/supabase-js';

export async function bindMessageToCrm(args: {
  supabase: SupabaseClient;
  organizationId: string;
  contactId: string;
  conversationId: string;
  isInbound: boolean;
  messageBody: string | null;
}) {
  const { supabase, organizationId, contactId, conversationId, isInbound, messageBody } = args;
  if (!isInbound) return;  // só inbound aciona binding novo

  // 1. Pega pipeline default da org
  const { data: pipeline } = await supabase
    .from('crm_pipelines')
    .select('id, crm_stages!inner(id, position)')
    .eq('organization_id', organizationId)
    .eq('is_default', true)
    .single();
  if (!pipeline) return;

  const firstStage = (pipeline as any).crm_stages.sort((a: any, b: any) => a.position - b.position)[0];
  if (!firstStage) return;

  // 2. Verifica se o contact já tem deal aberto
  const { data: openDeals } = await supabase
    .from('crm_deals')
    .select('id')
    .eq('contact_id', contactId)
    .eq('status', 'open')
    .limit(1);

  if (openDeals && openDeals.length > 0) {
    // Deal já existe → vincula só conversation se ainda não tem
    await supabase
      .from('conversations')
      .update({ primary_deal_id: openDeals[0].id })
      .eq('id', conversationId)
      .is('primary_deal_id', null);

    // Loga activity
    await supabase.from('crm_activities').insert({
      organization_id: organizationId,
      contact_id: contactId,
      deal_id: openDeals[0].id,
      type: 'whatsapp',
      title: 'Mensagem recebida',
      body: messageBody?.slice(0, 200) ?? null,
    });
    return;
  }

  // 3. Cria deal novo
  const { data: contact } = await supabase
    .from('contacts')
    .select('full_name, push_name, phone_number')
    .eq('id', contactId)
    .single();

  const dealTitle = `Novo contato: ${contact?.full_name ?? contact?.push_name ?? contact?.phone_number}`;

  const { data: newDeal } = await supabase
    .from('crm_deals')
    .insert({
      organization_id: organizationId,
      pipeline_id: pipeline.id,
      stage_id: firstStage.id,
      contact_id: contactId,
      title: dealTitle,
      source: 'whatsapp_inbound',
      source_conversation_id: conversationId,
    })
    .select('id')
    .single();

  if (newDeal) {
    await supabase
      .from('conversations')
      .update({ primary_deal_id: newDeal.id })
      .eq('id', conversationId);

    await supabase.from('crm_activities').insert({
      organization_id: organizationId,
      contact_id: contactId,
      deal_id: newDeal.id,
      type: 'whatsapp',
      title: 'Primeira mensagem',
      body: messageBody?.slice(0, 200) ?? null,
    });
  }
}
```

Chame essa função no `handleIncomingMessage` (doc 05) depois do INSERT da mensagem.

---

## 4. Atribuição automática de operador (round-robin)

Quando uma conversa nova entra sem assignee, a IA ou o sistema decide quem cuida.

📦 **`lib/crm/assignment.ts`**:

```typescript
import type { SupabaseClient } from '@supabase/supabase-js';

export async function autoAssignConversation(args: {
  supabase: SupabaseClient;
  organizationId: string;
  conversationId: string;
  strategy?: 'round_robin' | 'least_busy' | 'manual';
}) {
  const { supabase, organizationId, conversationId, strategy = 'round_robin' } = args;

  // Lista usuários disponíveis (online + role atendente)
  const { data: users } = await supabase
    .from('user_organizations')
    .select('user_id, users:auth.users(email)')
    .eq('organization_id', organizationId)
    .in('role', ['admin', 'attendant', 'sales']);

  if (!users || users.length === 0) return;

  let chosenUserId: string;
  if (strategy === 'least_busy') {
    // Pega quem tem menos conversation 'open' atribuídas
    const counts: Record<string, number> = {};
    for (const u of users) counts[u.user_id] = 0;

    const { data: assignedConvs } = await supabase
      .from('conversations')
      .select('assigned_user_id')
      .eq('organization_id', organizationId)
      .eq('status', 'open');
    for (const c of assignedConvs ?? []) {
      if (c.assigned_user_id && counts[c.assigned_user_id] !== undefined) {
        counts[c.assigned_user_id]++;
      }
    }
    chosenUserId = Object.entries(counts).sort((a, b) => a[1] - b[1])[0][0];
  } else {
    // round-robin simples baseado em hash do conversationId
    const hash = simpleHash(conversationId);
    chosenUserId = users[hash % users.length].user_id;
  }

  await supabase
    .from('conversations')
    .update({ assigned_user_id: chosenUserId })
    .eq('id', conversationId);
}

function simpleHash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h) + str.charCodeAt(i);
  return Math.abs(h);
}
```

---

## 5. Hook frontend para usar no SidePanel

📦 **`hooks/useConversation.ts`**:

```typescript
'use client';
import { useEffect, useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { useRealtimeChannel } from './useRealtimeChannel';

export function useConversation(conversationId: string) {
  const [conversation, setConversation] = useState<any>(null);
  const [contact, setContact] = useState<any>(null);

  const fetch = async () => {
    const supa = getSupabaseBrowserClient();
    const { data } = await supa
      .from('conversations')
      .select(`
        id, organization_id, status, assigned_user_id, primary_deal_id, last_message_at,
        contact:contacts ( id, full_name, push_name, phone_number, email, profile_picture_url, tags, notes )
      `)
      .eq('id', conversationId)
      .single();
    setConversation(data);
    setContact((data as any)?.contact);
  };

  useEffect(() => { fetch(); }, [conversationId]);

  useRealtimeChannel({
    channelName: `conv_detail_${conversationId}`,
    table: 'conversations',
    event: 'UPDATE',
    filter: `id=eq.${conversationId}`,
    onChange: () => fetch(),
  });

  const resolveConversation = async () => {
    const supa = getSupabaseBrowserClient();
    await supa.from('conversations').update({ status: 'resolved' }).eq('id', conversationId);
  };

  const assignToMe = async () => {
    const supa = getSupabaseBrowserClient();
    const { data: { user } } = await supa.auth.getUser();
    if (!user) return;
    await supa.from('conversations').update({ assigned_user_id: user.id }).eq('id', conversationId);
  };

  return { conversation, contact, resolveConversation, assignToMe, refresh: fetch };
}
```

---

## 6. Componente: `DealSection` no SidePanel

📦 **`components/chat/sidepanel/DealSection.tsx`**:

```typescript
'use client';
import { useEffect, useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { Button } from '@/components/ui/button';
import { ChevronDown } from 'lucide-react';

interface Deal {
  id: string;
  title: string;
  value_cents: number;
  stage_id: string;
  stage_name: string;
  status: string;
}

export function DealSection({
  conversationId,
  contactId,
  primaryDealId,
}: {
  conversationId: string;
  contactId: string;
  primaryDealId: string | null;
}) {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [stages, setStages] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    const load = async () => {
      const supa = getSupabaseBrowserClient();
      const { data: dealsData } = await supa
        .from('crm_deals')
        .select('id, title, value_cents, status, stage:crm_stages(id, name)')
        .eq('contact_id', contactId)
        .order('created_at', { ascending: false });

      setDeals(
        (dealsData ?? []).map((d: any) => ({
          id: d.id,
          title: d.title,
          value_cents: d.value_cents,
          stage_id: d.stage.id,
          stage_name: d.stage.name,
          status: d.status,
        })),
      );

      const { data: stagesData } = await supa
        .from('crm_stages')
        .select('id, name, position')
        .order('position');
      setStages(stagesData ?? []);
    };
    load();
  }, [contactId]);

  const moveStage = async (dealId: string, newStageId: string) => {
    const supa = getSupabaseBrowserClient();
    await supa.from('crm_deals').update({ stage_id: newStageId }).eq('id', dealId);
  };

  return (
    <section className="border-b border-border p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-sm">Negócios ({deals.length})</h3>
        <Button variant="link" size="sm">Novo</Button>
      </div>
      {deals.length === 0 && (
        <p className="text-xs text-muted-foreground">Nenhum negócio vinculado.</p>
      )}
      <div className="space-y-2">
        {deals.map((d) => (
          <div key={d.id} className="border rounded-md p-3 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium truncate">{d.title}</span>
              {d.id === primaryDealId && <span className="text-[10px] px-1.5 py-0.5 bg-primary/10 text-primary rounded">Principal</span>}
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

---

## 7. Roteamento por palavras-chave (segmentação automática)

Padrão útil pra triagem inicial. Ex: clínica recebe mensagens, palavras "consulta" → comercial; "exame" → recepção; "boleto" → financeiro.

📦 **`lib/crm/routing-rules.ts`**:

```typescript
export interface RoutingRule {
  match: (text: string) => boolean;
  pipelineId?: string;
  stageId?: string;
  assignToTeam?: string;
  tags?: string[];
}

export function applyRoutingRules(text: string, rules: RoutingRule[]) {
  const matched = rules.find((r) => r.match(text));
  return matched ?? null;
}

// Exemplos
export const defaultClinicaRules: RoutingRule[] = [
  {
    match: (t) => /consulta|agendar|marcar/i.test(t),
    tags: ['agendamento'],
  },
  {
    match: (t) => /boleto|pagamento|cobranca|cobrança/i.test(t),
    assignToTeam: 'financeiro',
    tags: ['financeiro'],
  },
  {
    match: (t) => /exame|resultado|laudo/i.test(t),
    assignToTeam: 'recepcao',
    tags: ['exames'],
  },
];
```

Use no handler: depois de criar a conversation/deal, aplica regras e atualiza tags / assignee.

---

## 8. IA agent integrado (ponto de inserção)

Cada nicho geralmente quer uma IA respondendo as mensagens triviais. Hook único:

```typescript
// Em handleIncomingMessage, depois do INSERT da message:
if (orgHasAiAgentEnabled) {
  await triggerAiAgent({
    organizationId,
    conversationId: conv.id,
    contactId: contact.id,
    incomingMessage: { type, body },
    sessionName: event.session,
  });
}
```

📦 **`lib/ai/agent-runner.ts`** (esqueleto):

```typescript
import { dispatchSend } from '@/lib/waha/dispatcher';

export async function triggerAiAgent(args: {
  organizationId: string;
  conversationId: string;
  contactId: string;
  incomingMessage: { type: string; body: string | null };
  sessionName: string;
}) {
  // 1. Carrega histórico (últimas 20 mensagens)
  // 2. Carrega prompt do agent da org (em uma tabela `ai_agents`)
  // 3. Carrega contexto CRM (deal, contact, etc.)
  // 4. Chama LLM (Anthropic, OpenAI, etc.)
  // 5. Se deve responder: chama dispatchSend com a resposta gerada
  // 6. Se deve escalar: marca conversation.status='pending', notifica humanos
  
  // Implementação detalhada foge do escopo desta aula — ver projeto separado
}
```

---

## 9. Webhooks de saída (notificar sistemas externos)

Toda vez que algo importante acontece no CRM (deal mudou de stage, contact criado, etc.), você quer poder notificar webhooks externos do cliente.

📦 **Schema:**

```sql
create table if not exists public.webhook_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  url text not null,
  events text[] not null,             -- ['contact.created', 'deal.stage_changed', 'message.received']
  secret text not null,
  is_active boolean default true,
  created_at timestamptz default now()
);
```

Trigger a cada evento dispara HTTP POST async para os subscribers.

---

## 10. Pipeline kanban com drag & drop

📦 **`components/crm/PipelineBoard.tsx`** (overview):

```typescript
'use client';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';
// ... usa hook useStages() e useDeals() filtrando por pipeline e org
// Ao soltar um deal em outra coluna: PATCH /api/crm/deals/{id} com novo stage_id
```

Implementação completa típica = ~150 linhas. Não é específico de WhatsApp, então não detalhamos aqui.

---

## 11. Exportação e relatórios

Métricas mínimas que você precisa expor:

| Métrica | Fonte | Granularidade |
|---------|-------|---------------|
| Conversas inbound por dia | conversations.last_inbound_at | dia/semana/mês |
| Tempo de primeira resposta | (primeira message from_me=true) - (primeira inbound) | médio, mediano, p95 |
| Conversas resolvidas | conversations.status='resolved' | dia |
| Taxa de conversão whatsapp → deal won | crm_deals onde source='whatsapp_inbound' AND status='won' | mês |
| Mensagens enviadas/recebidas | messages.from_me | dia |
| Atendentes mais ativos | conversations.assigned_user_id | mês |

Implementação: views materializadas no Postgres + endpoint `/api/crm/reports/*`.

---

## 12. Casos especiais por nicho (exemplos)

### Clínica (saúde)
- Binding extra: agendamento criado quando paciente confirma horário no chat → integrar com calendar
- Tags automáticas: "primeira consulta", "retorno", "particular", "convênio"
- Compliance: armazenar mensagens criptografadas, retenção limitada (LGPD)

### Imobiliária
- Custom field no deal: "tipo de imóvel", "faixa de preço", "região"
- Roteamento por região: cada corretor cuida de uma zona
- Match de propriedades: ao receber "quero apartamento até 500k em Pinheiros" → IA sugere imóveis do banco

### Advocacia
- Confidencialidade extrema: RLS por advogado responsável (não por toda equipe)
- Activity types extras: "audiência", "petição", "prazo"
- Lembretes automáticos: webhook agenda em prazos processuais

### Infoprodutos / Lançamento
- Eventos de funil: "clicou no link", "viu webinar", "abandonou checkout"
- Integração com plataforma (Hotmart, Kiwify, Eduzz): webhook deles → cria activity + atualiza deal stage
- Disparos massivos pós-evento: cuidado anti-ban (ver doc 06)

---

## Próximo: [10-edge-cases.md](10-edge-cases.md)
