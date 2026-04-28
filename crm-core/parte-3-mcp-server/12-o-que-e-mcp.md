# 12 — O que é MCP e por que expor seu CRM por ele

> **Resumo:** MCP (Model Context Protocol) é o "USB-C da IA": um padrão único pra conectar qualquer LLM a qualquer fonte de dados ou ferramenta. Expor seu CRM por MCP significa que **Claude, Cursor, Cline, Continue e qualquer agente custom passam a operar leads, pipelines e atividades em linguagem natural**, sem você escrever uma integração específica pra cada cliente. Esta parte da aula é sobre transformar seu CRM em uma **plataforma operável por IA**.

---

## 1. O problema que MCP resolve

Antes do MCP, conectar uma LLM a um sistema externo seguia um destes três caminhos — todos ruins:

| Caminho | O que era | Por que era ruim |
|---------|-----------|------------------|
| **Function calling artesanal** | Você descreve cada função em JSON Schema dentro do prompt e implementa o roteador no seu código | Reescrita pra cada cliente (OpenAI, Anthropic, Gemini), sem padrão de descoberta, sem cache, sem segurança |
| **Plugins ChatGPT (OpenAPI)** | Endpoint REST + manifesto `.well-known/ai-plugin.json` | Só funcionava no ChatGPT. Morreu quando OpenAI mudou de estratégia |
| **LangChain/LlamaIndex Tools** | Wrapper Python/TS sobre cada API | Acoplado ao framework. Trocar de SDK = reescrever tudo |

Cada cliente IA falava um dialeto. Cada SaaS expunha o mesmo CRUD de jeitos diferentes. Resultado: a maior parte dos sistemas continuava **invisível pras LLMs**, mesmo tendo APIs perfeitamente documentadas.

🎯 **Decisão da Anthropic em novembro de 2024:** padronizar o protocolo. MCP nasce como spec aberta, com SDKs em TypeScript, Python, Java, Kotlin, C#, Swift — e é adotada em meses pelo Cursor, Cline, Continue, Zed, e dezenas de clientes de terceiros.

---

## 2. A analogia que vai te ajudar pelo resto da aula

> **MCP é o USB-C da IA.**

USB-C resolveu três problemas ao mesmo tempo:

1. **Um conector pra todos os dispositivos.** Mouse, teclado, monitor, carregador, fone — todos no mesmo plug.
2. **Bidirecionalidade.** Carrega energia E transmite dados.
3. **Descoberta automática.** O sistema operacional reconhece o dispositivo sem você instalar driver.

MCP faz exatamente isso pra IA:

1. **Um protocolo pra tudo.** Banco de dados, API REST, sistema de arquivos, CRM, ERP, Jira, Notion, Slack, GitHub — tudo fala o mesmo MCP.
2. **Bidirecionalidade.** A IA chama tools (ações) E lê resources (contexto).
3. **Descoberta automática.** O cliente IA pergunta ao servidor "o que você sabe fazer?" e o servidor responde com schemas. **Você não escreve prompt list-de-tools**.

Quem implementa o lado "dispositivo" se chama **MCP server**. Quem implementa o lado "host" (Claude Desktop, Cursor, etc.) se chama **MCP client**.

---

## 3. Os 4 conceitos centrais do MCP

Toda a especificação gira em torno de quatro primitivas. Decore essas palavras — você vai usá-las o tempo todo.

### 3.1. Tools — ações

Funções que **a IA pode invocar pra mudar o mundo** (ou ler dados ativamente).

Cada tool tem:
- **Nome** (`create_lead`, `move_lead_to_stage`, `mark_lead_won`)
- **Descrição** (texto natural lido pelo LLM pra decidir quando chamar)
- **Input schema** (JSON Schema, geralmente derivado de Zod)
- **Output** (texto, JSON estruturado ou `resource link`)

Exemplo conceitual:

```
Tool: create_lead
Description: "Cria um novo lead no CRM com título, valor estimado e contato associado."
Input schema:
  - title: string (obrigatório)
  - pipeline_id: uuid (obrigatório)
  - stage_id: uuid (opcional — usa primeiro stage do pipeline se omitido)
  - value_cents: integer (opcional)
  - contact_phone: string (opcional, formato E.164)
```

