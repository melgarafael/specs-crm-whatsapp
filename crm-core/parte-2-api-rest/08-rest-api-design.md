# 08 — Design da API REST do CRM

> **Resumo:** os princípios e decisões canônicas da API REST que vai expor o CRM. Estabelece formato de resposta, paginação cursor, idempotência, autenticação e versionamento. Tudo aqui é universal — serve clínica, imobiliária, advocacia, infoproduto. Você sai com o mapa de endpoints e o contrato pronto para construir.

---

## 1. Por que REST (e não GraphQL ou RPC)

Antes de escrever endpoint, precisamos defender o estilo. CRMs nichados raramente justificam GraphQL — o cliente típico (frontend próprio + integrações via Zapier, n8n, Make) prefere endpoints HTTP previsíveis.

| Aspecto | REST | GraphQL | RPC |
|---------|------|---------|-----|
| Cache HTTP | Nativo (URL + verb) | Difícil (POST sempre) | Difícil |
| Documentação | OpenAPI maduro | Schema próprio | Custom |
| Curva integradores | Rasa | Íngreme | Média |
| Tooling pronto | Postman, Insomnia, curl | GraphiQL | Específico |
| Erros HTTP | Naturais | Forçados em payload | Custom |
| Webhooks combinam | Sim | Sim | Sim |

🎯 **Decisão:** REST + JSON. GraphQL fica como possibilidade futura para operadores que precisarem de consultas hiper-customizadas — mas o core é REST.

⚠️ **Gotcha:** evite o anti-padrão "REST que é RPC disfarçado" (`POST /api/doStuff`). Se a operação não cabe em GET/POST/PATCH/DELETE de um recurso, pense duas vezes antes de criar `/leads/:id/move` — mas, quando a operação é genuína (transição de estado com efeitos colaterais), o endpoint dedicado é honesto.

---

## 2. Os 5 princípios da API CRM

### 2.1. Recurso primeiro, ação depois

Toda URL aponta pra um recurso. O verbo HTTP define a ação:

```
GET    /api/v1/leads          → lista leads
GET    /api/v1/leads/{id}     → lê 1 lead
POST   /api/v1/leads          → cria 1 lead
PATCH  /api/v1/leads/{id}     → atualiza parcial
DELETE /api/v1/leads/{id}     → deleta (soft)
```

Operações dedicadas (que não caem nos verbos) ficam aninhadas como sub-recurso ou ação:

```
POST /api/v1/leads/{id}/move           → muda de stage
POST /api/v1/leads/{id}/activities     → registra atividade
POST /api/v1/leads/bulk                → cria em lote
```

### 2.2. Sempre versionado

Toda URL começa com `/api/v1/`. Quando precisar quebrar contrato (mudar shape de response, remover campo, mudar semântica), você sobe pra `v2` e mantém v1 alimentado por adaptador.

🎯 **Decisão:** versionamento por path, não por header. Header é elegante mas péssimo pra debugar (você não vê a versão na URL do log).

### 2.3. Resposta padronizada

Toda resposta de sucesso:

```json
{
  "data": { /* objeto ou array */ },
  "meta": { /* opcional: paginação, total, etc. */ }
}
```

Toda resposta de erro:

```json
{
  "error": {
    "code": "lead_not_found",
    "message": "O lead solicitado não existe ou você não tem acesso.",
    "details": [ /* opcional: array de issues do Zod, etc. */ ]
  }
}
```

Por quê esse wrapper? Porque o cliente nunca precisa decidir se o body é objeto/array/erro — sempre é `{ data }` ou `{ error }`.

### 2.4. Idempotência via header

POST com `Idempotency-Key: <uuid-do-cliente>` jamais duplica. Se o cliente mandar a mesma chave duas vezes, a segunda chamada retorna o mesmo response da primeira. Crítico pra:

- Botão "Criar lead" clicado 2x rápido
- Retry de webhook por timeout
- Importação em lote que falha no meio

### 2.5. Filtros expressivos

Listar leads precisa cobrir 90% dos casos sem o cliente ter que baixar tudo e filtrar localmente:

```
GET /api/v1/leads?stage_id=xxx&owner=yyy&value_min=10000&search=acme&custom_field[plano]=premium&tag=enterprise&created_after=2026-01-01
```

Nunca page-based default. Sempre cursor.

---

## 3. Decisões canônicas (lei interna)

### 3.1. Base path e content type

| Decisão | Valor |
|---------|-------|
| Base path | `/api/v1/` |
| Content-Type request | `application/json` (exceto upload de mídia) |
| Content-Type response | `application/json; charset=utf-8` |
| Charset | UTF-8 sempre |

### 3.2. Status codes

| Code | Quando usar | Exemplo |
|------|-------------|---------|
| 200 OK | GET com sucesso, PATCH com retorno | `GET /leads/abc` |
| 201 Created | POST que criou | `POST /leads` |
| 204 No Content | DELETE com sucesso, PATCH sem retorno | `DELETE /leads/abc` |
| 400 Bad Request | JSON malformado, body não parseable | body vazio em POST |
| 401 Unauthorized | Sem auth ou auth inválida | cookie expirado |
| 403 Forbidden | Auth ok mas sem permissão | viewer tentando deletar |
| 404 Not Found | Recurso não existe (ou tenant não tem acesso) | id de outro org |
| 409 Conflict | Estado inválido pra ação | mover lead pra stage de outro pipeline |
| 422 Unprocessable Entity | Validação Zod falhou | `value_cents = -1` |
| 429 Too Many Requests | Rate limit excedido | 100 req/min ultrapassado |
| 500 Internal | Bug no servidor | exception não tratada |

⚠️ **Gotcha:** muita gente usa 400 pra tudo. Diferenciar 400 (não conseguiu nem parsear) de 422 (parseou mas a validação falhou) ajuda muito o cliente a debugar.

### 3.3. Paginação: cursor por default

🎯 **Decisão:** cursor opaco em base64, contendo `(created_at, id)` ou `(position_in_stage, id)` dependendo do ordering.

Por quê não offset?

| Aspecto | Cursor | Offset |
|---------|--------|--------|
| Performance em escala | Constante | Degrada O(n) |
| Inserções durante paginação | Estável | Pula/duplica linhas |
| Primeira página rápida | Sim | Sim |
| Total count | Opcional | Custa caro também |
| Pular pra "página 47" | Não | Sim (mas é raro) |

Resposta:

```json
{
  "data": [ /* leads */ ],
  "meta": {
    "cursor": "eyJjcmVhdGVkX2F0IjoiMjAyNi0wNC0yOFQxNDozMDowMFoiLCJpZCI6IjEyMyJ9",
    "has_more": true,
    "total": null
  }
}
```

Cliente pega `meta.cursor` e passa em `?cursor=...` na próxima request. Quando `has_more = false`, terminou.

⚠️ **Gotcha:** cursor sem assinatura HMAC é tamper-friendly. Detalhamos isso em [10-filtros-busca-paginacao.md](10-filtros-busca-paginacao.md).

### 3.4. Modelo de auth

Dois caminhos aceitos:

| Caminho | Quando | Como passar |
|---------|--------|-------------|
| Cookie session | Frontend chamando da mesma origin | `Cookie: sb-access-token=...` (Supabase SSR) |
| Bearer token | Server-to-server, integrações externas | `Authorization: Bearer tok_...` |

API tokens vivem em uma tabela:

```sql
create table api_tokens (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  token_hash text not null,         -- nunca o plaintext
  prefix text not null,             -- 8 primeiros chars pra identificar
  scopes text[] default '{leads:read,leads:write}',
  created_by_user_id uuid,
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz default now()
);

create index on api_tokens (token_hash);
create index on api_tokens (organization_id);
```

Plaintext é mostrado UMA vez no momento da criação. Depois só hash.

🎯 **Decisão:** cookies pra frontend (CSRF protege via SameSite=Strict), bearer pra integrações. Não suportar query string `?api_key=...` — vaza em logs.

### 3.5. Idempotência

Header obrigatório em POST de criação:

```
Idempotency-Key: 9c5b0a3a-2f8e-4f2f-bf76-0b3c5a1e8d44
```

