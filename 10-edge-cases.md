# 10 — Edge Cases e Gotchas de Produção

> **Resumo:** o que dá errado e como prevenir. Lições reais de quem operou WAHA em produção. Cada item tem sintoma → causa → fix.

---

## 1. Sessão e autenticação

### 1.1 Sessão cai sem aviso

**Sintoma:** mensagens param de chegar. Status fica em `WORKING` no DB mas WAHA mostra `STOPPED`.

**Causa:** O WhatsApp do celular foi aberto e desconectou os "Aparelhos vinculados". OU o WAHA crashou e reiniciou sem reconectar.

**Fix:**
- Health check periódico no WAHA via `/api/sessions` cron job (cada 1 min).
- Quando detectar divergência entre DB e WAHA, atualizar DB e notificar admin.
- Para `STOPPED`, tentar `POST /api/sessions/{name}/start`. Se falhar, exigir novo QR.

📦 Cron job:

```typescript
// app/api/cron/sync-sessions/route.ts
export async function GET() {
  const supa = getSupabaseAdminClient();
  const waha = getWahaClient();

  const { data: dbSessions } = await supa
    .from('channel_sessions')
    .select('id, organization_id, waha_session_name, status');

  const liveSessions = await waha.listSessions();
  const liveByName = new Map(liveSessions.map(s => [s.name, s]));

  for (const db of dbSessions ?? []) {
    const live = liveByName.get(db.waha_session_name);
    const liveStatus = live?.status?.toLowerCase() ?? 'stopped';
    if (liveStatus !== db.status) {
      await supa
        .from('channel_sessions')
        .update({ status: liveStatus, last_status_at: new Date().toISOString() })
        .eq('id', db.id);
      
      if (liveStatus === 'failed' || liveStatus === 'stopped') {
        // Notifica admin (email, Slack, push)
        await notifyAdmin(db.organization_id, `Sessão ${db.waha_session_name} caiu (${liveStatus})`);
      }
    }
  }
  return new Response('ok');
}
```

Schedule: `*/1 * * * *`.

### 1.2 QR code expira durante setup

**Sintoma:** usuário demora pra escanear, QR fica inválido, scan falha.

**Causa:** WhatsApp expira QR após ~60s.

**Fix:** auto-refresh do QR no frontend a cada 30s (`fetch('/api/wa/qr/{id}')` ou consume realtime). Botão "Gerar novo QR" que chama `POST /api/sessions/{name}/restart`.

### 1.3 Número banido

**Sintoma:** WAHA conecta, mostra `WORKING`, mas envios falham silenciosamente. Webhook de mensagem nunca chega.

**Causa:** WhatsApp baniu o número. Geralmente por spam.

**Fix:** **não tem.** Use outro número. Acelere comunicação:
- Deal status do cliente afetado: marque como "número_banido"
- Gere alerta visível no admin
- Documente o que disparou (timing de campanha, volume, conteúdo)

⚠️ **Prevenção em [06-enviar-mensagens.md §6](06-enviar-mensagens.md).**

### 1.4 Múltiplos dispositivos sem sync

**Sintoma:** operador envia do app oficial; CRM não vê. Operador envia do CRM; sumário do app oficial diferente.

**Causa:** WAHA usa "Aparelhos vinculados" (multi-device). Mensagens enviadas em dispositivos paralelos chegam via `message.any` se você assinou.

**Fix:** assine `message.any` em vez de `message`, e trate `fromMe=true` corretamente — não duplique no DB.

---

## 2. Mensagens

### 2.1 Mensagem chega fora de ordem

**Sintoma:** UI mostra mensagens em ordem errada.

**Causa:** Webhook reentregue 5 minutos depois de timeout. Mensagem aparece com timestamp antigo mas chega "depois".

**Fix:**
- Sempre ordene por `sent_at` (não `created_at`) na UI.
- Se webhook chega depois com data antiga, sua UI inserts no lugar correto se a query é ordered.

### 2.2 Mensagem duplicada

**Sintoma:** mesma mensagem aparece 2 vezes.

**Causa:** WAHA reenvia webhook (timeout do seu side OU bug de rede). Você processou 2x.

