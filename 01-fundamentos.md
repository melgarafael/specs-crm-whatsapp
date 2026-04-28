# 01 — Fundamentos: Chat Live, WhatsApp e por que WAHA

> **Resumo:** entenda o que você está construindo e por que WAHA é o caminho mais inteligente para 80% dos CRMs nichados pequenos e médios.

---

## 1. O que é "Chat Live" no contexto de um CRM

Chat Live é a tela onde o **operador humano do CRM** (atendente, vendedor, recepcionista) **conversa em tempo real** com o cliente final do negócio, dentro da própria interface do sistema, **sem precisar abrir o WhatsApp Web**.

Funcionalmente, é uma fusão de três coisas:

1. **Inbox unificada** — todas as conversas do número de WhatsApp do negócio em um só lugar.
2. **CRM contextual** — ao abrir uma conversa, o operador vê o histórico do contato no CRM (deals, tags, notas, agendamentos).
3. **Automação ambiental** — bots, respostas rápidas, IA, follow-ups automáticos rodam ao lado das mensagens humanas.

A diferença entre "ter WhatsApp" e "ter Chat Live no CRM" é a mesma diferença entre **um e-mail no Gmail** e **um ticket no Zendesk**.

---

## 2. Os três caminhos para integrar WhatsApp

| Caminho | Como funciona | Custo | Risco de banimento | Velocidade de setup | Limite de números |
|---------|---------------|-------|--------------------|--------------------|-------------------|
| **WhatsApp Business API oficial (Meta Cloud API)** | Você cria um app na Meta, verifica o negócio, conecta um número como WABA. Mensagens passam pela infra da Meta. | Cobrança por janela de conversa (~$0.005-$0.08 dependendo do tipo). Setup gratuito. | Quase zero (oficial). | Lento (verificação Meta leva dias-semanas). | Cada número precisa ser registrado e verificado. |
| **WAHA / Evolution / Z-API (não-oficial)** | Você roda (ou paga) uma instância que faz **engenharia reversa do WhatsApp Web**. Conecta o número via QR code. | WAHA Core: grátis. WAHA Plus: ~$30/mês. Evolution: grátis (self-host). Z-API: ~R$ 100-200/mês. | Médio (depende do uso). Banimento por spam ou volume anormal é real. | Rápido (minutos). | Quantos quiser, com QR code. |
| **WhatsApp Business App + automação de UI** | Você abre o app oficial e usa scripts/Selenium para automatizar. | Grátis. | Altíssimo. | Frágil. | 1 por aparelho. |

🎯 **Decisão:** esta aula assume **caminho 2 (WAHA)**. Os outros dois ou são lentos demais pra MVP de CRM nichado, ou são frágeis demais pra produção.

---

## 3. Por que WAHA especificamente (e não Evolution ou Z-API)

| Critério | WAHA | Evolution | Z-API |
|----------|------|-----------|-------|
| Self-hostable | ✅ Sim | ✅ Sim | ❌ Não (SaaS) |
| Versão gratuita | ✅ Core | ✅ Total | ❌ |
| Versão paga estável | ✅ Plus (com features extras) | — | ✅ |
| Documentação | Excelente, OpenAPI completo | Razoável | Boa |
| Multi-sessão (vários números) | ✅ Plus | ✅ | ✅ |
| Webhooks robustos | ✅ Plus tem retry | ✅ | ✅ |
| Mídia (S3/storage externo) | ✅ Plus | Manual | ✅ |
| Estabilidade do "engine" | Alta (NoWeb engine = mais estável que Web puppeteer) | Média | Alta |
| Comunidade | Grande, com Slack ativo | Muito grande (Brasil) | Pequena |

**Decisão padrão para CRM nichado:**
- 🆓 **WAHA Core** — para começar, validar mercado, pequenos clientes (<5 números).
- 🔌 **WAHA Plus** — assim que o produto cresce. Vale o investimento.

Evolution é uma alternativa válida e popular no Brasil — mas tem a desvantagem de estar mais sujeita a quebras quando o WhatsApp Web atualiza, porque depende mais do Puppeteer. WAHA suporta múltiplos engines (incluindo o "NoWeb" que é mais estável).

---

## 4. WAHA Core vs WAHA Plus — diferenças que importam

| Feature | Core 🆓 | Plus 🔌 |
|---------|---------|---------|
| Sessões simultâneas | 1 | Ilimitadas |
| API Key (autenticação) | Opcional | Obrigatória (SHA512 hash) |
| Webhook retry automático | ❌ | ✅ |
| Storage de mídia em S3 | ❌ | ✅ |
| Engine NoWeb | Limitado | Completo |
| Suporte a grupos completo | Parcial | ✅ |
| Bots e canais | Limitado | ✅ |
| Atualização automática | Manual | Automática |
| Suporte oficial | Discord comunidade | Discord + e-mail |
| Preço | $0 | ~$30/mês (sujeito a mudança) |

