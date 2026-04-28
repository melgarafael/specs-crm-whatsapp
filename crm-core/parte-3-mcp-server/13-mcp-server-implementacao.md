# 13 — MCP Server: implementação do esqueleto executável

> **Resumo:** monta um projeto Node.js novo (`crm-mcp/`), configura `@modelcontextprotocol/sdk`, escreve a estrutura modular (server, db, auth, tools, resources, prompts) e roda em **stdio** e **Streamable HTTP** no mesmo código. Ao terminar este doc, você tem um servidor MCP funcional com 1 tool de exemplo. As outras 18+ tools entram no Doc 14.

---

## 1. Setup do projeto

📦 **Criar projeto separado:**

```bash
mkdir crm-mcp
cd crm-mcp

npm init -y

# SDK oficial + Zod (validação) + Express (transport HTTP)
npm install @modelcontextprotocol/sdk zod express cors

# Tipos + ferramentas
npm install -D typescript @types/node @types/express @types/cors tsx
```

⚠️ **Gotcha (Node version):** o SDK exige Node 20+. Confirme com `node -v`. Em produção, fixe a versão num `.nvmrc`.

---

## 2. `package.json`

📦 **Substitua o `package.json` gerado por este:**

```json
{
  "name": "@suaempresa/crm-mcp",
  "version": "0.1.0",
  "description": "MCP server for the universal CRM core",
  "type": "module",
  "bin": {
    "crm-mcp": "./build/index.js"
  },
  "scripts": {
    "dev:stdio": "tsx src/index.ts",
    "dev:http": "tsx src/index-http.ts",
    "build": "tsc && chmod 755 build/index.js build/index-http.js",
    "start:stdio": "node build/index.js",
    "start:http": "node build/index-http.js",
    "test:client": "tsx scripts/test-client.ts"
  },
  "files": ["build", "README.md"],
  "engines": {
    "node": ">=20"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "cors": "^2.8.5",
    "express": "^4.21.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@types/cors": "^2.8.17",
    "@types/express": "^5.0.0",
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0"
  }
}
```

⚠️ **Gotcha (`"type": "module"`):** o SDK é distribuído como ESM. Você **precisa** ter `"type": "module"`. Tente `"commonjs"` e os imports `.js` quebram.

---

## 3. `tsconfig.json`

📦 **`tsconfig.json`:**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./build",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "build"]
}
```

⚠️ **Gotcha (`Node16` resolution):** sem isso, os imports do SDK (que usam exports map) não resolvem corretamente. Não troque por `"node"`/`"bundler"` sem saber o que tá fazendo.

---

## 4. Estrutura de pastas

```
crm-mcp/
├── package.json
├── tsconfig.json
├── .env.example
├── README.md
├── src/
│   ├── index.ts              # entry stdio
│   ├── index-http.ts         # entry HTTP/SSE
│   ├── server.ts             # cria McpServer + registra tools/resources/prompts
│   ├── db.ts                 # client HTTP pra REST API do CRM (ou SQL direto)
│   ├── auth.ts               # resolução de org + user (stdio = env, HTTP = bearer)
│   ├── logger.ts             # logger estruturado em JSON
│   ├── errors.ts             # erros tipados
│   ├── tools/
│   │   ├── index.ts          # registra todas as tools no server
│   │   ├── list-leads.ts
│   │   └── create-lead.ts
│   ├── resources/
│   │   ├── index.ts
│   │   └── schema.ts
│   └── prompts/
│       ├── index.ts
│       └── analyze-stuck-leads.ts
└── build/                    # gerado pelo tsc
```

---

## 5. `.env.example`

📦 **`.env.example`:**

```bash
# ─────────────────────────────────────────────────
# Conexão com seu CRM (a REST API da Parte 2)
# ─────────────────────────────────────────────────
CRM_API_BASE_URL="https://api.seucrm.com"

# Em stdio (single-tenant), você passa o token direto:
CRM_API_TOKEN=""

# Em HTTP (multi-tenant), o servidor MCP faz auth via Bearer recebido
# do cliente — não precisa setar CRM_API_TOKEN em runtime, é resolvido por request.

# ─────────────────────────────────────────────────
# Em modo stdio: org/user fixos (single-user no Claude Desktop)
# ─────────────────────────────────────────────────
DEFAULT_ORGANIZATION_ID=""
DEFAULT_USER_ID=""

# ─────────────────────────────────────────────────
# Em modo HTTP: configurações do servidor
# ─────────────────────────────────────────────────
PORT="3333"
HOST="0.0.0.0"

# Lista CSV de hosts permitidos pra DNS rebinding protection
ALLOWED_HOSTS="mcp.seucrm.com,localhost:3333"

# Lista CSV de origins pra CORS (Claude Desktop não usa CORS, mas browsers IA usam)
ALLOWED_ORIGINS="https://claude.ai,https://cursor.com"

