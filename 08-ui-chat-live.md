# 08 — UI Chat Live: anatomia e implementação

> **Resumo:** a tela completa de chat. Layout 3 colunas, lista lateral, thread, composer, indicadores de status. Componentes Next.js + shadcn/ui prontos pra colar.

---

## 1. Anatomia da UI

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                                  CRM TopBar                                        │
├──────────────────┬───────────────────────────────────────┬───────────────────────┤
│                  │                                       │                       │
│  ConversationList│           ChatThread                  │   CRMSidePanel        │
│                  │                                       │                       │
│  - Search        │   - ChatHeader (contato + ações)      │   - Contato           │
│  - Filters       │   - MessagesList (scrollable)         │     - Nome            │
│  - Conversations │     ┌─────────────────────────────┐   │     - Telefone        │
│    (item)        │     │ MessageBubble (cliente)     │   │     - Email           │
│  - Conv. (item)  │     │ MessageBubble (operador) ✓  │   │     - Tags            │
│  - ...           │     │ MessageBubble (cliente)     │   │   - Deal vinculado    │
│                  │     │ ...                         │   │   - Histórico         │
│                  │     └─────────────────────────────┘   │   - Notas             │
│                  │   - TypingIndicator                   │   - Agendar           │
│                  │   - Composer (input + anexos + send)  │                       │
│                  │                                       │                       │
└──────────────────┴───────────────────────────────────────┴───────────────────────┘
```

---

## 2. Layout root

📦 **`app/(crm)/chat/layout.tsx`**:

```typescript
export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-[calc(100vh-4rem)] overflow-hidden">
      {children}
    </div>
  );
}
```

📦 **`app/(crm)/chat/page.tsx`**:

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

📦 **`app/(crm)/chat/[conversationId]/page.tsx`**:

```typescript
import { ConversationList } from '@/components/chat/ConversationList';
import { ChatThread } from '@/components/chat/ChatThread';
import { CRMSidePanel } from '@/components/chat/CRMSidePanel';

export default function ConversationPage({ params }: { params: { conversationId: string } }) {
  return (
    <>
      <ConversationList activeConversationId={params.conversationId} />
      <ChatThread conversationId={params.conversationId} />
      <CRMSidePanel conversationId={params.conversationId} />
    </>
  );
}
```

---

## 3. Componente: `ConversationList`

📦 **`components/chat/ConversationList.tsx`**:

```typescript
'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Search, Filter } from 'lucide-react';
import { useConversationsRealtime } from '@/hooks/useConversationsRealtime';
import { useOrganization } from '@/hooks/useOrganization';
import { ConversationItem } from './ConversationItem';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

