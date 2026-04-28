# 11 — Auth, RBAC, rate limit, webhooks de saída e auditoria

> **Resumo:** o que envolve a "fronteira" da API. Cookie session vs bearer token, criação/rotação de API tokens, RBAC (admin, manager, agent, viewer) com permissões por pipeline, rate limit com Upstash Redis (sliding window) e fallback in-memory pra dev, webhooks de saída assinados com HMAC + retry exponencial + dead letter queue, e audit log denso pra forense.

---

## 1. Auth flows

### 1.1. Cookie session (frontend → API)

Frontend Next.js usa Supabase Auth via `@supabase/ssr`. O cookie `sb-<project>-auth-token` carrega a sessão. Em Route Handlers:

```typescript
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

const supa = createServerClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  {
    cookies: {
      get: (name) => cookies().get(name)?.value,
      set: () => {},   // route handlers leem; refresh é responsabilidade de middleware
      remove: () => {},
    },
  },
);
const { data: { user } } = await supa.auth.getUser();
```

Por quê `getUser()` e não `getSession()`?

- `getUser()` valida o JWT no backend (chama Supabase Auth). Mais lento mas seguro.
- `getSession()` confia no cookie local. Vulnerável se cookie é forjado.

🎯 **Decisão:** sempre `getUser()` em endpoints que mutam dados.

### 1.2. Bearer token (server-to-server)

Integrações externas (Zapier, n8n, Make, scripts internos) usam `Authorization: Bearer tok_...`.

📦 **Schema da tabela:**

```sql
CREATE TABLE IF NOT EXISTS api_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  prefix text NOT NULL,                       -- primeiros 8 chars do plaintext (display)
  token_hash text NOT NULL UNIQUE,            -- sha256 hex do plaintext
  scopes text[] NOT NULL DEFAULT '{leads:read}',
  created_by_user_id uuid NOT NULL,
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_tokens_org_idx ON api_tokens (organization_id);
CREATE INDEX api_tokens_hash_idx ON api_tokens (token_hash);
```

📦 **Endpoint de criação** (`app/api/v1/api-tokens/route.ts`):

```typescript
import { NextRequest } from 'next/server';
import { z } from 'zod';
import crypto from 'crypto';
import { authenticate, requireRole } from '@/lib/api/auth';
import { ok, created, unauthorized, forbidden, unprocessable, badRequest, serverError } from '@/lib/api/response';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { auditLog } from '@/lib/api/audit';

export const dynamic = 'force-dynamic';

const createSchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.string()).min(1).default(['leads:read']),
  expires_at: z.string().datetime().optional(),
});

const ALLOWED_SCOPES = new Set([
  'leads:read', 'leads:write',
  'pipelines:read', 'pipelines:write',
  'stages:read', 'stages:write',
  'activities:read', 'activities:write',
  'webhooks:read', 'webhooks:write',
]);

export async function GET(req: NextRequest) {
  const session = await authenticate(req);
  if (!session) return unauthorized();
  if (!requireRole(session, ['admin'])) return forbidden();

  const supa = getSupabaseAdminClient();
  const { data, error } = await supa
    .from('api_tokens')
    .select('id, name, prefix, scopes, last_used_at, expires_at, revoked_at, created_at, created_by_user_id')
    .eq('organization_id', session.organizationId)
    .order('created_at', { ascending: false });

  if (error) return serverError('Erro ao listar tokens.', error.message);
  return ok(data);
}

export async function POST(req: NextRequest) {
  const session = await authenticate(req);
  if (!session) return unauthorized();
  if (!requireRole(session, ['admin'])) return forbidden();

  let body: unknown;
  try { body = await req.json(); } catch { return badRequest('Body JSON inválido.'); }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return unprocessable('Validação falhou.', parsed.error.issues);

  for (const s of parsed.data.scopes) {
    if (!ALLOWED_SCOPES.has(s)) {
      return unprocessable(`Scope desconhecido: ${s}`);
    }
  }

  // Plaintext: tok_live_<32 chars random>
  const random = crypto.randomBytes(24).toString('base64url');
  const plaintext = `tok_live_${random}`;
  const prefix = plaintext.slice(0, 12);
  const tokenHash = crypto.createHash('sha256').update(plaintext).digest('hex');

  const supa = getSupabaseAdminClient();
  const { data: token, error } = await supa
    .from('api_tokens')
    .insert({
      organization_id: session.organizationId,
      name: parsed.data.name,
      prefix,
      token_hash: tokenHash,
      scopes: parsed.data.scopes,
      created_by_user_id: session.userId,
      expires_at: parsed.data.expires_at ?? null,
    })
    .select('id, name, prefix, scopes, expires_at, created_at')
    .single();

  if (error || !token) return serverError('Erro ao criar token.', error?.message);

  auditLog({
    organization_id: session.organizationId,
    user_id: session.userId,
    action: 'api_token.created',
    resource_type: 'api_token',
    resource_id: token.id,
    metadata: { name: token.name, scopes: token.scopes },
  });

  // ÚNICA vez que mostra plaintext
  return created({ ...token, plaintext });
}
```

