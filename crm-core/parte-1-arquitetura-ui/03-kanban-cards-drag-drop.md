# 03 — Kanban: cards, drag & drop, fractional indexing, realtime

> **Resumo:** UI completa do board kanban — `<PipelineBoard>`, `<StageColumn>`, `<LeadCard>`, drag-and-drop com `@hello-pangea/dnd`, ordenação por **fractional indexing** (não por `position int`), sincronização Realtime, filtros laterais, WIP limits visuais, empty states. TypeScript pronto pra colar.

---

## 1. Decisão crítica: fractional indexing > `position int`

Antes de qualquer JSX, escolha como ordenar leads dentro da stage. Esta decisão muda tudo.

### Abordagem ingênua (não use): `position int`

```sql
crm_leads ( ..., position int );
-- Ao mover lead para o meio da lista: UPDATE em todos os leads abaixo (++)
```

| Problema | Impacto |
|----------|--------|
| Mover 1 card → UPDATE em N cards | O(N) writes por drag |
| 2 usuários movem ao mesmo tempo | Race condition; posições conflitam |
| Realtime dispara 50 events em cascata | UI fica "saltando" |
| Em stage com 200 leads → 200 UPDATEs | Latência inaceitável |

### Abordagem correta: fractional indexing

`position_in_stage numeric` (precisão arbitrária). Posição = qualquer racional entre o vizinho de cima e o de baixo.

```
Stage com 3 leads:
  Lead A: position_in_stage = 1.0
  Lead B: position_in_stage = 2.0
  Lead C: position_in_stage = 3.0

Mover novo Lead X entre A e B:
  Lead X: position_in_stage = 1.5    ← UM único INSERT/UPDATE

Mover Lead D entre A e X:
  Lead D: position_in_stage = 1.25   ← entre 1.0 e 1.5

Mover Lead E entre A e D:
  Lead E: position_in_stage = 1.125
```

🎯 **Decisão:** use `numeric` no Postgres (precisão alta), e na app calcule **midpoint** entre vizinhos. Custo: O(1) por mover. Sem cascata. Sem race em queries de leitura.

### Quando rebalancear

Se a chave fica muito longa (ex: 10 casas decimais após muitos inserts no mesmo intervalo), faça um **rebalance batch** ocasional: `UPDATE` todos os leads da stage com `1.0, 2.0, 3.0, ...`. Cron diário ou trigger ao detectar `precision > 8`.

📦 **`lib/crm/fractional-position.ts`**:

```ts
/**
 * Calcula um "position_in_stage" entre dois vizinhos.
 *
 * Use:
 *   const pos = midpoint(prevPos, nextPos);
 *
 * @param prev posição do vizinho de cima (null se está no topo)
 * @param next posição do vizinho de baixo (null se está no fim)
 * @returns nova posição (number)
 */
export function midpoint(prev: number | null, next: number | null): number {
  if (prev == null && next == null) return 1.0;
  if (prev == null) return (next as number) / 2;
  if (next == null) return prev + 1.0;
  return (prev + next) / 2;
}

/**
 * Detecta se rebalance é recomendado (precisão excessiva).
 * Use pra agendar batch fix.
 */
export function needsRebalance(positions: number[]): boolean {
  for (const p of positions) {
    if (p.toString().includes('e-')) return true;       // notação científica = muito pequeno
    const decimals = (p.toString().split('.')[1] ?? '').length;
    if (decimals > 10) return true;
  }
  return false;
}
```

⚠️ **Gotcha:** se você tentar usar `bigint` ou `int` aqui, vai bater no limite de precisão em ~30 movimentos. Use **numeric** no DB e **number** (float64) na app — chega em ~50 níveis de precisão antes de precisar rebalancear.

---

## 2. Estrutura de componentes

