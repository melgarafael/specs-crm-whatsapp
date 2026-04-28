# Prompt 06 — CRM-core scaffolding (Parte 1: Arquitetura + UI)

> **Resumo:** prompt self-contained pra IA executar a Parte 1 da aula CRM-core. Cria as 5 tabelas (`crm_pipelines`, `crm_stages`, `crm_leads`, `crm_lead_activities`, `crm_lead_links`) + `event_log` + `webhook_subscriptions`, instala `@hello-pangea/dnd`, scaffolda os componentes do kanban (`PipelineBoard`, `StageColumn`, `LeadCard`, `BoardFiltersBar`, `PipelineTabs`), helpers de fractional indexing, hook `useBoard` com Realtime, e endpoints básicos `GET/POST /api/crm/pipelines`. **NÃO inclui** CRUD completo de leads — isso é Prompt 07 (responsabilidade do Agent B).

---

## Contexto que você (IA) precisa saber

Você é uma IA executora trabalhando dentro de um projeto **Next.js 14+ (App Router) + TypeScript + Tailwind + shadcn/ui + Supabase**.

O projeto **já tem**:
- Multi-tenant com `organizations` + `user_organizations(user_id, organization_id, role)`
- `contacts` (id, organization_id, ...)
- Tabelas de chat WhatsApp: `channel_sessions`, `conversations`, `messages`, `webhook_events_log`
- Auth via Supabase Auth
- shadcn/ui instalado
- Helpers `getSupabaseBrowserClient()` e `getSupabaseServerClient()`

Você **vai criar** o CRM-core sem mexer no que já existe. Tudo o que toca no DB é **idempotente**.

---

## Regras de execução

1. **Não mude código existente.** Só adicione.
2. **Idempotência total.** SQL com `CREATE IF NOT EXISTS`, triggers com `DROP IF EXISTS ... CREATE`. Pode rodar 100×.
3. **Não invente tabelas que já existem** (`organizations`, `contacts`, `auth.users`, `channel_sessions`, etc.).
4. **Use TypeScript estrito.** Sem `any` exceto onde justificado.
5. **Use Tailwind + componentes shadcn/ui** existentes (Button, Input, Select, etc.).
6. **`@hello-pangea/dnd`** (não `react-beautiful-dnd`).
7. **Não implemente CRUD completo de leads.** Só: scaffolding pra o board funcionar com leads existentes.
8. **Comente decisões de relacionamento** nas migrations (uma linha SQL `comment on column ...`).

---

## Plano de execução (8 passos)

### Passo 1 — Migration SQL

Crie `supabase/migrations/{timestamp}_crm_core.sql` com o conteúdo de [reference/crm-schema.sql](../reference/crm-schema.sql) (referência canônica).

Resumo do que esse SQL cria:

- Helper `fn_user_org_ids()` (RLS).
- Helper `fn_crm_set_updated_at()`.
- Tabela `crm_pipelines` + indexes + comments + 3 triggers.
- Tabela `crm_stages` + indexes + 1 trigger.
- Tabela `crm_leads` + indexes (incl. GIN tags + GIN custom_fields) + 2 triggers.
- Tabela `crm_lead_activities` + indexes + 2 triggers (`touch_activity`, `emit_event`).
- Tabela `crm_lead_links` + indexes.
- Tabela `event_log` + indexes + unique idempotency.
- Tabela `webhook_subscriptions` + indexes.
- RLS habilitada nas 7 tabelas + policies.
- Realtime publication em todas idempotentemente.
- Trigger seed default pipeline ao criar org.

### Passo 2 — Instalar dependências

```bash
npm install @hello-pangea/dnd zod react-hook-form @hookform/resolvers
npm install date-fns lucide-react sonner
```

### Passo 3 — Helper de fractional indexing

Crie `src/lib/crm/fractional-position.ts`:

```ts
/**
 * Calcula um "position_in_stage" entre dois vizinhos (fractional indexing).
 *
 * Retornos:
 *   - lista vazia: 1.0
 *   - topo (sem prev): metade do next
 *   - fim (sem next): prev + 1.0
 *   - meio: midpoint(prev, next)
 */
export function midpoint(prev: number | null, next: number | null): number {
  if (prev == null && next == null) return 1.0;
  if (prev == null) return (next as number) / 2;
  if (next == null) return prev + 1.0;
  return (prev + next) / 2;
}

/**
 * Detecta precisão excessiva (rebalance recomendado).
 */
export function needsRebalance(positions: number[]): boolean {
  for (const p of positions) {
    if (p.toString().includes('e-')) return true;
    const decimals = (p.toString().split('.')[1] ?? '').length;
    if (decimals > 10) return true;
  }
  return false;
}
```

