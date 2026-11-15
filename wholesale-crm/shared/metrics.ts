// Business metrics computed from CRM records. Used by the dashboard, analytics, reports and the AI analyst tools.
import type { OrgSettings } from './settings';
import { stageById } from './settings';

type R = Record<string, any>;
export interface Dataset {
  leads: R[]; properties: R[]; contacts: R[]; offers: R[]; contracts: R[]; transactions: R[]; revenue: R[]; expenses: R[];
  communications: R[]; tasks: R[]; campaigns: R[]; dispositions: R[]; buyer_interests: R[]; buyers: R[]; users: R[]; markets: R[];
}
export interface Filter { from?: string; to?: string; ownerId?: string; source?: string; campaignId?: string; marketId?: string }

export const EMPTY: Dataset = { leads: [], properties: [], contacts: [], offers: [], contracts: [], transactions: [], revenue: [], expenses: [], communications: [], tasks: [], campaigns: [], dispositions: [], buyer_interests: [], buyers: [], users: [], markets: [] };

const day = (v?: string | null) => (v ? String(v).slice(0, 10) : '');
export const inRange = (v: string | null | undefined, f: Filter) => { const d = day(v); return !!d && (!f.from || d >= f.from) && (!f.to || d <= f.to); };
const byId = (rows: R[]) => new Map(rows.map(r => [r.id, r]));
export const sum = (rows: R[], k: string | ((r: R) => number)) => rows.reduce((s, r) => s + (Number(typeof k === 'string' ? r[k] : k(r)) || 0), 0);
export const avg = (vals: number[]) => (vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null);
export const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : null);
const daysBetween = (a?: string | null, b?: string | null) => (a && b ? (Date.parse(b) - Date.parse(a)) / 864e5 : null);

export function indexes(ds: Dataset) {
  return { lead: byId(ds.leads), property: byId(ds.properties), contact: byId(ds.contacts), txn: byId(ds.transactions), user: byId(ds.users), buyer: byId(ds.buyers), campaign: byId(ds.campaigns), market: byId(ds.markets), dispo: byId(ds.dispositions) };
}

/** Leads matching the dimension filters (owner/source/campaign/market). Date range is applied separately per metric. */
export function scopeLeads(ds: Dataset, f: Filter): R[] {
  const prop = byId(ds.properties);
  return ds.leads.filter(l => (!f.ownerId || l.owner_id === f.ownerId) && (!f.source || l.source === f.source) && (!f.campaignId || l.campaign_id === f.campaignId)
    && (!f.marketId || prop.get(l.property_id)?.market_id === f.marketId));
}

export interface RevenueRow extends R { lead?: R; txn?: R; property?: R; source: string; ownerId: string | null; marketId: string | null; buyerId: string | null }
/** Revenue records in range, joined back to their transaction, lead and property for attribution. */
export function revenueRows(ds: Dataset, f: Filter): RevenueRow[] {
  const ix = indexes(ds);
  return ds.revenue.map((r): RevenueRow => {
    const txn = ix.txn.get(r.transaction_id), lead = txn && ix.lead.get(txn.lead_id), property = txn && ix.property.get(txn.property_id);
    return { ...r, txn, lead, property, source: lead?.source ?? 'Unattributed', ownerId: lead?.owner_id ?? null, marketId: property?.market_id ?? null, buyerId: txn?.buyer_id ?? null };
  }).filter(r => inRange(r.date, f) && (!f.ownerId || r.ownerId === f.ownerId) && (!f.source || r.source === f.source)
    && (!f.campaignId || r.lead?.campaign_id === f.campaignId) && (!f.marketId || r.marketId === f.marketId));
}

