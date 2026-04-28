# PROMPT 07 — REST API CRUD do CRM core (auth, rate limit, idempotência, webhooks, audit)

> **Cole após Fase 06 (UI do CRM core). Cria a camada REST completa em `app/api/v1/`. Self-contained: tudo o que a IA precisa saber está aqui.**

---

## Contexto

Você está implementando a **Fase 7 de 8**. A organização do projeto até aqui:

- Fase 01: scaffolding Next.js + Supabase
- Fase 02: cliente WAHA + sessões
- Fase 03: webhook handler + envio
- Fase 04: frontend chat
- Fase 05: binding CRM (de WhatsApp pra CRM)
- Fase 06: UI do core (kanban, leads, pipelines, stages)
- **Fase 07: REST API completa** ← você está aqui
- Fase 08: MCP server

Sua missão: expor o CRM como API REST production-grade. Outros sistemas (Zapier, n8n, scripts internos, mobile, IA externa) consumirão.

## Princípios não-negociáveis

1. **Toda request passa por auth.** Cookie session OU bearer token. Sem fallback público.
2. **Toda mutação passa por validação Zod.** Sem trust no body.
3. **Toda criação aceita `Idempotency-Key`.** Header opcional, mas, quando presente, NUNCA duplica.
4. **Paginação cursor-based.** Nada de offset default.
5. **Resposta padronizada:** `{ data, meta? }` em sucesso, `{ error: { code, message, details? } }` em erro.
6. **Soft delete**, nunca DELETE físico (campo `deleted_at`).
7. **Audit log fire-and-forget** em toda mutação.
8. **Webhooks de saída assinados HMAC-SHA256**, com retry exponencial e dead letter.
9. **Rate limit por user**, header `X-RateLimit-*` exposto.
10. **`force-dynamic` em TODA route handler que toca DB.**

## Stack

- Next.js 14+ App Router (Route Handlers em `app/api/`)
- TypeScript strict
- Zod
- Supabase (cookie auth via `@supabase/ssr` + service role pra admin)
- Upstash Redis (rate limit) — fallback in-memory pra dev

## Tasks

### 1. Migration: tabelas auxiliares

`supabase/migrations/<timestamp>_api_infra.sql`:

```sql
-- API tokens
CREATE TABLE IF NOT EXISTS public.api_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  prefix text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL DEFAULT '{leads:read}',
  created_by_user_id uuid NOT NULL,
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_tokens_org_idx ON public.api_tokens (organization_id);
CREATE INDEX api_tokens_hash_idx ON public.api_tokens (token_hash);

-- Idempotency keys
CREATE TABLE IF NOT EXISTS public.idempotency_keys (
  key text NOT NULL,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  request_hash text NOT NULL,
  response_status int NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  PRIMARY KEY (organization_id, key)
);
CREATE INDEX idempotency_keys_expires_idx ON public.idempotency_keys (expires_at);

-- Audit log
CREATE TABLE IF NOT EXISTS public.api_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  user_id uuid,
  api_token_id uuid,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid,
  ip_address text,
  user_agent text,
  request_id text,
  metadata jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_audit_log_org_created_idx
  ON public.api_audit_log (organization_id, created_at DESC);

-- Webhook subscriptions + deliveries
CREATE TABLE IF NOT EXISTS public.webhook_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  url text NOT NULL,
  events text[] NOT NULL,
  secret text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  description text,
  created_by_user_id uuid,
  last_delivery_at timestamptz,
  last_delivery_status int,
  consecutive_failures int NOT NULL DEFAULT 0,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES public.webhook_subscriptions(id) ON DELETE CASCADE,
  event text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivering', 'success', 'failed', 'dead')),
  attempt int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_error text,
  last_response_status int,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_pending_idx
  ON public.webhook_deliveries (next_attempt_at)
  WHERE status IN ('pending', 'delivering');

-- Soft delete em crm_leads
ALTER TABLE public.crm_leads
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS crm_leads_org_active_idx
  ON public.crm_leads (organization_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- Search vectors
ALTER TABLE public.crm_leads
  ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('portuguese',
      coalesce(title, '') || ' ' ||
      coalesce(source, '') || ' ' ||
      array_to_string(coalesce(tags, '{}'), ' ')
    )
  ) STORED;
CREATE INDEX IF NOT EXISTS crm_leads_search_idx
  ON public.crm_leads USING gin (search_vector);

CREATE INDEX IF NOT EXISTS crm_leads_tags_idx
  ON public.crm_leads USING gin (tags);
CREATE INDEX IF NOT EXISTS crm_leads_custom_fields_idx
  ON public.crm_leads USING gin (custom_fields);

-- User per-pipeline access (opcional)
CREATE TABLE IF NOT EXISTS public.user_pipeline_access (
  user_id uuid NOT NULL,
  pipeline_id uuid NOT NULL REFERENCES public.crm_pipelines(id) ON DELETE CASCADE,
  access text NOT NULL DEFAULT 'read' CHECK (access IN ('read', 'write')),
  PRIMARY KEY (user_id, pipeline_id)
);
```

