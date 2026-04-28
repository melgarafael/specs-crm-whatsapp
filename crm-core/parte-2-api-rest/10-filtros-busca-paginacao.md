# 10 — Filtros, busca e paginação

> **Resumo:** todos os filtros suportados em `GET /api/v1/leads` (e como reaproveitar em outros recursos). Operadores, full-text search, ordering, encoding/decoding de cursor com HMAC, fallback page-based, performance (indexes obrigatórios), filtragem em jsonb (`custom_fields`) e exemplo end-to-end de uma query "real" complexa.

---

## 1. Filosofia de filtros

A regra de ouro: **nunca obrigue o cliente a baixar 1.000 leads pra filtrar localmente**. Se o uso é razoável, o servidor filtra.

Mas: **nunca aceite query string que mude o shape do response**. Filtros restringem linhas, nunca mudam colunas. Pra projeção dinâmica, use `?fields=id,title,value_cents` (opcional, fora do escopo desta aula).

🎯 **Decisão:** filtros são todos opcionais. Sem nenhum filtro, `GET /api/v1/leads` lista todos os leads abertos da org, ordenados por `created_at desc`, primeiros 25.

---

## 2. Tabela completa de filtros

| Query param | Operador | Tipo | Coluna alvo | Exemplo |
|-------------|---------|------|-------------|---------|
| `pipeline_id` | eq | uuid | `pipeline_id` | `?pipeline_id=abc-123` |
| `stage_id` | eq | uuid | `stage_id` | `?stage_id=def-456` |
| `owner` | eq | uuid | `owner_user_id` | `?owner=user-789` |
| `contact_id` | eq | uuid | `contact_id` | `?contact_id=...` |
| `status` | eq | enum | `status` | `?status=open` |
| `source` | eq | text | `source` | `?source=whatsapp_inbound` |
| `tag` | array contains | text | `tags` | `?tag=enterprise` |
| `search` | ILIKE | text | `title` | `?search=acme` |
| `value_min` | gte | int | `value_cents` | `?value_min=50000` |
| `value_max` | lte | int | `value_cents` | `?value_max=500000` |
| `created_after` | gte | timestamptz | `created_at` | `?created_after=2026-01-01T00:00:00Z` |
| `created_before` | lte | timestamptz | `created_at` | `?created_before=2026-04-30T23:59:59Z` |
| `last_activity_after` | gte | timestamptz | `last_activity_at` | `?last_activity_after=2026-04-21T00:00:00Z` |
| `closed_after` | gte | timestamptz | `closed_at` | `?closed_after=...` |
| `expected_close_after` | gte | date | `expected_close_date` | `?expected_close_after=2026-05-01` |
| `expected_close_before` | lte | date | `expected_close_date` | `?expected_close_before=2026-05-31` |
| `custom_field[KEY]` | jsonb @> | dynamic | `custom_fields` | `?custom_field[plano]=premium` |
| `has_lost_reason` | not null | bool | `lost_reason` | `?has_lost_reason=true` |
| `is_overdue` | computed | bool | derivado | `?is_overdue=true` |

⚠️ **Gotcha:** filtros booleanos como `is_overdue` (lead com `expected_close_date` no passado e ainda `open`) são *computados*, não colunas. Implemente como `WHERE expected_close_date < now() AND status = 'open'`. Se for usado muito, vire view ou coluna gerada.

---

## 3. Operadores adicionais (opcionais, padrão Stripe-like)

Pra filtros de range/list não-óbvios, ofereça notação `?campo[op]=valor`:

| Notação | Significado | SQL |
|---------|-------------|-----|
| `?value_cents[gt]=10000` | greater than | `value_cents > 10000` |
| `?value_cents[lt]=50000` | less than | `value_cents < 50000` |
| `?value_cents[gte]=10000` | greater or equal | `value_cents >= 10000` |
| `?value_cents[lte]=50000` | less or equal | `value_cents <= 50000` |
| `?status[in]=open,won` | array IN | `status IN ('open', 'won')` |
| `?tags[contains]=enterprise` | array contains | `tags @> ARRAY['enterprise']` |
| `?title[ilike]=acme%` | case-insensitive LIKE | `title ILIKE 'acme%'` |

