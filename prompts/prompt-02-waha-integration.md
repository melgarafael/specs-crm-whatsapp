# PROMPT 02 — Integração com WAHA

> **Cole este prompt depois da Fase 01. Cria o cliente WAHA, endpoints de sessão e tela de conexão de número.**

---

## Contexto

Você está na **fase 2 de 5** de um CRM nichado. A fase 1 (scaffolding) está pronta: Next.js 14 App Router + TypeScript + Supabase configurados, schema SQL aplicado, estrutura de pastas criada.

Agora você vai integrar o **WAHA** (WhatsApp HTTP API self-hosted) — o serviço que conecta números de WhatsApp via QR code e expõe REST API.

## O que é WAHA

WAHA roda em Docker. Você precisa subi-lo localmente. URL padrão: `http://localhost:3000`. Existe versão Core (gratuita) e Plus (paga). Ambas falam HTTP REST.

**Engine recomendado:** NOWEB (mais leve e estável).

**Auth:** Plus exige header `X-Api-Key` cujo valor é o **plaintext**, mas o servidor compara contra o **hash SHA512 hex** que está em `WAHA_API_KEY` no env. Em Core, key é opcional.

## Sua missão

1. Subir WAHA via docker-compose
2. Criar cliente TypeScript pro WAHA (`lib/waha/client.ts`)
3. Criar endpoints REST pra gerenciar sessões
4. Criar tela em `/settings/whatsapp` que conecta número via QR

## Tasks detalhadas

### 1. Subir WAHA

Crie `docker-compose.dev.yml` na raiz do projeto:

```yaml
version: '3.8'
services:
  waha:
    image: devlikeapro/waha:noweb
    container_name: waha-dev
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      WAHA_LOG_LEVEL: "debug"
    volumes:
      - waha_sessions:/app/.sessions
volumes:
  waha_sessions:
```

Suba com `docker compose -f docker-compose.dev.yml up -d`.

Verifique: `curl http://localhost:3000/api/sessions` deve retornar `[]`.

### 2. Cliente WAHA

Crie `src/lib/waha/client.ts`:

```typescript
export interface WahaConfig {
  baseUrl: string;
  apiKey?: string;
}

export interface WahaSession {
  name: string;
  status: 'STARTING' | 'SCAN_QR_CODE' | 'WORKING' | 'STOPPED' | 'FAILED';
  me?: { id: string; pushName?: string };
  engine?: { engine: string };
}

export interface WahaSentMessage {
  id: string;
  ack?: number;
}

export class WahaError extends Error {
  constructor(msg: string, public statusCode?: number) { super(msg); }
}

export class WahaClient {
  private baseUrl: string;
  private apiKey?: string;

  constructor(config: WahaConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
  }

  private headers(extra: Record<string, string> = {}): HeadersInit {
    const h: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
    if (this.apiKey) h['X-Api-Key'] = this.apiKey;
    return h;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, { ...init, headers: this.headers(init?.headers as any) });
    if (!res.ok) {
      const text = await res.text();
      throw new WahaError(`WAHA ${init?.method ?? 'GET'} ${path}: ${res.status} ${text}`, res.status);
    }
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  listSessions() { return this.request<WahaSession[]>('/api/sessions'); }
  getSession(name: string) { return this.request<WahaSession>(`/api/sessions/${encodeURIComponent(name)}`); }
  
  createSession(input: { name: string; config?: any }) {
    return this.request<WahaSession>('/api/sessions', { method: 'POST', body: JSON.stringify(input) });
  }
  
  startSession(name: string) {
    return this.request<WahaSession>(`/api/sessions/${encodeURIComponent(name)}/start`, { method: 'POST' });
  }
  
  stopSession(name: string) {
    return this.request<void>(`/api/sessions/${encodeURIComponent(name)}/stop`, { method: 'POST' });
  }
  
  logoutSession(name: string) {
    return this.request<void>(`/api/sessions/${encodeURIComponent(name)}/logout`, { method: 'POST' });
  }
  
  deleteSession(name: string) {
    return this.request<void>(`/api/sessions/${encodeURIComponent(name)}`, { method: 'DELETE' });
  }
  
  async getQrCode(name: string): Promise<string> {
    const url = `${this.baseUrl}/api/${encodeURIComponent(name)}/auth/qr?format=image`;
    const res = await fetch(url, { headers: this.headers({ Accept: 'image/png' }) });
    if (!res.ok) throw new WahaError(`QR failed: ${res.status}`, res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:image/png;base64,${buf.toString('base64')}`;
  }

  sendText(input: { session: string; chatId: string; text: string; reply_to?: string }) {
    return this.request<WahaSentMessage>('/api/sendText', { method: 'POST', body: JSON.stringify(input) });
  }
  
  sendImage(input: { session: string; chatId: string; file: any; caption?: string }) {
    return this.request<WahaSentMessage>('/api/sendImage', { method: 'POST', body: JSON.stringify(input) });
  }
  
  sendFile(input: { session: string; chatId: string; file: any; caption?: string }) {
    return this.request<WahaSentMessage>('/api/sendFile', { method: 'POST', body: JSON.stringify(input) });
  }
  
  sendVoice(input: { session: string; chatId: string; file: any }) {
    return this.request<WahaSentMessage>('/api/sendVoice', { method: 'POST', body: JSON.stringify(input) });
  }

  static toChatId(phoneE164: string): string {
    return `${phoneE164.replace(/\D/g, '')}@c.us`;
  }
  
  static fromChatId(chatId: string): string {
    return chatId.split('@')[0];
  }
}
```

### 3. Factory

Crie `src/lib/waha/index.ts`:

```typescript
import { WahaClient } from './client';