Quando o usuário diz "cria um lead pro João do dentista, R$ 2.500", o LLM:
1. Lê a descrição da tool
2. Extrai título, valor e contato do prompt
3. Pede pro cliente MCP invocar `create_lead` com esses argumentos
4. O cliente envia ao servidor MCP
5. Servidor executa, devolve `{ id, title, ... }`
6. LLM responde ao usuário com confirmação humana

### 3.2. Resources — contexto

Dados que **a IA pode ler passivamente**, identificados por URI.

Diferente de tool, resource não muda nada. É **leitura pura de contexto** — o cliente MCP frequentemente injeta resources direto no prompt sem nem perguntar ao LLM, porque sabe que ele vai precisar.

Exemplos no nosso CRM:
- `crm://schema` → o schema completo do CRM (tabelas, campos, vocabulário)
- `crm://pipelines` → lista de pipelines da organização
- `crm://leads/{leadId}` → ficha completa de um lead específico
- `crm://activities/recent` → últimas 100 atividades

URIs podem ser **estáticos** (`config://app`) ou **dinâmicos via template** (`user://{userId}/profile`).

### 3.3. Prompts — templates reutilizáveis

Mensagens pré-formatadas que o **usuário** pode invocar (não o LLM). Aparecem no Claude Desktop como botões de "ação rápida".

Exemplo:
- Prompt `analyze_stuck_leads` → "Liste todos os leads parados há mais de 7 dias no pipeline atual e sugira ação pra cada um, considerando o histórico de atividade."

Quando o usuário clica nesse prompt no Claude Desktop, a mensagem inteira é injetada no chat. O LLM então usa as tools e resources que precisar pra responder.

### 3.4. Transports — como cliente e servidor falam

Três meios físicos de comunicação:

| Transport | Como funciona | Quando usar |
|-----------|---------------|-------------|
| **stdio** | Cliente spawneia servidor como processo filho. Comunica via stdin/stdout (JSON-RPC linha-por-linha) | Local. Claude Desktop, Cursor, Cline rodando na máquina do usuário |
| **Streamable HTTP** | Servidor é um endpoint HTTP. Cliente faz POST `/mcp` pra requests, GET `/mcp` pra notificações via SSE, DELETE `/mcp` pra encerrar sessão | Remoto. Servidor publicado num domínio, multi-cliente, multi-tenant |
| **HTTP + SSE (deprecated)** | Versão antiga do anterior, com endpoints separados pra upload e stream | Só pra retrocompatibilidade. Não use em projeto novo |

🎯 **Decisão arquitetural pra CRM nichado:**

- **Modo dev/desktop pessoal:** stdio. Você roda o server localmente, configura Claude Desktop apontando pro binário, pronto.
- **Modo SaaS multi-tenant:** Streamable HTTP. Hospeda o server num VPS/Railway/Fly, cada cliente final recebe um Bearer token, conecta o Claude Desktop via "remote MCP server".

Esta aula cobre **os dois**.

---

## 4. MCP vs as alternativas (tabela de comparação)

| Critério | Function Calling artesanal | OpenAPI/Plugins ChatGPT | LangChain Tools | **MCP** |
|----------|----------------------------|------------------------|----------------|---------|
| Padrão aberto | ❌ | Parcial (OpenAPI é, plugin não) | ❌ | ✅ |
| Descoberta automática de tools | ❌ | ✅ | ❌ | ✅ |
| Funciona em múltiplos clientes IA | ❌ | ❌ (só ChatGPT) | ❌ (só LangChain) | ✅ Claude, Cursor, Cline, Continue, Zed, SDK direto |
| Resources (contexto passivo) | ❌ | ❌ | Parcial | ✅ |
| Prompts pré-definidos do servidor | ❌ | ❌ | ❌ | ✅ |
| Sessões com state | Manual | Manual | Manual | ✅ Built-in (Streamable HTTP) |
| Retomada de stream após queda | Manual | ❌ | ❌ | ✅ Event store opcional |
| Auth padronizado | Você inventa | Cada plugin diferente | Cada tool diferente | Bearer/OAuth com `authProvider` |
| SDK oficial | Vários | Apenas OAS | Vários | TypeScript, Python, Java, Kotlin, C#, Swift, Rust |

