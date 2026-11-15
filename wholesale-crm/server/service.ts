// Service layer: validation, server-side authorization, audit logging and domain rules for every write.
// All writes — from the API, automations, sequences and imports — go through create/patch/destroy.
import { ENTITY, validate, type Role } from '../shared/schema';
import { mergeSettings, stageById, milestoneRank, MILESTONE_ORDER, isTerminal, type OrgSettings, type Resource, type Access } from '../shared/settings';
import { scoreLead, contactName, propertyLabel } from '../shared/logic';
import { one, q } from './db';
import * as repo from './repo';
import { HttpError } from './repo';

type R = Record<string, any>;
export interface User { id: string; org_id: string; email: string; name: string; role: Role; status: string }
export interface Ev { type: string; data: R; depth: number; chain: string[] }
export interface Ctx {
  org: string; user: User | null; settings: OrgSettings;
  origin: 'user' | 'automation' | 'system' | 'import';
  events: Ev[]; depth: number; chain: string[]; demo?: boolean; label?: string;
}

export async function loadSettings(org: string): Promise<OrgSettings> {
  const row = await one('select name, settings from organizations where id = $1', [org]);
  if (!row) throw new HttpError(404, 'Organization not found');
  return mergeSettings(row.settings, row.name);
}
export async function makeCtx(org: string, user: User | null, origin: Ctx['origin'] = user ? 'user' : 'system'): Promise<Ctx> {
  return { org, user, settings: await loadSettings(org), origin, events: [], depth: 0, chain: [] };
}
export const emit = (ctx: Ctx, type: string, data: R) => { ctx.events.push({ type, data, depth: ctx.depth, chain: ctx.chain }); };

// ---------- Authorization ----------
export function access(ctx: Ctx, resource: string, op: 'read' | 'write'): Access {
  if (!ctx.user) return 'all';
  if (resource === 'self') return 'own';
  return ctx.settings.permissions[ctx.user.role]?.[resource as Resource]?.[op] ?? 'none';
}
export const canDelete = (ctx: Ctx, resource: string) => !ctx.user || resource === 'self' || !!ctx.settings.permissions[ctx.user.role]?.[resource as Resource]?.delete;
export function assertAccess(ctx: Ctx, resource: string, op: 'read' | 'write') {
  const a = access(ctx, resource, op);
  if (a === 'none') throw new HttpError(403, `Your role (${ctx.user?.role}) does not have ${op} access to ${resource}.`);
  return a;
}
function ownsRecord(ctx: Ctx, name: string, row: R) {
  const of = ENTITY[name].ownerField;
  return !of || !ctx.user || row[of] === ctx.user.id || (name === 'saved_views' && row.shared);
}

export async function listFor(ctx: Ctx, name: string, where: R = {}): Promise<R[]> {
  const e = repo.ent(name);
  const a = assertAccess(ctx, e.resource, 'read');
  let rows = await repo.list(ctx.org, name, where, name === 'activities' || name === 'audit_logs' || name === 'automation_runs' || name === 'integration_logs' ? { limit: 3000 } : {});
  if (a === 'own') {
    if (e.ownerField) rows = rows.filter(r => ownsRecord(ctx, name, r));
    else if (['contacts', 'activities', 'enrollments'].includes(name) && e.resource === 'leads') {
      // Records that hang off leads inherit lead ownership.
      const mine = await repo.list(ctx.org, 'leads', { owner_id: ctx.user!.id });
      const leadIds = new Set(mine.map(l => l.id)), contactIds = new Set(mine.map(l => l.contact_id));
      rows = rows.filter(r => (name === 'contacts' ? contactIds.has(r.id) || r.created_by === ctx.user!.id : leadIds.has(r.lead_id)));
    }
  }
  return rows;
}
export async function getFor(ctx: Ctx, name: string, id: string, op: 'read' | 'write' = 'read'): Promise<R> {
  const e = repo.ent(name);
  const a = assertAccess(ctx, e.resource, op);
  const row = await repo.get(ctx.org, name, id);
  if (!row) throw new HttpError(404, `${e.label} not found`);
  if (a === 'own' && !ownsRecord(ctx, name, row)) throw new HttpError(403, `You can only ${op === 'read' ? 'view' : 'change'} ${e.plural.toLowerCase()} assigned to you.`);
  return row;
}

// ---------- Helpers used by domain rules ----------
export async function logActivity(ctx: Ctx, a: R) {
  return repo.insert(ctx.org, 'activities', { at: new Date().toISOString(), user_id: ctx.user?.id ?? null, ...a }, { userId: ctx.user?.id, demo: ctx.demo });
}
export async function audit(ctx: Ctx, action: string, entity: string, id: string, summary: string, changes?: R) {
  await repo.insert(ctx.org, 'audit_logs', { user_id: ctx.user?.id ?? null, action, entity, entity_id: id, summary: summary.slice(0, 480), changes: changes ?? null }, { demo: ctx.demo });
}
export async function notify(ctx: Ctx, to: string | { role: string | string[] } | null | undefined, title: string, body: string, link: string, dedupe?: string) {
  if (!to) return 0;
  let ids: string[];
  if (typeof to === 'string') ids = [to];
  else { const roles = Array.isArray(to.role) ? to.role : [to.role]; ids = (await q(`select id from users where org_id = $1 and status = 'active' and role = any($2)`, [ctx.org, roles])).rows.map(r => r.id); }
  let n = 0;
  for (const uid of ids) {
    if (dedupe && await one('select 1 from notifications where org_id = $1 and user_id = $2 and dedupe = $3', [ctx.org, uid, dedupe])) continue;
    await repo.insert(ctx.org, 'notifications', { user_id: uid, title, body, link, read: false, dedupe: dedupe ?? null }, { demo: ctx.demo }); n++;
  }
  return n;
}

