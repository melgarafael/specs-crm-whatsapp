# PROMPT 04 — Frontend Chat Live

> **Cole após Fase 03. Implementa toda a UI de chat live: lista lateral + thread + composer + realtime.**

---

## Contexto

Fase **4 de 5**. As fases 1-3 já criaram: scaffolding, integração WAHA, webhook handler e endpoint de envio. Mensagens fluem dos dois lados — mas não tem UI ainda.

Sua missão: construir a tela de chat live completa.

## Sua missão

1. Hooks de realtime: `useRealtimeChannel`, `useConversationsRealtime`, `useMessagesRealtime`, `useSendMessage`, `useMarkAsRead`
2. Layout 3 colunas em `/chat`
3. Componentes: `ConversationList`, `ConversationItem`, `ChatHeader`, `ChatThread`, `MessageBubble`, `Composer`, `EmptyState`
4. Otimistic UI no envio
5. Status visual (cinza → azul) baseado em ack
6. Dependência: instalar `uuid` e `date-fns` (já feito na fase 1)

## Princípios de UX

- **Atualização instantânea:** mensagem nova aparece em <500ms via Supabase Realtime
- **Otimistic:** ao enviar, mensagem aparece IMEDIATAMENTE (mesmo antes do WAHA confirmar)
- **Auto-scroll:** thread scrollada pro fim quando entra mensagem nova
- **Mark as read:** abrir conversa zera `unread_count`
- **Status visual claro:** ⏱️ pending, ✓ sent, ✓✓ delivered, ✓✓ azul = read, ❗ failed

## Tasks

### 1. Hook `useRealtimeChannel` (genérico)

`src/hooks/useRealtimeChannel.ts`:

```typescript
'use client';
import { useEffect, useRef } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import type { RealtimeChannel } from '@supabase/supabase-js';

export interface RealtimeSubscription {
  channelName: string;
  table: string;
  event?: 'INSERT' | 'UPDATE' | 'DELETE' | '*';
  filter?: string;
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
    return () => { supa.removeChannel(channel); };
  }, [sub?.channelName, sub?.table, sub?.event, sub?.filter]);
}
```

### 2. Hook de organização

`src/hooks/useOrganization.ts`:

```typescript
'use client';
import { useEffect, useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';

export function useOrganization() {
  const [organizationId, setOrganizationId] = useState<string>('');

  useEffect(() => {
    const supa = getSupabaseBrowserClient();
    supa.from('user_organizations').select('organization_id').limit(1).single().then(({ data }) => {
      if (data) setOrganizationId(data.organization_id);
    });
  }, []);

  return { organizationId };
}
```

### 3. Hook de conversas

`src/hooks/useConversationsRealtime.ts`:

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

  const fetchConvs = useCallback(async () => {
    if (!organizationId) return;
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

  useEffect(() => { fetchConvs(); }, [fetchConvs]);

  useRealtimeChannel(
    organizationId
      ? {
          channelName: `conversations_${organizationId}`,
          table: 'conversations',
          filter: `organization_id=eq.${organizationId}`,
          onChange: () => fetchConvs(),
        }
      : null,
  );

  return { conversations, loading, refresh: fetchConvs };
}
```

### 4. Hook de mensagens

`src/hooks/useMessagesRealtime.ts`:

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
  const { conversationId } = args;
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
                // Reconcile com optimistic
                const filtered = prev.filter((m) => {
                  if (!m.id.startsWith('optimistic-')) return true;
                  if (m.from_me === payload.new.from_me &&
                      m.body === payload.new.body &&
                      Math.abs(new Date(m.created_at).getTime() - new Date(payload.new.created_at).getTime()) < 10000) {
                    return false;
                  }
                  return true;
                });
                if (filtered.find((m) => m.id === payload.new.id)) return filtered;
                return [...filtered, payload.new as ChatMessage];
              });
            } else if (payload.eventType === 'UPDATE') {
              setMessages((prev) => prev.map((m) => m.id === payload.new.id ? { ...m, ...payload.new } : m));
            }
          },
        }
      : null,
  );

  const addOptimistic = (msg: ChatMessage) => setMessages((prev) => [...prev, msg]);

  return { messages, loading, refresh: fetchInitial, addOptimistic };
}
```

### 5. Hook de envio com otimistic

`src/hooks/useSendMessage.ts`:

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
    media?: { url?: string; mimeType?: string; filename?: string };
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
    } finally {
      setSending(false);
    }
  };

  return { send, sending };
}
```

### 6. Hook mark as read

`src/hooks/useMarkAsRead.ts`:

```typescript
'use client';
import { useEffect } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';

