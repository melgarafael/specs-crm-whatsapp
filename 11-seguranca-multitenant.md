# 11 — Segurança e Multi-Tenant

> **Resumo:** isolamento de dados entre orgs, gestão de secrets, webhook security, encriptação at-rest, e padrões anti-vazamento. O básico que separa um CRM "MVP" de um CRM "B2B sério".

---

## 1. Os três níveis de isolamento

| Nível | O que isola | Mecanismo |
|-------|-------------|-----------|
| **Aplicação** | Tenant A não vê dado de Tenant B | RLS + filtros nas queries |
| **Sessão WAHA** | Mensagens de A não vão pra B | `waha_session_name` único + lookup correto |
| **Storage** | Mídia de A não acessível por B | Path com prefix `{org_id}` + URL assinada |

---

## 2. RLS bem feito (Row-Level Security)

### 2.1 Padrão "user pertence a org"

```sql
-- Tabela junction
create table public.user_organizations (
  user_id uuid references auth.users(id) on delete cascade,
  organization_id uuid references public.organizations(id) on delete cascade,
  role text not null default 'member',
  primary key (user_id, organization_id)
);

-- Helper imutável
create or replace function public.fn_user_org_ids()
returns table(organization_id uuid)
language sql stable security definer set search_path = public as $$
  select organization_id from public.user_organizations where user_id = auth.uid()
$$;
```

### 2.2 Policies para todas as tabelas tenant-aware

```sql
-- Exemplo: messages (replicar pra contacts, conversations, channel_sessions, deals, etc.)
alter table public.messages enable row level security;

create policy "tenant_isolation_messages_all"
  on public.messages
  for all
  using (organization_id in (select organization_id from public.fn_user_org_ids()))
  with check (organization_id in (select organization_id from public.fn_user_org_ids()));
```

### 2.3 RLS por role (admin vê tudo da org, atendente só vê atribuídas)

```sql
create policy "tenant_messages_member_select"
  on public.messages for select
  using (
    organization_id in (select organization_id from public.fn_user_org_ids())
    and (
      -- admin vê tudo
      exists (
        select 1 from public.user_organizations uo
        where uo.user_id = auth.uid() and uo.organization_id = messages.organization_id and uo.role = 'admin'
      )
      OR
      -- não-admin vê apenas mensagens de conversas atribuídas a ele
      exists (
        select 1 from public.conversations c
        where c.id = messages.conversation_id and c.assigned_user_id = auth.uid()
      )
    )
  );
```

⚠️ **Cuidado:** policies complexas com subquery encadeada podem ser lentas em escala. Profile com `EXPLAIN ANALYZE` antes de produção.

### 2.4 Service role bypass

Edge Functions e webhook handlers usam `SUPABASE_SERVICE_ROLE_KEY`, que **ignora RLS**. Você precisa **manualmente filtrar por organization_id** nesses contextos:

```typescript
// Em handler de webhook (admin client):
const { data } = await adminSupa
  .from('messages')
  .select('*')
  .eq('organization_id', verifiedOrgId)  // ← OBRIGATÓRIO. Sem isso, vaza entre orgs.
  .eq('id', messageId);
```

✅ **Padrão de segurança:** sempre que usar admin client, valide o `organization_id` antes da query, **a partir de fonte confiável** (cookie de sessão, JWT, webhook secret), nunca do body do request.

---

## 3. Webhook security em profundidade

### 3.1 Validação HMAC

Já coberto em [05-receber-mensagens.md §3](05-receber-mensagens.md). Resumo:

```typescript
const expected = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(receivedSig, 'hex'));
```

### 3.2 Path token como segunda camada

Mesmo com HMAC, adicione um path token longo que vira "secret no URL":

```
URL configurada na sessão:
https://api.seuprod.com/api/wa/webhook/{path-token}?session={name}
```

`path-token` é gerado junto com a sessão, único por sessão, e validado:

```typescript
// /api/wa/webhook/[token]/route.ts
const expectedToken = channelSession.webhook_path_token;
if (params.token !== expectedToken) return NextResponse.json({}, { status: 401 });
```

Vantagem: se HMAC falhar (Core), você ainda tem authn.

### 3.3 Replay attack protection

Header com timestamp + assinatura, rejeita se diff > 5 minutos:

```typescript
const ts = req.headers.get('x-webhook-timestamp');
if (!ts || Math.abs(Date.now() - Number(ts)) > 5 * 60 * 1000) {
  return NextResponse.json({ error: 'stale' }, { status: 401 });
}
```

⚠️ WAHA Plus assina o body, mas timestamp não é built-in. Você pode incluir `event.timestamp` (que vem no body) e checar contra `Date.now()`.

### 3.4 Rate limit no webhook

```typescript
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

const limiter = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(100, '10 s'), // 100 reqs em 10s por session
});

const { success } = await limiter.limit(`wa-webhook:${sessionName}`);
if (!success) return NextResponse.json({}, { status: 429 });
```

---

## 4. Secrets e credenciais

### 4.1 Hierarquia de secrets