# Logging
LOG_LEVEL="info"
```

---

## 6. `src/logger.ts` — logger estruturado

📦 **`src/logger.ts`:**

```typescript
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const ACTIVE_LEVEL: LogLevel =
  (process.env.LOG_LEVEL as LogLevel) || 'info';

function shouldLog(lvl: LogLevel): boolean {
  return LEVEL_PRIORITY[lvl] >= LEVEL_PRIORITY[ACTIVE_LEVEL];
}

/**
 * Loga em JSON via stderr (NUNCA stdout em modo stdio — stdout é o canal MCP).
 */
function log(lvl: LogLevel, msg: string, ctx: Record<string, unknown> = {}) {
  if (!shouldLog(lvl)) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level: lvl,
    msg,
    ...ctx,
  });
  process.stderr.write(line + '\n');
}

export const logger = {
  debug: (msg: string, ctx?: Record<string, unknown>) => log('debug', msg, ctx),
  info: (msg: string, ctx?: Record<string, unknown>) => log('info', msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => log('warn', msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => log('error', msg, ctx),
};
```

⚠️ **Gotcha crítico (stdio):** em modo stdio, `console.log` quebra o protocolo, porque o cliente MCP lê o stdout esperando JSON-RPC. **Sempre logue em stderr** (`process.stderr.write`). Se você usar `console.log` por engano, o Claude Desktop vai derrubar a conexão sem aviso.

---

## 7. `src/errors.ts` — erros tipados

📦 **`src/errors.ts`:**

```typescript
export class McpAppError extends Error {
  constructor(
    public code:
      | 'unauthenticated'
      | 'forbidden'
      | 'not_found'
      | 'invalid_input'
      | 'upstream_failed'
      | 'rate_limited'
      | 'internal',
    message: string,
    public statusCode = 500,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'McpAppError';
  }
}

/** Converte erro qualquer pro formato MCP de tool result com isError=true. */
export function errorToToolResult(err: unknown) {
  if (err instanceof McpAppError) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            error: err.code,
            message: err.message,
            details: err.details ?? null,
          }),
        },
      ],
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [
      { type: 'text' as const, text: JSON.stringify({ error: 'internal', message }) },
    ],
  };
}
```

---

## 8. `src/auth.ts` — contexto de identidade

📦 **`src/auth.ts`:**

```typescript
import { McpAppError } from './errors.js';

/**
 * Identidade resolvida — sempre presente quando uma tool é chamada.
 */
export interface AuthContext {
  /** Token usado pra chamar a REST API do CRM. */
  apiToken: string;
  /** Organização atual. Em multi-tenant, vem do token. */
  organizationId: string;
  /** Usuário que invocou a tool. Vai pra `performed_by_user_id` em activities. */
  userId: string;
}

/**
 * Modo stdio: identidade vem do .env (single-user).
 */
export function authFromEnv(): AuthContext {
  const apiToken = process.env.CRM_API_TOKEN;
  const organizationId = process.env.DEFAULT_ORGANIZATION_ID;
  const userId = process.env.DEFAULT_USER_ID;

  if (!apiToken) {
    throw new McpAppError(
      'unauthenticated',
      'CRM_API_TOKEN não configurado no env',
      401,
    );
  }
  if (!organizationId) {
    throw new McpAppError(
      'forbidden',
      'DEFAULT_ORGANIZATION_ID não configurado',
      403,
    );
  }
  if (!userId) {
    throw new McpAppError(
      'forbidden',
      'DEFAULT_USER_ID não configurado',
      403,
    );
  }

  return { apiToken, organizationId, userId };
}

/**
 * Modo HTTP: identidade vem de Bearer token validado contra a REST API do CRM.
 *
 * Você pode trocar essa implementação por uma que faça verificação JWT local,
 * cache em memória (com TTL), ou consulta no Redis — depende do volume.
 */
