# 05 — Receber mensagens: webhook handler completo

> **Resumo:** o webhook é a porta de entrada de tudo. Aqui você implementa um handler robusto: validação HMAC, idempotência, normalização de payload, persistência transacional, dispatch realtime, e tratamento de mídia.

---

## 1. Anatomia do webhook do WAHA

Toda mensagem do WhatsApp aterrissa como um POST do WAHA pro seu endpoint. O envelope é sempre:

```json
{
  "id": "evt_abc123",
  "timestamp": 1741234567890,
  "event": "message",
  "session": "org-acme-1",
  "metadata": {},
  "engine": "NOWEB",
  "payload": { /* específico do evento */ }
}
```

Os 4 eventos que você quer tratar com prioridade:

| Event | Quando dispara | Ação no DB |
|-------|----------------|------------|
| `message` | Cliente mandou mensagem pra você | INSERT em `messages` (from_me=false) |
| `message.any` | Qualquer mensagem (incluindo enviadas por você de outro device) | INSERT/UPDATE em `messages` |
| `message.ack` | Status de entrega mudou | UPDATE em `messages` (ack, status, delivered_at, read_at) |
| `session.status` | Sessão mudou de estado | UPDATE em `channel_sessions` (status, phone_number) |

Exemplos completos de payloads em [reference/webhook-payloads.json](reference/webhook-payloads.json).

---

## 2. Endpoint Next.js (App Router)

📦 **`app/api/wa/webhook/route.ts`**:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { processWahaWebhook } from '@/lib/waha/webhook-processor';
import { validateHmac } from '@/lib/waha/hmac';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';

