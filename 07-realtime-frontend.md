# 07 — Realtime no Frontend

> **Resumo:** como a UI do CRM atualiza em tempo real quando uma mensagem chega ou muda de status. Comparativo de 4 padrões e implementação de referência com Supabase Realtime.

---

## 1. Os 4 padrões de realtime

| Padrão | Como funciona | Quando usar |
|--------|---------------|-------------|
| **Polling** | Frontend faz GET a cada N segundos | Protótipos. **Não use em prod.** |
| **Server-Sent Events (SSE)** | Conexão HTTP longa, servidor empurra eventos | Quando você não quer WebSocket |
| **WebSocket próprio** | Conexão bidirecional persistente | Apps muito específicos, gerencia conexão |
| **Supabase Realtime / Pusher / Ably** | Pub/sub gerenciado em cima do banco/canais | **Default recomendado** |

🎯 **Decisão padrão:** Supabase Realtime se você usa Supabase. Pusher como fallback se Realtime escalou demais.

---

## 2. Como Supabase Realtime funciona

Supabase escuta o WAL (Write-Ahead Log) do Postgres e publica mudanças em canais. Você assina:

- **Postgres Changes** → eventos de INSERT/UPDATE/DELETE em uma tabela.
- **Broadcast** → eventos arbitrários que você emite (cliente ou servidor).
- **Presence** → quem está online no canal.

Para Chat Live, **Postgres Changes** cobre 95%. Broadcast só é útil pra "tá digitando" e similares.

⚠️ **RLS aplica.** O cliente recebe apenas eventos das linhas que sua RLS permite. Por isso você não precisa filtrar manualmente — o Postgres já filtra.

---

## 3. Setup do Supabase client

📦 **`lib/supabase/browser.ts`**:

```typescript
import { createBrowserClient } from '@supabase/ssr';

let cached: ReturnType<typeof createBrowserClient> | null = null;

export function getSupabaseBrowserClient() {
  if (cached) return cached;
  cached = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
  return cached;
}
```

📦 **`lib/supabase/server.ts`**:

```typescript
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export function getSupabaseServerClient() {
  const cookieStore = cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get: (name) => cookieStore.get(name)?.value,
        set: (name, value, options) => cookieStore.set(name, value, options as any),
        remove: (name, options) => cookieStore.set(name, '', { ...options, maxAge: 0 } as any),
      },
    },
  );
}
```

📦 **`lib/supabase/admin.ts`** (apenas backend):

```typescript
import { createClient } from '@supabase/supabase-js';

export function getSupabaseAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}
```

---

## 4. Hook universal: `useRealtimeChannel`

📦 **`hooks/useRealtimeChannel.ts`**:

```typescript
'use client';
import { useEffect, useRef } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import type { RealtimeChannel } from '@supabase/supabase-js';

export interface RealtimeSubscription {
  channelName: string;
  table: string;
  event?: 'INSERT' | 'UPDATE' | 'DELETE' | '*';
  filter?: string;          // ex: "organization_id=eq.<uuid>"
  onChange: (payload: any) => void;
}

export function useRealtimeChannel(sub: RealtimeSubscription | null) {
  const channelRef = useRef<RealtimeChannel | null>(null);

  useEffect(() => {
    if (!sub) return;
    const supa = getSupabaseBrowserClient();
    const channel = supa
      .channel(sub.channelName)
      .on(
        'postgres_changes' as any,
        { event: sub.event ?? '*', schema: 'public', table: sub.table, filter: sub.filter },
        (payload) => sub.onChange(payload),
      )
      .subscribe();
    channelRef.current = channel;
    return () => {
      supa.removeChannel(channel);
      channelRef.current = null;
    };
  }, [sub?.channelName, sub?.table, sub?.event, sub?.filter]);
}
```

---

## 5. Hook de chat: `useConversationsRealtime`

Atualiza a lista lateral quando qualquer conversa da org muda.

📦 **`hooks/useConversationsRealtime.ts`**:

