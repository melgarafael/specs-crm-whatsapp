# Reference — 10 nichos: campos, vocabulário e relacionamentos

> **Resumo:** referência canônica dos 10 nichos cobertos pela aula. Para cada um: vocabulário sugerido, tabela de fields recomendados, tabela de relacionamentos com módulos satélites, e bloco JSON pronto para colar em `crm_pipelines.settings.fields`.

---

## Como usar este documento

1. Identifique o nicho do seu cliente.
2. Copie o vocabulário sugerido em `crm_pipelines.vocabulary`.
3. Copie o JSON de fields em `crm_pipelines.settings.fields`.
4. Use a tabela de relacionamentos como **mapa mental** ao construir os módulos satélites (calendar, billing, documents).
5. Adapte. Esta é uma base, não um dogma.

---

## 1. Clínica médica

**Lead = Paciente · Deal = Atendimento**

### Vocabulário

```json
{
  "lead": "Paciente", "lead_plural": "Pacientes",
  "deal": "Atendimento", "deal_plural": "Atendimentos",
  "won_label": "Realizado", "lost_label": "Cancelado",
  "owner_label": "Médico responsável",
  "value_label": "Valor da consulta",
  "title_field": "Motivo do atendimento"
}
```

### Fields recomendados

| key | label | type | Notas |
|-----|-------|------|-------|
| `convenio` | Convênio | select | Particular, Unimed, Bradesco Saúde, ... |
| `numero_carteirinha` | Carteirinha | text | Quando convênio != Particular |
| `cpf` | CPF | text | Validar com regex |
| `data_nascimento` | Data de nascimento | date | — |
| `alergias` | Alergias | textarea | Crítico p/ atendimento |
| `medicamentos_uso_continuo` | Medicamentos contínuos | textarea | — |
| `medico_responsavel_id` | Médico responsável | reference | aponta `professionals.id` |
| `tipo_atendimento` | Tipo | select | Consulta, Retorno, Procedimento, Exame |
| `valor_consulta_cents` | Valor (R$) | currency | — |
| `ultimo_atendimento_em` | Último atendimento | date | denormalizado de appointments |
| `procedencia` | Como conheceu | select | Indicação, Convênio, Google, Instagram, ... |

### Relacionamentos com módulos satélites

| Field / lead | Conecta com | Padrão |
|-------------|------------|--------|
| `medico_responsavel_id` | `professionals.id` (módulo equipe) | reference + soft FK |
| Lead | `appointments.lead_id` (calendar) | FK rígida |
| Lead | `prescriptions.lead_id` (módulo prescrições) | FK rígida |
| Lead | `lab_results.lead_id` (módulo exames) | FK rígida |
| Lead | `medical_records.lead_id` (prontuário) | FK rígida |
| `crm_lead_links target_kind='conversation'` | `conversations` (chat WhatsApp) | poly |
| `crm_lead_links target_kind='invoice'` | `invoices` (financeiro) | poly |

### JSON `settings.fields`

```json
{
  "fields": [
    {"key": "convenio", "label": "Convênio", "type": "select", "options": ["Particular","Unimed","Bradesco Saúde","SulAmérica","Amil","Hapvida","Outro"], "required": true, "show_in_card": true, "show_in_filter": true, "group": "Saúde"},
    {"key": "numero_carteirinha", "label": "Carteirinha", "type": "text", "show_in_form": true, "group": "Saúde"},
    {"key": "cpf", "label": "CPF", "type": "text", "group": "Identificação"},
    {"key": "data_nascimento", "label": "Data de nascimento", "type": "date", "group": "Identificação"},
    {"key": "alergias", "label": "Alergias", "type": "textarea", "show_in_form": true, "group": "Saúde"},
    {"key": "medicamentos_uso_continuo", "label": "Medicamentos contínuos", "type": "textarea", "group": "Saúde"},
    {"key": "medico_responsavel_id", "label": "Médico responsável", "type": "reference", "show_in_card": true, "show_in_filter": true, "group": "Atendimento"},
    {"key": "tipo_atendimento", "label": "Tipo de atendimento", "type": "select", "options": ["Consulta","Retorno","Procedimento","Exame"], "show_in_card": true, "show_in_filter": true, "group": "Atendimento"},
    {"key": "valor_consulta_cents", "label": "Valor (R$)", "type": "currency", "show_in_card": true, "group": "Financeiro"},
    {"key": "ultimo_atendimento_em", "label": "Último atendimento", "type": "date", "group": "Atendimento"},
    {"key": "procedencia", "label": "Como conheceu", "type": "select", "options": ["Indicação","Convênio","Google","Instagram","Outro"], "show_in_filter": true, "group": "Origem"}
  ]
}
```

