# 12 — Checklist de Implementação

> **Resumo:** a ordem real (não a ordem da doc) em que você executa tudo. Cada item tem o doc/prompt de referência. Use como roteiro de live coding.

---

## Fase 0 — Preparação (1-2 horas)

- [ ] Criar projeto Next.js 14+: `npx create-next-app@latest meucrm --typescript --tailwind --app --src-dir`
- [ ] Instalar dependências base:
  ```bash
  npm i @supabase/supabase-js @supabase/ssr zod date-fns lucide-react uuid
  npm i -D @types/uuid
  ```
- [ ] Instalar shadcn/ui: `npx shadcn@latest init` e adicionar componentes (`button`, `input`, `textarea`, `avatar`, `tabs`, `dialog`)
- [ ] Criar projeto Supabase em [supabase.com](https://supabase.com)
- [ ] Configurar `.env.local` baseado em [reference/env.example](reference/env.example)
- [ ] Verificar que `npm run dev` sobe a app

---

## Fase 1 — Banco de dados (30 min)

📖 Refs: [03-data-model.md](03-data-model.md), [reference/schema.sql](reference/schema.sql)

- [ ] Conectar à instância Supabase (SQL Editor)
- [ ] Garantir que `organizations` e `user_organizations` existem (criar se não)
- [ ] Rodar [reference/schema.sql](reference/schema.sql) inteiro
- [ ] Verificar tabelas criadas no Table Editor: `channel_sessions`, `contacts`, `conversations`, `messages`, `webhook_events_log`
- [ ] Verificar RLS habilitada em cada tabela (Table Editor → tab "RLS")
- [ ] Inserir 1 organization de teste e vincular seu user em `user_organizations`
- [ ] Criar bucket `whatsapp-media` no Storage com policy de leitura por org

✅ **Definition of Done:** consigo fazer `SELECT * FROM channel_sessions` autenticado como minha conta — retorna vazio sem erro de RLS.

---

## Fase 2 — Subir o WAHA (30 min)

📖 Ref: [04-waha-setup.md](04-waha-setup.md)

- [ ] Decidir Core ou Plus
- [ ] Criar `docker-compose.dev.yml` (Core: usar imagem `:noweb`)
- [ ] `docker compose up -d`
- [ ] Acessar `http://localhost:3000/dashboard` — ver UI do WAHA
- [ ] Acessar `http://localhost:3000/` — ver Swagger
- [ ] Setar `WAHA_BASE_URL=http://localhost:3000` no `.env.local`
- [ ] (Plus) Gerar plaintext + SHA512, configurar `X-Api-Key`
- [ ] Instalar e rodar `ngrok http 3001` (ou cloudflared) — você precisa de URL pública para webhooks

✅ **Definition of Done:** `curl http://localhost:3000/api/sessions` retorna `[]`.

---

## Fase 3 — Cliente WAHA + setup de sessão (1 hora)

📖 Refs: [04-waha-setup.md §5-7](04-waha-setup.md), [prompts/prompt-02-waha-integration.md](prompts/prompt-02-waha-integration.md)

- [ ] Criar `lib/waha/client.ts` (classe WahaClient)
- [ ] Criar `lib/waha/index.ts` (factory `getWahaClient`)
- [ ] Criar endpoint `POST /api/wa/sessions` (cria sessão na tabela + chama WAHA)
- [ ] Criar endpoint `GET /api/wa/qr/[id]` (proxy do QR)
- [ ] Criar página `app/settings/whatsapp/page.tsx`
- [ ] Criar componentes `SessionCard` e `CreateSessionButton`
- [ ] Testar: criar sessão pela UI → escanear QR com celular → ver status virar `WORKING`

✅ **Definition of Done:** consegui conectar 1 número de teste pela UI do meu CRM.

---

## Fase 4 — Webhook handler (1.5 hora)

📖 Refs: [05-receber-mensagens.md](05-receber-mensagens.md), [prompts/prompt-03-message-flow.md](prompts/prompt-03-message-flow.md)

- [ ] Criar endpoint `POST /api/wa/webhook/route.ts`
- [ ] Criar `lib/waha/hmac.ts` (validação)
- [ ] Criar `lib/waha/webhook-processor.ts` (dispatcher)
- [ ] Criar handlers:
  - [ ] `lib/waha/handlers/message.ts` (mensagem recebida)
  - [ ] `lib/waha/handlers/message-ack.ts`
  - [ ] `lib/waha/handlers/session-status.ts`
  - [ ] `lib/waha/handlers/message-reaction.ts` (opcional)
  - [ ] `lib/waha/handlers/message-revoked.ts` (opcional)
- [ ] Criar `lib/waha/media.ts` (download e upload pro Storage)
- [ ] Atualizar config da sessão WAHA com URL do ngrok como webhook
- [ ] Mandar mensagem do celular pro número conectado → ver INSERT em `messages`

✅ **Definition of Done:** mandar mensagem do celular pro número aparece no banco em <2s, com mídia salva no Storage.

---

## Fase 5 — Realtime no frontend (1 hora)

📖 Refs: [07-realtime-frontend.md](07-realtime-frontend.md)

- [ ] Criar `lib/supabase/browser.ts` e `lib/supabase/server.ts`
- [ ] Criar hook `useRealtimeChannel`
- [ ] Criar hook `useConversationsRealtime`
- [ ] Criar hook `useMessagesRealtime`
- [ ] Criar hook `useChannelSession`
- [ ] Verificar publication: `messages`, `conversations`, `channel_sessions` no `supabase_realtime`

✅ **Definition of Done:** abrir 2 abas do CRM, mandar mensagem em uma → outra atualiza em <500ms.

---

## Fase 6 — UI Chat Live (2-3 horas)

📖 Refs: [08-ui-chat-live.md](08-ui-chat-live.md), [prompts/prompt-04-frontend-chat.md](prompts/prompt-04-frontend-chat.md)

- [ ] Criar layout `app/(crm)/chat/layout.tsx`
- [ ] Criar página `app/(crm)/chat/page.tsx` (lista + empty state)
- [ ] Criar página `app/(crm)/chat/[conversationId]/page.tsx` (lista + thread + sidepanel)
- [ ] Componentes:
  - [ ] `ConversationList`
  - [ ] `ConversationItem`
  - [ ] `ChatHeader`
  - [ ] `ChatThread`
  - [ ] `MessageBubble` (text, image, audio, video, document, location)
  - [ ] `Composer` (input + anexos + send)
  - [ ] `EmptyState`
- [ ] Hook `useSendMessage` com otimistic UI
- [ ] Hook `useMarkAsRead`
- [ ] Estilo de balão: cliente esquerda, operador direita com checks de status

✅ **Definition of Done:** conversa que recebi aparece na lista lateral; clico, abre thread; respondo, mensagem aparece na hora; webhook ack atualiza checks de cinza pra azul.

---

## Fase 7 — Envio de mensagens (1 hora)

📖 Refs: [06-enviar-mensagens.md](06-enviar-mensagens.md)

- [ ] Criar endpoint `POST /api/wa/send`
- [ ] Criar endpoint `POST /api/wa/upload` (mídia pro Storage)
- [ ] Criar `lib/waha/dispatcher.ts`
- [ ] Criar `lib/waha/rate-limiter.ts`
- [ ] Conectar Composer ao endpoint `/api/wa/send`
- [ ] Testar tipos: texto, imagem, áudio, documento

✅ **Definition of Done:** consigo mandar texto e mídia pelo CRM e o cliente final recebe no WhatsApp.

---

## Fase 8 — Binding com CRM (1.5 hora)

📖 Refs: [09-binding-crm.md](09-binding-crm.md), [prompts/prompt-05-crm-binding.md](prompts/prompt-05-crm-binding.md)

- [ ] Criar tabelas `crm_pipelines`, `crm_stages`, `crm_deals`, `crm_activities`
- [ ] Seed: 1 pipeline default com 4 estágios ("Lead novo", "Qualificado", "Negociação", "Ganhou")
- [ ] Criar `lib/waha/crm-binding.ts` (`bindMessageToCrm`)
- [ ] Adicionar chamada no `handleIncomingMessage`
- [ ] Criar componentes `CRMSidePanel`, `ContactSection`, `DealSection`, `NotesSection`
- [ ] Hook `useConversation`
- [ ] Botões "Eu cuido" (atribuir) e "Resolver"
- [ ] (Opcional) Auto-assignment com round-robin

✅ **Definition of Done:** mensagem nova de número novo cria contact + deal + activity vinculada. UI lateral mostra deal e permite mudar de estágio.

---

## Fase 9 — Robustez (1-2 horas)

📖 Refs: [10-edge-cases.md](10-edge-cases.md), [11-seguranca-multitenant.md](11-seguranca-multitenant.md)

- [ ] Cron `/api/cron/sync-sessions` (verifica saúde a cada 1 min)
- [ ] Cron `/api/cron/recover-stuck-messages` (timeout de envio)
- [ ] Cron `/api/cron/process-pending-webhooks` (Core only — fila de retry)
- [ ] Path token no webhook URL (segunda camada de auth)
- [ ] Rate limit no webhook (Upstash)
- [ ] Sanitize logs (filtro de headers sensíveis)
- [ ] Sentry: integrar e configurar `beforeSend`
- [ ] Storage com URL assinada (se compliance exige)
- [ ] MFA forçado para admin

---

## Fase 10 — Produção (1 hora)

- [ ] Deploy Vercel: `vercel deploy --prod`
- [ ] Configurar env vars na Vercel (idênticas ao `.env.local`)
- [ ] Migrar WAHA do localhost pra VPS (Hetzner, Railway, Fly)
- [ ] Configurar Nginx reverse proxy + Let's Encrypt
- [ ] Atualizar `WAHA_BASE_URL` no Vercel
- [ ] Atualizar webhook URL nas sessões existentes pra apontar pro domínio Vercel
- [ ] Backup automático Postgres (Supabase já faz; configure retention)
- [ ] Monitoramento: Sentry, Better Stack, Vercel Analytics

---

## Cronograma sugerido

| Sprint | Foco | Tempo |
|--------|------|-------|
| 1 (manhã) | Fases 0-3 (setup + WAHA + sessão) | 4h |
| 2 (tarde) | Fases 4-5 (webhook + realtime) | 3h |
| 3 (manhã) | Fase 6 (UI completa) | 3h |
| 4 (tarde) | Fases 7-8 (envio + binding) | 3h |
| 5 | Fases 9-10 (robustez + deploy) | 3h |

**Total: ~16h de trabalho focado.** Em 5 sessões de 3h cada, você tem MVP em produção em 1 semana.

---

## Antes de declarar "pronto"

Cheque [10-edge-cases.md §10](10-edge-cases.md) e [11-seguranca-multitenant.md §10](11-seguranca-multitenant.md). Estes checklists são pra produção real, não MVP.

---

## Próximo: [prompts/00-como-usar-os-prompts.md](prompts/00-como-usar-os-prompts.md)
