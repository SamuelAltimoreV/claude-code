// Automation engine: trigger → conditions → actions, with a readable execution history, retries,
// loop protection, follow-up sequences and the time-based scheduler.
import { ACTIONS, TRIGGERS, type ActionStep, type Condition, type SequenceStep } from '../shared/automation';
import { canContact, contactName, matchBuyer, propertyLabel } from '../shared/logic';
import { buyerStats, EMPTY } from '../shared/metrics';
import { isTerminal, stageById } from '../shared/settings';
import { one, q, savepoint, tx } from './db';
import * as repo from './repo';
import { HttpError } from './repo';
import { fireWebhooks, mergeContext, queueMessage, smtpReady, twilioReady } from './integrations';
import { create, emit, ensureTransaction, logActivity, makeCtx, notify, patch, type Ctx, type Ev } from './service';

type R = Record<string, any>;
interface Subject { lead: R | null; property: R | null; contact: R | null; offer: R | null; contract: R | null; transaction: R | null; disposition: R | null; task: R | null }
interface StepLog { action: string; label: string; status: 'ok' | 'failed' | 'skipped' | 'not_run'; detail: string }

async function loadSubject(ctx: Ctx, d: R): Promise<Subject> {
  const g = (name: string, id?: string | null) => repo.get(ctx.org, name, id);
  const task = await g('tasks', d.task_id), offer = await g('offers', d.offer_id), contract = await g('contracts', d.contract_id);
  const disposition = await g('dispositions', d.disposition_id);
  let transaction = await g('transactions', d.transaction_id ?? disposition?.transaction_id);
  const lead = await g('leads', d.lead_id ?? task?.lead_id ?? offer?.lead_id ?? contract?.lead_id ?? disposition?.lead_id ?? transaction?.lead_id);
  const property = await g('properties', lead?.property_id ?? offer?.property_id ?? contract?.property_id ?? disposition?.property_id ?? transaction?.property_id ?? task?.property_id);
  if (!transaction && lead) transaction = (await repo.list(ctx.org, 'transactions', { lead_id: lead.id }))[0] ?? null;
  return { lead, property, contact: await g('contacts', lead?.contact_id ?? offer?.contact_id), offer, contract, transaction, disposition, task };
}

function subjectLabel(s: Subject) {
  return s.lead && s.contact ? `${contactName(s.contact)}${s.property ? ` — ${propertyLabel(s.property)}` : ''}` : s.property ? propertyLabel(s.property) : s.task ? s.task.title : 'Record';
}

function checkCondition(c: Condition, s: Subject, hasFollowUp: boolean): { ok: boolean; text: string } {
  const v: unknown = c.field === 'deal_value' ? s.transaction?.assignment_fee ?? s.lead?.est_fee ?? null
    : c.field === 'has_follow_up' ? hasFollowUp
    : ['property_type', 'city', 'zip', 'county'].includes(c.field) ? s.property?.[c.field] : s.lead?.[c.field];
  const lc = (x: unknown) => String(x ?? '').trim().toLowerCase();
  let ok: boolean;
  switch (c.op) {
    case 'eq': ok = Array.isArray(v) ? v.some(x => lc(x) === lc(c.value)) : typeof v === 'boolean' ? v === (c.value === true || c.value === 'true' || c.value === 'yes') : lc(v) === lc(c.value); break;
    case 'neq': ok = Array.isArray(v) ? !v.some(x => lc(x) === lc(c.value)) : lc(v) !== lc(c.value); break;
    case 'gte': ok = v !== null && v !== undefined && Number(v) >= Number(c.value); break;
    case 'lte': ok = v !== null && v !== undefined && Number(v) <= Number(c.value); break;
    case 'contains': ok = lc(v).includes(lc(c.value)); break;
    case 'empty': ok = v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length); break;
    default: ok = false;
  }
  return { ok, text: `${c.field} ${c.op} ${c.value ?? ''} (actual: ${Array.isArray(v) ? v.join(', ') : v ?? 'empty'})` };
}