// IMPORTANTE: queremos o body raw pra validar HMAC. App Router permite via .text()
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const sessionName = req.nextUrl.searchParams.get('session') ?? null;

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  // 1. Resolve a sessão (e o secret para HMAC) via DB.
  const supa = getSupabaseAdminClient();
  const sessionFromBody = event.session ?? sessionName;
  if (!sessionFromBody) {
    return NextResponse.json({ error: 'missing_session' }, { status: 400 });
  }

  const { data: channelSession, error: sErr } = await supa
    .from('channel_sessions')
    .select('id, organization_id, webhook_secret, status, phone_number')
    .eq('waha_session_name', sessionFromBody)
    .single();

  if (sErr || !channelSession) {
    return NextResponse.json({ error: 'session_unknown' }, { status: 404 });
  }

  // 2. Valida HMAC (Plus envia header X-Webhook-Hmac).
  const hmacHeader = req.headers.get('x-webhook-hmac');
  if (hmacHeader && !validateHmac(rawBody, channelSession.webhook_secret, hmacHeader)) {
    return NextResponse.json({ error: 'invalid_hmac' }, { status: 401 });
  }

  // 3. Loga raw para auditoria (fire-and-forget).
  supa.from('webhook_events_log').insert({
    channel_session_id: channelSession.id,
    event_type: event.event,
    external_id: event.payload?.id ?? null,
    payload: event,
  }).then(({ error }) => { if (error) console.error('log error', error); });

  // 4. Processa de forma idempotente.
  try {
    await processWahaWebhook({
      event,
      channelSession,
      supabase: supa,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[webhook] process error', err);
    // Retorna 500 para o WAHA Plus reentregar (Plus tem retry nativo).
    // Para WAHA Core, retorne 200 e use uma fila própria.
    return NextResponse.json({ error: 'process_failed', message: String(err) }, { status: 500 });
  }
}

export const dynamic = 'force-dynamic';
```

---

## 3. Validação HMAC

📦 **`lib/waha/hmac.ts`**:

```typescript
import crypto from 'crypto';

/**
 * WAHA Plus assina o body com HMAC-SHA512 usando a key configurada na sessão.
 * Header default: X-Webhook-Hmac (hex).
 */
export function validateHmac(rawBody: string, secret: string, signatureHex: string): boolean {
  const expected = crypto
    .createHmac('sha512', secret)
    .update(rawBody, 'utf8')
    .digest('hex');
  
  // Comparação constant-time pra evitar timing attacks
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signatureHex, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
```

⚠️ **Gotcha:** WAHA Core não envia HMAC. Você decide:
- **Modo permissivo:** se sessão não tem `webhook_secret` ou header HMAC ausente, aceita. **Riscoso.**
- **Modo estrito:** sempre exige HMAC. Em Core, é incompatível — você teria que mudar pra autenticação por path secreto na URL.

Recomendado: **path com token random** mais HMAC quando disponível. URL fica `/api/wa/webhook/<path-token>`.

---

## 4. O processor (despacha por tipo de evento)

📦 **`lib/waha/webhook-processor.ts`**:

```typescript
import type { SupabaseClient } from '@supabase/supabase-js';
import { handleIncomingMessage } from './handlers/message';
import { handleMessageAck } from './handlers/message-ack';
import { handleSessionStatus } from './handlers/session-status';
import { handleMessageReaction } from './handlers/message-reaction';
import { handleMessageRevoked } from './handlers/message-revoked';

export interface ChannelSessionRef {
  id: string;
  organization_id: string;
  webhook_secret: string;
  status: string;
  phone_number: string | null;
}

export async function processWahaWebhook(args: {
  event: any;
  channelSession: ChannelSessionRef;
  supabase: SupabaseClient;
}) {
  const { event } = args;
  switch (event.event) {
    case 'message':
    case 'message.any':
      return handleIncomingMessage(args);
    case 'message.ack':
      return handleMessageAck(args);
    case 'message.reaction':
      return handleMessageReaction(args);
    case 'message.revoked':
      return handleMessageRevoked(args);
    case 'session.status':
      return handleSessionStatus(args);
    default:
      console.log(`[webhook] event ignorado: ${event.event}`);
  }
}
```

---

## 5. Handler de mensagem recebida (o coração)

📦 **`lib/waha/handlers/message.ts`**:

```typescript
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ChannelSessionRef } from '../webhook-processor';
import { downloadAndStoreMedia } from '../media';
import { normalizePhone } from '../utils';

export async function handleIncomingMessage(args: {
  event: any;
  channelSession: ChannelSessionRef;
  supabase: SupabaseClient;
}) {
  const { event, channelSession, supabase } = args;
  const p = event.payload;
  const fromMe: boolean = p.fromMe ?? false;

  // Em "message.any", você recebe inclusive mensagens enviadas por outro device.
  // Para o handler de "message" puro, fromMe sempre é false.

  // 1. chatId pode ser do contato (DM) ou do grupo.
  const chatId = p.from === p.to ? p.from : (fromMe ? p.to : p.from);
  const isGroup = chatId.endsWith('@g.us');
  const senderRawId: string = p.author ?? p.from;  // em grupos, p.author é quem mandou
  const senderPhone = normalizePhone(senderRawId);

  // 2. UPSERT contact (o ponto de origem da identificação).
  // Em DM, contato = quem está conversando.
  // Em grupo, contato = o sender (não o grupo). O grupo vira metadata.
  const contactPhone = isGroup
    ? senderPhone
    : normalizePhone(fromMe ? p.to : p.from);

  let pushName = p.pushName ?? p._data?.notifyName ?? null;

  const { data: contact, error: cErr } = await supabase
    .from('contacts')
    .upsert(
      {
        organization_id: channelSession.organization_id,
        phone_number: contactPhone,
        whatsapp_id: `${contactPhone.replace('+', '')}@c.us`,
        push_name: pushName,
        full_name: pushName,  // só na primeira vez; UPDATE não sobrescreve depois
      },
      { onConflict: 'organization_id,phone_number', ignoreDuplicates: false },
    )
    .select('id, full_name')
    .single();

  if (cErr) throw new Error(`contact upsert failed: ${cErr.message}`);

  // 3. UPSERT conversation.
  const { data: conv, error: convErr } = await supabase
    .from('conversations')
    .upsert(
      {
        organization_id: channelSession.organization_id,
        channel_session_id: channelSession.id,
        contact_id: contact.id,
        whatsapp_chat_id: chatId,
        is_group: isGroup,
        group_name: isGroup ? (p._data?.notifyName ?? null) : null,
      },
      { onConflict: 'organization_id,channel_session_id,whatsapp_chat_id', ignoreDuplicates: false },
    )
    .select('id')
    .single();

  if (convErr) throw new Error(`conversation upsert failed: ${convErr.message}`);

  // 4. Determina o tipo da mensagem e baixa mídia se necessário.
  const type = mapWahaType(p);
  let mediaInfo: {
    media_url?: string;
    media_mime_type?: string;
    media_size_bytes?: number;
    media_filename?: string;
    media_duration_seconds?: number;
  } = {};

  if (type !== 'text' && type !== 'system' && type !== 'reaction' && p.hasMedia) {
    mediaInfo = await downloadAndStoreMedia({
      organizationId: channelSession.organization_id,
      messageId: p.id,
      payload: p,
      supabase,
    });
  }

  // 5. INSERT da message (idempotente via unique constraint em external_id).
  const { error: mErr } = await supabase.from('messages').insert({
    organization_id: channelSession.organization_id,
    conversation_id: conv.id,
    external_id: p.id,
    external_session: event.session,
    from_me: fromMe,
    sender_phone: senderPhone,
    type,
    body: p.body ?? p.caption ?? null,
    ...mediaInfo,
    metadata: {
      quotedMessage: p.quotedMsgId ?? null,
      mentions: p.mentions ?? null,
      location: type === 'location' ? { lat: p.location?.latitude, lng: p.location?.longitude } : undefined,
    },
    status: fromMe ? 'sent' : 'delivered',
    ack: p.ack ?? (fromMe ? 1 : 2),
    sent_at: p.timestamp ? new Date(p.timestamp * 1000).toISOString() : new Date().toISOString(),
  });

  if (mErr) {
    // 23505 = duplicate key (idempotência) — ignora silenciosamente
    if ((mErr as any).code === '23505') {
      console.log(`[webhook] message ${p.id} já processada (idempotente)`);
      return;
    }
    throw new Error(`message insert failed: ${mErr.message}`);
  }

  // 6. (Opcional) dispara automações: roteamento, atribuição, IA agent.
  await maybeDispatchAutomations({
    organizationId: channelSession.organization_id,
    conversationId: conv.id,
    contactId: contact.id,
    isInbound: !fromMe,
    isFirstMessage: contact.full_name === null,
    supabase,
  });
}

function mapWahaType(p: any): string {
  // p.type vem do WAHA. Normaliza pro nosso vocabulário.
  if (p.type === 'chat') return 'text';
  if (p.type === 'image') return 'image';
  if (p.type === 'video') return 'video';
  if (p.type === 'ptt' || p.type === 'audio') return 'audio';
  if (p.type === 'document') return 'document';
  if (p.type === 'sticker') return 'sticker';
  if (p.type === 'location') return 'location';
  if (p.type === 'vcard') return 'contact';
  if (p.type === 'reaction') return 'reaction';
  return 'system';
}

async function maybeDispatchAutomations(args: {
  organizationId: string;
  conversationId: string;
  contactId: string;
  isInbound: boolean;
  isFirstMessage: boolean;
  supabase: SupabaseClient;
}) {
  // Hook plug-in para sua lógica de CRM.
  // Exemplos:
  //  - Se isFirstMessage: cria deal no estágio "Lead novo"
  //  - Se isInbound: marca conversation.status='pending' se não tem assignee
  //  - Dispara IA agent se inbound e org tem agent ativo
}
```

---

## 6. Download de mídia

⚠️ **Crítico:** o WAHA expõe a mídia, mas o link tem credenciais e tempo de vida. Você precisa baixar e guardar no SEU storage.

📦 **`lib/waha/media.ts`**:

```typescript
import type { SupabaseClient } from '@supabase/supabase-js';
import { getWahaClient } from './index';

export async function downloadAndStoreMedia(args: {
  organizationId: string;
  messageId: string;
  payload: any;
  supabase: SupabaseClient;
}): Promise<{
  media_url: string;
  media_mime_type: string;
  media_size_bytes: number;
  media_filename: string;
  media_duration_seconds?: number;
}> {
  const { organizationId, messageId, payload, supabase } = args;

  // 1. Pega URL temporária do WAHA
  const waha = getWahaClient();
  const baseUrl = (waha as any).baseUrl as string;
  const apiKey = process.env.WAHA_API_KEY_PLAINTEXT;

  let mediaUrl: string;
  if (payload.media?.url) {
    mediaUrl = payload.media.url;
  } else {
    // 🔌 WAHA Plus: GET /api/{session}/messages/{id}/file (alguns endpoints)
    // Em fallback, usa o payload.media.url quando disponível
    mediaUrl = payload._data?.directPath ? `${baseUrl}${payload._data.directPath}` : (payload.url ?? '');
  }

  if (!mediaUrl) throw new Error(`Sem URL de mídia para ${messageId}`);

  const res = await fetch(mediaUrl, {
    headers: apiKey ? { 'X-Api-Key': apiKey } : {},
  });
  if (!res.ok) throw new Error(`Falha ao baixar mídia: ${res.status}`);

  const buf = Buffer.from(await res.arrayBuffer());
  const mime = payload.mimetype ?? res.headers.get('content-type') ?? 'application/octet-stream';
  const ext = guessExtension(mime);
  const filename = payload.filename ?? `${messageId}.${ext}`;
  const path = `${organizationId}/${messageId}.${ext}`;

  // 2. Sobe pro Supabase Storage
  const bucket = process.env.SUPABASE_MEDIA_BUCKET ?? 'whatsapp-media';
  const { error: upErr } = await supabase.storage.from(bucket).upload(path, buf, {
    contentType: mime,
    upsert: true,
  });
  if (upErr) throw new Error(`Storage upload failed: ${upErr.message}`);

  const { data: pub } = supabase.storage.from(bucket).getPublicUrl(path);

  return {
    media_url: pub.publicUrl,
    media_mime_type: mime,
    media_size_bytes: buf.length,
    media_filename: filename,
    media_duration_seconds: payload.duration ?? undefined,
  };
}

function guessExtension(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'application/pdf': 'pdf',
  };
  return map[mime] ?? 'bin';
}
```

---

## 7. Handler de ACK (status de entrega)

📦 **`lib/waha/handlers/message-ack.ts`**:

```typescript
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ChannelSessionRef } from '../webhook-processor';