```typescript
'use client';
import { useState, useEffect, useCallback } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { useRealtimeChannel } from './useRealtimeChannel';

export interface ConversationListItem {
  id: string;
  contact_id: string;
  contact_name: string | null;
  contact_phone: string;
  contact_picture: string | null;
  last_message_preview: string | null;
  last_message_at: string | null;
  unread_count: number;
  status: string;
  is_group: boolean;
  group_name: string | null;
  assigned_user_id: string | null;
}

export function useConversationsRealtime(organizationId: string) {
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchConversations = useCallback(async () => {
    const supa = getSupabaseBrowserClient();
    const { data } = await supa
      .from('conversations')
      .select(`
        id, contact_id, last_message_preview, last_message_at, unread_count, status,
        is_group, group_name, assigned_user_id,
        contact:contacts ( full_name, push_name, phone_number, profile_picture_url )
      `)
      .eq('organization_id', organizationId)
      .neq('status', 'archived')
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(100);

    setConversations(
      (data ?? []).map((row: any) => ({
        id: row.id,
        contact_id: row.contact_id,
        contact_name: row.contact?.full_name ?? row.contact?.push_name ?? null,
        contact_phone: row.contact?.phone_number ?? '',
        contact_picture: row.contact?.profile_picture_url ?? null,
        last_message_preview: row.last_message_preview,
        last_message_at: row.last_message_at,
        unread_count: row.unread_count ?? 0,
        status: row.status,
        is_group: row.is_group,
        group_name: row.group_name,
        assigned_user_id: row.assigned_user_id,
      })),
    );
    setLoading(false);
  }, [organizationId]);

  useEffect(() => { fetchConversations(); }, [fetchConversations]);

  // Subscreve a updates de conversations e re-fetcha (estratégia simples).
  // Em escala maior, mescle o payload no estado em vez de re-fetch.
  useRealtimeChannel({
    channelName: `conversations_${organizationId}`,
    table: 'conversations',
    filter: `organization_id=eq.${organizationId}`,
    onChange: () => fetchConversations(),
  });

  return { conversations, loading, refresh: fetchConversations };
}
```

---

## 6. Hook de mensagens da thread: `useMessagesRealtime`

Atualiza a thread aberta quando mensagem nova entra.

📦 **`hooks/useMessagesRealtime.ts`**:

```typescript
'use client';
import { useState, useEffect, useCallback } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { useRealtimeChannel } from './useRealtimeChannel';

export interface ChatMessage {
  id: string;
  external_id: string | null;
  from_me: boolean;
  type: string;
  body: string | null;
  media_url: string | null;
  media_mime_type: string | null;
  media_filename: string | null;
  media_duration_seconds: number | null;
  status: string;
  ack: number;
  sent_at: string;
  created_at: string;
  metadata: Record<string, any>;
}

export function useMessagesRealtime(args: {
  conversationId: string | null;
  organizationId: string;
}) {
  const { conversationId, organizationId } = args;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchInitial = useCallback(async () => {
    if (!conversationId) return;
    setLoading(true);
    const supa = getSupabaseBrowserClient();
    const { data } = await supa
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('sent_at', { ascending: true, nullsFirst: false })
      .limit(200);
    setMessages((data ?? []) as ChatMessage[]);
    setLoading(false);
  }, [conversationId]);

  useEffect(() => { fetchInitial(); }, [fetchInitial]);

  useRealtimeChannel(
    conversationId
      ? {
          channelName: `messages_${conversationId}`,
          table: 'messages',
          filter: `conversation_id=eq.${conversationId}`,
          onChange: (payload) => {
            if (payload.eventType === 'INSERT') {
              setMessages((prev) => {
                // Idempotência local: evita duplicar quando o INSERT é por nós (otimistic)
                if (prev.find((m) => m.id === payload.new.id)) return prev;
                return [...prev, payload.new as ChatMessage];
              });
            } else if (payload.eventType === 'UPDATE') {
              setMessages((prev) =>
                prev.map((m) => (m.id === payload.new.id ? { ...m, ...payload.new } : m)),
              );
            } else if (payload.eventType === 'DELETE') {
              setMessages((prev) => prev.filter((m) => m.id !== payload.old.id));
            }
          },
        }
      : null,
  );

  return { messages, loading, refresh: fetchInitial };
}
```

---

## 7. Otimistic UI no envio

Quando o usuário envia, você quer mostrar a mensagem imediatamente — não esperar a API responder.

📦 **`hooks/useSendMessage.ts`**:

```typescript
'use client';
import { useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import type { ChatMessage } from './useMessagesRealtime';

export function useSendMessage(args: {
  conversationId: string;
  onOptimistic?: (msg: ChatMessage) => void;
}) {
  const [sending, setSending] = useState(false);

  const send = async (input: {
    type: 'text' | 'image' | 'audio' | 'video' | 'document';
    body?: string;
    media?: { url?: string; base64?: string; mimeType?: string; filename?: string };
  }) => {
    const optimistic: ChatMessage = {
      id: `optimistic-${uuidv4()}`,
      external_id: null,
      from_me: true,
      type: input.type,
      body: input.body ?? null,
      media_url: input.media?.url ?? null,
      media_mime_type: input.media?.mimeType ?? null,
      media_filename: input.media?.filename ?? null,
      media_duration_seconds: null,
      status: 'sending',
      ack: 0,
      sent_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      metadata: {},
    };
    args.onOptimistic?.(optimistic);

    setSending(true);
    try {
      const res = await fetch('/api/wa/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: args.conversationId, ...input }),
      });
      if (!res.ok) throw new Error(await res.text());
      // O Realtime vai entregar a mensagem real (com id verdadeiro).
      // Você pode reconciliar no useMessagesRealtime usando algum match heurístico,
      // mas o caminho mais simples é deixar o optimistic e o real coexistirem por <1s
      // e remover o optimistic quando o real chegar (id externo confere).
    } finally {
      setSending(false);
    }
  };

  return { send, sending };
}
```

