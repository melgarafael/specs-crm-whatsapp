# 06 — Enviar mensagens: endpoint, fila, anti-ban

> **Resumo:** como o operador do CRM (ou o agente de IA) envia mensagens. Inclui endpoint REST, otimistic UI, fila de envio, retry, throttling e estratégias anti-banimento.

---

## 1. Princípios de envio

1. **Sempre persiste antes de despachar.** Mensagem entra no DB com `status='sending'`. Se a chamada ao WAHA falhar, a mensagem não some — o operador vê e reenvia.
2. **Otimistic UI.** O frontend mostra a mensagem imediatamente, antes da resposta do WAHA. Status muda conforme webhook chega.
3. **Throttling por sessão.** Nunca envie >1 mensagem/segundo por sessão WAHA, mesmo em campanha. Senão = banimento.
4. **Sender humano > sender bot.** Misture mensagens manuais com automações pra parecer humano. Banimento detecta padrão.
5. **Mídia primeiro, texto depois.** Se você envia áudio + texto, mande em mensagens separadas. WhatsApp gosta mais.

---

## 2. Endpoint POST /api/wa/send

📦 **`app/api/wa/send/route.ts`**:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { dispatchSend } from '@/lib/waha/dispatcher';
import { z } from 'zod';

const sendSchema = z.object({
  conversationId: z.string().uuid(),
  type: z.enum(['text', 'image', 'video', 'audio', 'document']),
  body: z.string().optional(),                                // texto ou caption
  media: z.object({
    url: z.string().url().optional(),
    base64: z.string().optional(),
    mimeType: z.string().optional(),
    filename: z.string().optional(),
  }).optional(),
  replyToMessageId: z.string().uuid().optional(),
});

export async function POST(req: NextRequest) {
  // 1. Auth do usuário
  const supaUser = getSupabaseServerClient();
  const { data: { user } } = await supaUser.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  // 2. Parse e valida
  const parsed = sendSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_input', issues: parsed.error.issues }, { status: 400 });
  }
  const input = parsed.data;

  // 3. Busca conversation (com RLS aplicada — confirma que user pertence à org)
  const { data: conv, error: convErr } = await supaUser
    .from('conversations')
    .select(`
      id, organization_id, channel_session_id, whatsapp_chat_id, status,
      channel_session:channel_sessions!inner ( waha_session_name, status )
    `)
    .eq('id', input.conversationId)
    .single();

  if (convErr || !conv) return NextResponse.json({ error: 'conversation_not_found' }, { status: 404 });

  // 4. Valida que sessão está WORKING
  const sessionStatus = (conv as any).channel_session.status;
  if (sessionStatus !== 'working') {
    return NextResponse.json({ error: 'session_not_ready', status: sessionStatus }, { status: 409 });
  }

  // 5. Insere mensagem com status='sending' (admin client pra triggers)
  const supa = getSupabaseAdminClient();
  const { data: msg, error: mErr } = await supa
    .from('messages')
    .insert({
      organization_id: conv.organization_id,
      conversation_id: conv.id,
      from_me: true,
      sender_user_id: user.id,
      type: input.type,
      body: input.body ?? null,
      media_url: input.media?.url ?? null,
      media_mime_type: input.media?.mimeType ?? null,
      media_filename: input.media?.filename ?? null,
      status: 'sending',
      sent_at: new Date().toISOString(),
      metadata: input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {},
    })
    .select('id')
    .single();

  if (mErr || !msg) return NextResponse.json({ error: 'insert_failed', message: mErr?.message }, { status: 500 });

  // 6. Despacha para o WAHA (async — não bloqueia o response)
  dispatchSend({
    messageId: msg.id,
    sessionName: (conv as any).channel_session.waha_session_name,
    chatId: conv.whatsapp_chat_id,
    input,
  }).catch((err) => {
    console.error('[send] dispatch error', err);
  });

  // 7. Retorna imediatamente (otimistic)
  return NextResponse.json({ id: msg.id, status: 'sending' });
}