function triggerMatches(a: R, ev: Ev, s: Subject): boolean {
  const cfg = a.trigger_config ?? {};
  if (a.trigger === 'lead.stage_changed') return (!cfg.to || cfg.to === ev.data.to) && (!cfg.from || cfg.from === ev.data.from);
  if (a.trigger === 'lead.score_updated') return !cfg.crosses || (Number(ev.data.to) >= Number(cfg.crosses) && Number(ev.data.from ?? 0) < Number(cfg.crosses));
  if (a.trigger === 'task.completed') return !cfg.category || s.task?.category === cfg.category;
  return true;
}

async function resolveUsers(ctx: Ctx, spec: string | undefined, s: Subject, ev: Ev): Promise<string[]> {
  const v = spec || 'owner';
  if (v === 'owner') { const id = s.lead?.owner_id ?? s.task?.assignee_id ?? s.transaction?.coordinator_id ?? s.disposition?.owner_id; return id ? [id] : []; }
  if (v === 'trigger_user') return ev.data.user_id ? [ev.data.user_id] : [];
  if (v.startsWith('user:')) return [v.slice(5)];
  const role = v.startsWith('role:') ? v.slice(5) : v.startsWith('round_robin:') ? v.slice(12) : null;
  if (!role) return [];
  const users = (await q(`select u.id, (select count(*) from leads l where l.owner_id = u.id and l.closed_at is null and l.dead_at is null)::int as load
                          from users u where u.org_id = $1 and u.status = 'active' and u.role = $2 order by load, u.created_at`, [ctx.org, role])).rows;
  return v.startsWith('round_robin:') ? users.slice(0, 1).map(u => u.id) : users.map(u => u.id);
}

/** Adds buyers whose buy box fits the deal to a disposition campaign. Returns how many were added. */
export async function matchBuyersToDisposition(ctx: Ctx, dispositionId: string, minScore = 60): Promise<{ added: number; total: number }> {
  const d = await repo.get(ctx.org, 'dispositions', dispositionId);
  if (!d) throw new HttpError(404, 'Disposition not found');
  const property = await repo.get(ctx.org, 'properties', d.property_id);
  const [buyers, interests, transactions] = await Promise.all([repo.list(ctx.org, 'buyers'), repo.list(ctx.org, 'buyer_interests'), repo.list(ctx.org, 'transactions')]);
  const stats = new Map(buyerStats({ ...EMPTY, buyers, buyer_interests: interests, transactions }).map(x => [x.buyer.id, x]));
  const existing = new Set(interests.filter(i => i.disposition_id === d.id).map(i => i.buyer_id));
  let added = 0;
  for (const b of buyers) {
    if (existing.has(b.id)) continue;
    const st = stats.get(b.id);
    const m = matchBuyer(b, { property: property ?? {}, price: d.asking_price, arv: property?.arv, repairs: property?.repair_cost }, { presented: st?.presented ?? 0, offers: st?.offers ?? 0, closed: st?.closed ?? 0 });
    if (m.disqualified || m.score < minScore) continue;
    await create(ctx, 'buyer_interests', { disposition_id: d.id, buyer_id: b.id, status: 'Matched', match_score: m.score }, { system: true });
    added++;
  }
  if (added) {
    await logActivity(ctx, { type: 'dispo', summary: `${added} buyer(s) matched to this deal (score ≥ ${minScore})`, disposition_id: d.id, property_id: d.property_id, lead_id: d.lead_id });
    emit(ctx, 'buyer.matched', { disposition_id: d.id, lead_id: d.lead_id, count: added });
  }
  return { added, total: existing.size + added };
}