Tabela:

```sql
create table idempotency_keys (
  key text primary key,
  user_id uuid not null,
  organization_id uuid not null,
  request_hash text not null,                -- sha256 do body normalizado
  response_status int not null,
  response_body jsonb not null,
  created_at timestamptz default now() not null,
  expires_at timestamptz default (now() + interval '24 hours') not null
);

create index on idempotency_keys (organization_id, created_at);
```

Comportamento:

1. Cliente manda POST com `Idempotency-Key`
2. Servidor checa se existe
3. Se existe + mesmo body hash → devolve response salvo
4. Se existe + body diferente → 409 Conflict
5. Se não existe → processa, salva resultado, devolve

TTL: 24h. Cron limpa expirados.

⚠️ **Gotcha:** PATCH e DELETE são naturalmente idempotentes (PATCH com mesmo body produz mesmo estado, DELETE só remove uma vez). O header só importa pra POST.

---

## 4. Mapa de recursos

A tabela abaixo é o mapa completo. Cada recurso é detalhado em arquivos seguintes.

### 4.1. Pipelines

| Método | Path | Descrição |
|--------|------|-----------|
| GET | `/api/v1/pipelines` | Lista pipelines da org |
| GET | `/api/v1/pipelines/{id}` | Lê 1 pipeline (com stages embutidos) |
| POST | `/api/v1/pipelines` | Cria pipeline |
| PATCH | `/api/v1/pipelines/{id}` | Atualiza |
| DELETE | `/api/v1/pipelines/{id}` | Soft delete (marca `archived_at`) |
| POST | `/api/v1/pipelines/{id}/duplicate` | Duplica pipeline + stages |

### 4.2. Stages

| Método | Path | Descrição |
|--------|------|-----------|
| GET | `/api/v1/pipelines/{pid}/stages` | Lista stages do pipeline |
| POST | `/api/v1/pipelines/{pid}/stages` | Cria stage |
| PATCH | `/api/v1/stages/{id}` | Atualiza (nome, cor, win_probability, wip_limit) |
| DELETE | `/api/v1/stages/{id}` | Deleta (409 se tem leads) |
| POST | `/api/v1/pipelines/{pid}/stages/reorder` | Reordena (body: array de ids na ordem) |

### 4.3. Leads (recurso central)

| Método | Path | Descrição |
|--------|------|-----------|
| GET | `/api/v1/leads` | Lista (filtros + cursor) |
| GET | `/api/v1/leads/{id}` | Lê 1 |
| POST | `/api/v1/leads` | Cria (idempotente) |
| PATCH | `/api/v1/leads/{id}` | Atualiza parcial |
| DELETE | `/api/v1/leads/{id}` | Soft delete |
| POST | `/api/v1/leads/{id}/move` | Move pra stage (com validação) |
| POST | `/api/v1/leads/{id}/win` | Marca won |
| POST | `/api/v1/leads/{id}/lose` | Marca lost (body: lost_reason) |
| POST | `/api/v1/leads/bulk` | Cria N leads (max 100) |

### 4.4. Activities

| Método | Path | Descrição |
|--------|------|-----------|
| GET | `/api/v1/leads/{id}/activities` | Lista atividades do lead |
| POST | `/api/v1/leads/{id}/activities` | Registra activity |
| GET | `/api/v1/activities/{id}` | Lê 1 |
| PATCH | `/api/v1/activities/{id}` | Edita (só do mesmo autor) |
| DELETE | `/api/v1/activities/{id}` | Deleta |

### 4.5. Lead Links (referência cruzada)

| Método | Path | Descrição |
|--------|------|-----------|
| GET | `/api/v1/leads/{id}/links` | Lista links externos |
| POST | `/api/v1/leads/{id}/links` | Linka a entidade externa (conversation, appointment, contract) |
| DELETE | `/api/v1/lead-links/{id}` | Remove link |

### 4.6. Auxiliares

