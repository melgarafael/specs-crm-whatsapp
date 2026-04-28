# 05 — Custom fields por nicho

> **Resumo:** filosofia "jsonb generosamente, depois promove pra coluna se virar query quente". Schema declarativo de fields em `crm_pipelines.settings.fields`, validação Zod construída dinamicamente, UI de form dinâmico, filtros via operador `@>`. 10 nichos cobertos com seus campos canônicos e relacionamentos com módulos satélites.

---

## 1. Filosofia: jsonb primeiro, coluna depois

Toda CRM nichado tem **N campos próprios** ("número do processo" pra advogado, "categoria CNH" pra autoescola, "convênio" pra clínica). Você pode resolver isso de 3 jeitos:

| Abordagem | Vantagem | Desvantagem |
|-----------|---------|-------------|
| Coluna por field (`process_number text`, ...) | Indexável, type-safe | Migração a cada novo campo. Schema vira sopa. |
| Tabela `lead_field_values (lead_id, key, value)` (EAV) | Flexível | Querys medonhas. Performance baixa. |
| **`custom_fields jsonb` + GIN index** | Flexível + performante até 100k+ rows | jsonb tem leve overhead em queries muito específicas |

🎯 **Decisão padrão:** **`custom_fields jsonb`** com índice GIN, **promovendo pra coluna real só quando o field vira query crítica** (filtragem em board com >10k leads, dashboard rodando o tempo todo, etc.).

⚠️ **Gotcha:** jsonb perde ordenação natural. Comparações numéricas (`>`, `<`) em jsonb funcionam, mas você precisa cast explícito: `(custom_fields->>'mrr_cents')::bigint > 100000`.

---

## 2. Schema declarativo de fields

Os fields de cada pipeline ficam em `crm_pipelines.settings.fields` (jsonb array):

```json
{
  "fields": [
    {
      "key": "convenio",
      "label": "Convênio",
      "type": "select",
      "options": ["Particular", "Unimed", "Bradesco", "SulAmérica"],
      "required": false,
      "placeholder": "Selecione o convênio",
      "show_in_card": true,
      "show_in_form": true,
      "show_in_filter": true,
      "group": "Saúde"
    },
    {
      "key": "valor_consulta",
      "label": "Valor da consulta",
      "type": "currency",
      "required": false,
      "show_in_card": true
    }
  ]
}
```

### Tipos suportados (canônicos)

| `type` | Validação Zod | UI |
|--------|--------------|----|
| `text` | `z.string().max(500)` | `<input type="text">` |
| `textarea` | `z.string().max(5000)` | `<textarea>` |
| `number` | `z.number().or(z.string().transform(Number))` | `<input type="number">` |
| `currency` | `z.number().int().nonnegative()` (cents) | `<input type="number">` + máscara |
| `boolean` | `z.boolean()` | `<switch>` ou `<checkbox>` |
| `date` | `z.string().regex(/^\d{4}-\d{2}-\d{2}$/)` | `<input type="date">` |
| `datetime` | `z.string().datetime()` | `<input type="datetime-local">` |
| `select` | `z.enum(options)` | `<select>` |
| `multiselect` | `z.array(z.enum(options))` | `<MultiSelect>` |
| `email` | `z.string().email()` | `<input type="email">` |
| `phone` | `z.string().regex(/^\+?\d{8,15}$/)` | `<input type="tel">` |
| `url` | `z.string().url()` | `<input type="url">` |
| `tags` | `z.array(z.string())` | `<TagInput>` |
| `reference` | `z.string().uuid()` | `<EntityPicker>` (busca em outra tabela) |

⭐ **Relacionamentos potenciais — `crm_pipelines.settings.fields`**

| Aspecto | Conecta com | Padrão |
|--------|------------|--------|
| `key` | Coluna em `crm_leads.custom_fields` (path jsonb) | Convenção snake_case |
| `type=reference` | Outra tabela (ex: `assets.id` em imobiliária) | Soft FK validada na app |
| `type=select.options` | Lista canônica usada por filtros, IA prompts, BI | Texto livre; manter consistência |
| `show_in_card` | UI `<LeadCard>` renderiza | Flag booleana |
| `show_in_filter` | `<BoardFiltersBar>` adiciona controle | Flag booleana |