**Fix:** `unique (organization_id, external_id)` na tabela `messages`. Postgres rejeita o segundo INSERT — você captura `code === '23505'` e ignora silenciosamente.

```typescript
if ((mErr as any).code === '23505') return; // já processada
```

### 2.3 Mídia muito grande (vídeo de 50MB+)

**Sintoma:** download do WAHA timeout, OOM no Vercel function, mensagem fica sem mídia salva.

**Causa:** Vercel functions têm limite de memória e timeout. Vídeo grande estoura.

**Fix:**
- Use `WAHA_MEDIA_STORAGE=S3` no Plus (ele sobe direto pro S3, você só guarda URL).
- Se Core: streamar para Storage em chunks (não baixar tudo em memória):

```typescript
// Pseudo-código
const upstream = await fetch(mediaUrl);
const reader = upstream.body!.getReader();
// ... pipe pra Supabase Storage usando upload streaming
```

- Limite na sua UI: rejeite uploads > 16MB (limite do WhatsApp pra mídia regular).

### 2.4 Áudio em formato OGG não toca em alguns navegadores

**Sintoma:** Safari/iOS não reproduz áudio recebido.

**Causa:** WhatsApp manda OGG/Opus, Safari prefere MP4/AAC.

**Fix:**
- Re-encode para MP4 server-side (ffmpeg via Cloudflare Workers ou função separada).
- Ou aceite que Safari mostra "baixar" em vez de player inline.
- Solução pragmática: `<audio controls preload="none">` — dá ao navegador chance de baixar e tentar.

### 2.5 Texto muito longo (>4096 chars)

**Sintoma:** WAHA retorna erro 400 ou trunca.

**Causa:** Limite WhatsApp ~4096 caracteres por mensagem.

**Fix:** quebra texto em mensagens sequenciais no dispatcher:

```typescript
function chunkText(text: string, maxLen = 3500): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let split = remaining.lastIndexOf('\n\n', maxLen);
    if (split === -1) split = remaining.lastIndexOf(' ', maxLen);
    if (split === -1) split = maxLen;
    chunks.push(remaining.slice(0, split));
    remaining = remaining.slice(split).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
```

### 2.6 Emojis e caracteres especiais perdidos

**Sintoma:** "✅" vira "?" ou vazio.

**Causa:** encoding wrong em algum hop (DB sem UTF-8, fetch sem `Content-Type: application/json; charset=utf-8`).

**Fix:** Postgres `lc_collate` deve ser UTF-8. Conexão Supabase já é. Em fetch, sempre passe body como `JSON.stringify(...)` (que é UTF-8).

### 2.7 Mensagem de sistema (alguém entrou no grupo)

**Sintoma:** vem evento `message` com `type='system'` ou `type='e2e_notification'` que sua UI não sabe renderizar.

**Causa:** WhatsApp gera mensagens de sistema (entrou no grupo, alterou nome, etc.).

**Fix:**
- Salve com `type='system'` e renderize como item discreto centralizado: "João entrou no grupo".
- Ou ignore (não persista) se não te interessa.

---

## 3. Grupos

### 3.1 Grupo aparece como contato individual

**Sintoma:** mensagem de grupo é tratada como DM, contact criado errado.

**Causa:** chatId de grupo é `XXX@g.us`, não `XXX@c.us`. Lógica de `isGroup` falhou.

**Fix:** sempre cheque `chatId.endsWith('@g.us')`. Em grupos, o **sender** (`p.author`) é quem mandou; o `from` é o grupo.

### 3.2 Mensagem em grupo gera deal infinito

**Sintoma:** cada mensagem nova em grupo cria deal novo no funil.

**Causa:** binding CRM trata mensagem em grupo como inbound de pessoa nova.

**Fix:** **não faça binding CRM em grupos.** No handler:

```typescript
if (!conv.is_group) {
  await bindMessageToCrm({ ... });
}
```

Pra grupos, faça outro tipo de tratamento (ex: tag automática "grupo X", activity num deal já vinculado, etc.).

### 3.3 Operador acidentalmente responde no grupo errado

**Sintoma:** mensagem foi pra um grupo de 200 pessoas em vez do paciente.

**Causa:** UI não diferencia visualmente conversa em grupo.

