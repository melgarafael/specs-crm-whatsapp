# 01 — CRM como core do sistema (não como tela)

> **Resumo:** o CRM não é uma feature lateral nem uma tela de "cadastro de contatos". É a **fonte da verdade de pessoas, oportunidades e atividades** — o núcleo gravitacional ao redor do qual todos os outros módulos (chat, e-mail, calendar, billing, documentos, IA) orbitam. Este doc estabelece a filosofia que sustenta o resto da seção.

---

## 1. A frase que muda tudo

> "Toda mensagem é de alguém. Toda conversa é sobre algo. Toda venda começa numa conversa. Toda agenda mira uma conversa. Toda nota financeira pertence a alguém. Onde mora 'alguém' e 'algo'? No CRM."

Se o CRM não responde "quem é essa pessoa e qual o estado dela com a gente?" — você não tem CRM. Você tem **um cadastro**. A diferença é que o CRM **integra contexto** vindo de todos os módulos do sistema e devolve isso pra qualquer um que pergunte.

---

## 2. Anti-pattern clássico: o "CRM como tela de lista"

A pior arquitetura comum em sistemas SaaS pequenos:

```
┌────────────────────────────────────────────────────┐
│  Sidebar:  Inbox · Chat · Agendamentos · CRM       │
└────────────────────────────────────────────────────┘
                                          │
                                          ▼
                                ┌─────────────────┐
                                │  CRM (tela)     │
                                │  Lista de leads │
                                │  com nome+fone  │
                                └─────────────────┘
```

Sintomas desse anti-pattern:

| Sintoma | Causa raiz |
|---------|-----------|
| "Onde eu vejo o histórico do paciente?" → 3 telas diferentes | Sem unificação |
| Mesmo contato tem 3 cards (um no chat, um no agendamento, um no CRM) | Sem identidade canônica |
| Mudou status no CRM, mas chat continua mostrando velho | Sem source of truth |
| IA não sabe quem é o cliente quando responde mensagem | CRM desconectado da camada conversacional |
| Relatório do mês não bate com o que o atendente diz | Cada módulo tem seu próprio "estado" |

Quando o CRM é só uma tela, **cada módulo reinventa pessoas, oportunidades e atividades por conta própria**. Você acaba com 4 versões da mesma verdade — e nenhuma delas é confiável.

---

## 3. A arquitetura correta: CRM como núcleo gravitacional

```
                          ┌──────────────────┐
                          │     Calendar     │
                          │  (agendamentos)  │
                          └────────┬─────────┘
                                   │ FK: lead_id, contact_id
                                   │
        ┌──────────────┐           │           ┌────────────────┐
        │   E-mail     │◄──────────┤           │   WhatsApp     │
        │   (Resend)   │           │           │   (WAHA/Meta)  │
        └──────┬───────┘           │           └───────┬────────┘
               │                   │                   │
               │ FK: contact_id    │   FK: contact_id  │
               │                   ▼                   │
               │           ┌────────────────┐          │
               └──────────►│                │◄─────────┘
                           │      CRM       │
        ┌─────────────────►│   (CORE)       │◄──────────────┐
        │                  │                │               │
        │ FK: contact_id   │  ┌──────────┐  │   FK: lead_id │
        │                  │  │ pipelines│  │               │
   ┌────┴──────┐           │  │ stages   │  │       ┌───────┴────┐
   │ Documents │           │  │ leads    │  │       │  Billing   │
   │ (S3/PDFs) │           │  │ activities│ │       │ (Stripe..) │
   └───────────┘           │  │ links    │  │       └────────────┘
                           │  └──────────┘  │
                           └───────┬────────┘
                                   │ events
                                   ▼
                          ┌──────────────────┐
                          │   IA / Agent     │
                          │  Runtime / Bot   │
                          └──────────────────┘
```

Lê-se assim:

- **No centro:** as 5 tabelas core do CRM (`crm_pipelines`, `crm_stages`, `crm_leads`, `crm_lead_activities`, `crm_lead_links`).
- **Setas chegando:** módulos satélites enviam eventos/atividades pro CRM (`mensagem chegou` → `lead_activity`). O CRM **agrega** o que aconteceu com cada pessoa.
- **Setas saindo:** quando o CRM muda (lead avançou de stage), satélites reagem (calendar agenda follow-up, e-mail dispara template, IA atualiza memória).
- **Bidirecional:** todo módulo é cliente E servidor do CRM.

---

## 4. O que faz um módulo ser "core" tecnicamente