A leitura honesta: MCP **não cobre tudo** ainda (auth ainda está amadurecendo, observabilidade não está padronizada), mas é o **único protocolo que tem chance de virar padrão de fato**. Se você for construir hoje uma integração pra durar, MCP é o caminho.

---

## 5. Quem suporta MCP hoje (relevante pra CRM)

| Cliente | Suporte stdio | Suporte HTTP | Notas |
|---------|---------------|--------------|-------|
| **Claude Desktop** (Anthropic) | ✅ | ✅ Remote MCP | Distribuição mais natural pro usuário final do CRM |
| **Cursor** | ✅ | ✅ | IDE — útil pro cliente avançado que automatiza CRM enquanto programa |
| **Cline** (VS Code extension) | ✅ | ✅ | Idem |
| **Continue** | ✅ | ✅ | IDE assistant open-source |
| **Zed** | ✅ | ✅ | Editor com chat IA embutido |
| **Anthropic SDK direto** | ✅ via MCP client TS/Py | ✅ | Você embute o cliente MCP no seu próprio agente custom |
| **OpenAI compat (Roo Cline, librechat, etc.)** | ✅ | ✅ | Vários clientes da comunidade já implementam MCP via wrapper |

⚠️ **Gotcha:** o ChatGPT (oficial) ainda não suporta MCP nativamente em 2026. Se seu cliente vive no ChatGPT, você precisa de um adaptador (existem comunitários, mas não oficial). Pra todos os outros, é nativo.

---

## 6. Por que CRM via MCP é especialmente poderoso

Algumas integrações ganham 10% de produtividade com MCP. CRM ganha **10x**. Por quê?

### 6.1. CRM é interface, e interface vira linguagem

A maior parte do trabalho num CRM é **clicar pra mudar pequenos atributos**. "Move esse lead de qualificação pra negociação." "Adiciona uma nota dizendo que o cliente pediu desconto." "Marca como ganho." Cada uma dessas operações é 4-7 cliques.

Em linguagem natural, são frases de 5 palavras. **MCP transforma o CRM em chat-driven** — o usuário fala, a IA executa, vira commit no DB.

### 6.2. CRM já tem integrações (WhatsApp, e-mail, calendar)

Se a IA tem MCP do CRM **e** MCP do Gmail **e** MCP do calendar, ela pode encadear:

> "Olha as últimas mensagens desse lead no WhatsApp, agenda uma reunião no calendar pra terça às 15h, e cria uma activity no CRM dizendo 'reunião agendada'."

Sem MCP, isso é um workflow custom que você implementa por cliente. Com MCP, **a inteligência é do LLM**, e cada servidor MCP só precisa expor a operação atômica.

### 6.3. CRM tem schema rico que vira contexto

`crm_pipelines.vocabulary`, `crm_stages.win_probability`, `crm_leads.custom_fields` — tudo isso pode ser **resource** lido pela IA antes de qualquer ação. Resultado: a IA usa o vocabulário do nicho ("paciente" pra clínica, "matrícula" pra escola), respeita probabilidades de fechamento, conhece os custom fields. Você não escreve prompt nenhum.

### 6.4. CRM é estado — IA vira workflow engine

Combine **resources** (estado atual) + **tools** (transições válidas) + **prompts** (operações pré-definidas) e você essencialmente expôs uma máquina de estados manipulável por LLM. **CRM = workflow. MCP = API de workflow.**

---

## 7. Cinco use cases reais que vão acontecer no dia 1

Esses são os pedidos que seu cliente vai fazer pro Claude Desktop conectado ao seu CRM, sem você programar nada além das tools:

### Use case 1 — "Cria um lead do João, pelo WhatsApp dele"

