# PROMPT 03 — Fluxo de Mensagens (Webhook + Envio)

> **Cole após Fase 02. Implementa webhook handler completo e endpoint de envio.**

---

## Contexto

Fase **3 de 5**. Você tem: scaffolding (fase 1) e cliente WAHA + sessões (fase 2). O ngrok deve estar rodando expondo `localhost:3001` numa URL pública (`NEXT_PUBLIC_APP_URL`).

Sua missão: fazer mensagens **fluírem** dos dois lados.

## Sua missão

1. Webhook handler (`POST /api/wa/webhook`) — recebe eventos do WAHA
2. Validação HMAC
3. Handlers por tipo: `message`, `message.ack`, `session.status`, `message.reaction`, `message.revoked`
4. Download e armazenamento de mídia
5. Endpoint de envio (`POST /api/wa/send`)
6. Dispatcher com rate limit
7. Endpoint de upload (`POST /api/wa/upload`)

## Princípios

- **Idempotência:** mesma mensagem não pode duplicar (unique em `external_id`).
- **Otimismo:** envio retorna 200 antes do WAHA confirmar — UI mostra `status='sending'`.
- **Rate limit:** 1 mensagem por sessão por ~1.2 segundos.
- **Mídia:** download do WAHA → Supabase Storage → grava URL no DB.

## Tasks

### 1. Validação HMAC

`src/lib/waha/hmac.ts`:

```typescript
import crypto from 'crypto';

export function validateHmac(rawBody: string, secret: string, signatureHex: string): boolean {
  const expected = crypto.createHmac('sha512', secret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signatureHex, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
```

### 2. Utils

`src/lib/waha/utils.ts`:

```typescript
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  return digits.startsWith('+') ? raw : `+${digits}`;
}

export function chatIdToPhone(chatId: string): string {
  return normalizePhone(chatId.split('@')[0]);
}
```

### 3. Download de mídia

`src/lib/waha/media.ts`:

```typescript
import type { SupabaseClient } from '@supabase/supabase-js';

export async function downloadAndStoreMedia(args: {
  organizationId: string;
  messageId: string;
  payload: any;
  supabase: SupabaseClient;
}) {
  const { organizationId, messageId, payload, supabase } = args;
  const apiKey = process.env.WAHA_API_KEY_PLAINTEXT;

  let mediaUrl: string | undefined = payload.media?.url;
  if (!mediaUrl) {
    console.warn(`[media] sem URL para ${messageId}`);
    return {};
  }

  const res = await fetch(mediaUrl, { headers: apiKey ? { 'X-Api-Key': apiKey } : {} });
  if (!res.ok) {
    console.error(`[media] download falhou: ${res.status}`);
    return {};
  }

  const buf = Buffer.from(await res.arrayBuffer());
  const mime = payload.mimetype ?? res.headers.get('content-type') ?? 'application/octet-stream';
  const ext = guessExt(mime);
  const filename = payload.filename ?? `${messageId}.${ext}`;
  const path = `${organizationId}/${messageId}.${ext}`;

  const bucket = process.env.SUPABASE_MEDIA_BUCKET ?? 'whatsapp-media';
  const { error } = await supabase.storage.from(bucket).upload(path, buf, { contentType: mime, upsert: true });
  if (error) {
    console.error(`[media] upload falhou: ${error.message}`);
    return {};
  }

  const { data: pub } = supabase.storage.from(bucket).getPublicUrl(path);

  return {
    media_url: pub.publicUrl,
    media_mime_type: mime,
    media_size_bytes: buf.length,
    media_filename: filename,
    media_duration_seconds: payload.duration ?? undefined,
  };
}

function guessExt(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
    'video/mp4': 'mp4', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
    'application/pdf': 'pdf',
  };
  return map[mime] ?? 'bin';
}
```

### 4. Webhook processor

`src/lib/waha/webhook-processor.ts`:

```typescript
import type { SupabaseClient } from '@supabase/supabase-js';
import { handleIncomingMessage } from './handlers/message';
import { handleMessageAck } from './handlers/message-ack';
import { handleSessionStatus } from './handlers/session-status';

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
  switch (args.event.event) {
    case 'message':
    case 'message.any':
      return handleIncomingMessage(args);
    case 'message.ack':
      return handleMessageAck(args);
    case 'session.status':
      return handleSessionStatus(args);
    default:
      console.log(`[webhook] event ignorado: ${args.event.event}`);
  }
}
```

