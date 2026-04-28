# CRM Core — O núcleo do sistema

> **Resumo:** esta seção ensina a tratar o CRM como o **núcleo gravitacional** do produto. Não é "uma tela com lista de contatos" — é a fonte da verdade de pessoas, deals e atividades, e tudo o mais (chat, whatsapp, email, calendar, billing) orbita em volta. Cobre arquitetura, schema universal, kanban com drag-drop, REST API completa, MCP server e a doutrina central de relações entre dados.

---

## Filosofia

O módulo de WhatsApp da aula anterior é **um satélite**. O CRM é o **núcleo**.

Quando você inverte essa perspectiva:
- Toda mensagem é potencialmente uma activity num lead
- Todo lead pode ser conectado a múltiplas conversas em múltiplos canais
- Todo módulo novo (email, calendar, billing) entra como satélite, não como app paralelo
- O modelo de dados se torna a coisa que decide se seu produto escala ou vira spaghetti

A doutrina central desta seção: **todo dado se pergunta com quem se relaciona** antes de existir.

---

## Mapa da seção

### Parte 1 — Arquitetura e UI (Agent A)

| # | Doc | Pergunta que responde |
|---|-----|-----------------------|
| 01 | [parte-1-arquitetura-ui/01-crm-como-core-do-sistema.md](parte-1-arquitetura-ui/01-crm-como-core-do-sistema.md) | Por que o CRM é o core e não satélite? |
| 02 | [parte-1-arquitetura-ui/02-multi-tenant-pipelines.md](parte-1-arquitetura-ui/02-multi-tenant-pipelines.md) | Como organizo multi-tenant + múltiplos pipelines (abas)? |
| 03 | [parte-1-arquitetura-ui/03-kanban-cards-drag-drop.md](parte-1-arquitetura-ui/03-kanban-cards-drag-drop.md) | Como construo o kanban com drag-drop e fractional indexing? |
| 04 | [parte-1-arquitetura-ui/04-schema-universal.md](parte-1-arquitetura-ui/04-schema-universal.md) | Quais são as 5 tabelas core e como se relacionam? |
| 05 | [parte-1-arquitetura-ui/05-custom-fields-por-nicho.md](parte-1-arquitetura-ui/05-custom-fields-por-nicho.md) | Como suporto 10 nichos sem hardcode? |
| 06 | [parte-1-arquitetura-ui/06-data-relationship-doctrine.md](parte-1-arquitetura-ui/06-data-relationship-doctrine.md) ⭐ | Como cada dado se conecta com todo o ecossistema? |
| 07 | [parte-1-arquitetura-ui/07-eventos-e-comunicacao.md](parte-1-arquitetura-ui/07-eventos-e-comunicacao.md) | Como o CRM se comunica com módulos satélites em runtime? |

### Parte 2 — REST API CRUD (Agent B)

| # | Doc | Pergunta que responde |
|---|-----|-----------------------|
| 08 | [parte-2-api-rest/08-rest-api-design.md](parte-2-api-rest/08-rest-api-design.md) | Quais princípios e decisões canônicas da API? |
| 09 | [parte-2-api-rest/09-endpoints-crud-leads.md](parte-2-api-rest/09-endpoints-crud-leads.md) | Implementação completa dos endpoints |
| 10 | [parte-2-api-rest/10-filtros-busca-paginacao.md](parte-2-api-rest/10-filtros-busca-paginacao.md) | Como pesquisar, filtrar e paginar com performance? |
| 11 | [parte-2-api-rest/11-auth-rate-limit-webhooks.md](parte-2-api-rest/11-auth-rate-limit-webhooks.md) | Como autenticar, rate-limit e disparar webhooks externos? |

### Parte 3 — MCP Server (Agent C)

| # | Doc | Pergunta que responde |
|---|-----|-----------------------|
| 12 | [parte-3-mcp-server/12-o-que-e-mcp.md](parte-3-mcp-server/12-o-que-e-mcp.md) | O que é MCP e por que CRM via MCP é poderoso? |
| 13 | [parte-3-mcp-server/13-mcp-server-implementacao.md](parte-3-mcp-server/13-mcp-server-implementacao.md) | Como implementar o servidor MCP completo? |
| 14 | [parte-3-mcp-server/14-mcp-tools-do-crm.md](parte-3-mcp-server/14-mcp-tools-do-crm.md) | As 19 tools que a IA usa pra operar o funil |
| 15 | [parte-3-mcp-server/15-mcp-deploy-e-conexao.md](parte-3-mcp-server/15-mcp-deploy-e-conexao.md) | Como conectar Claude Desktop, Cursor, Anthropic SDK e deploy remoto? |

### Referências

- [reference/crm-schema.sql](reference/crm-schema.sql) — schema universal executável
- [reference/10-niches-fields.md](reference/10-niches-fields.md) — campos custom de cada nicho
- [reference/relationship-matrix.md](reference/relationship-matrix.md) — matriz canônica de relações
- [reference/openapi.yaml](reference/openapi.yaml) — spec OpenAPI 3.1
- [reference/mcp-server.ts](reference/mcp-server.ts) — servidor MCP completo single-file
- [reference/mcp-config-claude-desktop.json](reference/mcp-config-claude-desktop.json) — config Claude Desktop pronto

### Prompts plug-and-play

- [prompts/prompt-06-crm-core-scaffolding.md](prompts/prompt-06-crm-core-scaffolding.md) — base do CRM (schema + kanban)
- [prompts/prompt-07-rest-api-implementation.md](prompts/prompt-07-rest-api-implementation.md) — REST API completa
- [prompts/prompt-08-mcp-server-implementation.md](prompts/prompt-08-mcp-server-implementation.md) — MCP server completo

---

## Como ler na ordem certa

**Leitura linear:** 01 → 02 → 03 → 04 → 05 → **06 (DOC CENTRAL)** → 07 → 08 → ... → 15

**Leitura por interesse:**
- Vou construir um CRM novo: 01, 04, 06, 03 — depois prompts 06 e 07
- Vou expor o CRM que já tenho via API: 04 (releitura), 08, 09, 10, 11 — depois prompt 07
- Vou fazer IA operar meu CRM: 12, 13, 14, 15 — depois prompt 08
- Vou nichar pra um caso específico: 05 + reference/10-niches-fields.md

**O documento mais importante** é o [06-data-relationship-doctrine.md](parte-1-arquitetura-ui/06-data-relationship-doctrine.md). Se você ler só um, leia esse.

---

## Trilha de aula sugerida

| Sessão | Conteúdo | Tempo |
|--------|----------|-------|
| Sessão 1 | Filosofia + multi-tenant + schema (docs 01, 02, 04) | 90 min |
| Sessão 2 | Kanban + drag-drop ao vivo (doc 03 + prompt 06) | 120 min |
| Sessão 3 | Doutrina + nichos (docs 05, 06) | 90 min |
| Sessão 4 | Eventos + REST API (docs 07, 08, 09 + prompt 07) | 120 min |
| Sessão 5 | MCP — o futuro de CRM operado por IA (docs 12-15 + prompt 08) | 120 min |

**Total:** ~9h de aula. Mais 10-15h pra alunos implementarem por conta usando os prompts.

---

## Volta pra raiz da aula

[← README principal da aula](../README.md) — onde está o módulo WhatsApp/WAHA (Chat Live, webhook, UI de chat).