---

## 3. Construindo o Zod schema dinâmico

📦 **`lib/crm/dynamic-schema.ts`**:

```ts
import { z, ZodTypeAny } from 'zod';

export interface FieldDef {
  key: string;
  label: string;
  type:
    | 'text' | 'textarea' | 'number' | 'currency' | 'boolean'
    | 'date' | 'datetime' | 'select' | 'multiselect'
    | 'email' | 'phone' | 'url' | 'tags' | 'reference';
  required?: boolean;
  options?: string[];
  min?: number;
  max?: number;
  pattern?: string;
  placeholder?: string;
  group?: string;
  show_in_card?: boolean;
  show_in_form?: boolean;
  show_in_filter?: boolean;
}

export function buildFieldSchema(field: FieldDef): ZodTypeAny {
  let schema: ZodTypeAny;

  switch (field.type) {
    case 'text':
      schema = z.string().max(field.max ?? 500);
      break;
    case 'textarea':
      schema = z.string().max(field.max ?? 5000);
      break;
    case 'number':
      schema = z.coerce.number();
      if (field.min != null) schema = (schema as z.ZodNumber).min(field.min);
      if (field.max != null) schema = (schema as z.ZodNumber).max(field.max);
      break;
    case 'currency':
      schema = z.coerce.number().int().nonnegative();
      break;
    case 'boolean':
      schema = z.coerce.boolean();
      break;
    case 'date':
      schema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
      break;
    case 'datetime':
      schema = z.string().datetime();
      break;
    case 'select':
      if (!field.options || field.options.length === 0) {
        schema = z.string();
      } else {
        schema = z.enum(field.options as [string, ...string[]]);
      }
      break;
    case 'multiselect':
      if (!field.options || field.options.length === 0) {
        schema = z.array(z.string());
      } else {
        schema = z.array(z.enum(field.options as [string, ...string[]]));
      }
      break;
    case 'email':
      schema = z.string().email();
      break;
    case 'phone':
      schema = z.string().regex(/^\+?\d{8,15}$/);
      break;
    case 'url':
      schema = z.string().url();
      break;
    case 'tags':
      schema = z.array(z.string());
      break;
    case 'reference':
      schema = z.string().uuid();
      break;
    default:
      schema = z.unknown();
  }

  if (!field.required) schema = schema.optional().nullable();
  return schema;
}

export function buildCustomFieldsSchema(fields: FieldDef[]) {
  const shape: Record<string, ZodTypeAny> = {};
  for (const f of fields) {
    shape[f.key] = buildFieldSchema(f);
  }
  return z.object(shape).partial();
}
```

Uso:

```ts
import { buildCustomFieldsSchema } from '@/lib/crm/dynamic-schema';

const fields = pipeline.settings.fields ?? [];
const schema = buildCustomFieldsSchema(fields);

const result = schema.safeParse({
  convenio: 'Unimed',
  valor_consulta: 35000,   // R$ 350,00
});
```

---

## 4. UI: form dinâmico

📦 **`components/crm/DynamicLeadFields.tsx`**:

```tsx
'use client';

import { Controller, useFormContext } from 'react-hook-form';
import { FieldDef } from '@/lib/crm/dynamic-schema';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';

export function DynamicLeadFields({ fields }: { fields: FieldDef[] }) {
  const { control, formState: { errors } } = useFormContext();

  // Agrupa por `group`
  const groups = fields.reduce((acc, f) => {
    const g = f.group ?? '';
    (acc[g] ??= []).push(f);
    return acc;
  }, {} as Record<string, FieldDef[]>);

  return (
    <div className="space-y-6">
      {Object.entries(groups).map(([groupName, groupFields]) => (
        <div key={groupName} className="space-y-3">
          {groupName && <h4 className="text-sm font-semibold">{groupName}</h4>}
          {groupFields
            .filter((f) => f.show_in_form !== false)
            .map((f) => (
              <FormField key={f.key} field={f} control={control} errors={errors} />
            ))}
        </div>
      ))}
    </div>
  );
}

function FormField({ field, control, errors }: { field: FieldDef; control: any; errors: any }) {
  const fieldName = `custom_fields.${field.key}`;
  const error = (errors.custom_fields as any)?.[field.key];

  return (
    <div className="space-y-1.5">
      <Label htmlFor={fieldName}>
        {field.label}
        {field.required && <span className="text-destructive ml-1">*</span>}
      </Label>
      <Controller
        name={fieldName}
        control={control}
        render={({ field: f }) => {
          switch (field.type) {
            case 'textarea':
              return <Textarea {...f} placeholder={field.placeholder} />;
            case 'boolean':
              return <Switch checked={!!f.value} onCheckedChange={f.onChange} />;
            case 'select':
              return (
                <Select value={f.value ?? ''} onValueChange={f.onChange}>
                  <SelectTrigger>
                    <SelectValue placeholder={field.placeholder ?? 'Selecione...'} />
                  </SelectTrigger>
                  <SelectContent>
                    {(field.options ?? []).map((o) => (
                      <SelectItem key={o} value={o}>{o}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              );
            case 'multiselect':
              return <MultiSelect value={f.value ?? []} onChange={f.onChange} options={field.options ?? []} />;
            case 'currency':
              return (
                <Input
                  type="number"
                  step="0.01"
                  placeholder={field.placeholder}
                  value={f.value ? f.value / 100 : ''}
                  onChange={(e) => f.onChange(Math.round(Number(e.target.value) * 100))}
                />
              );
            case 'number':
              return <Input type="number" {...f} placeholder={field.placeholder} />;
            case 'date':
              return <Input type="date" {...f} />;
            case 'datetime':
              return <Input type="datetime-local" {...f} />;
            case 'email':
              return <Input type="email" {...f} placeholder={field.placeholder} />;
            case 'phone':
              return <Input type="tel" {...f} placeholder={field.placeholder} />;
            case 'url':
              return <Input type="url" {...f} placeholder={field.placeholder} />;
            default:
              return <Input {...f} placeholder={field.placeholder} />;
          }
        }}
      />
      {error && <p className="text-xs text-destructive">{error.message}</p>}
    </div>
  );
}

function MultiSelect({ value, onChange, options }: { value: string[]; onChange: (v: string[]) => void; options: string[] }) {
  // Implementação simples; em produção use shadcn-multi-select ou Radix combobox
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const selected = value.includes(o);
        return (
          <button
            type="button"
            key={o}
            onClick={() =>
              onChange(selected ? value.filter((v) => v !== o) : [...value, o])
            }
            className={`rounded-full border px-2.5 py-0.5 text-xs ${
              selected ? 'border-primary bg-primary/10 text-primary' : 'border-border'
            }`}
          >
            {o}
          </button>
        );
      })}
    </div>
  );
}
```

---

## 5. Filtros sobre custom fields

Postgres jsonb tem o operador `@>` (contains) que é perfeito pra isso:

```sql
select * from crm_leads
where pipeline_id = '...'
  and custom_fields @> '{"convenio": "Unimed"}'::jsonb;
```

Em Supabase JS:

```ts
const { data } = await supa
  .from('crm_leads')
  .select('*')
  .eq('pipeline_id', pipelineId)
  .contains('custom_fields', { convenio: 'Unimed' });
```

Para faixas numéricas:

```ts
const { data } = await supa
  .from('crm_leads')
  .select('*')
  .eq('pipeline_id', pipelineId)
  .gte('custom_fields->>valor_consulta', '30000')   // attention: precisa cast
  .lte('custom_fields->>valor_consulta', '50000');
```

⚠️ **Gotcha:** comparações de range em jsonb perdem o GIN index — caem em sequential scan. Se virar query quente, **promova o campo pra coluna real** (com BTREE).

📦 **Promoção de field jsonb pra coluna:**

```sql
-- Adiciona coluna gerada (computed) que extrai o valor
alter table public.crm_leads
  add column if not exists generated_mrr_cents bigint
  generated always as ((custom_fields->>'mrr_cents')::bigint) stored;

create index if not exists idx_crm_leads_mrr
  on public.crm_leads (generated_mrr_cents)
  where generated_mrr_cents is not null;
```