```
Tier 1 — DEPLOY-LEVEL (toda a app)
  - SUPABASE_SERVICE_ROLE_KEY
  - WAHA_API_KEY_PLAINTEXT (modo SaaS)
  - WAHA_BYO_ENCRYPTION_KEY
  
Tier 2 — ORG-LEVEL (por cliente)
  - waha_api_key_encrypted (para BYO) — encriptado com Tier 1
  - integrations.* tokens (Stripe, etc)
  
Tier 3 — SESSION-LEVEL (por número conectado)
  - webhook_secret (HMAC) — pode ficar plaintext no DB (RLS protege)
  - webhook_path_token
```

### 4.2 Encriptação at-rest no Postgres

Para campos sensíveis em tier 2 (BYO key), use **pgcrypto**:

```sql
create extension if not exists pgcrypto;

-- Encripta no INSERT
update public.channel_sessions 
set waha_api_key_encrypted = pgp_sym_encrypt('plaintext', current_setting('app.encryption_key'))
where id = '...';

-- Decripta na leitura (apenas em service role)
select pgp_sym_decrypt(waha_api_key_encrypted::bytea, current_setting('app.encryption_key'))
from public.channel_sessions where id = '...';
```

Configure `app.encryption_key` no postgresql.conf ou em runtime:

```sql
ALTER DATABASE postgres SET app.encryption_key = 'sua-chave-master';
```

⚠️ **Gotcha:** se `app.encryption_key` muda, todos os valores antigos viram garbage. Roteie via migration cuidadosa.

### 4.3 Segredos no client (Next.js)

Regras:
- `NEXT_PUBLIC_*` é exposto. Use APENAS para chaves públicas (Supabase ANON, URLs).
- Service role key **nunca** sai do server.
- Token WAHA **nunca** sai do server.

```typescript
// .env.local
NEXT_PUBLIC_SUPABASE_URL=...     ✅ ok
NEXT_PUBLIC_SUPABASE_ANON_KEY=... ✅ ok (RLS protege)
SUPABASE_SERVICE_ROLE_KEY=...    🔴 SEM NEXT_PUBLIC
WAHA_API_KEY_PLAINTEXT=...       🔴 SEM NEXT_PUBLIC
```

### 4.4 Secret rotation

```typescript
// Rotação de webhook secret de uma sessão
async function rotateWebhookSecret(sessionId: string) {
  const newSecret = crypto.randomBytes(32).toString('hex');
  
  // 1. Update DB
  await supa.from('channel_sessions').update({ webhook_secret: newSecret }).eq('id', sessionId);
  
  // 2. Update WAHA
  const session = await waha.getSession(sessionName);
  await waha.updateSession(sessionName, {
    config: {
      webhooks: [{
        url: webhookUrl,
        events: [...events],
        hmac: { key: newSecret },
      }],
    },
  });
}
```

Cron mensal pra rotacionar todos os secrets ativos.

---

## 5. Storage security

### 5.1 Bucket policies no Supabase Storage

Por padrão, buckets podem ser totalmente públicos ou privados. Para WhatsApp media, use **privado com URL assinada** ou **público mas path por org**.

#### Opção A — Privado + URL assinada

```sql
-- Storage bucket privado
insert into storage.buckets (id, name, public) values ('whatsapp-media', 'whatsapp-media', false);

-- Policy: user só lê arquivos da própria org
create policy "tenant_read_media"
  on storage.objects for select
  using (
    bucket_id = 'whatsapp-media'
    and (storage.foldername(name))[1] in (
      select organization_id::text from public.fn_user_org_ids()
    )
  );
```

Acesso via URL assinada (expira em 1h):

```typescript
const { data } = await supa.storage.from('whatsapp-media').createSignedUrl(path, 3600);
// data.signedUrl
```

#### Opção B — Público mas com path UUID

```typescript
// Path: {orgId}/{messageId}.{ext}
// Como orgId e messageId são UUIDs, são impossíveis de adivinhar.
```

Mais simples. Risco: se URL vaza (screenshot, log), qualquer um acessa eternamente. Mitigação: detecte cabeçalho `referer` no Storage e bloqueie domains não-permitidos.

🎯 **Decisão padrão:** opção A (privado + assinada) para CRM de saúde, jurídico, financeiro. Opção B para nichos menos sensíveis (e-commerce comum, infoproduto).

### 5.2 MIME validation no upload

```typescript
const ALLOWED_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'video/webm',
  'audio/mp3', 'audio/mpeg', 'audio/ogg', 'audio/webm', 'audio/m4a',
  'application/pdf',
]);

if (!ALLOWED_MIMES.has(file.type)) {
  return NextResponse.json({ error: 'invalid_mime' }, { status: 400 });
}
```

### 5.3 Tamanho máximo

```typescript
const MAX_SIZE = 16 * 1024 * 1024; // 16MB (limite WhatsApp)
if (file.size > MAX_SIZE) return NextResponse.json({ error: 'too_large' }, { status: 413 });
```

### 5.4 Vírus / malware

Para PDFs e documentos genéricos, integre com ClamAV ou serviço SaaS (Cloudmersive). Se não puder, **avise o operador** ao receber: "Documento de fonte externa. Confirme antes de abrir."

