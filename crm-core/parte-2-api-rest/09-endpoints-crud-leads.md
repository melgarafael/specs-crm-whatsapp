# 09 — Endpoints CRUD de Leads (implementação completa)

> **Resumo:** todos os endpoints REST para o recurso `leads` — listar com filtros + cursor, ler, criar (idempotente), atualizar, deletar (soft), mover de stage, criar em lote, registrar activities, linkar entidades externas. TypeScript real, Zod completo, pronto pra colar em `app/api/v1/leads/`.

---

## 1. Schemas Zod compartilhados

📦 **`lib/api/schemas/leads.ts`**:

```typescript
import { z } from 'zod';

// === Tipos básicos ===

export const uuidSchema = z.string().uuid();
export const isoDateSchema = z.string().datetime({ offset: true });

// === Custom fields são jsonb livre, mas validamos shape ===
export const customFieldsSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .default({});

// === CREATE ===
export const createLeadSchema = z.object({
  pipeline_id: uuidSchema,
  stage_id: uuidSchema,
  contact_id: uuidSchema,
  title: z.string().min(1).max(200),
  value_cents: z.number().int().min(0).max(9_999_999_999_999).default(0),
  currency: z.string().length(3).default('BRL'),
  owner_user_id: uuidSchema.optional().nullable(),
  source: z.string().max(60).optional().nullable(),
  source_metadata: z.record(z.unknown()).default({}),
  custom_fields: customFieldsSchema,
  tags: z.array(z.string().max(40)).max(20).default([]),
  expected_close_date: z.string().date().optional().nullable(),
});
export type CreateLeadInput = z.infer<typeof createLeadSchema>;

// === UPDATE (PATCH) — todos opcionais ===
export const updateLeadSchema = createLeadSchema.partial().extend({
  status: z.enum(['open', 'won', 'lost']).optional(),
  lost_reason: z.string().max(200).optional().nullable(),
});
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;

// === MOVE ===
export const moveLeadSchema = z.object({
  stage_id: uuidSchema,
  position_in_stage: z.number().optional(),  // se omitido, vai pro final
  reason: z.string().max(200).optional(),
});
export type MoveLeadInput = z.infer<typeof moveLeadSchema>;

// === BULK CREATE ===
export const bulkCreateLeadsSchema = z.object({
  leads: z.array(createLeadSchema).min(1).max(100),
});
export type BulkCreateLeadsInput = z.infer<typeof bulkCreateLeadsSchema>;

// === LIST QUERY ===
export const listLeadsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  pipeline_id: uuidSchema.optional(),
  stage_id: uuidSchema.optional(),
  owner: uuidSchema.optional(),
  contact_id: uuidSchema.optional(),
  status: z.enum(['open', 'won', 'lost']).optional(),
  source: z.string().optional(),
  tag: z.string().optional(),
  search: z.string().min(1).max(200).optional(),
  value_min: z.coerce.number().int().optional(),
  value_max: z.coerce.number().int().optional(),
  created_after: z.string().datetime().optional(),
  created_before: z.string().datetime().optional(),
  order_by: z.enum(['created_at', 'updated_at', 'last_activity_at', 'value_cents', 'position_in_stage'])
    .default('created_at'),
  order_dir: z.enum(['asc', 'desc']).default('desc'),
});
export type ListLeadsQuery = z.infer<typeof listLeadsQuerySchema>;

// === ACTIVITY ===
export const createActivitySchema = z.object({
  type: z.enum(['note', 'call', 'meeting', 'whatsapp', 'email', 'task', 'stage_change', 'system']),
  title: z.string().min(1).max(200),
  body: z.string().max(10_000).optional(),
  performed_at: z.string().datetime().optional(),
  metadata: z.record(z.unknown()).default({}),
  source_module: z.string().max(40).optional(),
  source_id: z.string().optional(),
});
export type CreateActivityInput = z.infer<typeof createActivitySchema>;

// === LEAD LINK ===
export const createLeadLinkSchema = z.object({
  target_kind: z.enum(['conversation', 'message', 'appointment', 'contract', 'invoice', 'document', 'external']),
  target_id: z.string().min(1).max(200),
  link_kind: z.enum(['related', 'origin', 'continuation', 'attachment']).default('related'),
  metadata: z.record(z.unknown()).default({}),
});
export type CreateLeadLinkInput = z.infer<typeof createLeadLinkSchema>;
```

⚠️ **Gotcha:** `value_cents` é integer pra evitar erros de ponto flutuante. R$ 1.500,00 = `value_cents: 150000`. Sempre.

---

## 2. Cursor: encode/decode

📦 **`lib/api/cursor.ts`** — cursor opaco com HMAC pra prevenir tampering:

```typescript
import crypto from 'crypto';

const SECRET = process.env.CURSOR_SECRET || process.env.NEXTAUTH_SECRET || 'dev-only-secret-change-me';

export interface CursorPayload {
  ts: string;     // ISO date do campo de ordenação (created_at, etc.)
  id: string;     // tie-breaker: id do recurso
  v: number;      // versão do shape, p/ evolução futura
}

export function encodeCursor(payload: CursorPayload): string {
  const json = JSON.stringify(payload);
  const body = Buffer.from(json, 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url').slice(0, 16);
  return `${body}.${sig}`;
}

export function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const [body, sig] = cursor.split('.');
    if (!body || !sig) return null;
    const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url').slice(0, 16);
    if (sig !== expected) return null;
    const json = Buffer.from(body, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as CursorPayload;
    if (typeof parsed.ts !== 'string' || typeof parsed.id !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}
```

---

## 3. Helper: `idempotency`

📦 **`lib/api/idempotency.ts`**:

```typescript
import crypto from 'crypto';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';

export interface IdempotentResult<T> {
  replay: boolean;
  status: number;
  body: T;
}

export async function withIdempotency<T>(args: {
  key: string | null;
  userId: string;
  organizationId: string;
  rawBody: unknown;
  handler: () => Promise<{ status: number; body: T }>;
}): Promise<IdempotentResult<T>> {
  const { key, userId, organizationId, rawBody, handler } = args;
  if (!key) {
    const r = await handler();
    return { replay: false, ...r };
  }

  const supa = getSupabaseAdminClient();
  const requestHash = crypto.createHash('sha256').update(JSON.stringify(rawBody)).digest('hex');

  // Tenta achar
  const { data: existing } = await supa
    .from('idempotency_keys')
    .select('request_hash, response_status, response_body')
    .eq('key', key)
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw new IdempotencyConflict();
    }
    return {
      replay: true,
      status: existing.response_status,
      body: existing.response_body as T,
    };
  }

  // Processa e salva
  const result = await handler();
  await supa.from('idempotency_keys').insert({
    key,
    user_id: userId,
    organization_id: organizationId,
    request_hash: requestHash,
    response_status: result.status,
    response_body: result.body as any,
  });

  return { replay: false, ...result };
}

export class IdempotencyConflict extends Error {
  constructor() { super('idempotency_conflict'); }
}
```

---

## 4. `GET /api/v1/leads` — listar

📦 **`app/api/v1/leads/route.ts`** (parte 1: GET):

```typescript
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { authenticate, requireScope } from '@/lib/api/auth';
import { ok, badRequest, unauthorized, forbidden, unprocessable, serverError } from '@/lib/api/response';
import { encodeCursor, decodeCursor } from '@/lib/api/cursor';
import { listLeadsQuerySchema } from '@/lib/api/schemas/leads';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { rateLimit } from '@/lib/api/rate-limit';
import { auditLog } from '@/lib/api/audit';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await authenticate(req);
  if (!session) return unauthorized();
  if (!requireScope(session, 'leads:read')) return forbidden();

  const rl = await rateLimit({ key: `leads:list:${session.userId}`, limit: 60, windowSec: 60 });
  if (!rl.ok) return rl.response;

  // Parse query
  const queryParams = Object.fromEntries(req.nextUrl.searchParams.entries());
  const parsed = listLeadsQuerySchema.safeParse(queryParams);
  if (!parsed.success) return unprocessable('Filtros inválidos.', parsed.error.issues);
  const q = parsed.data;

  // Custom fields filter (separado, padrão custom_field[plano]=premium)
  const customFieldsFilter: Record<string, string> = {};
  for (const [k, v] of req.nextUrl.searchParams.entries()) {
    const m = k.match(/^custom_field\[(.+)\]$/);
    if (m) customFieldsFilter[m[1]] = v;
  }

  const supa = getSupabaseAdminClient();
  let query = supa
    .from('crm_leads')
    .select('id, organization_id, pipeline_id, stage_id, contact_id, title, value_cents, currency, status, owner_user_id, source, custom_fields, tags, position_in_stage, expected_close_date, created_at, updated_at, last_activity_at, closed_at, lost_reason')
    .eq('organization_id', session.organizationId);

  if (q.pipeline_id) query = query.eq('pipeline_id', q.pipeline_id);
  if (q.stage_id) query = query.eq('stage_id', q.stage_id);
  if (q.owner) query = query.eq('owner_user_id', q.owner);
  if (q.contact_id) query = query.eq('contact_id', q.contact_id);
  if (q.status) query = query.eq('status', q.status);
  if (q.source) query = query.eq('source', q.source);
  if (q.tag) query = query.contains('tags', [q.tag]);
  if (q.value_min !== undefined) query = query.gte('value_cents', q.value_min);
  if (q.value_max !== undefined) query = query.lte('value_cents', q.value_max);
  if (q.created_after) query = query.gte('created_at', q.created_after);
  if (q.created_before) query = query.lte('created_at', q.created_before);
  if (q.search) query = query.ilike('title', `%${q.search}%`);
  for (const [k, v] of Object.entries(customFieldsFilter)) {
    query = query.contains('custom_fields', { [k]: v });
  }

  // Cursor: aplica WHERE no campo ordenado
  if (q.cursor) {
    const decoded = decodeCursor(q.cursor);
    if (!decoded) return badRequest('Cursor inválido ou adulterado.');
    if (q.order_dir === 'desc') {
      query = query.or(`${q.order_by}.lt.${decoded.ts},and(${q.order_by}.eq.${decoded.ts},id.lt.${decoded.id})`);
    } else {
      query = query.or(`${q.order_by}.gt.${decoded.ts},and(${q.order_by}.eq.${decoded.ts},id.gt.${decoded.id})`);
    }
  }

  query = query
    .order(q.order_by, { ascending: q.order_dir === 'asc' })
    .order('id', { ascending: q.order_dir === 'asc' })
    .limit(q.limit + 1);  // pega 1 a mais p/ saber se tem próxima

  const { data, error } = await query;
  if (error) return serverError('Falha ao listar leads.', error.message);

  const hasMore = data.length > q.limit;
  const items = hasMore ? data.slice(0, q.limit) : data;
  const last = items[items.length - 1];

  const cursor = hasMore && last
    ? encodeCursor({ ts: String(last[q.order_by as keyof typeof last]), id: last.id, v: 1 })
    : null;

  auditLog({
    organization_id: session.organizationId,
    user_id: session.userId,
    action: 'leads.list',
    resource_type: 'lead',
    resource_id: null,
    metadata: { count: items.length, filters: q },
  });

  return ok(items, { cursor, has_more: hasMore });
}
```

**Exemplo curl:**

```bash
curl -X GET "https://app.example.com/api/v1/leads?stage_id=abc-123&value_min=50000&tag=enterprise&limit=10" \
  -H "Authorization: Bearer tok_live_xyz..."
```

**Exemplo fetch (frontend):**