export function ConversationList({ activeConversationId }: { activeConversationId?: string }) {
  const { organizationId } = useOrganization();
  const { conversations, loading } = useConversationsRealtime(organizationId);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'unread' | 'mine' | 'open' | 'resolved'>('all');

  const filtered = conversations
    .filter((c) => {
      if (search) {
        const q = search.toLowerCase();
        return (
          (c.contact_name?.toLowerCase().includes(q) ||
           c.contact_phone.includes(q) ||
           c.last_message_preview?.toLowerCase().includes(q))
        );
      }
      return true;
    })
    .filter((c) => {
      if (filter === 'unread') return c.unread_count > 0;
      if (filter === 'open') return c.status === 'open';
      if (filter === 'resolved') return c.status === 'resolved';
      // 'mine' precisa de currentUserId — passe via prop ou contexto
      return true;
    });

  return (
    <aside className="w-80 border-r border-border flex flex-col bg-card">
      <div className="p-4 border-b border-border space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Buscar contato ou mensagem..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Tabs value={filter} onValueChange={(v) => setFilter(v as any)}>
          <TabsList className="grid grid-cols-4 w-full">
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
          <div className="p-8 text-center text-sm text-muted-foreground">
            Nenhuma conversa
          </div>
        )}
        {filtered.map((c) => (
          <Link key={c.id} href={`/chat/${c.id}`} prefetch={false}>
            <ConversationItem conversation={c} active={c.id === activeConversationId} />
          </Link>
        ))}
      </div>
    </aside>
  );
}
```

---

## 4. Componente: `ConversationItem`

📦 **`components/chat/ConversationItem.tsx`**:

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
  const displayName = c.is_group
    ? c.group_name ?? 'Grupo'
    : c.contact_name ?? c.contact_phone;
  const initial = displayName.charAt(0).toUpperCase();

  return (
    <div
      className={cn(
        'flex items-center gap-3 p-3 border-b border-border cursor-pointer hover:bg-accent/50 transition',
        active && 'bg-accent',
      )}
    >
      <Avatar className="w-12 h-12">
        {c.contact_picture && <AvatarImage src={c.contact_picture} />}
        <AvatarFallback>{initial}</AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-medium truncate">{displayName}</span>
          {c.last_message_at && (
            <span className="text-xs text-muted-foreground shrink-0">
              {formatDistanceToNowStrict(new Date(c.last_message_at), { locale: ptBR, addSuffix: false })}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 mt-0.5">
          <p className="text-sm text-muted-foreground truncate">
            {c.last_message_preview ?? '(sem mensagens)'}
          </p>
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

---

## 5. Componente: `ChatThread`

📦 **`components/chat/ChatThread.tsx`**:

```typescript
'use client';
import { useEffect, useRef } from 'react';
import { useMessagesRealtime } from '@/hooks/useMessagesRealtime';
import { useOrganization } from '@/hooks/useOrganization';
import { ChatHeader } from './ChatHeader';
import { MessageBubble } from './MessageBubble';
import { Composer } from './Composer';
import { TypingIndicator } from './TypingIndicator';
import { useMarkAsRead } from '@/hooks/useMarkAsRead';

export function ChatThread({ conversationId }: { conversationId: string }) {
  const { organizationId } = useOrganization();
  const { messages, loading } = useMessagesRealtime({ conversationId, organizationId });
  const scrollRef = useRef<HTMLDivElement>(null);
  useMarkAsRead(conversationId);

  // Auto-scroll para o fim quando mensagens mudam
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  return (
    <main className="flex-1 flex flex-col bg-background">
      <ChatHeader conversationId={conversationId} />

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4 space-y-2">
        {loading && <div className="text-center text-sm text-muted-foreground">Carregando mensagens...</div>}
        {!loading && messages.length === 0 && (
          <div className="text-center text-sm text-muted-foreground py-8">
            Sem mensagens. Envie a primeira para iniciar.
          </div>
        )}
        {messages.map((m, i) => (
          <MessageBubble
            key={m.id}
            message={m}
            previousMessage={messages[i - 1]}
          />
        ))}
        <TypingIndicator conversationId={conversationId} />
      </div>

      <Composer conversationId={conversationId} />
    </main>
  );
}
```

---

## 6. Componente: `MessageBubble`

📦 **`components/chat/MessageBubble.tsx`**:

```typescript
import { cn } from '@/lib/utils';
import { Check, CheckCheck, Clock, AlertCircle, Pause } from 'lucide-react';
import { format } from 'date-fns';
import type { ChatMessage } from '@/hooks/useMessagesRealtime';

export function MessageBubble({
  message: m,
  previousMessage,
}: {
  message: ChatMessage;
  previousMessage?: ChatMessage;
}) {
  // Agrupa balões consecutivos do mesmo lado
  const groupedWithPrevious =
    previousMessage && previousMessage.from_me === m.from_me &&
    Math.abs(new Date(m.sent_at).getTime() - new Date(previousMessage.sent_at).getTime()) < 60_000;

  return (
    <div className={cn('flex', m.from_me ? 'justify-end' : 'justify-start', groupedWithPrevious ? 'mt-1' : 'mt-3')}>
      <div
        className={cn(
          'max-w-[70%] rounded-2xl px-3 py-2 shadow-sm',
          m.from_me
            ? 'bg-primary text-primary-foreground rounded-br-sm'
            : 'bg-muted rounded-bl-sm',
        )}
      >
        <MessageContent message={m} />
        <div
          className={cn(
            'flex items-center gap-1 text-[10px] mt-1',
            m.from_me ? 'text-primary-foreground/70 justify-end' : 'text-muted-foreground',
          )}
        >
          <span>{format(new Date(m.sent_at), 'HH:mm')}</span>
          {m.from_me && <StatusIcon status={m.status} ack={m.ack} />}
        </div>
      </div>
    </div>
  );
}