export function useMarkAsRead(conversationId: string) {
  useEffect(() => {
    if (!conversationId) return;
    const supa = getSupabaseBrowserClient();
    supa.from('conversations').update({ unread_count: 0 }).eq('id', conversationId).then(() => {});
  }, [conversationId]);
}
```

### 7. Layout

`src/app/(crm)/chat/layout.tsx`:

```typescript
export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return <div className="flex h-screen overflow-hidden bg-background">{children}</div>;
}
```

### 8. Pages

`src/app/(crm)/chat/page.tsx`:

```typescript
import { ConversationList } from '@/components/chat/ConversationList';
import { EmptyState } from '@/components/chat/EmptyState';

export default function ChatPage() {
  return (
    <>
      <ConversationList />
      <EmptyState />
    </>
  );
}
```

`src/app/(crm)/chat/[conversationId]/page.tsx`:

```typescript
import { ConversationList } from '@/components/chat/ConversationList';
import { ChatThread } from '@/components/chat/ChatThread';

export default function ConversationPage({ params }: { params: { conversationId: string } }) {
  return (
    <>
      <ConversationList activeConversationId={params.conversationId} />
      <ChatThread conversationId={params.conversationId} />
    </>
  );
}
```

### 9. EmptyState

`src/components/chat/EmptyState.tsx`:

```typescript
import { MessageSquare } from 'lucide-react';

export function EmptyState() {
  return (
    <main className="flex-1 flex items-center justify-center bg-muted/30">
      <div className="text-center space-y-3 max-w-md">
        <div className="mx-auto w-16 h-16 rounded-full bg-muted flex items-center justify-center">
          <MessageSquare className="w-8 h-8 text-muted-foreground" />
        </div>
        <h2 className="text-lg font-semibold">Selecione uma conversa</h2>
        <p className="text-sm text-muted-foreground">
          Escolha uma conversa na lista lateral para começar a responder.
        </p>
      </div>
    </main>
  );
}
```

### 10. ConversationList

`src/components/chat/ConversationList.tsx`:

```typescript
'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Search } from 'lucide-react';
import { useConversationsRealtime } from '@/hooks/useConversationsRealtime';
import { useOrganization } from '@/hooks/useOrganization';
import { ConversationItem } from './ConversationItem';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

export function ConversationList({ activeConversationId }: { activeConversationId?: string }) {
  const { organizationId } = useOrganization();
  const { conversations, loading } = useConversationsRealtime(organizationId);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'unread' | 'open' | 'resolved'>('all');

  const filtered = conversations
    .filter((c) => {
      if (search) {
        const q = search.toLowerCase();
        return (c.contact_name?.toLowerCase().includes(q) ?? false) ||
          c.contact_phone.includes(q) ||
          (c.last_message_preview?.toLowerCase().includes(q) ?? false);
      }
      return true;
    })
    .filter((c) => {
      if (filter === 'unread') return c.unread_count > 0;
      if (filter === 'open') return c.status === 'open';
      if (filter === 'resolved') return c.status === 'resolved';
      return true;
    });

  return (
    <aside className="w-80 border-r border-border flex flex-col bg-card">
      <div className="p-4 border-b border-border space-y-3">
        <h2 className="font-semibold">Conversas</h2>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Buscar..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Tabs value={filter} onValueChange={(v) => setFilter(v as any)}>
          <TabsList className="grid grid-cols-4 w-full text-xs">
            <TabsTrigger value="all">Todas</TabsTrigger>
            <TabsTrigger value="unread">Não lidas</TabsTrigger>
            <TabsTrigger value="open">Abertas</TabsTrigger>
            <TabsTrigger value="resolved">Resolvidas</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && <div className="p-4 text-sm text-muted-foreground">Carregando...</div>}
        {!loading && filtered.length === 0 && (
          <div className="p-8 text-center text-sm text-muted-foreground">Nenhuma conversa</div>
        )}
        {filtered.map((c) => (
          <Link key={c.id} href={`/chat/${c.id}`} prefetch={false} className="block">
            <ConversationItem conversation={c} active={c.id === activeConversationId} />
          </Link>
        ))}
      </div>
    </aside>
  );
}
```

### 11. ConversationItem

`src/components/chat/ConversationItem.tsx`:

```typescript
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { formatDistanceToNowStrict } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import type { ConversationListItem } from '@/hooks/useConversationsRealtime';