Um módulo é **core** quando satisfaz os 4 critérios:

### 4.1 É a única fonte da verdade pra um conceito de domínio

Para "pessoa do negócio" e "oportunidade comercial", **só o CRM responde**. Se outro lugar tem dados sobre pessoa que o CRM não tem, ou esse outro lugar é satélite (denormalizado, sincronizado por evento) ou você tem um problema de modelagem.

### 4.2 Outros módulos referenciam por FK, não por cópia

```sql
-- ✅ Bom: appointments aponta pra lead
create table appointments (
  id uuid primary key,
  lead_id uuid references crm_leads(id),
  starts_at timestamptz,
  ...
);

-- ❌ Ruim: appointments duplica nome do lead
create table appointments (
  id uuid primary key,
  patient_name text,        -- duplicado
  patient_phone text,       -- duplicado
  patient_email text,       -- duplicado
  starts_at timestamptz
);
```

Se você duplica nome/telefone/e-mail em cada módulo, no dia que o cliente trocar o telefone você vai descobrir 7 lugares pra atualizar.

### 4.3 Emite eventos que outros módulos consomem

O CRM publica eventos como:

- `lead.created`
- `lead.stage_changed`
- `lead.won`
- `lead.lost`
- `lead.assigned`
- `lead_activity.recorded`

E satélites consomem (Calendar agenda follow-up automático, E-mail dispara sequência, IA atualiza memória).

### 4.4 Tem RLS e permissões próprias — outros módulos respeitam

Quem pode ver lead X é decidido **no CRM**. Calendar não pode mostrar consulta de um lead que o usuário logado não tem acesso a ler. Isso é resolvido com FK + RLS — Calendar não duplica regra de permissão, **delega** ao join com CRM.

---

## 5. Sinais de que seu CRM virou (ou não) core

### Sinais de que SIM, virou core ✅

- Apertar `Ctrl+K` em qualquer tela e digitar nome do cliente abre tudo dele (mensagens, agendamentos, e-mails, notas, deals)
- Mudar tag em um lead aparece imediato em todos os módulos
- Auditoria responde "o que aconteceu com essa pessoa nos últimos 30 dias?" em uma query
- IA do agente sabe responder "esse cliente já comprou? em que estágio está? última interação?" em <100ms
- Quando o cliente troca telefone, você atualiza em **um lugar** e tudo se realinha

### Sinais de que NÃO ⚠️

- Tem 2+ tabelas de "contatos" no DB (`contacts`, `users`, `clients`, `patients`)
- Mensagem chega no chat mas demora um clique pra "vincular ao CRM"
- Relatório de funil é gerado com export+merge no Excel
- Time de produto pergunta "onde devo gravar isso, no CRM ou no [outro módulo]?"
- IA precisa de uma rota separada pra buscar contexto do cliente

---

## 6. As 3 leis do CRM como core

### Lei 1 — Identidade canônica

Toda pessoa do negócio tem **um único `contact_id`**. Toda oportunidade tem **um único `lead_id`**. Os IDs são UUID, não dependem do canal de origem.

⚠️ **Gotcha:** um mesmo humano pode ter 2 contacts diferentes em 2 organizações diferentes. Isso é correto e esperado. Multi-tenant não fere a identidade canônica — ela é canônica **dentro da organização**.

### Lei 2 — Atividade polimórfica

Tudo que acontece com uma pessoa vira uma `crm_lead_activity` — não importa de onde veio. Mensagem WhatsApp, e-mail enviado, ligação, nota manual, evento de pagamento, webhook externo. **Tudo entra no mesmo timeline**.

```
crm_lead_activities (id, lead_id, contact_id, type, source_module, source_id, body, performed_at, ...)
```

`source_module` diz de onde nasceu (`whatsapp`, `email`, `calendar`, `billing`, `manual`, `agent`). `source_id` aponta pro registro original. Isso permite renderizar timeline rico sem JOIN com 8 tabelas diferentes.

### Lei 3 — Vínculo polimórfico explícito

Quando uma entidade satélite precisa estar **conectada** a um lead (não só logada como atividade), use `crm_lead_links`:

```
crm_lead_links (id, lead_id, target_kind, target_id, link_kind, metadata)
```

Exemplo: lead vinculado a uma `conversation` específica de WhatsApp:

```sql
insert into crm_lead_links (lead_id, target_kind, target_id, link_kind)
values ('lead-uuid', 'conversation', 'conv-uuid', 'primary_conversation');
```