📦 **Endpoint de revogação** (`app/api/v1/api-tokens/[id]/route.ts`):

```typescript
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await authenticate(req);
  if (!session) return unauthorized();
  if (!requireRole(session, ['admin'])) return forbidden();

  const supa = getSupabaseAdminClient();
  const { data: token } = await supa
    .from('api_tokens')
    .select('id, organization_id, name')
    .eq('id', params.id)
    .eq('organization_id', session.organizationId)
    .maybeSingle();
  if (!token) return notFound('Token não encontrado.');

  const { error } = await supa
    .from('api_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', params.id);
  if (error) return serverError('Erro ao revogar.', error.message);

  auditLog({
    organization_id: session.organizationId,
    user_id: session.userId,
    action: 'api_token.revoked',
    resource_type: 'api_token',
    resource_id: params.id,
    metadata: { name: token.name },
  });

  return noContent();
}
```

🎯 **Decisão:** plaintext é mostrado UMA vez. Depois só hash. Cliente perdeu = revoga e cria novo.

⚠️ **Gotcha:** prefixo `tok_live_` deixa óbvio em logs/grep. Use `tok_test_` em ambiente de staging. Reduz acidentes.

### 1.3. Rotação

Operador clica "rotacionar":
1. Cria novo token (com mesmo nome+scopes)
2. Marca antigo com `expires_at = now() + 24h` (grace period)
3. UI exibe o novo plaintext, alerta sobre o prazo

Implementação trivial usando os endpoints acima.

---

## 2. RBAC (Role-Based Access Control)

### 2.1. Roles padrão

| Role | Pode |
|------|------|
| `viewer` | GET tudo. Nada mais. |
| `agent` | + POST/PATCH em leads/activities dos pipelines onde está atribuído. Não deleta. |
| `manager` | + DELETE leads. Move qualquer lead. Cria/edita pipelines da sua org. |
| `admin` | Tudo. Inclui criar tokens, gerenciar webhooks, ver audit. |

📦 **Schema:**

```sql
ALTER TABLE user_organizations
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'viewer'
    CHECK (role IN ('admin', 'manager', 'agent', 'viewer'));
```

### 2.2. Helper

```typescript
type Role = 'admin' | 'manager' | 'agent' | 'viewer';

const ROLE_HIERARCHY: Record<Role, number> = {
  viewer: 1,
  agent: 2,
  manager: 3,
  admin: 4,
};

export function hasMinRole(session: ApiSession, min: Role): boolean {
  return ROLE_HIERARCHY[session.role] >= ROLE_HIERARCHY[min];
}

export function requireRole(session: ApiSession, allowed: Role[]): boolean {
  return allowed.includes(session.role);
}
```

### 2.3. Permissões por pipeline (cenário comum)

Vendedor SDR só vê pipeline "Inbound". Closer só vê "Negociação". Implementação:

```sql
CREATE TABLE IF NOT EXISTS user_pipeline_access (
  user_id uuid NOT NULL,
  pipeline_id uuid NOT NULL REFERENCES crm_pipelines(id) ON DELETE CASCADE,
  access text NOT NULL DEFAULT 'read' CHECK (access IN ('read', 'write')),
  PRIMARY KEY (user_id, pipeline_id)
);
```

