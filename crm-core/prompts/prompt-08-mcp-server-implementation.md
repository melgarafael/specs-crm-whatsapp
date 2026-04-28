# PROMPT 08 — MCP Server Implementation

> **Cole este prompt depois das fases 01-07 (CRM REST API funcional). Cria um pacote separado `crm-mcp/` com o servidor MCP em TypeScript, expõe 19 tools + 2 resources + 1 prompt, suporta stdio E HTTP, conecta com Claude Desktop e valida ponta-a-ponta.**

---

## Contexto

Você está na **fase 08** da construção do CRM Universal.

Até aqui, foram entregues:
- **Fase 01-05** — WhatsApp via WAHA: setup, sessions, mensagens, frontend, binding com CRM
- **Fase 06** — Schema do CRM Universal (`crm_pipelines`, `crm_stages`, `crm_leads`, `crm_lead_activities`, `crm_lead_links`)
- **Fase 07** — REST API HTTP do CRM (todos os endpoints `/api/pipelines`, `/api/leads`, `/api/leads/:id/move`, etc., autenticada via Bearer token)

Agora você vai expor esse CRM como **MCP server** (Model Context Protocol) — pra que **Claude Desktop, Cursor, Cline e qualquer cliente MCP-compatible** possam operar leads em linguagem natural.

## O que é MCP (resumo de 30 segundos)

**MCP = USB-C da IA.** Protocolo aberto da Anthropic (2024) que padroniza como LLMs se conectam a fontes de dados/ferramentas externas.

Conceitos:
- **Tools** → funções que a IA chama (`create_lead`, `move_lead_to_stage`)
- **Resources** → dados que a IA lê passivamente (`crm://schema`)
- **Prompts** → templates pré-definidos do servidor
- **Transports** → stdio (local, processo filho) ou Streamable HTTP (remoto)

SDK oficial: `@modelcontextprotocol/sdk` (Node.js, versão 1.x estável atual).

Importante: **descrições de tools são prompt** — a IA lê o `description` pra decidir quando chamar. Trate descrições como código de comportamento.

## Sua missão

Criar um **pacote Node.js separado** chamado `crm-mcp/` (não dentro do projeto Next.js — projeto à parte) que:

1. Conecta ao CRM via REST API (a da fase 07) — não fala SQL direto.
2. Registra 19 tools cobrindo o funil completo.
3. Expõe 2 resources (`crm://schema`, `crm://pipelines`) e 1 prompt (`analyze_stuck_leads`).
4. Suporta **stdio** (entry `src/index.ts`) e **Streamable HTTP** (entry `src/index-http.ts`).
5. Em HTTP, resolve identidade via Bearer token chamando `GET /api/me` da REST API.
6. Conecta no Claude Desktop e responde "list_pipelines" via prompt natural.

## Tasks detalhadas

### 1. Setup do projeto

Crie um diretório irmão ao Next.js:

```bash
mkdir crm-mcp
cd crm-mcp
npm init -y
npm install @modelcontextprotocol/sdk zod express cors
npm install -D typescript @types/node @types/express @types/cors tsx
mkdir -p src/tools src/resources src/prompts
```

### 2. `package.json`

Substitua o `package.json` gerado:

```json
{
  "name": "crm-mcp",
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
    "start:http": "node build/index-http.js"
  },
  "files": ["build", "README.md"],
  "engines": { "node": ">=20" },
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

### 3. `tsconfig.json`

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

⚠️ `"type": "module"` + `"module": "Node16"` são **obrigatórios**. O SDK é ESM.

### 4. `.env.example`

```bash
CRM_API_BASE_URL="http://localhost:3001"

# stdio (single-user):
CRM_API_TOKEN=""
DEFAULT_ORGANIZATION_ID=""
DEFAULT_USER_ID=""

# http:
PORT="3333"
HOST="0.0.0.0"
ALLOWED_HOSTS="localhost:3333"
ALLOWED_ORIGINS="*"
LOG_LEVEL="info"
```

### 5. `src/logger.ts`

```typescript
type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';