### 2. Helpers compartilhados

`src/lib/api/response.ts`:

```typescript
import { NextResponse } from 'next/server';

export type ApiSuccess<T> = {
  data: T;
  meta?: { cursor?: string | null; has_more?: boolean; total?: number | null };
};

export type ApiError = {
  error: { code: string; message: string; details?: unknown };
};

export function ok<T>(data: T, meta?: ApiSuccess<T>['meta'], status = 200) {
  return NextResponse.json<ApiSuccess<T>>({ data, ...(meta ? { meta } : {}) }, { status });
}

export function created<T>(data: T) { return ok(data, undefined, 201); }
export function noContent() { return new NextResponse(null, { status: 204 }); }

export function fail(code: string, message: string, status: number, details?: unknown) {
  return NextResponse.json<ApiError>(
    { error: { code, message, ...(details !== undefined ? { details } : {}) } },
    { status },
  );
}

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

### 3. Auth helper

`src/lib/api/auth.ts`:

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
  apiTokenId?: string;
}

export async function authenticate(req: NextRequest): Promise<ApiSession | null> {
  const auth = req.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) return resolveBearer(auth.slice(7).trim());
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
  const { data: m } = await supa
    .from('user_organizations')
    .select('organization_id, role')
    .eq('user_id', user.id)
    .single();
  if (!m) return null;
  return { userId: user.id, organizationId: m.organization_id, role: m.role, authMethod: 'cookie' };
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
  if (!token || token.revoked_at) return null;
  if (token.expires_at && new Date(token.expires_at) < new Date()) return null;
  supa.from('api_tokens').update({ last_used_at: new Date().toISOString() })
    .eq('id', token.id).then(() => {});
  return {
    userId: token.created_by_user_id,
    organizationId: token.organization_id,
    role: 'admin',
    authMethod: 'bearer',
    scopes: token.scopes ?? [],
    apiTokenId: token.id,
  };
}

export function requireRole(s: ApiSession, allowed: ApiSession['role'][]): boolean {
  return allowed.includes(s.role);
}

export function requireScope(s: ApiSession, scope: string): boolean {
  if (s.authMethod === 'cookie') return true;
  return s.scopes?.includes(scope) ?? false;
}
```

### 4. Cursor

`src/lib/api/cursor.ts`:

```typescript
import crypto from 'crypto';
const SECRET = process.env.CURSOR_SECRET || 'dev-only-change-me';

export interface CursorPayload { ts: string; id: string; v: number; }

export function encodeCursor(p: CursorPayload): string {
  const body = Buffer.from(JSON.stringify(p)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url').slice(0, 16);
  return `${body}.${sig}`;
}

export function decodeCursor(c: string): CursorPayload | null {
  const [body, sig] = c.split('.');
  if (!body || !sig) return null;
  const exp = crypto.createHmac('sha256', SECRET).update(body).digest('base64url').slice(0, 16);
  if (sig !== exp) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
}
```