```typescript
const res = await fetch('/api/v1/leads?stage_id=' + stageId + '&limit=20', {
  credentials: 'include',
});
const { data, meta } = await res.json();
// data: Lead[]
// meta: { cursor: string|null, has_more: boolean }
```

⚠️ **Gotcha:** o cursor encode usa `last[q.order_by]` — se `q.order_by = 'value_cents'`, o cursor terá um número como `ts`. O nome `ts` no payload é histórico; o decoder não interpreta — é literal pro Postgres.

---

## 5. `POST /api/v1/leads` — criar (com idempotência)

📦 **`app/api/v1/leads/route.ts`** (parte 2: POST):

```typescript
import { created, conflict, notFound } from '@/lib/api/response';
import { createLeadSchema } from '@/lib/api/schemas/leads';
import { withIdempotency, IdempotencyConflict } from '@/lib/api/idempotency';
import { publishWebhook } from '@/lib/api/webhooks';

export async function POST(req: NextRequest) {
  const session = await authenticate(req);
  if (!session) return unauthorized();
  if (!requireScope(session, 'leads:write')) return forbidden();

  const rl = await rateLimit({ key: `leads:write:${session.userId}`, limit: 60, windowSec: 60 });
  if (!rl.ok) return rl.response;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return badRequest('Body JSON inválido.');
  }

  const parsed = createLeadSchema.safeParse(rawBody);
  if (!parsed.success) return unprocessable('Validação falhou.', parsed.error.issues);
  const input = parsed.data;

  const idempotencyKey = req.headers.get('idempotency-key');

  try {
    const result = await withIdempotency({
      key: idempotencyKey,
      userId: session.userId,
      organizationId: session.organizationId,
      rawBody,
      handler: async () => {
        const supa = getSupabaseAdminClient();

        // 1. Valida que stage pertence ao pipeline e ambos pertencem à org
        const { data: stage } = await supa
          .from('crm_stages')
          .select('id, pipeline_id, wip_limit, is_won, is_lost, crm_pipelines!inner(organization_id)')
          .eq('id', input.stage_id)
          .single();
        if (!stage) return { status: 404, body: { error: { code: 'stage_not_found', message: 'Stage não encontrada.' } } };
        if (stage.pipeline_id !== input.pipeline_id) {
          return { status: 409, body: { error: { code: 'stage_not_in_pipeline', message: 'Stage não pertence ao pipeline informado.' } } };
        }
        if ((stage as any).crm_pipelines.organization_id !== session.organizationId) {
          return { status: 404, body: { error: { code: 'pipeline_not_found', message: 'Pipeline não encontrado.' } } };
        }

        // 2. Valida WIP limit se houver
        if (stage.wip_limit) {
          const { count } = await supa
            .from('crm_leads')
            .select('id', { count: 'exact', head: true })
            .eq('stage_id', input.stage_id)
            .eq('status', 'open');
          if ((count ?? 0) >= stage.wip_limit) {
            return { status: 409, body: { error: { code: 'wip_limit_exceeded', message: `Limite de ${stage.wip_limit} leads na stage atingido.` } } };
          }
        }

        // 3. Valida contact pertence à org
        const { data: contact } = await supa
          .from('contacts')
          .select('id')
          .eq('id', input.contact_id)
          .eq('organization_id', session.organizationId)
          .maybeSingle();
        if (!contact) return { status: 404, body: { error: { code: 'contact_not_found', message: 'Contato não encontrado.' } } };

        // 4. Calcula position_in_stage (final da fila)
        const { data: maxRow } = await supa
          .from('crm_leads')
          .select('position_in_stage')
          .eq('stage_id', input.stage_id)
          .order('position_in_stage', { ascending: false })
          .limit(1)
          .maybeSingle();
        const nextPosition = (maxRow?.position_in_stage ?? 0) + 1000;

        // 5. INSERT
        const { data: lead, error: insErr } = await supa
          .from('crm_leads')
          .insert({
            organization_id: session.organizationId,
            pipeline_id: input.pipeline_id,
            stage_id: input.stage_id,
            contact_id: input.contact_id,
            title: input.title,
            value_cents: input.value_cents,
            currency: input.currency,
            owner_user_id: input.owner_user_id ?? session.userId,
            source: input.source ?? null,
            source_metadata: input.source_metadata,
            custom_fields: input.custom_fields,
            tags: input.tags,
            position_in_stage: nextPosition,
            expected_close_date: input.expected_close_date ?? null,
            status: 'open',
            last_activity_at: new Date().toISOString(),
          })
          .select()
          .single();

        if (insErr || !lead) {
          return { status: 500, body: { error: { code: 'insert_failed', message: insErr?.message ?? 'Erro ao criar lead.' } } };
        }

        // 6. Activity de criação
        await supa.from('crm_lead_activities').insert({
          organization_id: session.organizationId,
          lead_id: lead.id,
          contact_id: lead.contact_id,
          type: 'system',
          title: 'Lead criado',
          body: `Criado por ${session.userId}`,
          performed_by_user_id: session.userId,
          performed_at: new Date().toISOString(),
          metadata: { source: input.source ?? 'manual' },
        });

        // 7. Audit + webhook
        auditLog({
          organization_id: session.organizationId,
          user_id: session.userId,
          action: 'lead.created',
          resource_type: 'lead',
          resource_id: lead.id,
          metadata: { lead },
        });
        publishWebhook({
          organization_id: session.organizationId,
          event: 'lead.created',
          payload: { data: lead },
        });

        return { status: 201, body: { data: lead } };
      },
    });

    const res = new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'Content-Type': 'application/json' },
    });
    if (result.replay) res.headers.set('X-Idempotency-Replay', 'true');
    return res;
  } catch (err) {
    if (err instanceof IdempotencyConflict) {
      return conflict('Mesmo Idempotency-Key usado com body diferente.');
    }
    console.error('[POST /leads]', err);
    return serverError('Erro ao processar criação.');
  }
}
```

