# 15 — Deploy do MCP Server e conexão com clientes IA

> **Resumo:** com o servidor pronto (Docs 13-14), agora ele precisa rodar onde os usuários estão. Cobre: configuração local em **Claude Desktop**, **Cursor** e **Cline**, uso direto via **Anthropic SDK** num agente custom, **deploy remoto** com TLS + Bearer auth, distribuição como pacote **npm** com `npx`, observabilidade, segurança em produção e o checklist final pra entregar pra cliente.

---

## 1. Mapa do que vamos cobrir

```
1. Conexão local (stdio)
   ├── Claude Desktop
   ├── Cursor
   └── Cline / Continue
2. Uso programático direto (Anthropic SDK)
3. Deploy HTTP remoto (Streamable HTTP)
   ├── VPS (DigitalOcean, Hetzner, OCI)
   ├── Railway / Fly.io
   ├── Reverse proxy (Nginx + TLS)
   └── Multi-tenant resolution
4. Distribuição como npm package
5. Observabilidade
6. Segurança em produção
7. Definition of Done
```

---

## 2. Conexão local com Claude Desktop

### 2.1. Onde fica o `claude_desktop_config.json`

| OS | Caminho |
|----|---------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

⚠️ **Gotcha:** o arquivo pode não existir até você abrir o Claude Desktop pelo menos uma vez.

### 2.2. Build local + ponteiro absoluto

📦 **No diretório do projeto:**

```bash
cd /Users/joao/projects/crm-mcp
npm run build
# Gera build/index.js já com chmod 755
```

📦 **`claude_desktop_config.json` (macOS):**

```json
{
  "mcpServers": {
    "crm": {
      "command": "node",
      "args": ["/Users/joao/projects/crm-mcp/build/index.js"],
      "env": {
        "CRM_API_BASE_URL": "https://api.seucrm.com",
        "CRM_API_TOKEN": "tok_prod_xxxxxxxxxxxx",
        "DEFAULT_ORGANIZATION_ID": "00000000-0000-0000-0000-000000000001",
        "DEFAULT_USER_ID": "00000000-0000-0000-0000-000000000002",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

📦 **`claude_desktop_config.json` (Windows):**

```json
{
  "mcpServers": {
    "crm": {
      "command": "node",
      "args": ["C:\\Users\\Joao\\projects\\crm-mcp\\build\\index.js"],
      "env": {
        "CRM_API_BASE_URL": "https://api.seucrm.com",
        "CRM_API_TOKEN": "tok_prod_xxxxxxxxxxxx",
        "DEFAULT_ORGANIZATION_ID": "00000000-0000-0000-0000-000000000001",
        "DEFAULT_USER_ID": "00000000-0000-0000-0000-000000000002"
      }
    }
  }
}
```

⚠️ **Gotcha (Windows):** caminhos precisam de `\\` (backslash duplo) no JSON.

### 2.3. Reiniciar Claude Desktop e validar

1. Feche **completamente** o Claude Desktop (não basta fechar a janela; saia do tray/dock).
2. Reabra.
3. Abra qualquer chat. Clique no ícone de plugue/martelo no canto inferior. Você deve ver "**crm**" listado.
4. Pergunte: *"Quais ferramentas do crm você tem?"* — deve responder com as 19 tools.

### 2.4. Quando der ruim — debugging

```bash
# macOS — logs do Claude
tail -f ~/Library/Logs/Claude/mcp*.log

# Linux
tail -f ~/.config/Claude/logs/mcp*.log