**Para CRM nichado multi-tenant:** **Plus é praticamente obrigatório**, porque você terá múltiplos clientes, cada um com pelo menos um número, e Core não dá conta de mais de uma sessão simultânea.

**Para CRM single-tenant (1 negócio = 1 número):** **Core funciona perfeitamente**.

---

## 5. Modelo mental: por onde a mensagem viaja

```
Cliente final  ──(WhatsApp)──>  Servidores do WhatsApp  ──>  WAHA  ──(webhook)──>  Seu backend  ──>  DB
                                                                                          │
                                                                                          ▼
                                                                                    Realtime push
                                                                                          │
                                                                                          ▼
                                                                                  UI do CRM atualiza
```

E na volta:

```
Operador digita  ──>  UI do CRM  ──>  Backend  ──(POST /sendText)──>  WAHA  ──>  WhatsApp  ──>  Cliente
```

Toda mensagem é **assíncrona** e **eventual** — significa que a UI nunca deve bloquear esperando uma resposta do WhatsApp. Você grava no DB, mostra o estado "enviando", e atualiza para "enviado/entregue/lido" conforme os webhooks chegam.

---

## 6. Conceitos-chave que vão atravessar toda a aula

### Sessão
Uma conexão ativa entre o WAHA e um número de WhatsApp. Tem um nome (slug), um status (`STARTING`, `SCAN_QR_CODE`, `WORKING`, `STOPPED`, `FAILED`) e um QR code para autenticar.

### Chat (ou Conversa)
A linha de mensagens com **um contato ou grupo**. Identificado por um `chatId` no formato `5511999999999@c.us` (DM) ou `123456@g.us` (grupo).

### Mensagem
Uma unidade de conteúdo (texto, mídia, áudio, documento, sticker, localização, contato). Tem `id`, `from`, `to`, `body`, `type`, `timestamp`, `fromMe` (true se enviei eu), `ack` (status de entrega).

### Webhook
URL pública do **seu** backend que o WAHA chama quando algo acontece (mensagem nova, status de entrega muda, sessão cai, etc.).

### ACK (Acknowledgement)
Estado de entrega da mensagem:
- `0` = error
- `1` = pending (saiu do WAHA mas ainda não confirmado)
- `2` = server (chegou no servidor do WhatsApp)
- `3` = device (chegou no aparelho do destinatário)
- `4` = read (foi lida — só vem se o destinatário tem confirmação de leitura ativa)
- `5` = played (áudio/vídeo foi reproduzido)

### Janela de 24h
**No WhatsApp oficial (Meta):** após 24h sem o cliente responder, você só pode enviar **template aprovado**. **No WAHA não-oficial:** essa regra **não existe tecnicamente**, você pode enviar mensagem livre a qualquer momento — **mas o risco de banimento por mensagem fria não solicitada aumenta drasticamente**. Trate a janela como uma boa prática de produto, não como uma regra técnica.

---

## 7. Riscos e responsabilidades reais

WAHA usa engenharia reversa do WhatsApp Web. Isso significa:

1. **Não é homologado pela Meta.** Termo de uso do WhatsApp proíbe automações não-oficiais.
2. **Banimento é possível.** Mais comum por: enviar mensagem em massa fria, volume desproporcional, denúncias de usuários, números novos sem histórico humano.
3. **Quebras eventuais.** Quando o WhatsApp atualiza protocolo, WAHA precisa atualizar — pode ter downtime de algumas horas.
4. **Sem SLA.** Você é o responsável final perante seu cliente.

⚠️ **Comunique isso ao cliente final do CRM.** Coloque na sua landing page e nos termos de uso. "Conexão não-oficial via WhatsApp Web — sujeita às políticas do WhatsApp."

---

## 8. Quando NÃO usar WAHA

- 🚫 **Empresa regulada** (banco, seguradora, healthtech séria) — vão exigir API oficial.
- 🚫 **Volume massivo de cold outreach** — vai ser banido em horas. Use API oficial.
- 🚫 **Cliente que precisa de selo verde** — só com API oficial.
- 🚫 **Cliente que tem 50+ atendentes simultâneos no mesmo número** — limite técnico do WhatsApp Web.

Para o resto (a esmagadora maioria dos CRMs nichados de PMEs), WAHA é o caminho.

---

## Próximo: [02-arquitetura-referencia.md](02-arquitetura-referencia.md)
