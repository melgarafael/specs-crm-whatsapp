# 02 — Arquitetura de Referência

> **Resumo:** o desenho completo de como as peças se encaixam. Mostra **onde mora cada coisa**, **quem fala com quem**, e **por que essa divisão**.

---

## 1. Visão de 10.000 pés

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              SEU PRODUTO (CRM Nichado)                               │
│                                                                                      │
│   ┌──────────────────────────┐         ┌─────────────────────────────────────────┐  │
│   │   FRONTEND (Next.js)     │         │            BACKEND (Next.js              │  │
│   │                          │         │            API Routes / Server          │  │
│   │   - /app/chat/page.tsx   │ ◄──────►│            Actions / Edge Functions)    │  │
│   │   - Lista de conversas   │   API   │                                          │  │
│   │   - Thread de mensagens  │         │   - /api/wa/send  → POST envio          │  │
│   │   - Composer + uploader  │         │   - /api/wa/webhook → recebe do WAHA    │  │
│   │   - Realtime subscriber  │         │   - /api/wa/qr → cria/inspeciona sessão │  │
│   └────────────┬─────────────┘         └────────────┬─────────────────────────────┘  │
│                │                                    │                                │
│                │ Realtime (Supabase Channels)       │                                │
│                ▼                                    ▼                                │
│   ┌─────────────────────────────────────────────────────────────────────────────┐   │
│   │                         POSTGRES (Supabase)                                  │   │
│   │                                                                              │   │
│   │   organizations  contacts  conversations  messages  channel_sessions  ...    │   │
│   │   crm_pipelines  crm_stages  crm_deals  ... (tabelas do seu CRM)             │   │
│   └─────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                      │
└──────────────────────────────────────────┬───────────────────────────────────────────┘
                                           │
                            HTTP (POST sendText, GET sessions)
                            HTTP (webhook callback)
                                           │
                                           ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                          WAHA (Self-hosted ou Cloud)                                 │
│                                                                                      │
│   - Engine NoWeb (recomendado) ou WebJS                                              │
│   - Sessões: clinic-1, advocacia-2, imobiliaria-3 (1 por número)                     │
│   - REST API: /api/sendText, /api/sessions, etc.                                     │
│   - Dispatcher de webhooks                                                           │
└──────────────────────────────────────────┬───────────────────────────────────────────┘
                                           │
                                           │ Engenharia reversa do
                                           │ protocolo do WhatsApp Web
                                           ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              SERVIDORES DO WHATSAPP                                  │
│                          (clientes finais conversam aqui)                            │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Componentes e responsabilidades

### Frontend (Next.js App Router)

**Responsabilidade:** renderizar UI de chat e o resto do CRM. **Nunca fala direto com WAHA.**

| Rota | O que faz |
|------|-----------|
| `/app/chat/page.tsx` | Layout principal: lista lateral + thread + composer |
| `/app/chat/[chatId]/page.tsx` | Thread de uma conversa específica |
| `/app/settings/whatsapp/page.tsx` | Conectar número (mostrar QR code, status) |

**Atualização em tempo real:** via Supabase Realtime escutando o canal `messages:org_{id}`.

### Backend (API Routes / Server Actions / Edge Functions)

**Responsabilidade:** intermediário entre Frontend e WAHA. É **único componente que tem o token do WAHA**.

| Endpoint | Direção | O que faz |
|----------|---------|-----------|
| `POST /api/wa/send` | Frontend → Backend | Recebe mensagem do operador, valida, persiste no DB com status "sending", chama WAHA |
| `POST /api/wa/webhook` | WAHA → Backend | Recebe eventos (mensagem nova, ack, status), valida HMAC, persiste no DB |
| `GET /api/wa/qr/:sessionId` | Frontend → Backend | Retorna QR code da sessão se status = `SCAN_QR_CODE` |
| `POST /api/wa/sessions` | Frontend → Backend | Cria nova sessão WAHA (admin/setup) |
| `GET /api/wa/sessions` | Frontend → Backend | Lista status de todas as sessões da org |

### Postgres (via Supabase)

**Responsabilidade:** fonte da verdade de tudo. Conversas, mensagens, contatos, deals, sessões.

Schema completo em [03-data-model.md](03-data-model.md).

### WAHA (Docker container)

**Responsabilidade:** falar com o WhatsApp e expor REST API. Você roda 1 instância para múltiplos clientes (cada cliente = 1 sessão).

---

## 3. Por que essa divisão e não outra

### Por que o frontend não fala direto com WAHA?

Três razões duras:
1. **Segurança.** O token do WAHA dá controle total sobre todos os números. Se vaza no client-side, qualquer um pode enviar mensagem em nome de qualquer cliente seu.
2. **Multi-tenant.** Você precisa decidir *qual sessão WAHA* usar baseado em qual *organização* o usuário pertence. Essa lógica vive no backend.
3. **Persistência.** Mensagem enviada precisa ser gravada no seu DB **antes** de ser enviada ao WAHA, com status "sending". Se você dispara direto do front, a mensagem some se a request cair antes de gravar.

### Por que Supabase Realtime e não WebSocket próprio?

- Você já vai usar Postgres. Supabase Realtime te dá pub/sub gratuito em cima do banco, com RLS aplicada.
- WebSocket próprio = você gerencia conexões, reconnect, sticky sessions, scaling. Trabalho desnecessário.
- Alternativa válida se você não usa Supabase: **Pusher**, **Ably**, ou **Pub/Sub com SSE**.