🎯 **Decisão:** colunas geradas (`generated always as ... stored`) são lindas porque você não precisa migrar dados — só adicionar a coluna e o índice. A app continua escrevendo em `custom_fields`.

---

## 6. Os 10 nichos canônicos

Cada nicho a seguir traz:
- Vocabulário do `crm_pipelines.vocabulary`
- Lista de fields recomendados
- ⭐ **Relacionamentos com módulos satélites** (qual entidade externa o lead toca)
- JSON exemplo de `crm_pipelines.settings.fields`

### 6.1 Clínica médica

**Vocabulário:**
```json
{
  "lead": "Paciente", "lead_plural": "Pacientes",
  "deal": "Atendimento", "won_label": "Realizado", "lost_label": "Cancelado",
  "owner_label": "Médico responsável", "title_field": "Motivo do atendimento"
}
```

**Fields:**

| `key` | `label` | `type` | Notas |
|-------|--------|--------|-------|
| `convenio` | Convênio | `select` | Lista de convênios da clínica |
| `numero_carteirinha` | Carteirinha | `text` | Quando convênio != Particular |
| `alergias` | Alergias | `textarea` | Critical pra atendimento |
| `medico_responsavel_id` | Médico responsável | `reference` | aponta pra `professionals.id` |
| `tipo_tratamento` | Tipo | `select` | Consulta, Retorno, Procedimento, Exame |
| `valor_consulta` | Valor (R$) | `currency` | — |
| `ultimo_atendimento_em` | Último atendimento | `date` | Pode ser denormalizado de `appointments` |
| `procedencia` | Como conheceu | `select` | Indicação, Convênio, Google, Instagram |

⭐ **Relacionamentos com módulos satélites:**

| Field / lead | Conecta com | Padrão |
|-------------|------------|--------|
| `medico_responsavel_id` | `professionals.id` (módulo equipe) | reference + soft FK |
| Lead inteiro | `appointments.lead_id` (módulo calendar/agendamentos) | FK rígida |
| Lead inteiro | `prescriptions.lead_id` (módulo prescrições) | FK rígida |
| Lead inteiro | `lab_results.lead_id` (módulo exames) | FK rígida |
| `crm_lead_links target_kind='conversation'` | `conversations` (chat WhatsApp) | polimórfico |
| `crm_lead_links target_kind='invoice'` | `invoices` (financeiro) | polimórfico |

### 6.2 Imobiliária

**Vocabulário:**
```json
{
  "lead": "Lead", "deal": "Imóvel/Contrato",
  "won_label": "Fechado", "lost_label": "Sem interesse",
  "owner_label": "Corretor"
}
```

**Fields:**

| `key` | `label` | `type` | Notas |
|-------|--------|--------|-------|
| `tipo_negociacao` | Compra ou aluguel | `select` | Compra, Aluguel, Temporada |
| `tipo_imovel` | Tipo de imóvel | `select` | Apartamento, Casa, Comercial, Terreno |
| `faixa_preco_min_cents` | Preço mín (R$) | `currency` | — |
| `faixa_preco_max_cents` | Preço máx (R$) | `currency` | — |
| `regiao_interesse` | Região | `multiselect` | Bairros / zonas |
| `metragem_min` | Metragem mín (m²) | `number` | — |
| `quartos_min` | Quartos | `number` | — |
| `precisa_financiamento` | Financia? | `boolean` | — |
| `imovel_principal_id` | Imóvel de interesse | `reference` | aponta `assets.id` |

⭐ **Relacionamentos com módulos satélites:**

| Field / lead | Conecta com | Padrão |
|-------------|------------|--------|
| `imovel_principal_id` | `assets.id` (catálogo de imóveis) | reference + soft FK |
| Lead | `assets_visits.lead_id` (visitas agendadas) | FK rígida |
| Lead | `appointments.lead_id` (calendar — visita) | FK rígida |
| Lead | `contracts.lead_id` (contratos) | FK rígida |

### 6.3 Advocacia

