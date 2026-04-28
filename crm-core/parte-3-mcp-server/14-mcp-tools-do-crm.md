# 14 — As 19 Tools do CRM (read + write completos)

> **Resumo:** implementação completa de 19 tools cobrindo o funil inteiro de CRM — pipelines, stages, leads, activities, links, tags, métricas. Inclui leitura, mutação, transições de estado e operações em massa. Cada tool tem schema Zod, descrição calibrada pra LLM, implementação TypeScript pronta pra colar e exemplo de uso natural → chamada → resposta.

---

## 1. Princípios de design das tools

Antes de despejar código, fixe estes 6 princípios. Eles decidem se sua IA vai operar bem ou alucinar.

### 1.1. Granularidade certa

Tools muito grandes ("`do_crm_action`") fazem o LLM se perder. Tools muito pequenas explodem o prompt com schemas. Regra: **uma tool = uma intenção humana**.

- ✅ `move_lead_to_stage` (uma intenção)
- ❌ `update_lead` que aceita stage_id (mistura mover com editar título)

### 1.2. Descrições escritas pra LLM, não pra dev

Ela vai num system prompt comprimido. Comece com verbo + objeto, e liste **constraints** explícitas:

> "Move a lead to a different stage. Both the lead and the new stage must already exist. Use list_pipelines first if you don't know stage IDs."

### 1.3. IDs são UUIDs, nunca slugs/nomes

LLM pode alucinar nomes, mas alucinar UUID é raro. **Schemas exigem UUID**, e há tools de busca pra LLM resolver nome→UUID.

### 1.4. Mutações são idempotentes onde possível

`add_tags` em vez de `set_tags` — ele não destrói tags existentes acidentalmente. Pra `set` use `update_lead` com `tags` explicitamente.

### 1.5. Erros são auto-explicativos

O `errorToToolResult` retorna `{ error, message, details }` em JSON. O LLM lê isso e reage (ex: "ah, stage_id inválido, deixa eu listar primeiro").

### 1.6. Outputs são compactos

Não devolva o objeto inteiro do banco. Devolva só o que o LLM precisa pra próximo passo: `id`, `title`, e os campos que mudaram.

---

## 2. Mapa das 19 tools

| # | Tool | Tipo | Doc 13? |
|---|------|------|---------|
| 1 | `list_pipelines` | Read | ❌ Esta |
| 2 | `get_pipeline` | Read | ❌ Esta |
| 3 | `list_stages` | Read | ❌ Esta |
| 4 | `list_leads` | Read | ✅ Doc 13 |
| 5 | `get_lead` | Read | ❌ Esta |
| 6 | `search_leads` | Read | ❌ Esta |
| 7 | `list_activities` | Read | ❌ Esta |
| 8 | `get_lead_metrics` | Read | ❌ Esta |
| 9 | `create_lead` | Write | ✅ Doc 13 |
| 10 | `update_lead` | Write | ❌ Esta |
| 11 | `move_lead_to_stage` | Write | ❌ Esta |
| 12 | `delete_lead` | Write | ❌ Esta |
| 13 | `mark_lead_won` | Write | ❌ Esta |
| 14 | `mark_lead_lost` | Write | ❌ Esta |
| 15 | `assign_lead` | Write | ❌ Esta |
| 16 | `add_activity` | Write | ❌ Esta |
| 17 | `link_lead_to_resource` | Write | ❌ Esta |
| 18 | `add_tags` / `remove_tags` | Write | ❌ Esta |
| 19 | `bulk_update_leads` | Write | ❌ Esta |

---

## 3. Read tools

### 3.1. `list_pipelines`

📦 **`src/tools/list-pipelines.ts`:**

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthContext } from '../auth.js';
import { CrmClient } from '../db.js';
import { errorToToolResult } from '../errors.js';