Helper que filtra:

```typescript
async function getAccessiblePipelines(supa: SupabaseClient, session: ApiSession): Promise<string[] | 'all'> {
  if (session.role === 'admin' || session.role === 'manager') return 'all';

  const { data } = await supa
    .from('user_pipeline_access')
    .select('pipeline_id')
    .eq('user_id', session.userId);
  return (data ?? []).map(d => d.pipeline_id);
}
```

Aplicado em GET /leads:

```typescript
const accessible = await getAccessiblePipelines(supa, session);
if (accessible !== 'all') {
  if (accessible.length === 0) return ok([], { cursor: null, has_more: false });
  query = query.in('pipeline_id', accessible);
}
```

⚠️ **Gotcha:** se `accessible.length === 0`, retornar 403 ou lista vazia? Lista vazia é mais amigável (UI mostra "nenhum lead"). 403 confunde se o user só ainda não tem acesso configurado.

### 2.4. RLS como segunda camada

Toda tabela CRM tem RLS:

```sql
ALTER TABLE crm_leads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "leads_select_org_members"
ON crm_leads FOR SELECT
USING (
  organization_id IN (
    SELECT organization_id FROM user_organizations WHERE user_id = auth.uid()
  )
);

CREATE POLICY "leads_insert_org_members_with_role"
ON crm_leads FOR INSERT
WITH CHECK (
  organization_id IN (
    SELECT organization_id FROM user_organizations
    WHERE user_id = auth.uid() AND role IN ('admin', 'manager', 'agent')
  )
);

-- analogamente UPDATE e DELETE
```

⚠️ **Gotcha:** RLS só funciona quando o cliente é o `supaUser` (anon key + JWT do user). Quando você usa `getSupabaseAdminClient()` (service role), RLS é bypassed. Por isso TODA query no admin client filtra `organization_id` manualmente.

🎯 **Decisão:** API usa admin client (rápido + libera operações cross-user dentro da org). Filtros manuais são defesa em profundidade. RLS protege quando você usa o user client direto (raro).

---

## 3. Rate limit

### 3.1. Por quê: hard rule

Sem rate limit, um cliente buggy entra em loop e te derruba o Postgres. Rate limit existe pra:
- Proteger contra bug (loop infinito de retry)
- Proteger contra abuse (scraper)
- Garantir fairness (1 cliente não monopoliza)

### 3.2. Sliding window com Upstash Redis (recomendado em produção)

📦 **Setup:** crie um Upstash Redis (tier free serve), pegue `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN`.

```bash
npm install @upstash/redis @upstash/ratelimit
```

📦 **`lib/api/rate-limit.ts`**:

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

function getLimiter(limit: number, windowSec: number): Ratelimit | null {
  if (!redis) return null;
  const key = `${limit}:${windowSec}`;
  if (!limiters.has(key)) {
    limiters.set(
      key,
      new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(limit, `${windowSec} s`),
        analytics: true,
        prefix: 'crm-rl',
      }),
    );
  }
  return limiters.get(key)!;
}

// Fallback in-memory (dev / single-instance)
const memBuckets = new Map<string, Array<number>>();

async function memLimit(key: string, limit: number, windowSec: number): Promise<{ success: boolean; remaining: number; reset: number }> {
  const now = Date.now();
  const cutoff = now - windowSec * 1000;
  const bucket = (memBuckets.get(key) ?? []).filter(ts => ts > cutoff);
  if (bucket.length >= limit) {
    return { success: false, remaining: 0, reset: Math.floor((bucket[0] + windowSec * 1000) / 1000) };
  }
  bucket.push(now);
  memBuckets.set(key, bucket);
  return { success: true, remaining: limit - bucket.length, reset: Math.floor(now / 1000) + windowSec };
}