**Vocabulário:**
```json
{
  "lead": "Cliente", "deal": "Caso",
  "won_label": "Ganho", "lost_label": "Encerrado",
  "owner_label": "Advogado responsável"
}
```

**Fields:**

| `key` | `label` | `type` | Notas |
|-------|--------|--------|-------|
| `area_direito` | Área | `select` | Trabalhista, Civil, Criminal, Família, Empresarial |
| `numero_processo` | Nº do processo | `text` | Format CNJ |
| `comarca` | Comarca | `text` | — |
| `valor_causa_cents` | Valor da causa | `currency` | — |
| `prazo_proxima_acao` | Próximo prazo | `date` | Vai pra calendar |
| `tipo_honorarios` | Honorários | `select` | Êxito, Fixo, Misto |
| `parte_contraria` | Parte contrária | `text` | — |
| `instancia` | Instância | `select` | 1ª, 2ª, STJ, STF |

⭐ **Relacionamentos com módulos satélites:**

| Field / lead | Conecta com | Padrão |
|-------------|------------|--------|
| `numero_processo` | API tribunal externa (Datajud, Escavador) | webhook/scrape |
| `prazo_proxima_acao` | `appointments` (agenda processual) | derivação automática |
| Lead | `documents.lead_id` (petições, contratos, decisões) | FK rígida |
| `area_direito` | Routing pra time específico | `automation_config` |

### 6.4 Autoescola

**Vocabulário:**
```json
{
  "lead": "Aluno", "deal": "Pacote",
  "won_label": "Habilitado", "lost_label": "Desistiu",
  "owner_label": "Instrutor"
}
```

**Fields:**

| `key` | `label` | `type` | Notas |
|-------|--------|--------|-------|
| `categoria_cnh` | Categoria | `select` | A, B, AB, C, D, E |
| `etapa_processo` | Etapa atual | `select` | LADV, PPD, CNH definitiva |
| `aulas_teoricas_total` | Aulas teóricas | `number` | — |
| `aulas_teoricas_feitas` | Aulas teóricas feitas | `number` | — |
| `aulas_praticas_total` | Aulas práticas | `number` | — |
| `aulas_praticas_feitas` | Aulas práticas feitas | `number` | — |
| `instrutor_id` | Instrutor | `reference` | aponta `professionals.id` |
| `veiculo_preferido` | Veículo | `select` | Carro, Moto |
| `data_prova_teorica` | Prova teórica | `date` | — |
| `data_prova_pratica` | Prova prática | `date` | — |

⭐ **Relacionamentos com módulos satélites:**

| Field / lead | Conecta com | Padrão |
|-------------|------------|--------|
| `instrutor_id` | `professionals.id` | reference |
| Lead | `appointments` (aulas agendadas) | FK rígida |
| Lead | `invoices.lead_id` (parcelamento do pacote) | FK rígida |
| `data_prova_*` | `appointments` calendar | derivação |

### 6.5 Infoprodutor (lançamento)

**Vocabulário:**
```json
{
  "lead": "Lead", "deal": "Compra",
  "won_label": "Comprou", "lost_label": "Não comprou",
  "owner_label": "Closer"
}
```

**Fields:**

| `key` | `label` | `type` | Notas |
|-------|--------|--------|-------|
| `produto_interesse` | Produto | `select` | Lista de produtos |
| `fonte_campanha` | Campanha | `text` | UTM source/medium |
| `utm_term` | UTM term | `text` | — |
| `faturamento_estimado_cents` | Faturamento estimado | `currency` | — |
| `fase_funil` | Fase | `select` | Captação, Aquecimento, Webinar, Carrinho aberto, Carrinho fechado |
| `assistiu_evento` | Assistiu evento? | `boolean` | — |
| `tempo_assistido_minutos` | Tempo assistido (min) | `number` | — |
| `clicou_carrinho` | Clicou checkout? | `boolean` | — |

⭐ **Relacionamentos com módulos satélites:**

| Field / lead | Conecta com | Padrão |
|-------------|------------|--------|
| `produto_interesse` | Plataforma externa (Hotmart/Kiwify/Eduzz) | API/webhook |
| `assistiu_evento`, `tempo_assistido_minutos` | Plataforma de live (StreamYard, etc.) | webhook |
| Lead | `purchases.lead_id` (orders/checkouts) | FK rígida |
| `fonte_campanha` | Tabela `campaigns` (BI) | denormalizado |