### 5. Handler de mensagem

`src/lib/waha/handlers/message.ts`:

```typescript
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ChannelSessionRef } from '../webhook-processor';
import { downloadAndStoreMedia } from '../media';
import { chatIdToPhone, normalizePhone } from '../utils';

export async function handleIncomingMessage(args: {
  event: any;
  channelSession: ChannelSessionRef;
  supabase: SupabaseClient;
}) {
  const { event, channelSession, supabase } = args;
  const p = event.payload;
  const fromMe: boolean = p.fromMe ?? false;

  const chatId: string = p.from === p.to ? p.from : (fromMe ? p.to : p.from);
  const isGroup = chatId.endsWith('@g.us');
  const senderRawId: string = p.author ?? p.from;
  const senderPhone = chatIdToPhone(senderRawId);

  const contactPhone = isGroup ? senderPhone : chatIdToPhone(fromMe ? p.to : p.from);
  const pushName = p.pushName ?? p._data?.notifyName ?? null;

  const { data: contact, error: cErr } = await supabase
    .from('contacts')
    .upsert(
      {
        organization_id: channelSession.organization_id,
        phone_number: contactPhone,
        whatsapp_id: `${contactPhone.replace('+', '')}@c.us`,
        push_name: pushName,
      },
      { onConflict: 'organization_id,phone_number', ignoreDuplicates: false },
    )
    .select('id, full_name')
    .single();
  if (cErr || !contact) throw new Error(`contact upsert: ${cErr?.message}`);

  // Se é a primeira vez (sem full_name), preenche
  if (!contact.full_name && pushName) {
    await supabase.from('contacts').update({ full_name: pushName }).eq('id', contact.id);
  }

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
  if (convErr || !conv) throw new Error(`conversation upsert: ${convErr?.message}`);

  const type = mapType(p);
  let mediaInfo = {};
  if (type !== 'text' && type !== 'system' && type !== 'reaction' && p.hasMedia) {
    mediaInfo = await downloadAndStoreMedia({
      organizationId: channelSession.organization_id,
      messageId: p.id,
      payload: p,
      supabase,
    });
  }

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
      location: type === 'location' ? { lat: p.location?.latitude, lng: p.location?.longitude } : undefined,
    },
    status: fromMe ? 'sent' : 'delivered',
    ack: p.ack ?? (fromMe ? 1 : 2),
    sent_at: p.timestamp ? new Date(p.timestamp * 1000).toISOString() : new Date().toISOString(),
  });

  if (mErr) {
    if ((mErr as any).code === '23505') {
      console.log(`[webhook] msg ${p.id} já processada (idempotente)`);
      return;
    }
    throw new Error(`message insert: ${mErr.message}`);
  }
}

function mapType(p: any): string {
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
```

### 6. Handler de ack

`src/lib/waha/handlers/message-ack.ts`:

```typescript
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ChannelSessionRef } from '../webhook-processor';

export async function handleMessageAck(args: {
  event: any;
  channelSession: ChannelSessionRef;
  supabase: SupabaseClient;
}) {
  const p = args.event.payload;
  const status = ackToStatus(p.ack);
  const updates: any = { ack: p.ack, status };
  if (p.ack >= 3) updates.delivered_at = new Date().toISOString();
  if (p.ack >= 4) updates.read_at = new Date().toISOString();

  await args.supabase
    .from('messages')
    .update(updates)
    .eq('organization_id', args.channelSession.organization_id)
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

### 7. Handler de status de sessão

`src/lib/waha/handlers/session-status.ts`:

```typescript
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ChannelSessionRef } from '../webhook-processor';