export async function rescoreLead(ctx: Ctx, leadId?: string | null) {
  if (!leadId) return;
  const lead = await repo.get(ctx.org, 'leads', leadId);
  if (!lead) return;
  const property = await repo.get(ctx.org, 'properties', lead.property_id);
  const s = await one(`select count(*)::int as n, count(*) filter (where direction = 'Inbound')::int as inbound from communications where org_id = $1 and lead_id = $2`, [ctx.org, leadId]);
  const t = await one(`select count(*) filter (where due_at < now())::int as overdue, count(*)::int as open from tasks where org_id = $1 and lead_id = $2 and status in ('Open','In Progress')`, [ctx.org, leadId]);
  const res = scoreLead(lead, property, { comms: s.n, inbound: s.inbound, lastContactAt: lead.last_contact_at, hasFollowUp: t.open > t.overdue, overdueTasks: t.overdue }, ctx.settings.scoring);
  if (res.score !== lead.score || !lead.score_detail) {
    await repo.update(ctx.org, 'leads', leadId, { score: res.score, score_detail: res });
    if (lead.score !== null && lead.score !== res.score) emit(ctx, 'lead.score_updated', { lead_id: leadId, from: lead.score, to: res.score });
  }
}

/** lead.next_follow_up is always the earliest open task due date for the lead. */
export async function syncFollowUp(ctx: Ctx, leadId?: string | null) {
  if (!leadId) return;
  const r = await one(`select min(due_at) as d from tasks where org_id = $1 and lead_id = $2 and status in ('Open','In Progress') and due_at is not null`, [ctx.org, leadId]);
  await q('update leads set next_follow_up = $3 where org_id = $1 and id = $2', [ctx.org, leadId, r?.d ?? null]);
}

export async function stopEnrollments(ctx: Ctx, leadId: string, reason: string, status: 'Paused' | 'Stopped' = 'Stopped') {
  const rows = (await q(`update enrollments set status = $3, stop_reason = $4, next_run_at = null, updated_at = now() where org_id = $1 and lead_id = $2 and status = 'Active' returning id`, [ctx.org, leadId, status, reason])).rows;
  if (rows.length) await logActivity(ctx, { type: 'sequence', summary: `Follow-up sequence ${status.toLowerCase()}: ${reason}`, lead_id: leadId });
  return rows.length;
}

/** Moves a lead forward to the first stage of a milestone if it has not reached it yet (never backwards). */
export async function advanceLead(ctx: Ctx, leadId: string | null | undefined, target: { stageId?: string; milestone?: string }, why: string) {
  if (!leadId) return;
  const lead = await repo.get(ctx.org, 'leads', leadId);
  if (!lead) return;
  const cur = stageById(ctx.settings, lead.stage);
  const dest = (target.stageId && stageById(ctx.settings, target.stageId)) || ctx.settings.stages.find(s => s.milestone === target.milestone);
  if (!dest || !cur || cur.milestone === 'dead' || cur.milestone === 'closed' && dest.milestone !== 'closed') return;
  const ci = ctx.settings.stages.indexOf(cur), di = ctx.settings.stages.indexOf(dest);
  if (di <= ci) return;
  await patch(ctx, 'leads', leadId, { stage: dest.id }, { system: true, note: why });
}

const today = () => new Date().toISOString().slice(0, 10);
const nowIso = () => new Date().toISOString();

// ---------- Domain rules (before/after save) ----------
type Hook = { before?: (ctx: Ctx, data: R, prev: R | null) => Promise<void>; after?: (ctx: Ctx, row: R, prev: R | null, opts: WriteOpts) => Promise<void>; removed?: (ctx: Ctx, row: R) => Promise<void> };

function consentStamps(data: R, prev: R | null) {
  for (const ch of ['sms', 'email']) {
    const k = `${ch}_opt_in`;
    if (data[k] === undefined) continue;
    if (data[k] && !prev?.[k]) data[`${k}_at`] = nowIso();
    if (!data[k] && prev?.[k]) data.opted_out_at = nowIso();
  }
  if (data.dnc && !prev?.dnc) data.opted_out_at = nowIso();
}
async function suppress(ctx: Ctx, person: R, reason: string) {
  for (const [kind, value] of [['Phone', person.phone], ['Phone', person.phone2], ['Email', person.email]] as const) {
    if (!value) continue;
    if (!(await one('select 1 from suppressions where org_id = $1 and kind = $2 and value = $3', [ctx.org, kind, value])))
      await repo.insert(ctx.org, 'suppressions', { kind, value, reason, source: 'Do not contact' }, { userId: ctx.user?.id, demo: person.is_demo });
  }
}

