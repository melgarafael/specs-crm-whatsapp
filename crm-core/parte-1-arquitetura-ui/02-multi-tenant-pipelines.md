# 02 — Multi-tenant e múltiplos pipelines por organização

> **Resumo:** como modelar organizações, papéis, múltiplos funis simultâneos e vocabulário customizável por pipeline. RLS completa, UI de tabs, 5 exemplos de configuração (vendas, suporte, recrutamento, onboarding, success) e endpoint pra criar/editar pipeline.

---

## 1. O que é multi-tenant aqui

Toda tabela de conteúdo do CRM carrega `organization_id`. Cada organização é um inquilino isolado: dados, usuários, pipelines, vocabulário, integrações — tudo separado por essa coluna + RLS.

```
┌───────────────────────┐
│    organizations      │   ← tabela já existente (vide reference da aula)
│    id, name, slug     │
└───────────┬───────────┘
            │ 1
            │
            │ N
            ▼
┌───────────────────────┐
│  user_organizations   │   ← junção users <-> orgs com role
│  user_id, org_id,     │
│  role                 │
└───────────────────────┘
```

⭐ **Relacionamentos potenciais — `organizations`**

| Coluna | Conecta com | Padrão |
|--------|------------|--------|
| `id` | TODAS as tabelas tenant-aware (`crm_pipelines.organization_id`, `crm_leads.organization_id`, `contacts.organization_id`, `conversations.organization_id`, `messages.organization_id`, etc.) | FK rígida com `ON DELETE CASCADE` |
| `slug` | Subdomínios, paths de URL, nomes de session WAHA (`waha_session_name = 'org-{slug}-1'`) | Denormalizado por uso em URL |

⭐ **Relacionamentos potenciais — `user_organizations`**

| Coluna | Conecta com | Padrão |
|--------|------------|--------|
| `user_id` | `auth.users.id` (Supabase Auth) | FK rígida |
| `organization_id` | `organizations.id` | FK rígida |
| `role` | Lógica de permissão em RLS, em UI (mostrar/esconder), em assignment automático | Enum string (`admin`, `manager`, `agent`, `viewer`) |

---

## 2. Papéis e seu efeito no CRM

```sql
-- user_organizations.role: enum-like text
-- valores sugeridos:
--   'owner'    → tudo (dono da org)
--   'admin'    → tudo exceto deletar a org
--   'manager'  → ver/editar todos os pipelines, gerir time
--   'agent'    → ver/editar leads atribuídos a si
--   'viewer'   → só leitura
```

Dois eixos de permissão importam no CRM:

1. **Pipeline-level:** quem pode ver/editar **um pipeline** específico (vendas vs RH).
2. **Lead-level:** quem pode ver/editar **um lead** específico (atendente só vê seus leads vs. manager vê todos).

⚠️ **Gotcha:** começar simples. `role` por org cobre 90% dos casos. Granularidade fina (permissão por pipeline) vai num jsonb `pipeline_permissions` no `user_organizations`, **só quando a feature for pedida**. Não over-engineer no começo.

---

## 3. Múltiplos pipelines: a tabela `crm_pipelines`

```sql
create table if not exists public.crm_pipelines (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- Identidade
  name            text not null,
  slug            text not null,                       -- 'sales', 'support', 'hiring', etc.
  is_default      boolean not null default false,
  position        int not null default 0,
  color           text,
  icon            text,                                -- nome de lucide-icon

  -- Vocabulário e comportamento
  vocabulary      jsonb not null default '{}'::jsonb,  -- { lead: 'Paciente', lead_plural: 'Pacientes', deal: 'Consulta', ... }
  settings        jsonb not null default '{}'::jsonb,  -- { fields: [...], rules: [...], wip_global: 50, ... }

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  unique (organization_id, slug)
);

create index if not exists idx_crm_pipelines_org
  on public.crm_pipelines (organization_id);
create index if not exists idx_crm_pipelines_org_default
  on public.crm_pipelines (organization_id) where is_default;
```