/** Selecting a buyer links them to the deal: drafts the assignment agreement and updates the transaction. */
export async function selectBuyer(ctx: Ctx, dispositionId: string, interestId: string) {
  const d = await repo.get(ctx.org, 'dispositions', dispositionId), i = await repo.get(ctx.org, 'buyer_interests', interestId);
  if (!d || !i || i.disposition_id !== d.id) throw new HttpError(404, 'Buyer interest not found on this disposition');
  if (['Closed', 'Cancelled'].includes(d.status)) throw new HttpError(409, `This disposition is ${d.status.toLowerCase()}.`);
  const price = i.offer_amount ?? d.asking_price;
  const fee = d.purchase_price != null ? price - d.purchase_price : null;
  await patch(ctx, 'buyer_interests', i.id, { status: 'Accepted' }, { system: true });
  for (const o of await repo.list(ctx.org, 'buyer_interests', { disposition_id: d.id })) if (o.id !== i.id && o.status === 'Accepted') await patch(ctx, 'buyer_interests', o.id, { status: 'Passed' }, { system: true });
  await patch(ctx, 'dispositions', d.id, { status: 'Buyer Selected', selected_buyer_id: i.buyer_id }, { system: true });
  let txn = d.transaction_id ? await repo.get(ctx.org, 'transactions', d.transaction_id) : null;
  if (txn) txn = await patch(ctx, 'transactions', txn.id, { buyer_id: i.buyer_id, assignment_price: price, assignment_fee: fee, status: ['Closed', 'Assigned', 'Clear to Close'].includes(txn.status) ? txn.status : 'Buyer Found' }, { system: true });
  let contract = (await repo.list(ctx.org, 'contracts', { property_id: d.property_id })).find(c => c.type === 'Assignment Agreement' && !['Terminated', 'Closed'].includes(c.status));
  const fields = { buyer_id: i.buyer_id, purchase_price: d.purchase_price, assignment_price: price, assignment_fee: fee, emd: i.emd ?? null, closing_date: i.proposed_close ?? txn?.closing_date ?? null };
  contract = contract ? await patch(ctx, 'contracts', contract.id, fields, { system: true })
    : await create(ctx, 'contracts', { type: 'Assignment Agreement', property_id: d.property_id, lead_id: d.lead_id, transaction_id: txn?.id ?? null, title_company: txn?.title_company ?? null, status: 'Draft', ...fields }, { system: true });
  const buyer = await repo.get(ctx.org, 'buyers', i.buyer_id);
  await logActivity(ctx, { type: 'dispo', summary: `Buyer selected: ${buyer?.name} at $${Math.round(price).toLocaleString()}${fee != null ? ` (assignment fee $${Math.round(fee).toLocaleString()})` : ''}`, disposition_id: d.id, buyer_id: i.buyer_id, property_id: d.property_id, lead_id: d.lead_id, transaction_id: txn?.id });
  return { disposition: await repo.get(ctx.org, 'dispositions', d.id), contract, transaction: txn };
}

export async function enrollLead(ctx: Ctx, leadId: string, sequenceId: string) {
  const lead = await repo.get(ctx.org, 'leads', leadId), seq = await repo.get(ctx.org, 'sequences', sequenceId);
  if (!lead || !seq) throw new HttpError(404, 'Lead or sequence not found');
  if (!seq.active) throw new HttpError(409, 'This sequence is turned off.');
  const steps: SequenceStep[] = seq.steps ?? [];
  if (!steps.length) throw new HttpError(409, 'This sequence has no steps.');
  if (isTerminal(ctx.settings, lead.stage)) throw new HttpError(409, 'This lead is closed or dead; sequences cannot be started.');
  const contact = await repo.get(ctx.org, 'contacts', lead.contact_id);
  if (contact?.dnc) throw new HttpError(422, 'Seller is marked Do Not Contact; sequences cannot be started.');
  if ((await repo.list(ctx.org, 'enrollments', { lead_id: leadId, status: 'Active' })).length) throw new HttpError(409, 'This lead already has an active sequence.');
  const now = Date.now();
  const e = await create(ctx, 'enrollments', { sequence_id: sequenceId, lead_id: leadId, status: 'Active', step_index: 0, started_at: new Date(now).toISOString(), next_run_at: new Date(now + steps[0].day * 864e5).toISOString() }, { system: true });
  await logActivity(ctx, { type: 'sequence', summary: `Started follow-up sequence: ${seq.name}`, lead_id: leadId });
  return e;
}