const hooks: Record<string, Hook> = {
  contacts: {
    before: async (_c, data, prev) => consentStamps(data, prev),
    after: async (ctx, row, prev) => {
      if (row.dnc && !prev?.dnc) {
        await suppress(ctx, row, 'Marked do not contact');
        for (const l of await repo.list(ctx.org, 'leads', { contact_id: row.id })) {
          await stopEnrollments(ctx, l.id, 'Seller marked do not contact');
          if (l.classification !== 'Do not contact') await repo.update(ctx.org, 'leads', l.id, { classification: 'Do not contact' });
          await logActivity(ctx, { type: 'compliance', summary: 'Seller marked Do Not Contact — all outreach and sequences blocked', lead_id: l.id, contact_id: row.id });
        }
      }
    },
  },
  buyers: {
    before: async (_c, data, prev) => { consentStamps(data, prev); if (data.pof_status === 'Verified' && prev?.pof_status !== 'Verified' && !data.pof_verified_on) data.pof_verified_on = today(); },
    after: async (ctx, row, prev) => {
      if (row.dnc && !prev?.dnc) await suppress(ctx, row, 'Buyer marked do not contact');
      if (!prev) await logActivity(ctx, { type: 'created', summary: `Buyer added: ${row.name}`, buyer_id: row.id });
      else if (row.pof_status !== prev.pof_status) await logActivity(ctx, { type: 'update', summary: `Proof of funds: ${prev.pof_status ?? 'none'} → ${row.pof_status}`, buyer_id: row.id });
    },
  },
  properties: {
    before: async (ctx, data, prev) => {
      const merged = { ...prev, ...data };
      if (!merged.market_id && (merged.zip || merged.city || merged.county)) {
        const lc = (v: unknown) => String(v ?? '').toLowerCase();
        const has = (arr: unknown, v: unknown) => !!v && Array.isArray(arr) && arr.some(x => lc(x) === lc(v));
        const markets = await repo.list(ctx.org, 'markets');
        const m = markets.find(m => has(m.zips, merged.zip)) ?? markets.find(m => has(m.cities, merged.city)) ?? markets.find(m => has(m.counties, merged.county));
        if (m) data.market_id = m.id;
      }
    },
    after: async (ctx, row, prev) => {
      if (!prev) await logActivity(ctx, { type: 'created', summary: `Property added: ${propertyLabel(row)}`, property_id: row.id });
      else for (const l of await repo.list(ctx.org, 'leads', { property_id: row.id })) await rescoreLead(ctx, l.id);
    },
  },
  leads: {
    before: async (ctx, data, prev) => {
      const s = ctx.settings;
      if (!prev) {
        data.stage ??= s.stages[0]?.id;
        data.stage_changed_at = nowIso();
        if (data.owner_id === undefined && ctx.user && ctx.origin === 'user') data.owner_id = ctx.user.id;
      }
      if (data.stage !== undefined && data.stage !== prev?.stage) {
        const st = stageById(s, data.stage);
        if (!st) throw new HttpError(400, `Unknown pipeline stage "${data.stage}"`);
        const from = stageById(s, prev?.stage);
        if (prev && ctx.origin === 'user' && from?.allowedNext?.length && !from.allowedNext.includes(st.id))
          throw new HttpError(422, `Leads cannot move from "${from.name}" directly to "${st.name}". Allowed next stages: ${from.allowedNext.map(id => stageById(s, id)?.name ?? id).join(', ')}.`);
        const merged = { ...prev, ...data };
        const missing = (st.requires ?? []).filter(k => merged[k] === null || merged[k] === undefined || merged[k] === '' || merged[k] === 'Unknown');
        if (prev && missing.length) {
          const labels = missing.map(k => ENTITY.leads.fields.find(f => f.k === k)?.label ?? k);
          throw new HttpError(422, `To move this lead to "${st.name}", first fill in: ${labels.join(', ')}.`, { missing, stage: st.id });
        }
        const now = nowIso();
        data.stage_changed_at = now;
        if (st.milestone === 'dead') data.dead_at = now;
        else {
          if (prev?.dead_at) { data.dead_at = null; data.dead_reason = null; }
          const rank = milestoneRank(st.milestone);
          const stamp: Record<string, string> = { contacted: 'contacted_at', qualified: 'qualified_at', offer: 'offer_at', contract: 'contract_at', closed: 'closed_at' };
          for (const m of MILESTONE_ORDER.slice(1, rank + 1)) if (!merged[stamp[m]]) data[stamp[m]] = now;
          if (st.milestone === 'contract' && s.leadStatuses.includes('Under contract')) data.classification = 'Under contract';
          if (st.milestone === 'closed' && s.leadStatuses.includes('Closed')) data.classification = 'Closed';
        }
      }
      if (data.motivation && data.motivation !== prev?.motivation && data.classification === undefined) {
        const cur = prev?.classification;
        if (!cur || /motivation$/.test(cur)) { const c = `${data.motivation} motivation`; if (s.leadStatuses.includes(c)) data.classification = c; }
      }
    },
    after: async (ctx, row, prev, opts) => {
      const s = ctx.settings, st = stageById(s, row.stage);
      if (!prev) {
        const contact = await repo.get(ctx.org, 'contacts', row.contact_id);
        await logActivity(ctx, { type: 'created', summary: `Lead created${row.source ? ` from ${row.source}` : ''}`, lead_id: row.id, property_id: row.property_id, contact_id: row.contact_id, data: { origin: ctx.origin } });
        if (row.property_id && !(await one('select 1 from property_contacts where property_id = $1 and contact_id = $2', [row.property_id, row.contact_id])))
          await repo.insert(ctx.org, 'property_contacts', { property_id: row.property_id, contact_id: row.contact_id, role: 'Owner' }, { userId: ctx.user?.id, demo: row.is_demo });
        emit(ctx, 'lead.created', { lead_id: row.id });
        if (row.owner_id) { emit(ctx, 'lead.assigned', { lead_id: row.id, to: row.owner_id }); if (row.owner_id !== ctx.user?.id && s.notifications.newLeadAssigned) await notify(ctx, row.owner_id, 'New lead assigned to you', contactName(contact), `/leads/${row.id}`); }
      } else {
        if (row.stage !== prev.stage) {
          const from = stageById(s, prev.stage);
          await logActivity(ctx, { type: 'stage', summary: `Stage: ${from?.name ?? prev.stage} → ${st?.name ?? row.stage}`, body: opts.note ?? (row.dead_reason && st?.milestone === 'dead' ? `Reason: ${row.dead_reason}` : null), lead_id: row.id, property_id: row.property_id, data: { from: prev.stage, to: row.stage, automatic: ctx.origin !== 'user' || !!opts.system } });
          emit(ctx, 'lead.stage_changed', { lead_id: row.id, from: prev.stage, to: row.stage });
          if (isTerminal(s, row.stage)) await stopEnrollments(ctx, row.id, `Lead moved to ${st?.name}`);
          if (row.owner_id && row.owner_id !== ctx.user?.id && s.notifications.stageChanges) await notify(ctx, row.owner_id, `Lead moved to ${st?.name}`, opts.note ?? 'Stage updated', `/leads/${row.id}`);
        }
        if (row.owner_id !== prev.owner_id) {
          const u = row.owner_id ? await one('select name from users where id = $1 and org_id = $2', [row.owner_id, ctx.org]) : null;
          await logActivity(ctx, { type: 'assignment', summary: u ? `Assigned to ${u.name}` : 'Unassigned', lead_id: row.id });
          if (row.owner_id) { emit(ctx, 'lead.assigned', { lead_id: row.id, to: row.owner_id }); if (row.owner_id !== ctx.user?.id && s.notifications.newLeadAssigned) await notify(ctx, row.owner_id, 'Lead assigned to you', 'Open the lead to review its history', `/leads/${row.id}`); }
        }
        if (row.property_id && row.property_id !== prev.property_id && !(await one('select 1 from property_contacts where property_id = $1 and contact_id = $2', [row.property_id, row.contact_id])))
          await repo.insert(ctx.org, 'property_contacts', { property_id: row.property_id, contact_id: row.contact_id, role: 'Owner' }, { userId: ctx.user?.id, demo: row.is_demo });
        if (row.classification === 'Do not contact' && prev.classification !== 'Do not contact') await patch(ctx, 'contacts', row.contact_id, { dnc: true }, { system: true });
        if (row.classification === 'Unqualified' && prev.classification !== 'Unqualified') await stopEnrollments(ctx, row.id, 'Lead marked unqualified');
      }
      await rescoreLead(ctx, row.id);
    },
  },
  communications: {
    before: async (ctx, data, prev) => {
      if (prev) return;
      data.at ??= nowIso();
      data.user_id ??= ctx.user?.id ?? null;
      if (data.lead_id) {
        const lead = await repo.get(ctx.org, 'leads', data.lead_id);
        if (lead) { data.contact_id ??= lead.contact_id; data.property_id ??= lead.property_id; }
      }
      if (!data.contact_id && !data.buyer_id) throw new HttpError(400, 'Choose the seller, buyer or lead this communication is with.');
    },
    after: async (ctx, row, prev) => {
      if (prev) return;
      const who = row.direction === 'Inbound' ? 'Incoming' : row.direction === 'Missed' ? 'Missed' : 'Outgoing';
      const summary = `${who} ${String(row.type).toLowerCase()}${row.outcome ? ` — ${row.outcome}` : ''}`;
      if (row.buyer_id) await logActivity(ctx, { type: 'comm', summary, body: row.body, buyer_id: row.buyer_id, data: { comm_id: row.id }, at: row.at });
      const noConversation = row.direction === 'Missed' || ['No answer', 'Left voicemail', 'Wrong number'].includes(row.outcome) || row.type === 'Voicemail';
      const leads = row.lead_id ? [await repo.get(ctx.org, 'leads', row.lead_id)] : row.contact_id ? (await repo.list(ctx.org, 'leads', { contact_id: row.contact_id })).filter(l => !isTerminal(ctx.settings, l.stage)) : [];
      for (const lead of leads) {
        if (!lead) continue;
        await logActivity(ctx, { type: 'comm', summary, body: row.body, lead_id: lead.id, contact_id: row.contact_id, property_id: lead.property_id, data: { comm_id: row.id, type: row.type, direction: row.direction, outcome: row.outcome }, at: row.at });
        const upd: R = {};
        if (row.direction !== 'Missed' && (!lead.last_contact_at || row.at > lead.last_contact_at)) upd.last_contact_at = row.at;
        if (row.direction === 'Outbound' && !lead.first_contact_at) upd.first_contact_at = row.at;
        if (Object.keys(upd).length) await repo.update(ctx.org, 'leads', lead.id, upd);
        if (row.direction === 'Inbound') await stopEnrollments(ctx, lead.id, 'Seller responded', 'Paused');
        const m = stageById(ctx.settings, lead.stage)?.milestone;
        if (m === 'lead') {
          if (!noConversation && ['Call', 'In Person', 'SMS', 'Email'].includes(row.type) && (row.direction === 'Inbound' || ['Call', 'In Person'].includes(row.type)))
            await advanceLead(ctx, lead.id, { milestone: 'contacted' }, 'Automatically advanced: first conversation logged');
          else if (row.direction === 'Outbound' && lead.stage === ctx.settings.stages[0]?.id && ctx.settings.stages[1]?.milestone === 'lead')
            await advanceLead(ctx, lead.id, { stageId: ctx.settings.stages[1].id }, 'Automatically advanced: first contact attempt logged');
        }
        if (row.follow_up_at) await create(ctx, 'tasks', { title: row.next_action || 'Follow up with seller', category: 'Follow up', due_at: row.follow_up_at, lead_id: lead.id, assignee_id: lead.owner_id ?? row.user_id, origin: 'Call log' }, { system: true });
        await rescoreLead(ctx, lead.id);
      }
      if (row.outcome === 'Do not contact') {
        if (row.contact_id) await patch(ctx, 'contacts', row.contact_id, { dnc: true }, { system: true });
        if (row.buyer_id) await patch(ctx, 'buyers', row.buyer_id, { dnc: true }, { system: true });
      }
    },
  },
  tasks: {
    before: async (ctx, data, prev) => {
      if (!prev) { data.assignee_id ??= ctx.user?.id ?? null; data.status ??= 'Open'; }
      if (data.status === 'Done' && prev?.status !== 'Done') data.completed_at = nowIso();
      if (data.status && data.status !== 'Done' && prev?.status === 'Done') data.completed_at = null;
      if (data.due_at && data.due_at !== prev?.due_at) data.reminded = false;
    },
    after: async (ctx, row, prev) => {
      if (row.status === 'Done' && prev && prev.status !== 'Done') {
        emit(ctx, 'task.completed', { task_id: row.id, lead_id: row.lead_id });
        if (row.lead_id) await logActivity(ctx, { type: 'task', summary: `Task completed: ${row.title}`, lead_id: row.lead_id });
      }
      if (!prev && row.assignee_id && row.assignee_id !== ctx.user?.id && ctx.origin === 'user') await notify(ctx, row.assignee_id, 'Task assigned to you', row.title, '/tasks');
      for (const id of new Set([row.lead_id, prev?.lead_id])) if (id) { await syncFollowUp(ctx, id); await rescoreLead(ctx, id); }
    },
    removed: async (ctx, row) => { await syncFollowUp(ctx, row.lead_id); },
  },
  analyses: {
    after: async (ctx, row, prev) => {
      if (!prev) await logActivity(ctx, { type: 'analysis', summary: `Deal analysis saved: ${row.name} — ${row.rating ?? ''}${row.mao ? `, MAO $${Math.round(row.mao).toLocaleString()}` : ''}`, lead_id: row.lead_id, property_id: row.property_id, data: { analysis_id: row.id } });
    },
  },
  offers: {
    before: async (ctx, data, prev) => {
      if (!prev) {
        data.offer_date ??= today(); data.owner_id ??= ctx.user?.id ?? null;
        if (data.lead_id && !data.contact_id) data.contact_id = (await repo.get(ctx.org, 'leads', data.lead_id))?.contact_id ?? null;
        if (!data.lead_id && data.property_id) {
          const l = (await repo.list(ctx.org, 'leads', { property_id: data.property_id })).find(l => !isTerminal(ctx.settings, l.stage));
          if (l) { data.lead_id = l.id; data.contact_id ??= l.contact_id; }
        }
      }
    },
    after: async (ctx, row, prev) => {
      const amt = `$${Math.round(row.amount).toLocaleString()}`;
      const base = { lead_id: row.lead_id, property_id: row.property_id, data: { offer_id: row.id } };
      if (!prev) {
        await logActivity(ctx, { type: 'offer', summary: `${row.from_party === 'Seller' ? 'Seller counteroffer' : 'Offer'} ${amt} recorded (${row.status})`, ...base });
        if (row.parent_id) { const p = await repo.get(ctx.org, 'offers', row.parent_id); if (p && ['Presented', 'Pending Approval', 'Draft'].includes(p.status)) await repo.update(ctx.org, 'offers', p.id, { status: 'Countered' }); }
      } else if (row.status !== prev.status) await logActivity(ctx, { type: 'offer', summary: `Offer ${amt}: ${prev.status} → ${row.status}`, ...base });
      const became = (s: string) => row.status === s && prev?.status !== s;
      if (row.from_party !== 'Seller' && became('Presented')) { emit(ctx, 'offer.submitted', { offer_id: row.id, lead_id: row.lead_id }); await advanceLead(ctx, row.lead_id, { milestone: 'offer' }, `Offer of ${amt} presented`); }
      if (row.from_party === 'Seller' && !prev) await advanceLead(ctx, row.lead_id, { stageId: 'negotiating' }, `Seller countered at ${amt}`);
      if (became('Accepted')) emit(ctx, 'offer.accepted', { offer_id: row.id, lead_id: row.lead_id });
    },
  },
  contracts: {
    before: async (ctx, data, prev) => {
      const m = { ...prev, ...data };
      if (!prev && m.lead_id && !m.contact_id) data.contact_id = (await repo.get(ctx.org, 'leads', m.lead_id))?.contact_id ?? null;
      const isAssign = m.type === 'Assignment Agreement';
      const signed = m.company_signed && (isAssign ? m.buyer_signed : m.seller_signed);
      if (signed && ['Draft', 'Sent', 'Awaiting Signature'].includes(m.status ?? 'Draft') && (data.seller_signed !== undefined || data.buyer_signed !== undefined || data.company_signed !== undefined)) data.status = 'Fully Executed';
      if (data.status === 'Fully Executed' && prev?.status !== 'Fully Executed') {
        data.effective_date ??= m.effective_date ?? today();
        if (isAssign && !m.buyer_id) throw new HttpError(422, 'An assignment agreement needs a buyer before it can be executed.');
      }
      if (m.assignment_price != null && m.purchase_price != null && data.assignment_fee === undefined && (data.assignment_price !== undefined || data.purchase_price !== undefined)) data.assignment_fee = m.assignment_price - m.purchase_price;
    },
    after: async (ctx, row, prev) => {
      const base = { lead_id: row.lead_id, property_id: row.property_id, transaction_id: row.transaction_id, data: { contract_id: row.id } };
      if (!prev) await logActivity(ctx, { type: 'contract', summary: `${row.type} created (${row.status})`, ...base });
      else if (row.status !== prev.status) await logActivity(ctx, { type: 'contract', summary: `${row.type}: ${prev.status} → ${row.status}`, ...base });
      if (row.status === 'Fully Executed' && prev?.status !== 'Fully Executed') {
        if (row.type === 'Assignment Agreement') {
          if (row.transaction_id) await patch(ctx, 'transactions', row.transaction_id, { status: 'Assigned', buyer_id: row.buyer_id, assignment_price: row.assignment_price, assignment_fee: row.assignment_fee }, { system: true });
          for (const d of await repo.list(ctx.org, 'dispositions', { property_id: row.property_id })) if (['Active', 'Buyer Selected'].includes(d.status)) await patch(ctx, 'dispositions', d.id, { status: 'Assigned' }, { system: true });
          await advanceLead(ctx, row.lead_id, { stageId: 'closing' }, 'Assignment agreement executed');
        } else {
          const txn = await ensureTransaction(ctx, row);
          await advanceLead(ctx, row.lead_id, { milestone: 'contract' }, 'Purchase agreement fully executed');
          emit(ctx, 'contract.signed', { contract_id: row.id, lead_id: row.lead_id, transaction_id: txn?.id });
        }
      }
      if (row.status === 'Terminated' && prev && prev.status !== 'Terminated') await notify(ctx, { role: ['Owner', 'Administrator', 'Transaction Coordinator'] }, 'Contract terminated', row.type, `/contracts?open=${row.id}`);
    },
  },
  dispositions: {
    before: async (ctx, data, prev) => {
      if (prev) { if (data.status && ['Closed', 'Cancelled'].includes(data.status) && !prev.ended_on) data.ended_on = today(); if (data.status === 'Assigned' && !prev.ended_on) data.ended_on = today(); return; }
      data.started_on ??= today(); data.owner_id ??= ctx.user?.id ?? null;
      const open = (await repo.list(ctx.org, 'dispositions', { property_id: data.property_id })).find(d => ['Draft', 'Active', 'Buyer Selected'].includes(d.status));
      if (open) throw new HttpError(409, 'This property already has an open disposition campaign.');
      const txn = data.transaction_id ? await repo.get(ctx.org, 'transactions', data.transaction_id) : (await repo.list(ctx.org, 'transactions', { property_id: data.property_id })).find(t => !['Closed', 'Cancelled'].includes(t.status));
      if (txn) { data.transaction_id = txn.id; data.lead_id ??= txn.lead_id; data.purchase_price ??= txn.purchase_price; }
      if (!data.contract_id) data.contract_id = (await repo.list(ctx.org, 'contracts', { property_id: data.property_id })).find(c => c.type === 'Purchase Agreement' && !['Terminated', 'Draft'].includes(c.status))?.id ?? null;
      if (data.fee_target == null && data.purchase_price != null) data.fee_target = data.asking_price - data.purchase_price;
    },
    after: async (ctx, row, prev) => {
      const base = { lead_id: row.lead_id, property_id: row.property_id, disposition_id: row.id, transaction_id: row.transaction_id };
      if (!prev) {
        await logActivity(ctx, { type: 'dispo', summary: `Disposition campaign started — asking $${Math.round(row.asking_price).toLocaleString()}`, ...base });
        if (row.transaction_id) { const t = await repo.get(ctx.org, 'transactions', row.transaction_id); if (t && ['Under Contract', 'Title Opened'].includes(t.status)) await patch(ctx, 'transactions', t.id, { status: 'Marketing to Buyers' }, { system: true }); }
        await advanceLead(ctx, row.lead_id, { stageId: 'disposition' }, 'Disposition campaign started');
        emit(ctx, 'dispo.created', { disposition_id: row.id, lead_id: row.lead_id });
      } else if (row.status !== prev.status) await logActivity(ctx, { type: 'dispo', summary: `Disposition: ${prev.status} → ${row.status}`, ...base });
    },
  },
  buyer_interests: {
    before: async (_ctx, data, prev) => {
      const st = data.status ?? prev?.status;
      if (data.offer_amount != null && data.offer_amount !== prev?.offer_amount && ['Matched', 'Sent', 'Opened', 'Responded', 'Requested Info', 'Showing Requested'].includes(st ?? 'Matched')) data.status = 'Offer Made';
      const s2 = data.status ?? prev?.status;
      if (s2 && s2 !== 'Matched' && !prev?.sent_at && !data.sent_at) data.sent_at = nowIso();
      if (s2 && !['Matched', 'Sent', 'Opened'].includes(s2) && !prev?.responded_at && !data.responded_at) data.responded_at = nowIso();
    },
    after: async (ctx, row, prev) => {
      if (prev && row.status === prev.status && row.offer_amount === prev.offer_amount) return;
      const b = await repo.get(ctx.org, 'buyers', row.buyer_id), d = await repo.get(ctx.org, 'dispositions', row.disposition_id);
      const text = row.status === 'Offer Made' && row.offer_amount ? `offered $${Math.round(row.offer_amount).toLocaleString()}` : `status: ${row.status}`;
      if (prev || row.status !== 'Matched') await logActivity(ctx, { type: 'dispo', summary: `${b?.name ?? 'Buyer'} — ${text}`, body: row.feedback, disposition_id: row.disposition_id, buyer_id: row.buyer_id, property_id: d?.property_id, lead_id: d?.lead_id });
    },
  },
  transactions: {
    before: async (ctx, data, prev) => {
      const m = { ...prev, ...data };
      if (!prev) data.checklist ??= ctx.settings.transactionChecklist.map(label => ({ label, done: false }));
      if (m.assignment_price != null && m.purchase_price != null && data.assignment_fee === undefined && (data.assignment_price !== undefined || data.purchase_price !== undefined)) data.assignment_fee = m.assignment_price - m.purchase_price;
      if (data.status === 'Closed' && prev?.status !== 'Closed') {
        if (m.assignment_fee == null) throw new HttpError(422, 'Enter the assignment fee (or the purchase and buyer prices) before closing this transaction.');
        data.closed_on ??= m.closed_on ?? today();
      }
    },
    after: async (ctx, row, prev) => {
      const base = { lead_id: row.lead_id, property_id: row.property_id, transaction_id: row.id };
      if (!prev) await logActivity(ctx, { type: 'transaction', summary: 'Transaction opened', ...base });
      else if (row.status !== prev.status) await logActivity(ctx, { type: 'transaction', summary: `Transaction: ${prev.status} → ${row.status}`, ...base });
      if (row.status === 'Closed' && prev?.status !== 'Closed') {
        if (!(await one('select 1 from revenue where org_id = $1 and transaction_id = $2', [ctx.org, row.id])))
          await repo.insert(ctx.org, 'revenue', { transaction_id: row.id, amount: row.assignment_fee, date: row.closed_on, type: 'Assignment Fee' }, { userId: ctx.user?.id, demo: row.is_demo });
        await logActivity(ctx, { type: 'revenue', summary: `Deal closed — assignment fee $${Math.round(row.assignment_fee).toLocaleString()} recorded`, ...base });
        for (const c of await repo.list(ctx.org, 'contracts', { transaction_id: row.id })) if (!['Closed', 'Terminated'].includes(c.status)) await repo.update(ctx.org, 'contracts', c.id, { status: 'Closed' });
        for (const d of await repo.list(ctx.org, 'dispositions', { transaction_id: row.id })) if (!['Closed', 'Cancelled'].includes(d.status)) await patch(ctx, 'dispositions', d.id, { status: 'Closed' }, { system: true });
        await advanceLead(ctx, row.lead_id, { milestone: 'closed' }, 'Transaction closed');
        emit(ctx, 'transaction.closed', { transaction_id: row.id, lead_id: row.lead_id });
        await notify(ctx, { role: ['Owner', 'Administrator'] }, 'Deal closed', `Assignment fee $${Math.round(row.assignment_fee).toLocaleString()}`, `/transactions?open=${row.id}`);
      }
      if (row.status === 'Cancelled' && prev && prev.status !== 'Cancelled')
        for (const d of await repo.list(ctx.org, 'dispositions', { transaction_id: row.id })) if (!['Closed', 'Cancelled'].includes(d.status)) await patch(ctx, 'dispositions', d.id, { status: 'Cancelled' }, { system: true });
    },
  },
};