function StatusIcon({ status, ack }: { status: string; ack: number }) {
  if (status === 'failed') return <AlertCircle className="w-3 h-3 text-destructive" />;
  if (status === 'sending') return <Clock className="w-3 h-3" />;
  if (ack >= 4) return <CheckCheck className="w-3 h-3 text-blue-400" />;        // lido
  if (ack >= 3) return <CheckCheck className="w-3 h-3" />;                       // entregue
  if (ack >= 2) return <Check className="w-3 h-3" />;                            // enviado servidor
  return <Check className="w-3 h-3 opacity-50" />;
}

function MessageContent({ message: m }: { message: ChatMessage }) {
  if (m.type === 'text') {
    return <p className="text-sm whitespace-pre-wrap break-words">{m.body}</p>;
  }
  if (m.type === 'image') {
    return (
      <div>
        {m.media_url && <img src={m.media_url} alt="" className="rounded-lg max-w-full max-h-80 object-cover mb-1" />}
        {m.body && <p className="text-sm whitespace-pre-wrap">{m.body}</p>}
      </div>
    );
  }
  if (m.type === 'audio') {
    return (
      <div className="flex items-center gap-2">
        <audio controls src={m.media_url ?? undefined} className="max-w-[240px]" />
        {m.media_duration_seconds && (
          <span className="text-xs">{m.media_duration_seconds}s</span>
        )}
      </div>
    );
  }
  if (m.type === 'video') {
    return (
      <video controls src={m.media_url ?? undefined} className="rounded-lg max-w-full max-h-80" />
    );
  }
  if (m.type === 'document') {
    return (
      <a
        href={m.media_url ?? '#'}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-2 underline"
      >
        📄 {m.media_filename ?? 'Documento'}
      </a>
    );
  }
  if (m.type === 'location') {
    const lat = m.metadata?.location?.lat;
    const lng = m.metadata?.location?.lng;
    return (
      <a
        href={`https://maps.google.com/?q=${lat},${lng}`}
        target="_blank"
        rel="noreferrer"
        className="text-sm underline"
      >
        📍 Ver localização
      </a>
    );
  }
  return <p className="text-sm italic opacity-70">[{m.type}]</p>;
}
```

---

## 7. Componente: `Composer` (input + anexos + envio)

📦 **`components/chat/Composer.tsx`**:

```typescript
'use client';
import { useState, useRef, KeyboardEvent } from 'react';
import { Send, Paperclip, Mic, Image as ImageIcon, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useSendMessage } from '@/hooks/useSendMessage';
import { uploadMedia } from '@/lib/api/upload';

export function Composer({ conversationId }: { conversationId: string }) {
  const [text, setText] = useState('');
  const [attachment, setAttachment] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { send, sending } = useSendMessage({ conversationId });

  const handleSend = async () => {
    if (!text.trim() && !attachment) return;

    if (attachment) {
      setUploading(true);
      try {
        const uploaded = await uploadMedia(attachment);
        const type = guessTypeFromMime(attachment.type);
        await send({
          type,
          body: text.trim() || undefined,
          media: { url: uploaded.url, mimeType: uploaded.mimeType, filename: uploaded.filename },
        });
      } finally {
        setUploading(false);
        setAttachment(null);
      }
    } else {
      await send({ type: 'text', body: text.trim() });
    }
    setText('');
  };

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
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
          <button onClick={() => setAttachment(null)}>
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="flex items-end gap-2">
        <Button
          size="icon"
          variant="ghost"
          onClick={() => fileInputRef.current?.click()}
          disabled={sending || uploading}
        >
          <Paperclip className="w-5 h-5" />
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept="image/*,video/*,audio/*,application/pdf"
          onChange={(e) => setAttachment(e.target.files?.[0] ?? null)}
        />

        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKey}
          placeholder="Digite uma mensagem..."
          rows={1}
          className="flex-1 min-h-[40px] max-h-[160px] resize-none"
          disabled={sending || uploading}
        />

        <Button
          size="icon"
          onClick={handleSend}
          disabled={(!text.trim() && !attachment) || sending || uploading}
        >
          {uploading ? '...' : <Send className="w-5 h-5" />}
        </Button>
      </div>
    </div>
  );
}