export async function rateLimit(args: {
  key: string;
  limit: number;
  windowSec: number;
}): Promise<{ ok: true; remaining: number; reset: number } | { ok: false; response: NextResponse }> {
  const limiter = getLimiter(args.limit, args.windowSec);
  let result: { success: boolean; remaining: number; reset: number };

  if (limiter) {
    const r = await limiter.limit(args.key);
    result = { success: r.success, remaining: r.remaining, reset: Math.floor(r.reset / 1000) };
  } else {
    result = await memLimit(args.key, args.limit, args.windowSec);
  }

  if (!result.success) {
    const retryAfter = Math.max(1, result.reset - Math.floor(Date.now() / 1000));
    const res = NextResponse.json(
      { error: { code: 'rate_limited', message: 'Rate limit excedido.' } },
      { status: 429 },
    );
    res.headers.set('Retry-After', String(retryAfter));
    res.headers.set('X-RateLimit-Limit', String(args.limit));
    res.headers.set('X-RateLimit-Remaining', '0');
    res.headers.set('X-RateLimit-Reset', String(result.reset));
    return { ok: false, response: res };
  }

  return { ok: true, remaining: result.remaining, reset: result.reset };
}
```

### 3.3. Aplicação por endpoint

```typescript
// Em qualquer Route Handler:
const rl = await rateLimit({
  key: `leads:write:${session.userId}`,
  limit: session.authMethod === 'cookie' ? 30 : 120,
  windowSec: 60,
});
if (!rl.ok) return rl.response;

// ... continua ...
```

A `key` deve incluir tanto a operação quanto o sujeito. Exemplos:

| Operação | Key |
|----------|-----|
| Lista de leads | `leads:list:${userId}` |
| Criação | `leads:write:${userId}` |
| Bulk | `leads:bulk:${userId}` |
| Busca | `search:${userId}` |
| Webhook delivery | `webhook:org:${orgId}` |

⚠️ **Gotcha:** se você fizer key só por user, um POST cria budget separado de GET. Bom (deletar não deve consumir budget de leitura). Mas você multiplica overhead. Comece simples (`api:${userId}` global), só desagregue quando ver problema.

### 3.4. Headers expostos

Toda resposta com sucesso também inclui:

```typescript
res.headers.set('X-RateLimit-Limit', String(rl.limit));
res.headers.set('X-RateLimit-Remaining', String(rl.remaining));
res.headers.set('X-RateLimit-Reset', String(rl.reset));
```

Cliente vê quantas requests restam e se programa.

---

## 4. Webhooks de saída

### 4.1. Por quê

Cliente quer ser notificado quando algo acontece (lead criado, mudou de stage, won, lost). Em vez de pollar `/leads`, ele subscreve um endpoint.

### 4.2. Schema

```sql
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url text NOT NULL,
  events text[] NOT NULL,                                 -- ['lead.created', 'lead.moved', ...]
  secret text NOT NULL,                                   -- usado pra HMAC
  is_active boolean NOT NULL DEFAULT true,
  description text,
  created_by_user_id uuid,
  last_delivery_at timestamptz,
  last_delivery_status int,
  consecutive_failures int NOT NULL DEFAULT 0,
  disabled_at timestamptz,                                -- desativado após N falhas
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX webhook_subs_org_idx ON webhook_subscriptions (organization_id);

-- Fila de delivery
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
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
  ON webhook_deliveries (next_attempt_at)
  WHERE status IN ('pending', 'delivering');
```

### 4.3. Eventos publicados

| Event | Quando |
|-------|--------|
| `lead.created` | POST /leads (sucesso) |
| `lead.updated` | PATCH /leads/:id (sucesso, sem mudar status) |
| `lead.moved` | POST /leads/:id/move (mudou de stage) |
| `lead.won` | move pra stage `is_won=true` ou status='won' |
| `lead.lost` | move pra stage `is_lost=true` ou status='lost' |
| `lead.deleted` | DELETE /leads/:id |
| `activity.created` | POST /leads/:id/activities |
| `pipeline.created` | POST /pipelines |
| `pipeline.updated` | PATCH /pipelines/:id |
| `stage.created` | POST /pipelines/:id/stages |

### 4.4. `publishWebhook`: enfileirar

📦 **`lib/api/webhooks.ts`**:

```typescript
import { getSupabaseAdminClient } from '@/lib/supabase/admin';