**Reconciliação otimista ↔ realtime:** o Supabase Realtime entrega o INSERT da mensagem real. O optimistic tem `id='optimistic-...'`. Quando o real chega:
1. Marque o optimistic como "synced" e remova
2. Ou use um match (mesmo `body`, `from_me=true`, criado nos últimos 5s)

Implementação simples (substituir no `useMessagesRealtime`):

```typescript
onChange: (payload) => {
  if (payload.eventType === 'INSERT') {
    setMessages((prev) => {
      // Remove optimistic com mesmo body/recente
      const filtered = prev.filter((m) => {
        if (!m.id.startsWith('optimistic-')) return true;
        if (m.from_me === payload.new.from_me &&
            m.body === payload.new.body &&
            Math.abs(new Date(m.created_at).getTime() - new Date(payload.new.created_at).getTime()) < 10000) {
          return false; // descarta optimistic correspondente
        }
        return true;
      });
      return [...filtered, payload.new as ChatMessage];
    });
  }
  // ...
},
```

---

## 8. Status de sessão em tempo real (QR code)

📦 **`hooks/useChannelSession.ts`**:

```typescript
'use client';
import { useState, useEffect } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { useRealtimeChannel } from './useRealtimeChannel';

export interface ChannelSession {
  id: string;
  status: 'pending' | 'scan_qr' | 'working' | 'stopped' | 'failed';
  qr_code: string | null;
  phone_number: string | null;
  display_name: string | null;
  waha_session_name: string;
}

export function useChannelSession(sessionId: string) {
  const [session, setSession] = useState<ChannelSession | null>(null);

  useEffect(() => {
    const supa = getSupabaseBrowserClient();
    supa
      .from('channel_sessions')
      .select('id, status, qr_code, phone_number, display_name, waha_session_name')
      .eq('id', sessionId)
      .single()
      .then(({ data }) => setSession(data as ChannelSession));
  }, [sessionId]);

  useRealtimeChannel({
    channelName: `session_${sessionId}`,
    table: 'channel_sessions',
    event: 'UPDATE',
    filter: `id=eq.${sessionId}`,
    onChange: (payload) => setSession(payload.new as ChannelSession),
  });

  return session;
}
```

---

## 9. Indicador "tá digitando" (opcional, via Broadcast)

A presença/typing não vem como mudança de DB — vai por Broadcast Channel.

📦 **`hooks/useTypingIndicator.ts`**:

```typescript
'use client';
import { useEffect, useState, useRef } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';

export function useTypingIndicator(conversationId: string, userId: string) {
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const channelRef = useRef<any>(null);

  useEffect(() => {
    const supa = getSupabaseBrowserClient();
    const channel = supa
      .channel(`typing_${conversationId}`)
      .on('broadcast', { event: 'typing' }, ({ payload }) => {
        setTypingUsers((prev) => Array.from(new Set([...prev, payload.userId])));
        setTimeout(() => {
          setTypingUsers((prev) => prev.filter((u) => u !== payload.userId));
        }, 3000);
      })
      .subscribe();
    channelRef.current = channel;
    return () => { supa.removeChannel(channel); };
  }, [conversationId]);

  const broadcastTyping = () => {
    channelRef.current?.send({ type: 'broadcast', event: 'typing', payload: { userId } });
  };

  return { typingUsers, broadcastTyping };
}
```

---

## 10. Notificações push de mensagem nova

Quando o usuário **não está com a conversa aberta** mas precisa saber que chegou mensagem:

```typescript
// Em useConversationsRealtime, no onChange:
onChange: (payload) => {
  if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
    fetchConversations();
    
    // Browser notification se a conversa nova/atualizada não está aberta
    if (payload.new.last_inbound_at && Notification.permission === 'granted') {
      new Notification('Nova mensagem no CRM', {
        body: payload.new.last_message_preview ?? '',
        icon: '/icon.png',
      });
    }
    
    // Som de notificação
    new Audio('/sounds/notification.mp3').play().catch(() => {});
  }
},
```

Pedir permissão na primeira visita à página de chat:

```typescript
useEffect(() => {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}, []);
```

---

## 11. Performance: gotchas reais

| Gotcha | Solução |
|--------|---------|
| Re-fetch a cada INSERT em conversa de alta atividade | Debounce: agrupa updates em janela de 200ms antes de fetchar |
| Realtime cai sem reconnect | Supabase reconecta automaticamente; mostre banner "Reconectando..." quando `channel.state` ≠ `joined` |
| Memory leak em mudança de conversa | useEffect cleanup com `removeChannel` é OBRIGATÓRIO |
| 1000 mensagens carregadas de uma vez = lag | Pagina por scroll infinito (50 por vez, mais ao subir) |
| Campos jsonb muito grandes via realtime | Realtime entrega a linha inteira; mantenha jsonb pequeno |

---

## Próximo: [08-ui-chat-live.md](08-ui-chat-live.md)