> *"Acabei de falar com o João Silva no whats, telefone +55 11 99999-1234, ele tá interessado em fechar plano premium. Cria um lead pra mim."*

LLM chama:
1. `crm://schema` (resource) → entende campos
2. `list_pipelines` → escolhe o pipeline default
3. `create_lead` → com title="João Silva — Plano Premium", contact_phone, value_cents

### Use case 2 — "Promove esse lead pra negociação"

> *"O João respondeu, tá animado. Bota ele em negociação."*

LLM chama:
1. `search_leads` por "João" → pega `lead_id`
2. `list_stages` do pipeline atual → identifica stage "Negociação"
3. `move_lead_to_stage`

### Use case 3 — "Lista quem tá parado há 7 dias"

> *"Quais leads não tiveram atividade na última semana?"*

LLM chama:
1. `list_leads` com filtro `last_activity_before` = `now - 7d`
2. Formata resposta em tabela
3. Sugere ação pra cada (a partir do system prompt do servidor)

### Use case 4 — "Marca como ganho, R$ 4.500, fecha"

> *"Fechei com a Maria, 4500. Marca como ganho."*

LLM chama:
1. `search_leads` por "Maria"
2. `update_lead` com `value_cents=450000`
3. `mark_lead_won`

### Use case 5 — "Resumo do funil"

> *"Como tá o funil? Onde tem mais lead parado?"*

LLM chama:
1. `get_lead_metrics`
2. Formata análise com insights

Note: **você não escreveu nenhum prompt pra isso**. Tudo emerge do par (descrição-de-tool + raciocínio-do-LLM).

---

## 8. Arquitetura: como CRM e MCP se conectam

```
┌─────────────────────┐
│  Claude Desktop /   │
│  Cursor / Cline     │  (cliente MCP)
└──────────┬──────────┘
           │
           │  stdio (local)
           │  ou HTTPS (remoto)
           │
           │  protocolo MCP (JSON-RPC 2.0)
           ▼
┌─────────────────────┐
│  Seu MCP Server     │  Node.js + @modelcontextprotocol/sdk
│  (esta aula)        │  - registerTool()
│                     │  - registerResource()
│                     │  - registerPrompt()
└──────────┬──────────┘
           │
           │  HTTP REST (sua API da Parte 2)
           │  ou
           │  SQL direto (Supabase / Postgres)
           ▼
┌─────────────────────┐
│  Banco do CRM       │  (Postgres)
│  crm_leads, etc.    │
└─────────────────────┘
```

🎯 **Decisão importante:** o MCP server pode **chamar sua REST API** (que você fez na Parte 2) ou **bater direto no banco**. Trade-offs:

| Caminho | Vantagens | Desvantagens |
|---------|-----------|--------------|
| MCP → REST API → DB | Reúsa toda a validação, RLS, lógica de negócio. Uma fonte de verdade. | Latência extra (extra hop HTTP). Acoplamento ao deploy da API. |
| MCP → DB direto | Mais rápido. Independente do deploy da REST API. | Você precisa duplicar validações. RLS via service-role bypass — você assume responsabilidade pela segurança. |

**Recomendação default:** MCP → REST API. Só vá direto ao DB se latência/uptime exigir, e nesse caso compartilhe o pacote de validação (zod) entre os dois.

Esta aula mostra **o caminho REST**. Trocar pra DB direto é trivial — basta substituir o `db.ts`.

---

## 9. stdio vs HTTP — quando usar cada um

### 9.1. stdio

**Cliente spawneia o servidor.** Cada usuário roda o seu próprio processo MCP localmente. Configuração via `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "crm": {
      "command": "node",
      "args": ["/Users/joao/crm-mcp/build/index.js"],
      "env": {
        "CRM_API_BASE_URL": "https://api.seucrm.com",
        "CRM_API_TOKEN": "tok_xxx"
      }
    }
  }
}
```

✅ **Bom pra:**
- Desenvolvimento local
- Power users que rodam Node
- Distribuição via `npx @suaempresa/crm-mcp` (cliente baixa sob demanda)