let cached: WahaClient | null = null;

export function getWahaClient(): WahaClient {
  if (cached) return cached;
  const baseUrl = process.env.WAHA_BASE_URL;
  if (!baseUrl) throw new Error('WAHA_BASE_URL não configurado');
  cached = new WahaClient({ baseUrl, apiKey: process.env.WAHA_API_KEY_PLAINTEXT || undefined });
  return cached;
}

export { WahaClient, WahaError } from './client';
```

### 4. Endpoint POST /api/wa/sessions (criar sessão)

`src/app/api/wa/sessions/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { getWahaClient } from '@/lib/waha';

const createSchema = z.object({
  organizationId: z.string().uuid(),
});

export async function POST(req: NextRequest) {
  const supaUser = getSupabaseServerClient();
  const { data: { user } } = await supaUser.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const body = await req.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 400 });

  const { organizationId } = parsed.data;

  // Confirma que user pertence à org
  const { data: membership } = await supaUser
    .from('user_organizations')
    .select('role')
    .eq('organization_id', organizationId)
    .eq('user_id', user.id)
    .single();
  if (!membership) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const supa = getSupabaseAdminClient();

  // Conta sessões existentes pra gerar nome único
  const { count } = await supa
    .from('channel_sessions')
    .select('*', { count: 'exact', head: true })
    .eq('organization_id', organizationId);
  const sessionName = `org-${organizationId.slice(0, 8)}-${(count ?? 0) + 1}`;

  const { data: created, error: insErr } = await supa
    .from('channel_sessions')
    .insert({ organization_id: organizationId, waha_session_name: sessionName, status: 'pending' })
    .select('id, webhook_secret, waha_session_name')
    .single();

  if (insErr || !created) {
    return NextResponse.json({ error: 'create_failed', message: insErr?.message }, { status: 500 });
  }

  const webhookUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/wa/webhook?session=${sessionName}`;

  const waha = getWahaClient();
  try {
    await waha.createSession({
      name: sessionName,
      config: {
        webhooks: [{
          url: webhookUrl,
          events: ['message', 'message.ack', 'session.status', 'message.reaction', 'message.revoked'],
          hmac: { key: created.webhook_secret },
        }],
        noweb: { store: { enabled: true, fullSync: false } },
      },
    });
    await waha.startSession(sessionName);
    
    await supa
      .from('channel_sessions')
      .update({ status: 'scan_qr', last_status_at: new Date().toISOString() })
      .eq('id', created.id);
  } catch (err) {
    await supa
      .from('channel_sessions')
      .update({ status: 'failed' })
      .eq('id', created.id);
    return NextResponse.json({ error: 'waha_failed', message: String(err) }, { status: 500 });
  }

  return NextResponse.json({ id: created.id, sessionName, status: 'scan_qr' });
}

export async function GET(req: NextRequest) {
  const supa = getSupabaseServerClient();
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const orgId = req.nextUrl.searchParams.get('organizationId');
  let q = supa.from('channel_sessions').select('*');
  if (orgId) q = q.eq('organization_id', orgId);
  const { data } = await q.order('created_at', { ascending: false });
  return NextResponse.json(data ?? []);
}

export const dynamic = 'force-dynamic';
```