⭐ **Relacionamentos potenciais — `crm_pipelines`**

| Coluna | Conecta com | Padrão |
|--------|------------|--------|
| `id` | `crm_stages.pipeline_id`, `crm_leads.pipeline_id` | FK rígida com `ON DELETE CASCADE` |
| `organization_id` | `organizations.id` | FK rígida; usada por RLS |
| `slug` | URL routes (`/crm/{slug}/board`), MCP tool args, webhooks externos | Por convenção, único por org |
| `vocabulary` (jsonb) | UI labels em todo lugar (header do kanban, tooltips, filtros) | Lido por componentes via context |
| `settings.fields` | UI de form dinâmico de leads, validação Zod, filtros | Lido pelo `LeadForm` e pelo `LeadFilter` |
| `settings.rules` | Engine de automação (notificações, atribuição, follow-up) | Consumido por workers/edge functions |

---

## 4. Por que múltiplos pipelines

A maioria dos sistemas começa com 1 pipeline ("vendas"). Mas quase todo cliente acaba precisando de mais:

| Pipeline | Lead típico | Stages | Vocabulário |
|----------|------------|--------|-------------|
| **Vendas (sales)** | Prospect comercial | Novo, Qualificando, Proposta, Negociação, Fechado | Lead, Deal, Won, Lost |
| **Suporte (support)** | Ticket de cliente | Aberto, Em análise, Aguardando cliente, Resolvido | Ticket, Resolvido, Reaberto |
| **Recrutamento (hiring)** | Candidato a vaga | Triagem, Entrevista 1, Entrevista 2, Oferta, Contratado | Candidato, Vaga, Contratado |
| **Onboarding** | Cliente recém-fechado | Boas-vindas, Setup, Treinamento, Live | Conta, Etapa, Concluído |
| **Customer Success** | Conta ativa pra renovar | Saudável, Em risco, Em recuperação, Renovado/Churned | Conta, Health Score, Renovado |

Cada um tem stages diferentes, vocabulário diferente, e geralmente time diferente.

---

## 5. UI: tabs de pipelines no topo do board

📦 **`components/crm/PipelineTabs.tsx`**:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { cn } from '@/lib/utils';
import * as LucideIcons from 'lucide-react';
import { Plus } from 'lucide-react';

interface Pipeline {
  id: string;
  name: string;
  slug: string;
  is_default: boolean;
  position: number;
  color: string | null;
  icon: string | null;
}