/** A fully executed purchase agreement always has a transaction. Idempotent. */
export async function ensureTransaction(ctx: Ctx, contract: R): Promise<R | null> {
  if (contract.transaction_id) return repo.get(ctx.org, 'transactions', contract.transaction_id);
  let txn = (await repo.list(ctx.org, 'transactions', { property_id: contract.property_id })).find(t => !['Closed', 'Cancelled'].includes(t.status)) ?? null;
  if (!txn) {
    const coord = await one(`select id from users where org_id = $1 and status = 'active' and role = 'Transaction Coordinator' order by created_at limit 1`, [ctx.org]);
    txn = await create(ctx, 'transactions', { property_id: contract.property_id, lead_id: contract.lead_id, contact_id: contract.contact_id, purchase_price: contract.purchase_price,
      title_company: contract.title_company, closing_date: contract.closing_date, coordinator_id: coord?.id ?? null, status: 'Under Contract' }, { system: true });
  }
  await repo.update(ctx.org, 'contracts', contract.id, { transaction_id: txn!.id });
  return txn;
}

// ---------- Generic writes ----------
export interface WriteOpts { system?: boolean; note?: string }

const describe = (name: string, row: R) => row.name ?? row.title ?? row.address ?? ([row.first_name, row.last_name].filter(Boolean).join(' ') || `${ENTITY[name].label} ${String(row.id).slice(0, 8)}`);