function guessTypeFromMime(mime: string): 'image' | 'video' | 'audio' | 'document' {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}
```

📦 **`lib/api/upload.ts`**:

```typescript
export async function uploadMedia(file: File): Promise<{ url: string; mimeType: string; filename: string }> {
  const form = new FormData();
  form.append('file', file);
  // Pegue organizationId do contexto/cookie
  form.append('organizationId', await getCurrentOrgId());
  const res = await fetch('/api/wa/upload', { method: 'POST', body: form });
  if (!res.ok) throw new Error('upload_failed');
  return res.json();
}

async function getCurrentOrgId(): Promise<string> {
  // Implementar de acordo com seu contexto de auth
  return localStorage.getItem('currentOrgId') ?? '';
}
```

---

## 8. Componente: `ChatHeader`

📦 **`components/chat/ChatHeader.tsx`**:

```typescript
'use client';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { CheckCircle2, MoreVertical, Phone, UserPlus } from 'lucide-react';
import { useConversation } from '@/hooks/useConversation';

export function ChatHeader({ conversationId }: { conversationId: string }) {
  const { conversation, contact, resolveConversation, assignToMe } = useConversation(conversationId);

  if (!conversation || !contact) return <div className="border-b border-border p-4">Carregando...</div>;

  return (
    <div className="border-b border-border px-6 py-3 flex items-center gap-3 bg-card">
      <Avatar className="w-10 h-10">
        {contact.profile_picture_url && <AvatarImage src={contact.profile_picture_url} />}
        <AvatarFallback>{(contact.full_name ?? contact.phone_number).charAt(0).toUpperCase()}</AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0">
        <div className="font-semibold truncate">{contact.full_name ?? contact.push_name ?? contact.phone_number}</div>
        <div className="text-xs text-muted-foreground truncate">
          {contact.phone_number}
          {conversation.assigned_user_id && ' · Atribuída'}
          {conversation.status === 'resolved' && ' · Resolvida'}
        </div>
      </div>
      <Button variant="ghost" size="sm" onClick={assignToMe}>
        <UserPlus className="w-4 h-4 mr-1" /> Eu cuido
      </Button>
      <Button variant="ghost" size="sm" onClick={resolveConversation}>
        <CheckCircle2 className="w-4 h-4 mr-1" /> Resolver
      </Button>
      <Button variant="ghost" size="icon">
        <MoreVertical className="w-4 h-4" />
      </Button>
    </div>
  );
}
```

---

## 9. Componente: `CRMSidePanel` (binding com CRM)

📦 **`components/chat/CRMSidePanel.tsx`** (esqueleto — implementação completa em [09-binding-crm.md](09-binding-crm.md)):

```typescript
'use client';
import { useConversation } from '@/hooks/useConversation';
import { ContactSection } from './sidepanel/ContactSection';
import { DealSection } from './sidepanel/DealSection';
import { NotesSection } from './sidepanel/NotesSection';
import { TimelineSection } from './sidepanel/TimelineSection';