export async function publishWebhook(args: {
  organization_id: string;
  event: string;
  payload: any;
}) {
  const supa = getSupabaseAdminClient();

  // Pega subscriptions ativas que escutam esse evento
  const { data: subs } = await supa
    .from('webhook_subscriptions')
    .select('id, events')
    .eq('organization_id', args.organization_id)
    .eq('is_active', true);

  if (!subs || subs.length === 0) return;

  const wantedSubs = subs.filter(s => s.events.includes(args.event));
  if (wantedSubs.length === 0) return;

  // Enfileira deliveries
  const rows = wantedSubs.map(s => ({
    subscription_id: s.id,
    event: args.event,
    payload: args.payload,
    status: 'pending',
    next_attempt_at: new Date().toISOString(),
  }));

  await supa.from('webhook_deliveries').insert(rows);

  // Trigger imediato (fire-and-forget)
  fetch(process.env.NEXT_PUBLIC_APP_URL + '/api/internal/webhook-tick', {
    method: 'POST',
    headers: { 'X-Internal-Secret': process.env.INTERNAL_SECRET! },
  }).catch(() => {/* cron pega depois */});
}
```

⚠️ **Gotcha:** o `publishWebhook` é chamado dentro do POST/PATCH/DELETE. Não pode bloquear muito tempo. Por isso ele só ENFILEIRA. O delivery real é assíncrono.

### 4.5. Worker de delivery

📦 **`app/api/internal/webhook-tick/route.ts`** (chamado por cron a cada minuto + trigger imediato):

```typescript
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
const MAX_ATTEMPTS = 8;            // 1 + 7 retries
const TIMEOUT_MS = 10_000;

export async function POST(req: NextRequest) {
  const internalSecret = req.headers.get('x-internal-secret');
  if (internalSecret !== process.env.INTERNAL_SECRET) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const supa = getSupabaseAdminClient();
  const now = new Date().toISOString();

  // Pega até 50 entregas pendentes
  const { data: deliveries } = await supa
    .from('webhook_deliveries')
    .select('id, subscription_id, event, payload, attempt, subscription:webhook_subscriptions(id, url, secret, is_active, consecutive_failures)')
    .in('status', ['pending'])
    .lte('next_attempt_at', now)
    .order('next_attempt_at', { ascending: true })
    .limit(50);

  if (!deliveries || deliveries.length === 0) return NextResponse.json({ delivered: 0 });

  let delivered = 0;
  for (const d of deliveries) {
    const sub = (d as any).subscription;
    if (!sub || !sub.is_active) continue;

    await supa.from('webhook_deliveries').update({ status: 'delivering' }).eq('id', d.id);

    try {
      const body = JSON.stringify({
        id: d.id,
        event: d.event,
        organization_id: sub.organization_id,
        created_at: now,
        data: d.payload,
      });

      const sig = crypto.createHmac('sha256', sub.secret).update(body).digest('hex');

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

      const res = await fetch(sub.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'TomikCRM-Webhook/1.0',
          'X-Webhook-Event': d.event,
          'X-Webhook-Delivery-Id': d.id,
          'X-Webhook-Signature': `sha256=${sig}`,
        },
        body,
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      if (res.status >= 200 && res.status < 300) {
        await supa.from('webhook_deliveries').update({
          status: 'success',
          delivered_at: new Date().toISOString(),
          last_response_status: res.status,
        }).eq('id', d.id);
        await supa.from('webhook_subscriptions').update({
          last_delivery_at: new Date().toISOString(),
          last_delivery_status: res.status,
          consecutive_failures: 0,
        }).eq('id', sub.id);
        delivered++;
      } else {
        await scheduleRetry(supa, d, sub, `HTTP ${res.status}`);
      }
    } catch (err: any) {
      await scheduleRetry(supa, d, sub, String(err?.message ?? err));
    }
  }

  return NextResponse.json({ delivered });
}