```
<PipelineBoard pipelineId>
   ├── <BoardHeader />                    (vocab + count + filtros)
   ├── <BoardFilters />                   (assignee, source, value range, date)
   └── <DragDropContext onDragEnd={...}>
         ├── <StageColumn stage={s1}>
         │     ├── <ColumnHeader />       (nome, count, soma de valores, WIP)
         │     └── <Droppable>
         │           ├── <Draggable>
         │           │     └── <LeadCard />
         │           ├── <Draggable>
         │           │     └── <LeadCard />
         │           └── ...
         ├── <StageColumn stage={s2}> ...
         └── <StageColumn stage={s3}> ...
```

---

## 3. Hook de dados: `useBoard`

📦 **`hooks/useBoard.ts`**:

```ts
'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import type { RealtimeChannel } from '@supabase/supabase-js';

export interface Stage {
  id: string;
  pipeline_id: string;
  name: string;
  position: number;
  is_won: boolean;
  is_lost: boolean;
  color: string | null;
  win_probability: number | null;
  wip_limit: number | null;
}

export interface Lead {
  id: string;
  pipeline_id: string;
  stage_id: string;
  contact_id: string | null;
  title: string;
  value_cents: number;
  currency: string;
  status: 'open' | 'won' | 'lost';
  owner_user_id: string | null;
  source: string | null;
  tags: string[];
  position_in_stage: number;
  last_activity_at: string | null;
  created_at: string;
  // join de contact
  contact_name?: string | null;
  contact_avatar_url?: string | null;
}

export interface BoardFilters {
  ownerUserId?: string | null;
  source?: string | null;
  search?: string;
  minValue?: number;
  maxValue?: number;
  fromDate?: string;
  toDate?: string;
  tags?: string[];
}

export function useBoard(pipelineId: string, filters: BoardFilters = {}) {
  const [stages, setStages] = useState<Stage[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const channelRef = useRef<RealtimeChannel | null>(null);

  const load = useCallback(async () => {
    const supa = getSupabaseBrowserClient();
    setLoading(true);

    const { data: stagesData } = await supa
      .from('crm_stages')
      .select('*')
      .eq('pipeline_id', pipelineId)
      .order('position');

    let q = supa
      .from('crm_leads')
      .select(`
        id, pipeline_id, stage_id, contact_id, title, value_cents, currency,
        status, owner_user_id, source, tags, position_in_stage,
        last_activity_at, created_at,
        contact:contacts ( full_name, push_name, profile_picture_url )
      `)
      .eq('pipeline_id', pipelineId)
      .eq('status', 'open')
      .order('position_in_stage', { ascending: true });

    if (filters.ownerUserId) q = q.eq('owner_user_id', filters.ownerUserId);
    if (filters.source) q = q.eq('source', filters.source);
    if (filters.minValue != null) q = q.gte('value_cents', filters.minValue);
    if (filters.maxValue != null) q = q.lte('value_cents', filters.maxValue);
    if (filters.fromDate) q = q.gte('created_at', filters.fromDate);
    if (filters.toDate) q = q.lte('created_at', filters.toDate);
    if (filters.tags && filters.tags.length > 0) q = q.contains('tags', filters.tags);
    if (filters.search) q = q.ilike('title', `%${filters.search}%`);

    const { data: leadsData } = await q;

    setStages(stagesData ?? []);
    setLeads(
      (leadsData ?? []).map((l: any) => ({
        ...l,
        contact_name: l.contact?.full_name ?? l.contact?.push_name ?? null,
        contact_avatar_url: l.contact?.profile_picture_url ?? null,
      })),
    );
    setLoading(false);
  }, [pipelineId, JSON.stringify(filters)]);

  // Carga inicial + reload em mudança de filtros
  useEffect(() => {
    load();
  }, [load]);

  // Realtime
  useEffect(() => {
    const supa = getSupabaseBrowserClient();
    if (channelRef.current) {
      supa.removeChannel(channelRef.current);
    }
    const ch = supa
      .channel(`board-${pipelineId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'crm_leads', filter: `pipeline_id=eq.${pipelineId}` },
        () => { load(); },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'crm_stages', filter: `pipeline_id=eq.${pipelineId}` },
        () => { load(); },
      )
      .subscribe();
    channelRef.current = ch;

    return () => { supa.removeChannel(ch); };
  }, [pipelineId, load]);

  return { stages, leads, loading, reload: load, setLeads };
}
```

⚠️ **Gotcha:** o `load()` em `useCallback` depende de `JSON.stringify(filters)` pra evitar recriação a cada render. Sem isso, o `useEffect` entra em loop.

---

## 4. Optimistic UI no drag end

📦 **`components/crm/PipelineBoard.tsx`**:

```tsx
'use client';

