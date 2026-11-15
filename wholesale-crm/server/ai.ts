// AI features (Claude). Every answer is grounded in CRM records fetched through the same permission-checked
// data layer the API uses. Nothing here writes to the CRM: suggestions come back to the user for approval.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { ENTITY } from '../shared/schema';
import * as M from '../shared/metrics';
import { contactName, propertyLabel } from '../shared/logic';
import { aiReady } from './integrations';
import { HttpError } from './repo';
import { getFor, listFor, type Ctx } from './service';

type R = Record<string, any>;
const MODEL = 'claude-opus-5-5';
// Server-side refusal fallback is enabled so a policy decline is retried on a fallback model in the same call.
const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } as any;

function client() {
  if (!aiReady()) throw new HttpError(424, 'The AI assistant is not connected. Set ANTHROPIC_API_KEY on the server (see Integrations).');
  return new Anthropic();
}
function fail(e: unknown): never {
  if (e instanceof HttpError) throw e;
  if (e instanceof Anthropic.AuthenticationError) throw new HttpError(424, 'The Anthropic API key was rejected. Check ANTHROPIC_API_KEY.');
  if (e instanceof Anthropic.RateLimitError) throw new HttpError(429, 'The AI provider is rate limiting requests. Try again in a moment.');
  if (e instanceof Anthropic.APIError) throw new HttpError(502, `AI request failed: ${e.message}`);
  throw e;
}
const textOf = (msg: { content: any[] }) => msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();

const LeadSummary = z.object({
  summary: z.string().describe('3-5 sentence overview of where this lead stands'),
  motivation: z.string(), property_condition: z.string(), asking_price: z.string(), timeline: z.string(),
  seller_sentiment: z.enum(['positive', 'neutral', 'hesitant', 'negative', 'unknown']),
  objections: z.array(z.string()), missing_information: z.array(z.string()),
  next_steps: z.array(z.object({ title: z.string().describe('Imperative task title'), due_in_days: z.number(), category: z.enum(['Call seller', 'Send offer', 'Follow up', 'Underwrite property', 'Research comps', 'Schedule appointment', 'Review contract', 'Other']), why: z.string() })),
});

export async function leadSummary(ctx: Ctx, leadId: string) {
  const lead = await getFor(ctx, 'leads', leadId);
  const [contact, property, activities, comms, offers, tasks] = await Promise.all([
    getFor(ctx, 'contacts', lead.contact_id).catch(() => null), lead.property_id ? getFor(ctx, 'properties', lead.property_id).catch(() => null) : null,
    listFor(ctx, 'activities', { lead_id: leadId }), listFor(ctx, 'communications', { lead_id: leadId }).catch(() => []), listFor(ctx, 'offers', { lead_id: leadId }).catch(() => []), listFor(ctx, 'tasks', { lead_id: leadId }).catch(() => []),
  ]);
  const pick = (o: R | null, keys: string[]) => (o ? Object.fromEntries(keys.filter(k => o[k] !== null && o[k] !== undefined && o[k] !== '').map(k => [k, o[k]])) : null);
  const record = {
    today: new Date().toISOString().slice(0, 10),
    seller: pick(contact, ['first_name', 'last_name', 'preferred_contact', 'best_time', 'dnc']),
    lead: pick(lead, ['stage', 'classification', 'motivation', 'reason', 'asking_price', 'timeline', 'negotiation', 'decision_authority', 'other_decision_makers', 'financial_situation', 'circumstances', 'source', 'tags', 'score', 'created_at', 'last_contact_at', 'next_follow_up']),
    property: pick(property, ['address', 'city', 'property_type', 'beds', 'baths', 'sqft', 'year_built', 'condition', 'occupancy', 'est_value', 'arv', 'repair_cost', 'mortgage_balance', 'tax_delinquent', 'tax_owed', 'indicators']),
    conversations: comms.sort((a, b) => a.at.localeCompare(b.at)).map(c => pick(c, ['at', 'type', 'direction', 'outcome', 'body', 'next_action'])),
    timeline: activities.filter(a => a.type !== 'comm').sort((a, b) => a.at.localeCompare(b.at)).map(a => `${a.at.slice(0, 10)} ${a.summary}${a.body ? `: ${a.body}` : ''}`),
    offers: offers.map(o => pick(o, ['from_party', 'amount', 'status', 'offer_date', 'notes'])), open_tasks: tasks.filter(t => t.status !== 'Done' && t.status !== 'Cancelled').map(t => pick(t, ['title', 'due_at'])),
  };
  try {
    const res = await client().messages.parse({
      model: MODEL, max_tokens: 8000,
      system: 'You summarize motivated-seller leads for a real estate wholesaling acquisitions team. Use only facts present in the CRM record provided. If something is not in the record, say it is not recorded — never guess or invent details. Recommended next steps are suggestions a person will review before anything happens. If the seller is marked do-not-contact, do not recommend any outreach.',
      messages: [{ role: 'user', content: `CRM record (JSON):\n${JSON.stringify(record)}\n\nSummarize this lead.` }],
      output_config: { effort: 'medium', format: zodOutputFormat(LeadSummary) },
    });
    if (res.stop_reason === 'refusal' || !res.parsed_output) throw new HttpError(502, 'The AI could not produce a summary for this lead.');
    return { ...res.parsed_output, generated_at: new Date().toISOString(), model: res.model, based_on: { conversations: comms.length, activities: activities.length, offers: offers.length } };
  } catch (e) { fail(e); }
}