async function scheduleRetry(supa: any, delivery: any, sub: any, errorMsg: string) {
  const nextAttempt = delivery.attempt + 1;
  if (nextAttempt >= MAX_ATTEMPTS) {
    await supa.from('webhook_deliveries').update({
      status: 'dead',
      attempt: nextAttempt,
      last_error: errorMsg,
    }).eq('id', delivery.id);

    // Disable após 10 deliveries dead consecutivas
    const newFailures = (sub.consecutive_failures ?? 0) + 1;
    const updates: any = { consecutive_failures: newFailures };
    if (newFailures >= 10) {
      updates.is_active = false;
      updates.disabled_at = new Date().toISOString();
    }
    await supa.from('webhook_subscriptions').update(updates).eq('id', sub.id);
    return;
  }

  // Backoff exponencial: 30s, 1m, 2m, 5m, 10m, 30m, 1h
  const delaysMin = [0.5, 1, 2, 5, 10, 30, 60];
  const delayMin = delaysMin[Math.min(nextAttempt - 1, delaysMin.length - 1)];
  const next = new Date(Date.now() + delayMin * 60 * 1000).toISOString();

  await supa.from('webhook_deliveries').update({
    status: 'pending',
    attempt: nextAttempt,
    next_attempt_at: next,
    last_error: errorMsg,
  }).eq('id', delivery.id);
}
```

📦 **Cron** (`vercel.json`):

```json
{
  "crons": [
    { "path": "/api/internal/webhook-tick", "schedule": "* * * * *" }
  ]
}
```

⚠️ **Gotcha:** Vercel cron não envia `x-internal-secret`. Use header secret de Vercel ou aceite request quando vem com header `x-vercel-cron`.

### 4.6. Verificação no consumer

O cliente que recebe o webhook valida a assinatura:

```typescript
// No endpoint do CLIENTE que recebe:
import crypto from 'crypto';

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET!;

export async function POST(req: Request) {
  const rawBody = await req.text();
  const signature = req.headers.get('x-webhook-signature') ?? '';
  const provided = signature.startsWith('sha256=') ? signature.slice(7) : signature;

  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
  const providedBuf = Buffer.from(provided, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');

  if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
    return new Response('invalid signature', { status: 401 });
  }

  const payload = JSON.parse(rawBody);
  // processa...
  return new Response('ok');
}
```

🎯 **Decisão:** sempre `timingSafeEqual` em comparação de assinatura. `===` vaza tempo de comparação.

### 4.7. Endpoints CRUD de subscription

Mesmo padrão dos outros recursos. Resumido:

```typescript
// app/api/v1/webhooks/route.ts
// GET → lista subscriptions da org
// POST → cria (admin only). Gera secret automaticamente, mostra UMA vez.

// app/api/v1/webhooks/[id]/route.ts
// PATCH → atualiza url, events, is_active
// DELETE → remove

// app/api/v1/webhooks/[id]/test/route.ts
// POST → envia evento ping_test pra subscription, retorna response do consumer
```

📦 **Schema do payload (cliente recebe):**

```json
{
  "id": "delivery-uuid",
  "event": "lead.moved",
  "organization_id": "org-uuid",
  "created_at": "2026-04-28T14:30:00Z",
  "data": {
    "data": { /* o lead atualizado */ },
    "previous_stage_id": "stage-anterior-uuid"
  }
}
```

---

## 5. Idempotência (detalhada)

📦 **Schema:**

```sql
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key text NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  request_hash text NOT NULL,
  response_status int NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  PRIMARY KEY (organization_id, key)
);