---

## 2. Imobiliária

**Lead = Lead · Deal = Imóvel/Contrato**

### Vocabulário

```json
{
  "lead": "Lead", "lead_plural": "Leads",
  "deal": "Imóvel", "deal_plural": "Imóveis",
  "won_label": "Fechado", "lost_label": "Sem interesse",
  "owner_label": "Corretor", "title_field": "Imóvel de interesse"
}
```

### Fields recomendados

| key | label | type | Notas |
|-----|-------|------|-------|
| `tipo_negociacao` | Compra ou aluguel | select | Compra, Aluguel, Temporada |
| `tipo_imovel` | Tipo de imóvel | select | Apartamento, Casa, Comercial, Terreno |
| `faixa_preco_min_cents` | Preço mín (R$) | currency | — |
| `faixa_preco_max_cents` | Preço máx (R$) | currency | — |
| `regiao_interesse` | Regiões | multiselect | Bairros / zonas |
| `metragem_min` | Metragem mín (m²) | number | — |
| `quartos_min` | Quartos | number | — |
| `vagas_garagem_min` | Vagas garagem | number | — |
| `precisa_financiamento` | Financia? | boolean | — |
| `tem_fgts` | Tem FGTS? | boolean | — |
| `imovel_principal_id` | Imóvel de interesse | reference | aponta `assets.id` |
| `prazo_decisao_dias` | Prazo decisão (dias) | number | — |

### Relacionamentos com módulos satélites

| Field / lead | Conecta com | Padrão |
|-------------|------------|--------|
| `imovel_principal_id` | `assets.id` (catálogo) | reference + soft FK |
| Lead | `assets_visits.lead_id` (visitas) | FK rígida |
| Lead | `appointments.lead_id` (calendar — visita) | FK rígida |
| Lead | `contracts.lead_id` (contratos) | FK rígida |
| Lead | `proposals.lead_id` (propostas) | FK rígida |

### JSON `settings.fields`

```json
{
  "fields": [
    {"key": "tipo_negociacao", "label": "Compra ou aluguel", "type": "select", "options": ["Compra","Aluguel","Temporada"], "required": true, "show_in_card": true, "show_in_filter": true},
    {"key": "tipo_imovel", "label": "Tipo de imóvel", "type": "select", "options": ["Apartamento","Casa","Comercial","Terreno","Cobertura","Sítio"], "show_in_card": true, "show_in_filter": true},
    {"key": "faixa_preco_min_cents", "label": "Preço mín (R$)", "type": "currency", "show_in_filter": true},
    {"key": "faixa_preco_max_cents", "label": "Preço máx (R$)", "type": "currency", "show_in_filter": true, "show_in_card": true},
    {"key": "regiao_interesse", "label": "Regiões", "type": "multiselect", "options": ["Centro","Zona Sul","Zona Norte","Zona Oeste","Zona Leste","Outra"], "show_in_filter": true},
    {"key": "metragem_min", "label": "Metragem mín (m²)", "type": "number"},
    {"key": "quartos_min", "label": "Quartos", "type": "number", "show_in_card": true},
    {"key": "vagas_garagem_min", "label": "Vagas garagem", "type": "number"},
    {"key": "precisa_financiamento", "label": "Precisa financiamento?", "type": "boolean", "show_in_filter": true},
    {"key": "tem_fgts", "label": "Tem FGTS?", "type": "boolean"},
    {"key": "imovel_principal_id", "label": "Imóvel de interesse", "type": "reference", "show_in_card": true},
    {"key": "prazo_decisao_dias", "label": "Prazo decisão (dias)", "type": "number"}
  ]
}
```

---

## 3. Advocacia

**Lead = Cliente · Deal = Caso**

### Vocabulário

```json
{
  "lead": "Cliente", "lead_plural": "Clientes",
  "deal": "Caso", "deal_plural": "Casos",
  "won_label": "Ganho", "lost_label": "Encerrado",
  "owner_label": "Advogado responsável", "title_field": "Descrição do caso"
}
```