async function runAction(ctx: Ctx, step: ActionStep, s: Subject, ev: Ev): Promise<{ status: 'ok' | 'skipped'; detail: string }> {
  const p = step.params ?? {};
  const def = ACTIONS.find(a => a.id === step.type);
  if (!def) throw new Error(`Unknown action "${step.type}"`);
  if (def.needs === 'lead' && !s.lead) return { status: 'skipped', detail: 'No lead is associated with this event' };
  const owner = s.lead?.owner_id ? await one('select id, name from users where id = $1', [s.lead.owner_id]) : null;
  const merge = (t: string) => mergeContext(ctx, { contact: s.contact, property: s.property, offer: s.offer, user: owner })(String(t ?? '')).replace(/\{\{\s*task_title\s*\}\}/g, s.task?.title ?? '');
  const link = s.lead ? `/leads/${s.lead.id}` : s.disposition ? `/dispositions/${s.disposition.id}` : s.transaction ? `/transactions?open=${s.transaction.id}` : '/tasks';
  switch (step.type) {
    case 'create_task': {
      const [assignee] = await resolveUsers(ctx, p.assign, s, ev);
      const due = new Date(Date.now() + Number(p.dueInDays ?? 1) * 864e5); if (Number(p.dueInDays ?? 1) >= 1) due.setHours(9, 0, 0, 0);
      const t = await create(ctx, 'tasks', { title: merge(p.title || 'Follow up'), category: p.category || null, priority: p.priority || 'Normal', due_at: due.toISOString(), assignee_id: assignee ?? null,
        lead_id: s.lead?.id ?? null, property_id: s.property?.id ?? null, transaction_id: s.transaction?.id ?? null, contract_id: s.contract?.id ?? null, offer_id: s.offer?.id ?? null, origin: `Automation: ${ctx.label}` }, { system: true });
      if (assignee) await notify(ctx, assignee, 'New task', t.title, '/tasks');
      return { status: 'ok', detail: `Created task "${t.title}"${assignee ? '' : ' (unassigned — no matching team member)'}` };
    }
    case 'assign_lead': {
      const [uid] = await resolveUsers(ctx, p.assign, s, ev);
      if (!uid) throw new Error('No active team member matches the assignment rule');
      if (uid === s.lead!.owner_id) return { status: 'skipped', detail: 'Lead already assigned to that team member' };
      await patch(ctx, 'leads', s.lead!.id, { owner_id: uid }, { system: true });
      return { status: 'ok', detail: `Assigned lead to ${(await one('select name from users where id = $1', [uid]))?.name}` };
    }
    case 'update_lead': {
      const upd: R = {};
      if (p.stage && p.stage !== s.lead!.stage) upd.stage = p.stage;
      if (p.classification && p.classification !== s.lead!.classification) upd.classification = p.classification;
      if (!Object.keys(upd).length) return { status: 'skipped', detail: 'Lead already has these values' };
      await patch(ctx, 'leads', s.lead!.id, upd, { system: true, note: `Automation: ${ctx.label}` });
      return { status: 'ok', detail: `Updated lead: ${Object.entries(upd).map(([k, v]) => `${k} = ${k === 'stage' ? stageById(ctx.settings, v)?.name ?? v : v}`).join(', ')}` };
    }
    case 'add_tag': {
      const tags: string[] = s.lead!.tags ?? [];
      if (!p.tag) throw new Error('No tag configured');
      if (tags.includes(p.tag)) return { status: 'skipped', detail: `Lead already tagged "${p.tag}"` };
      await patch(ctx, 'leads', s.lead!.id, { tags: [...tags, p.tag] }, { system: true });
      return { status: 'ok', detail: `Added tag "${p.tag}"` };
    }
    case 'notify': {
      const ids = await resolveUsers(ctx, p.assign, s, ev);
      if (!ids.length) return { status: 'skipped', detail: 'No team member matches the recipient rule' };
      for (const id of ids) await notify(ctx, id, ctx.label ?? 'Automation', merge(p.message || ''), link);
      return { status: 'ok', detail: `Notified ${ids.length} team member(s)` };
    }
    case 'create_transaction': {
      if (s.transaction && !['Closed', 'Cancelled'].includes(s.transaction.status)) return { status: 'skipped', detail: 'A transaction already exists for this deal' };
      if (!s.lead!.property_id) throw new Error('Lead has no property');
      const contract = (await repo.list(ctx.org, 'contracts', { property_id: s.lead!.property_id })).find(c => c.type === 'Purchase Agreement' && c.status !== 'Terminated');
      if (contract) { await ensureTransaction(ctx, contract); return { status: 'ok', detail: 'Created transaction from the purchase agreement with the standard checklist' }; }
      const offer = (await repo.list(ctx.org, 'offers', { lead_id: s.lead!.id, status: 'Accepted' }))[0];
      await create(ctx, 'transactions', { property_id: s.lead!.property_id, lead_id: s.lead!.id, contact_id: s.lead!.contact_id, purchase_price: offer?.amount ?? null, closing_date: offer?.closing_date ?? null, status: 'Under Contract' }, { system: true });
      return { status: 'ok', detail: 'Created transaction with the standard checklist (no purchase agreement on file yet)' };
    }
    case 'add_note':
      await logActivity(ctx, { type: 'note', summary: 'Note (automation)', body: merge(p.text || ''), lead_id: s.lead!.id, property_id: s.lead!.property_id });
      return { status: 'ok', detail: 'Added internal note' };
    case 'schedule_followup': {
      if (p.onlyIfNone !== 'no' && await one(`select 1 from tasks where org_id = $1 and lead_id = $2 and status in ('Open','In Progress') and due_at > now()`, [ctx.org, s.lead!.id]))
        return { status: 'skipped', detail: 'A follow-up is already scheduled' };
      const due = new Date(Date.now() + Number(p.inDays ?? 2) * 864e5); due.setHours(10, 0, 0, 0);
      await create(ctx, 'tasks', { title: `Follow up with ${contactName(s.contact)}`, category: 'Follow up', due_at: due.toISOString(), assignee_id: s.lead!.owner_id, lead_id: s.lead!.id, origin: `Automation: ${ctx.label}` }, { system: true });
      return { status: 'ok', detail: `Scheduled follow-up for ${due.toLocaleDateString('en-US')}` };
    }
    case 'enroll_sequence':
      if (!p.sequenceId) throw new Error('No sequence configured');
      await enrollLead(ctx, s.lead!.id, p.sequenceId);
      return { status: 'ok', detail: 'Started follow-up sequence' };
    case 'send_sms': case 'send_email': {
      const tpl = await repo.get(ctx.org, 'templates', p.templateId);
      if (!tpl) throw new Error('No message template selected for this action');
      if (!s.contact) throw new Error('Lead has no seller contact');
      await queueMessage(ctx, { channel: step.type === 'send_sms' ? 'SMS' : 'Email', kind: 'contacts', personId: s.contact.id, body: merge(tpl.body), subject: tpl.subject ? merge(tpl.subject) : undefined, lead_id: s.lead!.id, property_id: s.lead!.property_id, automated: true });
      return { status: 'ok', detail: `${step.type === 'send_sms' ? 'SMS' : 'Email'} "${tpl.name}" queued for delivery (see Communications for delivery status)` };
    }
    case 'add_buyers_to_campaign': {
      const d = s.disposition ?? (s.property ? (await repo.list(ctx.org, 'dispositions', { property_id: s.property.id })).find(x => ['Draft', 'Active'].includes(x.status)) : null);
      if (!d) return { status: 'skipped', detail: 'No open disposition campaign for this deal' };
      const r = await matchBuyersToDisposition(ctx, d.id, Number(p.minScore ?? 60));
      return { status: 'ok', detail: `Added ${r.added} matching buyer(s); campaign now has ${r.total}` };
    }
  }
  throw new Error(`Action "${step.type}" is not implemented`);
}