export async function authFromBearer(
  bearer: string,
  apiBaseUrl: string,
): Promise<AuthContext> {
  if (!bearer.startsWith('Bearer ')) {
    throw new McpAppError('unauthenticated', 'Authorization header inválido', 401);
  }
  const token = bearer.slice('Bearer '.length).trim();
  if (!token) {
    throw new McpAppError('unauthenticated', 'Token vazio', 401);
  }

  // Endpoint /me da sua REST API resolve token → { user_id, organization_id }.
  // Se você não tem ainda, crie. Doc 15 mostra o caminho.
  const res = await fetch(`${apiBaseUrl}/api/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 401) {
    throw new McpAppError('unauthenticated', 'Token inválido ou expirado', 401);
  }
  if (!res.ok) {
    throw new McpAppError(
      'upstream_failed',
      `Falha ao validar token: ${res.status}`,
      502,
    );
  }

  const data = (await res.json()) as { user_id: string; organization_id: string };
  return {
    apiToken: token,
    organizationId: data.organization_id,
    userId: data.user_id,
  };
}
```

🎯 **Decisão:** o token Bearer recebido pelo MCP server é **passado adiante** pra REST API do CRM em cada chamada. O MCP server **não armazena credenciais permanentes** — ele é um **proxy semântico**. Toda autorização final acontece na sua REST API (Parte 2), com RLS no banco. Isso simplifica muito a segurança.

---

## 9. `src/db.ts` — cliente HTTP da REST API do CRM

📦 **`src/db.ts`:**

```typescript
import type { AuthContext } from './auth.js';
import { McpAppError } from './errors.js';
import { logger } from './logger.js';

const API_BASE_URL =
  process.env.CRM_API_BASE_URL ?? 'http://localhost:3001';

export class CrmClient {
  constructor(private readonly auth: AuthContext) {}

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    let url = `${API_BASE_URL}${path}`;
    if (query) {
      const usp = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) usp.set(k, String(v));
      }
      const qs = usp.toString();
      if (qs) url += `?${qs}`;
    }

    const t0 = Date.now();
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.auth.apiToken}`,
        'X-Organization-Id': this.auth.organizationId,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const elapsedMs = Date.now() - t0;

    logger.debug('crm_api_call', { method, path, status: res.status, elapsedMs });

    if (res.status === 401) {
      throw new McpAppError('unauthenticated', 'Token CRM inválido', 401);
    }
    if (res.status === 403) {
      throw new McpAppError('forbidden', 'Sem permissão na operação', 403);
    }
    if (res.status === 404) {
      throw new McpAppError('not_found', `Recurso não encontrado: ${path}`, 404);
    }
    if (res.status === 422 || res.status === 400) {
      const text = await res.text();
      throw new McpAppError(
        'invalid_input',
        `Validação falhou: ${text}`,
        res.status,
        text,
      );
    }
    if (!res.ok) {
      const text = await res.text();
      throw new McpAppError(
        'upstream_failed',
        `${method} ${path}: ${res.status} ${text}`,
        res.status,
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // ─── Pipelines ───
  listPipelines() {
    return this.request<Pipeline[]>('GET', '/api/pipelines');
  }
  getPipeline(id: string) {
    return this.request<Pipeline>('GET', `/api/pipelines/${id}`);
  }
  listStages(pipelineId: string) {
    return this.request<Stage[]>('GET', `/api/pipelines/${pipelineId}/stages`);
  }

  // ─── Leads ───
  listLeads(filters: ListLeadsFilters) {
    return this.request<{ items: Lead[]; total: number }>(
      'GET',
      '/api/leads',
      undefined,
      filters as Record<string, string | number | boolean | undefined>,
    );
  }
  searchLeads(query: string, limit = 25) {
    return this.request<Lead[]>(
      'GET',
      '/api/leads/search',
      undefined,
      { q: query, limit },
    );
  }
  getLead(id: string) {
    return this.request<LeadDetailed>('GET', `/api/leads/${id}`);
  }
  createLead(input: CreateLeadInput) {
    return this.request<Lead>('POST', '/api/leads', input);
  }
  updateLead(id: string, patch: UpdateLeadInput) {
    return this.request<Lead>('PATCH', `/api/leads/${id}`, patch);
  }
  deleteLead(id: string) {
    return this.request<void>('DELETE', `/api/leads/${id}`);
  }
  moveLeadToStage(id: string, stageId: string, position?: number) {
    return this.request<Lead>(
      'POST',
      `/api/leads/${id}/move`,
      { stage_id: stageId, position },
    );
  }
  markLeadWon(id: string, value_cents?: number) {
    return this.request<Lead>(
      'POST',
      `/api/leads/${id}/won`,
      { value_cents },
    );
  }
  markLeadLost(id: string, reason: string) {
    return this.request<Lead>(
      'POST',
      `/api/leads/${id}/lost`,
      { lost_reason: reason },
    );
  }
  assignLead(id: string, ownerUserId: string) {
    return this.request<Lead>(
      'POST',
      `/api/leads/${id}/assign`,
      { owner_user_id: ownerUserId },
    );
  }

  // ─── Activities ───
  listActivities(leadId: string, limit = 50) {
    return this.request<Activity[]>(
      'GET',
      `/api/leads/${leadId}/activities`,
      undefined,
      { limit },
    );
  }
  addActivity(leadId: string, input: AddActivityInput) {
    return this.request<Activity>(
      'POST',
      `/api/leads/${leadId}/activities`,
      input,
    );
  }

  // ─── Links (lead → recurso externo) ───
  linkLead(
    leadId: string,
    input: { target_kind: string; target_id: string; link_kind: string; metadata?: unknown },
  ) {
    return this.request<{ id: string }>(
      'POST',
      `/api/leads/${leadId}/links`,
      input,
    );
  }

  // ─── Tags ───
  addTags(leadId: string, tags: string[]) {
    return this.request<Lead>(
      'POST',
      `/api/leads/${leadId}/tags`,
      { tags },
    );
  }
  removeTags(leadId: string, tags: string[]) {
    return this.request<Lead>(
      'DELETE',
      `/api/leads/${leadId}/tags`,
      { tags },
    );
  }

  // ─── Bulk ───
  bulkUpdate(ids: string[], patch: UpdateLeadInput) {
    return this.request<{ updated: number }>(
      'POST',
      '/api/leads/bulk',
      { ids, patch },
    );
  }

  // ─── Metrics ───
  getMetrics(pipelineId?: string) {
    return this.request<LeadMetrics>(
      'GET',
      '/api/metrics/leads',
      undefined,
      { pipeline_id: pipelineId },
    );
  }

  // ─── Schema (pra resource crm://schema) ───
  getSchema() {
    return this.request<CrmSchema>('GET', '/api/meta/schema');
  }
}

// ─── Tipos compartilhados ───

export interface Pipeline {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  is_default: boolean;
  position: number;
  color: string | null;
  icon: string | null;
  vocabulary: Record<string, string> | null;
  settings: Record<string, unknown> | null;
  stages?: Stage[];
}

export interface Stage {
  id: string;
  pipeline_id: string;
  name: string;
  position: number;
  is_won: boolean;
  is_lost: boolean;
  color: string | null;
  win_probability: number | null;
  automation_config: Record<string, unknown> | null;
  wip_limit: number | null;
}

export interface Lead {
  id: string;
  organization_id: string;
  pipeline_id: string;
  stage_id: string;
  contact_id: string | null;
  title: string;
  value_cents: number;
  currency: string;
  status: 'open' | 'won' | 'lost';
  owner_user_id: string | null;
  source: string | null;
  source_metadata: Record<string, unknown> | null;
  custom_fields: Record<string, unknown> | null;
  tags: string[];
  position_in_stage: number;
  lost_reason: string | null;
  expected_close_date: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  last_activity_at: string | null;
}

export interface LeadDetailed extends Lead {
  pipeline?: Pipeline;
  stage?: Stage;
  contact?: { id: string; phone_number: string | null; full_name: string | null };
  activities_recent?: Activity[];
  links?: Array<{
    id: string;
    target_kind: string;
    target_id: string;
    link_kind: string;
  }>;
}

export interface Activity {
  id: string;
  organization_id: string;
  lead_id: string;
  contact_id: string | null;
  type: string;
  title: string | null;
  body: string | null;
  performed_by_user_id: string | null;
  performed_at: string;
  metadata: Record<string, unknown> | null;
  source_module: string | null;
  source_id: string | null;
}

export interface ListLeadsFilters {
  pipeline_id?: string;
  stage_id?: string;
  owner_user_id?: string;
  status?: 'open' | 'won' | 'lost';
  q?: string;
  tags?: string;
  value_min_cents?: number;
  value_max_cents?: number;
  last_activity_before?: string;
  last_activity_after?: string;
  created_after?: string;
  created_before?: string;
  limit?: number;
  offset?: number;
}

export interface CreateLeadInput {
  title: string;
  pipeline_id: string;
  stage_id?: string;
  contact_id?: string;
  contact_phone?: string;
  contact_name?: string;
  value_cents?: number;
  currency?: string;
  owner_user_id?: string;
  source?: string;
  source_metadata?: Record<string, unknown>;
  custom_fields?: Record<string, unknown>;
  tags?: string[];
  expected_close_date?: string;
}

export interface UpdateLeadInput {
  title?: string;
  value_cents?: number;
  currency?: string;
  owner_user_id?: string | null;
  source?: string | null;
  source_metadata?: Record<string, unknown>;
  custom_fields?: Record<string, unknown>;
  tags?: string[];
  expected_close_date?: string | null;
  position_in_stage?: number;
}

export interface AddActivityInput {
  type: string;
  title?: string;
  body?: string;
  metadata?: Record<string, unknown>;
  source_module?: string;
  source_id?: string;
}

export interface LeadMetrics {
  total_open: number;
  total_won: number;
  total_lost: number;
  conversion_rate: number;
  by_stage: Array<{
    stage_id: string;
    stage_name: string;
    count: number;
    avg_time_in_stage_hours: number;
  }>;
  by_owner: Array<{
    user_id: string;
    name: string | null;
    open: number;
    won: number;
    lost: number;
  }>;
}

export interface CrmSchema {
  pipelines: Array<{ id: string; slug: string; name: string }>;
  stages_by_pipeline: Record<string, Stage[]>;
  vocabulary: Record<string, Record<string, string>>;
  custom_fields_definitions?: Record<string, unknown>;
  tags_known: string[];
  generated_at: string;
}
```

🎯 **Decisão:** o `CrmClient` é **stateless por construção** — uma instância por chamada de tool. Isso simplifica multi-tenant: cada chamada cria seu próprio client com o `AuthContext` daquela request. Não há shared state entre tools, então não tem race condition.

---

## 10. `src/server.ts` — instância principal do `McpServer`

📦 **`src/server.ts`:**

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools } from './tools/index.js';
import { registerAllResources } from './resources/index.js';
import { registerAllPrompts } from './prompts/index.js';
import type { AuthContext } from './auth.js';

/**
 * Cria uma nova instância de McpServer já com tools/resources/prompts registrados.
 *
 * Em modo stdio: 1 instância no processo inteiro.
 * Em modo HTTP: 1 instância por sessão (cada cliente tem seu McpServer + Transport).
 *
 * O `getAuth` é uma function que cada handler chama pra obter a identidade.
 * Em stdio, retorna sempre o mesmo AuthContext (do .env).
 * Em HTTP, retorna o AuthContext da sessão atual (resolvido do Bearer no init).
 */
export function buildServer(getAuth: () => AuthContext): McpServer {
  const server = new McpServer(
    {
      name: 'crm-mcp',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
        resources: { subscribe: false, listChanged: false },
        prompts: { listChanged: false },
        logging: {},
      },
      instructions: `
You are connected to a CRM. Always read the resource crm://schema first to
understand pipelines, stages, vocabulary, and custom fields before acting.
Use list_pipelines and list_stages when you don't know IDs.
For destructive actions (delete_lead, mark_lead_lost), confirm with the user
unless they were explicit. Never invent stage_id, pipeline_id, or lead_id.
      `.trim(),
    },
  );

  registerAllTools(server, getAuth);
  registerAllResources(server, getAuth);
  registerAllPrompts(server, getAuth);

  return server;
}
```

⚠️ **Gotcha:** o campo `instructions` é injetado no system prompt do LLM pelo cliente MCP automaticamente (Claude Desktop, Cursor). Use isso pra dar regras de comportamento sem o usuário precisar configurar prompt.

---

## 11. `src/tools/index.ts` — registry de tools

📦 **`src/tools/index.ts`:**

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthContext } from '../auth.js';
import { registerListLeads } from './list-leads.js';
import { registerCreateLead } from './create-lead.js';

/**
 * Registra todas as tools. Cada tool é um arquivo isolado em src/tools/.
 *
 * Mantenha esta lista alfabeticamente ordenada — facilita revisão.
 */
export function registerAllTools(
  server: McpServer,
  getAuth: () => AuthContext,
): void {
  registerCreateLead(server, getAuth);
  registerListLeads(server, getAuth);
  // No Doc 14 esta lista cresce pra 19+ tools.
}
```

---

## 12. `src/tools/list-leads.ts` — primeira tool de leitura

📦 **`src/tools/list-leads.ts`:**

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthContext } from '../auth.js';
import { CrmClient } from '../db.js';
import { errorToToolResult } from '../errors.js';
import { logger } from '../logger.js';

export function registerListLeads(
  server: McpServer,
  getAuth: () => AuthContext,
): void {
  server.registerTool(
    'list_leads',
    {
      title: 'List Leads',
      description: `
List leads in the current organization with optional filters.
Useful for: showing pipeline state, finding stuck leads, filtering by owner.
Returns up to 100 leads per call. Use offset/limit to paginate.
      `.trim(),
      inputSchema: {
        pipeline_id: z
          .string()
          .uuid()
          .optional()
          .describe('Filter by pipeline UUID. Omit to search across all pipelines.'),
        stage_id: z.string().uuid().optional(),
        owner_user_id: z.string().uuid().optional(),
        status: z.enum(['open', 'won', 'lost']).optional(),
        q: z
          .string()
          .optional()
          .describe('Free-text search on lead title and contact name.'),
        tags: z
          .array(z.string())
          .optional()
          .describe('Match leads that have ALL these tags.'),
        value_min_cents: z.number().int().nonnegative().optional(),
        value_max_cents: z.number().int().nonnegative().optional(),
        last_activity_before_iso: z
          .string()
          .datetime()
          .optional()
          .describe('Find leads with no activity since this ISO date.'),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().nonnegative().default(0),
      },
    },
    async (args) => {
      try {
        const auth = getAuth();
        const client = new CrmClient(auth);
        const result = await client.listLeads({
          pipeline_id: args.pipeline_id,
          stage_id: args.stage_id,
          owner_user_id: args.owner_user_id,
          status: args.status,
          q: args.q,
          tags: args.tags?.join(','),
          value_min_cents: args.value_min_cents,
          value_max_cents: args.value_max_cents,
          last_activity_before: args.last_activity_before_iso,
          limit: args.limit,
          offset: args.offset,
        });

        logger.info('tool_list_leads_ok', {
          count: result.items.length,
          total: result.total,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  total: result.total,
                  returned: result.items.length,
                  items: result.items.map((l) => ({
                    id: l.id,
                    title: l.title,
                    pipeline_id: l.pipeline_id,
                    stage_id: l.stage_id,
                    status: l.status,
                    value: l.value_cents / 100,
                    currency: l.currency,
                    owner_user_id: l.owner_user_id,
                    tags: l.tags,
                    last_activity_at: l.last_activity_at,
                    updated_at: l.updated_at,
                  })),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        logger.error('tool_list_leads_failed', { err: String(err) });
        return errorToToolResult(err);
      }
    },
  );
}
```

---

## 13. `src/tools/create-lead.ts` — primeira tool de mutação

📦 **`src/tools/create-lead.ts`:**

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthContext } from '../auth.js';
import { CrmClient } from '../db.js';
import { errorToToolResult } from '../errors.js';
import { logger } from '../logger.js';

export function registerCreateLead(
  server: McpServer,
  getAuth: () => AuthContext,
): void {
  server.registerTool(
    'create_lead',
    {
      title: 'Create Lead',
      description: `
Create a new lead in the CRM.
Pipeline_id is required. Stage_id is optional — if omitted, the lead lands in the
first stage of the pipeline. If contact_id is omitted but contact_phone is provided,
the CRM will find or create a contact by phone (E.164 format expected, e.g. +5511999998888).
Always pass value_cents (integer, smallest currency unit) — never decimal "value".
      `.trim(),
      inputSchema: {
        title: z.string().min(1).max(500),
        pipeline_id: z.string().uuid(),
        stage_id: z.string().uuid().optional(),
        contact_id: z.string().uuid().optional(),
        contact_phone: z
          .string()
          .regex(/^\+?[1-9]\d{6,14}$/)
          .optional()
          .describe('E.164 format, e.g. +5511999998888'),
        contact_name: z.string().min(1).optional(),
        value_cents: z.number().int().nonnegative().optional(),
        currency: z.string().length(3).default('BRL'),
        owner_user_id: z.string().uuid().optional(),
        source: z.string().max(100).optional(),
        custom_fields: z.record(z.string(), z.unknown()).optional(),
        tags: z.array(z.string()).max(50).optional(),
        expected_close_date: z.string().date().optional(),
      },
    },
    async (args) => {
      try {
        const auth = getAuth();
        const client = new CrmClient(auth);
        const lead = await client.createLead({
          title: args.title,
          pipeline_id: args.pipeline_id,
          stage_id: args.stage_id,
          contact_id: args.contact_id,
          contact_phone: args.contact_phone,
          contact_name: args.contact_name,
          value_cents: args.value_cents,
          currency: args.currency,
          owner_user_id: args.owner_user_id,
          source: args.source,
          custom_fields: args.custom_fields,
          tags: args.tags,
          expected_close_date: args.expected_close_date,
        });

        logger.info('tool_create_lead_ok', { lead_id: lead.id, title: lead.title });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  id: lead.id,
                  title: lead.title,
                  pipeline_id: lead.pipeline_id,
                  stage_id: lead.stage_id,
                  status: lead.status,
                  value: lead.value_cents / 100,
                  currency: lead.currency,
                  created_at: lead.created_at,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        logger.error('tool_create_lead_failed', { err: String(err) });
        return errorToToolResult(err);
      }
    },
  );
}
```

⚠️ **Gotcha (descrição é prompt):** o campo `description` é lido pelo LLM como **mini prompt**. Frases como "always pass value_cents (integer, smallest currency unit) — never decimal" salvam você de bugs onde o LLM mandaria `value: 49.90`. Trate descrições como código.

---

## 14. `src/resources/index.ts` — registry de resources

📦 **`src/resources/index.ts`:**

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthContext } from '../auth.js';
import { registerSchemaResource } from './schema.js';

export function registerAllResources(
  server: McpServer,
  getAuth: () => AuthContext,
): void {
  registerSchemaResource(server, getAuth);
}
```

---

## 15. `src/resources/schema.ts` — resource `crm://schema`

📦 **`src/resources/schema.ts`:**

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthContext } from '../auth.js';
import { CrmClient } from '../db.js';
import { logger } from '../logger.js';