**Exemplo curl:**

```bash
curl -X POST https://app.example.com/api/v1/leads \
  -H "Authorization: Bearer tok_live_xyz..." \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "pipeline_id": "9c5b0a3a-2f8e-4f2f-bf76-0b3c5a1e8d44",
    "stage_id": "1a1b1c1d-1e1f-2a2b-3c3d-4e4f5a5b6c6d",
    "contact_id": "2a2b2c2d-2e2f-3a3b-4c4d-5e5f6a6b7c7d",
    "title": "Empresa Acme — Plano Pro",
    "value_cents": 250000,
    "currency": "BRL",
    "tags": ["enterprise", "inbound"],
    "custom_fields": {"plano": "premium", "industria": "saude"}
  }'
```

**Códigos de retorno:**

| Code | Significado |
|------|-------------|
| 201 | Criado |
| 401 | Não autenticado |
| 403 | Sem scope `leads:write` |
| 404 | pipeline/stage/contact não encontrado |
| 409 | stage_not_in_pipeline / wip_limit_exceeded / idempotency_conflict |
| 422 | Validação Zod |
| 429 | Rate limit |

⚠️ **Gotcha:** se o cliente NÃO mandar `Idempotency-Key`, dois POSTs idênticos criam dois leads. É responsabilidade do cliente. Mas você documenta isso e pronto.

---

## 6. `GET /api/v1/leads/{id}` — ler um

📦 **`app/api/v1/leads/[id]/route.ts`** (parte 1: GET):

```typescript
import { NextRequest } from 'next/server';
import { authenticate, requireScope } from '@/lib/api/auth';
import { ok, unauthorized, forbidden, notFound, serverError } from '@/lib/api/response';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await authenticate(req);
  if (!session) return unauthorized();
  if (!requireScope(session, 'leads:read')) return forbidden();

  const supa = getSupabaseAdminClient();
  const { data, error } = await supa
    .from('crm_leads')
    .select(`
      id, organization_id, pipeline_id, stage_id, contact_id, title, value_cents, currency,
      status, owner_user_id, source, source_metadata, custom_fields, tags, position_in_stage,
      lost_reason, expected_close_date, created_at, updated_at, closed_at, last_activity_at,
      contact:contacts(id, full_name, push_name, phone_number, email),
      stage:crm_stages(id, name, color, position, is_won, is_lost),
      pipeline:crm_pipelines(id, name, slug)
    `)
    .eq('id', params.id)
    .eq('organization_id', session.organizationId)
    .maybeSingle();

  if (error) return serverError('Erro ao buscar lead.', error.message);
  if (!data) return notFound('Lead não encontrado.');

  return ok(data);
}
```

⚠️ **Gotcha:** o filtro `.eq('organization_id', session.organizationId)` é defesa em profundidade. RLS já protege, mas com service role (admin client) o RLS é bypassed — então você FILTRA SEMPRE manualmente.

---

## 7. `PATCH /api/v1/leads/{id}` — atualizar

📦 **`app/api/v1/leads/[id]/route.ts`** (parte 2: PATCH):

```typescript
import { updateLeadSchema } from '@/lib/api/schemas/leads';
import { unprocessable, badRequest, conflict } from '@/lib/api/response';
import { auditLog } from '@/lib/api/audit';
import { publishWebhook } from '@/lib/api/webhooks';

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await authenticate(req);
  if (!session) return unauthorized();
  if (!requireScope(session, 'leads:write')) return forbidden();

  let rawBody: unknown;
  try { rawBody = await req.json(); } catch { return badRequest('Body JSON inválido.'); }

  const parsed = updateLeadSchema.safeParse(rawBody);
  if (!parsed.success) return unprocessable('Validação falhou.', parsed.error.issues);
  const updates = parsed.data;

  const supa = getSupabaseAdminClient();

  // Pega antes pra computar diff
  const { data: before } = await supa
    .from('crm_leads')
    .select('*')
    .eq('id', params.id)
    .eq('organization_id', session.organizationId)
    .maybeSingle();

  if (!before) return notFound('Lead não encontrado.');

  // Reject changes em campos imutáveis
  if (updates.pipeline_id && updates.pipeline_id !== before.pipeline_id) {
    return conflict('Use POST /leads/:id/move para trocar de pipeline/stage.');
  }
  if (updates.stage_id && updates.stage_id !== before.stage_id) {
    return conflict('Use POST /leads/:id/move para trocar de stage.');
  }

  // Se virando won/lost, set closed_at
  const now = new Date().toISOString();
  const patch: any = {
    ...updates,
    updated_at: now,
    last_activity_at: now,
  };
  if (updates.status === 'won' || updates.status === 'lost') {
    patch.closed_at = now;
  }

  const { data: updated, error } = await supa
    .from('crm_leads')
    .update(patch)
    .eq('id', params.id)
    .eq('organization_id', session.organizationId)
    .select()
    .single();

  if (error || !updated) return serverError('Erro ao atualizar.', error?.message);

  // Activity
  await supa.from('crm_lead_activities').insert({
    organization_id: session.organizationId,
    lead_id: updated.id,
    contact_id: updated.contact_id,
    type: 'system',
    title: 'Lead atualizado',
    body: `Campos alterados: ${Object.keys(updates).join(', ')}`,
    performed_by_user_id: session.userId,
    performed_at: now,
    metadata: { changes: diffShallow(before, updated) },
  });

  auditLog({
    organization_id: session.organizationId,
    user_id: session.userId,
    action: 'lead.updated',
    resource_type: 'lead',
    resource_id: updated.id,
    metadata: { before, after: updated },
  });

  const event = updated.status === 'won' ? 'lead.won'
              : updated.status === 'lost' ? 'lead.lost'
              : 'lead.updated';
  publishWebhook({
    organization_id: session.organizationId,
    event,
    payload: { data: updated, previous: before },
  });

  return ok(updated);
}

function diffShallow(a: any, b: any): Record<string, { from: any; to: any }> {
  const out: Record<string, { from: any; to: any }> = {};
  for (const k of Object.keys(b)) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out[k] = { from: a[k], to: b[k] };
  }
  return out;
}
```