🎯 **Decisão:** começar com os atalhos do arquivo 09 (`value_min`/`value_max`, `created_after`/`created_before`). Adicionar `[op]=` notation só se cliente real precisar — gera complexidade de parser.

📦 **Parser opcional** (`lib/api/filters.ts`):

```typescript
export interface FilterOp {
  column: string;
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains' | 'ilike';
  value: any;
}

const OP_MAP: Record<string, FilterOp['op']> = {
  eq: 'eq', neq: 'neq', gt: 'gt', gte: 'gte', lt: 'lt', lte: 'lte',
  in: 'in', contains: 'contains', ilike: 'ilike',
};

export function parseFilters(searchParams: URLSearchParams, allowedColumns: Set<string>): FilterOp[] {
  const out: FilterOp[] = [];
  for (const [k, v] of searchParams.entries()) {
    const m = k.match(/^([a-z_]+)\[([a-z]+)\]$/);
    if (!m) continue;
    const [, col, opShort] = m;
    if (!allowedColumns.has(col)) continue;
    const op = OP_MAP[opShort];
    if (!op) continue;
    out.push({
      column: col,
      op,
      value: op === 'in' ? v.split(',') : v,
    });
  }
  return out;
}

export function applyFilters(query: any, filters: FilterOp[]) {
  for (const f of filters) {
    switch (f.op) {
      case 'eq': query = query.eq(f.column, f.value); break;
      case 'neq': query = query.neq(f.column, f.value); break;
      case 'gt': query = query.gt(f.column, f.value); break;
      case 'gte': query = query.gte(f.column, f.value); break;
      case 'lt': query = query.lt(f.column, f.value); break;
      case 'lte': query = query.lte(f.column, f.value); break;
      case 'in': query = query.in(f.column, f.value); break;
      case 'contains': query = query.contains(f.column, [f.value]); break;
      case 'ilike': query = query.ilike(f.column, f.value); break;
    }
  }
  return query;
}
```

---

## 4. Filtragem em `custom_fields` (jsonb)

CRMs nichados vivem disso. Cada nicho mete campos diferentes em `custom_fields`. A API tem que filtrar por eles sem schema mudando.

### 4.1. Notação

```
GET /api/v1/leads?custom_field[plano]=premium&custom_field[industria]=saude
```

### 4.2. Implementação (Postgres `@>`)

```sql
SELECT * FROM crm_leads
WHERE organization_id = $1
  AND custom_fields @> '{"plano": "premium", "industria": "saude"}'::jsonb
ORDER BY created_at DESC
LIMIT 25;
```

O operador `@>` (containment) é eficientíssimo se você tiver GIN index:

```sql
CREATE INDEX crm_leads_custom_fields_gin ON public.crm_leads USING gin (custom_fields);
```

### 4.3. Conversão Supabase JS

```typescript
// Cliente manda ?custom_field[plano]=premium&custom_field[industria]=saude
const customFilter: Record<string, string> = {};
for (const [k, v] of req.nextUrl.searchParams.entries()) {
  const m = k.match(/^custom_field\[(.+)\]$/);
  if (m) customFilter[m[1]] = v;
}

// Aplica como containment
if (Object.keys(customFilter).length > 0) {
  query = query.contains('custom_fields', customFilter);
}
```

⚠️ **Gotcha 1:** `@>` testa **igualdade exata**. Pra texto parcial em jsonb (`plano LIKE '%premium%'`), você usa `custom_fields->>'plano' ILIKE '%premium%'` — mas isso quebra o GIN index. Decida: equality (rápido, GIN-friendly) ou parcial (devagar, full scan).

⚠️ **Gotcha 2:** valores em URL são sempre string. Se `custom_fields.idade = 30` (número), o filtro `?custom_field[idade]=30` vai virar `{"idade": "30"}` e NÃO vai bater. Convenção: armazene tudo como string em custom_fields, OU implemente coerção explícita (cliente envia `?custom_field[idade]:int=30`).

---

