# Aula — CRM Nichado com WhatsApp (WAHA)

> **Objetivo:** ensinar uma IA (e o builder humano que a opera) a implementar, **do zero**, o módulo de **Chat Live + WhatsApp não-oficial via WAHA** dentro de qualquer CRM nichado — clínicas, imobiliárias, advogados, autoescolas, infoprodutos, agências, e-commerce, etc.
>
> **Stack de referência:** React + Next.js (App Router) + TypeScript + Postgres + Supabase (Realtime + Edge Functions) + WAHA Core/Plus.
>
> **Forma de uso:** cada doc é autossuficiente. Pode ser lido isolado ou alimentado em fatias para uma IA executora.

---

## Filosofia

1. **Builder primeiro, programador depois.** Esta aula assume que você usa uma IA para escrever o código. Os documentos são otimizados para servir como **contexto perfeito** para Cursor/Claude Code/Copilot.
2. **Universal sobre específico.** Schemas, contratos e patterns funcionam pra qualquer nicho. O que muda é o vocabulário (cliente vs paciente vs aluno), não a arquitetura.
3. **Cicatrizes valem mais que tutoriais.** Cada doc tem seção `⚠️ Gotchas` com armadilhas reais de produção que você só descobre quebrando a cara.
4. **Cobre Core E Plus.** Onde divergem, há nota explícita. Você decide qual usar baseado em budget e necessidade.

---

## Mapa da aula

A aula tem **duas grandes seções**:

### 🟢 Seção 1 — Módulo WhatsApp + Chat Live (este README, abaixo)
Implementação do canal WhatsApp não-oficial via WAHA, do zero ao deploy. **Comece aqui** se quer rapidamente um Chat Live funcionando.

### 🟣 Seção 2 — CRM Core (o núcleo do sistema) — [crm-core/README.md](crm-core/README.md)
Arquitetura do CRM em si como núcleo gravitacional do produto. Multi-tenant, pipelines (abas), kanban com drag-drop, schema universal + 10 nichos, **Data Relationship Doctrine**, REST API completa e MCP server pra IA operar o funil. **Vá pra cá** depois de ter o módulo WhatsApp rodando, ou se você quer construir o CRM antes do canal.

---

### Parte I — Fundação (entenda antes de codar)

| # | Doc | Pergunta que responde |
|---|-----|-----------------------|
| 01 | [01-fundamentos.md](01-fundamentos.md) | O que é Chat Live, por que WAHA, quando usar não-oficial vs oficial vs Evolution? |
| 02 | [02-arquitetura-referencia.md](02-arquitetura-referencia.md) | Como as peças se encaixam? Onde mora cada coisa? |
| 03 | [03-data-model.md](03-data-model.md) | Quais tabelas mínimas eu preciso? Como modelar conversas, mensagens, contatos? |

### Parte II — Backend (servidor falando com WAHA)

| # | Doc | Pergunta que responde |
|---|-----|-----------------------|
| 04 | [04-waha-setup.md](04-waha-setup.md) | Como subo o WAHA, autentico e crio uma sessão? |
| 05 | [05-receber-mensagens.md](05-receber-mensagens.md) | Como o WAHA me avisa de uma mensagem nova? |
| 06 | [06-enviar-mensagens.md](06-enviar-mensagens.md) | Como envio texto, mídia, áudio sem ser banido? |

### Parte III — Frontend (UI de chat real)

| # | Doc | Pergunta que responde |
|---|-----|-----------------------|
| 07 | [07-realtime-frontend.md](07-realtime-frontend.md) | Como a UI atualiza em tempo real? |
| 08 | [08-ui-chat-live.md](08-ui-chat-live.md) | Como construo a tela de chat (lista + thread + composer)? |

### Parte IV — Conexão com o CRM

| # | Doc | Pergunta que responde |
|---|-----|-----------------------|
| 09 | [09-binding-crm.md](09-binding-crm.md) | Como a conversa vira um contato e entra no funil? |

### Parte V — Produção (não cair quando o cliente usar)

| # | Doc | Pergunta que responde |
|---|-----|-----------------------|
| 10 | [10-edge-cases.md](10-edge-cases.md) | O que pode dar errado e como prevenir? |
| 11 | [11-seguranca-multitenant.md](11-seguranca-multitenant.md) | Como isolar dados entre clientes e proteger secrets? |

### Parte VI — Execução (mãos à obra)

| # | Doc | Pergunta que responde |
|---|-----|-----------------------|
| 12 | [12-checklist-implementacao.md](12-checklist-implementacao.md) | Em que ordem eu faço tudo isso? |

### Referências

- [reference/schema.sql](reference/schema.sql) — schema universal pronto pra rodar
- [reference/waha-api-cheatsheet.md](reference/waha-api-cheatsheet.md) — endpoints WAHA mais usados
- [reference/webhook-payloads.json](reference/webhook-payloads.json) — exemplos reais de payloads
- [reference/env.example](reference/env.example) — variáveis de ambiente comentadas

### Prompts plug-and-play

Cinco prompts self-contained para alimentar uma IA. Cada um implementa uma fase completa:

- [prompts/00-como-usar-os-prompts.md](prompts/00-como-usar-os-prompts.md)
- [prompts/prompt-01-scaffolding.md](prompts/prompt-01-scaffolding.md)
- [prompts/prompt-02-waha-integration.md](prompts/prompt-02-waha-integration.md)
- [prompts/prompt-03-message-flow.md](prompts/prompt-03-message-flow.md)
- [prompts/prompt-04-frontend-chat.md](prompts/prompt-04-frontend-chat.md)
- [prompts/prompt-05-crm-binding.md](prompts/prompt-05-crm-binding.md)

---

## Como ensinar essa aula

**Trilha de 4 horas (workshop):**
1. Hora 1 — Parte I (fundação) + leitura comentada da Parte II
2. Hora 2 — Live coding usando `prompt-01` e `prompt-02` em uma IA
3. Hora 3 — Live coding usando `prompt-03` e `prompt-04`
4. Hora 4 — `prompt-05` + edge cases + Q&A

**Trilha self-paced:** ler em ordem, executar prompts entre cada parte.

---

## Para quem NÃO é essa aula

- Quem quer **WhatsApp Business API oficial (Meta)** — outra arquitetura, outros custos, outros casos de uso. Veja `01-fundamentos.md` para o trade-off.
- Quem quer um **clone de Z-API/Evolution puro** — esses são serviços, não tutoriais de implementação.
- Quem quer um CRM **enlatado** — esta aula é pra quem **constrói**.

---

## Convenções dos documentos

- 📦 **Bloco de código** = pronto pra colar
- ⚠️ **Gotcha** = armadilha real de produção
- 🎯 **Decisão** = ponto onde você precisa escolher um caminho
- 🔌 **WAHA Plus** = funcionalidade exclusiva da versão paga
- 🆓 **WAHA Core** = funcionalidade da versão gratuita

---

**Versão:** 1.0
**Stack alvo:** Next.js 14+ (App Router), TypeScript 5+, Supabase, WAHA 2026.x
**Licença pedagógica:** use, adapte, ensine.