async function checkRefs(ctx: Ctx, name: string, data: R) {
  for (const f of ENTITY[name].fields) {
    if (f.t !== 'ref' || !data[f.k]) continue;
    const ok = f.ref === 'users' ? await one('select 1 from users where id = $1 and org_id = $2', [data[f.k], ctx.org]) : await one(`select 1 from ${f.ref} where id = $1 and org_id = $2`, [data[f.k], ctx.org]);
    if (!ok) throw new HttpError(400, `${f.label} does not exist`);
  }
}

export async function create(ctx: Ctx, name: string, input: R, opts: WriteOpts = {}): Promise<R> {
  const e = repo.ent(name);
  if (!opts.system) {
    const a = assertAccess(ctx, e.resource, 'write');
    if (a === 'own' && e.ownerField && ctx.user) input = { ...input, [e.ownerField]: input[e.ownerField] ?? ctx.user.id };
    if (a === 'own' && e.ownerField && input[e.ownerField] !== ctx.user?.id) throw new HttpError(403, `You can only create ${e.plural.toLowerCase()} assigned to yourself.`);
  }
  const v = validate(e, input, { includeSystem: opts.system || ctx.origin !== 'user' });
  if (!v.ok) throw new HttpError(400, Object.values(v.errors)[0], { fields: v.errors });
  const data = v.data;
  if (e.ownerField === 'user_id' && e.resource === 'self') data.user_id = ctx.user?.id ?? data.user_id;
  await hooks[name]?.before?.(ctx, data, null);
  await checkRefs(ctx, name, data);
  const row = await repo.insert(ctx.org, name, data, { userId: ctx.user?.id, demo: ctx.demo });
  await hooks[name]?.after?.(ctx, row, null, opts);
  if (e.audit) await audit(ctx, 'create', name, row.id, `Created ${e.label.toLowerCase()}: ${describe(name, row)}`);
  return (await repo.get(ctx.org, name, row.id)) ?? row;
}

