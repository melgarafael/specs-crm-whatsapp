# WAHA API Cheatsheet

Endpoints mais usados, payloads de exemplo, e quirks por engine.

> Versão alvo: WAHA 2026.x. APIs estáveis há tempo, mas confira [waha.devlike.pro](https://waha.devlike.pro) para novidades.

---

## Base URL e auth

```
Base: http://localhost:3000  (dev) | https://waha.seudominio.com (prod)
Header: X-Api-Key: <plaintext> (Plus exige; Core opcional)
```

---

## Sessions

### Listar sessões

```http
GET /api/sessions
```

Resposta:
```json
[
  {
    "name": "org-acme-1",
    "status": "WORKING",
    "engine": { "engine": "NOWEB" },
    "me": { "id": "5511888888888@c.us", "pushname": "Acme Corp" }
  }
]
```

### Criar sessão

```http
POST /api/sessions
Content-Type: application/json

{
  "name": "org-acme-1",
  "config": {
    "webhooks": [
      {
        "url": "https://api.seuprod.com/api/wa/webhook?session=org-acme-1",
        "events": ["message", "message.ack", "session.status", "message.reaction", "message.revoked"],
        "hmac": { "key": "webhook-secret-32-bytes-hex" }
      }
    ],
    "noweb": {
      "store": { "enabled": true, "fullSync": false }
    }
  }
}
```

### Iniciar / parar / logout / deletar

```http
POST /api/sessions/{name}/start
POST /api/sessions/{name}/stop
POST /api/sessions/{name}/restart
POST /api/sessions/{name}/logout
DELETE /api/sessions/{name}
```

### Obter status

```http
GET /api/sessions/{name}
```

### QR code

```http
GET /api/{name}/auth/qr?format=image       (PNG binário)
GET /api/{name}/auth/qr?format=text        (string ASCII)
GET /api/{name}/auth/qr?format=base64      (data URL)
```

---

## Mensagens — Enviar

### Texto

```http
POST /api/sendText
Content-Type: application/json

{
  "session": "org-acme-1",
  "chatId": "5511999999999@c.us",
  "text": "Olá, tudo bem?",
  "reply_to": "false_5511999999999@c.us_3EB0..." 
}
```

Resposta:
```json
{ "id": "true_5511999999999@c.us_3EB0...", "ack": 1 }
```

### Imagem

```http
POST /api/sendImage
{
  "session": "org-acme-1",
  "chatId": "5511999999999@c.us",
  "file": {
    "url": "https://meucrm.com/storage/imagem.jpg",
    "mimetype": "image/jpeg",
    "filename": "imagem.jpg"
  },
  "caption": "Confira a foto"
}
```

Alternativa com base64:
```json
{
  "session": "org-acme-1",
  "chatId": "...",
  "file": {
    "data": "/9j/4AAQSkZJRg...",     // base64 sem prefix
    "mimetype": "image/jpeg",
    "filename": "imagem.jpg"
  }
}
```

### Vídeo / Documento (genérico)

```http
POST /api/sendFile
{
  "session": "org-acme-1",
  "chatId": "5511999999999@c.us",
  "file": {
    "url": "https://...",
    "mimetype": "application/pdf",
    "filename": "boleto.pdf"
  },
  "caption": "Seu boleto"
}
```

### Áudio (voice note)

```http
POST /api/sendVoice
{
  "session": "org-acme-1",
  "chatId": "5511999999999@c.us",
  "file": {
    "url": "https://meucrm.com/storage/audio.ogg"
  }
}
```

⚠️ **Áudio:** OGG/Opus dá melhor compatibilidade. WAHA pode converter automaticamente.

### Reação (emoji)

```http
POST /api/{session}/messages/{messageId}/reaction
{
  "reaction": "❤️"
}
```

Para remover: `reaction: ""`.

### Localização

```http
POST /api/sendLocation
{
  "session": "org-acme-1",
  "chatId": "5511999999999@c.us",
  "latitude": -23.5505,
  "longitude": -46.6333,
  "title": "Av. Paulista",
  "address": "São Paulo, SP"
}
```

### Indicador "tá digitando"

```http
POST /api/{session}/chats/{chatId}/typing
{
  "duration": 5000     (ms)
}
```

---

## Mensagens — Outras operações

### Marcar como lida

```http
POST /api/sendSeen
{ "session": "org-acme-1", "chatId": "5511999999999@c.us" }
```

### Deletar (revoke) mensagem

```http
DELETE /api/{session}/chats/{chatId}/messages/{messageId}
```

### Forwardar

```http
POST /api/forwardMessage
{
  "session": "org-acme-1",
  "chatId": "5511999999999@c.us",
  "messageId": "false_..._3EB0..."
}
```

---

## Chats e Contatos

### Listar chats

```http
GET /api/{session}/chats?limit=50&offset=0
```

### Histórico de mensagens de um chat

```http
GET /api/{session}/chats/{chatId}/messages?limit=100&downloadMedia=false
```

### Info de um contato

```http
GET /api/{session}/contacts/{chatId}
```

### Foto de perfil

```http
GET /api/{session}/contacts/{chatId}/profile-picture
```

### Verificar se número tem WhatsApp

```http
POST /api/contacts/check-exists
{
  "session": "org-acme-1",
  "phone": "5511999999999"
}
```

Resposta: `{ "exists": true, "chatId": "5511999999999@c.us" }`

---

## Grupos

### Criar grupo

```http
POST /api/{session}/groups
{
  "name": "Pacientes VIP",
  "participants": ["5511999999999@c.us", "5511888888888@c.us"]
}
```

### Adicionar / remover participante

```http
POST /api/{session}/groups/{chatId}/participants/add
POST /api/{session}/groups/{chatId}/participants/remove
{
  "participants": ["5511999999999@c.us"]
}
```

---

## Engines: NOWEB vs WEBJS

| Aspecto | NOWEB | WEBJS |
|---------|-------|-------|
| Memória | Baixa (~150MB) | Alta (~600MB Chromium) |
| Estabilidade | Alta | Média (depende WhatsApp Web) |
| Mídia mais antiga | Limitada | Funciona |
| Reactions | ✅ | ✅ |
| Stickers animados | ⚠️ Parcial | ✅ |
| Listas e botões | ⚠️ | ✅ |
| Default recomendado | ✅ | Use só se precisa de feature específica |

Configurar:
```yaml
WHATSAPP_DEFAULT_ENGINE: "NOWEB"   # ou WEBJS
```

Ou por sessão:
```json
{
  "name": "...",
  "config": {
    "engine": "NOWEB"
  }
}
```

---

## Quirks comuns

### chatId formats

| Tipo | Formato | Exemplo |
|------|---------|---------|
| DM (pessoa) | `<phone-no-+>@c.us` | `5511999999999@c.us` |
| Grupo | `<id-numerico>@g.us` | `120363045123456789@g.us` |
| Broadcast list | `<id>@broadcast` | (raro) |

⚠️ **Não use `+` no chatId.** Sempre dígitos puros + `@c.us` ou `@g.us`.

### message ID format

```
<true|false>_<chatId>_<messageId>
ex: true_5511999999999@c.us_3EB0ABC...
```

`true` = enviada pelo dono da sessão. `false` = recebida.

### ACK values

| Value | Meaning |
|-------|---------|
| -1 | Erro |
| 0 | Pendente (cliente) |
| 1 | Pendente (saiu do app) |
| 2 | Server (chegou no WhatsApp) |
| 3 | Device (chegou no celular) |
| 4 | Read (lida) |
| 5 | Played (áudio/vídeo reproduzido) |

### Typing/online status

`presence.update` event tem payload:
```json
{
  "id": "5511999999999@c.us",
  "presence": "available" | "unavailable" | "composing" | "recording" | "paused"
}
```

---

## Headers úteis

### Webhook outbound (do WAHA pro seu backend)

```
X-Webhook-Hmac: <hex sha512>             (Plus, se config.webhooks[].hmac.key setado)
X-Webhook-Timestamp: <unix ms>           (Plus)
User-Agent: WAHA/<version>
Content-Type: application/json
```

### Inbound (você → WAHA)

```
X-Api-Key: <plaintext>                   (Plus obrigatório, Core opcional)
Content-Type: application/json
Accept: application/json
```

---

## Errors comuns

| Status | Significado | Fix |
|--------|-------------|-----|
| 400 | Body inválido | Verifique schema do payload |
| 401 | API Key errada/ausente | Confira hash SHA512 vs plaintext |
| 404 | Sessão não existe | Confira `name` |
| 409 | Conflito (sessão já existe / não pode criar agora) | Cheque status, faça stop+delete antes |
| 422 | Sessão não está WORKING | Aguarde QR scan |
| 500 | Erro interno do WAHA | Logs do container; reinicie |

---

## Webhooks: lista de eventos

| Event | Quando |
|-------|--------|
| `message` | Mensagem chegou pra você |
| `message.any` | Qualquer mensagem (incluindo enviadas por você de outro device) |
| `message.ack` | Status de entrega mudou |
| `message.reaction` | Reação adicionada/removida |
| `message.revoked` | Mensagem deletada (delete for everyone) |
| `message.edited` | Mensagem editada |
| `session.status` | Status da sessão mudou |
| `session.upsert` | Sessão criada/atualizada |
| `state.change` | Mudança fina de estado interno |
| `group.v2.join` | Você ou alguém entrou em grupo |
| `group.v2.leave` | Saiu de grupo |
| `group.v2.update` | Metadata de grupo mudou |
| `presence.update` | Online/offline/typing (volume alto) |
| `poll.vote` | Voto em enquete |
| `chat.archive` | Conversa arquivada |
| `call.received` | Ligação chegando |

---

## Comandos curl úteis (debug)

```bash
# Listar sessões
curl -H "X-Api-Key: $WAHA_KEY" https://waha.seudominio.com/api/sessions | jq

# Criar e iniciar sessão
curl -X POST -H "Content-Type: application/json" -H "X-Api-Key: $WAHA_KEY" \
  -d '{"name":"test-1","config":{"webhooks":[{"url":"https://api.example.com/wh","events":["message"]}]}}' \
  https://waha.seudominio.com/api/sessions

curl -X POST -H "X-Api-Key: $WAHA_KEY" https://waha.seudominio.com/api/sessions/test-1/start

# Pegar QR
curl -H "X-Api-Key: $WAHA_KEY" "https://waha.seudominio.com/api/test-1/auth/qr?format=image" -o qr.png

# Enviar texto
curl -X POST -H "Content-Type: application/json" -H "X-Api-Key: $WAHA_KEY" \
  -d '{"session":"test-1","chatId":"5511999999999@c.us","text":"Hello"}' \
  https://waha.seudominio.com/api/sendText
```