### 5. Rate limit

`src/lib/api/rate-limit.ts`:

```typescript
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { NextResponse } from 'next/server';

const redis = process.env.UPSTASH_REDIS_REST_URL
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    })
  : null;

const limiters = new Map<string, Ratelimit>();
function getLimiter(limit: number, win: number) {
  if (!redis) return null;
  const k = `${limit}:${win}`;
  if (!limiters.has(k)) {
    limiters.set(k, new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(limit, `${win} s`),
      analytics: true,
      prefix: 'crm-rl',
    }));
  }
  return limiters.get(k)!;
}

const memBuckets = new Map<string, number[]>();

export async function rateLimit(args: { key: string; limit: number; windowSec: number }) {
  let result: { success: boolean; remaining: number; reset: number };
  const limiter = getLimiter(args.limit, args.windowSec);
  if (limiter) {
    const r = await limiter.limit(args.key);
    result = { success: r.success, remaining: r.remaining, reset: Math.floor(r.reset / 1000) };
  } else {
    const now = Date.now();
    const bucket = (memBuckets.get(args.key) ?? []).filter(t => t > now - args.windowSec * 1000);
    if (bucket.length >= args.limit) {
      result = { success: false, remaining: 0, reset: Math.floor((bucket[0] + args.windowSec * 1000) / 1000) };
    } else {
      bucket.push(now);
      memBuckets.set(args.key, bucket);
      result = { success: true, remaining: args.limit - bucket.length, reset: Math.floor(now / 1000) + args.windowSec };
    }
  }
  if (!result.success) {
    const retry = Math.max(1, result.reset - Math.floor(Date.now() / 1000));
    const res = NextResponse.json({ error: { code: 'rate_limited', message: 'Rate limit excedido.' } }, { status: 429 });
    res.headers.set('Retry-After', String(retry));
    res.headers.set('X-RateLimit-Limit', String(args.limit));
    res.headers.set('X-RateLimit-Remaining', '0');
    res.headers.set('X-RateLimit-Reset', String(result.reset));
    return { ok: false as const, response: res };
  }
  return { ok: true as const, remaining: result.remaining, reset: result.reset };
}
```

### 6. Idempotency

`src/lib/api/idempotency.ts`:

```typescript
import crypto from 'crypto';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';

export class IdempotencyConflict extends Error { constructor() { super('conflict'); } }

export async function withIdempotency<T>(args: {
  key: string | null;
  userId: string;
  organizationId: string;
  rawBody: unknown;
  handler: () => Promise<{ status: number; body: T }>;
}) {
  if (!args.key) {
    const r = await args.handler();
    return { replay: false, ...r };
  }
  const supa = getSupabaseAdminClient();
  const reqHash = crypto.createHash('sha256').update(JSON.stringify(args.rawBody)).digest('hex');
  const { data: existing } = await supa.from('idempotency_keys')
    .select('request_hash, response_status, response_body')
    .eq('key', args.key).eq('organization_id', args.organizationId).maybeSingle();
  if (existing) {
    if (existing.request_hash !== reqHash) throw new IdempotencyConflict();
    return { replay: true, status: existing.response_status, body: existing.response_body as T };
  }
  const result = await args.handler();
  await supa.from('idempotency_keys').insert({
    key: args.key, user_id: args.userId, organization_id: args.organizationId,
    request_hash: reqHash, response_status: result.status, response_body: result.body as any,
  });
  return { replay: false, ...result };
}
```

### 7. Audit + webhooks

`src/lib/api/audit.ts`:

```typescript
import { getSupabaseAdminClient } from '@/lib/supabase/admin';

export function auditLog(entry: {
  organization_id: string; user_id?: string | null; api_token_id?: string | null;
  action: string; resource_type: string; resource_id: string | null;
  metadata?: Record<string, unknown>;
}) {
  getSupabaseAdminClient().from('api_audit_log').insert(entry).then(({ error }) => {
    if (error) console.error('[audit]', error);
  });
}
```