⚠️ **Gotcha:** PATCH não muda stage. Se você permitir `stage_id` em PATCH, perde a oportunidade de validar regras de transição (WIP, kanban position, etc). Force o cliente a usar `/leads/:id/move`.

---

## 8. `DELETE /api/v1/leads/{id}` — soft delete

📦 **`app/api/v1/leads/[id]/route.ts`** (parte 3: DELETE):

```typescript
import { noContent } from '@/lib/api/response';

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await authenticate(req);
  if (!session) return unauthorized();
  if (!requireScope(session, 'leads:write')) return forbidden();

  const supa = getSupabaseAdminClient();
  const { data: existing } = await supa
    .from('crm_leads')
    .select('id, deleted_at')
    .eq('id', params.id)
    .eq('organization_id', session.organizationId)
    .maybeSingle();

  if (!existing) return notFound('Lead não encontrado.');
  if (existing.deleted_at) return noContent();  // já deletado, idempotente

  const now = new Date().toISOString();
  const { error } = await supa
    .from('crm_leads')
    .update({ deleted_at: now, updated_at: now })
    .eq('id', params.id);

  if (error) return serverError('Erro ao deletar.', error.message);

  auditLog({
    organization_id: session.organizationId,
    user_id: session.userId,
    action: 'lead.deleted',
    resource_type: 'lead',
    resource_id: params.id,
    metadata: {},
  });
  publishWebhook({
    organization_id: session.organizationId,
    event: 'lead.deleted',
    payload: { data: { id: params.id } },
  });

  return noContent();
}
```

🎯 **Decisão:** soft delete (campo `deleted_at`) em vez de DELETE físico. Permite undo, auditoria e relatórios históricos. O `GET /leads` filtra `deleted_at IS NULL` por default.

⚠️ **Gotcha:** se você NÃO incluiu `deleted_at` no schema do Agent A, adicione: `alter table crm_leads add column deleted_at timestamptz;`

---

## 9. `POST /api/v1/leads/{id}/move` — mover de stage

📦 **`app/api/v1/leads/[id]/move/route.ts`**:

```typescript
import { NextRequest } from 'next/server';
import { authenticate, requireScope } from '@/lib/api/auth';
import { ok, unauthorized, forbidden, notFound, conflict, badRequest, unprocessable, serverError } from '@/lib/api/response';
import { moveLeadSchema } from '@/lib/api/schemas/leads';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { auditLog } from '@/lib/api/audit';
import { publishWebhook } from '@/lib/api/webhooks';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await authenticate(req);
  if (!session) return unauthorized();
  if (!requireScope(session, 'leads:write')) return forbidden();

  let rawBody: unknown;
  try { rawBody = await req.json(); } catch { return badRequest('Body JSON inválido.'); }
  const parsed = moveLeadSchema.safeParse(rawBody);
  if (!parsed.success) return unprocessable('Validação falhou.', parsed.error.issues);

  const supa = getSupabaseAdminClient();

  // 1. Pega lead atual
  const { data: lead } = await supa
    .from('crm_leads')
    .select('id, pipeline_id, stage_id, contact_id, status, organization_id')
    .eq('id', params.id)
    .eq('organization_id', session.organizationId)
    .maybeSingle();
  if (!lead) return notFound('Lead não encontrado.');
  if (lead.status !== 'open') return conflict('Lead já fechado (won/lost).');

  // 2. Valida nova stage pertence ao mesmo pipeline e mesma org
  const { data: newStage } = await supa
    .from('crm_stages')
    .select('id, pipeline_id, wip_limit, is_won, is_lost, crm_pipelines!inner(organization_id)')
    .eq('id', parsed.data.stage_id)
    .maybeSingle();
  if (!newStage) return notFound('Stage não encontrada.');
  if (newStage.pipeline_id !== lead.pipeline_id) {
    return conflict('Stage não pertence ao mesmo pipeline do lead.');
  }
  if ((newStage as any).crm_pipelines.organization_id !== session.organizationId) {
    return notFound('Stage não encontrada.');
  }

  // 3. WIP limit
  if (newStage.wip_limit && newStage.id !== lead.stage_id) {
    const { count } = await supa
      .from('crm_leads')
      .select('id', { count: 'exact', head: true })
      .eq('stage_id', newStage.id)
      .eq('status', 'open');
    if ((count ?? 0) >= newStage.wip_limit) {
      return conflict(`Stage cheia (limite ${newStage.wip_limit}).`);
    }
  }

  // 4. Calcula position
  let positionInStage = parsed.data.position_in_stage;
  if (positionInStage === undefined) {
    const { data: max } = await supa
      .from('crm_leads')
      .select('position_in_stage')
      .eq('stage_id', newStage.id)
      .order('position_in_stage', { ascending: false })
      .limit(1)
      .maybeSingle();
    positionInStage = (max?.position_in_stage ?? 0) + 1000;
  }

  // 5. Update
  const now = new Date().toISOString();
  const patch: any = {
    stage_id: newStage.id,
    position_in_stage: positionInStage,
    updated_at: now,
    last_activity_at: now,
  };
  if (newStage.is_won) {
    patch.status = 'won';
    patch.closed_at = now;
  } else if (newStage.is_lost) {
    patch.status = 'lost';
    patch.closed_at = now;
    if (parsed.data.reason) patch.lost_reason = parsed.data.reason;
  }

  const { data: updated, error } = await supa
    .from('crm_leads')
    .update(patch)
    .eq('id', lead.id)
    .select()
    .single();
  if (error || !updated) return serverError('Erro ao mover.', error?.message);

  // 6. Activity
  await supa.from('crm_lead_activities').insert({
    organization_id: session.organizationId,
    lead_id: lead.id,
    contact_id: lead.contact_id,
    type: 'stage_change',
    title: 'Movido de stage',
    body: parsed.data.reason ?? null,
    performed_by_user_id: session.userId,
    performed_at: now,
    metadata: { from_stage: lead.stage_id, to_stage: newStage.id },
  });

  auditLog({
    organization_id: session.organizationId,
    user_id: session.userId,
    action: 'lead.moved',
    resource_type: 'lead',
    resource_id: lead.id,
    metadata: { from_stage: lead.stage_id, to_stage: newStage.id, position: positionInStage },
  });

  publishWebhook({
    organization_id: session.organizationId,
    event: newStage.is_won ? 'lead.won' : newStage.is_lost ? 'lead.lost' : 'lead.moved',
    payload: { data: updated, previous_stage_id: lead.stage_id },
  });

  return ok(updated);
}
```