import { useState, useMemo, useCallback } from 'react';
import { DragDropContext, Droppable, Draggable, DropResult } from '@hello-pangea/dnd';
import { useBoard, BoardFilters, Lead, Stage } from '@/hooks/useBoard';
import { midpoint } from '@/lib/crm/fractional-position';
import { StageColumn } from './StageColumn';
import { LeadCard } from './LeadCard';
import { BoardFiltersBar } from './BoardFiltersBar';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { toast } from 'sonner';

export function PipelineBoard({ pipelineId }: { pipelineId: string }) {
  const [filters, setFilters] = useState<BoardFilters>({});
  const { stages, leads, loading, setLeads, reload } = useBoard(pipelineId, filters);

  // Indexa leads por stage para passagem aos columns
  const leadsByStage = useMemo(() => {
    const map = new Map<string, Lead[]>();
    for (const s of stages) map.set(s.id, []);
    for (const l of leads) {
      const arr = map.get(l.stage_id);
      if (arr) arr.push(l);
    }
    // Já vêm ordenados por position_in_stage ASC
    return map;
  }, [leads, stages]);

  const onDragEnd = useCallback(async (result: DropResult) => {
    const { source, destination, draggableId } = result;
    if (!destination) return;
    if (
      source.droppableId === destination.droppableId &&
      source.index === destination.index
    ) return;

    const sourceStageId = source.droppableId;
    const destStageId = destination.droppableId;

    const sourceList = leadsByStage.get(sourceStageId) ?? [];
    const destList =
      sourceStageId === destStageId
        ? sourceList
        : (leadsByStage.get(destStageId) ?? []);

    const moved = sourceList.find((l) => l.id === draggableId);
    if (!moved) return;

    // Calcula nova posição via midpoint
    const targetIndex = destination.index;
    let prev: number | null = null;
    let next: number | null = null;

    // Lista destino sem o item movido
    const filteredDest = destList.filter((l) => l.id !== draggableId);
    if (targetIndex > 0) prev = filteredDest[targetIndex - 1]?.position_in_stage ?? null;
    if (targetIndex < filteredDest.length) next = filteredDest[targetIndex]?.position_in_stage ?? null;

    const newPos = midpoint(prev, next);

    // Optimistic update
    setLeads((prevLeads) =>
      prevLeads.map((l) =>
        l.id === draggableId
          ? { ...l, stage_id: destStageId, position_in_stage: newPos }
          : l,
      ),
    );

    // Persiste
    const supa = getSupabaseBrowserClient();
    const { error } = await supa
      .from('crm_leads')
      .update({
        stage_id: destStageId,
        position_in_stage: newPos,
        updated_at: new Date().toISOString(),
      })
      .eq('id', draggableId);

    if (error) {
      toast.error('Não foi possível mover. Tentando novamente...');
      reload();
    }
  }, [leadsByStage, setLeads, reload]);

  if (loading && stages.length === 0) {
    return <BoardSkeleton />;
  }

  if (stages.length === 0) {
    return <BoardEmptyState pipelineId={pipelineId} />;
  }

  return (
    <div className="flex h-full flex-col">
      <BoardFiltersBar filters={filters} onChange={setFilters} pipelineId={pipelineId} />
      <DragDropContext onDragEnd={onDragEnd}>
        <div className="flex flex-1 gap-3 overflow-x-auto p-3">
          {stages.map((stage) => (
            <StageColumn
              key={stage.id}
              stage={stage}
              leads={leadsByStage.get(stage.id) ?? []}
            />
          ))}
        </div>
      </DragDropContext>
    </div>
  );
}