# Windows
Get-Content -Wait "$env:APPDATA\Claude\logs\mcp.log"
```

Sintomas comuns:

| Sintoma | Causa | Fix |
|---------|-------|-----|
| Server não aparece | JSON inválido | Cole em jsonlint.com |
| "spawn ENOENT" | `command: "node"` mas Node não está no PATH do app | Use caminho absoluto: `command: "/usr/local/bin/node"` |
| Server aparece mas tools=[] | Crash silencioso no boot | Veja `mcp.log` — provavelmente env faltando |
| Tools listadas mas chamada falha | Auth ou API URL errados | Olhe stderr no log; ajuste env |

---

## 3. Conexão local com Cursor

📦 **`~/.cursor/mcp.json` (Cursor 0.40+):**

```json
{
  "mcpServers": {
    "crm": {
      "command": "node",
      "args": ["/Users/joao/projects/crm-mcp/build/index.js"],
      "env": {
        "CRM_API_BASE_URL": "https://api.seucrm.com",
        "CRM_API_TOKEN": "tok_prod_xxxxxxxxxxxx",
        "DEFAULT_ORGANIZATION_ID": "00000000-0000-0000-0000-000000000001",
        "DEFAULT_USER_ID": "00000000-0000-0000-0000-000000000002"
      }
    }
  }
}
```

Em Cursor: `Cmd/Ctrl + Shift + P` → "Cursor Settings: Open MCP" → habilita o server.

🎯 **Decisão:** Cursor é especialmente útil pro cliente que automatiza CRM **enquanto programa** ("cria um lead pra cada repo que o usuário comentou no GitHub").

---

## 4. Conexão local com Cline (VS Code)

Cline lê config do próprio painel. Procedimento:

1. Abra Cline em VS Code.
2. Settings → MCP Servers → Add new.
3. Type: `stdio`. Command: `node`. Args: `/Users/joao/projects/crm-mcp/build/index.js`.
4. Env: as mesmas 4 variáveis.

Continue (extensão concorrente) tem fluxo idêntico em `~/.continue/config.json`.

---

## 5. Uso programático direto via Anthropic SDK

Cliente avançado: você embute o **MCP client** dentro do seu próprio agente (Anthropic SDK ou OpenAI compat).

📦 **`scripts/agent-with-mcp.ts`** (exemplo completo, salva no projeto principal — não no `crm-mcp/`):

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function main() {
  // 1. Spawna o MCP server local via stdio.
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['/Users/joao/projects/crm-mcp/build/index.js'],
    env: {
      ...(process.env as Record<string, string>),
      CRM_API_BASE_URL: process.env.CRM_API_BASE_URL!,
      CRM_API_TOKEN: process.env.CRM_API_TOKEN!,
      DEFAULT_ORGANIZATION_ID: process.env.DEFAULT_ORGANIZATION_ID!,
      DEFAULT_USER_ID: process.env.DEFAULT_USER_ID!,
    },
  });

  // 2. Conecta o cliente MCP.
  const mcpClient = new Client({
    name: 'my-crm-agent',
    version: '1.0.0',
  });
  await mcpClient.connect(transport);

  // 3. Descobre tools disponíveis.
  const { tools } = await mcpClient.listTools();
  console.log(`Loaded ${tools.length} MCP tools`);

  // 4. Converte schema MCP → schema Anthropic Tool.
  const anthropicTools = tools.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    input_schema: (t.inputSchema as Anthropic.Messages.Tool.InputSchema) ?? {
      type: 'object' as const,
      properties: {},
    },
  }));

  // 5. Lê o resource crm://schema pra dar contexto inicial.
  const schemaRes = await mcpClient.readResource({ uri: 'crm://schema' });
  const schemaText = schemaRes.contents
    .map((c) => ('text' in c ? c.text : ''))
    .join('\n');

  // 6. Anthropic SDK
  const anthropic = new Anthropic();
  const userPrompt = process.argv.slice(2).join(' ') || 'Liste os leads parados há 7 dias';

  const messages: Anthropic.Messages.MessageParam[] = [
    {
      role: 'user',
      content: `Context (CRM schema):\n\`\`\`json\n${schemaText}\n\`\`\`\n\nUser: ${userPrompt}`,
    },
  ];

  // 7. Loop tool-use até a IA terminar.
  let iter = 0;
  while (iter++ < 10) {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 4096,
      tools: anthropicTools,
      messages,
    });

    if (response.stop_reason === 'end_turn') {
      const textBlocks = response.content.filter((b) => b.type === 'text');
      console.log('\n=== Final answer ===\n');
      for (const b of textBlocks) console.log(b.type === 'text' ? b.text : '');
      break;
    }

    if (response.stop_reason !== 'tool_use') {
      console.error(`Unexpected stop_reason: ${response.stop_reason}`);
      break;
    }

    // Adiciona resposta da IA ao histórico
    messages.push({ role: 'assistant', content: response.content });

    // Executa cada tool_use
    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      console.log(`→ tool_call: ${block.name}`);
      const result = await mcpClient.callTool({
        name: block.name,
        arguments: block.input as Record<string, unknown>,
      });
      const text = (result.content ?? [])
        .map((c) => ('text' in c ? c.text : JSON.stringify(c)))
        .join('\n');
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: text,
        is_error: result.isError ?? false,
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  await mcpClient.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