export function registerSchemaResource(
  server: McpServer,
  getAuth: () => AuthContext,
): void {
  server.registerResource(
    'crm-schema',
    'crm://schema',
    {
      title: 'CRM Schema (live)',
      description:
        'Live snapshot of the CRM structure: pipelines, stages, vocabulary, custom fields, known tags. Always read this first to ground your reasoning.',
      mimeType: 'application/json',
    },
    async (uri) => {
      try {
        const auth = getAuth();
        const client = new CrmClient(auth);
        const schema = await client.getSchema();
        logger.info('resource_schema_ok', {
          pipelines: schema.pipelines.length,
        });
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify(schema, null, 2),
            },
          ],
        };
      } catch (err) {
        logger.error('resource_schema_failed', { err: String(err) });
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify({
                error: 'failed_to_load_schema',
                message: String(err),
              }),
            },
          ],
        };
      }
    },
  );
}
```

---

## 16. `src/prompts/index.ts` — registry de prompts

📦 **`src/prompts/index.ts`:**

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthContext } from '../auth.js';
import { registerAnalyzeStuckLeads } from './analyze-stuck-leads.js';

export function registerAllPrompts(
  server: McpServer,
  getAuth: () => AuthContext,
): void {
  registerAnalyzeStuckLeads(server, getAuth);
}
```