export async function handleMessageAck(args: {
  event: any;
  channelSession: ChannelSessionRef;
  supabase: SupabaseClient;
}) {
  const { event, channelSession, supabase } = args;
  const p = event.payload;

  // Mapeia ack int → status texto
  const status = ackToStatus(p.ack);
  const updates: any = {
    ack: p.ack,
    status,
  };
  if (p.ack >= 3) updates.delivered_at = new Date().toISOString();
  if (p.ack >= 4) updates.read_at = new Date().toISOString();

  await supabase
    .from('messages')
    .update(updates)
    .eq('organization_id', channelSession.organization_id)
    .eq('external_id', p.id);
}

function ackToStatus(ack: number): string {
  if (ack >= 4) return 'read';
  if (ack >= 3) return 'delivered';
  if (ack >= 2) return 'sent';
  if (ack < 0) return 'failed';
  return 'sending';
}
```

---

## 8. Handler de status de sessão

📦 **`lib/waha/handlers/session-status.ts`**:

```typescript
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ChannelSessionRef } from '../webhook-processor';

export async function handleSessionStatus(args: {
  event: any;
  channelSession: ChannelSessionRef;
  supabase: SupabaseClient;
}) {
  const { event, channelSession, supabase } = args;
  const p = event.payload;

  const statusLower = String(p.status).toLowerCase();
  const updates: any = {
    status: statusLower,
    last_status_at: new Date().toISOString(),
  };

  if (statusLower === 'working' && p.me?.id) {
    updates.phone_number = p.me.id.replace('@c.us', '');
    updates.display_name = p.me.pushname ?? null;
    updates.qr_code = null;  // Limpa QR ao autenticar
  }

  if (statusLower === 'scan_qr_code' || statusLower === 'scan_qr') {
    updates.status = 'scan_qr';
    // O QR vem em payload.qr (data url) — opcional persistir aqui
    if (p.qr) updates.qr_code = p.qr;
  }

  await supabase
    .from('channel_sessions')
    .update(updates)
    .eq('id', channelSession.id);
}
```

---

## 9. Idempotência: por que e como

Webhooks **podem chegar duplicados**. WAHA Plus reentrega quando você retorna 5xx. Mensagens podem aparecer em `message` E `message.any`. O cliente pode reenviar a mesma mensagem (mesmo `external_id`) por bug.

A unique constraint em `messages.external_id` faz o trabalho:
- Se você tenta inserir duplicado, Postgres retorna erro `23505`.
- Você detecta esse erro específico e ignora (já processou).

```typescript
if ((mErr as any).code === '23505') {
  return; // já processado
}
```

---

## 10. Patterns avançados

### 10.1 Fila assíncrona (WAHA Core sem retry)

WAHA Core não reentrega webhooks que falham. Solução: tenha uma fila própria.

**Padrão simples:** loga raw em `webhook_events_log` com `processed_at = null`. Um cron job processa pendentes a cada 1 min:

```typescript
// app/api/cron/process-pending-webhooks/route.ts
export async function GET() {
  const supa = getSupabaseAdminClient();
  const { data: pending } = await supa
    .from('webhook_events_log')
    .select('*')
    .is('processed_at', null)
    .order('received_at')
    .limit(100);

  for (const ev of pending ?? []) {
    try {
      // ... reprocessa ev.payload
      await supa.from('webhook_events_log')
        .update({ processed_at: new Date().toISOString() })
        .eq('id', ev.id);
    } catch (err) {
      await supa.from('webhook_events_log')
        .update({ processing_error: String(err) })
        .eq('id', ev.id);
    }
  }
  return new Response('ok');
}
```

Dispare via Vercel Cron (`vercel.ts` com `crons: [{ path: '/api/cron/process-pending-webhooks', schedule: '*/1 * * * *' }]`).

### 10.2 Validação de schema

Use `zod` para validar payloads. Salva sua vida quando o WAHA muda formato:

```typescript
import { z } from 'zod';

const messagePayloadSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string().optional(),
  fromMe: z.boolean().optional().default(false),
  body: z.string().optional(),
  type: z.string(),
  timestamp: z.number(),
  hasMedia: z.boolean().optional(),
  // ... etc
});
```

### 10.3 Backpressure

Se você recebe 1000 mensagens em 10 segundos (raro mas possível em campanha mal feita), o webhook pode entupir. Coloque um rate limiter no endpoint e **retorne 503** quando saturado — Plus retentará. Em Vercel, o timeout de 300s dá margem confortável.

---

## 11. Testando localmente

```bash
# 1. Sobe app: npm run dev (porta 3001)
# 2. Sobe WAHA via docker compose
# 3. Expõe seu localhost:
ngrok http 3001

# 4. Cria sessão apontando webhook pro ngrok URL
curl -X POST http://localhost:3000/api/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "name": "test-session-1",
    "config": {
      "webhooks": [{
        "url": "https://abc123.ngrok.app/api/wa/webhook",
        "events": ["message", "message.ack", "session.status"]
      }]
    }
  }'

# 5. Inicia
curl -X POST http://localhost:3000/api/sessions/test-session-1/start

# 6. Pega QR e escaneia com seu celular
curl http://localhost:3000/api/test-session-1/auth/qr?format=image -o qr.png && open qr.png

# 7. Mande mensagem do celular pra esse número e veja seu webhook handler logando
```

---

## Próximo: [06-enviar-mensagens.md](06-enviar-mensagens.md)