export const dynamic = 'force-dynamic';
```

---

## 3. Dispatcher (chama o WAHA)

📦 **`lib/waha/dispatcher.ts`**:

```typescript
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { getWahaClient, WahaClient } from './index';
import { acquireSendLock, releaseSendLock } from './rate-limiter';

export async function dispatchSend(args: {
  messageId: string;
  sessionName: string;
  chatId: string;
  input: {
    type: 'text' | 'image' | 'video' | 'audio' | 'document';
    body?: string;
    media?: { url?: string; base64?: string; mimeType?: string; filename?: string };
    replyToMessageId?: string;
  };
}) {
  const { messageId, sessionName, chatId, input } = args;
  const supa = getSupabaseAdminClient();
  const waha = getWahaClient();

  // 1. Lock de rate limit (max 1 envio/seg/sessão)
  await acquireSendLock(sessionName);

  try {
    let externalId: string | null = null;

    if (input.type === 'text') {
      if (!input.body) throw new Error('Texto vazio');
      const sent = await waha.sendText({ session: sessionName, chatId, text: input.body });
      externalId = sent.id;
    } else if (input.type === 'image') {
      const sent = await waha.sendImage({
        session: sessionName,
        chatId,
        file: { url: input.media?.url, data: input.media?.base64, mimetype: input.media?.mimeType, filename: input.media?.filename },
        caption: input.body,
      });
      externalId = sent.id;
    } else if (input.type === 'audio') {
      const sent = await waha.sendVoice({
        session: sessionName,
        chatId,
        file: { url: input.media?.url, data: input.media?.base64 },
      });
      externalId = sent.id;
    } else if (input.type === 'document' || input.type === 'video') {
      const sent = await waha.sendFile({
        session: sessionName,
        chatId,
        file: {
          url: input.media?.url,
          data: input.media?.base64,
          mimetype: input.media?.mimeType,
          filename: input.media?.filename ?? `file.${input.type}`,
        },
        caption: input.body,
      });
      externalId = sent.id;
    } else {
      throw new Error(`Tipo de mensagem não suportado: ${input.type}`);
    }

    // 2. Atualiza com external_id e status sent
    await supa
      .from('messages')
      .update({
        external_id: externalId,
        external_session: sessionName,
        status: 'sent',
        ack: 1,
      })
      .eq('id', messageId);
  } catch (err) {
    console.error(`[dispatch] envio falhou pra mensagem ${messageId}:`, err);
    await supa
      .from('messages')
      .update({
        status: 'failed',
        failed_reason: String(err).slice(0, 500),
      })
      .eq('id', messageId);
    throw err;
  } finally {
    releaseSendLock(sessionName);
  }
}
```

---

## 4. Rate limiter por sessão

⚠️ **Crítico anti-ban:** WhatsApp detecta padrão e penaliza disparos rápidos. **Limite de produção: 1 mensagem por segundo por sessão**, com jitter aleatório.

📦 **`lib/waha/rate-limiter.ts`** (in-memory; pra multi-instância use Redis):

```typescript
const lastSendBySession = new Map<string, number>();
const queueBySession = new Map<string, Array<() => void>>();

const MIN_INTERVAL_MS = 1200;   // 1.2s entre envios
const JITTER_MS = 800;          // até 800ms de variação aleatória

export async function acquireSendLock(sessionName: string): Promise<void> {
  return new Promise((resolve) => {
    const now = Date.now();
    const last = lastSendBySession.get(sessionName) ?? 0;
    const jitter = Math.floor(Math.random() * JITTER_MS);
    const wait = Math.max(0, last + MIN_INTERVAL_MS + jitter - now);

    const queue = queueBySession.get(sessionName) ?? [];
    queue.push(() => {
      lastSendBySession.set(sessionName, Date.now());
      resolve();
    });
    queueBySession.set(sessionName, queue);

    setTimeout(() => {
      const q = queueBySession.get(sessionName);
      if (q && q.length > 0) {
        const next = q.shift()!;
        next();
      }
    }, wait);
  });
}