## 5. Busca full-text

Busca por palavra em `title`, `body` de activities, `notes` de contact. Postgres tem `tsvector`/`tsquery` nativo — use isso, não ILIKE no varchar grande.

### 5.1. Setup

```sql
-- Coluna gerada
ALTER TABLE crm_leads
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('portuguese',
      coalesce(title, '') || ' ' ||
      coalesce(source, '') || ' ' ||
      array_to_string(tags, ' ')
    )
  ) STORED;

CREATE INDEX crm_leads_search_idx ON crm_leads USING gin (search_vector);
```

Pra `crm_lead_activities`:

```sql
ALTER TABLE crm_lead_activities
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('portuguese',
      coalesce(title, '') || ' ' || coalesce(body, '')
    )
  ) STORED;

CREATE INDEX crm_lead_activities_search_idx ON crm_lead_activities USING gin (search_vector);
```

🎯 **Decisão:** dicionário `'portuguese'` (ajuste pro idioma da sua base). Se a org for multi-idioma, use `'simple'` (só normaliza, não derruba sufixos).

### 5.2. Query

```typescript
// ?search=acme%20saude
const search = req.nextUrl.searchParams.get('search');
if (search) {
  const tsQuery = search.split(/\s+/).filter(Boolean).join(' & ');
  // Supabase JS não tem tsquery direto — usa rpc ou literal SQL
  query = query.textSearch('search_vector', tsQuery, {
    type: 'plain',
    config: 'portuguese',
  });
}
```

📦 **Endpoint dedicado pra search global** (across leads + activities):

```typescript
// app/api/v1/search/route.ts
export async function GET(req: NextRequest) {
  const session = await authenticate(req);
  if (!session) return unauthorized();

  const q = req.nextUrl.searchParams.get('q');
  if (!q || q.length < 2) return badRequest('Query muito curta.');

  const supa = getSupabaseAdminClient();
  const tsQuery = q.split(/\s+/).filter(Boolean).join(' & ');

  const [leads, activities] = await Promise.all([
    supa
      .from('crm_leads')
      .select('id, title, value_cents, status, stage_id')
      .eq('organization_id', session.organizationId)
      .textSearch('search_vector', tsQuery, { type: 'plain', config: 'portuguese' })
      .limit(10),
    supa
      .from('crm_lead_activities')
      .select('id, lead_id, type, title, body, performed_at')
      .eq('organization_id', session.organizationId)
      .textSearch('search_vector', tsQuery, { type: 'plain', config: 'portuguese' })
      .limit(10),
  ]);

  return ok({
    leads: leads.data ?? [],
    activities: activities.data ?? [],
  });
}
```

⚠️ **Gotcha:** `textSearch` do Supabase JS não escapa caracteres `&`, `|`, `!` que têm significado em tsquery. Sanitize antes de juntar com `' & '`.

---

## 6. Ordering

| `order_by` | `order_dir` default | Útil pra |
|-----------|---------------------|----------|
| `created_at` | desc | Ver leads mais novos |
| `updated_at` | desc | Ver mexidos recentemente |
| `last_activity_at` | desc | Foco em quem teve interação |
| `value_cents` | desc | Maior ticket primeiro |
| `position_in_stage` | asc | Ordem do kanban |
| `expected_close_date` | asc | Próximos a fechar |

Sempre adicione `id` como tie-breaker secundário pra cursor pagination ser determinística:

```typescript
query = query
  .order(orderBy, { ascending: orderDir === 'asc' })
  .order('id', { ascending: orderDir === 'asc' });
```

⚠️ **Gotcha:** sem tie-breaker, leads com mesmo `created_at` (impossível? não — bulk insert dá colisão) podem aparecer/sumir entre páginas. ID resolve.

---

## 7. Cursor: encoding com HMAC

Já vimos a função `encodeCursor`/`decodeCursor` no doc anterior. Vamos detalhar **por quê HMAC**.

Cliente NÃO deve interpretar o cursor. Mas se você só usar base64 puro:

```
?cursor=eyJ0cyI6IjIwMjYtMDQtMjhUMTQ6MzAiLCJpZCI6ImFiYy0xMjMifQ==
```