function log(lvl: LogLevel, msg: string, ctx: Record<string, unknown> = {}) {
  if (LEVELS[lvl] < LEVELS[LEVEL]) return;
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...ctx }) + '\n');
}

export const logger = {
  debug: (m: string, c?: Record<string, unknown>) => log('debug', m, c),
  info: (m: string, c?: Record<string, unknown>) => log('info', m, c),
  warn: (m: string, c?: Record<string, unknown>) => log('warn', m, c),
  error: (m: string, c?: Record<string, unknown>) => log('error', m, c),
};
```

⚠️ **Crítico**: em modo stdio, `console.log` quebra o protocolo (stdout é o canal MCP). **Sempre stderr**.

### 6. `src/errors.ts`

```typescript
export class McpAppError extends Error {
  constructor(
    public code:
      | 'unauthenticated' | 'forbidden' | 'not_found'
      | 'invalid_input' | 'upstream_failed' | 'rate_limited' | 'internal',
    message: string,
    public statusCode = 500,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'McpAppError';
  }
}

export function errorToToolResult(err: unknown) {
  if (err instanceof McpAppError) {
    return {
      isError: true,
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: err.code, message: err.message, details: err.details ?? null }),
      }],
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ error: 'internal', message }) }],
  };
}
```

### 7. `src/auth.ts`

```typescript
import { McpAppError } from './errors.js';

export interface AuthContext {
  apiToken: string;
  organizationId: string;
  userId: string;
}

export function authFromEnv(): AuthContext {
  const apiToken = process.env.CRM_API_TOKEN;
  const organizationId = process.env.DEFAULT_ORGANIZATION_ID;
  const userId = process.env.DEFAULT_USER_ID;
  if (!apiToken) throw new McpAppError('unauthenticated', 'CRM_API_TOKEN não configurado', 401);
  if (!organizationId) throw new McpAppError('forbidden', 'DEFAULT_ORGANIZATION_ID não configurado', 403);
  if (!userId) throw new McpAppError('forbidden', 'DEFAULT_USER_ID não configurado', 403);
  return { apiToken, organizationId, userId };
}

export async function authFromBearer(bearer: string, apiBaseUrl: string): Promise<AuthContext> {
  if (!bearer.startsWith('Bearer ')) throw new McpAppError('unauthenticated', 'Authorization inválido', 401);
  const token = bearer.slice('Bearer '.length).trim();
  if (!token) throw new McpAppError('unauthenticated', 'Token vazio', 401);
  const res = await fetch(`${apiBaseUrl}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) throw new McpAppError('unauthenticated', 'Token inválido/expirado', 401);
  if (!res.ok) throw new McpAppError('upstream_failed', `Falha em /me: ${res.status}`, 502);
  const data = (await res.json()) as { user_id: string; organization_id: string };
  return { apiToken: token, organizationId: data.organization_id, userId: data.user_id };
}
```

### 8. `src/db.ts`

Use exatamente o código do **Doc 13 §9** desta aula. É um wrapper HTTP da REST API com métodos `listPipelines`, `getPipeline`, `listStages`, `listLeads`, `searchLeads`, `getLead`, `createLead`, `updateLead`, `deleteLead`, `moveLeadToStage`, `markLeadWon`, `markLeadLost`, `assignLead`, `listActivities`, `addActivity`, `linkLead`, `addTags`, `removeTags`, `bulkUpdate`, `getMetrics`, `getSchema`, mais os tipos `Pipeline`, `Stage`, `Lead`, `LeadDetailed`, `Activity`, `ListLeadsFilters`, `CreateLeadInput`, `UpdateLeadInput`, `AddActivityInput`, `LeadMetrics`, `CrmSchema`.

### 9. `src/server.ts`

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools } from './tools/index.js';
import { registerAllResources } from './resources/index.js';
import { registerAllPrompts } from './prompts/index.js';
import type { AuthContext } from './auth.js';

export function buildServer(getAuth: () => AuthContext): McpServer {
  const server = new McpServer(
    { name: 'crm-mcp', version: '0.1.0' },
    {
      capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} },
      instructions: `
You are connected to a CRM. Always read crm://schema first to understand
pipelines, stages, vocabulary, and custom fields before acting.
Use list_pipelines and list_stages when you don't know IDs.
For destructive actions (delete_lead, mark_lead_lost, bulk_update_leads),
confirm with the user. Never invent UUIDs.
      `.trim(),
    },
  );
  registerAllTools(server, getAuth);
  registerAllResources(server, getAuth);
  registerAllPrompts(server, getAuth);
  return server;
}
```

### 10. Tools — implementar todos os 19

Crie `src/tools/<nome>.ts` para cada tool, exportando `register<Nome>`. Lista canônica (ver **Doc 14** dessa aula pra código completo):

| Tool | Tipo |
|------|------|
| `list_pipelines` | Read |
| `get_pipeline` | Read |
| `list_stages` | Read |
| `list_leads` | Read |
| `get_lead` | Read |
| `search_leads` | Read |
| `list_activities` | Read |
| `get_lead_metrics` | Read |
| `create_lead` | Write |
| `update_lead` | Write |
| `move_lead_to_stage` | Write |
| `delete_lead` | Write (com `confirm: true` obrigatório) |
| `mark_lead_won` | Write |
| `mark_lead_lost` | Write (reason obrigatório) |
| `assign_lead` | Write |
| `add_activity` | Write |
| `link_lead_to_resource` | Write |
| `add_tags` / `remove_tags` | Write (em `src/tools/tags.ts`) |
| `bulk_update_leads` | Write (com `confirm: true`) |

Padrão para cada arquivo:

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthContext } from '../auth.js';
import { CrmClient } from '../db.js';
import { errorToToolResult } from '../errors.js';

export function registerXxx(server: McpServer, getAuth: () => AuthContext): void {
  server.registerTool(
    'tool_name',
    {
      title: 'Human Readable Title',
      description: 'Concise behavior contract. Constraints. When to use.',
      inputSchema: { /* zod fields */ },
    },
    async (args) => {
      try {
        const client = new CrmClient(getAuth());
        const result = await client.someMethod(...);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
```