export async function dealReview(ctx: Ctx, body: { inputs: R; results: R; propertyId?: string; comps?: R[]; checks?: R[]; matches?: R[] }) {
  const property = body.propertyId ? await getFor(ctx, 'properties', body.propertyId) : null;
  try {
    const res = await client().beta.messages.create({
      model: MODEL, max_tokens: 6000, ...FALLBACK,
      system: 'You are an underwriting reviewer for a real estate wholesaler. Review the deal analysis you are given. Identify risks, missing information, assumptions that look unrealistic, negotiation angles and which buyer types fit. Base every statement on the numbers provided; do not invent comps, values or market facts. You have no market data beyond what is in the message — say so where it matters. Be concise: short sections with bullet points. Your review is advisory; a person decides the offer.',
      messages: [{ role: 'user', content: JSON.stringify({ property, analysis_inputs: body.inputs, analysis_results: body.results, manual_comps: body.comps ?? [], rule_based_checks: body.checks ?? [], matching_buyers: body.matches ?? [] }) }],
      output_config: { effort: 'medium' },
    } as any);
    if (res.stop_reason === 'refusal') throw new HttpError(502, 'The AI declined to review this deal.');
    return { text: textOf(res), model: res.model, generated_at: new Date().toISOString() };
  } catch (e) { fail(e); }
}

const QUERYABLE = ['leads', 'contacts', 'properties', 'offers', 'contracts', 'transactions', 'buyers', 'dispositions', 'buyer_interests', 'tasks', 'communications', 'campaigns', 'revenue', 'expenses', 'markets'];

async function dataset(ctx: Ctx): Promise<M.Dataset> {
  const keys = Object.keys(M.EMPTY).filter(k => k !== 'users') as (keyof M.Dataset)[];
  const rows = await Promise.all(keys.map(k => listFor(ctx, k).catch(() => [] as R[])));
  const ds: any = { ...M.EMPTY };
  keys.forEach((k, i) => { ds[k] = rows[i]; });
  ds.users = (await (await import('./db')).q(`select id, name, role, status from users where org_id = $1`, [ctx.org])).rows;
  return ds;
}