CREATE INDEX idempotency_keys_expires_idx ON idempotency_keys (expires_at);
```

📦 **Cron de limpeza:**

```typescript
// app/api/internal/idempotency-cleanup/route.ts
export async function POST(req: NextRequest) {
  if (req.headers.get('x-internal-secret') !== process.env.INTERNAL_SECRET) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const supa = getSupabaseAdminClient();
  const { count } = await supa
    .from('idempotency_keys')
    .delete()
    .lt('expires_at', new Date().toISOString())
    .select('key', { count: 'exact', head: true });
  return NextResponse.json({ deleted: count });
}
```

⚠️ **Gotcha:** PK composta `(organization_id, key)` evita que um cliente A use a mesma key de cliente B. UUIDs colidem com probabilidade ~0, mas defesa em profundidade.

---

## 6. Audit log

### 6.1. Schema

```sql
CREATE TABLE IF NOT EXISTS api_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  user_id uuid,
  api_token_id uuid,
  action text NOT NULL,                       -- ex: 'lead.created', 'lead.moved'
  resource_type text NOT NULL,                -- ex: 'lead', 'pipeline', 'api_token'
  resource_id uuid,
  ip_address text,
  user_agent text,
  request_id text,
  metadata jsonb DEFAULT '{}',                -- diff, params, etc.
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX api_audit_log_org_created_idx ON api_audit_log (organization_id, created_at DESC);
CREATE INDEX api_audit_log_resource_idx ON api_audit_log (resource_type, resource_id);
CREATE INDEX api_audit_log_user_idx ON api_audit_log (user_id);
```

### 6.2. Helper

📦 **`lib/api/audit.ts`**:

```typescript
import { getSupabaseAdminClient } from '@/lib/supabase/admin';

export interface AuditEntry {
  organization_id: string;
  user_id?: string | null;
  api_token_id?: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  ip_address?: string | null;
  user_agent?: string | null;
  request_id?: string | null;
  metadata?: Record<string, unknown>;
}