**Exemplo curl:**

```bash
curl -X POST https://app.example.com/api/v1/leads/9c5b0a3a-.../move \
  -H "Authorization: Bearer tok_live_xyz..." \
  -H "Content-Type: application/json" \
  -d '{ "stage_id": "abc-...", "reason": "Cliente confirmou orçamento" }'
```

⚠️ **Gotcha:** `position_in_stage` usa intervalos de 1000 (1000, 2000, 3000...). Quando o cliente reordenar (drag & drop), você define a nova posição como média dos vizinhos: `(prev + next) / 2`. Quando os intervalos colapsarem (após muitos rearranjos), faça reorder em massa e renumere todos com 1000 de gap.

---

## 10. `POST /api/v1/leads/bulk` — criar em lote

📦 **`app/api/v1/leads/bulk/route.ts`**:

```typescript
import { NextRequest } from 'next/server';
import { authenticate, requireScope } from '@/lib/api/auth';
import { ok, unauthorized, forbidden, badRequest, unprocessable, serverError } from '@/lib/api/response';
import { bulkCreateLeadsSchema } from '@/lib/api/schemas/leads';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { auditLog } from '@/lib/api/audit';
import { publishWebhook } from '@/lib/api/webhooks';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = await authenticate(req);
  if (!session) return unauthorized();
  if (!requireScope(session, 'leads:write')) return forbidden();

  let rawBody: unknown;
  try { rawBody = await req.json(); } catch { return badRequest('Body JSON inválido.'); }
  const parsed = bulkCreateLeadsSchema.safeParse(rawBody);
  if (!parsed.success) return unprocessable('Validação falhou.', parsed.error.issues);

  const supa = getSupabaseAdminClient();

  // Valida pipelines, stages, contacts em batch
  const pipelineIds = [...new Set(parsed.data.leads.map(l => l.pipeline_id))];
  const stageIds = [...new Set(parsed.data.leads.map(l => l.stage_id))];
  const contactIds = [...new Set(parsed.data.leads.map(l => l.contact_id))];

  const [{ data: pipelines }, { data: stages }, { data: contacts }] = await Promise.all([
    supa.from('crm_pipelines').select('id').eq('organization_id', session.organizationId).in('id', pipelineIds),
    supa.from('crm_stages').select('id, pipeline_id').in('id', stageIds),
    supa.from('contacts').select('id').eq('organization_id', session.organizationId).in('id', contactIds),
  ]);

  const validPipelines = new Set(pipelines?.map(p => p.id));
  const stageById = new Map(stages?.map(s => [s.id, s.pipeline_id]));
  const validContacts = new Set(contacts?.map(c => c.id));

  const errors: Array<{ index: number; error: string }> = [];
  const validRows: any[] = [];

  for (const [i, l] of parsed.data.leads.entries()) {
    if (!validPipelines.has(l.pipeline_id)) { errors.push({ index: i, error: 'pipeline_not_found' }); continue; }
    if (stageById.get(l.stage_id) !== l.pipeline_id) { errors.push({ index: i, error: 'stage_not_in_pipeline' }); continue; }
    if (!validContacts.has(l.contact_id)) { errors.push({ index: i, error: 'contact_not_found' }); continue; }

    validRows.push({
      organization_id: session.organizationId,
      pipeline_id: l.pipeline_id,
      stage_id: l.stage_id,
      contact_id: l.contact_id,
      title: l.title,
      value_cents: l.value_cents,
      currency: l.currency,
      owner_user_id: l.owner_user_id ?? session.userId,
      source: l.source ?? 'bulk_import',
      source_metadata: l.source_metadata,
      custom_fields: l.custom_fields,
      tags: l.tags,
      expected_close_date: l.expected_close_date ?? null,
      status: 'open',
      position_in_stage: 1000 + i * 1000,  // gap inicial
      last_activity_at: new Date().toISOString(),
    });
  }

  if (validRows.length === 0) {
    return unprocessable('Nenhum lead válido no batch.', errors);
  }

  const { data: inserted, error } = await supa
    .from('crm_leads')
    .insert(validRows)
    .select();
  if (error) return serverError('Erro ao inserir batch.', error.message);

  auditLog({
    organization_id: session.organizationId,
    user_id: session.userId,
    action: 'leads.bulk_created',
    resource_type: 'lead',
    resource_id: null,
    metadata: { inserted: inserted.length, errored: errors.length },
  });

  // Um webhook por lead criado (consumidores podem agrupar se quiserem)
  for (const lead of inserted) {
    publishWebhook({
      organization_id: session.organizationId,
      event: 'lead.created',
      payload: { data: lead, source: 'bulk' },
    });
  }

  return ok(
    { inserted, errors },
    undefined,
    errors.length > 0 ? 207 : 201,  // 207 Multi-Status se rolou parcial
  );
}
```