### 6.6 E-commerce

**Vocabulário:**
```json
{
  "lead": "Cliente", "deal": "Pedido",
  "won_label": "Pago", "lost_label": "Cancelado",
  "owner_label": "Atendente"
}
```

**Fields:**

| `key` | `label` | `type` | Notas |
|-------|--------|--------|-------|
| `ltv_cents` | LTV | `currency` | denormalizado de orders |
| `ultimo_pedido_em` | Último pedido | `date` | denormalizado |
| `tickets_abertos` | Tickets abertos | `number` | denormalizado |
| `programa_fidelidade` | Tier fidelidade | `select` | Bronze, Prata, Ouro, Diamante |
| `nps_score` | NPS | `number` | 0–10 |
| `categoria_preferida` | Categoria | `multiselect` | Lista de categorias |
| `cep_principal` | CEP | `text` | — |
| `frequencia_compra_dias` | Freq. de compra (dias) | `number` | — |

⭐ **Relacionamentos com módulos satélites:**

| Field / lead | Conecta com | Padrão |
|-------------|------------|--------|
| Lead | `orders.lead_id` ou `orders.contact_id` | FK rígida |
| `ltv_cents` | view/MV de `orders` | denormalizado por job |
| `tickets_abertos` | `tickets` (suporte) | denormalizado por trigger |
| `nps_score` | `nps_responses.lead_id` | denormalizado do mais recente |
| Lead | `cart_abandonment_events.lead_id` | FK rígida |

### 6.7 Agência de marketing

**Vocabulário:**
```json
{
  "lead": "Prospect", "deal": "Projeto",
  "won_label": "Contratou", "lost_label": "Não fechou",
  "owner_label": "Account"
}
```

**Fields:**

| `key` | `label` | `type` | Notas |
|-------|--------|--------|-------|
| `budget_mensal_cents` | Budget mensal | `currency` | — |
| `redes_ativas` | Redes ativas | `multiselect` | Instagram, TikTok, YouTube, LinkedIn, FB, X |
| `crm_atual` | CRM atual | `text` | "RD Station", "HubSpot", "nenhum" |
| `dor_principal` | Dor principal | `textarea` | — |
| `numero_funcionarios` | Funcionários | `number` | — |
| `setor` | Setor | `select` | — |
| `prazo_contrato_meses` | Prazo (meses) | `number` | — |
| `decisor_email` | E-mail do decisor | `email` | — |

⭐ **Relacionamentos com módulos satélites:**

| Field / lead | Conecta com | Padrão |
|-------------|------------|--------|
| Lead | `contracts.lead_id` | FK rígida |
| Lead | `proposals.lead_id` | FK rígida |
| Lead | `email_threads.lead_id` (módulo e-mail) | FK rígida |
| `decisor_email` | identificação cross-channel (mesma pessoa em diferentes canais) | merge logic |

### 6.8 SaaS B2B

**Vocabulário:**
```json
{
  "lead": "Lead", "deal": "Conta",
  "won_label": "Cliente", "lost_label": "Lost",
  "owner_label": "AE/SDR"
}
```

**Fields:**

| `key` | `label` | `type` | Notas |
|-------|--------|--------|-------|
| `mrr_potencial_cents` | MRR potencial | `currency` | — |
| `seats` | Nº de assentos | `number` | — |
| `plano_alvo` | Plano alvo | `select` | Starter, Growth, Enterprise |
| `integracoes_pedidas` | Integrações pedidas | `multiselect` | Slack, Salesforce, HubSpot, etc. |
| `decisor_role` | Cargo do decisor | `text` | CEO, CTO, COO, VP Sales |
| `tamanho_empresa` | Tamanho | `select` | 1-10, 11-50, 51-200, 201+ |
| `industria` | Indústria | `select` | — |
| `compete_com` | Compete com | `text` | Concorrente atual |

⭐ **Relacionamentos com módulos satélites:**