**Fix:** indicador visual claro (ícone, cor, label "Grupo: Pacientes VIP"). Confirmação extra em grupos: modal "Tem certeza? Esta mensagem será vista por 200 pessoas".

---

## 4. Multi-tenant e BYO

### 4.1 Webhook bate na sessão errada

**Sintoma:** mensagem da org A acaba indo pro DB da org B.

**Causa:** dois clientes nomearam sessão igual ou seu lookup foi por nome sem conferir org.

**Fix:**
- Sempre lookup por `(provider, waha_session_name)` único globalmente, ou inclua `organization_id` no path do webhook.
- Padrão recomendado: `https://api.seuprod.com/wa/webhook?session={name}&t={token}` onde `t` é único por sessão.

### 4.2 Cliente BYO mudou URL/key sem avisar

**Sintoma:** webhooks param de chegar.

**Causa:** cliente moveu o WAHA pra outro servidor, esqueceu de atualizar a URL no painel.

**Fix:**
- Health check do BYO endpoint a cada 5 min.
- UI clara no dashboard do cliente: "última mensagem recebida há X minutos".
- Botão "testar conexão" que pinga o WAHA do cliente.

### 4.3 BYO key vazada em logs

**Sintoma:** auditoria mostra logs com `X-Api-Key` plaintext.

**Causa:** algum erro logger pegou o objeto do request inteiro.

**Fix:**
- Sanitize logs: filter `X-Api-Key`, `Authorization`, `webhook_secret` antes de logar.
- Encripte `waha_api_key_encrypted` no DB com chave separada (`WAHA_BYO_ENCRYPTION_KEY`).
- Use Sentry com `beforeSend` filtrando headers sensíveis.

---

## 5. Performance e escala

### 5.1 Lista de conversas demora 5s pra carregar

**Sintoma:** UI trava ao abrir `/chat`.

**Causa:** query JOIN sem index, ou conversations sem `last_message_at` indexado.

**Fix:** indexes em `conversations (organization_id, last_message_at desc)`. Query com `select` enxuto (não `*`).

### 5.2 Realtime para de empurrar updates

**Sintoma:** mensagem chega no DB, UI não atualiza.

**Causa:** Supabase Realtime conexão caiu silenciosamente. Reconectou para canal errado.

**Fix:**
- Detect e mostre estado: `channel.state === 'joined'` ou `'errored'` etc.
- Banner de "Reconectando..." com botão "Recarregar".
- Cleanup correto no `useEffect`: `return () => supa.removeChannel(channel)`.

### 5.3 Função de webhook do Vercel timeout em pico

**Sintoma:** retorno 504 em alguns webhooks; WAHA Plus reentrega; alguns viram 5xx persistente.

**Causa:** Vercel function timeout (default 10s em Hobby, 300s em Pro). Webhook handler pesado (download de mídia grande).

**Fix:**
- Move download de mídia para função background separada (Vercel Queue / Inngest).
- Webhook handler responde 200 imediato, enfileira processamento real.

```typescript
// Fast path: log e retorna 200
await supa.from('webhook_events_log').insert({ ... });
await inngest.send({ name: 'wa/process', data: { eventLogId, ... } });
return NextResponse.json({ ok: true });
```

### 5.4 Postgres lock em UPSERT alta cardinalidade

**Sintoma:** UPSERT em contacts/conversations falha com lock timeout sob carga.

**Causa:** muitos webhooks concorrentes do mesmo contato (ex: contato manda 10 mensagens em 2s).

**Fix:**
- Use `INSERT ... ON CONFLICT DO NOTHING` quando você só precisa garantir existência. Depois SELECT.
- Ou: serialize por contato usando lock de aplicação (Redis lock por phone).

---

## 6. Tempo de resposta e expectativas

### 6.1 Cliente espera resposta instantânea, IA demora 8s

**Sintoma:** cliente acha que mensagem não chegou e manda outra.

**Causa:** LLM lento + você fez chamada síncrona.

**Fix:**
- Mostre "digitando..." via send `chat-state` no WAHA: `POST /api/{session}/chats/{chatId}/typing` antes de mandar.
- Cap do timeout do agent: 5s. Se não respondeu, escala humano.

### 6.2 Notificação no celular do operador demora

**Sintoma:** mensagem chega no CRM mas operador só vê 30s depois.