`src/lib/api/webhooks.ts`:

```typescript
import { getSupabaseAdminClient } from '@/lib/supabase/admin';

export async function publishWebhook(args: { organization_id: string; event: string; payload: any }) {
  const supa = getSupabaseAdminClient();
  const { data: subs } = await supa.from('webhook_subscriptions')
    .select('id, events').eq('organization_id', args.organization_id).eq('is_active', true);
  if (!subs?.length) return;
  const wanted = subs.filter(s => s.events.includes(args.event));
  if (!wanted.length) return;
  await supa.from('webhook_deliveries').insert(wanted.map(s => ({
    subscription_id: s.id, event: args.event, payload: args.payload,
    status: 'pending', next_attempt_at: new Date().toISOString(),
  })));
  fetch((process.env.NEXT_PUBLIC_APP_URL ?? '') + '/api/internal/webhook-tick', {
    method: 'POST',
    headers: { 'X-Internal-Secret': process.env.INTERNAL_SECRET ?? '' },
  }).catch(() => {});
}
```

### 8. Schemas Zod

`src/lib/api/schemas/leads.ts` — exatamente como descrito em [09-endpoints-crud-leads.md §1](../parte-2-api-rest/09-endpoints-crud-leads.md). Cole tal qual.

### 9. Endpoints

Implemente, na ordem:

1. `app/api/v1/me/route.ts` — devolve `{ user_id, organization_id, role, auth_method }`
2. `app/api/v1/leads/route.ts` — GET (listar) + POST (criar) — código completo em [09 §4-§5](../parte-2-api-rest/09-endpoints-crud-leads.md)
3. `app/api/v1/leads/[id]/route.ts` — GET, PATCH, DELETE — código completo em [09 §6-§8](../parte-2-api-rest/09-endpoints-crud-leads.md)
4. `app/api/v1/leads/[id]/move/route.ts` — POST — código completo em [09 §9](../parte-2-api-rest/09-endpoints-crud-leads.md)
5. `app/api/v1/leads/[id]/win/route.ts` e `lose/route.ts` — atalhos
6. `app/api/v1/leads/bulk/route.ts` — POST bulk
7. `app/api/v1/leads/[id]/activities/route.ts` — GET, POST
8. `app/api/v1/leads/[id]/links/route.ts` + `app/api/v1/lead-links/[id]/route.ts` — links
9. `app/api/v1/pipelines/route.ts` + `[id]/route.ts` — CRUD básico
10. `app/api/v1/pipelines/[pid]/stages/route.ts` + `app/api/v1/stages/[id]/route.ts` — stages CRUD
11. `app/api/v1/pipelines/[pid]/stages/reorder/route.ts` — POST com `{stage_ids: uuid[]}`
12. `app/api/v1/api-tokens/route.ts` + `[id]/route.ts` — admin only
13. `app/api/v1/webhooks/route.ts` + `[id]/route.ts` + `[id]/test/route.ts`
14. `app/api/v1/audit-log/route.ts` — admin only
15. `app/api/internal/webhook-tick/route.ts` — worker de delivery (assinatura HMAC, retry exponencial, dead letter)
16. `app/api/internal/idempotency-cleanup/route.ts` — limpa entradas expiradas

Cada endpoint segue o pipeline:

```
1. authenticate(req) → 401 se null
2. requireScope(session, '<recurso>:<read|write>') → 403 se não tem
3. rateLimit(...) → 429 se excedeu
4. parse body → 400 se JSON inválido
5. zod parse → 422 se inválido
6. lógica + queries (SEMPRE filtrando organization_id manualmente)
7. auditLog (fire-and-forget)
8. publishWebhook (fire-and-forget) se aplicável
9. Response padronizado
```

### 10. Cron config

`vercel.json`:

```json
{
  "crons": [
    { "path": "/api/internal/webhook-tick", "schedule": "* * * * *" },
    { "path": "/api/internal/idempotency-cleanup", "schedule": "0 3 * * *" }
  ]
}
```