export function funnel(leads: R[]) {
  const c = (k: string) => leads.filter(l => l[k]).length;
  const total = leads.length, contacted = c('contacted_at'), qualified = c('qualified_at'), offer = c('offer_at'), contract = c('contract_at'), closed = c('closed_at'), dead = c('dead_at');
  return {
    total, contacted, qualified, offer, contract, closed, dead,
    leadToContact: pct(contacted, total), contactToQualified: pct(qualified, contacted), qualifiedToContract: pct(contract, qualified), contractToClose: pct(closed, contract), leadToClose: pct(closed, total),
  };
}

export function kpis(ds: Dataset, f: Filter, settings: OrgSettings, now = new Date()) {
  const scoped = scopeLeads(ds, f);
  const created = scoped.filter(l => inRange(l.created_at, f));
  const rev = revenueRows(ds, f);
  const noDate: Filter = { ...f, from: undefined, to: undefined };
  const allRev = revenueRows(ds, noDate);
  const today = now.toISOString().slice(0, 10), month = today.slice(0, 7), year = today.slice(0, 4);
  const st = (l: R) => stageById(settings, l.stage);
  const active = scoped.filter(l => { const m = st(l)?.milestone; return m !== 'dead' && m !== 'closed'; });
  const leadIds = new Set(scoped.map(l => l.id));
  const txns = ds.transactions.filter(t => !t.lead_id || leadIds.has(t.lead_id) || (!f.ownerId && !f.source && !f.campaignId && !f.marketId));
  const openTxns = txns.filter(t => t.status !== 'Closed' && t.status !== 'Cancelled');
  const lead = byId(ds.leads);
  const projected = sum(openTxns, t => t.assignment_fee ?? lead.get(t.lead_id)?.est_fee ?? 0);
  const fees = rev.map(r => Number(r.amount) || 0);
  const nowIso = now.toISOString();
  const needFollowUp = active.filter(l => (l.next_follow_up && l.next_follow_up <= nowIso) || (!l.next_follow_up && st(l)?.milestone !== 'contract'));
  const fuTasks = ds.tasks.filter(t => ['Follow up', 'Call seller'].includes(t.category) && inRange(t.due_at, f) && t.due_at <= nowIso && t.status !== 'Cancelled' && (!f.ownerId || t.assignee_id === f.ownerId));
  const closedTxns = txns.filter(t => t.status === 'Closed' && inRange(t.closed_on, f));
  const offers = ds.offers.filter(o => inRange(o.offer_date ?? o.created_at, f) && o.from_party !== 'Seller' && o.status !== 'Draft' && (!o.lead_id || leadIds.has(o.lead_id)));
  const contractsSigned = scoped.filter(l => inRange(l.contract_at, f));
  return {
    revenue: { total: sum(allRev, 'amount'), inRange: sum(rev, 'amount'), month: sum(allRev.filter(r => day(r.date).startsWith(month)), 'amount'), year: sum(allRev.filter(r => day(r.date).startsWith(year)), 'amount'), projected, avgFee: avg(fees), maxFee: fees.length ? Math.max(...fees) : null, deals: rev.length, rows: rev },
    pipeline: {
      active, created, needFollowUp,
      new: active.filter(l => l.stage === settings.stages[0]?.id), contacted: created.filter(l => l.contacted_at), qualified: created.filter(l => l.qualified_at),
      offers, contractsSigned,
      underContract: active.filter(l => st(l)?.milestone === 'contract'), inDispo: ds.dispositions.filter(d => ['Active', 'Buyer Selected'].includes(d.status) && (!d.lead_id || leadIds.has(d.lead_id))),
      closed: scoped.filter(l => inRange(l.closed_at, f)), dead: scoped.filter(l => inRange(l.dead_at, f)),
    },
    funnel: funnel(created),
    perf: {
      avgDaysToClose: avg(closedTxns.map(t => daysBetween(t.created_at, t.closed_on)).filter((x): x is number => x !== null && x >= 0)),
      avgDaysLeadToContract: avg(contractsSigned.map(l => daysBetween(l.created_at, l.contract_at)).filter((x): x is number => x !== null && x >= 0)),
      followUpRate: pct(fuTasks.filter(t => t.status === 'Done').length, fuTasks.length), followUpTasks: fuTasks,
      responseHours: avg(created.map(l => daysBetween(l.created_at, l.first_contact_at)).filter((x): x is number => x !== null && x >= 0).map(d => d * 24)),
    },
    openTxns,
  };
}