`src/tools/index.ts` consolida os imports e chama todos os `register*` em sequência.

### 11. Resources

`src/resources/schema.ts`:

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthContext } from '../auth.js';
import { CrmClient } from '../db.js';

export function registerSchemaResource(server: McpServer, getAuth: () => AuthContext): void {
  server.registerResource(
    'crm-schema',
    'crm://schema',
    {
      title: 'CRM Schema (live)',
      description: 'Live snapshot of pipelines, stages, vocabulary, custom fields. Read FIRST.',
      mimeType: 'application/json',
    },
    async (uri) => {
      try {
        const schema = await new CrmClient(getAuth()).getSchema();
        return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(schema, null, 2) }] };
      } catch (err) {
        return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ error: String(err) }) }] };
      }
    },
  );
}
```

Crie também `src/resources/pipelines.ts` análogo, com URI `crm://pipelines`.

`src/resources/index.ts` registra ambos.

### 12. Prompt

`src/prompts/analyze-stuck-leads.ts`:

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthContext } from '../auth.js';

export function registerAnalyzeStuckLeads(server: McpServer, _getAuth: () => AuthContext): void {
  server.registerPrompt(
    'analyze_stuck_leads',
    {
      title: 'Analyze Stuck Leads',
      description: 'Lists leads with no activity in N days and proposes one action per lead.',
      argsSchema: {
        days: z.string().default('7'),
        pipeline_id: z.string().optional(),
      },
    },
    ({ days, pipeline_id }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `
Use the CRM tools:
1. Read crm://schema for context.
2. list_leads ${pipeline_id ? `in pipeline ${pipeline_id}` : 'across all pipelines'} with status="open" and last_activity_before_iso = today - ${days}d.
3. For each lead: list_activities to inspect history.
4. Output a markdown table: title, days_stuck, value, last_activity_summary, suggested_next_action.
5. Suggest a concrete action per lead. If zero activities, recommend a first-touch.
Be concise.
          `.trim(),
        },
      }],
    }),
  );
}
```

`src/prompts/index.ts` registra.

### 13. Entry stdio — `src/index.ts`

```typescript
#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { authFromEnv } from './auth.js';
import { logger } from './logger.js';
import { buildServer } from './server.js';