---

## 17. `src/prompts/analyze-stuck-leads.ts` — prompt pré-definido

📦 **`src/prompts/analyze-stuck-leads.ts`:**

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthContext } from '../auth.js';

export function registerAnalyzeStuckLeads(
  server: McpServer,
  _getAuth: () => AuthContext,
): void {
  server.registerPrompt(
    'analyze_stuck_leads',
    {
      title: 'Analyze Stuck Leads',
      description:
        'Lists leads with no activity in N days and proposes one action per lead based on activity history.',
      argsSchema: {
        days: z
          .string()
          .default('7')
          .describe('How many days without activity counts as "stuck"'),
        pipeline_id: z
          .string()
          .optional()
          .describe('Optional UUID of a specific pipeline'),
      },
    },
    ({ days, pipeline_id }) => {
      const filter = pipeline_id
        ? `in pipeline ${pipeline_id}`
        : 'across all pipelines';
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `
Use the CRM tools to do the following:

1. Read crm://schema for context.
2. Call list_leads ${filter} with status="open" and last_activity_before_iso = (today - ${days} days as ISO).
3. For each returned lead, call list_activities to inspect history.
4. Output a markdown table with columns: title, days_stuck, value, last_activity_summary, suggested_next_action.
5. Suggest a concrete next action for each, based on the history.

Be concise. If a lead has zero activities, recommend a first-touch.
              `.trim(),
            },
          },
        ],
      };
    },
  );
}
```

---

## 18. `src/index.ts` — entry stdio

📦 **`src/index.ts`:**

```typescript
#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { authFromEnv } from './auth.js';
import { logger } from './logger.js';
import { buildServer } from './server.js';