export async function runAutomation(ctx: Ctx, a: R, ev: Ev, opts: { dedupe?: string; retryOf?: R } = {}): Promise<R | null> {
  const s = await loadSubject(ctx, ev.data);
  if (!opts.retryOf && !triggerMatches(a, ev, s)) return null;
  if (opts.dedupe && await one('select 1 from automation_runs where org_id = $1 and dedupe = $2', [ctx.org, opts.dedupe])) return null;
  const started = new Date().toISOString();
  const actions: ActionStep[] = a.actions ?? [];
  const label = (st: ActionStep) => ACTIONS.find(x => x.id === st.type)?.label ?? st.type;
  const base = { automation_id: a.id, trigger: TRIGGERS.find(t => t.id === a.trigger)?.label ?? a.trigger, subject: subjectLabel(s), context: { event: ev.type, data: ev.data }, started_at: started, dedupe: opts.dedupe ?? null, retry_of: opts.retryOf?.id ?? null };
  const save = (status: string, steps: StepLog[], error: string | null) => repo.insert(ctx.org, 'automation_runs', { ...base, status, steps, error, finished_at: new Date().toISOString() }, { demo: ctx.demo });

  const hasFollowUp = s.lead ? !!(await one(`select 1 from tasks where org_id = $1 and lead_id = $2 and status in ('Open','In Progress') and due_at > now()`, [ctx.org, s.lead.id])) : false;
  const failedCond = (a.conditions as Condition[] ?? []).map(c => checkCondition(c, s, hasFollowUp)).find(r => !r.ok);
  if (failedCond && !opts.retryOf) return save('skipped', [], `Condition not met: ${failedCond.text}`);

  const prevSteps: StepLog[] = opts.retryOf?.steps ?? [];
  const steps: StepLog[] = [];
  const child: Ctx = { ...ctx, user: null, origin: 'automation', depth: ev.depth + 1, chain: [...ev.chain, a.id], label: a.name };
  let failed: string | null = null;
  for (let i = 0; i < actions.length; i++) {
    const st = actions[i];
    if (failed) { steps.push({ action: st.type, label: label(st), status: 'not_run', detail: 'Not run because an earlier step failed' }); continue; }
    if (opts.retryOf && prevSteps[i]?.status === 'ok') { steps.push({ ...prevSteps[i], detail: `${prevSteps[i].detail} (completed in original run)` }); continue; }
    try { const r = await savepoint(() => runAction(child, st, s, ev)); steps.push({ action: st.type, label: label(st), ...r }); }
    catch (e: any) { failed = String(e?.message ?? e); steps.push({ action: st.type, label: label(st), status: 'failed', detail: failed }); }
  }
  if (failed) await notify(ctx, { role: ['Owner', 'Administrator'] }, `Automation failed: ${a.name}`, failed.slice(0, 200), '/automations?tab=history');
  return save(failed ? 'failed' : steps.every(x => x.status === 'skipped') && steps.length ? 'skipped' : 'success', steps, failed);
}