export function CRMSidePanel({ conversationId }: { conversationId: string }) {
  const { conversation, contact } = useConversation(conversationId);

  if (!conversation || !contact) return null;

  return (
    <aside className="w-96 border-l border-border bg-card overflow-y-auto">
      <ContactSection contact={contact} />
      <DealSection conversationId={conversationId} contactId={contact.id} primaryDealId={conversation.primary_deal_id} />
      <NotesSection contactId={contact.id} />
      <TimelineSection contactId={contact.id} />
    </aside>
  );
}
```

---

## 10. Hook auxiliar: `useMarkAsRead`

📦 **`hooks/useMarkAsRead.ts`**:

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

---

## 11. Tela de conexão de número (QR code)

📦 **`app/(crm)/settings/whatsapp/page.tsx`**:

```typescript
'use client';
import { useState } from 'react';
import { useChannelSessions } from '@/hooks/useChannelSessions';
import { CreateSessionButton } from '@/components/whatsapp/CreateSessionButton';
import { SessionCard } from '@/components/whatsapp/SessionCard';

export default function WhatsAppSettingsPage() {
  const { sessions, refresh } = useChannelSessions();

  return (
    <div className="container max-w-4xl py-8 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Conexões do WhatsApp</h1>
        <CreateSessionButton onCreated={refresh} />
      </div>
      <div className="grid gap-4">
        {sessions.map((s) => (
          <SessionCard key={s.id} session={s} onChange={refresh} />
        ))}
      </div>
    </div>
  );
}
```

📦 **`components/whatsapp/SessionCard.tsx`** (mostra QR quando precisa):

```typescript
'use client';
import { useChannelSession } from '@/hooks/useChannelSession';
import { Button } from '@/components/ui/button';
import Image from 'next/image';

export function SessionCard({ session: initial, onChange }: any) {
  const live = useChannelSession(initial.id);
  const session = live ?? initial;

  return (
    <div className="border rounded-lg p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-semibold">{session.display_name ?? session.waha_session_name}</div>
          <div className="text-sm text-muted-foreground">{session.phone_number ?? '(não conectado)'}</div>
        </div>
        <StatusBadge status={session.status} />
      </div>

      {session.status === 'scan_qr' && session.qr_code && (
        <div className="flex flex-col items-center gap-3 py-4 bg-muted rounded">
          <img src={session.qr_code} alt="QR Code" className="w-64 h-64" />
          <p className="text-sm text-muted-foreground">
            Abra o WhatsApp do celular do negócio → Aparelhos conectados → Conectar um aparelho
          </p>
        </div>
      )}

      {session.status === 'working' && (
        <div className="text-sm text-green-600">✓ Conectado</div>
      )}

      {session.status === 'failed' && (
        <Button variant="destructive" onClick={() => fetch(`/api/wa/sessions/${session.id}/restart`, { method: 'POST' }).then(onChange)}>
          Tentar novamente
        </Button>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    working: 'bg-green-100 text-green-800',
    scan_qr: 'bg-yellow-100 text-yellow-800',
    pending: 'bg-gray-100 text-gray-800',
    stopped: 'bg-gray-200 text-gray-800',
    failed: 'bg-red-100 text-red-800',
  };
  return <span className={`px-2 py-1 rounded text-xs ${colors[status] ?? ''}`}>{status}</span>;
}
```

---

## 12. Mobile: o que muda

A 3-coluna não cabe em mobile. Soluções:
- Duas-rotas: `/chat` mostra apenas a lista; `/chat/[id]` mostra apenas a thread.
- Drawer pra `CRMSidePanel`.
- Composer fixo no bottom com `position: sticky`.
- Avoid `100vh` em iOS Safari → use `100dvh` (dynamic viewport).

```css
.chat-shell { height: 100dvh; }
```

---

## 13. Acessibilidade

- Roles: `<aside role="navigation">`, `<main role="main">`, `<form role="search">`.
- Foco: clicar numa conversa não deve "comer" o foco do composer; salve foco e restaure.
- Anúncio screen reader de mensagem nova: `aria-live="polite"` num elemento que recebe atualizações.
- Atalhos: `/` foca search, `n` próxima conversa, `Esc` desselecciona.

---

## Próximo: [09-binding-crm.md](09-binding-crm.md)