async function main() {
  // Em stdio, identidade vem do .env. Resolve uma vez no boot.
  const auth = authFromEnv();
  logger.info('mcp_stdio_boot', {
    organizationId: auth.organizationId,
    userId: auth.userId,
  });

  const server = buildServer(() => auth);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('mcp_stdio_ready');
}

main().catch((err) => {
  logger.error('mcp_stdio_fatal', { err: String(err) });
  process.exit(1);
});
```

⚠️ **Gotcha:** o shebang `#!/usr/bin/env node` na primeira linha + `chmod 755` no script `build` (ver `package.json`) faz o build virar um executável. Sem isso, `claude_desktop_config.json` precisa de `"command": "node"`.

---

## 19. `src/index-http.ts` — entry HTTP/SSE

📦 **`src/index-http.ts`:**

```typescript
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { authFromBearer, type AuthContext } from './auth.js';
import { logger } from './logger.js';
import { buildServer } from './server.js';

const PORT = Number(process.env.PORT ?? 3333);
const HOST = process.env.HOST ?? '0.0.0.0';
const API_BASE_URL = process.env.CRM_API_BASE_URL ?? 'http://localhost:3001';

const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS ?? `localhost:${PORT}`)
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '*')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

interface SessionState {
  transport: StreamableHTTPServerTransport;
  auth: AuthContext;
}

const sessions = new Map<string, SessionState>();

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(
  cors({
    origin: ALLOWED_ORIGINS.length === 1 && ALLOWED_ORIGINS[0] === '*' ? '*' : ALLOWED_ORIGINS,
    exposedHeaders: ['Mcp-Session-Id', 'MCP-Protocol-Version', 'WWW-Authenticate'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Mcp-Session-Id',
      'MCP-Protocol-Version',
    ],
  }),
);

// ─── Healthcheck (livre de auth) ───
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, sessions: sessions.size });
});

// ─── POST /mcp — requests JSON-RPC do cliente ───
app.post('/mcp', async (req: Request, res: Response) => {
  try {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && sessions.has(sessionId)) {
      // Sessão existente: roteia pra transport correspondente.
      const { transport } = sessions.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // Sem sessão: precisa ser uma `initialize` request.
    if (!isInitializeRequest(req.body)) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'No session — first request must be initialize',
        },
        id: null,
      });
      return;
    }

    // Auth: resolve Bearer → AuthContext
    const bearer = req.headers.authorization;
    if (!bearer) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Missing Authorization header' },
        id: null,
      });
      return;
    }

    let auth: AuthContext;
    try {
      auth = await authFromBearer(bearer, API_BASE_URL);
    } catch (err) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: String(err) },
        id: null,
      });
      return;
    }

    // Cria transport e server pra essa sessão.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: true,
      allowedHosts: ALLOWED_HOSTS,
      onsessioninitialized: (sid) => {
        sessions.set(sid, { transport, auth });
        logger.info('mcp_session_init', {
          session_id: sid,
          organization_id: auth.organizationId,
          user_id: auth.userId,
        });
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        sessions.delete(sid);
        logger.info('mcp_session_closed', { session_id: sid });
      }
    };

    const server = buildServer(() => auth);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    logger.error('mcp_post_failed', { err: String(err) });
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal error' },
        id: null,
      });
    }
  }
});

// ─── GET /mcp — abre stream SSE pra notificações server→client ───
app.get('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).send('Invalid or missing session');
    return;
  }
  const { transport } = sessions.get(sessionId)!;
  await transport.handleRequest(req, res);
});

// ─── DELETE /mcp — cliente fecha sessão limpa ───
app.delete('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).send('Invalid or missing session');
    return;
  }
  const { transport } = sessions.get(sessionId)!;
  await transport.handleRequest(req, res);
});

app.listen(PORT, HOST, () => {
  logger.info('mcp_http_listening', { host: HOST, port: PORT });
});
```