### Fields recomendados

| key | label | type | Notas |
|-----|-------|------|-------|
| `area_direito` | Área | select | Trabalhista, Civil, Criminal, Família, Empresarial |
| `numero_processo` | Nº do processo | text | Format CNJ |
| `comarca` | Comarca | text | — |
| `tribunal` | Tribunal | text | TJSP, TRT2, etc. |
| `instancia` | Instância | select | 1ª, 2ª, STJ, STF |
| `valor_causa_cents` | Valor da causa | currency | — |
| `tipo_honorarios` | Honorários | select | Êxito, Fixo, Misto |
| `prazo_proxima_acao` | Próximo prazo | date | — |
| `parte_contraria` | Parte contrária | text | — |
| `vara` | Vara | text | — |
| `status_processual` | Status processual | select | Em curso, Sentenciado, Em recurso, Trânsito julgado |

### Relacionamentos com módulos satélites

| Field / lead | Conecta com | Padrão |
|-------------|------------|--------|
| `numero_processo` | API tribunal externa (Datajud, Escavador) | webhook/scrape |
| `prazo_proxima_acao` | `appointments` (agenda processual) | derivação automática |
| Lead | `documents.lead_id` (petições, contratos, decisões) | FK rígida |
| Lead | `legal_deadlines.lead_id` (prazos) | FK rígida |
| `area_direito` | Routing pra time específico | `automation_config.on_enter` |

### JSON `settings.fields`

```json
{
  "fields": [
    {"key": "area_direito", "label": "Área", "type": "select", "options": ["Trabalhista","Civil","Criminal","Família","Empresarial","Tributário","Previdenciário"], "required": true, "show_in_card": true, "show_in_filter": true},
    {"key": "numero_processo", "label": "Nº do processo", "type": "text", "show_in_card": true},
    {"key": "comarca", "label": "Comarca", "type": "text"},
    {"key": "tribunal", "label": "Tribunal", "type": "text"},
    {"key": "instancia", "label": "Instância", "type": "select", "options": ["1ª","2ª","STJ","STF","TST","TSE"]},
    {"key": "valor_causa_cents", "label": "Valor da causa", "type": "currency", "show_in_card": true},
    {"key": "tipo_honorarios", "label": "Honorários", "type": "select", "options": ["Êxito","Fixo","Misto"]},
    {"key": "prazo_proxima_acao", "label": "Próximo prazo", "type": "date", "show_in_card": true, "show_in_filter": true},
    {"key": "parte_contraria", "label": "Parte contrária", "type": "text"},
    {"key": "vara", "label": "Vara", "type": "text"},
    {"key": "status_processual", "label": "Status processual", "type": "select", "options": ["Em curso","Sentenciado","Em recurso","Trânsito julgado"]}
  ]
}
```

---

## 4. Autoescola

**Lead = Aluno · Deal = Pacote/Matrícula**

### Vocabulário

```json
{
  "lead": "Aluno", "lead_plural": "Alunos",
  "deal": "Pacote", "deal_plural": "Pacotes",
  "won_label": "Habilitado", "lost_label": "Desistiu",
  "owner_label": "Instrutor", "title_field": "Pacote"
}
```

### Fields recomendados

| key | label | type | Notas |
|-----|-------|------|-------|
| `categoria_cnh` | Categoria | select | A, B, AB, C, D, E |
| `etapa_processo` | Etapa atual | select | LADV, PPD, CNH definitiva |
| `aulas_teoricas_total` | Aulas teóricas | number | — |
| `aulas_teoricas_feitas` | Aulas teóricas feitas | number | — |
| `aulas_praticas_total` | Aulas práticas | number | — |
| `aulas_praticas_feitas` | Aulas práticas feitas | number | — |
| `instrutor_id` | Instrutor | reference | aponta `professionals.id` |
| `veiculo_preferido` | Veículo | select | Carro, Moto |
| `data_prova_teorica` | Prova teórica | date | — |
| `data_prova_pratica` | Prova prática | date | — |
| `valor_pacote_cents` | Valor pacote | currency | — |

### Relacionamentos com módulos satélites