export function releaseSendLock(_sessionName: string) {
  // No-op: o lock é baseado em tempo, não em flag.
  // Mantido como API pra futura troca por mutex real.
}
```

⚠️ **Gotcha:** este rate limiter é in-memory. Em produção multi-instância (Vercel com várias regiões), use **Upstash Redis com `INCR` + `EXPIRE`** ou **fila dedicada (BullMQ, Inngest, Trigger.dev)**.

---

## 5. Fila durável (recomendado pra produção)

Para volumes maiores ou para mensagens agendadas, troque o `dispatchSend` direto por uma fila:

**Opções:**

| Solução | Vantagens | Desvantagens |
|---------|-----------|--------------|
| **Inngest** | Nativo serverless, Vercel-friendly, fácil de escrever | Custo escala |
| **Trigger.dev** | Mesmo benefício, BR-friendly | Idem |
| **BullMQ + Redis** | Total controle | Você gerencia infra |
| **Vercel Queues** | Nativo Vercel (beta) | Beta, ecossistema novo |
| **pg_boss em cima do Postgres** | Sem infra extra | Menos features |

**Padrão genérico (Inngest):**

```typescript
import { Inngest } from 'inngest';
const inngest = new Inngest({ id: 'crm-whatsapp' });

export const sendWhatsAppFn = inngest.createFunction(
  { id: 'wa-send', concurrency: { key: 'event.data.sessionName', limit: 1 } },
  { event: 'wa/send' },
  async ({ event, step }) => {
    await step.sleep('throttle', '1.2s');  // garante intervalo
    await step.run('dispatch', () => dispatchSend(event.data));
  }
);

// No endpoint /api/wa/send:
await inngest.send({ name: 'wa/send', data: { messageId, sessionName, chatId, input } });
```

---

## 6. Anti-banimento: regras de ouro

### O que pega ban
1. **Volume desproporcional ao histórico** do número (número novo + 100 mensagens dia 1 = ban)
2. **Mensagem fria pra muita gente** que não responde (cold outreach em massa)
3. **Mesma mensagem pra muitos** (template idêntico em escala)
4. **Denúncias de usuários** (3+ "isso não é spam" e o número entra em revisão)
5. **Padrão de bot** (intervalos exatos, sem variação)

### O que protege

| Prática | Como implementar |
|---------|------------------|
| Warm-up do número | Antes de campanha, troque mensagens manuais por 7-14 dias com humanos reais |
| Variação de copy | Pelo menos 5 variações por mensagem (template + spinning) |
| Janela de horário | Não envie 0h-7h. Não envie domingo (alguns países) |
| Throttling agressivo | 1 msg/2s mínimo. Em campanha, 1 msg/5s |
| Pausa após N envios | A cada 50 envios, pausa de 60s |
| Jitter no intervalo | Nunca enviar com timing exato |
| Limite diário | 200-500 msgs/dia em número novo, 1000+ só após meses |
| Opt-in claro | Cliente sabe que vai receber. Mensagem inicial sempre pergunta autorização |

### Implementação de spinning

```typescript
function spin(template: string, vars: Record<string, string>): string {
  // {{name}} → vars.name
  let out = template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');

  // {opt1|opt2|opt3} → escolhe uma aleatoriamente
  out = out.replace(/\{([^{}]+\|[^{}]+)\}/g, (_, opts) => {
    const choices = opts.split('|');
    return choices[Math.floor(Math.random() * choices.length)];
  });

  return out;
}