export function PipelineTabs({
  organizationId,
  activeSlug,
}: {
  organizationId: string;
  activeSlug: string;
}) {
  const router = useRouter();
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);

  useEffect(() => {
    const load = async () => {
      const supa = getSupabaseBrowserClient();
      const { data } = await supa
        .from('crm_pipelines')
        .select('id, name, slug, is_default, position, color, icon')
        .eq('organization_id', organizationId)
        .order('position');
      setPipelines(data ?? []);
    };
    load();
  }, [organizationId]);

  const renderIcon = (iconName: string | null) => {
    if (!iconName) return null;
    const Icon = (LucideIcons as any)[iconName];
    return Icon ? <Icon className="h-4 w-4" /> : null;
  };

  return (
    <div className="flex items-center gap-1 border-b border-border px-4">
      {pipelines.map((p) => (
        <button
          key={p.id}
          onClick={() => router.push(`/crm/${p.slug}/board`)}
          className={cn(
            'flex items-center gap-2 px-3 py-2 text-sm border-b-2 -mb-px transition-colors',
            activeSlug === p.slug
              ? 'border-primary text-foreground font-medium'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
          style={
            activeSlug === p.slug && p.color
              ? { borderColor: p.color }
              : undefined
          }
        >
          {renderIcon(p.icon)}
          <span>{p.name}</span>
        </button>
      ))}
      <button
        onClick={() => router.push(`/crm/new`)}
        className="ml-2 flex items-center gap-1 px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <Plus className="h-4 w-4" /> Novo
      </button>
    </div>
  );
}
```

---

## 6. Vocabulário customizável por pipeline

A coluna `vocabulary jsonb` tem um schema sugerido:

```json
{
  "lead": "Paciente",
  "lead_plural": "Pacientes",
  "lead_short": "Pac",
  "deal": "Consulta",
  "deal_plural": "Consultas",
  "won_label": "Realizada",
  "lost_label": "Cancelada",
  "value_label": "Valor",
  "pipeline_label": "Funil de Atendimento",
  "stage_label": "Etapa",
  "owner_label": "Médico responsável",
  "source_label": "Origem",
  "title_field": "Motivo da consulta"
}
```

📦 **`hooks/usePipelineVocabulary.ts`**:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';

interface Vocabulary {
  lead: string;
  lead_plural: string;
  deal: string;
  deal_plural: string;
  won_label: string;
  lost_label: string;
  owner_label: string;
  value_label: string;
  title_field: string;
  [key: string]: string;
}

const DEFAULT_VOCAB: Vocabulary = {
  lead: 'Lead',
  lead_plural: 'Leads',
  deal: 'Negócio',
  deal_plural: 'Negócios',
  won_label: 'Ganho',
  lost_label: 'Perdido',
  owner_label: 'Responsável',
  value_label: 'Valor',
  title_field: 'Título',
};

export function usePipelineVocabulary(pipelineId: string | null) {
  const [vocab, setVocab] = useState<Vocabulary>(DEFAULT_VOCAB);

  useEffect(() => {
    if (!pipelineId) {
      setVocab(DEFAULT_VOCAB);
      return;
    }
    const load = async () => {
      const supa = getSupabaseBrowserClient();
      const { data } = await supa
        .from('crm_pipelines')
        .select('vocabulary')
        .eq('id', pipelineId)
        .single();
      const merged = { ...DEFAULT_VOCAB, ...((data?.vocabulary as Vocabulary) ?? {}) };
      setVocab(merged);
    };
    load();
  }, [pipelineId]);

  return vocab;
}
```

⚠️ **Gotcha:** vocabulary deve **sempre** mergear com defaults. Pipeline pode estar com vocab parcial (só sobrescreveu `lead`) — o resto deve cair pro padrão.

---

## 7. Cinco exemplos completos de configuração de pipeline

### 7.1 Pipeline "Vendas" (genérico B2B/B2C)

```sql
insert into public.crm_pipelines (organization_id, name, slug, is_default, position, color, icon, vocabulary, settings)
values (
  '{org-id}',
  'Vendas',
  'sales',
  true,
  0,
  '#3b82f6',
  'TrendingUp',
  '{
    "lead": "Lead", "lead_plural": "Leads",
    "deal": "Oportunidade", "deal_plural": "Oportunidades",
    "owner_label": "Vendedor",
    "won_label": "Fechado", "lost_label": "Perdido",
    "value_label": "Ticket"
  }'::jsonb,
  '{
    "fields": [
      {"key": "company", "label": "Empresa", "type": "text"},
      {"key": "industry", "label": "Setor", "type": "select", "options": ["SaaS", "Varejo", "Saúde", "Outro"]},
      {"key": "decision_maker", "label": "Decisor identificado?", "type": "boolean"}
    ],
    "wip_global": null
  }'::jsonb
);

-- Stages
insert into public.crm_stages (pipeline_id, name, position, color)
select id, x.name, x.pos, x.color from public.crm_pipelines, lateral (values
  ('Novo', 0, '#94a3b8'),
  ('Qualificando', 1, '#60a5fa'),
  ('Proposta', 2, '#a78bfa'),
  ('Negociação', 3, '#f59e0b')
) x(name, pos, color)
where slug='sales';

insert into public.crm_stages (pipeline_id, name, position, color, is_won)
select id, 'Fechado', 4, '#10b981', true from public.crm_pipelines where slug='sales';

insert into public.crm_stages (pipeline_id, name, position, color, is_lost)
select id, 'Perdido', 5, '#ef4444', true from public.crm_pipelines where slug='sales';
```

### 7.2 Pipeline "Suporte"

```sql
insert into public.crm_pipelines (...)
values (...,
  'Suporte', 'support', false, 1, '#ef4444', 'LifeBuoy',
  '{"lead": "Ticket", "lead_plural": "Tickets", "deal": "Chamado", "owner_label": "Atendente", "won_label": "Resolvido", "lost_label": "Encerrado sem resolução"}'::jsonb,
  '{
    "fields": [
      {"key": "severity", "label": "Severidade", "type": "select", "options": ["Baixa", "Média", "Alta", "Crítica"]},
      {"key": "first_response_sla_minutes", "label": "SLA primeira resposta (min)", "type": "number"},
      {"key": "category", "label": "Categoria", "type": "select", "options": ["Bug", "Dúvida", "Pedido de feature", "Cobrança"]}
    ]
  }'::jsonb
);

-- Stages: Novo, Em análise, Aguardando cliente, Em resolução, Resolvido (won), Encerrado (lost)
```

### 7.3 Pipeline "Recrutamento"

```sql
insert into public.crm_pipelines (...)
values (...,
  'Recrutamento', 'hiring', false, 2, '#a855f7', 'Users',
  '{"lead": "Candidato", "lead_plural": "Candidatos", "deal": "Vaga", "owner_label": "Recrutador", "won_label": "Contratado", "lost_label": "Reprovado"}'::jsonb,
  '{
    "fields": [
      {"key": "position", "label": "Cargo", "type": "text"},
      {"key": "expected_salary", "label": "Pretensão salarial", "type": "currency"},
      {"key": "linkedin_url", "label": "LinkedIn", "type": "url"},
      {"key": "english_level", "label": "Nível de inglês", "type": "select", "options": ["Básico", "Intermediário", "Avançado", "Fluente"]}
    ]
  }'::jsonb
);

-- Stages: Triagem, Teste técnico, Entrevista RH, Entrevista técnica, Oferta, Contratado, Reprovado
```

### 7.4 Pipeline "Onboarding"

```sql
insert into public.crm_pipelines (...)
values (...,
  'Onboarding', 'onboarding', false, 3, '#14b8a6', 'Rocket',
  '{"lead": "Conta", "lead_plural": "Contas", "deal": "Implantação", "owner_label": "CSM", "won_label": "Implantada", "lost_label": "Churn antes de live"}'::jsonb,
  '{
    "fields": [
      {"key": "plan", "label": "Plano contratado", "type": "select", "options": ["Starter", "Pro", "Enterprise"]},
      {"key": "kickoff_date", "label": "Data de kickoff", "type": "date"},
      {"key": "training_completed", "label": "Treinamento finalizado?", "type": "boolean"}
    ],
    "wip_global": 30
  }'::jsonb
);

-- Stages: Boas-vindas, Setup técnico, Migração de dados, Treinamento, Go-live, Ativa, Churn
```

### 7.5 Pipeline "Customer Success"

```sql
insert into public.crm_pipelines (...)
values (...,
  'Customer Success', 'success', false, 4, '#22c55e', 'Heart',
  '{"lead": "Conta", "lead_plural": "Contas", "deal": "Renovação", "owner_label": "CSM", "won_label": "Renovada", "lost_label": "Churn"}'::jsonb,
  '{
    "fields": [
      {"key": "health_score", "label": "Health Score", "type": "number", "min": 0, "max": 100},
      {"key": "mrr_cents", "label": "MRR (centavos)", "type": "currency"},
      {"key": "renewal_date", "label": "Data de renovação", "type": "date"},
      {"key": "main_users", "label": "Usuários ativos", "type": "number"}
    ]
  }'::jsonb
);

-- Stages: Saudável, Em monitoramento, Em risco, Em recuperação, Renovada, Churn
```

---

## 8. RLS completa pra pipelines, stages e leads

⚠️ Sem RLS, qualquer usuário autenticado vê leads de qualquer org. Não pular.

```sql
-- Helper (uma vez por DB)
create or replace function public.fn_user_org_ids()
returns table(organization_id uuid) language sql stable security definer as $$
  select organization_id
  from public.user_organizations
  where user_id = auth.uid()
$$;

-- crm_pipelines
alter table public.crm_pipelines enable row level security;

create policy "pipelines_select_org_members"
  on public.crm_pipelines for select
  using (organization_id in (select organization_id from public.fn_user_org_ids()));

create policy "pipelines_insert_org_members"
  on public.crm_pipelines for insert
  with check (organization_id in (select organization_id from public.fn_user_org_ids()));

create policy "pipelines_update_admin_or_manager"
  on public.crm_pipelines for update
  using (
    organization_id in (
      select uo.organization_id
      from public.user_organizations uo
      where uo.user_id = auth.uid()
        and uo.role in ('owner', 'admin', 'manager')
    )
  );

create policy "pipelines_delete_admin"
  on public.crm_pipelines for delete
  using (
    organization_id in (
      select uo.organization_id
      from public.user_organizations uo
      where uo.user_id = auth.uid()
        and uo.role in ('owner', 'admin')
    )
  );

-- crm_stages (segue org via JOIN com pipeline)
alter table public.crm_stages enable row level security;

create policy "stages_select_org_members"
  on public.crm_stages for select
  using (
    pipeline_id in (
      select id from public.crm_pipelines
      where organization_id in (select organization_id from public.fn_user_org_ids())
    )
  );

create policy "stages_write_admin_manager"
  on public.crm_stages for all
  using (
    pipeline_id in (
      select p.id from public.crm_pipelines p
      join public.user_organizations uo on uo.organization_id = p.organization_id
      where uo.user_id = auth.uid()
        and uo.role in ('owner', 'admin', 'manager')
    )
  );

-- crm_leads (todos os agentes da org veem)
alter table public.crm_leads enable row level security;

create policy "leads_select_org_members"
  on public.crm_leads for select
  using (organization_id in (select organization_id from public.fn_user_org_ids()));

create policy "leads_insert_org_members"
  on public.crm_leads for insert
  with check (organization_id in (select organization_id from public.fn_user_org_ids()));

create policy "leads_update_org_members"
  on public.crm_leads for update
  using (organization_id in (select organization_id from public.fn_user_org_ids()));

-- Opcional, mais restritivo: agent só edita os próprios
-- create policy "leads_update_own_or_manager" on public.crm_leads for update
-- using (
--   organization_id in (select organization_id from public.fn_user_org_ids())
--   and (
--     owner_user_id = auth.uid()
--     or exists (
--       select 1 from public.user_organizations
--       where user_id = auth.uid()
--         and organization_id = crm_leads.organization_id
--         and role in ('owner', 'admin', 'manager')
--     )
--   )
-- );
```

⭐ **Relacionamentos potenciais — RLS policies**

| Policy | Lê de | Bloqueia |
|--------|------|----------|
| `pipelines_select_org_members` | `user_organizations` | Cross-tenant read |
| `pipelines_update_admin_or_manager` | `user_organizations.role` | Agente trocar config de pipeline |
| `leads_update_own_or_manager` (opcional) | `crm_leads.owner_user_id`, `user_organizations.role` | Agente editar lead de outro |

---

## 9. API: criar e editar pipelines

📦 **`app/api/crm/pipelines/route.ts`**:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseServerClient } from '@/lib/supabase/server';