function BoardSkeleton() {
  return (
    <div className="flex gap-3 p-3">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex w-72 flex-col gap-2 rounded-md border bg-muted/30 p-2 animate-pulse">
          <div className="h-6 rounded bg-muted" />
          <div className="h-20 rounded bg-muted" />
          <div className="h-20 rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

function BoardEmptyState({ pipelineId }: { pipelineId: string }) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-md text-center space-y-3">
        <h3 className="text-lg font-semibold">Pipeline sem etapas</h3>
        <p className="text-sm text-muted-foreground">
          Crie ao menos uma etapa para começar a usar o funil.
        </p>
        <a
          href={`/crm/pipelines/${pipelineId}/edit`}
          className="inline-flex items-center rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground"
        >
          Configurar etapas
        </a>
      </div>
    </div>
  );
}
```

---

## 5. `<StageColumn>` com header rico e WIP visual

📦 **`components/crm/StageColumn.tsx`**:

```tsx
'use client';

import { Droppable, Draggable } from '@hello-pangea/dnd';
import { Stage, Lead } from '@/hooks/useBoard';
import { LeadCard } from './LeadCard';
import { cn } from '@/lib/utils';
import { Plus, Trophy, X } from 'lucide-react';

interface Props {
  stage: Stage;
  leads: Lead[];
}

export function StageColumn({ stage, leads }: Props) {
  const totalCents = leads.reduce((sum, l) => sum + (l.value_cents ?? 0), 0);
  const totalCurrency = leads[0]?.currency ?? 'BRL';
  const wipExceeded = stage.wip_limit != null && leads.length > stage.wip_limit;

  return (
    <div className="flex w-72 shrink-0 flex-col rounded-md border bg-muted/30">
      {/* Header */}
      <div
        className="flex items-center justify-between gap-2 border-b px-3 py-2"
        style={stage.color ? { borderTopColor: stage.color, borderTopWidth: 3 } : undefined}
      >
        <div className="flex items-center gap-2 min-w-0">
          {stage.is_won && <Trophy className="h-4 w-4 text-emerald-600" />}
          {stage.is_lost && <X className="h-4 w-4 text-rose-600" />}
          <span className="truncate text-sm font-medium">{stage.name}</span>
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-xs',
              wipExceeded
                ? 'bg-rose-100 text-rose-700'
                : 'bg-muted text-muted-foreground',
            )}
            title={
              stage.wip_limit
                ? `${leads.length} / WIP ${stage.wip_limit}`
                : `${leads.length}`
            }
          >
            {leads.length}
            {stage.wip_limit ? ` / ${stage.wip_limit}` : ''}
          </span>
        </div>
        <button
          className="rounded p-1 text-muted-foreground hover:bg-muted"
          aria-label="Novo lead nesta etapa"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {/* Soma de valores */}
      <div className="px-3 py-1.5 text-xs text-muted-foreground border-b">
        {(totalCents / 100).toLocaleString('pt-BR', {
          style: 'currency',
          currency: totalCurrency,
        })}
      </div>

      {/* Lista droppable */}
      <Droppable droppableId={stage.id} type="LEAD">
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={cn(
              'flex flex-1 flex-col gap-2 overflow-y-auto p-2 min-h-[120px]',
              snapshot.isDraggingOver && 'bg-accent/40',
            )}
          >
            {leads.length === 0 && !snapshot.isDraggingOver && (
              <p className="text-center text-xs text-muted-foreground py-4">
                Nenhum card
              </p>
            )}
            {leads.map((lead, index) => (
              <Draggable key={lead.id} draggableId={lead.id} index={index}>
                {(p, s) => (
                  <div
                    ref={p.innerRef}
                    {...p.draggableProps}
                    {...p.dragHandleProps}
                    className={cn(
                      'transition-shadow',
                      s.isDragging && 'shadow-lg ring-2 ring-primary/40',
                    )}
                  >
                    <LeadCard lead={lead} />
                  </div>
                )}
              </Draggable>
            ))}
            {provided.placeholder}
          </div>
        )}
      </Droppable>
    </div>
  );
}
```

⚠️ **Gotcha:** sempre adicione `min-h-[120px]` no droppable, senão arrastar pra coluna vazia fica com hitbox quase nula e o usuário não consegue soltar.

---

## 6. `<LeadCard>` configurável

📦 **`components/crm/LeadCard.tsx`**:

```tsx
'use client';