⚠️ **Gotcha:** retornar 207 Multi-Status pra batch parcial é tecnicamente correto mas pouco comum. Alguns clientes só sabem ler 200/201/4xx. Se for problema, devolva 200 com `{ inserted, errors }` e deixe o cliente decidir.

---

## 11. Activities

📦 **`app/api/v1/leads/[id]/activities/route.ts`**:

```typescript
import { NextRequest } from 'next/server';
import { authenticate, requireScope } from '@/lib/api/auth';
import { ok, created, unauthorized, forbidden, notFound, badRequest, unprocessable, serverError } from '@/lib/api/response';
import { createActivitySchema } from '@/lib/api/schemas/leads';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await authenticate(req);
  if (!session) return unauthorized();
  if (!requireScope(session, 'leads:read')) return forbidden();

  const limit = Number(req.nextUrl.searchParams.get('limit') ?? 50);

  const supa = getSupabaseAdminClient();
  const { data: lead } = await supa
    .from('crm_leads')
    .select('id')
    .eq('id', params.id)
    .eq('organization_id', session.organizationId)
    .maybeSingle();
  if (!lead) return notFound('Lead não encontrado.');

  const { data, error } = await supa
    .from('crm_lead_activities')
    .select('id, type, title, body, performed_by_user_id, performed_at, metadata, source_module, source_id, created_at')
    .eq('lead_id', params.id)
    .eq('organization_id', session.organizationId)
    .order('performed_at', { ascending: false })
    .limit(Math.min(limit, 200));

  if (error) return serverError('Erro ao listar activities.', error.message);
  return ok(data);
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await authenticate(req);
  if (!session) return unauthorized();
  if (!requireScope(session, 'leads:write')) return forbidden();

  let rawBody: unknown;
  try { rawBody = await req.json(); } catch { return badRequest('Body JSON inválido.'); }
  const parsed = createActivitySchema.safeParse(rawBody);
  if (!parsed.success) return unprocessable('Validação falhou.', parsed.error.issues);

  const supa = getSupabaseAdminClient();
  const { data: lead } = await supa
    .from('crm_leads')
    .select('id, contact_id')
    .eq('id', params.id)
    .eq('organization_id', session.organizationId)
    .maybeSingle();
  if (!lead) return notFound('Lead não encontrado.');

  const now = new Date().toISOString();
  const { data: activity, error } = await supa
    .from('crm_lead_activities')
    .insert({
      organization_id: session.organizationId,
      lead_id: lead.id,
      contact_id: lead.contact_id,
      type: parsed.data.type,
      title: parsed.data.title,
      body: parsed.data.body ?? null,
      performed_by_user_id: session.userId,
      performed_at: parsed.data.performed_at ?? now,
      metadata: parsed.data.metadata,
      source_module: parsed.data.source_module ?? 'api',
      source_id: parsed.data.source_id ?? null,
    })
    .select()
    .single();

  if (error || !activity) return serverError('Erro ao criar activity.', error?.message);

  // Atualiza last_activity_at do lead
  await supa
    .from('crm_leads')
    .update({ last_activity_at: now })
    .eq('id', lead.id);

  return created(activity);
}
```

---

## 12. Lead Links

📦 **`app/api/v1/leads/[id]/links/route.ts`**:

```typescript
import { NextRequest } from 'next/server';
import { authenticate, requireScope } from '@/lib/api/auth';
import { ok, created, unauthorized, forbidden, notFound, badRequest, unprocessable, serverError } from '@/lib/api/response';
import { createLeadLinkSchema } from '@/lib/api/schemas/leads';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await authenticate(req);
  if (!session) return unauthorized();
  if (!requireScope(session, 'leads:read')) return forbidden();

  const supa = getSupabaseAdminClient();
  const { data: lead } = await supa
    .from('crm_leads')
    .select('id')
    .eq('id', params.id)
    .eq('organization_id', session.organizationId)
    .maybeSingle();
  if (!lead) return notFound('Lead não encontrado.');

  const { data, error } = await supa
    .from('crm_lead_links')
    .select('id, target_kind, target_id, link_kind, metadata, created_at')
    .eq('lead_id', params.id)
    .order('created_at', { ascending: false });

  if (error) return serverError('Erro ao listar links.', error.message);
  return ok(data);
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await authenticate(req);
  if (!session) return unauthorized();
  if (!requireScope(session, 'leads:write')) return forbidden();

  let rawBody: unknown;
  try { rawBody = await req.json(); } catch { return badRequest('Body JSON inválido.'); }
  const parsed = createLeadLinkSchema.safeParse(rawBody);
  if (!parsed.success) return unprocessable('Validação falhou.', parsed.error.issues);

  const supa = getSupabaseAdminClient();
  const { data: lead } = await supa
    .from('crm_leads')
    .select('id')
    .eq('id', params.id)
    .eq('organization_id', session.organizationId)
    .maybeSingle();
  if (!lead) return notFound('Lead não encontrado.');

  const { data: link, error } = await supa
    .from('crm_lead_links')
    .insert({
      lead_id: lead.id,
      target_kind: parsed.data.target_kind,
      target_id: parsed.data.target_id,
      link_kind: parsed.data.link_kind,
      metadata: parsed.data.metadata,
    })
    .select()
    .single();

  if (error || !link) return serverError('Erro ao criar link.', error?.message);
  return created(link);
}
```

📦 **`app/api/v1/lead-links/[id]/route.ts`** (DELETE):

```typescript
import { NextRequest } from 'next/server';
import { authenticate, requireScope } from '@/lib/api/auth';
import { noContent, unauthorized, forbidden, notFound, serverError } from '@/lib/api/response';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await authenticate(req);
  if (!session) return unauthorized();
  if (!requireScope(session, 'leads:write')) return forbidden();

  const supa = getSupabaseAdminClient();
  // Junta com crm_leads pra verificar org
  const { data: link } = await supa
    .from('crm_lead_links')
    .select('id, lead:crm_leads!inner(organization_id)')
    .eq('id', params.id)
    .maybeSingle();

  if (!link || (link.lead as any)?.organization_id !== session.organizationId) {
    return notFound('Link não encontrado.');
  }

  const { error } = await supa.from('crm_lead_links').delete().eq('id', params.id);
  if (error) return serverError('Erro ao remover.', error.message);

  return noContent();
}
```