export function registerListPipelines(
  server: McpServer,
  getAuth: () => AuthContext,
): void {
  server.registerTool(
    'list_pipelines',
    {
      title: 'List Pipelines',
      description: `
List all pipelines in the current organization, including their stages.
Pipelines are different funnels (e.g. "Sales", "Support", "Onboarding").
Use this when you don't know pipeline IDs or stage IDs.
Each pipeline has: id, name, slug, vocabulary (per-niche labels), and stages.
      `.trim(),
      inputSchema: {
        include_stages: z
          .boolean()
          .default(true)
          .describe('Include stages in response. Set false for a leaner answer.'),
      },
    },
    async ({ include_stages }) => {
      try {
        const client = new CrmClient(getAuth());
        const pipelines = await client.listPipelines();
        const compact = pipelines.map((p) => ({
          id: p.id,
          name: p.name,
          slug: p.slug,
          is_default: p.is_default,
          vocabulary: p.vocabulary,
          stages: include_stages
            ? p.stages?.map((s) => ({
                id: s.id,
                name: s.name,
                position: s.position,
                is_won: s.is_won,
                is_lost: s.is_lost,
                win_probability: s.win_probability,
              }))
            : undefined,
        }));
        return {
          content: [{ type: 'text', text: JSON.stringify(compact, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
```

**Exemplo:**

> *Usuário:* "Quais pipelines tenho?"
> *LLM:* chama `list_pipelines({ include_stages: true })`
> *Resposta:* `[{ id, name: "Sales", stages: [...] }, ...]`
> *LLM responde:* "Você tem 2 pipelines: Sales (5 stages) e Onboarding (4 stages)."

---

### 3.2. `get_pipeline`

📦 **`src/tools/get-pipeline.ts`:**

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthContext } from '../auth.js';
import { CrmClient } from '../db.js';
import { errorToToolResult } from '../errors.js';

export function registerGetPipeline(
  server: McpServer,
  getAuth: () => AuthContext,
): void {
  server.registerTool(
    'get_pipeline',
    {
      title: 'Get Pipeline',
      description: `
Get full details of a single pipeline by ID, including all stages,
vocabulary mapping, settings, and color/icon.
Use this when you need stage IDs or want to inspect pipeline configuration.
      `.trim(),
      inputSchema: {
        pipeline_id: z.string().uuid(),
      },
    },
    async ({ pipeline_id }) => {
      try {
        const client = new CrmClient(getAuth());
        const p = await client.getPipeline(pipeline_id);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  id: p.id,
                  name: p.name,
                  slug: p.slug,
                  is_default: p.is_default,
                  vocabulary: p.vocabulary,
                  settings: p.settings,
                  stages: p.stages,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
```

---

### 3.3. `list_stages`

📦 **`src/tools/list-stages.ts`:**

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthContext } from '../auth.js';
import { CrmClient } from '../db.js';
import { errorToToolResult } from '../errors.js';

export function registerListStages(
  server: McpServer,
  getAuth: () => AuthContext,
): void {
  server.registerTool(
    'list_stages',
    {
      title: 'List Stages',
      description: `
List stages for a single pipeline, ordered by position.
Each stage has: id, name, position, is_won, is_lost, win_probability, wip_limit.
Use this when you know the pipeline but need stage IDs to move leads.
      `.trim(),
      inputSchema: {
        pipeline_id: z.string().uuid(),
      },
    },
    async ({ pipeline_id }) => {
      try {
        const client = new CrmClient(getAuth());
        const stages = await client.listStages(pipeline_id);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(stages, null, 2),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
```

---

### 3.4. `list_leads` — já no Doc 13

Refer to Doc 13 §12. **Não duplique**.

---

### 3.5. `get_lead`

📦 **`src/tools/get-lead.ts`:**

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthContext } from '../auth.js';
import { CrmClient } from '../db.js';
import { errorToToolResult } from '../errors.js';

export function registerGetLead(
  server: McpServer,
  getAuth: () => AuthContext,
): void {
  server.registerTool(
    'get_lead',
    {
      title: 'Get Lead',
      description: `
Get full detail of a single lead by ID.
Returns: lead fields, related pipeline, stage, contact, last 10 activities,
and external links (calendar events, messages, docs).
Use this before any action that needs context (e.g. before suggesting next step).
      `.trim(),
      inputSchema: {
        lead_id: z.string().uuid(),
      },
    },
    async ({ lead_id }) => {
      try {
        const client = new CrmClient(getAuth());
        const lead = await client.getLead(lead_id);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  id: lead.id,
                  title: lead.title,
                  status: lead.status,
                  pipeline: lead.pipeline
                    ? { id: lead.pipeline.id, name: lead.pipeline.name }
                    : null,
                  stage: lead.stage
                    ? {
                        id: lead.stage.id,
                        name: lead.stage.name,
                        win_probability: lead.stage.win_probability,
                      }
                    : null,
                  value: lead.value_cents / 100,
                  currency: lead.currency,
                  owner_user_id: lead.owner_user_id,
                  contact: lead.contact,
                  tags: lead.tags,
                  custom_fields: lead.custom_fields,
                  expected_close_date: lead.expected_close_date,
                  created_at: lead.created_at,
                  updated_at: lead.updated_at,
                  last_activity_at: lead.last_activity_at,
                  closed_at: lead.closed_at,
                  lost_reason: lead.lost_reason,
                  activities_recent: lead.activities_recent?.slice(0, 10),
                  links: lead.links,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
```

---

### 3.6. `search_leads`

📦 **`src/tools/search-leads.ts`:**

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthContext } from '../auth.js';
import { CrmClient } from '../db.js';
import { errorToToolResult } from '../errors.js';

export function registerSearchLeads(
  server: McpServer,
  getAuth: () => AuthContext,
): void {
  server.registerTool(
    'search_leads',
    {
      title: 'Search Leads',
      description: `
Full-text search on lead title and contact name.
Returns up to 25 leads, ranked by relevance and recency.
Use this when the user mentions a lead by name (e.g. "the João lead", "Acme deal")
and you need to find the lead_id.
If multiple match, prefer the most recently active.
      `.trim(),
      inputSchema: {
        query: z.string().min(1).max(200),
        limit: z.number().int().min(1).max(25).default(10),
      },
    },
    async ({ query, limit }) => {
      try {
        const client = new CrmClient(getAuth());
        const leads = await client.searchLeads(query, limit);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                leads.map((l) => ({
                  id: l.id,
                  title: l.title,
                  pipeline_id: l.pipeline_id,
                  stage_id: l.stage_id,
                  status: l.status,
                  value: l.value_cents / 100,
                  last_activity_at: l.last_activity_at,
                })),
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
```

**Exemplo:**

> *Usuário:* "Como tá o lead da Maria?"
> *LLM:* `search_leads({ query: "Maria" })` → recebe 2 leads → escolhe o `last_activity_at` mais recente → `get_lead({ lead_id })` → responde com contexto.

---

### 3.7. `list_activities`

📦 **`src/tools/list-activities.ts`:**

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthContext } from '../auth.js';
import { CrmClient } from '../db.js';
import { errorToToolResult } from '../errors.js';

export function registerListActivities(
  server: McpServer,
  getAuth: () => AuthContext,
): void {
  server.registerTool(
    'list_activities',
    {
      title: 'List Activities',
      description: `
List activities of a single lead, newest first.
Activities can be: note, call, meeting, message, email, status_change, custom.
Use this to see lead history before suggesting next action.
      `.trim(),
      inputSchema: {
        lead_id: z.string().uuid(),
        limit: z.number().int().min(1).max(100).default(50),
      },
    },
    async ({ lead_id, limit }) => {
      try {
        const client = new CrmClient(getAuth());
        const activities = await client.listActivities(lead_id, limit);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                activities.map((a) => ({
                  id: a.id,
                  type: a.type,
                  title: a.title,
                  body: a.body?.slice(0, 500), // trunca pra não estourar contexto
                  performed_at: a.performed_at,
                  performed_by_user_id: a.performed_by_user_id,
                  source_module: a.source_module,
                })),
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
```

---

### 3.8. `get_lead_metrics`

📦 **`src/tools/get-lead-metrics.ts`:**

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthContext } from '../auth.js';
import { CrmClient } from '../db.js';
import { errorToToolResult } from '../errors.js';

export function registerGetLeadMetrics(
  server: McpServer,
  getAuth: () => AuthContext,
): void {
  server.registerTool(
    'get_lead_metrics',
    {
      title: 'Get Lead Metrics',
      description: `
Get aggregate metrics for the lead funnel:
- total_open / won / lost
- conversion_rate
- by_stage: count per stage + average time in stage (hours)
- by_owner: distribution per user
Use this to answer "how is the funnel?" or "where are we losing leads?".
Filter by pipeline_id to scope to a single funnel.
      `.trim(),
      inputSchema: {
        pipeline_id: z.string().uuid().optional(),
      },
    },
    async ({ pipeline_id }) => {
      try {
        const client = new CrmClient(getAuth());
        const m = await client.getMetrics(pipeline_id);
        return {
          content: [{ type: 'text', text: JSON.stringify(m, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
```

---

## 4. Write tools

### 4.1. `create_lead` — já no Doc 13

Refer to Doc 13 §13. Não duplique.

---

### 4.2. `update_lead`

📦 **`src/tools/update-lead.ts`:**

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthContext } from '../auth.js';
import { CrmClient } from '../db.js';
import { errorToToolResult } from '../errors.js';

export function registerUpdateLead(
  server: McpServer,
  getAuth: () => AuthContext,
): void {
  server.registerTool(
    'update_lead',
    {
      title: 'Update Lead',
      description: `
Update fields of an existing lead.
DO NOT use this to move stage (use move_lead_to_stage), close as won/lost
(use mark_lead_won/lost), reassign owner (use assign_lead), or modify tags
(use add_tags/remove_tags). For those, use the dedicated tool.
This tool is for: title, value, currency, source, custom_fields,
expected_close_date, source_metadata.
All fields are optional — only provided fields are updated.
      `.trim(),
      inputSchema: {
        lead_id: z.string().uuid(),
        title: z.string().min(1).max(500).optional(),
        value_cents: z.number().int().nonnegative().optional(),
        currency: z.string().length(3).optional(),
        source: z.string().max(100).nullable().optional(),
        source_metadata: z.record(z.string(), z.unknown()).optional(),
        custom_fields: z.record(z.string(), z.unknown()).optional(),
        expected_close_date: z.string().date().nullable().optional(),
      },
    },
    async ({ lead_id, ...patch }) => {
      try {
        const client = new CrmClient(getAuth());
        const lead = await client.updateLead(lead_id, patch);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  id: lead.id,
                  title: lead.title,
                  value: lead.value_cents / 100,
                  currency: lead.currency,
                  source: lead.source,
                  custom_fields: lead.custom_fields,
                  expected_close_date: lead.expected_close_date,
                  updated_at: lead.updated_at,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
```

---

### 4.3. `move_lead_to_stage`

📦 **`src/tools/move-lead-to-stage.ts`:**

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthContext } from '../auth.js';
import { CrmClient } from '../db.js';
import { errorToToolResult } from '../errors.js';

export function registerMoveLeadToStage(
  server: McpServer,
  getAuth: () => AuthContext,
): void {
  server.registerTool(
    'move_lead_to_stage',
    {
      title: 'Move Lead to Stage',
      description: `
Move a lead to a different stage within the same pipeline.
Both lead and stage must already exist. Stage must belong to the lead's pipeline
(no cross-pipeline moves — for that, you'd need to recreate the lead).
The move generates a status_change activity automatically.
If the target stage is is_won or is_lost, prefer mark_lead_won / mark_lead_lost
(they accept extra context like value, reason).
Optional `position` orders the lead within the stage (lower = top).
      `.trim(),
      inputSchema: {
        lead_id: z.string().uuid(),
        stage_id: z.string().uuid(),
        position: z.number().nonnegative().optional(),
      },
    },
    async ({ lead_id, stage_id, position }) => {
      try {
        const client = new CrmClient(getAuth());
        const lead = await client.moveLeadToStage(lead_id, stage_id, position);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  id: lead.id,
                  title: lead.title,
                  stage_id: lead.stage_id,
                  status: lead.status,
                  position_in_stage: lead.position_in_stage,
                  updated_at: lead.updated_at,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
```

**Exemplo:**

> *Usuário:* "promove o João pra negociação"
> *LLM:* `search_leads("João")` → `list_stages(pipeline_id)` → encontra "Negociação" → `move_lead_to_stage(...)`

---

### 4.4. `delete_lead`

📦 **`src/tools/delete-lead.ts`:**

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthContext } from '../auth.js';
import { CrmClient } from '../db.js';
import { errorToToolResult } from '../errors.js';

export function registerDeleteLead(
  server: McpServer,
  getAuth: () => AuthContext,
): void {
  server.registerTool(
    'delete_lead',
    {
      title: 'Delete Lead (soft)',
      description: `
Soft-delete a lead (sets deleted_at timestamp; row stays in DB for audit).
Activities and links are preserved. Use mark_lead_lost for "didn't close" —
delete is for typo, duplicate, test data, GDPR.
ALWAYS confirm with the user before calling. Pass confirm=true.
If confirm is not set or false, the tool returns an error so the LLM has
to ask the user explicitly.
      `.trim(),
      inputSchema: {
        lead_id: z.string().uuid(),
        confirm: z
          .boolean()
          .describe('Must be true to actually delete. Set false (or omit) to dry-run.'),
        reason: z.string().min(3).max(500).optional(),
      },
    },
    async ({ lead_id, confirm, reason }) => {
      try {
        if (!confirm) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'confirmation_required',
                  message:
                    'Pass confirm=true to actually delete the lead. Confirm with the user first.',
                }),
              },
            ],
          };
        }
        const client = new CrmClient(getAuth());
        await client.deleteLead(lead_id);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                deleted: true,
                lead_id,
                reason: reason ?? null,
              }),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
```

⚠️ **Gotcha (confirmação dupla):** o campo `confirm` força o LLM a refletir antes de apagar. É uma camada barata de segurança contra "ah o usuário disse limpa o crm e o LLM apagou tudo". Em produção, considere ainda exigir confirmação humana via Claude Desktop "tool approval".

---

### 4.5. `mark_lead_won`

📦 **`src/tools/mark-lead-won.ts`:**

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthContext } from '../auth.js';
import { CrmClient } from '../db.js';
import { errorToToolResult } from '../errors.js';

export function registerMarkLeadWon(
  server: McpServer,
  getAuth: () => AuthContext,
): void {
  server.registerTool(
    'mark_lead_won',
    {
      title: 'Mark Lead as Won',
      description: `
Mark a lead as WON (status = 'won', closed_at = now()).
Optionally update value_cents at close (e.g. final negotiated value).
The lead is moved to the first stage flagged is_won in its pipeline.
A status_change activity is auto-generated.
Use this — not move_lead_to_stage — when explicitly closing as won.
      `.trim(),
      inputSchema: {
        lead_id: z.string().uuid(),
        value_cents: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('Final closed value, in smallest currency unit (e.g. cents).'),
      },
    },
    async ({ lead_id, value_cents }) => {
      try {
        const client = new CrmClient(getAuth());
        const lead = await client.markLeadWon(lead_id, value_cents);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  id: lead.id,
                  title: lead.title,
                  status: lead.status,
                  value: lead.value_cents / 100,
                  closed_at: lead.closed_at,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
```

---

### 4.6. `mark_lead_lost`

📦 **`src/tools/mark-lead-lost.ts`:**

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthContext } from '../auth.js';
import { CrmClient } from '../db.js';
import { errorToToolResult } from '../errors.js';

export function registerMarkLeadLost(
  server: McpServer,
  getAuth: () => AuthContext,
): void {
  server.registerTool(
    'mark_lead_lost',
    {
      title: 'Mark Lead as Lost',
      description: `
Mark a lead as LOST. Reason is REQUIRED — the user must explain why.
Common reasons: "no_budget", "competitor_X", "timing", "no_response_30d".
The lead moves to the first stage flagged is_lost in its pipeline.
A status_change activity is auto-generated with the reason.
      `.trim(),
      inputSchema: {
        lead_id: z.string().uuid(),
        reason: z
          .string()
          .min(3)
          .max(200)
          .describe('Short reason. Free text or one of: no_budget, competitor, timing, no_response, ghosted, other.'),
      },
    },
    async ({ lead_id, reason }) => {
      try {
        const client = new CrmClient(getAuth());
        const lead = await client.markLeadLost(lead_id, reason);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  id: lead.id,
                  title: lead.title,
                  status: lead.status,
                  lost_reason: lead.lost_reason,
                  closed_at: lead.closed_at,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
```

---

### 4.7. `assign_lead`

📦 **`src/tools/assign-lead.ts`:**

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthContext } from '../auth.js';
import { CrmClient } from '../db.js';
import { errorToToolResult } from '../errors.js';

export function registerAssignLead(
  server: McpServer,
  getAuth: () => AuthContext,
): void {
  server.registerTool(
    'assign_lead',
    {
      title: 'Assign Lead Owner',
      description: `
Reassign the lead owner (the user responsible for moving it forward).
The new owner must be a member of the same organization.
Generates an "owner_changed" activity automatically.
      `.trim(),
      inputSchema: {
        lead_id: z.string().uuid(),
        owner_user_id: z.string().uuid(),
      },
    },
    async ({ lead_id, owner_user_id }) => {
      try {
        const client = new CrmClient(getAuth());
        const lead = await client.assignLead(lead_id, owner_user_id);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  id: lead.id,
                  title: lead.title,
                  owner_user_id: lead.owner_user_id,
                  updated_at: lead.updated_at,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
```

---

### 4.8. `add_activity`

📦 **`src/tools/add-activity.ts`:**

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthContext } from '../auth.js';
import { CrmClient } from '../db.js';
import { errorToToolResult } from '../errors.js';

export function registerAddActivity(
  server: McpServer,
  getAuth: () => AuthContext,
): void {
  server.registerTool(
    'add_activity',
    {
      title: 'Add Activity',
      description: `
Append an activity to a lead's history.
Activity types (extensible): note, call, meeting, email, message, task, custom.
Use 'note' for free-form observations.
Use 'call' / 'meeting' for explicit interactions; put summary in 'body'.
Use 'task' to log a TODO (with metadata.due_at).
The activity is timestamped at server time and attributed to the current user.
      `.trim(),
      inputSchema: {
        lead_id: z.string().uuid(),
        type: z
          .enum(['note', 'call', 'meeting', 'email', 'message', 'task', 'custom'])
          .default('note'),
        title: z.string().max(200).optional(),
        body: z.string().max(10_000).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async ({ lead_id, type, title, body, metadata }) => {
      try {
        const client = new CrmClient(getAuth());
        const a = await client.addActivity(lead_id, {
          type,
          title,
          body,
          metadata,
          source_module: 'mcp',
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  id: a.id,
                  lead_id: a.lead_id,
                  type: a.type,
                  performed_at: a.performed_at,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
```

**Exemplo:**

> *Usuário:* "Adiciona uma nota no lead da Maria dizendo que ela pediu desconto de 15%"
> *LLM:* `search_leads("Maria")` → `add_activity({ lead_id, type: "note", body: "Cliente pediu desconto de 15%" })`

---

### 4.9. `link_lead_to_resource`

📦 **`src/tools/link-lead-to-resource.ts`:**

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthContext } from '../auth.js';
import { CrmClient } from '../db.js';
import { errorToToolResult } from '../errors.js';

export function registerLinkLeadToResource(
  server: McpServer,
  getAuth: () => AuthContext,
): void {
  server.registerTool(
    'link_lead_to_resource',
    {
      title: 'Link Lead to External Resource',
      description: `
Create a typed link from a lead to an external entity (whatsapp_message,
calendar_event, document, ticket, file). This populates crm_lead_links
so other tools (and humans) can navigate from a lead to the related artifact.
Multiple links per lead allowed. Idempotent on (lead_id, target_kind, target_id).
target_kind examples: "whatsapp_chat", "whatsapp_message", "calendar_event",
"google_doc", "stripe_customer", "task".
link_kind examples: "primary_contact_chat", "kickoff_meeting", "proposal_doc".
      `.trim(),
      inputSchema: {
        lead_id: z.string().uuid(),
        target_kind: z.string().min(1).max(50),
        target_id: z.string().min(1).max(200),
        link_kind: z.string().min(1).max(50),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async ({ lead_id, target_kind, target_id, link_kind, metadata }) => {
      try {
        const client = new CrmClient(getAuth());
        const link = await client.linkLead(lead_id, {
          target_kind,
          target_id,
          link_kind,
          metadata,
        });
        return {
          content: [
            { type: 'text', text: JSON.stringify({ link_id: link.id, lead_id }) },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
```

---

### 4.10. `add_tags` e `remove_tags`

📦 **`src/tools/tags.ts`:**

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthContext } from '../auth.js';
import { CrmClient } from '../db.js';
import { errorToToolResult } from '../errors.js';

export function registerTagsTools(
  server: McpServer,
  getAuth: () => AuthContext,
): void {
  server.registerTool(
    'add_tags',
    {
      title: 'Add Tags to Lead',
      description: `
Add one or more tags to a lead. Idempotent — duplicates are ignored.
Tag names are free text; common values: "vip", "urgent", "warm", "needs_demo".
Does NOT remove existing tags.
      `.trim(),
      inputSchema: {
        lead_id: z.string().uuid(),
        tags: z.array(z.string().min(1).max(50)).min(1).max(20),
      },
    },
    async ({ lead_id, tags }) => {
      try {
        const client = new CrmClient(getAuth());
        const lead = await client.addTags(lead_id, tags);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ id: lead.id, tags: lead.tags }),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.registerTool(
    'remove_tags',
    {
      title: 'Remove Tags from Lead',
      description: `
Remove one or more tags from a lead. No-op if a tag was already absent.
Does NOT delete the lead, only its tag entries.
      `.trim(),
      inputSchema: {
        lead_id: z.string().uuid(),
        tags: z.array(z.string().min(1).max(50)).min(1).max(20),
      },
    },
    async ({ lead_id, tags }) => {
      try {
        const client = new CrmClient(getAuth());
        const lead = await client.removeTags(lead_id, tags);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ id: lead.id, tags: lead.tags }),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
```

---

### 4.11. `bulk_update_leads`

📦 **`src/tools/bulk-update-leads.ts`:**

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthContext } from '../auth.js';
import { CrmClient } from '../db.js';
import { errorToToolResult } from '../errors.js';

export function registerBulkUpdateLeads(
  server: McpServer,
  getAuth: () => AuthContext,
): void {
  server.registerTool(
    'bulk_update_leads',
    {
      title: 'Bulk Update Leads',
      description: `
Apply the same patch to multiple leads in one call. Max 100 leads per call.
Patch supports the same fields as update_lead (title, value_cents, source,
custom_fields, expected_close_date).
DOES NOT support stage move, won/lost, owner change, or tags — use the dedicated
tools for those.
ALWAYS pass confirm=true and explain to the user what will change.
Returns count of leads updated.
      `.trim(),
      inputSchema: {
        lead_ids: z.array(z.string().uuid()).min(1).max(100),
        patch: z.object({
          title: z.string().min(1).max(500).optional(),
          value_cents: z.number().int().nonnegative().optional(),
          currency: z.string().length(3).optional(),
          source: z.string().max(100).nullable().optional(),
          custom_fields: z.record(z.string(), z.unknown()).optional(),
          expected_close_date: z.string().date().nullable().optional(),
        }),
        confirm: z.boolean(),
      },
    },
    async ({ lead_ids, patch, confirm }) => {
      try {
        if (!confirm) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'confirmation_required',
                  message: `Pass confirm=true to apply patch to ${lead_ids.length} leads. Confirm scope with the user first.`,
                }),
              },
            ],
          };
        }
        const client = new CrmClient(getAuth());
        const result = await client.bulkUpdate(lead_ids, patch);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                updated: result.updated,
                requested: lead_ids.length,
              }),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
```

---

## 5. Registry final — `src/tools/index.ts` completo

📦 **`src/tools/index.ts` (versão final):**

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthContext } from '../auth.js';

// Read tools
import { registerListPipelines } from './list-pipelines.js';
import { registerGetPipeline } from './get-pipeline.js';
import { registerListStages } from './list-stages.js';
import { registerListLeads } from './list-leads.js';
import { registerGetLead } from './get-lead.js';
import { registerSearchLeads } from './search-leads.js';
import { registerListActivities } from './list-activities.js';
import { registerGetLeadMetrics } from './get-lead-metrics.js';

// Write tools
import { registerCreateLead } from './create-lead.js';
import { registerUpdateLead } from './update-lead.js';
import { registerMoveLeadToStage } from './move-lead-to-stage.js';
import { registerDeleteLead } from './delete-lead.js';
import { registerMarkLeadWon } from './mark-lead-won.js';
import { registerMarkLeadLost } from './mark-lead-lost.js';
import { registerAssignLead } from './assign-lead.js';
import { registerAddActivity } from './add-activity.js';
import { registerLinkLeadToResource } from './link-lead-to-resource.js';
import { registerTagsTools } from './tags.js';
import { registerBulkUpdateLeads } from './bulk-update-leads.js';

export function registerAllTools(
  server: McpServer,
  getAuth: () => AuthContext,
): void {
  // Read
  registerListPipelines(server, getAuth);
  registerGetPipeline(server, getAuth);
  registerListStages(server, getAuth);
  registerListLeads(server, getAuth);
  registerGetLead(server, getAuth);
  registerSearchLeads(server, getAuth);
  registerListActivities(server, getAuth);
  registerGetLeadMetrics(server, getAuth);

  // Write
  registerCreateLead(server, getAuth);
  registerUpdateLead(server, getAuth);
  registerMoveLeadToStage(server, getAuth);
  registerDeleteLead(server, getAuth);
  registerMarkLeadWon(server, getAuth);
  registerMarkLeadLost(server, getAuth);
  registerAssignLead(server, getAuth);
  registerAddActivity(server, getAuth);
  registerLinkLeadToResource(server, getAuth);
  registerTagsTools(server, getAuth);
  registerBulkUpdateLeads(server, getAuth);
}
```

---

## 6. Resources adicionais (além de `crm://schema`)

Pra IA ter contexto rico sem chamar tool, exponha mais resources. Opcionais mas valiosos:

📦 **`src/resources/pipelines.ts` (resource adicional):**

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthContext } from '../auth.js';
import { CrmClient } from '../db.js';

export function registerPipelinesResource(
  server: McpServer,
  getAuth: () => AuthContext,
): void {
  server.registerResource(
    'crm-pipelines',
    'crm://pipelines',
    {
      title: 'CRM Pipelines',
      description: 'List of all pipelines in the org with stages embedded.',
      mimeType: 'application/json',
    },
    async (uri) => {
      try {
        const client = new CrmClient(getAuth());
        const pipelines = await client.listPipelines();
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify(pipelines, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify({ error: String(err) }),
            },
          ],
        };
      }
    },
  );
}
```

---

## 7. Tabela final: tool → exemplo natural

Pra você confirmar visualmente que cobriu o funil:

| Tool | Frase típica do usuário |
|------|--------------------------|
| `list_pipelines` | "Quais funis tenho?" |
| `get_pipeline` | "Detalhes do funil de vendas" |
| `list_stages` | "Quais estágios do funil X?" |
| `list_leads` | "Lista os leads abertos" |
| `get_lead` | "Como tá o lead da Acme?" |
| `search_leads` | "Acha o lead da Maria" |
| `list_activities` | "O que aconteceu com esse lead?" |
| `get_lead_metrics` | "Como tá o funil?" |
| `create_lead` | "Cria um lead pro João, R$ 2.500" |
| `update_lead` | "Muda o valor pra 5k" |
| `move_lead_to_stage` | "Promove pra negociação" |
| `delete_lead` | "Apaga esse lead duplicado" |
| `mark_lead_won` | "Marca como ganho" |
| `mark_lead_lost` | "Perdemos esse, sem orçamento" |
| `assign_lead` | "Passa esse lead pra Ana" |
| `add_activity` | "Adiciona nota: cliente pediu desconto" |
| `link_lead_to_resource` | "Conecta esse lead com o evento de calendar X" |
| `add_tags` | "Marca como VIP" |
| `remove_tags` | "Tira a tag urgente" |
| `bulk_update_leads` | "Atualiza source pra 'evento_março' nesses 30 leads" |

---

## 8. Como o LLM compõe múltiplas tools

Um exemplo real de chain-of-tools que o Claude executa sem você programar nada:

> *Usuário:* "Olha os leads parados há 7 dias e me sugere ação pra cada um."

```
1. read crm://schema                          (resource)
2. list_pipelines()                           (tool)
3. list_leads({ last_activity_before_iso, status: "open" })
4. for each lead:
   list_activities({ lead_id, limit: 10 })
5. format markdown table + suggestion per row
```

Tudo isso é orquestrado pelo LLM — você só expôs as 19 peças.

---

## 9. Antes de seguir, valide

```bash
npm run dev:stdio  # ou dev:http
```

E peça pro Claude (uma vez configurado — **Doc 15**):

- "Quais ferramentas você tem do CRM?" → deve listar 19 nomes
- "Quais resources?" → `crm://schema`, `crm://pipelines`
- "Quais prompts?" → `analyze_stuck_leads`

Se faltou alguma, voltou ao registry.

---

## Próximo: [15-mcp-deploy-e-conexao.md](15-mcp-deploy-e-conexao.md)
