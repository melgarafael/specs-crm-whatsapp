# 04 — WAHA Setup: subindo, autenticando e criando sessões

> **Resumo:** como rodar o WAHA (Core e Plus), configurar autenticação, expor ao mundo, criar uma sessão e conectar um número via QR code. Cobre desenvolvimento local e produção.

---

## 1. Imagens Docker disponíveis

| Imagem | O que é | Quando usar |
|--------|---------|-------------|
| `devlikeapro/waha:latest` | 🆓 Core, engine WebJS (Puppeteer + Chromium) | MVP, dev local, 1 número |
| `devlikeapro/waha:noweb` | 🆓 Core, engine NoWeb (mais leve, sem browser) | MVP onde memória é cara |
| `devlikeapro/waha-plus:latest` | 🔌 Plus, multi-engine | Produção multi-tenant |

⚠️ **Ler antes de pagar:** os tags exatos e preços do Plus mudam. Sempre cheque [waha.devlike.pro](https://waha.devlike.pro/docs/overview/install/) antes de comprar a licença.

---

## 2. Docker Compose para desenvolvimento (Core)

📦 **`docker-compose.dev.yml`** — copiar e colar:

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
      # Sem API key em dev (Core permite). Em prod, sempre setar.
      # WAHA_API_KEY: "sua-key-em-plaintext-aqui"

      # URL de webhook global (opcional — você também pode setar por sessão)
      # WHATSAPP_HOOK_URL: "http://host.docker.internal:3001/api/wa/webhook"
      # WHATSAPP_HOOK_EVENTS: "message,message.ack,session.status"

      # Logs verbosos pra dev
      WAHA_LOG_LEVEL: "debug"
    volumes:
      - waha_sessions:/app/.sessions
    networks:
      - waha_net

volumes:
  waha_sessions:

networks:
  waha_net:
```

Subir: `docker compose -f docker-compose.dev.yml up -d`

Verificar saúde: `curl http://localhost:3000/api/sessions` → deve retornar `[]`.

Dashboard nativo do WAHA (interface web pra inspecionar sessões): `http://localhost:3000/dashboard`.

OpenAPI/Swagger: `http://localhost:3000/`.

---

## 3. Docker Compose para produção (Plus)

📦 **`docker-compose.prod.yml`** — para VPS:

```yaml
version: '3.8'

services:
  waha:
    image: devlikeapro/waha-plus:latest
    container_name: waha-prod
    restart: always
    ports:
      - "127.0.0.1:3000:3000"   # Bind apenas em localhost; Nginx faz o proxy reverso
    environment:
      # 🔌 Plus exige API Key
      # ⚠️ ATENÇÃO: o WAHA Plus espera o HASH SHA512 (hex) do plaintext aqui, NÃO o plaintext.
      # Gere com: echo -n "sua-key" | sha512sum | awk '{print $1}'
      WAHA_API_KEY: "${WAHA_API_KEY_SHA512}"

      # Engine padrão (NOWEB é mais estável; WEBJS é mais features)
      WHATSAPP_DEFAULT_ENGINE: "NOWEB"

      # Storage de mídia em S3 (Plus)
      WAHA_MEDIA_STORAGE: "S3"
      WAHA_S3_REGION: "us-east-1"
      WAHA_S3_BUCKET: "${WAHA_S3_BUCKET}"
      WAHA_S3_ACCESS_KEY_ID: "${WAHA_S3_ACCESS_KEY}"
      WAHA_S3_SECRET_ACCESS_KEY: "${WAHA_S3_SECRET_KEY}"

      # Limites
      WAHA_WORKERS: "4"

      # Logs
      WAHA_LOG_LEVEL: "info"
      WAHA_LOG_FORMAT: "json"

      # Webhook retries (Plus)
      WHATSAPP_HOOK_RETRIES: "5"
      WHATSAPP_HOOK_TIMEOUT: "10000"
    volumes:
      - waha_sessions:/app/.sessions
      - waha_media:/app/.media
    networks:
      - waha_net

volumes:
  waha_sessions:
  waha_media:

networks:
  waha_net:
```

Variáveis sensíveis em `.env`:

```bash
WAHA_API_KEY_PLAINTEXT="o-plaintext-que-voce-NUNCA-loga-mas-usa-no-X-Api-Key-do-cliente"
WAHA_API_KEY_SHA512="hash-sha512-hex-do-plaintext-acima"
WAHA_S3_BUCKET="meu-crm-waha-media"
WAHA_S3_ACCESS_KEY="..."
WAHA_S3_SECRET_KEY="..."
```

⚠️ **Gotcha crítico (autenticação Plus):**

> O WAHA Plus exige que `WAHA_API_KEY` seja o **hash SHA512 hex** do plaintext, não o plaintext. Você guarda o plaintext em segredo e só ele aparece no header `X-Api-Key` das requisições. Isso evita que vazamento da env do servidor comprometa a chave.

Gerar o hash:

```bash
# Gerar 32 bytes random como plaintext
openssl rand -hex 32
# Resultado: a1b2c3...

# Calcular SHA512 hex
echo -n "a1b2c3..." | sha512sum | awk '{print $1}'
# Resultado: f9e8d7... (este vai em WAHA_API_KEY)
```

---

## 4. Nginx reverse proxy (produção)

```nginx
server {
    listen 443 ssl http2;
    server_name waha.seudominio.com;

    ssl_certificate     /etc/letsencrypt/live/waha.seudominio.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/waha.seudominio.com/privkey.pem;

    # Body grande pra mídia
    client_max_body_size 100M;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
```

---

## 5. Cliente WAHA em TypeScript (single fonte da verdade)

📦 **`lib/waha/client.ts`** — wrapper que todo seu backend usa:

```typescript
import crypto from 'crypto';

export interface WahaConfig {
  baseUrl: string;       // ex: https://waha.seudominio.com
  apiKey?: string;       // plaintext (NÃO o hash); só pra Plus, opcional em Core
}

export class WahaClient {
  private baseUrl: string;
  private apiKey?: string;

  constructor(config: WahaConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
  }

  private headers(extra: Record<string, string> = {}): HeadersInit {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      ...extra,
    };
    if (this.apiKey) h['X-Api-Key'] = this.apiKey;
    return h;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...init,
      headers: this.headers(init?.headers as Record<string, string>),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new WahaError(`WAHA ${init?.method || 'GET'} ${path} failed: ${res.status} ${text}`, res.status);
    }
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  // -------- Sessions --------

  listSessions() {
    return this.request<WahaSession[]>('/api/sessions');
  }

  getSession(name: string) {
    return this.request<WahaSession>(`/api/sessions/${encodeURIComponent(name)}`);
  }

  /** Cria sessão. Webhook URL e secret são por sessão (recomendado). */
  createSession(input: {
    name: string;
    config?: {
      webhooks?: Array<{ url: string; events: string[]; hmac?: { key: string } }>;
      noweb?: { store?: { enabled: boolean; fullSync: boolean } };
    };
  }) {
    return this.request<WahaSession>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  startSession(name: string) {
    return this.request<WahaSession>(`/api/sessions/${encodeURIComponent(name)}/start`, {
      method: 'POST',
    });
  }

  stopSession(name: string) {
    return this.request<void>(`/api/sessions/${encodeURIComponent(name)}/stop`, {
      method: 'POST',
    });
  }

  logoutSession(name: string) {
    return this.request<void>(`/api/sessions/${encodeURIComponent(name)}/logout`, {
      method: 'POST',
    });
  }

  deleteSession(name: string) {
    return this.request<void>(`/api/sessions/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
  }

  /** Pega o QR code (image/png como base64). Só funciona se status = SCAN_QR_CODE. */
  async getQrCode(name: string): Promise<string> {
    const url = `${this.baseUrl}/api/${encodeURIComponent(name)}/auth/qr?format=image`;
    const res = await fetch(url, { headers: this.headers({ Accept: 'image/png' }) });
    if (!res.ok) throw new WahaError(`QR failed: ${res.status}`, res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:image/png;base64,${buf.toString('base64')}`;
  }

  // -------- Send messages --------

  sendText(input: { session: string; chatId: string; text: string; reply_to?: string }) {
    return this.request<WahaSentMessage>('/api/sendText', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  sendImage(input: {
    session: string;
    chatId: string;
    file: { url?: string; data?: string; mimetype?: string; filename?: string };
    caption?: string;
  }) {
    return this.request<WahaSentMessage>('/api/sendImage', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  sendFile(input: {
    session: string;
    chatId: string;
    file: { url?: string; data?: string; mimetype?: string; filename: string };
    caption?: string;
  }) {
    return this.request<WahaSentMessage>('/api/sendFile', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  sendVoice(input: { session: string; chatId: string; file: { url?: string; data?: string } }) {
    return this.request<WahaSentMessage>('/api/sendVoice', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  // -------- Chats / Contacts --------

  getChats(session: string, limit = 50) {
    return this.request<WahaChat[]>(`/api/${encodeURIComponent(session)}/chats?limit=${limit}`);
  }

  getContact(session: string, chatId: string) {
    return this.request<WahaContact>(
      `/api/${encodeURIComponent(session)}/contacts/${encodeURIComponent(chatId)}`,
    );
  }

  // -------- Helpers --------

  /** Converte +5511999999999 → 5511999999999@c.us */
  static toChatId(phoneE164: string): string {
    const digits = phoneE164.replace(/\D/g, '');
    return `${digits}@c.us`;
  }

  static fromChatId(chatId: string): string {
    return chatId.split('@')[0];
  }
}

export class WahaError extends Error {
  constructor(msg: string, public statusCode?: number) { super(msg); }
}

// Tipos básicos do WAHA (simplificados — adicione conforme precisa)
export interface WahaSession {
  name: string;
  status: 'STARTING' | 'SCAN_QR_CODE' | 'WORKING' | 'STOPPED' | 'FAILED';
  me?: { id: string; pushName?: string };
  engine?: { engine: string };
}
export interface WahaSentMessage { id: string; ack?: number; }
export interface WahaChat { id: string; name?: string; isGroup: boolean; unreadCount?: number; }
export interface WahaContact { id: string; pushname?: string; profilePicUrl?: string; }
```

---

## 6. Singleton/factory para usar em qualquer lugar

📦 **`lib/waha/index.ts`**:

```typescript
import { WahaClient } from './client';

let cached: WahaClient | null = null;

export function getWahaClient(): WahaClient {
  if (cached) return cached;
  const baseUrl = process.env.WAHA_BASE_URL;
  const apiKey = process.env.WAHA_API_KEY_PLAINTEXT;
  if (!baseUrl) throw new Error('WAHA_BASE_URL não configurado');
  cached = new WahaClient({ baseUrl, apiKey });
  return cached;
}

/** Para multi-tenant BYO (cliente roda WAHA próprio): cria client por org. */
export function getWahaClientForOrg(args: { baseUrl: string; apiKey?: string }): WahaClient {
  return new WahaClient(args);
}
```

---

## 7. Fluxo de criação de uma sessão (admin do CRM clicou em "Conectar WhatsApp")

```
1. Admin clica "Conectar número" na UI
2. Frontend POST /api/wa/sessions { organizationId }
3. Backend:
   a. Gera waha_session_name único (ex: org-acme-1)
   b. Gera webhook_secret (32 bytes random hex)
   c. INSERT em channel_sessions com status='pending'
   d. Chama WAHA: POST /api/sessions com:
      {
        name: 'org-acme-1',
        config: {
          webhooks: [{
            url: 'https://seuapp.com/api/wa/webhook?session=org-acme-1',
            events: ['message', 'message.ack', 'session.status', 'message.reaction'],
            hmac: { key: <webhook_secret> }
          }],
          noweb: { store: { enabled: true, fullSync: false } }
        }
      }
   e. Chama WAHA: POST /api/sessions/org-acme-1/start
   f. UPDATE channel_sessions SET status = 'scan_qr', last_status_at = now()
4. Frontend recebe { sessionId, status: 'scan_qr' }
5. Frontend faz polling em GET /api/wa/qr/<sessionId> a cada 2s
   (alternativa: subscribe Realtime ao channel_sessions)
6. Backend faz proxy pra WAHA: GET /api/<session>/auth/qr?format=image
7. Frontend exibe QR
8. Usuário escaneia com o WhatsApp do celular do negócio
9. WAHA envia webhook event=session.status com status=WORKING
10. Backend UPDATE channel_sessions SET status='working', phone_number=<extraído do payload>
11. Realtime push pro frontend → UI mostra ✅ "Conectado: +5511999999999"
```

---

## 8. Eventos de webhook que você quer assinar

```typescript
const WEBHOOK_EVENTS = [
  'message',                  // mensagem recebida (cliente → você)
  'message.any',              // mensagem qualquer (incluindo enviadas por você de outro device)
  'message.ack',              // status de entrega muda
  'message.reaction',         // alguém reagiu com emoji
  'message.revoked',          // mensagem deletada (apagada pra todos)
  'session.status',           // STARTING, SCAN_QR_CODE, WORKING, STOPPED, FAILED
  'group.v2.join',            // entrou em grupo
  'group.v2.leave',           // saiu de grupo
  'presence.update',          // online/offline/typing (opcional, pesado)
  'call.received',            // alguém te ligou (você decide se ignora)
];
```

⚠️ **Não assine `presence.update` em produção a menos que você precise.** O volume é altíssimo e geralmente não tem uso real.

---

## 9. Verificação de saúde da sessão

📦 **Endpoint healthcheck `/api/wa/sessions/[id]/health`**:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getWahaClient } from '@/lib/waha';
import { getSupabaseServerClient } from '@/lib/supabase';

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const supa = getSupabaseServerClient();
  const { data: session } = await supa
    .from('channel_sessions')
    .select('*')
    .eq('id', params.id)
    .single();

  if (!session) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const waha = getWahaClient();
  try {
    const live = await waha.getSession(session.waha_session_name);
    
    // Sincroniza status DB ↔ WAHA
    if (live.status !== session.status.toUpperCase()) {
      await supa
        .from('channel_sessions')
        .update({
          status: live.status.toLowerCase(),
          phone_number: live.me?.id ? live.me.id.replace('@c.us', '') : session.phone_number,
          last_status_at: new Date().toISOString(),
        })
        .eq('id', session.id);
    }

    return NextResponse.json({ status: live.status, me: live.me });
  } catch (err) {
    return NextResponse.json({ status: 'unknown', error: String(err) }, { status: 500 });
  }
}
```

---

## 10. Edge cases comuns no setup

| Sintoma | Causa provável | Fix |
|---------|---------------|-----|
| QR aparece, escaneia, mas volta pra `SCAN_QR_CODE` em segundos | Versão do WhatsApp do celular muito antiga ou WAHA desatualizado | Atualize ambos. Em Plus, force rebuild da imagem. |
| Status fica em `STARTING` indefinido | Volume `/app/.sessions` corrompido | `docker volume rm waha_sessions` (perde sessões) e refaça setup |
| `session.status` chega como `FAILED` com `Browser session closed` | OOM no container (engine WebJS) | Use NoWeb ou aumente memória do container (mínimo 1GB). |
| Webhook nunca dispara | URL não acessível externamente OU porta bloqueada | Use ngrok em dev. Em prod, valide com `curl` da máquina onde roda o WAHA. |
| 401 em todas as requisições com X-Api-Key correto | WAHA Plus configurado com plaintext em vez de SHA512 | Recalcule hash, atualize env, restart. |
| WAHA cai depois de algumas horas | Memória vazando (engine antigo) | Configure `restart: always` + healthcheck |

---

## 11. Comandos úteis de troubleshooting

```bash
# Logs em tempo real
docker logs -f waha-prod

# Status de todas as sessões
curl -H "X-Api-Key: $WAHA_KEY" https://waha.seudominio.com/api/sessions

# Forçar restart de uma sessão sem deslogar
curl -X POST -H "X-Api-Key: $WAHA_KEY" https://waha.seudominio.com/api/sessions/org-acme-1/restart

# Limpar e recriar sessão (ATENÇÃO: desloga o número)
curl -X POST -H "X-Api-Key: $WAHA_KEY" https://waha.seudominio.com/api/sessions/org-acme-1/logout
curl -X DELETE -H "X-Api-Key: $WAHA_KEY" https://waha.seudominio.com/api/sessions/org-acme-1
```

---

## Próximo: [05-receber-mensagens.md](05-receber-mensagens.md)