❌ **Ruim pra:**
- Cliente final não-técnico que não vai instalar Node
- Ambiente corporativo onde IT bloqueia binários

### 9.2. Streamable HTTP

**Servidor publicado.** Cliente conecta via URL. Configuração:

```json
{
  "mcpServers": {
    "crm": {
      "type": "http",
      "url": "https://mcp.seucrm.com/mcp",
      "headers": {
        "Authorization": "Bearer tok_xxx"
      }
    }
  }
}
```

✅ **Bom pra:**
- SaaS multi-tenant — você hospeda 1 servidor, todos os clientes apontam
- Atualização centralizada (você faz deploy, todos pegam)
- Auth e rate limit centralizado
- Cliente final só cola um URL no Claude Desktop

❌ **Ruim pra:**
- Latência extra
- Você assume custo de hosting
- Precisa de TLS, observabilidade, escalonamento

### 9.3. Recomendação por estágio do produto

| Estágio | Transport |
|---------|-----------|
| Validação (você sozinho) | stdio |
| Beta fechado (5-10 clientes técnicos) | stdio + npm publish |
| Produto real | Streamable HTTP + URL pública |
| Empresa B2B grande | Streamable HTTP self-host opcional pro cliente |

**Bom servidor MCP suporta os dois transports** sem duplicar lógica. É o que vamos fazer.

---

## 10. Limitações atuais do MCP (honestamente)

Pra você não se decepcionar e nem prometer demais ao cliente:

1. **State cross-session é por sua conta.** O protocolo tem `Mcp-Session-Id` em HTTP, mas se o cliente desconectar e reconectar com sessão nova, contexto se perde. Solução: state real fica no seu DB.
2. **Auth padronizado ainda em ferro.** Bearer token é o caminho prático. OAuth 2.1 está na spec, mas implementações ainda divergem.
3. **Streaming de mídia (imagens, áudio) é limitado.** Tools podem retornar `content` com `image` e `audio`, mas tamanho é restrito. Pra arquivos grandes, retorne URL.
4. **Não tem "webhook reverso" oficial.** O servidor MCP não pode "empurrar" notificação se o cliente desconectou. Tem `notifications` em sessão ativa, mas se a sessão caiu, perdeu.
5. **Observabilidade não-padrão.** Cada servidor MCP loga do jeito dele. Não existe `traceId` correlacionado com o cliente IA.
6. **Versionamento de tools não-formal.** Se você renomear uma tool, prompts antigos quebram. Estabilidade da interface vira sua responsabilidade.

Nada disso é bloqueante. Mas vale você saber.

---

## 11. Mapa do que vem pela frente nesta Parte 3

| Documento | O que cobre |
|-----------|-------------|
| **13 — MCP Server: implementação** | Setup do projeto, estrutura, transport stdio + HTTP, auth, primeiras tools |
| **14 — Tools do CRM** | Implementação completa de 19+ tools (read + write) com schemas Zod |
| **15 — Deploy e conexão** | Claude Desktop, Cursor, Anthropic SDK direto, deploy HTTP remoto, segurança, npm publish |
| **reference/mcp-server.ts** | Servidor MCP completo executável em arquivo único |
| **reference/mcp-config-claude-desktop.json** | Config de Claude Desktop pronta pra colar |
| **prompts/prompt-08-mcp-server-implementation.md** | Prompt executável pra IA construir tudo isso do zero |

---

## 12. Antes de seguir, calibre expectativas

Você vai sair desta parte com:

✅ Um servidor MCP **executável**, em TypeScript, com 19+ tools cobrindo o funil completo de CRM
✅ Transports stdio **e** HTTP, ambos no mesmo código
✅ Auth via Bearer token, rate limit, audit log, multi-tenant resolvido
✅ Distribuição como pacote npm
✅ Conexão testada com Claude Desktop, Cursor, e SDK Anthropic direto

E vai entender por que, daqui pra frente, **CRM sem MCP vai parecer software de 2010**.

---

## Próximo: [13-mcp-server-implementacao.md](13-mcp-server-implementacao.md)