| Field / lead | Conecta com | Padrão |
|-------------|------------|--------|
| `instrutor_id` | `professionals.id` | reference |
| Lead | `appointments.lead_id` (aulas agendadas) | FK rígida |
| Lead | `invoices.lead_id` (parcelamento) | FK rígida |
| `data_prova_*` | `appointments` calendar | derivação |
| `aulas_*_feitas` | aggregate de `appointments.lead_id` filtered | denorm/job |

### JSON `settings.fields`

```json
{
  "fields": [
    {"key": "categoria_cnh", "label": "Categoria", "type": "select", "options": ["A","B","AB","C","D","E"], "required": true, "show_in_card": true, "show_in_filter": true},
    {"key": "etapa_processo", "label": "Etapa atual", "type": "select", "options": ["LADV","PPD","CNH definitiva","Renovação"], "show_in_card": true},
    {"key": "aulas_teoricas_total", "label": "Aulas teóricas", "type": "number"},
    {"key": "aulas_teoricas_feitas", "label": "Aulas teóricas feitas", "type": "number"},
    {"key": "aulas_praticas_total", "label": "Aulas práticas", "type": "number"},
    {"key": "aulas_praticas_feitas", "label": "Aulas práticas feitas", "type": "number"},
    {"key": "instrutor_id", "label": "Instrutor", "type": "reference", "show_in_filter": true},
    {"key": "veiculo_preferido", "label": "Veículo", "type": "select", "options": ["Carro","Moto"]},
    {"key": "data_prova_teorica", "label": "Prova teórica", "type": "date"},
    {"key": "data_prova_pratica", "label": "Prova prática", "type": "date"},
    {"key": "valor_pacote_cents", "label": "Valor do pacote", "type": "currency", "show_in_card": true}
  ]
}
```

---

## 5. Infoprodutor (lançamento)

**Lead = Lead · Deal = Compra**

### Vocabulário

```json
{
  "lead": "Lead", "lead_plural": "Leads",
  "deal": "Compra", "deal_plural": "Compras",
  "won_label": "Comprou", "lost_label": "Não comprou",
  "owner_label": "Closer", "title_field": "Produto"
}
```

### Fields recomendados

| key | label | type | Notas |
|-----|-------|------|-------|
| `produto_interesse` | Produto | select | Lista de produtos |
| `fonte_campanha` | Campanha | text | UTM source/medium |
| `utm_source` | UTM source | text | — |
| `utm_medium` | UTM medium | text | — |
| `utm_campaign` | UTM campaign | text | — |
| `faturamento_estimado_cents` | Faturamento estimado | currency | — |
| `fase_funil` | Fase | select | Captação, Aquecimento, Webinar, Carrinho aberto, Carrinho fechado |
| `assistiu_evento` | Assistiu evento? | boolean | — |
| `tempo_assistido_minutos` | Tempo assistido (min) | number | — |
| `clicou_carrinho` | Clicou checkout? | boolean | — |
| `plataforma_compra` | Plataforma | select | Hotmart, Kiwify, Eduzz, Outro |

### Relacionamentos com módulos satélites

| Field / lead | Conecta com | Padrão |
|-------------|------------|--------|
| `produto_interesse` | Plataforma externa (Hotmart/Kiwify/Eduzz) | API/webhook |
| `assistiu_evento`, `tempo_assistido_minutos` | Plataforma de live (StreamYard, etc.) | webhook |
| Lead | `purchases.lead_id` (orders/checkouts) | FK rígida |
| `fonte_campanha` + `utm_*` | Tabela `campaigns` (BI) | denormalizado |
| Webhook plataforma | `crm_lead_activities` | `source_module='hotmart'` |

### JSON `settings.fields`

```json
{
  "fields": [
    {"key": "produto_interesse", "label": "Produto", "type": "select", "options": ["Curso A","Curso B","Mentoria","Imersão"], "show_in_card": true, "show_in_filter": true},
    {"key": "fonte_campanha", "label": "Campanha", "type": "text", "show_in_filter": true},
    {"key": "utm_source", "label": "UTM source", "type": "text", "group": "Tracking"},
    {"key": "utm_medium", "label": "UTM medium", "type": "text", "group": "Tracking"},
    {"key": "utm_campaign", "label": "UTM campaign", "type": "text", "group": "Tracking"},
    {"key": "faturamento_estimado_cents", "label": "Faturamento estimado", "type": "currency"},
    {"key": "fase_funil", "label": "Fase do funil", "type": "select", "options": ["Captação","Aquecimento","Webinar","Carrinho aberto","Carrinho fechado","Pós-venda"], "show_in_card": true},
    {"key": "assistiu_evento", "label": "Assistiu evento?", "type": "boolean"},
    {"key": "tempo_assistido_minutos", "label": "Tempo assistido (min)", "type": "number"},
    {"key": "clicou_carrinho", "label": "Clicou no checkout?", "type": "boolean", "show_in_filter": true},
    {"key": "plataforma_compra", "label": "Plataforma", "type": "select", "options": ["Hotmart","Kiwify","Eduzz","Outro"]}
  ]
}
```