/** Processes all queued events: fires outbound webhooks and runs matching automations (which may queue more). */
export async function drainEvents(ctx: Ctx) {
  let guard = 0;
  while (ctx.events.length && guard++ < 500) {
    const ev = ctx.events.shift()!;
    if (ev.depth === 0 || ev.type === 'transaction.closed') await fireWebhooks(ctx.org, ev.type, ev.data);
    if (ctx.settings.automation.pauseAll) continue;
    const autos = (await repo.list(ctx.org, 'automations', { trigger: ev.type, enabled: true }, { order: 'created_at asc' }));
    for (const a of autos) {
      if (ev.chain.includes(a.id) || ev.depth >= ctx.settings.automation.maxChainDepth) continue;
      await runAutomation(ctx, a, ev);
    }
  }
}

export async function retryRun(ctx: Ctx, runId: string) {
  const run = await repo.get(ctx.org, 'automation_runs', runId);
  if (!run) throw new HttpError(404, 'Run not found');
  if (run.status !== 'failed') throw new HttpError(409, 'Only failed runs can be retried.');
  const a = await repo.get(ctx.org, 'automations', run.automation_id);
  if (!a) throw new HttpError(404, 'Automation no longer exists');
  const res = await runAutomation(ctx, a, { type: run.context?.event ?? a.trigger, data: run.context?.data ?? {}, depth: 0, chain: [] }, { retryOf: run });
  await drainEvents(ctx);
  return res;
}