🎯 **Decisão crítica: 1 sessão = 1 McpServer + 1 Transport + 1 AuthContext.** Não compartilhe `McpServer` entre sessões. O SDK é projetado pra isso ser barato (constructor leve, registrations são closures). Compartilhar quebra multi-tenant.

⚠️ **Gotcha (DNS rebinding):** habilitar `enableDnsRebindingProtection: true` com `allowedHosts` impede ataque clássico onde um site malicioso usa o navegador da vítima como proxy pra fazer request no `localhost:3333`. Em produção, sempre setar.

---

## 20. Ciclo de vida de uma chamada (mental model)

Pra fixar — o que acontece quando o usuário diz "lista os leads":

### Em stdio:

```
1. Claude Desktop spawna `node build/index.js`
2. Server lê .env → AuthContext fixo
3. Server.connect(StdioServerTransport)
4. Cliente envia `initialize` → server responde com capabilities
5. Cliente envia `tools/list` → server responde com 19 tools
6. Usuário no chat: "lista os leads"
7. Claude (LLM) decide chamar list_leads
8. Cliente envia `tools/call` { name: "list_leads", arguments: {...} }
9. Server invoca handler → CrmClient.listLeads → REST API → DB
10. Server responde com content[0].text JSON dos leads
11. Claude formata e mostra ao usuário
```