| Método | Path | Descrição |
|--------|------|-----------|
| GET | `/api/v1/me` | Sessão atual (usuário + org + role) |
| GET | `/api/v1/contacts` | Lista contacts (proxy pro recurso já existente) |
| POST | `/api/v1/api-tokens` | Gera token de API |
| DELETE | `/api/v1/api-tokens/{id}` | Revoga token |
| GET | `/api/v1/webhooks` | Lista webhook subscriptions |
| POST | `/api/v1/webhooks` | Cria webhook subscription |

---

## 5. Estrutura de arquivos no Next.js

📦 **Layout esperado em `app/api/`:**

```
app/api/v1/
├── leads/
│   ├── route.ts                          # GET (list), POST (create)
│   ├── bulk/
│   │   └── route.ts                      # POST (bulk create)
│   └── [id]/
│       ├── route.ts                      # GET, PATCH, DELETE
│       ├── move/route.ts                 # POST
│       ├── win/route.ts                  # POST
│       ├── lose/route.ts                 # POST
│       ├── activities/route.ts           # GET, POST
│       └── links/route.ts                # GET, POST
├── pipelines/
│   ├── route.ts
│   ├── [id]/
│   │   ├── route.ts
│   │   ├── duplicate/route.ts
│   │   └── stages/
│   │       ├── route.ts                  # GET (list of stages), POST
│   │       └── reorder/route.ts
├── stages/
│   └── [id]/route.ts                     # PATCH, DELETE (atalho)
├── activities/
│   └── [id]/route.ts                     # GET, PATCH, DELETE
├── lead-links/
│   └── [id]/route.ts                     # DELETE
├── api-tokens/
│   ├── route.ts
│   └── [id]/route.ts
├── webhooks/
│   ├── route.ts
│   └── [id]/route.ts
├── me/route.ts
└── contacts/route.ts
```

⚠️ **Gotcha:** Route Handlers que mexem em DB precisam de `export const dynamic = 'force-dynamic'`. Senão o Next.js cacheia em build e você atende request com dado velho.

---

## 6. Stack do request: pipeline conceitual

Toda chamada passa por essa sequência (implementada como helpers):

```
┌──────────────────────────────────────────────┐
│ 1. Parse body (JSON)                         │
│    └─ erro? 400                              │
├──────────────────────────────────────────────┤
│ 2. Auth (cookie OU bearer)                   │
│    └─ ausente? 401                           │
│    └─ resolve user + organization_id         │
├──────────────────────────────────────────────┤
│ 3. RBAC (verifica role)                      │
│    └─ insuficiente? 403                      │
├──────────────────────────────────────────────┤
│ 4. Rate limit (sliding window)               │
│    └─ excedido? 429                          │
├──────────────────────────────────────────────┤
│ 5. Idempotency (se POST com header)          │
│    └─ já visto? retorna response salvo       │
├──────────────────────────────────────────────┤
│ 6. Validação Zod                             │
│    └─ falhou? 422 com array de issues        │
├──────────────────────────────────────────────┤
│ 7. Lógica de negócio                         │
│    └─ bater no Postgres com RLS aplicada     │
├──────────────────────────────────────────────┤
│ 8. Audit log (async fire-and-forget)         │
├──────────────────────────────────────────────┤
│ 9. Webhook outbound (async)                  │
├──────────────────────────────────────────────┤
│ 10. Response (sucesso ou erro)               │
│     └─ salva em idempotency_keys se POST     │
└──────────────────────────────────────────────┘
```

Implementação detalhada de cada camada nos próximos arquivos.

---

## 7. Helpers compartilhados (referenciados nos próximos docs)

📦 **`lib/api/response.ts`** — formato canônico:

```typescript
import { NextResponse } from 'next/server';

export type ApiSuccess<T> = {
  data: T;
  meta?: { cursor?: string | null; has_more?: boolean; total?: number | null };
};

export type ApiError = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export function ok<T>(data: T, meta?: ApiSuccess<T>['meta'], status = 200) {
  return NextResponse.json<ApiSuccess<T>>({ data, ...(meta ? { meta } : {}) }, { status });
}

export function created<T>(data: T) {
  return ok(data, undefined, 201);
}

export function noContent() {
  return new NextResponse(null, { status: 204 });
}

export function fail(code: string, message: string, status: number, details?: unknown) {
  return NextResponse.json<ApiError>(
    { error: { code, message, ...(details !== undefined ? { details } : {}) } },
    { status },
  );
}

// Atalhos
export const badRequest = (msg = 'Requisição inválida.', details?: unknown) =>
  fail('bad_request', msg, 400, details);
export const unauthorized = (msg = 'Não autenticado.') => fail('unauthorized', msg, 401);
export const forbidden = (msg = 'Permissão insuficiente.') => fail('forbidden', msg, 403);
export const notFound = (msg = 'Recurso não encontrado.') => fail('not_found', msg, 404);
export const conflict = (msg = 'Estado conflitante.', details?: unknown) =>
  fail('conflict', msg, 409, details);
export const unprocessable = (msg = 'Validação falhou.', details?: unknown) =>
  fail('unprocessable', msg, 422, details);
export const tooMany = (msg = 'Rate limit excedido.', retryAfterSec?: number) => {
  const res = fail('rate_limited', msg, 429);
  if (retryAfterSec) res.headers.set('Retry-After', String(retryAfterSec));
  return res;
};
export const serverError = (msg = 'Erro interno.', details?: unknown) =>
  fail('internal', msg, 500, details);
```

📦 **`lib/api/auth.ts`** — resolve sessão e org:

```typescript
import { NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import crypto from 'crypto';

export interface ApiSession {
  userId: string;
  organizationId: string;
  role: 'admin' | 'manager' | 'agent' | 'viewer';
  authMethod: 'cookie' | 'bearer';
  scopes?: string[];
}

export async function authenticate(req: NextRequest): Promise<ApiSession | null> {
  // 1. Tenta bearer token
  const auth = req.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) {
    const plaintext = auth.slice(7).trim();
    return resolveBearer(plaintext);
  }

  // 2. Tenta cookie session
  return resolveCookie();
}

async function resolveCookie(): Promise<ApiSession | null> {
  const cookieStore = cookies();
  const supa = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get: (name) => cookieStore.get(name)?.value,
        set: () => {},
        remove: () => {},
      },
    },
  );
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return null;

  const { data: membership } = await supa
    .from('user_organizations')
    .select('organization_id, role')
    .eq('user_id', user.id)
    .single();

  if (!membership) return null;

  return {
    userId: user.id,
    organizationId: membership.organization_id,
    role: membership.role,
    authMethod: 'cookie',
  };
}

async function resolveBearer(plaintext: string): Promise<ApiSession | null> {
  const { getSupabaseAdminClient } = await import('@/lib/supabase/admin');
  const supa = getSupabaseAdminClient();
  const tokenHash = crypto.createHash('sha256').update(plaintext).digest('hex');

  const { data: token } = await supa
    .from('api_tokens')
    .select('id, organization_id, scopes, expires_at, revoked_at, created_by_user_id')
    .eq('token_hash', tokenHash)
    .single();

  if (!token) return null;
  if (token.revoked_at) return null;
  if (token.expires_at && new Date(token.expires_at) < new Date()) return null;

  // Atualiza last_used_at fire-and-forget
  supa.from('api_tokens').update({ last_used_at: new Date().toISOString() })
    .eq('id', token.id).then(() => {});

  return {
    userId: token.created_by_user_id,
    organizationId: token.organization_id,
    role: 'admin', // tokens são treated as their creator's role; em produção, herde da membership
    authMethod: 'bearer',
    scopes: token.scopes ?? [],
  };
}

export function requireRole(session: ApiSession, allowed: ApiSession['role'][]): boolean {
  return allowed.includes(session.role);
}

export function requireScope(session: ApiSession, scope: string): boolean {
  if (session.authMethod === 'cookie') return true; // cookie session = full access da role
  return session.scopes?.includes(scope) ?? false;
}
```

⚠️ **Gotcha:** o exemplo acima assume que `user_organizations` tem 1 row por user (user pertence a 1 org). Se sua arquitetura permite múltiplas orgs por user, você precisa de um `X-Organization-Id` header pra desambiguar.

---

## 8. Convenção de nomes