export type Bucket = 'day' | 'week' | 'month';
export function bucketKey(d: string, b: Bucket) {
  if (b === 'month') return d.slice(0, 7);
  if (b === 'day') return d.slice(0, 10);
  const dt = new Date(d.slice(0, 10) + 'T00:00:00Z'); dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7)); return dt.toISOString().slice(0, 10);
}
export const pickBucket = (from: string, to: string): Bucket => { const d = (Date.parse(to) - Date.parse(from)) / 864e5; return d <= 31 ? 'day' : d <= 120 ? 'week' : 'month'; };

/** Continuous series with zero-filled buckets between from and to. */
export function series(rows: R[], dateKey: string, value: (r: R) => number, from: string, to: string, bucket: Bucket = pickBucket(from, to)) {
  const map = new Map<string, number>();
  const cur = new Date(bucketKey(from, bucket).padEnd(10, '-01') + 'T00:00:00Z'), end = new Date(to + 'T00:00:00Z');
  for (let i = 0; cur <= end && i < 800; i++) {
    map.set(bucketKey(cur.toISOString(), bucket), 0);
    if (bucket === 'month') cur.setUTCMonth(cur.getUTCMonth() + 1); else cur.setUTCDate(cur.getUTCDate() + (bucket === 'week' ? 7 : 1));
  }
  for (const r of rows) { const d = day(r[dateKey]); if (!d || d < from || d > to) continue; const k = bucketKey(d, bucket); map.set(k, (map.get(k) ?? 0) + value(r)); }
  return [...map.entries()].sort().map(([key, value]) => ({ key, value }));
}

export function groupBy<T extends R>(rows: T[], key: (r: T) => string | null | undefined) {
  const m = new Map<string, T[]>();
  for (const r of rows) { const k = key(r) ?? '—'; (m.get(k) ?? m.set(k, []).get(k)!).push(r); }
  return m;
}

export function campaignStats(ds: Dataset, f: Filter = {}) {
  const rev = revenueRows(ds, {});
  return ds.campaigns.map(c => {
    const leads = ds.leads.filter(l => l.campaign_id === c.id && (!f.from || inRange(l.created_at, f)));
    const spend = sum(ds.expenses.filter(e => e.campaign_id === c.id), 'amount');
    const revenue = sum(rev.filter(r => r.lead?.campaign_id === c.id), 'amount');
    const fn = funnel(leads);
    return { campaign: c, leads: leads.length, qualified: fn.qualified, contracts: fn.contract, closed: fn.closed, spend, revenue,
      cpl: leads.length ? spend / leads.length : null, cpql: fn.qualified ? spend / fn.qualified : null, cpa: fn.contract ? spend / fn.contract : null,
      roi: spend > 0 ? ((revenue - spend) / spend) * 100 : null };
  });
}

export function sourceStats(ds: Dataset, f: Filter) {
  const leads = scopeLeads(ds, f).filter(l => inRange(l.created_at, f));
  const rev = revenueRows(ds, f);
  const camp = byId(ds.campaigns);
  const spendBySource = new Map<string, number>();
  for (const e of ds.expenses) { if (e.category !== 'Marketing' || !inRange(e.date, f)) continue; const s = camp.get(e.campaign_id)?.source ?? e.subcategory ?? 'Unattributed'; spendBySource.set(s, (spendBySource.get(s) ?? 0) + (Number(e.amount) || 0)); }
  const names = new Set<string>([...leads.map(l => l.source ?? 'Unattributed'), ...rev.map(r => r.source)]);
  return [...names].map(source => {
    const ls = leads.filter(l => (l.source ?? 'Unattributed') === source), rs = rev.filter(r => r.source === source), fn = funnel(ls);
    const spend = spendBySource.get(source) ?? 0, revenue = sum(rs, 'amount');
    return { source, leads: ls.length, contacted: fn.contacted, qualified: fn.qualified, contracts: fn.contract, closed: rs.length, revenue, avgFee: rs.length ? revenue / rs.length : null,
      qualifiedRate: pct(fn.qualified, ls.length), spend, roi: spend > 0 ? ((revenue - spend) / spend) * 100 : null, avgScore: avg(ls.map(l => l.score ?? 0)) };
  }).sort((a, b) => b.revenue - a.revenue || b.leads - a.leads);
}