import { Lead } from '@/hooks/useBoard';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { CalendarDays, MessageCircle, Tag } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import Link from 'next/link';

export function LeadCard({ lead }: { lead: Lead }) {
  return (
    <Link
      href={`/crm/leads/${lead.id}`}
      className="block rounded-md border bg-background p-3 hover:bg-accent/30 transition-colors"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium leading-tight line-clamp-2">
          {lead.title}
        </span>
        {lead.value_cents > 0 && (
          <span className="text-xs font-semibold text-emerald-700 whitespace-nowrap">
            {(lead.value_cents / 100).toLocaleString('pt-BR', {
              style: 'currency',
              currency: lead.currency || 'BRL',
            })}
          </span>
        )}
      </div>

      {lead.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {lead.tags.slice(0, 3).map((t) => (
            <span
              key={t}
              className="inline-flex items-center gap-0.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
            >
              <Tag className="h-2.5 w-2.5" />
              {t}
            </span>
          ))}
        </div>
      )}

      <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
        <div className="flex items-center gap-2 min-w-0">
          {lead.contact_name && (
            <div className="flex items-center gap-1 min-w-0">
              <Avatar className="h-5 w-5">
                <AvatarImage src={lead.contact_avatar_url ?? undefined} />
                <AvatarFallback className="text-[9px]">
                  {lead.contact_name.slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <span className="truncate">{lead.contact_name}</span>
            </div>
          )}
        </div>
        {lead.last_activity_at && (
          <span className="flex items-center gap-1 whitespace-nowrap">
            <CalendarDays className="h-3 w-3" />
            {formatDistanceToNow(new Date(lead.last_activity_at), { locale: ptBR, addSuffix: true })}
          </span>
        )}
      </div>
    </Link>
  );
}
```

---

## 7. Filtros laterais (`<BoardFiltersBar>`)

📦 **`components/crm/BoardFiltersBar.tsx`**:

```tsx
'use client';

import { useState, useEffect } from 'react';
import { BoardFilters } from '@/hooks/useBoard';
import { Search } from 'lucide-react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';