/** Business analyst: Claude answers questions by calling read-only tools over the user's permitted records. */
export async function ask(ctx: Ctx, question: string, history: { role: 'user' | 'assistant'; content: string }[] = []) {
  if (!question?.trim()) throw new HttpError(400, 'Ask a question.');
  const trace: { tool: string; input: R; rows?: number }[] = [];
  const ds = await dataset(ctx);
  const names = { user: new Map(ds.users.map(u => [u.id, u.name])), stage: new Map(ctx.settings.stages.map(s => [s.id, s.name])) };
  const decorate = (entity: string, r: R) => {
    const o: R = { ...r }; delete o.custom; delete o.score_detail; delete o.checklist; delete o.org_id;
    for (const k of ['owner_id', 'assignee_id', 'user_id', 'coordinator_id', 'rep_id']) if (o[k]) o[k.replace('_id', '_name')] = names.user.get(o[k]) ?? null;
    if (entity === 'leads') { o.stage_name = names.stage.get(o.stage) ?? o.stage; o.seller = contactName(ds.contacts.find(c => c.id === o.contact_id)); o.property = propertyLabel(ds.properties.find(p => p.id === o.property_id)); }
    return o;
  };
  const listRecords = betaZodTool({
    name: 'list_records',
    description: `Fetch CRM records. Entities: ${QUERYABLE.join(', ')}. Use "fields" to keep results small. Filters are exact-match on a field, or use ops gte/lte/contains/empty/not_empty. Returns at most "limit" rows plus the total match count.`,
    inputSchema: z.object({
      entity: z.enum(QUERYABLE as [string, ...string[]]),
      filters: z.array(z.object({ field: z.string(), op: z.enum(['eq', 'neq', 'gte', 'lte', 'contains', 'empty', 'not_empty']), value: z.union([z.string(), z.number(), z.boolean()]).optional() })).optional(),
      fields: z.array(z.string()).optional(), sort_by: z.string().optional(), sort_dir: z.enum(['asc', 'desc']).optional(), limit: z.number().optional(),
    }),
    run: async input => {
      let rows = ((ds as any)[input.entity] as R[]).map(r => decorate(input.entity, r));
      for (const f of input.filters ?? []) rows = rows.filter(r => {
        const v = r[f.field], s = String(v ?? '').toLowerCase(), t = String(f.value ?? '').toLowerCase();
        switch (f.op) { case 'eq': return Array.isArray(v) ? v.map(x => String(x).toLowerCase()).includes(t) : s === t; case 'neq': return s !== t; case 'gte': return v != null && (typeof f.value === 'number' ? Number(v) >= f.value : s >= t);
          case 'lte': return v != null && (typeof f.value === 'number' ? Number(v) <= f.value : s <= t); case 'contains': return s.includes(t) || (Array.isArray(v) && v.some(x => String(x).toLowerCase().includes(t))); case 'empty': return v == null || v === ''; default: return v != null && v !== ''; }
      });
      if (input.sort_by) rows.sort((a, b) => { const x = a[input.sort_by!], y = b[input.sort_by!]; return (x == null ? 1 : y == null ? -1 : x < y ? -1 : x > y ? 1 : 0) * (input.sort_dir === 'desc' ? -1 : 1); });
      const total = rows.length, out = rows.slice(0, Math.min(input.limit ?? 50, 200)).map(r => (input.fields?.length ? Object.fromEntries(['id', ...input.fields].map(k => [k, r[k]])) : r));
      trace.push({ tool: 'list_records', input, rows: total });
      return JSON.stringify({ total_matching: total, returned: out.length, fields_available: ['id', 'created_at', ...ENTITY[input.entity].fields.map(f => f.k)], rows: out });
    },
  });
  const metrics = betaZodTool({
    name: 'business_metrics',
    description: 'Computed business metrics for a date range (ISO dates). report: overview (revenue, pipeline counts, conversion rates, timing), lead_sources, team, markets, campaigns, financials, buyers, dispositions. These use the exact same calculations as the CRM dashboards.',
    inputSchema: z.object({ report: z.enum(['overview', 'lead_sources', 'team', 'markets', 'campaigns', 'financials', 'buyers', 'dispositions']), from: z.string().optional(), to: z.string().optional() }),
    run: async input => {
      const f = { from: input.from, to: input.to ?? new Date().toISOString().slice(0, 10) };
      trace.push({ tool: 'business_metrics', input });
      const name = (id?: string | null) => names.user.get(id as string) ?? null;
      switch (input.report) {
        case 'overview': { const k = M.kpis(ds, f, ctx.settings); const n = (o: R) => Object.fromEntries(Object.entries(o).map(([key, v]) => [key, Array.isArray(v) ? v.length : v])); return JSON.stringify({ revenue: { ...k.revenue, rows: undefined }, pipeline_counts: n(k.pipeline), funnel: k.funnel, performance: { ...k.perf, followUpTasks: undefined }, open_transactions: k.openTxns.length }); }
        case 'lead_sources': return JSON.stringify(M.sourceStats(ds, f));
        case 'team': return JSON.stringify(M.teamStats(ds, f).map(t => ({ ...t, user: t.user.name, role: t.user.role })));
        case 'markets': return JSON.stringify(M.marketStats(ds, f).map(m => ({ ...m, market: m.market.name })));
        case 'campaigns': return JSON.stringify(M.campaignStats(ds, f).map(c => ({ ...c, campaign: c.campaign.name, source: c.campaign.source })));
        case 'financials': { const x = M.financials(ds, f); return JSON.stringify({ gross_assignment_revenue: x.gross, marketing_expenses: x.marketing, operating_expenses: x.operating, net_profit: x.net, deals: x.deals, avg_fee: x.avgFee, revenue_by_owner: [...M.groupBy(x.rev, r => name(r.ownerId) ?? 'Unassigned')].map(([k, v]) => ({ owner: k, revenue: M.sum(v, 'amount') })) }); }
        case 'buyers': return JSON.stringify(M.buyerStats(ds).map(b => ({ ...b, buyer: b.buyer.name, company: b.buyer.company })));
        default: return JSON.stringify(M.dispoStats(ds, f));
      }
    },
  });
  try {
    const final = await client().beta.messages.toolRunner({
      model: MODEL, max_tokens: 8000, max_iterations: 12, ...FALLBACK,
      output_config: { effort: 'medium' },
      system: `You are the business analyst inside a real estate wholesaling CRM. Today is ${new Date().toISOString().slice(0, 10)}. Answer questions using ONLY data returned by your tools — call them before answering; never estimate or invent numbers, names or records. If the data needed does not exist or the user's role cannot see it, say so plainly. State how you calculated each figure (which records, which date range, which formula) in one or two sentences. Name specific records (seller and address) when listing leads or deals. Pipeline stages in order: ${ctx.settings.stages.map(s => `${s.id}="${s.name}"`).join(', ')}. You are read-only: if the user asks you to change data, explain which screen does it instead. Keep answers concise; use a short markdown table when comparing more than three items.`,
      tools: [listRecords, metrics],
      messages: [...history.slice(-8).map(h => ({ role: h.role, content: h.content })), { role: 'user' as const, content: question }],
    } as any);
    if (final.stop_reason === 'refusal') throw new HttpError(502, 'The AI declined to answer this question.');
    return { answer: textOf(final), trace, model: final.model };
  } catch (e) { fail(e); }
}