Decoda fácil → cliente aprende internals → 6 meses depois você muda formato → todo cliente quebra.

Pior: cliente pode **adulterar**. Mete `ts: '1970-01-01'` e vê tudo. Com 100 reqs em paralelo, vira ataque de enumeração.

🎯 **Decisão:** cursor = `base64url(payload).hmac_sha256(payload)` — primeiros 16 chars da assinatura colados com ponto.

```typescript
import crypto from 'crypto';

const SECRET = process.env.CURSOR_SECRET!;

export function encodeCursor(payload: { ts: string; id: string; v: number }): string {
  const json = JSON.stringify(payload);
  const body = Buffer.from(json).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url').slice(0, 16);
  return `${body}.${sig}`;
}

export function decodeCursor(cursor: string): { ts: string; id: string; v: number } | null {
  const [body, sig] = cursor.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url').slice(0, 16);
  if (sig !== expected) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch { return null; }
}
```

`v: 1` permite evoluir o shape no futuro: você bumps pra `v: 2`, decoder reconhece, traduz.

⚠️ **Gotcha:** rotacione `CURSOR_SECRET` pode invalidar cursors em uso. Aceitável (próxima request o cliente refaz desde o início).

---

## 8. Aplicando o cursor na query

A parte chata: traduzir `(ts, id)` em WHERE clauses.

Para ordering `created_at DESC`, você quer linhas com:

```
created_at < cursor.ts
  OR (created_at = cursor.ts AND id < cursor.id)
```

Em Supabase JS:

```typescript
if (q.cursor) {
  const c = decodeCursor(q.cursor);
  if (!c) return badRequest('Cursor inválido.');
  if (q.order_dir === 'desc') {
    query = query.or(
      `${q.order_by}.lt.${c.ts},and(${q.order_by}.eq.${c.ts},id.lt.${c.id})`
    );
  } else {
    query = query.or(
      `${q.order_by}.gt.${c.ts},and(${q.order_by}.eq.${c.ts},id.gt.${c.id})`
    );
  }
}
```

Pegue `limit + 1`, fatie, e gere o próximo cursor a partir do último item retornado:

```typescript
query = query.limit(q.limit + 1);
const { data } = await query;
const hasMore = data.length > q.limit;
const items = hasMore ? data.slice(0, q.limit) : data;
const last = items[items.length - 1];
const nextCursor = hasMore && last
  ? encodeCursor({ ts: String(last[q.order_by]), id: last.id, v: 1 })
  : null;
```

---

## 9. Fallback page-based (opcional)

Algumas integrações dumb (planilhas, Zapier antigo) só sabem `page=1, page=2, ...`. Aceite, mas avise no docs que é desencorajado:

```typescript
const page = Number(req.nextUrl.searchParams.get('page')) || null;
const perPage = Math.min(Number(req.nextUrl.searchParams.get('per_page')) || 25, 100);

if (page !== null) {
  const from = (page - 1) * perPage;
  const to = from + perPage - 1;
  query = query.range(from, to);

  // Pra retornar total, mete count: 'exact' (custa um SELECT count)
  query = query.select('*', { count: 'exact' });
}
```

⚠️ **Gotcha:** `count: 'exact'` em tabela com >1M leads é lento (full scan). Use `count: 'estimated'` (rápido mas só estimativa do planner) ou `count: 'planned'`.

🎯 **Decisão:** ofereça page-based só em GET /leads. Não propague em outros recursos.

---

## 10. Indexes obrigatórios

Sem isso, sua API é lenta a partir de 10k leads.