---

## 6. Auth flows que aumentam segurança

### 6.1 2FA obrigatório para admin

Supabase Auth tem MFA:

```typescript
const { data } = await supa.auth.mfa.enroll({ factorType: 'totp' });
// Mostra QR code do TOTP
const { error } = await supa.auth.mfa.challengeAndVerify({ factorId: data.id, code: '123456' });
```

Force MFA para roles `admin`. Outros podem ser opt-in.

### 6.2 Session timeout

```typescript
// supabase/config.toml
[auth]
jwt_expiry = 3600           # 1 hora (mais curto = mais seguro mas chato)
refresh_token_rotation_enabled = true
```

### 6.3 Audit log de ações sensíveis

```sql
create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  actor_user_id uuid,
  action text not null,        -- 'session_created', 'message_deleted', 'contact_exported', etc
  target_type text,            -- 'channel_session', 'contact', etc
  target_id uuid,
  metadata jsonb,
  ip_address inet,
  user_agent text,
  created_at timestamptz default now()
);
```

Crie helper `await logAudit({ action, target, ... })` e chame em todas as ações destrutivas.

---

## 7. Network e infra

### 7.1 WAHA atrás de firewall

WAHA não precisa ser público — só o webhook precisa chegar nele. Configuração:

```
Internet → CRM frontend (Vercel)
                  ↓
            CRM backend → POST sendText → WAHA (rede privada VPC, IP interno)
                  
WAHA → POST webhook → CRM backend (precisa público)
```

Em Vercel, backend é serverless = público sempre. Em VPS, ambos podem estar em VPC, com WAHA acessível só pelo backend interno e backend público com TLS.

### 7.2 IP allowlist no WAHA

Restrinja quem pode chamar a API do WAHA via Nginx:

```nginx
location /api/ {
    allow 10.0.0.0/8;       # rede privada
    allow <IP do Vercel>;   # se aplicável
    deny all;
    proxy_pass http://127.0.0.1:3000;
}
```

### 7.3 TLS em todo lugar

- Front → Backend: HTTPS (Vercel automático).
- Backend → WAHA: HTTPS com Let's Encrypt no Nginx.
- Webhook: HTTPS obrigatório (WAHA pode rejeitar HTTP).

---

## 8. Compliance frameworks (resumo prático)

### LGPD (Brasil)

- [ ] Termo de uso explícito sobre WAHA não-oficial
- [ ] Bandeira "Direito de excluir meus dados" no perfil do contact final
- [ ] Encarregado de dados (DPO) listado
- [ ] Export de dados pessoais (formato JSON) sob demanda
- [ ] Encriptação at-rest e em trânsito

### GDPR (UE) — extra

- [ ] Cookie banner se você opera em UE
- [ ] Data Processing Agreement com clientes B2B

### HIPAA (EUA, healthtech)

- [ ] **Não use WAHA.** Sério. WhatsApp não é HIPAA-compliant. Use a Cloud API oficial Meta.

### SOC 2

- [ ] Audit log completo
- [ ] Backup automatizado e testado (restore mensal)
- [ ] Pen test anual
- [ ] Incident response plan documentado

---

## 9. Anti-vazamento: padrões de código

### 9.1 Nunca logue body de webhook completo em produção

```typescript
// ❌ Errado
console.log('webhook payload', JSON.stringify(event, null, 2));

// ✅ Certo
console.log('webhook', { event: event.event, session: event.session, payloadId: event.payload?.id });
```

### 9.2 Sanitize antes de logar

```typescript
function sanitize(obj: any): any {
  const SENSITIVE = ['x-api-key', 'authorization', 'webhook_secret', 'cookie', 'password'];
  if (typeof obj !== 'object' || obj === null) return obj;
  const out: any = Array.isArray(obj) ? [] : {};
  for (const k of Object.keys(obj)) {
    if (SENSITIVE.includes(k.toLowerCase())) out[k] = '[REDACTED]';
    else out[k] = sanitize(obj[k]);
  }
  return out;
}
```

### 9.3 Sentry: filtra antes de enviar

```typescript
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  beforeSend(event) {
    if (event.request?.headers) {
      delete event.request.headers['x-api-key'];
      delete event.request.headers['authorization'];
    }
    return event;
  },
});
```

---

## 10. Checklist de produção

- [ ] Todas as tabelas tenant-aware têm RLS habilitada
- [ ] Service role key não está em código client-side
- [ ] Webhook valida HMAC + path token
- [ ] BYO keys encriptadas no DB
- [ ] Storage com URL assinada ou path UUID
- [ ] MFA forçado para role `admin`
- [ ] Audit log para ações destrutivas
- [ ] Rate limit em endpoints sensíveis
- [ ] Logs sanitizados
- [ ] Sentry configurado com filtro de headers
- [ ] HTTPS em todos os hops
- [ ] LGPD: rota de export e deleção de dados pessoais
- [ ] Termo de uso menciona uso de WhatsApp não-oficial

---

## Próximo: [12-checklist-implementacao.md](12-checklist-implementacao.md)