### 11. Variáveis de ambiente

Adicione ao `.env.example` e ao `.env.local`:

```bash
CURSOR_SECRET=<openssl rand -hex 32>
INTERNAL_SECRET=<openssl rand -hex 32>
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

## Testar

### 1. Auth

```bash
# Sem auth
curl -i http://localhost:3000/api/v1/leads
# → 401 unauthorized

# Cria token (cookie session no navegador → POST /api-tokens)
# Copie o plaintext devolvido

# Bearer
curl -i http://localhost:3000/api/v1/leads \
  -H "Authorization: Bearer tok_live_..."
# → 200 com data: []
```

### 2. CRUD lead

```bash
TOKEN="tok_live_..."
ORG_ID="..."
PIPELINE_ID="..."
STAGE_ID="..."
CONTACT_ID="..."

# Cria
curl -X POST http://localhost:3000/api/v1/leads \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d "{
    \"pipeline_id\": \"$PIPELINE_ID\",
    \"stage_id\": \"$STAGE_ID\",
    \"contact_id\": \"$CONTACT_ID\",
    \"title\": \"Teste E2E\",
    \"value_cents\": 100000,
    \"tags\": [\"teste\"]
  }"
# → 201 { data: { id: "...", ... } }

# Lê
curl http://localhost:3000/api/v1/leads/<lead-id> -H "Authorization: Bearer $TOKEN"

# Atualiza
curl -X PATCH http://localhost:3000/api/v1/leads/<lead-id> \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"value_cents": 200000}'

# Move
curl -X POST http://localhost:3000/api/v1/leads/<lead-id>/move \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"stage_id\": \"<new-stage>\"}"

# Deleta (soft)
curl -X DELETE http://localhost:3000/api/v1/leads/<lead-id> \
  -H "Authorization: Bearer $TOKEN"
# → 204
```

### 3. Idempotência

```bash
KEY=$(uuidgen)
# 1ª chamada
curl -X POST http://localhost:3000/api/v1/leads \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{...}'
# → 201

# Repetir mesma chamada → MESMO response
curl -X POST http://localhost:3000/api/v1/leads \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{...}'
# → 201 (mesmo body), header X-Idempotency-Replay: true

# Mudar body → 409 idempotency_conflict
```

### 4. Cursor pagination

```bash
# Primeira página
curl "http://localhost:3000/api/v1/leads?limit=5" -H "Authorization: Bearer $TOKEN"
# → { data: [...5...], meta: { cursor: "abc.def", has_more: true } }

# Próxima
curl "http://localhost:3000/api/v1/leads?limit=5&cursor=abc.def" \
  -H "Authorization: Bearer $TOKEN"

# Cursor inválido
curl "http://localhost:3000/api/v1/leads?cursor=tampered" -H "Authorization: Bearer $TOKEN"
# → 400 invalid_cursor
```

### 5. Filtros

```bash
# Por stage
curl "http://localhost:3000/api/v1/leads?stage_id=$STAGE_ID" -H "Authorization: Bearer $TOKEN"

# Custom field
curl "http://localhost:3000/api/v1/leads?custom_field[plano]=premium" \
  -H "Authorization: Bearer $TOKEN"

# Multi-filter
curl "http://localhost:3000/api/v1/leads?stage_id=$STAGE_ID&value_min=50000&tag=enterprise&order_by=last_activity_at&order_dir=desc" \
  -H "Authorization: Bearer $TOKEN"
```

### 6. Rate limit

```bash
# Loop pra estourar
for i in $(seq 1 100); do
  curl -s -o /dev/null -w "%{http_code} " http://localhost:3000/api/v1/leads \
    -H "Authorization: Bearer $TOKEN"
done
# Eventualmente: 429 (com Retry-After)
```

### 7. Webhooks

```bash
# Cria subscription
curl -X POST http://localhost:3000/api/v1/webhooks \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://webhook.site/<seu-uuid>",
    "events": ["lead.created", "lead.moved", "lead.won"]
  }'
# Anote o secret retornado