| Field / lead | Conecta com | Padrão |
|-------------|------------|--------|
| Lead | `accounts.lead_id` (módulo billing) | FK rígida ao fechar |
| Lead | `usage_metrics.lead_id` (uso do produto) | denormalizado de evento |
| Lead | `support_tickets.lead_id` | FK rígida |
| `mrr_potencial_cents` | Forecast/board weighted | aritmética |

### 6.9 Escola/educação

**Vocabulário:**
```json
{
  "lead": "Aluno", "deal": "Matrícula",
  "won_label": "Matriculado", "lost_label": "Não matriculou",
  "owner_label": "Coordenador"
}
```

**Fields:**

| `key` | `label` | `type` | Notas |
|-------|--------|--------|-------|
| `serie` | Série | `select` | 1º ano EF, ..., 3º ano EM |
| `turno_preferido` | Turno | `select` | Matutino, Vespertino, Integral |
| `responsavel_financeiro_nome` | Responsável | `text` | — |
| `responsavel_financeiro_email` | E-mail responsável | `email` | — |
| `responsavel_financeiro_telefone` | Tel. responsável | `phone` | — |
| `bolsa_aplicada` | Bolsa | `select` | Não, 25%, 50%, 75%, 100% |
| `mensalidade_cents` | Mensalidade | `currency` | — |
| `status_pagamento_matricula` | Pagamento matrícula | `select` | Pendente, Parcial, Pago |

⭐ **Relacionamentos com módulos satélites:**

| Field / lead | Conecta com | Padrão |
|-------------|------------|--------|
| Lead | `enrollments.lead_id` | FK rígida ao matricular |
| Lead | `grades.lead_id` (boletim) | denormalizado |
| Lead | `attendance.lead_id` (frequência) | FK rígida |
| `responsavel_financeiro_*` | `contacts.id` (segundo contact = responsável) | reference |

### 6.10 Restaurante / delivery

**Vocabulário:**
```json
{
  "lead": "Cliente", "deal": "Pedido fidelidade",
  "won_label": "Cliente recorrente", "lost_label": "Inativo",
  "owner_label": "Atendente"
}
```

**Fields:**

| `key` | `label` | `type` | Notas |
|-------|--------|--------|-------|
| `preferencia_alimentar` | Preferência | `multiselect` | Vegano, Vegetariano, Sem glúten, Sem lactose |
| `pedido_favorito_id` | Pedido favorito | `reference` | aponta `menu_items.id` |
| `frequencia_dias` | Frequência (dias) | `number` | denormalizado |
| `ultimo_pedido_em` | Último pedido | `date` | denormalizado |
| `pontos_fidelidade` | Pontos | `number` | denormalizado |
| `tier_fidelidade` | Tier | `select` | Bronze, Prata, Ouro |
| `bairro_entrega` | Bairro entrega | `text` | — |
| `aniversario` | Aniversário | `date` | gatilho de promo |

⭐ **Relacionamentos com módulos satélites:**

| Field / lead | Conecta com | Padrão |
|-------------|------------|--------|
| `pedido_favorito_id` | `menu_items.id` (catálogo) | reference |
| Lead | `orders.lead_id` | FK rígida |
| `pontos_fidelidade` | `loyalty_events.lead_id` | aggregate por trigger |
| `aniversario` | Cron de envio promo | scheduled job |

---

## 7. JSON exemplo completo (settings.fields)

Cole esse no `crm_pipelines.settings` da pipeline default da clínica:

```json
{
  "fields": [
    {
      "key": "convenio",
      "label": "Convênio",
      "type": "select",
      "options": ["Particular", "Unimed", "Bradesco Saúde", "SulAmérica", "Amil", "Hapvida", "Outro"],
      "required": true,
      "show_in_card": true,
      "show_in_filter": true,
      "group": "Saúde"
    },
    {
      "key": "numero_carteirinha",
      "label": "Carteirinha",
      "type": "text",
      "show_in_form": true,
      "group": "Saúde"
    },
    {
      "key": "alergias",
      "label": "Alergias / restrições",
      "type": "textarea",
      "show_in_form": true,
      "group": "Saúde"
    },
    {
      "key": "medico_responsavel_id",
      "label": "Médico responsável",
      "type": "reference",
      "show_in_card": true,
      "show_in_filter": true,
      "group": "Atendimento"
    },
    {
      "key": "tipo_tratamento",
      "label": "Tipo de atendimento",
      "type": "select",
      "options": ["Consulta", "Retorno", "Procedimento", "Exame"],
      "show_in_card": true,
      "show_in_filter": true,
      "group": "Atendimento"
    },
    {
      "key": "valor_consulta",
      "label": "Valor (R$)",
      "type": "currency",
      "show_in_card": true,
      "group": "Financeiro"
    },
    {
      "key": "ultimo_atendimento_em",
      "label": "Último atendimento",
      "type": "date",
      "group": "Atendimento"
    },
    {
      "key": "procedencia",
      "label": "Como conheceu",
      "type": "select",
      "options": ["Indicação", "Convênio", "Google", "Instagram", "Outro"],
      "show_in_filter": true,
      "group": "Origem"
    }
  ]
}
```

---

## 8. Render no `<LeadCard>` apenas dos `show_in_card: true`

```tsx
// dentro de LeadCard.tsx
const cardFields = (pipeline.settings?.fields ?? []).filter((f: any) => f.show_in_card);

{cardFields.map((f) => {
  const value = lead.custom_fields?.[f.key];
  if (value == null || value === '') return null;
  return (
    <div key={f.key} className="flex items-center gap-1 text-[11px] text-muted-foreground">
      <span className="font-medium">{f.label}:</span>
      <span>{formatFieldValue(f, value)}</span>
    </div>
  );
})}
```

---

## 9. Filtro genérico no `<BoardFiltersBar>` (custom field selecionado)

```tsx
// Para cada field com show_in_filter, renderiza controle equivalente
{filterableFields.map((f) => (
  <CustomFieldFilter
    key={f.key}
    field={f}
    value={filters.customFields?.[f.key]}
    onChange={(value) => onChange({
      ...filters,
      customFields: { ...filters.customFields, [f.key]: value }
    })}
  />
))}
```

E na query (`useBoard`):

```ts
if (filters.customFields) {
  const filterJson: Record<string, any> = {};
  for (const [k, v] of Object.entries(filters.customFields)) {
    if (v != null && v !== '') filterJson[k] = v;
  }
  if (Object.keys(filterJson).length > 0) {
    q = q.contains('custom_fields', filterJson);
  }
}
```

---

## 10. Migração: trocar field type sem perder dados

Cenário: você tinha `valor_consulta` como `text`, quer migrar pra `currency` (number em centavos).

```sql
-- Backfill: converte string "R$ 350,00" pra inteiro 35000
update public.crm_leads
set custom_fields = jsonb_set(
  custom_fields,
  '{valor_consulta}',
  to_jsonb(
    (regexp_replace(custom_fields->>'valor_consulta', '[^0-9]', '', 'g')::bigint)
  )
)
where custom_fields ? 'valor_consulta'
  and jsonb_typeof(custom_fields->'valor_consulta') = 'string';
```

⚠️ **Gotcha:** sempre **rode SELECT primeiro** com a expressão antes do UPDATE. Erros de regex ou cast em jsonb são silenciosos e podem corromper dados.

---

## 11. Checklist de implementação

- [ ] `crm_pipelines.settings.fields` documentado por pipeline
- [ ] `buildCustomFieldsSchema(fields)` retorna Zod válido
- [ ] `<DynamicLeadFields>` renderiza form pelo schema
- [ ] Campo `currency` tem máscara/conversão centavos
- [ ] `<LeadCard>` exibe só `show_in_card`
- [ ] `<BoardFiltersBar>` exibe só `show_in_filter`
- [ ] Filtros usam `.contains()` em jsonb
- [ ] Para field hot, há **coluna gerada** `generated always as (...) stored` + index
- [ ] Pelo menos 1 nicho seedado (vendas) ao criar org
- [ ] Lista de nichos pré-fabricados disponível em UI ("clonar pipeline de Clínica")

---

## Próximo: [06-data-relationship-doctrine.md](06-data-relationship-doctrine.md)