// Uso
spin('Oi {João|Maria}, tudo {bem|certo}? {{produto}}', { produto: 'Curso de IA' })
// → "Oi Maria, tudo bem? Curso de IA"
```

---

## 7. Mídia: subir antes de mandar

WAHA aceita mídia de 3 formas:
1. **URL pública** — você passa um link, WAHA baixa e envia. Mais simples.
2. **Base64 inline** — você manda o conteúdo. Pesado em payloads grandes.
3. **🔌 Plus: file upload prévio** — você sobe uma vez e referencia.

**Recomendação:** sobe a mídia primeiro pro **seu Supabase Storage** (público ou com URL assinada), depois passa a URL ao WAHA. Vantagens:
- Você tem cópia da mídia.
- WAHA não armazena permanentemente.
- Reutilização entre sessões.

📦 **`app/api/wa/upload/route.ts`** (recebe mídia do frontend, sobe pro Storage, retorna URL):

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { randomUUID } from 'crypto';

export async function POST(req: NextRequest) {
  const supa = getSupabaseServerClient();
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const form = await req.formData();
  const file = form.get('file') as File | null;
  const orgId = form.get('organizationId') as string;
  if (!file || !orgId) return NextResponse.json({ error: 'missing_input' }, { status: 400 });

  const path = `${orgId}/outbound/${randomUUID()}-${file.name}`;
  const { error } = await supa.storage.from('whatsapp-media').upload(path, file, {
    contentType: file.type,
    upsert: false,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: pub } = supa.storage.from('whatsapp-media').getPublicUrl(path);
  return NextResponse.json({
    url: pub.publicUrl,
    mimeType: file.type,
    filename: file.name,
    size: file.size,
  });
}
```

---

## 8. Retry e mensagens travadas em "sending"

Mensagem em `status='sending'` por mais de N minutos = problema. Cron job:

📦 **`app/api/cron/recover-stuck-messages/route.ts`**:

```typescript
export async function GET() {
  const supa = getSupabaseAdminClient();

  // Marca como falha após 5 minutos sem resposta do WAHA
  await supa.rpc('mark_stuck_messages_as_failed', { stuck_minutes: 5 });

  // Opcional: re-tenta se for "first attempt"
  // ...

  return new Response('ok');
}
```

```sql
-- migration
create or replace function public.mark_stuck_messages_as_failed(stuck_minutes int)
returns void language sql as $$
  update public.messages
  set status = 'failed', failed_reason = 'timeout: dispatch did not complete'
  where status = 'sending'
    and created_at < now() - (stuck_minutes::text || ' minutes')::interval;
$$;
```

Schedule no `vercel.ts`:

```typescript
crons: [
  { path: '/api/cron/recover-stuck-messages', schedule: '*/5 * * * *' },
],
```

---

## 9. Mensagens agendadas (scheduled send)

Adicione campo `scheduled_for timestamptz` em `messages`. Cria com `status='scheduled'`. Cron job cada minuto despacha as que chegaram a hora:

```sql
alter table public.messages add column if not exists scheduled_for timestamptz;
create index on public.messages (scheduled_for) where status = 'scheduled';
```

```typescript
// /api/cron/dispatch-scheduled
const { data: due } = await supa
  .from('messages')
  .select('*, conversation:conversations!inner(channel_session:channel_sessions!inner(waha_session_name))')
  .eq('status', 'scheduled')
  .lte('scheduled_for', new Date().toISOString())
  .limit(100);

for (const msg of due ?? []) {
  await supa.from('messages').update({ status: 'sending' }).eq('id', msg.id);
  await dispatchSend({ /* ... */ });
}
```

---

## 10. Conferência rápida da implementação

Checklist mental antes de declarar pronto:

- [ ] POST `/api/wa/send` valida user, persiste `messages`, dispatcha async
- [ ] Dispatcher trata 5 tipos: text, image, video, audio, document
- [ ] External_id preenchido após resposta WAHA
- [ ] Rate limit 1 msg/seg por sessão
- [ ] Falha = `status='failed'` com `failed_reason`
- [ ] Mensagem travada > 5min vira `failed`
- [ ] Mídia sobe pro Storage antes de mandar
- [ ] Realtime publica updates de `messages` pra UI mudar checks de cinza pra azul

---

## Próximo: [07-realtime-frontend.md](07-realtime-frontend.md)