### Por que webhook e não polling?

- Polling em escala = caro e lento. Webhook chega em 50ms.
- WAHA Plus tem retry nativo do webhook (Core não — você precisa de fila própria, ver [05-receber-mensagens.md](05-receber-mensagens.md)).

---

## 4. Variantes de deployment

### Variante A — Solo builder, single-tenant (1 cliente = 1 deploy)

```
Vercel (Next.js full)  +  Supabase  +  WAHA Core no Railway/Fly.io ($5/mês)
```

Custo: ~$25/mês (Vercel free + Supabase free + Railway $5 + domínio).

### Variante B — Multi-tenant SaaS (1 deploy = N clientes)

```
Vercel (Next.js)  +  Supabase  +  WAHA Plus em VPS dedicada (Hetzner, $10/mês)
```

Custo: ~$50/mês com até 50 clientes ativos. Margem boa.

### Variante C — Cliente bring-your-own (BYO)

Cada cliente **roda o próprio WAHA** (instala no servidor dele) e configura o webhook apontando para sua API. Você só hospeda o CRM.

Vantagem: cliente paga a infra do WhatsApp. Você não corre risco de banimento por agregação.
Desvantagem: setup técnico do cliente, suporte mais difícil.

🎯 **Decisão típica para CRM nichado:** comece com **B**, ofereça **C** como upgrade premium.

---

## 5. Multi-tenant: como modelar a relação org ↔ sessão WAHA

| Cenário | Modelagem |
|---------|-----------|
| **1 org = 1 número** (90% dos casos) | `channel_sessions` tem `(organization_id, waha_session_name)` único |
| **1 org = N números** (escritórios maiores) | Várias linhas em `channel_sessions` para a mesma `organization_id` |
| **Org BYO WAHA** | Coluna `waha_base_url` e `waha_api_key` na própria org, e `channel_sessions` apenas registra metadata |

Schema detalhado em [03-data-model.md](03-data-model.md). Implementação de seleção de sessão em [06-enviar-mensagens.md](06-enviar-mensagens.md).

---

## 6. Fluxo end-to-end de uma mensagem (recebida)

```
1. Cliente final manda mensagem no WhatsApp
2. WhatsApp entrega ao WAHA (que está autenticado como aquele número)
3. WAHA dispara POST para https://seudominio.com/api/wa/webhook
   Body: { event: "message", session: "clinic-1", payload: { from, body, ... } }
   Header: X-Webhook-Hmac (assinado com webhook secret)
4. Seu backend:
   a. Valida HMAC
   b. Identifica a organization a partir do session name
   c. Faz UPSERT do contact (cria se não existe)
   d. Faz UPSERT da conversation (cria se não existe)
   e. INSERT da message
   f. (Opcional) dispara automações: roteamento, atribuição, IA agent
5. Postgres trigger / Supabase Realtime envia push pra todos os subscribers
   no canal messages:org_{id}
6. Frontend de quem está com a UI aberta recebe o evento
7. UI atualiza: aparece bolha nova na thread, badge de não-lido na lista lateral
```

Latência típica end-to-end: **300-800ms**.

---

## 7. Fluxo end-to-end de uma mensagem (enviada)

```
1. Operador digita "Olá, tudo bem?" e clica enviar
2. Frontend chama POST /api/wa/send com { conversationId, body, type: 'text' }
3. Backend:
   a. Verifica que o operador tem permissão na conversation (RLS / check)
   b. INSERT na tabela messages com status="sending", fromMe=true
   c. Retorna 200 ao frontend (otimistic UI)
   d. Em background (ou no mesmo request, depende), chama WAHA:
      POST {WAHA_URL}/api/sendText  com chatId, text, session
   e. WAHA retorna { id: "WAHA_MESSAGE_ID" }
   f. UPDATE messages SET external_id = WAHA_MESSAGE_ID, status="sent"
4. WAHA entrega a mensagem ao WhatsApp
5. WhatsApp confirma entrega → WAHA dispara webhook event="message.ack" 
6. Backend webhook handler atualiza messages.ack = 2 (server) ou 3 (device) ou 4 (read)
7. Realtime empurra atualização → UI muda os checks de cinza pra azul
```

---

## 8. Stack mínima para começar amanhã

| Camada | Escolha sugerida | Por quê |
|--------|------------------|---------|
| Frontend | Next.js 14+ App Router + TypeScript + Tailwind + shadcn/ui | Padrão de mercado, rápido de mover |
| Backend | Next.js API Routes / Server Actions (no mesmo repo) | Zero overhead de outro serviço |
| DB | Supabase (Postgres gerenciado) | Auth + Realtime + Storage no pacote |
| Realtime | Supabase Realtime | Gratuito até 200 conexões simultâneas |
| WhatsApp | WAHA Core (MVP) → Plus (produção) | Discutido no doc 01 |
| Hospedagem WAHA | Railway (MVP) → VPS Hetzner (produção) | Custo/performance |
| Hospedagem App | Vercel | Deploy git-push |
| Storage de mídia | Supabase Storage ou S3 | Para anexos enviados/recebidos |

---

## Próximo: [03-data-model.md](03-data-model.md)