### 5. Endpoint GET /api/wa/qr/[id]

`src/app/api/wa/qr/[id]/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { getWahaClient } from '@/lib/waha';

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const supa = getSupabaseServerClient();
  const { data: session } = await supa
    .from('channel_sessions')
    .select('id, waha_session_name, status')
    .eq('id', params.id)
    .single();

  if (!session) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (session.status !== 'scan_qr') {
    return NextResponse.json({ status: session.status });
  }

  const waha = getWahaClient();
  try {
    const qr = await waha.getQrCode(session.waha_session_name);
    return NextResponse.json({ qr, status: 'scan_qr' });
  } catch (err) {
    return NextResponse.json({ error: 'qr_failed', message: String(err) }, { status: 500 });
  }
}

export const dynamic = 'force-dynamic';
```

### 6. Endpoint POST /api/wa/sessions/[id]/restart

`src/app/api/wa/sessions/[id]/restart/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { getWahaClient } from '@/lib/waha';

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const supa = getSupabaseAdminClient();
  const { data: session } = await supa
    .from('channel_sessions')
    .select('id, waha_session_name')
    .eq('id', params.id)
    .single();
  if (!session) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const waha = getWahaClient();
  try {
    await waha.stopSession(session.waha_session_name).catch(() => {});
    await waha.startSession(session.waha_session_name);
    await supa.from('channel_sessions').update({ status: 'scan_qr', last_status_at: new Date().toISOString() }).eq('id', session.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: 'restart_failed', message: String(err) }, { status: 500 });
  }
}

export const dynamic = 'force-dynamic';
```

### 7. Hook `useChannelSession` e `useChannelSessions`

`src/hooks/useChannelSession.ts`:

```typescript
'use client';
import { useState, useEffect } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';

export interface ChannelSession {
  id: string;
  status: 'pending' | 'scan_qr' | 'working' | 'stopped' | 'failed';
  qr_code: string | null;
  phone_number: string | null;
  display_name: string | null;
  waha_session_name: string;
  organization_id: string;
}

export function useChannelSession(sessionId: string) {
  const [session, setSession] = useState<ChannelSession | null>(null);
  const [qr, setQr] = useState<string | null>(null);

  useEffect(() => {
    const supa = getSupabaseBrowserClient();
    
    supa
      .from('channel_sessions')
      .select('*')
      .eq('id', sessionId)
      .single()
      .then(({ data }) => setSession(data as ChannelSession));

    const channel = supa
      .channel(`session_${sessionId}`)
      .on(
        'postgres_changes' as any,
        { event: 'UPDATE', schema: 'public', table: 'channel_sessions', filter: `id=eq.${sessionId}` },
        (payload: any) => setSession(payload.new),
      )
      .subscribe();

    return () => { supa.removeChannel(channel); };
  }, [sessionId]);

  // Poll do QR enquanto scan_qr
  useEffect(() => {
    if (session?.status !== 'scan_qr') {
      setQr(null);
      return;
    }
    const fetchQr = async () => {
      const res = await fetch(`/api/wa/qr/${sessionId}`);
      const data = await res.json();
      if (data.qr) setQr(data.qr);
    };
    fetchQr();
    const interval = setInterval(fetchQr, 5000);
    return () => clearInterval(interval);
  }, [session?.status, sessionId]);

  return { session, qr };
}
```

`src/hooks/useChannelSessions.ts`:

```typescript
'use client';
import { useEffect, useState, useCallback } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';

export function useChannelSessions(organizationId: string) {
  const [sessions, setSessions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const supa = getSupabaseBrowserClient();
    const { data } = await supa
      .from('channel_sessions')
      .select('*')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false });
    setSessions(data ?? []);
    setLoading(false);
  }, [organizationId]);

  useEffect(() => { refresh(); }, [refresh]);

  return { sessions, loading, refresh };
}
```

### 8. Página /settings/whatsapp

`src/app/(crm)/settings/whatsapp/page.tsx`:

```typescript
'use client';
import { useState, useEffect } from 'react';
import { useChannelSessions } from '@/hooks/useChannelSessions';
import { SessionCard } from '@/components/whatsapp/SessionCard';
import { Button } from '@/components/ui/button';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';

export default function WhatsAppSettingsPage() {
  const [orgId, setOrgId] = useState<string>('');
  const { sessions, refresh } = useChannelSessions(orgId);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const supa = getSupabaseBrowserClient();
    supa.from('user_organizations').select('organization_id').limit(1).single().then(({ data }) => {
      if (data) setOrgId(data.organization_id);
    });
  }, []);

  const createSession = async () => {
    setCreating(true);
    try {
      await fetch('/api/wa/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId: orgId }),
      });
      await refresh();
    } finally {
      setCreating(false);
    }
  };

  if (!orgId) return <div className="p-8">Carregando...</div>;

  return (
    <div className="container max-w-4xl py-8 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Conexões do WhatsApp</h1>
        <Button onClick={createSession} disabled={creating}>
          {creating ? 'Criando...' : 'Conectar novo número'}
        </Button>
      </div>

      <div className="grid gap-4">
        {sessions.length === 0 && (
          <div className="border-2 border-dashed rounded-lg p-12 text-center text-muted-foreground">
            Nenhum número conectado. Clique em "Conectar novo número".
          </div>
        )}
        {sessions.map((s) => (
          <SessionCard key={s.id} sessionId={s.id} onChange={refresh} />
        ))}
      </div>
    </div>
  );
}
```

### 9. Componente SessionCard

`src/components/whatsapp/SessionCard.tsx`:

```typescript
'use client';
import { useChannelSession } from '@/hooks/useChannelSession';
import { Button } from '@/components/ui/button';

export function SessionCard({ sessionId, onChange }: { sessionId: string; onChange: () => void }) {
  const { session, qr } = useChannelSession(sessionId);

  if (!session) return null;

  const restart = async () => {
    await fetch(`/api/wa/sessions/${sessionId}/restart`, { method: 'POST' });
    onChange();
  };

  return (
    <div className="border rounded-lg p-6 space-y-4 bg-card">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-semibold">{session.display_name ?? session.waha_session_name}</div>
          <div className="text-sm text-muted-foreground">{session.phone_number ?? '(não conectado)'}</div>
        </div>
        <StatusBadge status={session.status} />
      </div>

      {session.status === 'scan_qr' && qr && (
        <div className="flex flex-col items-center gap-3 py-4 bg-muted rounded">
          <img src={qr} alt="QR Code" className="w-64 h-64" />
          <p className="text-sm text-muted-foreground text-center max-w-md">
            Abra o WhatsApp no celular do negócio → Menu → <b>Aparelhos conectados</b> → <b>Conectar um aparelho</b>
          </p>
        </div>
      )}

      {session.status === 'working' && (
        <div className="text-sm text-green-600 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-green-600"></span>
          Conectado e funcionando
        </div>
      )}

      {(session.status === 'failed' || session.status === 'stopped') && (
        <Button variant="destructive" onClick={restart} size="sm">
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

### 10. Atualizar `.env.local`

```
WAHA_BASE_URL="http://localhost:3000"
WAHA_API_KEY_PLAINTEXT=""
NEXT_PUBLIC_APP_URL="https://<seu-ngrok>.ngrok.app"
```

⚠️ **Pra webhook funcionar localmente**, rode `ngrok http 3001` e atualize `NEXT_PUBLIC_APP_URL` com a URL pública.

## Definition of Done

- [ ] WAHA rodando em localhost:3000 (`docker ps` mostra container)
- [ ] `curl http://localhost:3000/api/sessions` retorna `[]`
- [ ] App roda em localhost:3001
- [ ] ngrok expondo localhost:3001 numa URL pública
- [ ] Acessar `/settings/whatsapp` mostra a página
- [ ] Clicar "Conectar novo número" cria entrada em `channel_sessions` com status `scan_qr`
- [ ] QR aparece na UI
- [ ] Escanear QR com WhatsApp do celular muda status pra `working` (após o handler de webhook estar no ar — vem na fase 3)

⚠️ Se o status nunca muda de `scan_qr` para `working`, é porque o webhook ainda não está implementado. Isso é esperado nesta fase. **A fase 3 resolve.**

## Não faça

- ❌ Não implemente webhook handler — fase 3
- ❌ Não implemente envio de mensagens — fase 3
- ❌ Não construa UI de chat — fase 4
- ❌ Não use Pages Router

Ao terminar, responda: **"Fase 02 completa. Pode prosseguir para fase 03 (Message Flow)."**