export function teamStats(ds: Dataset, f: Filter) {
  const rev = revenueRows(ds, { from: f.from, to: f.to });
  return ds.users.filter(u => u.status !== 'disabled').map(u => {
    const comms = ds.communications.filter(c => c.user_id === u.id && inRange(c.at, f));
    const calls = comms.filter(c => c.type === 'Call');
    const leads = ds.leads.filter(l => l.owner_id === u.id);
    const offers = ds.offers.filter(o => o.owner_id === u.id && o.from_party !== 'Seller' && o.status !== 'Draft' && inRange(o.offer_date ?? o.created_at, f));
    const myRev = rev.filter(r => r.ownerId === u.id);
    const created = leads.filter(l => inRange(l.created_at, f)), fn = funnel(created);
    return { user: u, calls: calls.length, conversations: calls.filter(c => c.direction !== 'Missed' && !['No answer', 'Left voicemail', 'Wrong number'].includes(c.outcome)).length,
      leadsAssigned: created.length, qualified: leads.filter(l => inRange(l.qualified_at, f)).length, offers: offers.length, contracts: leads.filter(l => inRange(l.contract_at, f)).length,
      closed: myRev.length, revenue: sum(myRev, 'amount'), conversion: fn.leadToClose, contractRate: pct(fn.contract, fn.total),
      tasksDone: ds.tasks.filter(t => t.assignee_id === u.id && t.status === 'Done' && inRange(t.completed_at, f)).length,
      tasksOverdue: ds.tasks.filter(t => t.assignee_id === u.id && ['Open', 'In Progress'].includes(t.status) && t.due_at && t.due_at < new Date().toISOString()).length };
  });
}

export function marketStats(ds: Dataset, f: Filter) {
  const prop = byId(ds.properties);
  const rev = revenueRows(ds, f);
  return ds.markets.map(m => {
    const leads = ds.leads.filter(l => prop.get(l.property_id)?.market_id === m.id);
    const created = leads.filter(l => inRange(l.created_at, f)), fn = funnel(created), rs = rev.filter(r => r.marketId === m.id);
    return { market: m, properties: ds.properties.filter(p => p.market_id === m.id).length, leads: created.length, active: leads.filter(l => !l.closed_at && !l.dead_at).length,
      qualified: fn.qualified, contracts: fn.contract, closed: rs.length, revenue: sum(rs, 'amount'), avgFee: rs.length ? sum(rs, 'amount') / rs.length : null, conversion: fn.leadToClose };
  });
}

export function buyerStats(ds: Dataset) {
  return ds.buyers.map(b => {
    const ints = ds.buyer_interests.filter(i => i.buyer_id === b.id);
    const txns = ds.transactions.filter(t => t.buyer_id === b.id && t.status === 'Closed');
    const responded = ints.filter(i => i.sent_at && i.responded_at);
    const presented = ints.filter(i => i.status !== 'Matched').length, offers = ints.filter(i => i.offer_amount || ['Offer Made', 'Accepted'].includes(i.status)).length, accepted = ints.filter(i => i.status === 'Accepted').length;
    return { buyer: b, presented, offers, accepted, closed: txns.length, volume: sum(txns, 'assignment_price'), avgPrice: txns.length ? sum(txns, 'assignment_price') / txns.length : null,
      avgResponseHours: avg(responded.map(i => (Date.parse(i.responded_at) - Date.parse(i.sent_at)) / 36e5)), reliability: accepted ? pct(txns.length, accepted) : null };
  });
}