---

## 6. E-commerce

**Lead = Cliente · Deal = Pedido**

### Vocabulário

```json
{
  "lead": "Cliente", "lead_plural": "Clientes",
  "deal": "Pedido", "deal_plural": "Pedidos",
  "won_label": "Pago", "lost_label": "Cancelado",
  "owner_label": "Atendente", "title_field": "Pedido"
}
```

### Fields recomendados

| key | label | type | Notas |
|-----|-------|------|-------|
| `ltv_cents` | LTV | currency | denormalizado de orders |
| `numero_pedidos_total` | Pedidos no total | number | denorm |
| `ultimo_pedido_em` | Último pedido | date | denorm |
| `tickets_abertos` | Tickets abertos | number | denorm |
| `programa_fidelidade` | Tier fidelidade | select | Bronze, Prata, Ouro, Diamante |
| `nps_score` | NPS | number | 0–10 |
| `categoria_preferida` | Categoria preferida | multiselect | — |
| `cep_principal` | CEP | text | — |
| `frequencia_compra_dias` | Freq. de compra (dias) | number | — |
| `chargebacks` | Chargebacks histórico | number | — |

### Relacionamentos com módulos satélites

| Field / lead | Conecta com | Padrão |
|-------------|------------|--------|
| Lead | `orders.lead_id` (ou contact_id) | FK rígida |
| `ltv_cents` | view/MV de `orders` | denormalizado por job |
| `tickets_abertos` | `tickets` (suporte) | denormalizado por trigger |
| `nps_score` | `nps_responses.lead_id` | denormalizado do mais recente |
| Lead | `cart_abandonment_events.lead_id` | FK rígida |

### JSON `settings.fields`

```json
{
  "fields": [
    {"key": "ltv_cents", "label": "LTV", "type": "currency", "show_in_card": true},
    {"key": "numero_pedidos_total", "label": "Total de pedidos", "type": "number", "show_in_card": true},
    {"key": "ultimo_pedido_em", "label": "Último pedido", "type": "date"},
    {"key": "tickets_abertos", "label": "Tickets abertos", "type": "number"},
    {"key": "programa_fidelidade", "label": "Tier fidelidade", "type": "select", "options": ["Bronze","Prata","Ouro","Diamante"], "show_in_filter": true},
    {"key": "nps_score", "label": "NPS", "type": "number", "show_in_card": true},
    {"key": "categoria_preferida", "label": "Categoria preferida", "type": "multiselect", "options": ["Eletrônicos","Moda","Casa","Esporte","Beleza"]},
    {"key": "cep_principal", "label": "CEP", "type": "text"},
    {"key": "frequencia_compra_dias", "label": "Freq. compra (dias)", "type": "number"},
    {"key": "chargebacks", "label": "Chargebacks", "type": "number"}
  ]
}
```

---

## 7. Agência de marketing

**Lead = Prospect · Deal = Projeto**

### Vocabulário

```json
{
  "lead": "Prospect", "lead_plural": "Prospects",
  "deal": "Projeto", "deal_plural": "Projetos",
  "won_label": "Contratou", "lost_label": "Não fechou",
  "owner_label": "Account", "title_field": "Projeto"
}
```

### Fields recomendados

| key | label | type | Notas |
|-----|-------|------|-------|
| `budget_mensal_cents` | Budget mensal | currency | — |
| `redes_ativas` | Redes ativas | multiselect | Instagram, TikTok, YouTube, ... |
| `crm_atual` | CRM atual | text | — |
| `dor_principal` | Dor principal | textarea | — |
| `numero_funcionarios` | Funcionários | number | — |
| `setor` | Setor | select | — |
| `prazo_contrato_meses` | Prazo (meses) | number | — |
| `decisor_email` | E-mail do decisor | email | — |
| `decisor_nome` | Nome do decisor | text | — |