### Passo 4 — Hook `useBoard`

Crie `src/hooks/useBoard.ts` conforme spec do doc 03 da aula. Inclua:

- Tipos `Stage`, `Lead`, `BoardFilters`.
- Carga inicial de stages + leads (por pipeline_id).
- Realtime subscription: `crm_leads` + `crm_stages` filtrados por `pipeline_id`.
- Reload em mudança de filtros.
- Retorno: `{ stages, leads, loading, reload, setLeads }`.

### Passo 5 — Componentes do kanban

Crie:

```
src/components/crm/PipelineBoard.tsx
src/components/crm/PipelineTabs.tsx
src/components/crm/StageColumn.tsx
src/components/crm/LeadCard.tsx
src/components/crm/BoardFiltersBar.tsx
src/components/crm/BoardHeader.tsx       (opcional, com vocab)
```

Comportamento:

- `<PipelineBoard pipelineId>`:
  - Carrega via `useBoard(pipelineId, filters)`.
  - Renderiza `<BoardFiltersBar>` no topo.
  - Renderiza `<DragDropContext>` com `<StageColumn>` por stage.
  - `onDragEnd` calcula `midpoint(prev, next)` e faz **optimistic update** + `supabase.from('crm_leads').update({ stage_id, position_in_stage })`.
  - Em erro: `toast.error()` + `reload()`.

- `<StageColumn>`:
  - Header com nome, count, soma de valores, badge de WIP.
  - WIP estourado: badge vermelha.
  - `<Droppable>` com `min-h-[120px]`.
  - Empty state: "Nenhum card".

- `<LeadCard>`:
  - Título, valor formatado em BRL, tags, owner avatar, last_activity_at em date-fns.
  - Click: `Link href={'/crm/leads/' + id}` (rota não precisa existir nesse prompt).

- `<PipelineTabs>`:
  - Lista pipelines da org, mostra `name + icon`, troca rota `/crm/{slug}/board`.

- `<BoardFiltersBar>`:
  - Busca debounced (300ms).
  - Selects: owner, source.
  - Inputs numéricos: min/max value (em centavos).
  - Botão "Limpar".

### Passo 6 — Hook `usePipelineVocabulary`

Crie `src/hooks/usePipelineVocabulary.ts`:

- Retorna o jsonb `vocabulary` mergeado com defaults (lead, lead_plural, deal, won_label, lost_label, owner_label, value_label, title_field).
- Defaults: Lead, Leads, Negócio, Negócios, Ganho, Perdido, Responsável, Valor, Título.

### Passo 7 — Endpoints API

Crie:

```
src/app/api/crm/pipelines/route.ts          (GET listar, POST criar)
src/app/api/crm/pipelines/[id]/route.ts     (PATCH atualizar, DELETE)
src/app/api/crm/leads/[id]/move/route.ts    (POST mover lead com fractional indexing)
```

`POST /api/crm/pipelines` espera:

```ts
{
  pipeline: {
    name: string,
    slug: string (snake-kebab),
    color?: string,
    icon?: string,
    vocabulary?: Record<string, string>,
    settings?: Record<string, any>
  },
  stages: Array<{
    name: string,
    position: number,
    color?: string,
    is_won?: boolean,
    is_lost?: boolean,
    win_probability?: number,
    wip_limit?: number | null
  }>  // mínimo 1
}
```

Validar com Zod. Apenas `role in (owner, admin, manager)` pode criar.

`POST /api/crm/leads/[id]/move`:

```ts
{
  destStageId: string (uuid),
  prevPosition: number | null,
  nextPosition: number | null
}
```

Calcula `midpoint(prev, next)`, atualiza `stage_id + position_in_stage`, e se a stage destino tem `is_won` ou `is_lost`, marca status apropriado e `closed_at`. Valida WIP limit (alerta, não bloqueia por padrão).

### Passo 8 — Página de demonstração

Crie `src/app/(app)/crm/[slug]/board/page.tsx`:

```tsx
import { PipelineBoard } from '@/components/crm/PipelineBoard';
import { PipelineTabs } from '@/components/crm/PipelineTabs';
import { resolvePipelineBySlug } from '@/lib/crm/server';

export default async function BoardPage({ params }: { params: { slug: string } }) {
  const pipeline = await resolvePipelineBySlug(params.slug);
  if (!pipeline) return <div>Pipeline não encontrado.</div>;

  return (
    <div className="flex h-screen flex-col">
      <PipelineTabs organizationId={pipeline.organization_id} activeSlug={params.slug} />
      <div className="flex-1 overflow-hidden">
        <PipelineBoard pipelineId={pipeline.id} />
      </div>
    </div>
  );
}
```

Crie `src/lib/crm/server.ts`:

```ts
import { getSupabaseServerClient } from '@/lib/supabase/server';

export async function resolvePipelineBySlug(slug: string) {
  const supa = getSupabaseServerClient();
  const { data } = await supa
    .from('crm_pipelines')
    .select('id, organization_id, slug, name')
    .eq('slug', slug)
    .single();
  return data;
}
```

---

## Definition of Done

- [ ] SQL migration aplicada (Supabase Studio confirma 7 tabelas + triggers + policies)
- [ ] `npm run dev` roda sem erros TypeScript
- [ ] Visitar `/crm/sales/board` mostra o board com 6 stages do seed default
- [ ] Drag & drop entre stages funciona (otimista + persistido)
- [ ] Mover pra "Fechado" → lead vira `status='won'` automaticamente (via trigger DB)
- [ ] Ao fazer drag, `position_in_stage` muda **só no card movido** (não cascateia)
- [ ] Outro browser aberto na mesma org vê a mudança via Realtime em <2s
- [ ] `<PipelineTabs>` lista pipelines e troca rota
- [ ] `<BoardFiltersBar>` filtra por owner, source, valor
- [ ] `POST /api/crm/pipelines` cria pipeline + stages com Zod validando
- [ ] WIP estourado mostra badge vermelha no header da stage

---

## O que NÃO é responsabilidade deste prompt

- CRUD detalhado de leads (formulário com custom_fields dinâmicos) — **Prompt 07** (Agent B / REST API)
- Vista de detalhe do lead (`/crm/leads/[id]`) com timeline
- Importação CSV
- Bulk operations
- MCP server — **Prompt 08** (Agent C / MCP)
- Webhooks de saída funcionando (estrutura está, worker é separado)
- Edge Functions de automation_config
- Métricas / dashboards

Esses ficam pra prompts subsequentes da aula.

---

## Comandos de verificação ao terminar

```bash
# 1. Lint + types
npm run lint
npm run build

# 2. Conferir migration aplicada
# (Supabase Studio ou)
psql $DATABASE_URL -c "select count(*) from crm_pipelines where slug='sales';"
# → esperado >= 1 (seed automático em organizations existentes? ajuste se necessário)

# 3. Ping no endpoint
curl -X GET http://localhost:3000/api/crm/pipelines \
  -H "Cookie: $YOUR_AUTH_COOKIE"
# → 200 com lista
```

---

## Erros comuns e como resolver

| Erro | Causa | Fix |
|------|------|-----|
| `column "position_in_stage" does not exist` | Migration não rodou | Rode `supabase db push` ou aplicar SQL manual |
| Drag-and-drop não solta | `<Droppable>` sem `min-h-*` | Garantir altura mínima de 120px |
| Realtime não chega | Tabela não está no `supabase_realtime` publication | Confirmar via `\d+ pg_publication_tables` |
| RLS bloqueando | Service role key sendo usada no client | Usar **anon key** no browser, **service** só em handlers SSR/edge |
| Position vira `Infinity` ou `NaN` | `midpoint(null, null)` em lista vazia retornando errado | Default = 1.0 quando ambos null |
| Toast não aparece | Sonner provider não montado | Adicionar `<Toaster />` no root layout |
| `auth.uid()` retorna null em RLS | Sessão não propagou pro server client | Conferir `cookies()` no `getSupabaseServerClient()` |

---

## Comentários de qualidade

- ✅ Comente colunas críticas com `comment on column ...` (SQL).
- ✅ Tipos exportados em `src/types/crm.ts` (Stage, Lead, Pipeline) pra outros módulos consumirem.
- ✅ `useDebounce` numa lib utilitária (não inline em N componentes).
- ✅ Não polua o board com modais de criação aqui — fica pro próximo prompt.

Bom trabalho. Entregue limpo.