# Cria lead → webhook chega no webhook.site
# Cabeçalho X-Webhook-Signature: sha256=<hex>

# Validar HMAC manualmente:
echo -n '<rawBody>' | openssl dgst -sha256 -hmac '<secret>'
```

### 8. Bulk

```bash
curl -X POST http://localhost:3000/api/v1/leads/bulk \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "leads": [
      { "pipeline_id": "...", "stage_id": "...", "contact_id": "...", "title": "Lead A" },
      { "pipeline_id": "...", "stage_id": "...", "contact_id": "...", "title": "Lead B" }
    ]
  }'
# → 201 { data: { inserted: [...], errors: [] } }
```

## Definition of Done

- [ ] Migration aplicada (api_tokens, idempotency_keys, api_audit_log, webhook_subscriptions, webhook_deliveries, soft delete em crm_leads, search_vector, GIN indexes)
- [ ] Helper `authenticate()` resolve cookie OU bearer
- [ ] Helper `rateLimit()` com Upstash + fallback memory
- [ ] Helper `withIdempotency()` salva e replaya
- [ ] Helper `auditLog()` fire-and-forget
- [ ] Helper `publishWebhook()` enfileira deliveries
- [ ] Cursor encode/decode com HMAC
- [ ] `GET /api/v1/leads` lista com cursor + filtros (stage, owner, value, tag, custom_field, search, dates)
- [ ] `POST /api/v1/leads` cria com idempotência, valida pipeline+stage+contact+WIP
- [ ] `PATCH /api/v1/leads/:id` recusa mudar pipeline/stage (força `/move`)
- [ ] `DELETE /api/v1/leads/:id` faz soft delete (idempotente em segunda chamada)
- [ ] `POST /api/v1/leads/:id/move` valida stage no mesmo pipeline, WIP, calcula position; aciona webhook `lead.moved` / `lead.won` / `lead.lost`
- [ ] `POST /api/v1/leads/bulk` aceita até 100, valida em batch, retorna `{ inserted, errors }`
- [ ] `GET/POST /api/v1/leads/:id/activities` funciona, atualiza `last_activity_at`
- [ ] `POST /api/v1/leads/:id/links` linka entidade externa
- [ ] CRUD de pipelines + stages funciona
- [ ] `POST /api/v1/api-tokens` cria, mostra plaintext UMA vez, gera prefix
- [ ] `DELETE /api/v1/api-tokens/:id` revoga
- [ ] `POST /api/v1/webhooks` cria subscription com secret
- [ ] Worker `webhook-tick` entrega com HMAC `X-Webhook-Signature: sha256=<hex>`
- [ ] Backoff exponencial: 30s, 1m, 2m, 5m, 10m, 30m, 1h
- [ ] Após 8 attempts → `dead`, após 10 deliveries dead consecutivas → subscription `is_active=false`
- [ ] Cron `idempotency-cleanup` remove keys expiradas
- [ ] Headers `X-Request-Id`, `X-RateLimit-*`, `Retry-After` retornados
- [ ] Todos route handlers com `export const dynamic = 'force-dynamic'`
- [ ] Audit log popula em todas mutações
- [ ] Curl de ponta a ponta funciona conforme seção "Testar"

## Não faça

- ❌ Não use offset pagination como default (use cursor SEMPRE)
- ❌ Não esqueça `force-dynamic`
- ❌ Não trust no body sem Zod
- ❌ Não filtre só por RLS quando usa `getSupabaseAdminClient()` (RLS é bypassed; filtre `organization_id` manualmente)
- ❌ Não armazene plaintext de token (só hash sha256)
- ❌ Não bloqueie request com webhook delivery síncrono (publishWebhook só enfileira)
- ❌ Não auditLog síncrono (fire-and-forget)
- ❌ Não mude shape de response em campos opcionais sem subir versão (v2)
- ❌ Não comece MCP server (fase 8)

Ao terminar: **"Fase 07 completa. Pode prosseguir para fase 08 (MCP server)."**