```sql
-- Já existem implícitos pela PK e FKs, mas explicite os compostos:

-- Lista por org + filtros comuns
CREATE INDEX crm_leads_org_status_idx ON crm_leads (organization_id, status, created_at DESC);
CREATE INDEX crm_leads_org_pipeline_idx ON crm_leads (organization_id, pipeline_id, stage_id, position_in_stage);
CREATE INDEX crm_leads_org_owner_idx ON crm_leads (organization_id, owner_user_id, created_at DESC);
CREATE INDEX crm_leads_org_contact_idx ON crm_leads (organization_id, contact_id);

-- Search
CREATE INDEX crm_leads_search_idx ON crm_leads USING gin (search_vector);
CREATE INDEX crm_leads_tags_idx ON crm_leads USING gin (tags);
CREATE INDEX crm_leads_custom_fields_idx ON crm_leads USING gin (custom_fields);

-- Activities timeline
CREATE INDEX crm_lead_activities_lead_perf_idx
  ON crm_lead_activities (lead_id, performed_at DESC);
CREATE INDEX crm_lead_activities_search_idx
  ON crm_lead_activities USING gin (search_vector);

-- Lead links
CREATE INDEX crm_lead_links_lead_idx ON crm_lead_links (lead_id);
CREATE INDEX crm_lead_links_target_idx ON crm_lead_links (target_kind, target_id);

-- Soft delete: filtros sempre ignoram deletados
CREATE INDEX crm_leads_org_active_idx ON crm_leads (organization_id, created_at DESC)
  WHERE deleted_at IS NULL;
```

Verifique no Supabase Studio → Database → Indexes. Use `EXPLAIN ANALYZE` em queries lentas.

⚠️ **Gotcha:** index parcial `WHERE deleted_at IS NULL` requer que TODA query da listagem inclua o predicado idêntico. Se você esquecer e fizer `SELECT * WHERE organization_id = ...` sem `AND deleted_at IS NULL`, o index parcial não é usado.

---

## 11. Exemplo end-to-end: a query "real" complexa

> "Liste leads no estágio 'Em negociação' do pipeline padrão, do owner Maria, com value > R$ 5.000, tag 'enterprise', criados nos últimos 30 dias, ordenados por última atividade desc."

**URL:**

```
GET /api/v1/leads
  ?stage_id=def-456
  &owner=maria-uuid
  &value_min=500000
  &tag=enterprise
  &created_after=2026-03-29T00:00:00Z
  &order_by=last_activity_at
  &order_dir=desc
  &limit=20
```

**SQL gerada (aproximação):**

```sql
SELECT id, organization_id, pipeline_id, stage_id, contact_id, title,
       value_cents, currency, status, owner_user_id, source, custom_fields,
       tags, position_in_stage, expected_close_date,
       created_at, updated_at, last_activity_at, closed_at, lost_reason
FROM crm_leads
WHERE organization_id = $1
  AND deleted_at IS NULL
  AND stage_id = 'def-456'
  AND owner_user_id = 'maria-uuid'
  AND value_cents >= 500000
  AND tags @> ARRAY['enterprise']::text[]
  AND created_at >= '2026-03-29T00:00:00Z'
ORDER BY last_activity_at DESC, id DESC
LIMIT 21;
```

**Response:**

```json
{
  "data": [
    {
      "id": "9c5b...",
      "title": "Acme Corp — Renovação Anual",
      "value_cents": 1200000,
      "currency": "BRL",
      "status": "open",
      "stage_id": "def-456",
      "owner_user_id": "maria-uuid",
      "tags": ["enterprise", "renewal"],
      "custom_fields": {"plano": "premium"},
      "last_activity_at": "2026-04-27T18:23:00Z",
      "created_at": "2026-04-15T10:00:00Z"
    }
    /* ... mais 19 leads ... */
  ],
  "meta": {
    "cursor": "eyJ0cyI6IjIwMjYtMDQtMjJUMTI6MTU6MDBaIiwiaWQiOiIxYTJiM2M0ZCIsInYiOjF9.5d7bf3a8e2f4a1c0",
    "has_more": true
  }
}
```

**Próxima página:**

```
GET /api/v1/leads
  ?stage_id=def-456
  &owner=maria-uuid
  &value_min=500000
  &tag=enterprise
  &created_after=2026-03-29T00:00:00Z
  &order_by=last_activity_at
  &order_dir=desc
  &limit=20
  &cursor=eyJ0cyI6IjIwMjYtMDQtMjJUMTI6MTU6MDBaIiwiaWQiOiIxYTJiM2M0ZCIsInYiOjF9.5d7bf3a8e2f4a1c0
```