export function BoardFiltersBar({
  filters,
  onChange,
  pipelineId,
}: {
  filters: BoardFilters;
  onChange: (f: BoardFilters) => void;
  pipelineId: string;
}) {
  const [members, setMembers] = useState<Array<{ user_id: string; email: string }>>([]);

  useEffect(() => {
    const load = async () => {
      const supa = getSupabaseBrowserClient();
      // ajusta conforme seu schema (assumindo view ou função que retorna emails)
      const { data } = await supa.rpc('list_org_members');
      setMembers((data ?? []) as any);
    };
    load();
  }, [pipelineId]);

  const debouncedSearch = useDebounce((value: string) => {
    onChange({ ...filters, search: value || undefined });
  }, 300);

  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
      <label className="relative">
        <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          placeholder="Buscar..."
          defaultValue={filters.search ?? ''}
          onChange={(e) => debouncedSearch(e.target.value)}
          className="rounded-md border bg-background py-1.5 pl-7 pr-3 text-sm"
        />
      </label>

      <select
        value={filters.ownerUserId ?? ''}
        onChange={(e) =>
          onChange({ ...filters, ownerUserId: e.target.value || null })
        }
        className="rounded-md border bg-background px-2 py-1.5 text-sm"
      >
        <option value="">Todos os responsáveis</option>
        {members.map((m) => (
          <option key={m.user_id} value={m.user_id}>{m.email}</option>
        ))}
      </select>

      <select
        value={filters.source ?? ''}
        onChange={(e) => onChange({ ...filters, source: e.target.value || null })}
        className="rounded-md border bg-background px-2 py-1.5 text-sm"
      >
        <option value="">Todas as origens</option>
        <option value="whatsapp_inbound">WhatsApp</option>
        <option value="email_inbound">E-mail</option>
        <option value="web_form">Formulário</option>
        <option value="manual">Manual</option>
        <option value="api">API</option>
      </select>

      <input
        type="number"
        placeholder="Valor mín"
        value={filters.minValue ?? ''}
        onChange={(e) =>
          onChange({
            ...filters,
            minValue: e.target.value ? Number(e.target.value) * 100 : undefined,
          })
        }
        className="w-24 rounded-md border bg-background px-2 py-1.5 text-sm"
      />
      <input
        type="number"
        placeholder="Valor máx"
        value={filters.maxValue ?? ''}
        onChange={(e) =>
          onChange({
            ...filters,
            maxValue: e.target.value ? Number(e.target.value) * 100 : undefined,
          })
        }
        className="w-24 rounded-md border bg-background px-2 py-1.5 text-sm"
      />
      {Object.values(filters).some((v) => v != null && v !== '') && (
        <button
          onClick={() => onChange({})}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Limpar
        </button>
      )}
    </div>
  );
}

function useDebounce<T extends (...a: any[]) => void>(fn: T, ms: number) {
  const ref = useState<{ t: any }>({ t: null })[0];
  return (...args: Parameters<T>) => {
    if (ref.t) clearTimeout(ref.t);
    ref.t = setTimeout(() => fn(...args), ms);
  };
}
```

---

## 8. Realtime: prevenir saltos com optimistic + skip-self

Quando você faz UPDATE optimistic e o realtime chega de volta, a UI pode "saltar" porque você está aplicando duas vezes. Soluções:

### Estratégia A — sempre `reload()`

Simples: a cada evento Realtime, refetch. Funciona bem até ~500 leads no board.

### Estratégia B — patch in-place

Mais sofisticado. Quando recebe UPDATE de um lead que já está no estado optimistic, ignora se `position_in_stage` é igual.

```ts
.on('postgres_changes', {...}, (payload) => {
  if (payload.eventType === 'UPDATE') {
    setLeads((prev) =>
      prev.map((l) =>
        l.id === payload.new.id
          ? { ...l, ...payload.new, contact_name: l.contact_name, contact_avatar_url: l.contact_avatar_url }
          : l,
      ),
    );
  } else {
    reload();
  }
});
```

🎯 **Decisão:** comece com Estratégia A. Migre pra B se latência incomodar.

---

## 9. Endpoint server-side opcional (validação extra)

Em vez de `supa.from('crm_leads').update(...)` direto do client, você pode rotear por uma API que valide regras de negócio antes de persistir.

📦 **`app/api/crm/leads/[id]/move/route.ts`**:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { midpoint } from '@/lib/crm/fractional-position';

const Schema = z.object({
  destStageId: z.string().uuid(),
  prevPosition: z.number().nullable(),
  nextPosition: z.number().nullable(),
});

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const supa = getSupabaseServerClient();
  const body = await req.json();
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_payload' }, { status: 400 });
  }

  const { destStageId, prevPosition, nextPosition } = parsed.data;

  // Valida WIP limit do stage destino
  const { data: stage } = await supa
    .from('crm_stages')
    .select('id, wip_limit, is_won, is_lost')
    .eq('id', destStageId)
    .single();

  if (!stage) return NextResponse.json({ error: 'stage_not_found' }, { status: 404 });

  if (stage.wip_limit != null) {
    const { count } = await supa
      .from('crm_leads')
      .select('id', { count: 'exact', head: true })
      .eq('stage_id', destStageId)
      .eq('status', 'open');
    if ((count ?? 0) >= stage.wip_limit) {
      // Permitir mas sinalizar
      // Ou bloquear:
      // return NextResponse.json({ error: 'wip_exceeded' }, { status: 422 });
    }
  }

  const newPos = midpoint(prevPosition, nextPosition);

  const update: Record<string, any> = {
    stage_id: destStageId,
    position_in_stage: newPos,
    updated_at: new Date().toISOString(),
  };

  // Se destino é won/lost, fecha
  if (stage.is_won) {
    update.status = 'won';
    update.closed_at = new Date().toISOString();
  } else if (stage.is_lost) {
    update.status = 'lost';
    update.closed_at = new Date().toISOString();
  }

  const { data, error } = await supa
    .from('crm_leads')
    .update(update)
    .eq('id', params.id)
    .select('id, stage_id, position_in_stage, status')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ lead: data });
}
```