// ---------- Scheduler ----------
async function processSequences(ctx: Ctx) {
  const due = await repo.list(ctx.org, 'enrollments', { status: 'Active' }, { extra: 'next_run_at <= now()', order: 'next_run_at asc', limit: 200 });
  const suppressions = due.length ? await repo.list(ctx.org, 'suppressions') : [];
  for (const en of due) {
    const [seq, lead] = await Promise.all([repo.get(ctx.org, 'sequences', en.sequence_id), repo.get(ctx.org, 'leads', en.lead_id)]);
    const stop = (reason: string, status = 'Stopped') => repo.update(ctx.org, 'enrollments', en.id, { status, stop_reason: reason, next_run_at: null });
    if (!seq || !lead) { await stop('Sequence or lead no longer exists'); continue; }
    if (!seq.active) { await stop('Sequence turned off', 'Paused'); continue; }
    if (isTerminal(ctx.settings, lead.stage)) { await stop('Lead reached a terminal stage'); continue; }
    const contact = await repo.get(ctx.org, 'contacts', lead.contact_id), property = await repo.get(ctx.org, 'properties', lead.property_id);
    if (contact?.dnc) { await stop('Seller is Do Not Contact'); continue; }
    const steps: SequenceStep[] = seq.steps ?? [], step = steps[en.step_index];
    if (!step) { await stop('Completed', 'Completed'); continue; }
    const owner = lead.owner_id ? await one('select id, name from users where id = $1', [lead.owner_id]) : null;
    const tpl = step.templateId ? await repo.get(ctx.org, 'templates', step.templateId) : null;
    const text = tpl ? mergeContext(ctx, { contact, property, user: owner })(tpl.body) : step.note ?? '';
    const stepName = `${seq.name} · step ${en.step_index + 1}/${steps.length} (day ${step.day})`;
    const mkTask = (title: string, category: string, description: string) => create(ctx, 'tasks', { title, category, description, due_at: new Date().toISOString(), assignee_id: lead.owner_id, lead_id: lead.id, enrollment_id: en.id, priority: 'High', origin: `Sequence: ${seq.name}` }, { system: true });
    try {
      await savepoint(async () => {
        if (step.channel === 'Call' || step.channel === 'Task') {
          await mkTask(step.channel === 'Call' ? `Call ${contactName(contact)} — ${stepName}` : `${step.note || 'Follow up'} — ${contactName(contact)}`, step.channel === 'Call' ? 'Call seller' : 'Follow up', text ? `Script / notes:\n${text}` : '');
        } else {
          const check = canContact(step.channel, contact, ctx.settings, suppressions, { automated: true });
          const quiet = check.reason.startsWith('Outside permitted');
          if (quiet) throw Object.assign(new Error('quiet-hours'), { defer: true });
          if (!check.allowed) await logActivity(ctx, { type: 'sequence', summary: `${step.channel} step skipped — ${check.reason}`, body: stepName, lead_id: lead.id });
          else if (step.channel === 'SMS' ? twilioReady() : smtpReady())
            await queueMessage(ctx, { channel: step.channel, kind: 'contacts', personId: contact!.id, body: text, subject: tpl?.subject ?? undefined, lead_id: lead.id, property_id: lead.property_id, automated: true });
          else await mkTask(`Send ${step.channel} manually to ${contactName(contact)} — ${stepName}`, 'Follow up', `No ${step.channel} provider is connected, so this step was not sent automatically. Consent is on file. Message:\n\n${text}`);
        }
      });
    } catch (e: any) {
      if (e?.defer) { await repo.update(ctx.org, 'enrollments', en.id, { next_run_at: new Date(Date.now() + 36e5).toISOString() }); continue; }
      await logActivity(ctx, { type: 'sequence', summary: `Sequence step failed: ${String(e?.message ?? e).slice(0, 200)}`, body: stepName, lead_id: lead.id });
    }
    const next = steps[en.step_index + 1];
    if (!next) { await repo.update(ctx.org, 'enrollments', en.id, { status: 'Completed', step_index: en.step_index + 1, next_run_at: null, stop_reason: 'Completed' }); await logActivity(ctx, { type: 'sequence', summary: `Follow-up sequence completed: ${seq.name}`, lead_id: lead.id }); }
    else await repo.update(ctx.org, 'enrollments', en.id, { step_index: en.step_index + 1, next_run_at: new Date(Math.max(Date.parse(en.started_at) + next.day * 864e5, Date.now() + 6e4)).toISOString() });
  }
  return due.length;
}