**Causa:** WebSocket não tem fallback bom em browser background. Web Push é separado.

**Fix:**
- Implementar Web Push (Push API + service worker). Fora do escopo desta aula, mas referência: `web-push` lib.
- Ou som de notificação alto + browser notification + "Marcar como urgente" exibe banner persistente.

---

## 7. Compliance e legais

### 7.1 LGPD: cliente exige apagar histórico

**Sintoma:** cliente pediu remoção de dados pessoais.

**Causa:** LGPD/GDPR — direito ao esquecimento.

**Fix:**
- Botão admin "deletar contato" que faz CASCADE: contact → conversations → messages → activities.
- Storage: deletar arquivos `whatsapp-media/{org}/{messageIds}`.
- Log de auditoria do delete: quem, quando, qual contact.

### 7.2 Mensagens precisam ser exportáveis (auditoria)

**Sintoma:** cliente final em processo legal pede print de conversas.

**Fix:**
- Endpoint `/api/conversations/{id}/export?format=pdf|json` que gera relatório formatado.
- Inclua metadata: contact, datas, status, sender.

---

## 8. Anti-spam de receptor

### 8.1 Cliente recebe e marca como spam

**Sintoma:** seu número começa a perder ack 4 (lido) — cliente bloqueou.

**Causa:** mensagens não solicitadas.

**Fix:**
- Sempre primeiro contato deve ser "responsivo" (cliente ligou primeiro, formulário web, etc.).
- Em campanhas, só dispara pra quem **aceitou** receber explicitamente (opt-in).
- Track de blocks: campo `is_blocked` no contact, atualiza ao detectar (mensagem volta com erro específico).

### 8.2 Cliente respondeu STOP

**Sintoma:** cliente pediu pra parar de receber, sistema continua disparando.

**Fix:**
- Detector de keywords: `/STOP|PARAR|SAIR|UNSUBSCRIBE/i` no inbound → `is_blocked=true` no contact.
- Bloqueia automações e mensagens manuais (botão envio desabilitado).

---

## 9. Ferramentas de debugging

### 9.1 Webhook não chega

**Diagnóstico:**

```bash
# 1. WAHA está disparando?
docker logs waha-prod | grep webhook

# 2. URL é acessível?
curl -X POST https://api.seuprod.com/api/wa/webhook?session=test -d '{"event":"test"}'

# 3. Sua app loga o request?
# Veja Vercel logs ou Sentry
```

### 9.2 Mensagem nunca atualiza pra "lido"

**Diagnóstico:**

```bash
# 1. Webhook event=message.ack chegou?
SELECT * FROM webhook_events_log WHERE event_type='message.ack' ORDER BY received_at DESC LIMIT 10;

# 2. external_id confere?
SELECT id, external_id, ack, status FROM messages WHERE external_id = '...';

# 3. UPDATE rodou?
# Veja logs do handler.
```

### 9.3 Performance da lista lateral

```sql
EXPLAIN ANALYZE
SELECT id, last_message_at, contact_id 
FROM conversations 
WHERE organization_id = '<uuid>' 
ORDER BY last_message_at DESC NULLS LAST 
LIMIT 100;
```

Espere `Index Scan using idx_conversations_org_lastmsg`. Se você ver `Seq Scan`, falta index.

---

## 10. Checklist de robustez

Antes de declarar produção:

- [ ] Health check de sessão a cada 1 min
- [ ] Reentrega de webhook configurada (Plus) ou fila própria (Core)
- [ ] Idempotência testada (manda mesmo external_id 2x)
- [ ] Mídia grande (>10MB) testada
- [ ] Texto >4000 chars testado (chunked)
- [ ] Mensagem em grupo não cria deal duplicado
- [ ] BYO: health check do endpoint cliente
- [ ] LGPD: rota de deleção implementada
- [ ] Anti-spam: keyword STOP detectada
- [ ] Throttle 1 msg/seg confirmado em load test
- [ ] Realtime reconnect testado (mata wifi por 30s, valida volta)
- [ ] Timeout do dispatcher → status='failed' visível na UI
- [ ] Logs sanitizados (sem keys/secrets)

---

## Próximo: [11-seguranca-multitenant.md](11-seguranca-multitenant.md)