⭐ **Relacionamentos potenciais — endpoint `move`**

| Lê de | Escreve em | Eventos |
|------|-----------|---------|
| `crm_stages.wip_limit, is_won, is_lost` | `crm_leads.stage_id, position_in_stage, status, closed_at` | Trigger `lead.stage_changed`, `lead.won`, `lead.lost` |

---

## 10. Empty states e loading

| Estado | UI |
|--------|----|
| Pipeline carregando | Skeleton de 4 colunas com shimmer |
| Pipeline sem stages | CTA "Configurar etapas" |
| Stage sem leads + drop ativo | Hitbox visível com hint "Solte aqui" |
| Stage sem leads + sem drop | Texto "Nenhum card" centralizado |
| Erro de rede | Toast + botão "Tentar novamente" |
| WIP estourado | Badge vermelha no header + tooltip explicando |

---

## 11. Atalhos de teclado (opcional mas valoroso)

```tsx
'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export function BoardKeyboardShortcuts({ onNew }: { onNew: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ignora se usuário está digitando em input
      const target = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA'].includes(target.tagName)) return;

      if (e.key === 'n' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        onNew();
      }
      // adicione: '/' = focar busca, 'f' = abrir filtros, etc.
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onNew]);
  return null;
}
```

---

## 12. Performance: virtualização (quando necessário)

Em pipelines com >500 leads por stage, considere `react-window` ou `react-virtuoso` na lista do `<Droppable>`. `@hello-pangea/dnd` suporta isso, mas exige ajustes. **Não otimize antes de medir** — até 200 leads por coluna o DOM puro vai bem.

---

## 13. Checklist de implementação UI

- [ ] `@hello-pangea/dnd` instalado (versão >= 16)
- [ ] `crm_leads.position_in_stage` é `numeric`
- [ ] `midpoint()` testado nos casos: vazio, topo, fim, meio
- [ ] `useBoard()` retorna stages + leads ordenados
- [ ] Realtime canal escuta `crm_leads` + `crm_stages`
- [ ] `<PipelineBoard>` faz optimistic update no drag
- [ ] Falha de rede no UPDATE faz rollback (reload)
- [ ] `<StageColumn>` mostra count, soma, WIP
- [ ] `<LeadCard>` mostra título, valor, tags, owner, last_activity
- [ ] Filtros laterais funcionam e debouncing está aplicado
- [ ] Empty state em pipeline sem stages
- [ ] Skeleton em loading
- [ ] WIP estourado é visualmente óbvio (vermelho)

---

## Próximo: [04-schema-universal.md](04-schema-universal.md)