export function auditLog(entry: AuditEntry) {
  // Fire-and-forget. Audit nunca bloqueia request.
  const supa = getSupabaseAdminClient();
  supa.from('api_audit_log').insert(entry).then(({ error }) => {
    if (error) console.error('[audit] insert failed:', error);
  });
}
```

### 6.3. O que registrar

- Toda mutação de recurso (`lead.created`, `lead.updated`, `lead.deleted`, `lead.moved`, `lead.won`, `lead.lost`)
- Toda criação/revogação de token
- Toda criação/atualização/desativação de webhook
- Login/logout (se você expõe via API)
- Mudanças de role em `user_organizations`

### 6.4. O que NÃO registrar

- GET (lê não muda nada). Exceção: GET de dados sensíveis (export massivo).
- 401/403 (já está no log da aplicação)
- Health checks

⚠️ **Gotcha:** audit log cresce. Particione por mês ou archive em storage frio depois de 12 meses.

### 6.5. Endpoint de leitura

```typescript
// app/api/v1/audit-log/route.ts
export async function GET(req: NextRequest) {
  const session = await authenticate(req);
  if (!session) return unauthorized();
  if (!requireRole(session, ['admin'])) return forbidden();

  const limit = Math.min(Number(req.nextUrl.searchParams.get('limit') ?? 50), 200);
  const action = req.nextUrl.searchParams.get('action');
  const resourceType = req.nextUrl.searchParams.get('resource_type');
  const resourceId = req.nextUrl.searchParams.get('resource_id');

  const supa = getSupabaseAdminClient();
  let query = supa
    .from('api_audit_log')
    .select('id, user_id, api_token_id, action, resource_type, resource_id, metadata, created_at')
    .eq('organization_id', session.organizationId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (action) query = query.eq('action', action);
  if (resourceType) query = query.eq('resource_type', resourceType);
  if (resourceId) query = query.eq('resource_id', resourceId);

  const { data } = await query;
  return ok(data ?? []);
}
```

---

## 7. Pipeline integrado: middleware-style

Pra não repetir a sequência (auth → rate limit → idempotency) em todo handler, monte um wrapper:

📦 **`lib/api/with-api.ts`**:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { authenticate, requireScope, type ApiSession } from './auth';
import { rateLimit } from './rate-limit';
import { unauthorized, forbidden } from './response';
import crypto from 'crypto';

export interface ApiContext {
  session: ApiSession;
  requestId: string;
}

export type ApiHandler<P = any> = (
  req: NextRequest,
  ctx: ApiContext & { params?: P },
) => Promise<NextResponse> | NextResponse;

export interface WithApiOptions {
  scope?: string;
  rateLimit?: { limit: number; windowSec: number; keyPrefix: string };
}

export function withApi<P = any>(handler: ApiHandler<P>, options: WithApiOptions = {}) {
  return async (req: NextRequest, params: { params: P }): Promise<NextResponse> => {
    const requestId = crypto.randomUUID();

    const session = await authenticate(req);
    if (!session) return addRequestId(unauthorized(), requestId);
    if (options.scope && !requireScope(session, options.scope)) {
      return addRequestId(forbidden(), requestId);
    }

    if (options.rateLimit) {
      const rl = await rateLimit({
        key: `${options.rateLimit.keyPrefix}:${session.userId}`,
        limit: options.rateLimit.limit,
        windowSec: options.rateLimit.windowSec,
      });
      if (!rl.ok) return addRequestId(rl.response, requestId);
      // Headers expostos
    }

    try {
      const res = await handler(req, { session, requestId, params: params?.params });
      return addRequestId(res, requestId);
    } catch (err) {
      console.error(`[${requestId}]`, err);
      return addRequestId(
        NextResponse.json({ error: { code: 'internal', message: 'Erro interno.' } }, { status: 500 }),
        requestId,
      );
    }
  };
}

function addRequestId(res: NextResponse, requestId: string): NextResponse {
  res.headers.set('X-Request-Id', requestId);
  return res;
}
```

**Uso (rewrite enxuto do POST /leads):**

```typescript
import { withApi } from '@/lib/api/with-api';

export const POST = withApi(
  async (req, { session }) => {
    // ... lógica direta, sem boilerplate
  },
  {
    scope: 'leads:write',
    rateLimit: { limit: 60, windowSec: 60, keyPrefix: 'leads:write' },
  },
);
```

🎯 **Decisão:** opcional. Se o time é pequeno, copy-paste do boilerplate é ok. Se cresce, o wrapper salva muita linha.

---

## 8. Variáveis de ambiente

`.env.example`:

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...

# Cursor signature
CURSOR_SECRET=alterar-em-produção-32-bytes-min

# Internal calls
INTERNAL_SECRET=alterar-em-produção-32-bytes-min

# Rate limit (Upstash Redis — opcional em dev)
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

# App URL (pra triggers de webhook tick)
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

⚠️ **Gotcha:** `INTERNAL_SECRET` deve ser DIFERENTE do `SUPABASE_SERVICE_ROLE_KEY`. Internal é só pra suas crons. Service role é o root do DB. Vazar service role = vazar tudo.

---

## 9. Conferência rápida desta fase

- [ ] Auth dual: `getUser()` em cookie session + `Bearer tok_...` com hash sha256
- [ ] `api_tokens` com prefix visível, hash secreto, scopes, expires_at, revoked_at
- [ ] Plaintext do token mostrado UMA vez na criação
- [ ] Roles: viewer < agent < manager < admin (hierarquia)
- [ ] `user_pipeline_access` permite restringir por pipeline
- [ ] RLS habilitado nas tabelas CRM (defesa em profundidade)
- [ ] Rate limit Upstash com sliding window + fallback in-memory
- [ ] Headers `X-RateLimit-*` e `Retry-After` corretos
- [ ] `webhook_subscriptions` armazena url, events[], secret, is_active
- [ ] `webhook_deliveries` é fila com status (pending → delivering → success/failed/dead)
- [ ] Backoff exponencial: 30s, 1m, 2m, 5m, 10m, 30m, 1h (8 tentativas)
- [ ] Após 10 falhas consecutivas, subscription desativada
- [ ] Payload assinado com `X-Webhook-Signature: sha256=<hex>`
- [ ] Cliente valida com `timingSafeEqual`
- [ ] `idempotency_keys` com TTL 24h, PK composta `(org, key)`
- [ ] Cron de cleanup de idempotency_keys
- [ ] `api_audit_log` registra todas mutações com diff em `metadata`
- [ ] `auditLog()` é fire-and-forget, nunca bloqueia request
- [ ] Wrapper `withApi()` opcional pra centralizar auth + rate limit + error handling

---

## Próximo: prompt 07 em [../prompts/prompt-07-rest-api-implementation.md](../prompts/prompt-07-rest-api-implementation.md)