### Relacionamentos com módulos satélites

| Field / lead | Conecta com | Padrão |
|-------------|------------|--------|
| Lead | `contracts.lead_id` | FK rígida |
| Lead | `proposals.lead_id` | FK rígida |
| Lead | `email_threads.lead_id` (módulo e-mail) | FK rígida |
| `decisor_email` | identificação cross-channel (mesma pessoa em diferentes canais) | merge logic |
| Lead | `briefings.lead_id` | FK rígida |

### JSON `settings.fields`

```json
{
  "fields": [
    {"key": "budget_mensal_cents", "label": "Budget mensal", "type": "currency", "show_in_card": true, "show_in_filter": true},
    {"key": "redes_ativas", "label": "Redes ativas", "type": "multiselect", "options": ["Instagram","TikTok","YouTube","LinkedIn","Facebook","X (Twitter)","Pinterest"]},
    {"key": "crm_atual", "label": "CRM atual", "type": "text"},
    {"key": "dor_principal", "label": "Dor principal", "type": "textarea"},
    {"key": "numero_funcionarios", "label": "Funcionários", "type": "number"},
    {"key": "setor", "label": "Setor", "type": "select", "options": ["SaaS","Varejo","Saúde","Educação","Serviços","Indústria","Outro"]},
    {"key": "prazo_contrato_meses", "label": "Prazo (meses)", "type": "number"},
    {"key": "decisor_email", "label": "E-mail do decisor", "type": "email"},
    {"key": "decisor_nome", "label": "Nome do decisor", "type": "text"}
  ]
}
```

---

## 8. SaaS B2B

**Lead = Lead · Deal = Conta**

### Vocabulário

```json
{
  "lead": "Lead", "lead_plural": "Leads",
  "deal": "Conta", "deal_plural": "Contas",
  "won_label": "Cliente", "lost_label": "Lost",
  "owner_label": "AE/SDR", "title_field": "Empresa"
}
```

### Fields recomendados

| key | label | type | Notas |
|-----|-------|------|-------|
| `mrr_potencial_cents` | MRR potencial | currency | — |
| `seats` | Nº de assentos | number | — |
| `plano_alvo` | Plano alvo | select | Starter, Growth, Enterprise |
| `integracoes_pedidas` | Integrações pedidas | multiselect | — |
| `decisor_role` | Cargo do decisor | text | — |
| `tamanho_empresa` | Tamanho | select | 1-10, 11-50, 51-200, 201+ |
| `industria` | Indústria | select | — |
| `compete_com` | Compete com | text | — |
| `urgencia` | Urgência | select | Imediata, 1 mês, 3 meses, 6+ meses |

### Relacionamentos com módulos satélites

| Field / lead | Conecta com | Padrão |
|-------------|------------|--------|
| Lead | `accounts.lead_id` (módulo billing) | FK rígida ao fechar |
| Lead | `usage_metrics.lead_id` (uso do produto) | denormalizado de evento |
| Lead | `support_tickets.lead_id` | FK rígida |
| `mrr_potencial_cents` | Forecast/board weighted | aritmética |
| Lead | `email_threads.lead_id`, `calls.lead_id` | FK rígida |

### JSON `settings.fields`

```json
{
  "fields": [
    {"key": "mrr_potencial_cents", "label": "MRR potencial", "type": "currency", "show_in_card": true, "show_in_filter": true},
    {"key": "seats", "label": "Nº de assentos", "type": "number"},
    {"key": "plano_alvo", "label": "Plano alvo", "type": "select", "options": ["Starter","Growth","Enterprise"], "show_in_card": true},
    {"key": "integracoes_pedidas", "label": "Integrações pedidas", "type": "multiselect", "options": ["Slack","Salesforce","HubSpot","Zapier","Notion","Linear","GitHub"]},
    {"key": "decisor_role", "label": "Cargo do decisor", "type": "text"},
    {"key": "tamanho_empresa", "label": "Tamanho", "type": "select", "options": ["1-10","11-50","51-200","201-1000","1000+"], "show_in_filter": true},
    {"key": "industria", "label": "Indústria", "type": "select", "options": ["SaaS","FinTech","HealthTech","E-commerce","Serviços","Varejo","Outro"]},
    {"key": "compete_com", "label": "Compete com", "type": "text"},
    {"key": "urgencia", "label": "Urgência", "type": "select", "options": ["Imediata","1 mês","3 meses","6+ meses"]}
  ]
}
```