export function dispoStats(ds: Dataset, f: Filter) {
  const ds2 = ds.dispositions.filter(d => inRange(d.started_on ?? d.created_at, f));
  const ids = new Set(ds2.map(d => d.id));
  const ints = ds.buyer_interests.filter(i => ids.has(i.disposition_id));
  const done = ds.dispositions.filter(d => d.ended_on && inRange(d.ended_on, f) && d.status !== 'Cancelled');
  return { marketed: ds2.length, buyersContacted: ints.filter(i => i.status !== 'Matched').length, buyerOffers: ints.filter(i => i.offer_amount).length,
    assigned: ds.contracts.filter(c => c.type === 'Assignment Agreement' && inRange(c.effective_date ?? c.created_at, f) && !['Draft', 'Terminated'].includes(c.status)).length,
    closed: ds.transactions.filter(t => t.status === 'Closed' && inRange(t.closed_on, f)).length,
    avgDays: avg(done.map(d => daysBetween(d.started_on ?? d.created_at, d.ended_on)).filter((x): x is number => x !== null && x >= 0)) };
}

export function financials(ds: Dataset, f: Filter) {
  const rev = revenueRows(ds, f), exp = ds.expenses.filter(e => inRange(e.date, f) && (!f.campaignId || e.campaign_id === f.campaignId));
  const gross = sum(rev, 'amount'), marketing = sum(exp.filter(e => e.category === 'Marketing'), 'amount'), operating = sum(exp.filter(e => e.category !== 'Marketing'), 'amount');
  return { gross, marketing, operating, net: gross - marketing - operating, deals: rev.length, avgFee: rev.length ? gross / rev.length : null, rev, exp };
}

/** Date range presets and the equivalent previous period for comparisons. */
export function presetRange(preset: string, now = new Date()): { from: string; to: string } {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const t = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const d = (y: number, m: number, dd: number) => new Date(Date.UTC(y, m, dd));
  const y = t.getUTCFullYear(), m = t.getUTCMonth(), q = Math.floor(m / 3) * 3;
  const mon = new Date(t); mon.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  switch (preset) {
    case 'week': return { from: iso(mon), to: iso(t) };
    case 'month': return { from: iso(d(y, m, 1)), to: iso(t) };
    case 'quarter': return { from: iso(d(y, q, 1)), to: iso(t) };
    case 'year': return { from: iso(d(y, 0, 1)), to: iso(t) };
    case '30d': return { from: iso(new Date(t.getTime() - 29 * 864e5)), to: iso(t) };
    case '90d': return { from: iso(new Date(t.getTime() - 89 * 864e5)), to: iso(t) };
    case '12m': return { from: iso(d(y - 1, m + 1, 1)), to: iso(t) };
    default: return { from: '2000-01-01', to: iso(t) };
  }
}
export function previousRange(preset: string, r: { from: string; to: string }): { from: string; to: string } | null {
  if (preset === 'all') return null;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const from = new Date(r.from + 'T00:00:00Z'), to = new Date(r.to + 'T00:00:00Z');
  const shift = (d: Date, months: number) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() - months); return x; };
  if (preset === 'month') return { from: iso(shift(from, 1)), to: iso(shift(to, 1)) };
  if (preset === 'quarter') return { from: iso(shift(from, 3)), to: iso(shift(to, 3)) };
  if (preset === 'year' || preset === '12m') return { from: iso(shift(from, 12)), to: iso(shift(to, 12)) };
  const len = to.getTime() - from.getTime() + 864e5;
  return { from: iso(new Date(from.getTime() - len)), to: iso(new Date(to.getTime() - len)) };
}