| Coisa | Convenção | Exemplo |
|-------|-----------|---------|
| Path | kebab-case plural | `/api/v1/lead-links` |
| Query string | snake_case | `?value_min=1000&created_after=...` |
| JSON keys | snake_case | `value_cents`, `owner_user_id` |
| Headers | Title-Case-Hyphen | `Idempotency-Key`, `X-RateLimit-Remaining` |
| IDs | UUID v4 | `9c5b0a3a-2f8e-...` |
| Datas | ISO 8601 UTC | `2026-04-28T14:30:00.000Z` |
| Dinheiro | `_cents` integer | `value_cents: 150000` (R$ 1500,00) |
| Currency | ISO 4217 | `currency: "BRL"` |

🎯 **Decisão:** snake_case em JSON (não camelCase). Polêmico, mas:
- Bate 1:1 com colunas Postgres (sem mapping)
- Quase todas as APIs B2B sérias (Stripe, Twilio, Mercado Pago) usam snake
- Frontend converte se quiser camelCase

---

## 9. Headers de resposta importantes

| Header | Quando | Valor |
|--------|--------|-------|
| `X-RateLimit-Limit` | Toda response | `60` |
| `X-RateLimit-Remaining` | Toda response | `42` |
| `X-RateLimit-Reset` | Toda response | unix timestamp |
| `Retry-After` | 429 | segundos |
| `X-Request-Id` | Toda response | UUID p/ correlacionar logs |
| `X-Idempotency-Replay` | POST que reusou key | `true` |

📦 **Helper:**

```typescript
export function withRequestId(res: Response, requestId: string) {
  res.headers.set('X-Request-Id', requestId);
  return res;
}
```

---

## 10. Erros padronizados (códigos)

Lista canônica de `error.code`. Cliente pode programar contra isso:

| Code | HTTP | Significado |
|------|------|-------------|
| `bad_request` | 400 | Body malformado |
| `unauthorized` | 401 | Sem auth ou auth inválida |
| `forbidden` | 403 | Sem permissão |
| `not_found` | 404 | Recurso não existe |
| `conflict` | 409 | Estado conflitante |
| `unprocessable` | 422 | Validação Zod |
| `rate_limited` | 429 | Excedeu rate limit |
| `internal` | 500 | Bug do servidor |
| `idempotency_conflict` | 409 | Mesma key, body diferente |
| `lead_not_found` | 404 | Lead específico |
| `stage_not_in_pipeline` | 409 | Tentou mover lead pra stage de outro pipeline |
| `wip_limit_exceeded` | 409 | Stage com WIP cheio |
| `bulk_limit_exceeded` | 422 | bulk com >100 items |
| `invalid_cursor` | 400 | Cursor adulterado |

---

## 11. Versionamento e deprecação

Quando precisar quebrar contrato:

1. Cria `/api/v2/...` ao lado de v1
2. Mantém v1 funcionando por mínimo 6 meses
3. Adiciona header `Sunset: Wed, 28 Oct 2026 00:00:00 GMT` em todas as responses v1
4. Adiciona `Deprecation: true` 
5. Posta no changelog

⚠️ **Gotcha:** se você nunca quebrar contrato, nunca precisa de v2. Adicionar campo é não-breaking. Tirar campo é breaking. Renomear é breaking. Mudar tipo é breaking. Mudar default behavior é breaking.

---

## 12. Conferência rápida desta fase

- [ ] Decidiu por REST + JSON
- [ ] Versionamento via path `/api/v1/`
- [ ] Resposta padronizada `{ data, meta }` ou `{ error }`
- [ ] Cursor pagination como default
- [ ] `Idempotency-Key` em POST de criação
- [ ] Auth dual: cookie + bearer
- [ ] RBAC: admin, manager, agent, viewer
- [ ] Status codes mapeados (200/201/204/400/401/403/404/409/422/429/500)
- [ ] Helpers `ok()`, `fail()`, `notFound()` etc. centralizam respostas
- [ ] Helper `authenticate()` resolve cookie ou bearer
- [ ] Mapa de recursos completo (pipelines, stages, leads, activities, links)

---

## Próximo: [09-endpoints-crud-leads.md](09-endpoints-crud-leads.md)