---

## 12. Performance: medindo

Pra cada endpoint de lista, **meça** com EXPLAIN ANALYZE no pior caso (org com muitos leads).

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM crm_leads
WHERE organization_id = '...'
  AND deleted_at IS NULL
  AND tags @> ARRAY['enterprise']
ORDER BY created_at DESC
LIMIT 25;
```

Boa: `Index Scan using crm_leads_org_active_idx`, `actual time < 5ms`.
Ruim: `Seq Scan`, `actual time > 100ms`. Falta index ou index errado.

**Métricas alvo (org com 100k leads):**

| Operação | Latência p95 alvo |
|----------|-------------------|
| GET /leads (sem filtros) | < 50ms |
| GET /leads (com 3+ filtros + cursor) | < 80ms |
| GET /leads/:id | < 20ms |
| POST /leads | < 100ms |
| PATCH /leads/:id | < 80ms |
| Search full-text | < 150ms |

---

## 13. Cache (quando faz sentido)

Listagens cacheadas? Cuidado — leads são mutáveis. Mas:

- `GET /pipelines` muda raramente → cache 5 min
- `GET /stages` muda raramente → cache 5 min
- `GET /leads/:id` se usuário faz F5 muitas vezes → ETag + 304 Not Modified

📦 **ETag pra leads/:id**:

```typescript
import crypto from 'crypto';

const etag = `W/"${crypto.createHash('sha1').update(JSON.stringify(lead)).digest('hex')}"`;
const ifNoneMatch = req.headers.get('if-none-match');
if (ifNoneMatch === etag) return new Response(null, { status: 304 });

return new Response(JSON.stringify({ data: lead }), {
  status: 200,
  headers: { 'Content-Type': 'application/json', 'ETag': etag },
});
```

⚠️ **Gotcha:** weak ETag (`W/"..."`) é ok pra response com timestamps. Strong ETag exige byte-for-byte equal — quase impossível por causa de `updated_at`.

---

## 14. Rate limit por endpoint

Limite global por user é bom. Limite por endpoint é melhor. Sugestão (RPM = requests per minute):

| Endpoint | RPM (cookie) | RPM (bearer) |
|----------|-------------|--------------|
| GET /leads | 60 | 300 |
| GET /leads/:id | 120 | 600 |
| POST /leads | 30 | 120 |
| POST /leads/bulk | 6 | 30 |
| PATCH /leads/:id | 30 | 120 |
| POST /leads/:id/move | 60 | 300 |
| GET /search | 30 | 60 |

Cookie é frontend humano (limite menor). Bearer é integração (limite maior).

Implementação no próximo arquivo: [11-auth-rate-limit-webhooks.md](11-auth-rate-limit-webhooks.md).

---

## 15. Conferência rápida desta fase

- [ ] Filtros documentados: pipeline, stage, owner, contact, status, source, tag, value range, date ranges, custom_fields
- [ ] `custom_field[KEY]=value` usa `@>` (jsonb containment) com GIN index
- [ ] Search full-text via `tsvector` em coluna gerada + GIN index
- [ ] Ordering com tie-breaker por `id`
- [ ] Cursor opaco com HMAC SHA256, base64url, versionado (`v: 1`)
- [ ] Cursor decode rejeita assinatura inválida → 400 invalid_cursor
- [ ] Page-based aceito como fallback (`?page=1&per_page=25`), só em GET /leads
- [ ] Indexes compostos cobrindo combinações comuns (org + status + created_at, org + pipeline + stage)
- [ ] GIN indexes em `tags`, `custom_fields`, `search_vector`
- [ ] Soft delete usa index parcial `WHERE deleted_at IS NULL`
- [ ] ETag em GET /leads/:id pra reduzir banda em F5
- [ ] Rate limit diferenciado por método de auth (cookie x bearer)
- [ ] Métricas alvo definidas (p95 < 50/80/100ms conforme operação)

---

## Próximo: [11-auth-rate-limit-webhooks.md](11-auth-rate-limit-webhooks.md)