export async function handleSessionStatus(args: {
  event: any;
  channelSession: ChannelSessionRef;
  supabase: SupabaseClient;
}) {
  const p = args.event.payload;
  const statusLower = String(p.status).toLowerCase();
  
  let normalized = statusLower;
  if (statusLower === 'scan_qr_code') normalized = 'scan_qr';
  
  const updates: any = {
    status: normalized,
    last_status_at: new Date().toISOString(),
  };
  
  if (normalized === 'working' && p.me?.id) {
    updates.phone_number = p.me.id.replace('@c.us', '');
    updates.display_name = p.me.pushname ?? null;
    updates.qr_code = null;
  }
  
  if (normalized === 'scan_qr' && p.qr) {
    updates.qr_code = p.qr;
  }

  await args.supabase
    .from('channel_sessions')
    .update(updates)
    .eq('id', args.channelSession.id);
}
```

### 8. Endpoint do webhook

`src/app/api/wa/webhook/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { processWahaWebhook } from '@/lib/waha/webhook-processor';
import { validateHmac } from '@/lib/waha/hmac';

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const sessionFromQuery = req.nextUrl.searchParams.get('session');

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const sessionName = event.session ?? sessionFromQuery;
  if (!sessionName) return NextResponse.json({ error: 'missing_session' }, { status: 400 });

  const supa = getSupabaseAdminClient();
  const { data: channelSession } = await supa
    .from('channel_sessions')
    .select('id, organization_id, webhook_secret, status, phone_number')
    .eq('waha_session_name', sessionName)
    .single();

  if (!channelSession) return NextResponse.json({ error: 'session_unknown' }, { status: 404 });

  // HMAC opcional (Plus envia, Core não)
  const hmac = req.headers.get('x-webhook-hmac');
  if (hmac && !validateHmac(rawBody, channelSession.webhook_secret, hmac)) {
    return NextResponse.json({ error: 'invalid_hmac' }, { status: 401 });
  }

  // Log raw (fire-and-forget)
  supa.from('webhook_events_log').insert({
    channel_session_id: channelSession.id,
    event_type: event.event,
    external_id: event.payload?.id ?? null,
    payload: event,
  }).then(({ error }) => { if (error) console.error('[webhook log]', error); });

  try {
    await processWahaWebhook({ event, channelSession, supabase: supa });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[webhook process]', err);
    return NextResponse.json({ error: 'process_failed', message: String(err) }, { status: 500 });
  }
}

export const dynamic = 'force-dynamic';
```

### 9. Rate limiter

`src/lib/waha/rate-limiter.ts`:

```typescript
const lastSend = new Map<string, number>();
const queues = new Map<string, Array<() => void>>();
const MIN_INTERVAL = 1200;
const JITTER = 800;

export async function acquireSendLock(sessionName: string): Promise<void> {
  return new Promise((resolve) => {
    const now = Date.now();
    const last = lastSend.get(sessionName) ?? 0;
    const jitter = Math.floor(Math.random() * JITTER);
    const wait = Math.max(0, last + MIN_INTERVAL + jitter - now);

    setTimeout(() => {
      lastSend.set(sessionName, Date.now());
      resolve();
    }, wait);
  });
}
```

### 10. Dispatcher

`src/lib/waha/dispatcher.ts`:

```typescript
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { getWahaClient } from './index';
import { acquireSendLock } from './rate-limiter';

export async function dispatchSend(args: {
  messageId: string;
  sessionName: string;
  chatId: string;
  input: {
    type: 'text' | 'image' | 'video' | 'audio' | 'document';
    body?: string;
    media?: { url?: string; base64?: string; mimeType?: string; filename?: string };
  };
}) {
  const supa = getSupabaseAdminClient();
  const waha = getWahaClient();
  const { messageId, sessionName, chatId, input } = args;

  await acquireSendLock(sessionName);

  try {
    let externalId: string;
    if (input.type === 'text') {
      if (!input.body) throw new Error('texto vazio');
      const sent = await waha.sendText({ session: sessionName, chatId, text: input.body });
      externalId = sent.id;
    } else if (input.type === 'image') {
      const sent = await waha.sendImage({
        session: sessionName, chatId,
        file: { url: input.media?.url, mimetype: input.media?.mimeType, filename: input.media?.filename },
        caption: input.body,
      });
      externalId = sent.id;
    } else if (input.type === 'audio') {
      const sent = await waha.sendVoice({ session: sessionName, chatId, file: { url: input.media?.url } });
      externalId = sent.id;
    } else {
      const sent = await waha.sendFile({
        session: sessionName, chatId,
        file: {
          url: input.media?.url,
          mimetype: input.media?.mimeType,
          filename: input.media?.filename ?? `file.${input.type}`,
        },
        caption: input.body,
      });
      externalId = sent.id;
    }

    await supa.from('messages').update({
      external_id: externalId,
      external_session: sessionName,
      status: 'sent',
      ack: 1,
    }).eq('id', messageId);
  } catch (err) {
    console.error(`[dispatch] msg ${messageId}:`, err);
    await supa.from('messages').update({
      status: 'failed',
      failed_reason: String(err).slice(0, 500),
    }).eq('id', messageId);
    throw err;
  }
}
```

### 11. Endpoint de envio

`src/app/api/wa/send/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { dispatchSend } from '@/lib/waha/dispatcher';