const PipelineSchema = z.object({
  name: z.string().min(1).max(80),
  slug: z.string().min(2).max(40).regex(/^[a-z0-9-]+$/),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  icon: z.string().max(40).optional(),
  is_default: z.boolean().optional(),
  vocabulary: z.record(z.string()).optional(),
  settings: z.record(z.any()).optional(),
});

const StagesSchema = z.array(z.object({
  name: z.string().min(1).max(60),
  position: z.number().int().nonnegative(),
  color: z.string().optional(),
  is_won: z.boolean().optional(),
  is_lost: z.boolean().optional(),
  win_probability: z.number().min(0).max(1).optional(),
  wip_limit: z.number().int().nonnegative().nullable().optional(),
})).min(1);

const CreatePipelineSchema = z.object({
  pipeline: PipelineSchema,
  stages: StagesSchema,
});

export async function POST(req: NextRequest) {
  const supa = getSupabaseServerClient();
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json();
  const parsed = CreatePipelineSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_payload', issues: parsed.error.issues }, { status: 400 });
  }

  const { pipeline, stages } = parsed.data;

  // org id vem da relação atual do user (assumindo 1 org por sessão; senão receba do header)
  const { data: orgRow } = await supa
    .from('user_organizations')
    .select('organization_id, role')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .single();
  if (!orgRow) return NextResponse.json({ error: 'no_org' }, { status: 403 });
  if (!['owner', 'admin', 'manager'].includes(orgRow.role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // Insere pipeline
  const { data: created, error: pErr } = await supa
    .from('crm_pipelines')
    .insert({
      organization_id: orgRow.organization_id,
      ...pipeline,
    })
    .select('id')
    .single();
  if (pErr) return NextResponse.json({ error: pErr.message }, { status: 400 });

  // Insere stages
  const stageRows = stages.map((s) => ({ pipeline_id: created.id, ...s }));
  const { error: sErr } = await supa.from('crm_stages').insert(stageRows);
  if (sErr) {
    // rollback manual
    await supa.from('crm_pipelines').delete().eq('id', created.id);
    return NextResponse.json({ error: sErr.message }, { status: 400 });
  }

  return NextResponse.json({ id: created.id }, { status: 201 });
}

export async function GET() {
  const supa = getSupabaseServerClient();
  const { data, error } = await supa
    .from('crm_pipelines')
    .select('id, name, slug, is_default, position, color, icon, vocabulary, settings, created_at')
    .order('position');
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ pipelines: data });
}
```

📦 **`app/api/crm/pipelines/[id]/route.ts`** (atualizar/deletar):

```ts
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseServerClient } from '@/lib/supabase/server';