export function ConversationItem({
  conversation: c,
  active,
}: {
  conversation: ConversationListItem;
  active?: boolean;
}) {
  const displayName = c.is_group ? c.group_name ?? 'Grupo' : c.contact_name ?? c.contact_phone;
  const initial = displayName.charAt(0).toUpperCase();

  return (
    <div className={cn(
      'flex items-center gap-3 p-3 border-b border-border cursor-pointer hover:bg-accent/50 transition',
      active && 'bg-accent',
    )}>
      <Avatar className="w-12 h-12">
        {c.contact_picture && <AvatarImage src={c.contact_picture} />}
        <AvatarFallback>{initial}</AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-medium truncate">{displayName}</span>
          {c.last_message_at && (
            <span className="text-xs text-muted-foreground shrink-0">
              {formatDistanceToNowStrict(new Date(c.last_message_at), { locale: ptBR })}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 mt-0.5">
          <p className="text-sm text-muted-foreground truncate">{c.last_message_preview ?? '(sem mensagens)'}</p>
          {c.unread_count > 0 && (
            <span className="bg-primary text-primary-foreground text-xs rounded-full px-2 py-0.5 min-w-[20px] text-center">
              {c.unread_count > 99 ? '99+' : c.unread_count}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
```

### 12. ChatThread

`src/components/chat/ChatThread.tsx`:

```typescript
'use client';
import { useEffect, useRef } from 'react';
import { useMessagesRealtime } from '@/hooks/useMessagesRealtime';
import { useOrganization } from '@/hooks/useOrganization';
import { ChatHeader } from './ChatHeader';
import { MessageBubble } from './MessageBubble';
import { Composer } from './Composer';
import { useMarkAsRead } from '@/hooks/useMarkAsRead';

export function ChatThread({ conversationId }: { conversationId: string }) {
  const { organizationId } = useOrganization();
  const { messages, loading, addOptimistic } = useMessagesRealtime({ conversationId, organizationId });
  const scrollRef = useRef<HTMLDivElement>(null);
  useMarkAsRead(conversationId);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length]);

  return (
    <main className="flex-1 flex flex-col bg-background">
      <ChatHeader conversationId={conversationId} />
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4 space-y-2">
        {loading && <div className="text-center text-sm text-muted-foreground">Carregando...</div>}
        {!loading && messages.length === 0 && (
          <div className="text-center text-sm text-muted-foreground py-8">
            Sem mensagens. Envie a primeira para iniciar.
          </div>
        )}
        {messages.map((m, i) => (
          <MessageBubble key={m.id} message={m} previousMessage={messages[i - 1]} />
        ))}
      </div>
      <Composer conversationId={conversationId} onOptimistic={addOptimistic} />
    </main>
  );
}
```

### 13. ChatHeader

`src/components/chat/ChatHeader.tsx`:

```typescript
'use client';
import { useEffect, useState } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { CheckCircle2 } from 'lucide-react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';

export function ChatHeader({ conversationId }: { conversationId: string }) {
  const [contact, setContact] = useState<any>(null);
  const [convStatus, setConvStatus] = useState<string>('open');

  useEffect(() => {
    const supa = getSupabaseBrowserClient();
    supa
      .from('conversations')
      .select('status, contact:contacts(full_name, push_name, phone_number, profile_picture_url)')
      .eq('id', conversationId)
      .single()
      .then(({ data }) => {
        if (data) {
          setContact((data as any).contact);
          setConvStatus(data.status);
        }
      });
  }, [conversationId]);

  const resolve = async () => {
    const supa = getSupabaseBrowserClient();
    await supa.from('conversations').update({ status: 'resolved' }).eq('id', conversationId);
    setConvStatus('resolved');
  };

  if (!contact) return <div className="border-b border-border p-4 h-16">Carregando...</div>;

  const name = contact.full_name ?? contact.push_name ?? contact.phone_number;

  return (
    <div className="border-b border-border px-6 py-3 flex items-center gap-3 bg-card">
      <Avatar className="w-10 h-10">
        {contact.profile_picture_url && <AvatarImage src={contact.profile_picture_url} />}
        <AvatarFallback>{name.charAt(0).toUpperCase()}</AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0">
        <div className="font-semibold truncate">{name}</div>
        <div className="text-xs text-muted-foreground truncate">{contact.phone_number}</div>
      </div>
      <Button variant={convStatus === 'resolved' ? 'secondary' : 'ghost'} size="sm" onClick={resolve}>
        <CheckCircle2 className="w-4 h-4 mr-1" />
        {convStatus === 'resolved' ? 'Resolvida' : 'Resolver'}
      </Button>
    </div>
  );
}
```

### 14. MessageBubble

`src/components/chat/MessageBubble.tsx`:

```typescript
import { cn } from '@/lib/utils';
import { Check, CheckCheck, Clock, AlertCircle } from 'lucide-react';
import { format } from 'date-fns';
import type { ChatMessage } from '@/hooks/useMessagesRealtime';

export function MessageBubble({
  message: m,
  previousMessage,
}: {
  message: ChatMessage;
  previousMessage?: ChatMessage;
}) {
  const grouped = previousMessage &&
    previousMessage.from_me === m.from_me &&
    Math.abs(new Date(m.sent_at).getTime() - new Date(previousMessage.sent_at).getTime()) < 60_000;

  return (
    <div className={cn('flex', m.from_me ? 'justify-end' : 'justify-start', grouped ? 'mt-1' : 'mt-3')}>
      <div className={cn(
        'max-w-[70%] rounded-2xl px-3 py-2 shadow-sm',
        m.from_me ? 'bg-primary text-primary-foreground rounded-br-sm' : 'bg-muted rounded-bl-sm',
      )}>
        <Content message={m} />
        <div className={cn(
          'flex items-center gap-1 text-[10px] mt-1',
          m.from_me ? 'text-primary-foreground/70 justify-end' : 'text-muted-foreground',
        )}>
          <span>{format(new Date(m.sent_at), 'HH:mm')}</span>
          {m.from_me && <Status status={m.status} ack={m.ack} />}
        </div>
      </div>
    </div>
  );
}

function Status({ status, ack }: { status: string; ack: number }) {
  if (status === 'failed') return <AlertCircle className="w-3 h-3" />;
  if (status === 'sending') return <Clock className="w-3 h-3" />;
  if (ack >= 4) return <CheckCheck className="w-3 h-3 text-blue-300" />;
  if (ack >= 3) return <CheckCheck className="w-3 h-3" />;
  if (ack >= 2) return <Check className="w-3 h-3" />;
  return <Check className="w-3 h-3 opacity-50" />;
}

function Content({ message: m }: { message: ChatMessage }) {
  if (m.type === 'text') return <p className="text-sm whitespace-pre-wrap break-words">{m.body}</p>;
  if (m.type === 'image') return (
    <div>
      {m.media_url && <img src={m.media_url} alt="" className="rounded-lg max-w-full max-h-80 object-cover mb-1" />}
      {m.body && <p className="text-sm whitespace-pre-wrap">{m.body}</p>}
    </div>
  );
  if (m.type === 'audio') return <audio controls src={m.media_url ?? undefined} className="max-w-[240px]" />;
  if (m.type === 'video') return <video controls src={m.media_url ?? undefined} className="rounded-lg max-w-full max-h-80" />;
  if (m.type === 'document') return (
    <a href={m.media_url ?? '#'} target="_blank" rel="noreferrer" className="flex items-center gap-2 underline">
      📄 {m.media_filename ?? 'Documento'}
    </a>
  );
  if (m.type === 'location') {
    const lat = m.metadata?.location?.lat;
    const lng = m.metadata?.location?.lng;
    return <a href={`https://maps.google.com/?q=${lat},${lng}`} target="_blank" rel="noreferrer" className="text-sm underline">📍 Ver localização</a>;
  }
  return <p className="text-sm italic opacity-70">[{m.type}]</p>;
}
```

### 15. Composer

`src/components/chat/Composer.tsx`:

```typescript
'use client';
import { useState, useRef, KeyboardEvent } from 'react';
import { Send, Paperclip, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useSendMessage } from '@/hooks/useSendMessage';
import { useOrganization } from '@/hooks/useOrganization';
import type { ChatMessage } from '@/hooks/useMessagesRealtime';

export function Composer({
  conversationId,
  onOptimistic,
}: {
  conversationId: string;
  onOptimistic: (msg: ChatMessage) => void;
}) {
  const { organizationId } = useOrganization();
  const [text, setText] = useState('');
  const [attachment, setAttachment] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { send, sending } = useSendMessage({ conversationId, onOptimistic });

  const handleSend = async () => {
    if (!text.trim() && !attachment) return;
    if (attachment && organizationId) {
      setUploading(true);
      try {
        const form = new FormData();
        form.append('file', attachment);
        form.append('organizationId', organizationId);
        const res = await fetch('/api/wa/upload', { method: 'POST', body: form });
        if (!res.ok) throw new Error('upload failed');
        const data = await res.json();
        const type = guessType(attachment.type);
        await send({ type, body: text.trim() || undefined, media: { url: data.url, mimeType: data.mimeType, filename: data.filename } });
      } finally {
        setUploading(false);
        setAttachment(null);
      }
    } else {
      await send({ type: 'text', body: text.trim() });
    }
    setText('');
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="border-t border-border p-4 bg-card">
      {attachment && (
        <div className="mb-2 flex items-center gap-2 text-sm bg-muted rounded-md px-3 py-2">
          <Paperclip className="w-4 h-4" />
          <span className="flex-1 truncate">{attachment.name}</span>
          <button onClick={() => setAttachment(null)}><X className="w-4 h-4" /></button>
        </div>
      )}
      <div className="flex items-end gap-2">
        <Button size="icon" variant="ghost" onClick={() => fileInputRef.current?.click()} disabled={sending || uploading}>
          <Paperclip className="w-5 h-5" />
        </Button>
        <input
          ref={fileInputRef} type="file" className="hidden"
          accept="image/*,video/*,audio/*,application/pdf"
          onChange={(e) => setAttachment(e.target.files?.[0] ?? null)}
        />
        <Textarea
          value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
          placeholder="Digite uma mensagem..." rows={1}
          className="flex-1 min-h-[40px] max-h-[160px] resize-none"
          disabled={sending || uploading}
        />
        <Button size="icon" onClick={handleSend} disabled={(!text.trim() && !attachment) || sending || uploading}>
          {uploading ? '...' : <Send className="w-5 h-5" />}
        </Button>
      </div>
    </div>
  );
}

function guessType(mime: string): 'image' | 'video' | 'audio' | 'document' {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}
```

## Definition of Done

- [ ] Acessar `/chat` mostra lista lateral + empty state
- [ ] Receber mensagem do celular faz aparecer item novo na lista (sem reload)
- [ ] Clicar item abre `/chat/[id]` com thread completa
- [ ] Mandar texto: aparece IMEDIATAMENTE com ícone de relógio (sending), depois muda pra ✓ (sent), depois ✓✓ (delivered), depois ✓✓ azul (read se cliente leu)
- [ ] Mandar imagem funciona (cliente recebe no WhatsApp)
- [ ] Status de leitura zerado ao abrir conversa (`unread_count`=0)
- [ ] Search filtra a lista
- [ ] Tabs (Todas / Não lidas / Abertas / Resolvidas) funcionam
- [ ] Botão "Resolver" muda status para resolved

## Não faça

- ❌ Implementar pipeline kanban — fase 5
- ❌ Implementar binding com deals — fase 5
- ❌ Mexer no schema do banco

Ao terminar: **"Fase 04 completa. Pode prosseguir para fase 05 (CRM Binding)."**