---

## 9. Escola/educação

**Lead = Aluno · Deal = Matrícula**

### Vocabulário

```json
{
  "lead": "Aluno", "lead_plural": "Alunos",
  "deal": "Matrícula", "deal_plural": "Matrículas",
  "won_label": "Matriculado", "lost_label": "Não matriculou",
  "owner_label": "Coordenador", "title_field": "Matrícula"
}
```

### Fields recomendados

| key | label | type | Notas |
|-----|-------|------|-------|
| `serie` | Série | select | — |
| `turno_preferido` | Turno | select | Matutino, Vespertino, Integral |
| `responsavel_financeiro_nome` | Responsável | text | — |
| `responsavel_financeiro_email` | E-mail responsável | email | — |
| `responsavel_financeiro_telefone` | Tel. responsável | phone | — |
| `bolsa_aplicada` | Bolsa | select | Não, 25%, 50%, 75%, 100% |
| `mensalidade_cents` | Mensalidade | currency | — |
| `valor_matricula_cents` | Valor matrícula | currency | — |
| `status_pagamento_matricula` | Pagamento matrícula | select | Pendente, Parcial, Pago |
| `irmaos_na_escola` | Irmãos na escola | number | — |

### Relacionamentos com módulos satélites

| Field / lead | Conecta com | Padrão |
|-------------|------------|--------|
| Lead | `enrollments.lead_id` | FK rígida ao matricular |
| Lead | `grades.lead_id` (boletim) | denormalizado |
| Lead | `attendance.lead_id` (frequência) | FK rígida |
| `responsavel_financeiro_*` | `contacts.id` (segundo contact = responsável) | reference |
| Lead | `invoices.lead_id` (mensalidades) | FK rígida |

### JSON `settings.fields`

```json
{
  "fields": [
    {"key": "serie", "label": "Série", "type": "select", "options": ["Maternal","Infantil 1","Infantil 2","1º EF","2º EF","3º EF","4º EF","5º EF","6º EF","7º EF","8º EF","9º EF","1º EM","2º EM","3º EM"], "required": true, "show_in_card": true, "show_in_filter": true},
    {"key": "turno_preferido", "label": "Turno", "type": "select", "options": ["Matutino","Vespertino","Integral"], "show_in_card": true},
    {"key": "responsavel_financeiro_nome", "label": "Responsável financeiro", "type": "text", "required": true},
    {"key": "responsavel_financeiro_email", "label": "E-mail responsável", "type": "email"},
    {"key": "responsavel_financeiro_telefone", "label": "Tel. responsável", "type": "phone"},
    {"key": "bolsa_aplicada", "label": "Bolsa", "type": "select", "options": ["Não","25%","50%","75%","100%"]},
    {"key": "mensalidade_cents", "label": "Mensalidade", "type": "currency", "show_in_card": true},
    {"key": "valor_matricula_cents", "label": "Valor matrícula", "type": "currency"},
    {"key": "status_pagamento_matricula", "label": "Pagamento matrícula", "type": "select", "options": ["Pendente","Parcial","Pago"]},
    {"key": "irmaos_na_escola", "label": "Irmãos na escola", "type": "number"}
  ]
}
```

---

## 10. Restaurante / delivery

**Lead = Cliente · Deal = Pedido fidelidade**

### Vocabulário

```json
{
  "lead": "Cliente", "lead_plural": "Clientes",
  "deal": "Pedido", "deal_plural": "Pedidos",
  "won_label": "Cliente recorrente", "lost_label": "Inativo",
  "owner_label": "Atendente", "title_field": "Cliente"
}
```

### Fields recomendados