### Em HTTP:

```
1. Claude Desktop conecta em https://mcp.seucrm.com/mcp
2. POST /mcp { initialize, ... } com Authorization: Bearer tok_xxx
3. Server cria sessão: gera sessionId, valida bearer → AuthContext
4. Cria McpServer + Transport, salva em sessions Map
5. Responde 200 + Mcp-Session-Id header
6. Cliente envia GET /mcp com Mcp-Session-Id (abre stream SSE)
7. Cliente envia POST /mcp tools/list, tools/call, etc. — sempre com Mcp-Session-Id
8. Quando cliente desconecta: DELETE /mcp ou timeout → sessão removida
```

---

## 21. Rodando localmente

📦 **`.env` (criado a partir do `.env.example`):**

```bash
CRM_API_BASE_URL="http://localhost:3001"
CRM_API_TOKEN="tok_dev_seu_token_aqui"
DEFAULT_ORGANIZATION_ID="00000000-0000-0000-0000-000000000001"
DEFAULT_USER_ID="00000000-0000-0000-0000-000000000002"
PORT="3333"
LOG_LEVEL="debug"
```

**Modo stdio:**

```bash
npm run dev:stdio
# (não vai imprimir nada visível — fica esperando input no stdin)
```

**Modo HTTP:**

```bash
npm run dev:http
# {"ts":"...","level":"info","msg":"mcp_http_listening","host":"0.0.0.0","port":3333}
```

**Smoke test rápido (HTTP):**

```bash
curl -X POST http://localhost:3333/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer tok_dev_seu_token_aqui" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-06-18",
      "capabilities": {},
      "clientInfo": { "name": "curl", "version": "0.0" }
    }
  }'
```

Você deve ver um header `Mcp-Session-Id` na resposta + JSON com `serverInfo` e `capabilities`.

---

## 22. Build pra produção

```bash
npm run build
# build/index.js, build/index-http.js criados, ambos chmod 755

# Stdio:
node build/index.js

# HTTP:
node build/index-http.js
```

Empacotamento `npx` pra distribuição: ver Doc 15.

---

## 23. Checklist deste documento

Ao terminar, você deve ter:

- [ ] Projeto `crm-mcp/` criado com a estrutura de pastas exata
- [ ] `package.json`, `tsconfig.json`, `.env.example` no lugar
- [ ] `src/logger.ts`, `src/errors.ts`, `src/auth.ts`, `src/db.ts`, `src/server.ts`
- [ ] Pelo menos 1 tool de leitura (`list_leads`) e 1 de mutação (`create_lead`)
- [ ] 1 resource (`crm://schema`)
- [ ] 1 prompt (`analyze_stuck_leads`)
- [ ] `npm run dev:stdio` roda sem crash
- [ ] `npm run dev:http` sobe na porta configurada
- [ ] Smoke test via curl retorna sessão válida

Não testou conexão com Claude Desktop ainda? Tudo bem — isso é o **Doc 15**. Antes, você precisa das outras 17 tools, que vêm no **Doc 14**.

---

## Próximo: [14-mcp-tools-do-crm.md](14-mcp-tools-do-crm.md)