const schema = z.object({
  conversationId: z.string().uuid(),
  type: z.enum(['text', 'image', 'video', 'audio', 'document']),
  body: z.string().optional(),
  media: z.object({
    url: z.string().url().optional(),
    base64: z.string().optional(),
    mimeType: z.string().optional(),
    filename: z.string().optional(),
  }).optional(),
});

export async function POST(req: NextRequest) {
  const supaUser = getSupabaseServerClient();
  const { data: { user } } = await supaUser.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 400 });

  const { data: conv } = await supaUser
    .from('conversations')
    .select('id, organization_id, channel_session_id, whatsapp_chat_id, channel_session:channel_sessions!inner(waha_session_name, status)')
    .eq('id', parsed.data.conversationId)
    .single();
  if (!conv) return NextResponse.json({ error: 'conversation_not_found' }, { status: 404 });

  if ((conv as any).channel_session.status !== 'working') {
    return NextResponse.json({ error: 'session_not_ready' }, { status: 409 });
  }

  const supa = getSupabaseAdminClient();
  const { data: msg, error: mErr } = await supa
    .from('messages')
    .insert({
      organization_id: conv.organization_id,
      conversation_id: conv.id,
      from_me: true,
      sender_user_id: user.id,
      type: parsed.data.type,
      body: parsed.data.body ?? null,
      media_url: parsed.data.media?.url ?? null,
      media_mime_type: parsed.data.media?.mimeType ?? null,
      media_filename: parsed.data.media?.filename ?? null,
      status: 'sending',
      sent_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (mErr || !msg) return NextResponse.json({ error: 'insert_failed' }, { status: 500 });

  dispatchSend({
    messageId: msg.id,
    sessionName: (conv as any).channel_session.waha_session_name,
    chatId: conv.whatsapp_chat_id,
    input: parsed.data,
  }).catch((err) => console.error('[send]', err));

  return NextResponse.json({ id: msg.id, status: 'sending' });
}

export const dynamic = 'force-dynamic';
```

### 12. Endpoint de upload

`src/app/api/wa/upload/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { randomUUID } from 'crypto';

const ALLOWED = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'video/webm',
  'audio/mp3', 'audio/mpeg', 'audio/ogg', 'audio/webm', 'audio/m4a',
  'application/pdf',
]);
const MAX_SIZE = 16 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const supa = getSupabaseServerClient();
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const form = await req.formData();
  const file = form.get('file') as File | null;
  const orgId = form.get('organizationId') as string | null;
  if (!file || !orgId) return NextResponse.json({ error: 'missing_input' }, { status: 400 });
  if (file.size > MAX_SIZE) return NextResponse.json({ error: 'too_large' }, { status: 413 });
  if (!ALLOWED.has(file.type)) return NextResponse.json({ error: 'invalid_mime' }, { status: 400 });

  const path = `${orgId}/outbound/${randomUUID()}-${file.name}`;
  const { error } = await supa.storage.from('whatsapp-media').upload(path, file, {
    contentType: file.type, upsert: false,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: pub } = supa.storage.from('whatsapp-media').getPublicUrl(path);
  return NextResponse.json({ url: pub.publicUrl, mimeType: file.type, filename: file.name, size: file.size });
}

export const dynamic = 'force-dynamic';
```

## Testar

1. `docker logs -f waha-dev` em outro terminal
2. Conecte um número (fase 2 já cobre)
3. Mande mensagem do celular pro número conectado
4. Veja logs: webhook recebido, message inserido
5. No SQL editor do Supabase: `SELECT * FROM messages ORDER BY created_at DESC LIMIT 5` → deve mostrar a mensagem

## Definition of Done

- [ ] Mandar mensagem do celular → entra em `messages` em <2s
- [ ] Mídia (foto) salva no Storage `whatsapp-media/{orgId}/{messageId}.{ext}`
- [ ] Status da sessão muda pra `working` após scan
- [ ] `POST /api/wa/send` insere `messages` com `status='sending'`, depois fica `sent` quando WAHA responde
- [ ] Mensagem enviada chega no WhatsApp do destinatário
- [ ] Logs do `webhook_events_log` populando

## Não faça

- ❌ UI de chat — fase 4
- ❌ Binding com pipeline CRM — fase 5

Ao terminar: **"Fase 03 completa. Pode prosseguir para fase 04 (Frontend Chat)."**