export async function patch(ctx: Ctx, name: string, id: string, input: R, opts: WriteOpts = {}): Promise<R> {
  const e = repo.ent(name);
  const prev = opts.system ? await repo.get(ctx.org, name, id) : await getFor(ctx, name, id, 'write');
  if (!prev) throw new HttpError(404, `${e.label} not found`);
  const v = validate(e, input, { partial: true, includeSystem: opts.system || ctx.origin !== 'user' });
  if (!v.ok) throw new HttpError(400, Object.values(v.errors)[0], { fields: v.errors });
  const data = v.data;
  if (!opts.system && access(ctx, e.resource, 'write') === 'own' && e.ownerField && data[e.ownerField] !== undefined && data[e.ownerField] !== ctx.user?.id)
    throw new HttpError(403, 'Your role cannot reassign records to other team members.');
  await hooks[name]?.before?.(ctx, data, prev);
  await checkRefs(ctx, name, data);
  if (data.custom) data.custom = { ...(prev.custom ?? {}), ...data.custom };
  const row = (await repo.update(ctx.org, name, id, data))!;
  await hooks[name]?.after?.(ctx, row, prev, opts);
  if (e.audit) {
    const changes: R = {};
    for (const k of Object.keys(data)) if (JSON.stringify(prev[k] ?? null) !== JSON.stringify(row[k] ?? null) && !e.fields.find(f => f.k === k)?.system) changes[k] = { from: prev[k] ?? null, to: row[k] ?? null };
    if (Object.keys(changes).length) await audit(ctx, 'update', name, id, `Updated ${e.label.toLowerCase()}: ${describe(name, row)} (${Object.keys(changes).join(', ')})`, changes);
  }
  return (await repo.get(ctx.org, name, id)) ?? row;
}

export async function destroy(ctx: Ctx, name: string, id: string): Promise<void> {
  const e = repo.ent(name);
  const row = await getFor(ctx, name, id, 'write');
  if (!canDelete(ctx, e.resource)) throw new HttpError(403, `Your role cannot delete ${e.plural.toLowerCase()}.`);
  await repo.remove(ctx.org, name, id);
  await hooks[name]?.removed?.(ctx, row);
  if (e.audit) await audit(ctx, 'delete', name, id, `Deleted ${e.label.toLowerCase()}: ${describe(name, row)}`, { snapshot: row });
}
