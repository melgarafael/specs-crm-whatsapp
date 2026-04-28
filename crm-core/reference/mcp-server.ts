#!/usr/bin/env node
/**
 * MCP Server (compact reference) — universal CRM
 * ================================================
 *
 * Servidor MCP completo executável em arquivo único.
 *
 * Cobre 19+ tools (read + write), 2 resources, 1 prompt, e ambos os transports
 * (stdio e Streamable HTTP) — selecionados por env var `MCP_TRANSPORT`
 * ("stdio" ou "http", default "stdio").
 *
 * Pressupõe que sua REST API do CRM (Parte 2 da aula) está rodando em
 * `process.env.CRM_API_BASE_URL` e expõe os endpoints chamados aqui.
 *
 * Dependencies:
 *   npm i @modelcontextprotocol/sdk zod express cors
 *   npm i -D @types/node @types/express @types/cors typescript tsx
 *
 * Run:
 *   tsx mcp-server.ts                       # stdio (default)
 *   MCP_TRANSPORT=http tsx mcp-server.ts    # HTTP em PORT (default 3333)
 *
 * Configuração mínima de env:
 *   CRM_API_BASE_URL=https://api.seucrm.com
 *
 *   # stdio (single-user, identidade fixa):
 *   CRM_API_TOKEN=tok_xxx
 *   DEFAULT_ORGANIZATION_ID=...
 *   DEFAULT_USER_ID=...
 *
 *   # http (multi-tenant, identidade resolvida do Bearer):
 *   PORT=3333
 *   ALLOWED_HOSTS=mcp.seucrm.com,localhost:3333
 *   ALLOWED_ORIGINS=https://claude.ai,https://app.cursor.com
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Logger (stderr — nunca stdout em modo stdio)
// ─────────────────────────────────────────────────────────────────────────────

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';

function log(lvl: LogLevel, msg: string, ctx: Record<string, unknown> = {}) {
  if (LEVELS[lvl] < LEVELS[LEVEL]) return;
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...ctx }) + '\n');
}
const logger = {
  debug: (m: string, c?: Record<string, unknown>) => log('debug', m, c),
  info: (m: string, c?: Record<string, unknown>) => log('info', m, c),
  warn: (m: string, c?: Record<string, unknown>) => log('warn', m, c),
  error: (m: string, c?: Record<string, unknown>) => log('error', m, c),
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. Erros tipados + helper de resposta
// ─────────────────────────────────────────────────────────────────────────────

class McpAppError extends Error {
  constructor(
    public code:
      | 'unauthenticated' | 'forbidden' | 'not_found'
      | 'invalid_input' | 'upstream_failed' | 'rate_limited' | 'internal',
    message: string,
    public statusCode = 500,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'McpAppError';
  }
}

function errToResult(err: unknown) {
  if (err instanceof McpAppError) {
    return {
      isError: true,
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: err.code, message: err.message, details: err.details ?? null }),
      }],
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ error: 'internal', message: msg }) }],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Auth context
// ─────────────────────────────────────────────────────────────────────────────

interface AuthContext {
  apiToken: string;
  organizationId: string;
  userId: string;
}

const API_BASE_URL = process.env.CRM_API_BASE_URL ?? 'http://localhost:3001';

function authFromEnv(): AuthContext {
  const apiToken = process.env.CRM_API_TOKEN;
  const organizationId = process.env.DEFAULT_ORGANIZATION_ID;
  const userId = process.env.DEFAULT_USER_ID;
  if (!apiToken) throw new McpAppError('unauthenticated', 'CRM_API_TOKEN missing', 401);
  if (!organizationId) throw new McpAppError('forbidden', 'DEFAULT_ORGANIZATION_ID missing', 403);
  if (!userId) throw new McpAppError('forbidden', 'DEFAULT_USER_ID missing', 403);
  return { apiToken, organizationId, userId };
}

async function authFromBearer(bearer: string): Promise<AuthContext> {
  if (!bearer.startsWith('Bearer ')) throw new McpAppError('unauthenticated', 'Bad Authorization header', 401);
  const token = bearer.slice('Bearer '.length).trim();
  if (!token) throw new McpAppError('unauthenticated', 'Empty token', 401);
  const res = await fetch(`${API_BASE_URL}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) throw new McpAppError('unauthenticated', 'Invalid or expired token', 401);
  if (!res.ok) throw new McpAppError('upstream_failed', `auth /me ${res.status}`, 502);
  const d = (await res.json()) as { user_id: string; organization_id: string };
  return { apiToken: token, organizationId: d.organization_id, userId: d.user_id };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. CRM REST client (proxies pra REST API da Parte 2)
// ─────────────────────────────────────────────────────────────────────────────

interface Pipeline { id: string; name: string; slug: string; is_default: boolean; vocabulary: Record<string, string> | null; stages?: Stage[]; }
interface Stage { id: string; pipeline_id: string; name: string; position: number; is_won: boolean; is_lost: boolean; win_probability: number | null; wip_limit: number | null; }
interface Lead {
  id: string; pipeline_id: string; stage_id: string; title: string; status: 'open' | 'won' | 'lost';
  value_cents: number; currency: string; owner_user_id: string | null; tags: string[];
  position_in_stage: number; lost_reason: string | null; expected_close_date: string | null;
  custom_fields: Record<string, unknown> | null; created_at: string; updated_at: string;
  closed_at: string | null; last_activity_at: string | null;
}
interface Activity { id: string; lead_id: string; type: string; title: string | null; body: string | null; performed_at: string; performed_by_user_id: string | null; source_module: string | null; }

class CrmClient {
  constructor(private auth: AuthContext) {}

  private async req<T>(method: string, path: string, body?: unknown, query?: Record<string, unknown>): Promise<T> {
    let url = `${API_BASE_URL}${path}`;
    if (query) {
      const usp = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) usp.set(k, String(v));
      }
      const qs = usp.toString();
      if (qs) url += `?${qs}`;
    }
    const t0 = Date.now();
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.auth.apiToken}`,
        'X-Organization-Id': this.auth.organizationId,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    logger.debug('crm_call', { method, path, status: res.status, elapsedMs: Date.now() - t0 });
    if (res.status === 401) throw new McpAppError('unauthenticated', 'CRM token invalid', 401);
    if (res.status === 403) throw new McpAppError('forbidden', 'No permission', 403);
    if (res.status === 404) throw new McpAppError('not_found', `Not found: ${path}`, 404);
    if (res.status === 422 || res.status === 400) {
      const t = await res.text();
      throw new McpAppError('invalid_input', `Validation: ${t}`, res.status, t);
    }
    if (!res.ok) {
      const t = await res.text();
      throw new McpAppError('upstream_failed', `${method} ${path}: ${res.status} ${t}`, res.status);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // pipelines
  listPipelines = () => this.req<Pipeline[]>('GET', '/api/pipelines');
  getPipeline = (id: string) => this.req<Pipeline>('GET', `/api/pipelines/${id}`);
  listStages = (pid: string) => this.req<Stage[]>('GET', `/api/pipelines/${pid}/stages`);

  // leads
  listLeads = (q: Record<string, unknown>) => this.req<{ items: Lead[]; total: number }>('GET', '/api/leads', undefined, q);
  searchLeads = (q: string, limit: number) => this.req<Lead[]>('GET', '/api/leads/search', undefined, { q, limit });
  getLead = (id: string) => this.req<Lead & { activities_recent?: Activity[]; links?: unknown[] }>('GET', `/api/leads/${id}`);
  createLead = (input: Record<string, unknown>) => this.req<Lead>('POST', '/api/leads', input);
  updateLead = (id: string, patch: Record<string, unknown>) => this.req<Lead>('PATCH', `/api/leads/${id}`, patch);
  deleteLead = (id: string) => this.req<void>('DELETE', `/api/leads/${id}`);
  moveLeadToStage = (id: string, stage_id: string, position?: number) => this.req<Lead>('POST', `/api/leads/${id}/move`, { stage_id, position });
  markLeadWon = (id: string, value_cents?: number) => this.req<Lead>('POST', `/api/leads/${id}/won`, { value_cents });
  markLeadLost = (id: string, lost_reason: string) => this.req<Lead>('POST', `/api/leads/${id}/lost`, { lost_reason });
  assignLead = (id: string, owner_user_id: string) => this.req<Lead>('POST', `/api/leads/${id}/assign`, { owner_user_id });
  bulkUpdate = (ids: string[], patch: Record<string, unknown>) => this.req<{ updated: number }>('POST', '/api/leads/bulk', { ids, patch });

  // activities
  listActivities = (leadId: string, limit: number) => this.req<Activity[]>('GET', `/api/leads/${leadId}/activities`, undefined, { limit });
  addActivity = (leadId: string, input: Record<string, unknown>) => this.req<Activity>('POST', `/api/leads/${leadId}/activities`, input);

  // links + tags
  linkLead = (leadId: string, input: Record<string, unknown>) => this.req<{ id: string }>('POST', `/api/leads/${leadId}/links`, input);
  addTags = (leadId: string, tags: string[]) => this.req<Lead>('POST', `/api/leads/${leadId}/tags`, { tags });
  removeTags = (leadId: string, tags: string[]) => this.req<Lead>('DELETE', `/api/leads/${leadId}/tags`, { tags });

  // metrics + schema
  getMetrics = (pipeline_id?: string) => this.req<unknown>('GET', '/api/metrics/leads', undefined, { pipeline_id });
  getSchema = () => this.req<unknown>('GET', '/api/meta/schema');
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Build server + register tools/resources/prompts
// ─────────────────────────────────────────────────────────────────────────────

function buildServer(getAuth: () => AuthContext): McpServer {
  const server = new McpServer(
    { name: 'crm-mcp', version: '0.1.0' },
    {
      capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} },
      instructions: `
You are connected to a CRM. Always read crm://schema first to understand
pipelines, stages, vocabulary, and custom fields before acting.
Use list_pipelines / list_stages when you don't know IDs.
For destructive actions (delete_lead, mark_lead_lost, bulk_update_leads)
confirm with the user. Never invent UUIDs.
      `.trim(),
    },
  );

  // ─── READ TOOLS ───

  server.registerTool(
    'list_pipelines',
    {
      title: 'List Pipelines',
      description: 'List all pipelines in the org with stages embedded. Use when you need pipeline_id or stage_id.',
      inputSchema: { include_stages: z.boolean().default(true) },
    },
    async ({ include_stages }) => {
      try {
        const ps = await new CrmClient(getAuth()).listPipelines();
        const compact = ps.map((p) => ({
          id: p.id, name: p.name, slug: p.slug, is_default: p.is_default,
          vocabulary: p.vocabulary,
          stages: include_stages ? p.stages?.map((s) => ({
            id: s.id, name: s.name, position: s.position,
            is_won: s.is_won, is_lost: s.is_lost, win_probability: s.win_probability,
          })) : undefined,
        }));
        return { content: [{ type: 'text', text: JSON.stringify(compact, null, 2) }] };
      } catch (err) { return errToResult(err); }
    },
  );

  server.registerTool(
    'get_pipeline',
    {
      title: 'Get Pipeline',
      description: 'Get full pipeline details by id, including stages, vocabulary, settings.',
      inputSchema: { pipeline_id: z.string().uuid() },
    },
    async ({ pipeline_id }) => {
      try {
        const p = await new CrmClient(getAuth()).getPipeline(pipeline_id);
        return { content: [{ type: 'text', text: JSON.stringify(p, null, 2) }] };
      } catch (err) { return errToResult(err); }
    },
  );

  server.registerTool(
    'list_stages',
    {
      title: 'List Stages',
      description: 'List stages for one pipeline ordered by position.',
      inputSchema: { pipeline_id: z.string().uuid() },
    },
    async ({ pipeline_id }) => {
      try {
        const stages = await new CrmClient(getAuth()).listStages(pipeline_id);
        return { content: [{ type: 'text', text: JSON.stringify(stages, null, 2) }] };
      } catch (err) { return errToResult(err); }
    },
  );

  server.registerTool(
    'list_leads',
    {
      title: 'List Leads',
      description: 'List leads with optional filters. Returns up to 100 per call.',
      inputSchema: {
        pipeline_id: z.string().uuid().optional(),
        stage_id: z.string().uuid().optional(),
        owner_user_id: z.string().uuid().optional(),
        status: z.enum(['open', 'won', 'lost']).optional(),
        q: z.string().optional(),
        tags: z.array(z.string()).optional(),
        value_min_cents: z.number().int().nonnegative().optional(),
        value_max_cents: z.number().int().nonnegative().optional(),
        last_activity_before_iso: z.string().datetime().optional(),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().nonnegative().default(0),
      },
    },
    async (a) => {
      try {
        const r = await new CrmClient(getAuth()).listLeads({
          pipeline_id: a.pipeline_id, stage_id: a.stage_id, owner_user_id: a.owner_user_id,
          status: a.status, q: a.q, tags: a.tags?.join(','),
          value_min_cents: a.value_min_cents, value_max_cents: a.value_max_cents,
          last_activity_before: a.last_activity_before_iso,
          limit: a.limit, offset: a.offset,
        });
        return {
          content: [{
            type: 'text', text: JSON.stringify({
              total: r.total, returned: r.items.length,
              items: r.items.map((l) => ({
                id: l.id, title: l.title, pipeline_id: l.pipeline_id, stage_id: l.stage_id,
                status: l.status, value: l.value_cents / 100, currency: l.currency,
                owner_user_id: l.owner_user_id, tags: l.tags,
                last_activity_at: l.last_activity_at, updated_at: l.updated_at,
              })),
            }, null, 2),
          }],
        };
      } catch (err) { return errToResult(err); }
    },
  );

  server.registerTool(
    'get_lead',
    {
      title: 'Get Lead',
      description: 'Get full detail of a lead including pipeline, stage, contact, recent activities, and links.',
      inputSchema: { lead_id: z.string().uuid() },
    },
    async ({ lead_id }) => {
      try {
        const l = await new CrmClient(getAuth()).getLead(lead_id);
        return { content: [{ type: 'text', text: JSON.stringify(l, null, 2) }] };
      } catch (err) { return errToResult(err); }
    },
  );

  server.registerTool(
    'search_leads',
    {
      title: 'Search Leads',
      description: 'Full-text search on title and contact name. Use when user mentions a lead by name.',
      inputSchema: { query: z.string().min(1).max(200), limit: z.number().int().min(1).max(25).default(10) },
    },
    async ({ query, limit }) => {
      try {
        const ls = await new CrmClient(getAuth()).searchLeads(query, limit);
        return {
          content: [{
            type: 'text', text: JSON.stringify(ls.map((l) => ({
              id: l.id, title: l.title, pipeline_id: l.pipeline_id, stage_id: l.stage_id,
              status: l.status, value: l.value_cents / 100, last_activity_at: l.last_activity_at,
            })), null, 2),
          }],
        };
      } catch (err) { return errToResult(err); }
    },
  );

  server.registerTool(
    'list_activities',
    {
      title: 'List Activities',
      description: 'List activities of a single lead, newest first.',
      inputSchema: { lead_id: z.string().uuid(), limit: z.number().int().min(1).max(100).default(50) },
    },
    async ({ lead_id, limit }) => {
      try {
        const acts = await new CrmClient(getAuth()).listActivities(lead_id, limit);
        return {
          content: [{
            type: 'text', text: JSON.stringify(acts.map((a) => ({
              id: a.id, type: a.type, title: a.title,
              body: a.body?.slice(0, 500), performed_at: a.performed_at,
              performed_by_user_id: a.performed_by_user_id, source_module: a.source_module,
            })), null, 2),
          }],
        };
      } catch (err) { return errToResult(err); }
    },
  );

  server.registerTool(
    'get_lead_metrics',
    {
      title: 'Get Lead Metrics',
      description: 'Aggregate funnel metrics: totals, conversion, by_stage, by_owner.',
      inputSchema: { pipeline_id: z.string().uuid().optional() },
    },
    async ({ pipeline_id }) => {
      try {
        const m = await new CrmClient(getAuth()).getMetrics(pipeline_id);
        return { content: [{ type: 'text', text: JSON.stringify(m, null, 2) }] };
      } catch (err) { return errToResult(err); }
    },
  );

  // ─── WRITE TOOLS ───

  server.registerTool(
    'create_lead',
    {
      title: 'Create Lead',
      description: `
Create a new lead. pipeline_id required; stage_id optional (uses first stage).
Pass value_cents (integer, smallest currency unit) — never decimal value.
contact_phone in E.164 format (+5511999998888).`.trim(),
      inputSchema: {
        title: z.string().min(1).max(500),
        pipeline_id: z.string().uuid(),
        stage_id: z.string().uuid().optional(),
        contact_id: z.string().uuid().optional(),
        contact_phone: z.string().regex(/^\+?[1-9]\d{6,14}$/).optional(),
        contact_name: z.string().min(1).optional(),
        value_cents: z.number().int().nonnegative().optional(),
        currency: z.string().length(3).default('BRL'),
        owner_user_id: z.string().uuid().optional(),
        source: z.string().max(100).optional(),
        custom_fields: z.record(z.string(), z.unknown()).optional(),
        tags: z.array(z.string()).max(50).optional(),
        expected_close_date: z.string().date().optional(),
      },
    },
    async (a) => {
      try {
        const l = await new CrmClient(getAuth()).createLead(a);
        return { content: [{ type: 'text', text: JSON.stringify({ id: l.id, title: l.title, status: l.status }, null, 2) }] };
      } catch (err) { return errToResult(err); }
    },
  );

  server.registerTool(
    'update_lead',
    {
      title: 'Update Lead',
      description: `
Update fields. Do NOT use for stage move, won/lost, owner change, or tags —
use the dedicated tool for those.`.trim(),
      inputSchema: {
        lead_id: z.string().uuid(),
        title: z.string().min(1).max(500).optional(),
        value_cents: z.number().int().nonnegative().optional(),
        currency: z.string().length(3).optional(),
        source: z.string().max(100).nullable().optional(),
        source_metadata: z.record(z.string(), z.unknown()).optional(),
        custom_fields: z.record(z.string(), z.unknown()).optional(),
        expected_close_date: z.string().date().nullable().optional(),
      },
    },
    async ({ lead_id, ...patch }) => {
      try {
        const l = await new CrmClient(getAuth()).updateLead(lead_id, patch);
        return { content: [{ type: 'text', text: JSON.stringify({ id: l.id, updated_at: l.updated_at }, null, 2) }] };
      } catch (err) { return errToResult(err); }
    },
  );

  server.registerTool(
    'move_lead_to_stage',
    {
      title: 'Move Lead to Stage',
      description: 'Move a lead to a different stage in the same pipeline. Generates a status_change activity.',
      inputSchema: {
        lead_id: z.string().uuid(),
        stage_id: z.string().uuid(),
        position: z.number().nonnegative().optional(),
      },
    },
    async ({ lead_id, stage_id, position }) => {
      try {
        const l = await new CrmClient(getAuth()).moveLeadToStage(lead_id, stage_id, position);
        return { content: [{ type: 'text', text: JSON.stringify({ id: l.id, stage_id: l.stage_id, status: l.status }, null, 2) }] };
      } catch (err) { return errToResult(err); }
    },
  );

  server.registerTool(
    'delete_lead',
    {
      title: 'Delete Lead (soft)',
      description: 'Soft-delete. Use mark_lead_lost for "did not close". confirm=true required.',
      inputSchema: {
        lead_id: z.string().uuid(),
        confirm: z.boolean(),
        reason: z.string().min(3).max(500).optional(),
      },
    },
    async ({ lead_id, confirm, reason }) => {
      try {
        if (!confirm) {
          return {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify({ error: 'confirmation_required', message: 'Pass confirm=true after asking the user.' }) }],
          };
        }
        await new CrmClient(getAuth()).deleteLead(lead_id);
        return { content: [{ type: 'text', text: JSON.stringify({ deleted: true, lead_id, reason: reason ?? null }) }] };
      } catch (err) { return errToResult(err); }
    },
  );

  server.registerTool(
    'mark_lead_won',
    {
      title: 'Mark Lead as Won',
      description: 'Close as won. Optionally update final value_cents.',
      inputSchema: {
        lead_id: z.string().uuid(),
        value_cents: z.number().int().nonnegative().optional(),
      },
    },
    async ({ lead_id, value_cents }) => {
      try {
        const l = await new CrmClient(getAuth()).markLeadWon(lead_id, value_cents);
        return { content: [{ type: 'text', text: JSON.stringify({ id: l.id, status: l.status, value: l.value_cents / 100, closed_at: l.closed_at }) }] };
      } catch (err) { return errToResult(err); }
    },
  );

  server.registerTool(
    'mark_lead_lost',
    {
      title: 'Mark Lead as Lost',
      description: 'Close as lost. Reason is required (free text or no_budget|competitor|timing|no_response|ghosted|other).',
      inputSchema: {
        lead_id: z.string().uuid(),
        reason: z.string().min(3).max(200),
      },
    },
    async ({ lead_id, reason }) => {
      try {
        const l = await new CrmClient(getAuth()).markLeadLost(lead_id, reason);
        return { content: [{ type: 'text', text: JSON.stringify({ id: l.id, status: l.status, lost_reason: l.lost_reason, closed_at: l.closed_at }) }] };
      } catch (err) { return errToResult(err); }
    },
  );

  server.registerTool(
    'assign_lead',
    {
      title: 'Assign Lead Owner',
      description: 'Reassign owner. Generates an "owner_changed" activity.',
      inputSchema: {
        lead_id: z.string().uuid(),
        owner_user_id: z.string().uuid(),
      },
    },
    async ({ lead_id, owner_user_id }) => {
      try {
        const l = await new CrmClient(getAuth()).assignLead(lead_id, owner_user_id);
        return { content: [{ type: 'text', text: JSON.stringify({ id: l.id, owner_user_id: l.owner_user_id }) }] };
      } catch (err) { return errToResult(err); }
    },
  );

  server.registerTool(
    'add_activity',
    {
      title: 'Add Activity',
      description: 'Append note/call/meeting/email/message/task/custom to a lead history.',
      inputSchema: {
        lead_id: z.string().uuid(),
        type: z.enum(['note', 'call', 'meeting', 'email', 'message', 'task', 'custom']).default('note'),
        title: z.string().max(200).optional(),
        body: z.string().max(10_000).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (a) => {
      try {
        const act = await new CrmClient(getAuth()).addActivity(a.lead_id, {
          type: a.type, title: a.title, body: a.body, metadata: a.metadata, source_module: 'mcp',
        });
        return { content: [{ type: 'text', text: JSON.stringify({ id: act.id, type: act.type, performed_at: act.performed_at }) }] };
      } catch (err) { return errToResult(err); }
    },
  );

  server.registerTool(
    'link_lead_to_resource',
    {
      title: 'Link Lead to External Resource',
      description: 'Create typed link from a lead to (whatsapp_chat, calendar_event, document, ticket, etc.).',
      inputSchema: {
        lead_id: z.string().uuid(),
        target_kind: z.string().min(1).max(50),
        target_id: z.string().min(1).max(200),
        link_kind: z.string().min(1).max(50),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async ({ lead_id, target_kind, target_id, link_kind, metadata }) => {
      try {
        const r = await new CrmClient(getAuth()).linkLead(lead_id, { target_kind, target_id, link_kind, metadata });
        return { content: [{ type: 'text', text: JSON.stringify({ link_id: r.id, lead_id }) }] };
      } catch (err) { return errToResult(err); }
    },
  );

  server.registerTool(
    'add_tags',
    {
      title: 'Add Tags to Lead',
      description: 'Add tags. Idempotent — duplicates ignored. Does NOT remove existing.',
      inputSchema: {
        lead_id: z.string().uuid(),
        tags: z.array(z.string().min(1).max(50)).min(1).max(20),
      },
    },
    async ({ lead_id, tags }) => {
      try {
        const l = await new CrmClient(getAuth()).addTags(lead_id, tags);
        return { content: [{ type: 'text', text: JSON.stringify({ id: l.id, tags: l.tags }) }] };
      } catch (err) { return errToResult(err); }
    },
  );

  server.registerTool(
    'remove_tags',
    {
      title: 'Remove Tags from Lead',
      description: 'Remove tags. No-op if absent.',
      inputSchema: {
        lead_id: z.string().uuid(),
        tags: z.array(z.string().min(1).max(50)).min(1).max(20),
      },
    },
    async ({ lead_id, tags }) => {
      try {
        const l = await new CrmClient(getAuth()).removeTags(lead_id, tags);
        return { content: [{ type: 'text', text: JSON.stringify({ id: l.id, tags: l.tags }) }] };
      } catch (err) { return errToResult(err); }
    },
  );

  server.registerTool(
    'bulk_update_leads',
    {
      title: 'Bulk Update Leads',
      description: 'Apply same patch to up to 100 leads. confirm=true required. No stage/owner/tags here.',
      inputSchema: {
        lead_ids: z.array(z.string().uuid()).min(1).max(100),
        patch: z.object({
          title: z.string().min(1).max(500).optional(),
          value_cents: z.number().int().nonnegative().optional(),
          currency: z.string().length(3).optional(),
          source: z.string().max(100).nullable().optional(),
          custom_fields: z.record(z.string(), z.unknown()).optional(),
          expected_close_date: z.string().date().nullable().optional(),
        }),
        confirm: z.boolean(),
      },
    },
    async ({ lead_ids, patch, confirm }) => {
      try {
        if (!confirm) {
          return {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify({ error: 'confirmation_required', message: `Pass confirm=true to apply patch to ${lead_ids.length} leads.` }) }],
          };
        }
        const r = await new CrmClient(getAuth()).bulkUpdate(lead_ids, patch);
        return { content: [{ type: 'text', text: JSON.stringify({ updated: r.updated, requested: lead_ids.length }) }] };
      } catch (err) { return errToResult(err); }
    },
  );

  // ─── RESOURCES ───

  server.registerResource(
    'crm-schema',
    'crm://schema',
    {
      title: 'CRM Schema (live)',
      description: 'Live snapshot of pipelines, stages, vocabulary, custom fields. Read FIRST.',
      mimeType: 'application/json',
    },
    async (uri) => {
      try {
        const schema = await new CrmClient(getAuth()).getSchema();
        return {
          contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(schema, null, 2) }],
        };
      } catch (err) {
        return {
          contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ error: String(err) }) }],
        };
      }
    },
  );

  server.registerResource(
    'crm-pipelines',
    'crm://pipelines',
    {
      title: 'CRM Pipelines',
      description: 'All pipelines with stages embedded.',
      mimeType: 'application/json',
    },
    async (uri) => {
      try {
        const ps = await new CrmClient(getAuth()).listPipelines();
        return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(ps, null, 2) }] };
      } catch (err) {
        return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ error: String(err) }) }] };
      }
    },
  );

  // ─── PROMPTS ───

  server.registerPrompt(
    'analyze_stuck_leads',
    {
      title: 'Analyze Stuck Leads',
      description: 'Lists leads with no activity in N days and proposes an action per lead.',
      argsSchema: {
        days: z.string().default('7'),
        pipeline_id: z.string().optional(),
      },
    },
    ({ days, pipeline_id }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `
Use the CRM tools to:
1. Read crm://schema for context.
2. list_leads ${pipeline_id ? `in pipeline ${pipeline_id}` : 'across all pipelines'} with status="open" and last_activity_before_iso = today - ${days}d.
3. For each lead: list_activities to inspect history.
4. Output a markdown table: title, days_stuck, value, last_activity_summary, suggested_next_action.
5. Suggest a concrete action per lead. If zero activities, recommend a first-touch.
Be concise.`.trim(),
        },
      }],
    }),
  );

  return server;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Transport selection (stdio | http)
// ─────────────────────────────────────────────────────────────────────────────

async function runStdio() {
  const auth = authFromEnv();
  logger.info('mcp_stdio_boot', { organizationId: auth.organizationId, userId: auth.userId });
  const server = buildServer(() => auth);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('mcp_stdio_ready');
}

async function runHttp() {
  const PORT = Number(process.env.PORT ?? 3333);
  const HOST = process.env.HOST ?? '0.0.0.0';
  const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS ?? `localhost:${PORT}`).split(',').map((s) => s.trim()).filter(Boolean);
  const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '*').split(',').map((s) => s.trim()).filter(Boolean);

  interface SessionState { transport: StreamableHTTPServerTransport; auth: AuthContext; }
  const sessions = new Map<string, SessionState>();

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(cors({
    origin: ALLOWED_ORIGINS.length === 1 && ALLOWED_ORIGINS[0] === '*' ? '*' : ALLOWED_ORIGINS,
    exposedHeaders: ['Mcp-Session-Id', 'MCP-Protocol-Version', 'WWW-Authenticate'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id', 'MCP-Protocol-Version'],
  }));

  app.get('/healthz', (_req, res) => res.json({ ok: true, sessions: sessions.size }));

  app.post('/mcp', async (req: Request, res: Response) => {
    try {
      const sid = req.headers['mcp-session-id'] as string | undefined;

      if (sid && sessions.has(sid)) {
        await sessions.get(sid)!.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!isInitializeRequest(req.body)) {
        res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Initialize first' }, id: null });
        return;
      }

      const bearer = req.headers.authorization;
      if (!bearer) {
        res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Missing Authorization' }, id: null });
        return;
      }

      let auth: AuthContext;
      try { auth = await authFromBearer(bearer); }
      catch (err) {
        res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: String(err) }, id: null });
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableDnsRebindingProtection: true,
        allowedHosts: ALLOWED_HOSTS,
        onsessioninitialized: (s) => {
          sessions.set(s, { transport, auth });
          logger.info('mcp_session_init', { session_id: s, organization_id: auth.organizationId, user_id: auth.userId });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
          logger.info('mcp_session_closed', { session_id: transport.sessionId });
        }
      };

      const server = buildServer(() => auth);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error('mcp_post_failed', { err: String(err) });
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
      }
    }
  });

  app.get('/mcp', async (req: Request, res: Response) => {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    if (!sid || !sessions.has(sid)) { res.status(400).send('Invalid session'); return; }
    await sessions.get(sid)!.transport.handleRequest(req, res);
  });

  app.delete('/mcp', async (req: Request, res: Response) => {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    if (!sid || !sessions.has(sid)) { res.status(400).send('Invalid session'); return; }
    await sessions.get(sid)!.transport.handleRequest(req, res);
  });

  app.listen(PORT, HOST, () => logger.info('mcp_http_listening', { host: HOST, port: PORT }));
}

const TRANSPORT = (process.env.MCP_TRANSPORT ?? 'stdio').toLowerCase();

async function main() {
  if (TRANSPORT === 'http') await runHttp();
  else await runStdio();
}

main().catch((err) => {
  logger.error('mcp_fatal', { err: String(err) });
  process.exit(1);
});