async function main() {
  const auth = authFromEnv();
  logger.info('mcp_stdio_boot', { organizationId: auth.organizationId, userId: auth.userId });
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

### 14. Entry HTTP — `src/index-http.ts`

Use o código completo do **Doc 13 §19**. Os pontos chave:

- `express + cors` middleware
- Map `sessions: Map<sessionId, { transport, auth }>`
- `app.post('/mcp')` — se sessão existir reusa; senão exige `isInitializeRequest` + Bearer
- `app.get('/mcp')` — abre stream SSE pra notifications
- `app.delete('/mcp')` — encerra sessão
- `app.get('/healthz')` — healthcheck público
- `enableDnsRebindingProtection: true` + `allowedHosts` da env

### 15. Configurar Claude Desktop

Path:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "crm": {
      "command": "node",
      "args": ["/PATH/ABSOLUTO/PARA/crm-mcp/build/index.js"],
      "env": {
        "CRM_API_BASE_URL": "http://localhost:3001",
        "CRM_API_TOKEN": "tok_dev_xxx",
        "DEFAULT_ORGANIZATION_ID": "<UUID da sua org>",
        "DEFAULT_USER_ID": "<UUID do seu user>",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

⚠️ **Quit + reopen** Claude Desktop (não basta fechar a janela).

### 16. Endpoint `/api/me` no projeto Next.js (CRM REST API)

Pra HTTP transport funcionar, a REST API da Parte 2 precisa expor `/api/me` que valida Bearer e retorna `{ user_id, organization_id }`. Crie `src/app/api/me/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import crypto from 'crypto';

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  const token = auth.slice('Bearer '.length).trim();
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  const supa = getSupabaseServerClient();
  const { data, error } = await supa
    .from('api_tokens')
    .select('user_id, organization_id, scopes, revoked_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (error || !data || data.revoked_at) {
    return NextResponse.json({ error: 'invalid_token' }, { status: 401 });
  }
  return NextResponse.json({
    user_id: data.user_id,
    organization_id: data.organization_id,
    scopes: data.scopes,
  });
}

export const dynamic = 'force-dynamic';
```

Tabela `api_tokens` (se ainda não existe):

```sql
create table if not exists public.api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  scopes text[] not null default '{crm:read,crm:write}',
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index on public.api_tokens (token_hash) where revoked_at is null;
```

Gere um token de dev manualmente:

```sql
-- Gere plaintext: openssl rand -hex 32
-- Plaintext: tok_dev_xxxxxxxxxxxx
-- Hash sha256: <calcule via shell ou JS>
insert into public.api_tokens (user_id, organization_id, name, token_hash)
values ('<seu user_id>', '<sua org_id>', 'dev_local', '<sha256 hex>');
```

E use o **plaintext** no `CRM_API_TOKEN` do MCP server.

### 17. Build e testar

```bash
cd crm-mcp
npm run build

# Smoke test do binário
node build/index.js
# (fica esperando stdin — Ctrl+C pra sair, isso é normal)
```

```bash
# Smoke test HTTP
PORT=3333 node build/index-http.js
# Em outro terminal:
curl -X POST http://localhost:3333/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer tok_dev_xxxxxxxxxxxx" \
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

Resposta deve trazer `Mcp-Session-Id` no header e JSON com `serverInfo`.

### 18. Validação no Claude Desktop

1. Quit Claude Desktop completamente.
2. Reabra.
3. Em qualquer chat, clique no ícone de plugue/martelo. Deve aparecer "**crm**" com 19 tools.
4. Pergunte: "Quais ferramentas do crm você tem?" → deve listar.
5. Pergunte: "Quais pipelines tenho?" → deve chamar `list_pipelines` e responder.
6. Pergunte: "Cria um lead de teste, valor R$ 1.000, no primeiro pipeline." → deve chamar `list_pipelines` → `create_lead` → confirmar criação.

## Estrutura final esperada

```
crm-mcp/
├── package.json
├── tsconfig.json
├── .env.example
├── .env                       (gitignore, com seus valores reais)
├── README.md
├── src/
│   ├── index.ts
│   ├── index-http.ts
│   ├── server.ts
│   ├── db.ts
│   ├── auth.ts
│   ├── logger.ts
│   ├── errors.ts
│   ├── tools/
│   │   ├── index.ts
│   │   ├── list-pipelines.ts
│   │   ├── get-pipeline.ts
│   │   ├── list-stages.ts
│   │   ├── list-leads.ts
│   │   ├── get-lead.ts
│   │   ├── search-leads.ts
│   │   ├── list-activities.ts
│   │   ├── get-lead-metrics.ts
│   │   ├── create-lead.ts
│   │   ├── update-lead.ts
│   │   ├── move-lead-to-stage.ts
│   │   ├── delete-lead.ts
│   │   ├── mark-lead-won.ts
│   │   ├── mark-lead-lost.ts
│   │   ├── assign-lead.ts
│   │   ├── add-activity.ts
│   │   ├── link-lead-to-resource.ts
│   │   ├── tags.ts
│   │   └── bulk-update-leads.ts
│   ├── resources/
│   │   ├── index.ts
│   │   ├── schema.ts
│   │   └── pipelines.ts
│   └── prompts/
│       ├── index.ts
│       └── analyze-stuck-leads.ts
└── build/                     (gerado)
```

## Definition of Done

- [ ] `crm-mcp/` criado, `npm run build` sem erro
- [ ] 19 arquivos de tool em `src/tools/`, todos exportando `register*`
- [ ] 2 resources, 1 prompt registrados
- [ ] `npm run dev:stdio` roda sem crash
- [ ] `npm run dev:http` sobe na porta configurada
- [ ] Endpoint `/api/me` adicionado na REST API da fase 07
- [ ] Token gerado em `api_tokens` (DB) com plaintext salvo no `.env` do MCP server
- [ ] Claude Desktop configurado e reiniciado
- [ ] Claude lista o "crm" e suas 19 tools
- [ ] Pergunta "Quais pipelines tenho?" funciona via `list_pipelines`
- [ ] Pergunta "Cria um lead pra João, R$ 1500" funciona via chain `list_pipelines` + `create_lead`
- [ ] Smoke test HTTP via curl retorna Mcp-Session-Id

## Não faça

- ❌ Não use `console.log` em nenhum lugar — quebra stdio. Use `logger` (stderr).
- ❌ Não bata no DB diretamente — use a REST API da Parte 2.
- ❌ Não use `"type": "commonjs"` — o SDK é ESM.
- ❌ Não invente UUIDs nos tools — schemas Zod exigem `.uuid()`.
- ❌ Não pule a etapa de `npm run build` — Claude Desktop chama `node build/index.js`, não `tsx src/index.ts`.
- ❌ Não distribua nem comite tokens reais — `.env` no `.gitignore`.

## Recovery (se travar)

| Problema | Diagnóstico | Fix |
|----------|-------------|-----|
| Build falha em "Cannot find module @modelcontextprotocol/sdk/server/mcp.js" | Faltou `"moduleResolution": "Node16"` | Ajuste tsconfig.json |
| Claude Desktop mostra erro vermelho no plug | JSON inválido em `claude_desktop_config.json` | Cole em jsonlint.com |
| Claude lista 0 tools | Crash silencioso no boot do MCP | `tail -f ~/Library/Logs/Claude/mcp*.log` |
| Tools listadas mas chamada falha 401 | Token vencido ou wrong hash | Regenere token, atualize `.env`, rebuild, restart Claude |
| HTTP transport responde 400 "Initialize first" | Cliente esqueceu de enviar `initialize` | Sempre primeiro request é `initialize` (sem `Mcp-Session-Id`) |
| Erro "EADDRINUSE" no HTTP | Outra coisa rodando na PORT | Mude PORT no `.env` |

Ao terminar, responda: **"Fase 08 (MCP Server) completa. CRM exposto a clientes IA via 19 tools + 2 resources + 1 prompt. Pronto pra próximo épico (deploy multi-tenant remoto, integração com voice agents, etc.)."**
