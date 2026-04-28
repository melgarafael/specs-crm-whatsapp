# Como usar os prompts

> **Resumo:** estes 5 prompts são **self-contained**. Cada um inclui todo contexto necessário para uma IA implementar uma fase do CRM sem precisar ler outros arquivos. Foi feito assim de propósito: você cola um prompt, a IA executa, você revisa, parte pro próximo.

---

## Os 5 prompts

| # | Prompt | O que constrói | Tempo IA |
|---|--------|----------------|----------|
| 01 | [Scaffolding](prompt-01-scaffolding.md) | Projeto Next.js + DB + estrutura | 15-30 min |
| 02 | [WAHA Integration](prompt-02-waha-integration.md) | Cliente WAHA + endpoints de sessão | 20-40 min |
| 03 | [Message Flow](prompt-03-message-flow.md) | Webhook + envio + persistência | 30-60 min |
| 04 | [Frontend Chat](prompt-04-frontend-chat.md) | UI completa de chat live | 30-60 min |
| 05 | [CRM Binding](prompt-05-crm-binding.md) | Pipeline + deals + binding | 30-60 min |

**Tempo total IA:** ~3-5 horas (inclui sua revisão entre cada prompt).

---

## Workflow recomendado

### Para Cursor / Claude Code / Cline

1. Abra o projeto (vazio ou existente).
2. Cole o prompt 01 inteiro.
3. **Aguarde a IA terminar** (não interrompa). Ela vai criar arquivos, rodar comandos, etc.
4. **Revise**. Olhe os arquivos criados. Rode o que ela pediu. Cheque o "Definition of Done".
5. Faça commit: `git commit -m "fase 01: scaffolding"`.
6. Cole o próximo prompt. Repita.

### Para ChatGPT / Claude (chat puro, sem código)

A IA não pode criar arquivos. Use os prompts pra **gerar o código** que você cola manualmente. Estratégia:
1. Cole o prompt.
2. IA produz blocos de código com paths.
3. Você cria os arquivos copiando.
4. Roda comandos manualmente.

---

## Regras de ouro pra IA executora

Os prompts incluem essas regras embutidas, mas vale repetir:

1. **Não invente arquivos não solicitados.** Se o prompt pede "crie 3 arquivos", crie 3 — não 5.
2. **Use exatamente o stack pedido.** Next.js 14 App Router, TypeScript, Supabase, shadcn/ui. Não substitua sem permissão.
3. **Não pule para o próximo prompt.** Cada um termina em "Definition of Done" — pare ali.
4. **Comente onde precisa decisão humana.** Ex: `// TODO: configurar pipeline default` e siga em frente.
5. **Idempotência.** Se o prompt rodar 2x, não duplica nada. Use `IF NOT EXISTS`, `upsert`, etc.

---

## O que fazer se a IA travar

| Sintoma | Ação |
|---------|------|
| "Não sei qual stack usar" | Cole de novo a seção "Stack obrigatório" do prompt |
| "Posso criar X em vez?" | Diga "não, siga o prompt exatamente" |
| "Preciso de mais contexto sobre Y" | Cole a seção da aula relevante (ex: doc 03 inteiro) |
| Cria arquivo errado | Apague, refaça o prompt |
| Cria mais do que pedido | Apague o extra; mantenha o foco da fase |

---

## Customização por nicho

Os prompts são genéricos. Para nichar (clínica, imobiliária, advocacia), no final de cada prompt adicione:

> **Vocabulário do nicho:** substitua "contact" por "paciente", "deal" por "consulta", "pipeline" por "trilha de atendimento". (Por exemplo, para clínica.)

A IA aplica em labels, comentários, e seeds — sem mudar o schema.

---

## Validação ao final dos 5 prompts

Você deve conseguir:
- [ ] Conectar 1 número de WhatsApp ao CRM via QR
- [ ] Receber mensagens do cliente em tempo real na UI
- [ ] Enviar texto, imagem e áudio
- [ ] Ver checks de status (cinza → azul) atualizando
- [ ] Conversa nova cria deal automaticamente no funil
- [ ] Mover deal de estágio
- [ ] Resolver conversa
- [ ] Atribuir conversa a outro operador

Se isso tudo funciona: você tem um MVP de CRM Chat Live com WhatsApp pronto pra mostrar.

---

## Próximo: [prompt-01-scaffolding.md](prompt-01-scaffolding.md)