| key | label | type | Notas |
|-----|-------|------|-------|
| `preferencia_alimentar` | Preferência | multiselect | Vegano, Vegetariano, Sem glúten, ... |
| `pedido_favorito_id` | Pedido favorito | reference | aponta `menu_items.id` |
| `frequencia_dias` | Frequência (dias) | number | denormalizado |
| `ultimo_pedido_em` | Último pedido | date | denormalizado |
| `pontos_fidelidade` | Pontos | number | denormalizado |
| `tier_fidelidade` | Tier | select | Bronze, Prata, Ouro |
| `bairro_entrega` | Bairro entrega | text | — |
| `aniversario` | Aniversário | date | gatilho de promo |
| `valor_medio_pedido_cents` | Ticket médio | currency | denormalizado |
| `forma_pagamento_preferida` | Forma de pagamento | select | Pix, Cartão, Dinheiro, Vale-refeição |

### Relacionamentos com módulos satélites

| Field / lead | Conecta com | Padrão |
|-------------|------------|--------|
| `pedido_favorito_id` | `menu_items.id` (catálogo) | reference |
| Lead | `orders.lead_id` | FK rígida |
| `pontos_fidelidade` | `loyalty_events.lead_id` | aggregate por trigger |
| `aniversario` | Cron de envio promo | scheduled job |
| Lead | `delivery_addresses.lead_id` | FK rígida |

### JSON `settings.fields`

```json
{
  "fields": [
    {"key": "preferencia_alimentar", "label": "Preferência alimentar", "type": "multiselect", "options": ["Vegano","Vegetariano","Sem glúten","Sem lactose","Halal","Kosher"]},
    {"key": "pedido_favorito_id", "label": "Pedido favorito", "type": "reference", "show_in_card": true},
    {"key": "frequencia_dias", "label": "Frequência (dias)", "type": "number", "show_in_card": true},
    {"key": "ultimo_pedido_em", "label": "Último pedido", "type": "date"},
    {"key": "pontos_fidelidade", "label": "Pontos", "type": "number", "show_in_card": true},
    {"key": "tier_fidelidade", "label": "Tier", "type": "select", "options": ["Bronze","Prata","Ouro"], "show_in_filter": true},
    {"key": "bairro_entrega", "label": "Bairro entrega", "type": "text", "show_in_filter": true},
    {"key": "aniversario", "label": "Aniversário", "type": "date"},
    {"key": "valor_medio_pedido_cents", "label": "Ticket médio", "type": "currency"},
    {"key": "forma_pagamento_preferida", "label": "Forma de pagamento", "type": "select", "options": ["Pix","Cartão crédito","Cartão débito","Dinheiro","Vale-refeição"]}
  ]
}
```

---

## Tabela cruzada: nichos × módulos satélites comuns

| Nicho | Calendar | Billing | Documents | Inventário/Catálogo | Externos |
|-------|---------|---------|-----------|---------------------|----------|
| Clínica | sim (consultas) | sim (pagamento) | sim (prontuário) | catálogo de procedimentos | convênios |
| Imobiliária | sim (visitas) | sim (contratos) | sim (escrituras) | imóveis | bancos (financiamento) |
| Advocacia | sim (audiências) | sim (honorários) | sim (petições) | — | tribunais (Datajud) |
| Autoescola | sim (aulas) | sim (parcelas) | sim (DETRAN) | veículos | DETRAN |
| Infoprodutor | sim (lives) | sim (compras) | — | produtos | Hotmart/Kiwify/Eduzz |
| E-commerce | — | sim (orders) | sim (NFs) | catálogo de produtos | gateways pagamento, correios |
| Agência | sim (reuniões) | sim (contratos) | sim (briefings) | serviços | redes sociais |
| SaaS B2B | sim (demos) | sim (subscriptions) | sim (contratos) | — | Stripe, Slack |
| Escola | sim (aulas) | sim (mensalidades) | sim (boletins) | — | sistema de pagamento |
| Restaurante | — (delivery) | sim (orders) | — | menu | iFood, Rappi |

---

## Como adaptar pra um nicho não listado

1. **Mude o vocabulário primeiro.** Pergunte ao cliente: "como você chama um lead aqui? E uma venda? E a pessoa responsável?".
2. **Liste os 5–8 fields críticos.** Não passe disso. Pergunte: "se eu tiver que perguntar 8 coisas pro cliente novo na primeira ligação, quais são?"
3. **Liste os módulos satélites relevantes.** Calendar? Billing? Documents? Algum API externa específica?
4. **Comece sem custom_fields, adicione conforme demanda.** Lançar com 0 fields é melhor que com 30 que ninguém usa.
5. **Promova para coluna real só os 1-2 hot fields.**

---

## Fim