const UpdateSchema = z.object({
  name: z.string().optional(),
  color: z.string().optional(),
  icon: z.string().optional(),
  is_default: z.boolean().optional(),
  vocabulary: z.record(z.string()).optional(),
  settings: z.record(z.any()).optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const supa = getSupabaseServerClient();
  const body = await req.json();
  const parsed = UpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_payload', issues: parsed.error.issues }, { status: 400 });
  }

  const { data, error } = await supa
    .from('crm_pipelines')
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq('id', params.id)
    .select('id')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ id: data.id });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const supa = getSupabaseServerClient();

  // Garante que não é o default
  const { data: p } = await supa
    .from('crm_pipelines')
    .select('is_default')
    .eq('id', params.id)
    .single();
  if (p?.is_default) {
    return NextResponse.json({ error: 'cannot_delete_default' }, { status: 400 });
  }

  const { error } = await supa.from('crm_pipelines').delete().eq('id', params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
```

⚠️ **Gotcha:** deletar pipeline cascateia stages e leads. Exigir confirmação dupla na UI ("digite o nome do pipeline pra confirmar"). Logar quem deletou. Considerar **soft delete** (`deleted_at timestamptz`) em produção.

---

## 10. Trigger: garantir que sempre tem 1 default por org

```sql
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

create trigger trg_pipelines_single_default
  after insert or update of is_default on public.crm_pipelines
  for each row when (new.is_default = true)
  execute function public.fn_ensure_single_default_pipeline();
```

E pra garantir que existe **pelo menos um** default ao criar a primeira:

```sql
-- Antes de inserir o primeiro pipeline, marca como default
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

create trigger trg_first_pipeline_default
  before insert on public.crm_pipelines
  for each row execute function public.fn_first_pipeline_is_default();
```

---

## 11. Permissões por pipeline (avançado)

Quando o cliente pede "vendedor não pode ver pipeline de RH", você adiciona uma tabela:

```sql
create table if not exists public.crm_pipeline_permissions (
  pipeline_id uuid not null references public.crm_pipelines(id) on delete cascade,
  user_id     uuid not null,
  permission  text not null check (permission in ('view', 'edit', 'admin')),
  created_at  timestamptz default now(),
  primary key (pipeline_id, user_id)
);

create index on public.crm_pipeline_permissions (user_id);
```

⭐ **Relacionamentos potenciais — `crm_pipeline_permissions`**

| Coluna | Conecta com | Padrão |
|--------|------------|--------|
| `pipeline_id` | `crm_pipelines.id` | FK rígida com `CASCADE` |
| `user_id` | `auth.users.id` (e `user_organizations.user_id`) | FK soft (validação na app) |
| `permission` | RLS policies em `crm_pipelines`, `crm_stages`, `crm_leads` | Enum string |

E ajusta a policy:

```sql
drop policy "pipelines_select_org_members" on public.crm_pipelines;

create policy "pipelines_select_with_permission"
  on public.crm_pipelines for select
  using (
    organization_id in (select organization_id from public.fn_user_org_ids())
    and (
      -- managers/admins/owners veem tudo
      exists (
        select 1 from public.user_organizations
        where user_id = auth.uid()
          and organization_id = crm_pipelines.organization_id
          and role in ('owner', 'admin', 'manager')
      )
      -- agents só veem se tem permissão explícita ou se o pipeline é "público" (sem entry em permissions)
      or not exists (
        select 1 from public.crm_pipeline_permissions where pipeline_id = crm_pipelines.id
      )
      or exists (
        select 1 from public.crm_pipeline_permissions
        where pipeline_id = crm_pipelines.id and user_id = auth.uid()
      )
    )
  );
```

🎯 **Decisão:** comece **sem essa tabela**. Adicione **só quando o cliente pedir**. 9 em 10 clientes nunca pedem.

---

## 12. Vocabulary aplicado: exemplo de header do board

```tsx
'use client';
import { usePipelineVocabulary } from '@/hooks/usePipelineVocabulary';

export function BoardHeader({ pipelineId, leadCount }: { pipelineId: string; leadCount: number }) {
  const v = usePipelineVocabulary(pipelineId);
  return (
    <div className="flex items-baseline justify-between p-4">
      <div>
        <h1 className="text-2xl font-bold">{v.pipeline_label ?? 'Funil'}</h1>
        <p className="text-sm text-muted-foreground">
          {leadCount} {leadCount === 1 ? v.lead : v.lead_plural}
        </p>
      </div>
    </div>
  );
}
```

---

## 13. Checklist de implementação multi-tenant

- [ ] `organizations` e `user_organizations` existem
- [ ] `crm_pipelines` criado com `organization_id` + unique slug
- [ ] `crm_stages` criado com `pipeline_id`
- [ ] RLS habilitada em `crm_pipelines`, `crm_stages`, `crm_leads`
- [ ] Helper `fn_user_org_ids()` criado
- [ ] Trigger `is_default` único garantido
- [ ] Trigger primeiro pipeline vira default
- [ ] Endpoint `POST /api/crm/pipelines` valida com Zod
- [ ] Endpoint protege role (manager/admin/owner) pra criar
- [ ] UI `<PipelineTabs>` lista e troca pipeline ativo
- [ ] Hook `usePipelineVocabulary` mergeia com defaults
- [ ] Pelo menos 1 pipeline default por org (no signup, seed automático)

---

## Próximo: [03-kanban-cards-drag-drop.md](03-kanban-cards-drag-drop.md)