Rodar:

```bash
npx tsx scripts/agent-with-mcp.ts "Promove o lead da Maria pra Negociação"
```

🎯 **Decisão:** este pattern é poderoso pra:
- Bots Slack/Discord que operam o CRM via comandos `/crm`
- N8N/Make customizados sem usar nó pronto
- Background jobs que processam inbox automaticamente

---

## 6. Deploy HTTP remoto

Pra distribuir pro cliente final sem ele instalar Node, suba o servidor HTTP e dê uma URL.

### 6.1. Onde hospedar

| Opção | Custo | Setup | Quando |
|-------|-------|-------|--------|
| **Railway** | ~$5-20/mês | 5 min | MVP, beta |
| **Fly.io** | ~$3-15/mês | 10 min | Multi-região |
| **DigitalOcean App Platform** | ~$12/mês | 10 min | Time conhece DO |
| **Hetzner / OCI VPS** | ~$5-10/mês | 30 min (Nginx + Let's Encrypt) | Escala / preço/perf |
| **AWS ECS Fargate** | depends | 1-2 dias | Empresa grande |

🎯 **Recomendação default:** Railway pra MVP. Quando o produto crescer (>500 leads ativos por cliente, >10 clientes), migra pra VPS gerenciada.

### 6.2. Dockerfile (recomendado pra qualquer deploy)

📦 **`Dockerfile` na raiz do `crm-mcp/`:**

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
COPY src ./src
RUN npm ci --include=dev
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/build ./build
EXPOSE 3333
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3333/healthz || exit 1
CMD ["node", "build/index-http.js"]
```

### 6.3. Railway

```bash
# CLI
npm i -g @railway/cli
railway login
railway init
railway up

# Variáveis
railway variables set CRM_API_BASE_URL="https://api.seucrm.com" \
  PORT="3333" \
  HOST="0.0.0.0" \
  ALLOWED_HOSTS="crm-mcp.up.railway.app" \
  ALLOWED_ORIGINS="*" \
  LOG_LEVEL="info"

# Domínio custom (opcional)
railway domain
```

Endpoint pronto: `https://crm-mcp.up.railway.app/mcp`.

### 6.4. Nginx + Let's Encrypt (VPS)

📦 **`/etc/nginx/sites-available/mcp.seucrm.com`:**

```nginx
server {
    listen 443 ssl http2;
    server_name mcp.seucrm.com;

    ssl_certificate     /etc/letsencrypt/live/mcp.seucrm.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mcp.seucrm.com/privkey.pem;

    # Header importante: Anthropic clients enviam User-Agent grande
    large_client_header_buffers 4 16k;

    # Timeout maior pra streams SSE
    proxy_read_timeout    3600s;
    proxy_send_timeout    3600s;
    proxy_connect_timeout 60s;
    keepalive_timeout     3600s;
    chunked_transfer_encoding on;

    # Não buffera SSE
    proxy_buffering off;
    proxy_cache off;
    proxy_set_header Connection '';
    proxy_http_version 1.1;

    location /mcp {
        proxy_pass         http://127.0.0.1:3333;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_set_header   Authorization $http_authorization;
        proxy_set_header   Mcp-Session-Id $http_mcp_session_id;
        proxy_set_header   MCP-Protocol-Version $http_mcp_protocol_version;
    }

    location /healthz {
        proxy_pass http://127.0.0.1:3333/healthz;
        access_log off;
    }
}

server {
    listen 80;
    server_name mcp.seucrm.com;
    return 301 https://$host$request_uri;
}
```

⚠️ **Gotcha (SSE + buffering):** `proxy_buffering off` é **obrigatório** pro Streamable HTTP transport conseguir push em tempo real. Sem isso, notificações server→client ficam emperradas até a buffer encher.

### 6.5. Conexão remota no Claude Desktop

📦 **`claude_desktop_config.json` (modo HTTP):**

```json
{
  "mcpServers": {
    "crm": {
      "type": "http",
      "url": "https://mcp.seucrm.com/mcp",
      "headers": {
        "Authorization": "Bearer tok_user_seu_token_aqui"
      }
    }
  }
}
```

⚠️ **Gotcha (versões antigas):** algumas versões do Claude Desktop ainda usavam `command: "npx"` + script wrapper pra chamar URL HTTP. Versões >= 0.7 suportam `"type": "http"` nativamente. Se sua versão é antiga, atualize.

---

## 7. Multi-tenant em deploy remoto

Cada cliente tem seu próprio token. O servidor MCP descobre `organization_id` a partir do token.

### 7.1. Endpoint `/api/me` na sua REST API (Parte 2)

📦 **No projeto da Parte 2, em `src/app/api/me/route.ts`:**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  const token = auth.slice('Bearer '.length).trim();

  const supa = getSupabaseServerClient();
  const { data, error } = await supa
    .from('api_tokens')
    .select('user_id, organization_id, scopes, revoked_at')
    .eq('token_hash', sha256(token))
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

function sha256(s: string) {
  return require('crypto').createHash('sha256').update(s).digest('hex');
}

export const dynamic = 'force-dynamic';
```

### 7.2. Geração de token pelo usuário

UI da Parte 1: tela `/settings/integrations/mcp` onde o usuário clica "Gerar token MCP" → backend cria token plaintext, salva apenas o `sha256` no DB, retorna **uma vez** pro usuário copiar.

📦 **Schema mínimo da tabela `api_tokens`:**

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

⚠️ **Gotcha:** **NUNCA** armazene o token plaintext. Sempre o hash. Token mostrado uma vez na geração.

---

## 8. Distribuição como pacote npm

Pra power users que querem `npx @suaempresa/crm-mcp` sem clonar repo:

### 8.1. Publicar

📦 **`package.json` ajustado:**

```json
{
  "name": "@suaempresa/crm-mcp",
  "version": "0.1.0",
  "description": "MCP server for the universal CRM core",
  "type": "module",
  "bin": {
    "crm-mcp": "./build/index.js",
    "crm-mcp-http": "./build/index-http.js"
  },
  "files": ["build", "README.md", "LICENSE"],
  "publishConfig": { "access": "public" }
}
```

```bash
npm login
npm run build
npm publish --access public
```

### 8.2. Cliente usa via npx

📦 **`claude_desktop_config.json`:**

```json
{
  "mcpServers": {
    "crm": {
      "command": "npx",
      "args": ["-y", "@suaempresa/crm-mcp"],
      "env": {
        "CRM_API_BASE_URL": "https://api.seucrm.com",
        "CRM_API_TOKEN": "tok_xxx",
        "DEFAULT_ORGANIZATION_ID": "...",
        "DEFAULT_USER_ID": "..."
      }
    }
  }
}
```

⚠️ **Gotcha (`-y`):** sem o `-y`, `npx` abre prompt interativo perguntando se pode baixar. Como o cliente IA spawneia sem TTY, o `npx` trava. Sempre `-y`.

🎯 **Decisão (versionamento):** mantenha `0.x.y` enquanto o set de tools muda. Quando estável, vá pra `1.0.0` — partir daí, **breaking change na tool é major bump**.

---

## 9. Observabilidade

Sem isso, você não sabe se o cliente tá usando ou se tá quebrado.

### 9.1. Logs estruturados (já feito no Doc 13)

Cada chamada de tool gera linha JSON em stderr:

```json
{"ts":"2026-04-28T15:42:11.882Z","level":"info","msg":"tool_create_lead_ok","lead_id":"e3b...","title":"João Silva — Plano Premium"}
```

Em produção, capture stderr → Loki / Datadog / CloudWatch / Axiom.

### 9.2. Métricas — endpoint `/metrics` (opcional)

📦 **`src/index-http.ts` (adicionar antes do `app.listen`):**

```typescript
const metrics = {
  total_calls: 0,
  by_tool: new Map<string, number>(),
  errors: 0,
  active_sessions: 0,
};

app.get('/metrics', (_req, res) => {
  res.json({
    ...metrics,
    by_tool: Object.fromEntries(metrics.by_tool),
    active_sessions: sessions.size,
  });
});

// Em cada handler de tool, incremente metrics.by_tool.set(name, (count ?? 0) + 1)
```

Em produção, prefira **OpenTelemetry**: `@opentelemetry/sdk-node` exportando OTLP pra Honeycomb / SigNoz / Grafana Tempo.

### 9.3. Audit log de mutações

Toda chamada de write tool deve gerar uma linha no DB (`crm_lead_activities` já registra automaticamente quando você faz CRUD pelo CRM — se o MCP server bate na REST API, herda automatic). Em adição, registre **quem chamou via MCP**:

📦 **Em cada write tool, adicione:**

```typescript
metadata: { source: 'mcp', mcp_session_id: ... }
```

Assim `crm_lead_activities` vira **audit log da IA**.

---

## 10. Segurança em produção

### 10.1. Validação de input (já está com Zod)

✅ Coberto. Schema Zod em cada tool rejeita input malformado antes de chegar no DB.

### 10.2. Prevenção de prompt injection nas descrições

🎯 **Princípio:** descrições de tools são lidas pelo LLM, então **não as escreva como output do banco**. Hardcode-as no código. Nunca:

```typescript
// ❌ ERRADO
description: await db.getDescription(toolName)
```

```typescript
// ✅ CERTO
description: 'Move a lead to a different stage. Both must exist.'
```

Se você precisa de descrições por organização (pra adaptar vocabulário), faça isso via `crm://schema` resource — que é dado, não código de comportamento.

### 10.3. Scoping por user_id

Tudo que o token consegue ver, a IA consegue. Não exponha token de admin pra usuário comum. Cada usuário gera seu próprio token, com escopo limitado às orgs/recursos dele. RLS no banco garante isolamento real.

### 10.4. Rate limit

📦 **Adicione no `src/index-http.ts` antes do `app.post('/mcp')`:**

```typescript
import rateLimit from 'express-rate-limit';

const mcpLimiter = rateLimit({
  windowMs: 60_000,
  max: 120, // 120 reqs/min por IP
  message: 'Too many requests',
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/mcp', mcpLimiter);
```

Instale: `npm i express-rate-limit`.

⚠️ **Gotcha:** rate limit por IP é incompleto pra multi-tenant. Idealmente, limite por `user_id` resolvido do token. Use `keyGenerator` custom:

```typescript
const mcpLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  keyGenerator: (req) => {
    const auth = req.headers.authorization;
    return auth ?? req.ip;
  },
});
```

### 10.5. CORS bem-comportado

Já no Doc 13. Pra produção real, NÃO use `*` — liste origins:

```typescript
ALLOWED_ORIGINS="https://claude.ai,https://app.cursor.com"
```

### 10.6. DNS rebinding protection

Já habilitado. **Sempre verifique `allowedHosts`** corresponde ao domínio público real.

### 10.7. Confirmação humana via Claude Desktop

O Claude Desktop, por padrão, pede confirmação humana antes de chamar tools "destructive" (definição: tools que mudam estado). Você reforça isso em duas camadas:

1. Servidor: marcando tools como `destructive` (não fazemos isso explicitamente — confiamos no `confirm: true` do `delete_lead` e `bulk_update_leads`).
2. Cliente: usuário aprova ou bloqueia tool-by-tool no Claude Desktop.

---

## 11. SSE vs Streamable HTTP — qual usar

| Critério | SSE (legacy) | Streamable HTTP (current) |
|----------|--------------|--------------------------|
| Endpoints | `GET /sse` + `POST /messages` | `POST /mcp`, `GET /mcp`, `DELETE /mcp` |
| Sessões | Manual | Built-in via `Mcp-Session-Id` |
| Resumability | Não | Sim (com `eventStore`) |
| Suporte oficial | Mantido por backwards compat | Recomendado |

🎯 **Decisão:** sempre **Streamable HTTP**. SSE só se tem cliente legado preso.

---

## 12. Checklist completo de Definition of Done

### MVP local (single-user)
- [ ] `npm run dev:stdio` roda sem crash
- [ ] Claude Desktop lista o server e as 19 tools
- [ ] Você consegue criar lead via prompt natural ("cria um lead pro João, R$ 2.500")
- [ ] Você consegue mover lead, ganhar/perder
- [ ] `crm://schema` aparece em "Resources"
- [ ] Prompt `analyze_stuck_leads` aparece e funciona

### Beta (Anthropic SDK direto)
- [ ] `scripts/agent-with-mcp.ts` roda end-to-end com 3 prompts diferentes
- [ ] Tool errors voltam estruturados pra IA reagir
- [ ] Logs em stderr capturáveis

### Produção (HTTP remoto)
- [ ] `Dockerfile` constrói imagem
- [ ] Deploy em Railway/Fly/VPS funciona
- [ ] Endpoint `/healthz` retorna 200
- [ ] Endpoint `/mcp` aceita POST `initialize` autenticado
- [ ] DNS rebinding protection ativa
- [ ] Rate limit ativo
- [ ] CORS configurado pro Claude/Cursor
- [ ] TLS via Let's Encrypt ou cloud-managed
- [ ] Logs estruturados indo pra observabilidade
- [ ] Geração de token MCP na UI da Parte 1
- [ ] Documentação no help center: como o cliente conecta

### Distribuição npm
- [ ] `npm publish` foi feito ao menos uma vez
- [ ] `npx @suaempresa/crm-mcp` funciona em máquina limpa
- [ ] README do pacote ensina uso

---

## 13. Erros comuns no go-live

| Sintoma | Causa | Fix |
|---------|-------|-----|
| Claude Desktop diz "MCP timeout" no init | Servidor demorando >30s pra responder initialize | Otimize boot. Pré-warm conexão DB. |
| Tool funciona em curl mas não em Claude | Schema Zod tem campo `default` que LLM não envia + REST API exige | Marque como `.optional().default(...)` em ambas as camadas |
| 401 só em Claude, ok em curl | Claude Desktop strip headers customizados | Use `Authorization` (padrão) — não `X-Api-Key` |
| Sessões somem após N min | Servidor reiniciou (deploy / OOM / CI) | Cliente reconecta automaticamente; estado fica no DB |
| Resource `crm://schema` retorna {} | `getSchema()` não implementado na REST API | Implemente o endpoint da Parte 2 (`GET /api/meta/schema`) |
| Tool list cresce e LLM começa a alucinar | >25 tools, LLM perde track | Quebre em servers separados (ex: `crm-read`, `crm-write`) |

---

## 14. Próximos passos

Você terminou as 3 partes do CRM Core (UI/Arquitetura, REST API, MCP Server). Caminhos naturais:

1. **Conectar o MCP a outras integrações.** Combine com o MCP do WAHA (se você expôs WhatsApp como MCP server também), Google Calendar MCP, Gmail MCP. Resultado: agente que conversa com cliente, agenda reunião, cria lead, tudo numa thread.
2. **Voice agent.** Conecte Vapi/ElevenLabs ao mesmo MCP server — agora seu CRM operável por voz.
3. **Background agents.** Crons que abrem sessão MCP, leem leads parados, enviam template de reativação. Sem você programar lógica — só o cron + prompt.
4. **Marketplace de tools custom.** Cliente cria tools dele em cima da sua REST API; você expõe via subdomain `mcp.{org-slug}.seucrm.com`.

---

## Próximo: explore os arquivos `reference/mcp-server.ts`, `reference/mcp-config-claude-desktop.json` e `prompts/prompt-08-mcp-server-implementation.md` pra material de copy-paste.