Isso é a ponte universal pra qualquer módulo. `target_kind` é uma string aberta — futuros módulos não exigem migração.

---

## 7. Diagrama de fluxo: mensagem WhatsApp em um sistema com CRM-core

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  WhatsApp ──> WAHA ──> webhook ──> backend                           │
│                                       │                              │
│                                       ▼                              │
│                            UPSERT contact (CRM-core resolve)         │
│                                       │                              │
│                                       ▼                              │
│                       UPSERT conversation (chat module)              │
│                                       │                              │
│                                       ▼                              │
│                            INSERT message (chat module)              │
│                                       │                              │
│                                       ▼                              │
│   ┌──────────────────────── BINDING CRM ────────────────────────┐    │
│   │  Se contact é novo OU sem lead aberto:                      │    │
│   │     INSERT crm_lead (stage = primeiro do pipeline default)  │    │
│   │     INSERT crm_lead_link (target=conversation)              │    │
│   │  INSERT crm_lead_activity                                   │    │
│   │     (source_module=whatsapp, source_id=message.id)          │    │
│   │  UPDATE crm_lead.last_activity_at                           │    │
│   └─────────────────────────────────────────────────────────────┘    │
│                                       │                              │
│                                       ▼                              │
│                           NOTIFY 'lead.activity_recorded'            │
│                                  │           │                       │
│                                  ▼           ▼                       │
│                       ┌──────────┐    ┌──────────┐                   │
│                       │ Realtime │    │   IA     │                   │
│                       │ frontend │    │ runtime  │                   │
│                       └──────────┘    └──────────┘                   │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

Note que o **chat module** (conversations, messages) é satélite. Ele acontece, registra, e **emite pro CRM**. O CRM é quem decide o que isso significa pra venda.

---

## 8. O que CRM-core NÃO é

Pra fechar o conceito, vamos separar:

| CRM-core É | CRM-core NÃO É |
|------------|----------------|
| Fonte da verdade de pessoas e oportunidades | Sistema de mensageria (isso é chat) |
| Timeline unificada de atividades | Player de áudio/mídia |
| Pipeline com stages e regras de avanço | UI de editor de texto rico |
| Emissor/consumidor de eventos | Storage de arquivos (isso é S3/Storage) |
| Camada de permissões de acesso a dados de cliente | Sistema de autenticação (isso é Auth) |
| Provedor de contexto pra IA e automações | LLM ou agente em si |

CRM-core é **uma camada de domínio**, não uma camada de UI. A UI do kanban é satélite — você pode ter 0 telas de kanban e ainda ter CRM-core (via API/MCP). A maioria dos sistemas tem kanban pq é a UI canônica, mas é decisão de produto, não de arquitetura.

---

## 9. Como Tomik chegou nesse formato (caso opcional)

> Esta seção é um exemplo concreto. Não é regra. Use como ilustração.

No início, o Tomik tinha:

- Tabela `patients` (do módulo clínica)
- Tabela `contacts` (do módulo CRM)
- Tabela `conversations` (do módulo chat)

Três fontes da verdade pra "pessoa". Sintoma: ao mudar telefone do paciente, o chat continuava mostrando antigo. Ao receber mensagem de número que era paciente conhecido, criava contato novo no CRM.

A refatoração:

1. `patients` virou **view materializada** sobre `crm_leads + crm_lead_activities` filtrado por nicho clínica.
2. `contacts` virou única identidade. Patients agora é um **enriquecimento** de contact.
3. `conversations.contact_id` aponta pro mesmo `contacts.id` que o CRM usa.
4. Agendamento, prescrição, exame — tudo passa a ter `lead_id` como FK.

Resultado: bug de "telefone diferente em telas diferentes" virou impossível. Relatório bate. IA tem contexto unificado.

---

## 10. O que vem nos próximos docs desta seção

| Doc | O que constrói |
|-----|---------------|
| 02 | Multi-tenant, múltiplos pipelines, vocabulário customizável, RLS |
| 03 | UI do kanban (cards, drag&drop com @hello-pangea/dnd, fractional indexing, realtime) |
| 04 | Schema canônico das 5 tabelas (SQL idempotente, indexes, triggers) |
| 05 | Custom fields por nicho (10 nichos cobertos) |
| 06 | ⭐ **Data Relationship Doctrine** — o doc central |
| 07 | Eventos e comunicação inter-módulos |

E nas pastas `reference/` e `prompts/` ficam os artefatos prontos pra colar.

---

## Próximo: [02-multi-tenant-pipelines.md](02-multi-tenant-pipelines.md)