async function timedTriggers(ctx: Ctx) {
  const autos = (await repo.list(ctx.org, 'automations', { enabled: true })).filter(a => TRIGGERS.find(t => t.id === a.trigger)?.timed);
  if (ctx.settings.automation.pauseAll) return;
  for (const a of autos) {
    const cfg = a.trigger_config ?? {};
    const fire = (data: R, key: string) => runAutomation(ctx, a, { type: a.trigger, data, depth: 0, chain: [] }, { dedupe: `${a.id}:${key}` });
    if (a.trigger === 'task.overdue') {
      const rows = (await q(`select id, due_at from tasks where org_id = $1 and status in ('Open','In Progress') and due_at < now() - ($2 || ' hours')::interval and due_at > now() - interval '30 days' limit 200`, [ctx.org, String(Number(cfg.hours ?? 1))])).rows;
      for (const t of rows) await fire({ task_id: t.id }, `${t.id}:${t.due_at}`);
    } else if (a.trigger === 'closing.approaching') {
      const rows = (await q(`select id, closing_date from transactions where org_id = $1 and status not in ('Closed','Cancelled') and closing_date is not null and closing_date <= (current_date + $2::int) and closing_date >= current_date`, [ctx.org, Number(cfg.days ?? 3)])).rows;
      for (const t of rows) await fire({ transaction_id: t.id }, `${t.id}:${t.closing_date}`);
    } else if (a.trigger === 'lead.inactive') {
      const rows = (await q(`select id, greatest(coalesce(last_contact_at, created_at), coalesce(stage_changed_at, created_at)) as last from leads
                             where org_id = $1 and closed_at is null and dead_at is null and greatest(coalesce(last_contact_at, created_at), coalesce(stage_changed_at, created_at)) < now() - ($2 || ' days')::interval limit 300`, [ctx.org, String(Number(cfg.days ?? 7))])).rows;
      for (const l of rows) await fire({ lead_id: l.id }, `${l.id}:${l.last}`);
    }
  }
}

async function reminders(ctx: Ctx) {
  const n = ctx.settings.notifications;
  if (n.taskReminders) {
    const rows = (await q(`select id, title, assignee_id, due_at, lead_id from tasks where org_id = $1 and status in ('Open','In Progress') and assignee_id is not null and coalesce(reminded, false) = false
                           and due_at is not null and due_at <= now() + (coalesce(reminder_min, 0) || ' minutes')::interval and due_at > now() - interval '2 days'`, [ctx.org])).rows;
    for (const t of rows) {
      await notify(ctx, t.assignee_id, Date.parse(t.due_at) < Date.now() ? 'Task due now' : 'Task coming up', t.title, t.lead_id ? `/leads/${t.lead_id}` : '/tasks');
      await q('update tasks set reminded = true where id = $1', [t.id]);
    }
  }
  if (n.contractDeadlines) {
    const rows = (await q(`select c.id, c.type, c.inspection_end, c.closing_date, p.address from contracts c join properties p on p.id = c.property_id
                           where c.org_id = $1 and c.status not in ('Closed','Terminated','Draft')`, [ctx.org])).rows;
    const today = new Date().toISOString().slice(0, 10), limit = new Date(Date.now() + n.deadlineDays * 864e5).toISOString().slice(0, 10);
    for (const c of rows) for (const [k, label] of [['inspection_end', 'Inspection period ends'], ['closing_date', 'Closing date']] as const) {
      const d = c[k];
      if (d && d >= today && d <= limit) await notify(ctx, { role: ['Owner', 'Administrator', 'Transaction Coordinator', 'Acquisition Manager'] }, `${label} ${d === today ? 'today' : `on ${d}`}`, `${c.address} — ${c.type}`, `/contracts?open=${c.id}`, `deadline:${c.id}:${k}:${d}`);
    }
  }
  const expired = (await q(`select id from offers where org_id = $1 and status in ('Presented','Pending Approval','Countered') and expires_on is not null and expires_on < current_date`, [ctx.org])).rows;
  for (const o of expired) await patch(ctx, 'offers', o.id, { status: 'Expired' }, { system: true });
}

/** One scheduler pass for one organization. Safe to call repeatedly. */
export async function tickOrg(org: string) {
  return tx(async () => {
    const ctx = await makeCtx(org, null, 'system');
    const sequences = await processSequences(ctx);
    await timedTriggers(ctx);
    await reminders(ctx);
    await drainEvents(ctx);
    return { sequences };
  });
}
export async function tickAll() {
  for (const o of (await q('select id from organizations')).rows) {
    try { await tickOrg(o.id); } catch (e) { console.error('scheduler tick failed for org', o.id, e); }
  }
}