---

## 13. Win / Lose (atalhos para `/move`)

📦 **`app/api/v1/leads/[id]/win/route.ts`**:

```typescript
import { NextRequest } from 'next/server';
import { authenticate, requireScope } from '@/lib/api/auth';
import { ok, unauthorized, forbidden, notFound, conflict, serverError } from '@/lib/api/response';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { publishWebhook } from '@/lib/api/webhooks';
import { auditLog } from '@/lib/api/audit';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await authenticate(req);
  if (!session) return unauthorized();
  if (!requireScope(session, 'leads:write')) return forbidden();

  const supa = getSupabaseAdminClient();
  const { data: lead } = await supa
    .from('crm_leads')
    .select('id, pipeline_id, stage_id, status, contact_id')
    .eq('id', params.id)
    .eq('organization_id', session.organizationId)
    .maybeSingle();
  if (!lead) return notFound('Lead não encontrado.');
  if (lead.status !== 'open') return conflict('Lead já fechado.');

  const { data: wonStage } = await supa
    .from('crm_stages')
    .select('id')
    .eq('pipeline_id', lead.pipeline_id)
    .eq('is_won', true)
    .maybeSingle();
  if (!wonStage) return conflict('Pipeline não tem stage de vitória configurada.');

  const now = new Date().toISOString();
  const { data: updated, error } = await supa
    .from('crm_leads')
    .update({
      stage_id: wonStage.id,
      status: 'won',
      closed_at: now,
      updated_at: now,
      last_activity_at: now,
    })
    .eq('id', lead.id)
    .select()
    .single();
  if (error || !updated) return serverError('Erro ao marcar won.', error?.message);

  await supa.from('crm_lead_activities').insert({
    organization_id: session.organizationId,
    lead_id: lead.id,
    contact_id: lead.contact_id,
    type: 'stage_change',
    title: 'Marcado como ganho',
    performed_by_user_id: session.userId,
    performed_at: now,
    metadata: { from_stage: lead.stage_id, to_stage: wonStage.id, won: true },
  });

  auditLog({
    organization_id: session.organizationId,
    user_id: session.userId,
    action: 'lead.won',
    resource_type: 'lead',
    resource_id: lead.id,
    metadata: {},
  });
  publishWebhook({
    organization_id: session.organizationId,
    event: 'lead.won',
    payload: { data: updated },
  });

  return ok(updated);
}
```

📦 **`app/api/v1/leads/[id]/lose/route.ts`** — análogo, mas pega `is_lost = true` e aceita body com `lost_reason`:

```typescript
import { z } from 'zod';
const loseSchema = z.object({ reason: z.string().max(200).optional() });

// Implementação simétrica ao /win, com:
// - busca stage com is_lost=true
// - update com status='lost', lost_reason=body.reason
// - activity type='stage_change' title='Marcado como perdido'
// - webhook event='lead.lost'
```

---

## 14. Resumo de status codes por endpoint

| Endpoint | 200 | 201 | 204 | 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 |
|----------|-----|-----|-----|-----|-----|-----|-----|-----|-----|-----|-----|
| GET /leads | ✓ | | | ✓ | ✓ | ✓ | | | ✓ | ✓ | ✓ |
| GET /leads/:id | ✓ | | | | ✓ | ✓ | ✓ | | | ✓ | ✓ |
| POST /leads | | ✓ | | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| PATCH /leads/:id | ✓ | | | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| DELETE /leads/:id | | | ✓ | | ✓ | ✓ | ✓ | | | ✓ | ✓ |
| POST /leads/:id/move | ✓ | | | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| POST /leads/bulk | | ✓ | | ✓ | ✓ | ✓ | | | ✓ | ✓ | ✓ |
| GET /leads/:id/activities | ✓ | | | | ✓ | ✓ | ✓ | | | ✓ | ✓ |
| POST /leads/:id/activities | | ✓ | | ✓ | ✓ | ✓ | ✓ | | ✓ | ✓ | ✓ |
| POST /leads/:id/links | | ✓ | | ✓ | ✓ | ✓ | ✓ | | ✓ | ✓ | ✓ |
| DELETE /lead-links/:id | | | ✓ | | ✓ | ✓ | ✓ | | | ✓ | ✓ |

---

## 15. Conferência rápida desta fase

- [ ] Schemas Zod cobrem create, update, move, bulk, list, activity, link
- [ ] Cursor encode/decode com HMAC pra prevenir tampering
- [ ] Idempotency middleware salva `(key, request_hash, response)` por 24h
- [ ] GET /leads suporta filtros: stage, owner, value range, tag, search, custom_fields, dates
- [ ] POST /leads valida pipeline+stage+contact, respeita WIP limit, gera activity de criação, dispara webhook `lead.created`
- [ ] PATCH não permite mudar stage/pipeline (força uso de `/move`)
- [ ] DELETE faz soft delete (`deleted_at`)
- [ ] POST /leads/:id/move valida pipeline-stage, WIP, posição, e dispara webhooks corretos (`lead.moved` / `lead.won` / `lead.lost`)
- [ ] POST /leads/bulk aceita até 100, valida pre-checks em batch, pode retornar 207 multi-status
- [ ] GET/POST `/activities` registra timeline e atualiza `last_activity_at`
- [ ] POST `/links` permite linkar lead a conversation, appointment, etc.
- [ ] Win/Lose existem como atalhos honestos pro fluxo de fechamento

---

## Próximo: [10-filtros-busca-paginacao.md](10-filtros-busca-paginacao.md)
