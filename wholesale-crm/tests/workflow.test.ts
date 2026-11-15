// End-to-end workflow test against the real API + an in-memory PostgreSQL (PGlite).
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../server/app';
import { initDb } from '../server/db';
import { tickOrg } from '../server/automation';
import { analyzeDeal, defaultInputs, compStats } from '../shared/calc';
import { defaultSettings } from '../shared/settings';
import { matchBuyer, scoreLead, canContact, renderTemplate } from '../shared/logic';
import { kpis } from '../shared/metrics';

let cookie = '';
async function api(method: string, path: string, body?: unknown, jar = true) {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'crm', ...(jar && cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.get('set-cookie');
  if (set && jar) cookie = set.split(';')[0];
  const json = await res.json().catch(() => null);
  return { status: res.status, json: json as any };
}
const ok = async (method: string, path: string, body?: unknown) => { const r = await api(method, path, body); if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.json)}`); return r.json; };
const list = (e: string, qs = '') => ok('GET', `/api/e/${e}${qs}`);

beforeAll(async () => { await initDb({ memory: true }); }, 60_000);

describe('pure business logic', () => {
  const cfg = defaultSettings().analyzer;
  it('computes MAO with the configurable percent rule', () => {
    const r = analyzeDeal(defaultInputs(cfg, { arv: 200000, repairs: 30000, assignmentFee: 10000, maoPct: 70 }), cfg.thresholds);
    expect(r.buyerMaxPrice).toBe(110000);
    expect(r.mao).toBe(100000);
    const r75 = analyzeDeal(defaultInputs(cfg, { arv: 200000, repairs: 30000, assignmentFee: 10000, maoPct: 75 }), cfg.thresholds);
    expect(r75.mao).toBe(110000);
  });
  it('rates a deal from the projected fee at the asking price', () => {
    const base = { arv: 200000, repairs: 30000, assignmentFee: 10000, maoPct: 70 };
    expect(analyzeDeal(defaultInputs(cfg, { ...base, asking: 90000 }), cfg.thresholds).rating).toBe('Excellent deal'); // fee 20k
    expect(analyzeDeal(defaultInputs(cfg, { ...base, asking: 100000 }), cfg.thresholds).rating).toBe('Potential deal'); // fee 10k
    expect(analyzeDeal(defaultInputs(cfg, { ...base, asking: 106000 }), cfg.thresholds).rating).toBe('Marginal deal'); // fee 4k
    expect(analyzeDeal(defaultInputs(cfg, { ...base, asking: 125000 }), cfg.thresholds).rating).toBe('Poor deal');
    expect(analyzeDeal(defaultInputs(cfg, { ...base, asking: 125000 }), cfg.thresholds).spreadVsAsking).toBe(-25000);
  });
  it('cost-based strategy leaves the buyer exactly the required margin', () => {
    const i = defaultInputs(cfg, { arv: 250000, repairs: 40000, strategy: 'cost', investorMarginPct: 15, loanPct: 80, interestRate: 12, points: 2, holdingMonths: 5 });
    const r = analyzeDeal(i, cfg.thresholds);
    expect(Math.round(r.investorProfit)).toBe(Math.round(250000 * 0.15));
    expect(r.mao).toBeCloseTo(r.buyerMaxPrice - i.assignmentFee, 5);
  });
  it('averages comp price per square foot', () => {
    const s = compStats([{ sale_price: 150000, sqft: 1500 }, { sale_price: 220000, sqft: 2000 }, { sale_price: 99999 }], 1800);
    expect(s.avgPpsf).toBeCloseTo(105, 5); expect(s.impliedArv).toBeCloseTo(189000, 5); expect(s.usable).toBe(2);
  });
  it('scores leads transparently', () => {
    const s = defaultSettings().scoring;
    const hot = scoreLead({ motivation: 'High', timeline: 'ASAP', asking_price: 50000, negotiation: 'Flexible', source: 'Referral' }, { est_value: 100000, mortgage_balance: 0, condition: 'Poor' }, { comms: 4, inbound: 2, lastContactAt: new Date().toISOString(), hasFollowUp: true, overdueTasks: 0 }, s);
    const cold = scoreLead({ motivation: 'Low', timeline: '6+ months', asking_price: 100000 }, { est_value: 100000, mortgage_balance: 95000, condition: 'Excellent' }, { comms: 0, inbound: 0, hasFollowUp: false, overdueTasks: 0 }, s);
    expect(hot.score).toBeGreaterThan(85); expect(hot.band).toBe('Hot'); expect(cold.score).toBeLessThan(20);
    expect(hot.factors.reduce((a, f) => a + f.max, 0)).toBe(100);
    expect(hot.factors.every(f => f.reason.length > 0)).toBe(true);
  });
  it('matches buyers and explains why', () => {
    const buyer = { cities: ['Canton'], property_types: ['Single Family'], min_price: 50000, max_price: 150000, max_repairs: 40000, pof_status: 'Verified' };
    const good = matchBuyer(buyer, { property: { city: 'Canton', property_type: 'Single Family', beds: 3 }, price: 90000, arv: 160000, repairs: 30000 }, { presented: 3, offers: 2, closed: 3 });
    const bad = matchBuyer(buyer, { property: { city: 'Akron', property_type: 'Land' }, price: 300000, arv: 400000, repairs: 90000 });
    expect(good.score).toBeGreaterThan(90); expect(bad.score).toBeLessThan(20);
    expect(matchBuyer({ ...buyer, dnc: true }, { property: {}, price: 1 }).disqualified).toMatch(/do-not-contact/);
  });
  it('never allows contact that violates DNC, consent, suppression or quiet hours', () => {
    const s = defaultSettings(); s.company.address = '1 Main St, Canton OH';
    const noon = new Date('2026-06-01T16:00:00Z'), night = new Date('2026-06-01T03:30:00Z');
    const c = { phone: '(330) 555-0100', email: 'a@example.com', sms_opt_in: true, email_opt_in: true };
    expect(canContact('SMS', c, s, [], { now: noon }).allowed).toBe(true);
    expect(canContact('SMS', { ...c, dnc: true }, s, [], { now: noon }).allowed).toBe(false);
    expect(canContact('SMS', { ...c, sms_opt_in: false }, s, [], { now: noon }).reason).toMatch(/consent/);
    expect(canContact('SMS', c, s, [{ kind: 'Phone', value: '330-555-0100' }], { now: noon }).reason).toMatch(/suppression/);
    expect(canContact('SMS', c, s, [], { now: night }).reason).toMatch(/hours/);
    expect(canContact('Email', { ...c, email_opt_in: false }, s, [], { now: noon }).allowed).toBe(false);
    expect(renderTemplate('Hi {{first_name}} re {{property_address}} {{unknown}}', { contact: { first_name: 'Ann' }, property: { address: '1 Elm' } })).toBe('Hi Ann re 1 Elm {{unknown}}');
  });
});

describe('end-to-end wholesale workflow', () => {
  const S: Record<string, any> = {};
  it('rejects unauthenticated and cross-site requests', async () => {
    expect((await api('GET', '/api/e/leads', undefined, false)).status).toBe(401);
    const res = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(403);
  });
  it('signs up with demo data: 25 leads, 25 properties, 15 buyers', async () => {
    expect((await api('POST', '/api/auth/signup', { company: 'Test Wholesale Co', name: 'Sam Owner', email: 'owner@test.example', password: 'short' })).status).toBe(400);
    await ok('POST', '/api/auth/signup', { company: 'Test Wholesale Co', name: 'Sam Owner', email: 'owner@test.example', password: 'correct-horse-battery' });
    const boot = await ok('GET', '/api/bootstrap');
    S.me = boot.user; S.users = boot.users; S.settings = boot.settings;
    expect(boot.settings._secret).toBeUndefined();
    const [leads, props, buyers, offers, contracts, txns] = await Promise.all(['leads', 'properties', 'buyers', 'offers', 'contracts', 'transactions'].map(e => list(e)));
    expect(leads.length).toBe(25); expect(props.length).toBe(25); expect(buyers.length).toBe(15);
    expect(offers.length).toBeGreaterThanOrEqual(10); expect(contracts.length).toBeGreaterThanOrEqual(5);
    expect(txns.filter((t: any) => !['Closed', 'Cancelled'].includes(t.status)).length).toBe(5);
    expect(leads.every((l: any) => l.is_demo && typeof l.score === 'number' && l.score_detail?.factors?.length === 9)).toBe(true);
    S.revenueBefore = (await list('revenue')).reduce((s: number, r: any) => s + r.amount, 0);
    expect(S.revenueBefore).toBe(42000);
  }, 120_000);

  it('1-4: creates a seller lead with property, detects duplicates, assigns a rep', async () => {
    const rep = S.users.find((u: any) => u.name === 'Jenna Kowalski');
    const payload = { contact: { first_name: 'Test', last_name: 'Seller', phone: '330-555-9911', email: 'Test.Seller@Example.com', sms_opt_in: true }, property: { address: '100 Workflow Way', city: 'Canton', state: 'OH', zip: '44708', property_type: 'Single Family', beds: 3, baths: 1, sqft: 1400, year_built: 1955, condition: 'Poor', est_value: 110000, arv: 180000, repair_cost: 35000, mortgage_balance: 20000 }, lead: { source: 'Referral', motivation: 'High', timeline: 'ASAP', asking_price: 80000, reason: 'Relocating', negotiation: 'Flexible' } };
    const r = await ok('POST', '/api/leads/intake', payload);
    S.lead = r.lead;
    expect(S.lead.stage).toBe('new'); expect(S.lead.score).toBeGreaterThan(50);
    const dup = await api('POST', '/api/leads/intake', payload);
    expect(dup.status).toBe(409); expect(dup.json.details.duplicates.contacts.length).toBe(1); expect(dup.json.details.duplicates.properties.length).toBe(1);
    const prop = await ok('GET', `/api/e/properties/${S.lead.property_id}`);
    expect(prop.market_id).toBeTruthy(); // auto-assigned to Stark County by ZIP
    const contact = await ok('GET', `/api/e/contacts/${S.lead.contact_id}`);
    expect(contact.email).toBe('test.seller@example.com'); expect(contact.phone).toBe('(330) 555-9911'); expect(contact.sms_opt_in_at).toBeTruthy();
    // speed-to-lead automation created an urgent call task
    const tasks = await list('tasks', `?lead_id=${S.lead.id}`);
    expect(tasks.some((t: any) => t.title.includes('Call new lead: Test Seller') && t.priority === 'Urgent')).toBe(true);
    const assigned = await ok('PATCH', `/api/e/leads/${S.lead.id}`, { owner_id: rep.id });
    expect(assigned.owner_id).toBe(rep.id);
    expect((await list('notifications')).every((n: any) => n.user_id === S.me.id)).toBe(true); // only my own notifications are visible
  });

  it('5: logs calls, auto-advances the stage and schedules a follow-up', async () => {
    await ok('POST', '/api/e/communications', { type: 'Call', direction: 'Outbound', lead_id: S.lead.id, outcome: 'No answer' });
    expect((await ok('GET', `/api/e/leads/${S.lead.id}`)).stage).toBe('attempting');
    const fu = new Date(Date.now() + 2 * 864e5).toISOString();
    await ok('POST', '/api/e/communications', { type: 'Call', direction: 'Outbound', lead_id: S.lead.id, outcome: 'Interested', body: 'Wants an offer this week', duration_min: 12, next_action: 'Call with offer', follow_up_at: fu });
    const lead = await ok('GET', `/api/e/leads/${S.lead.id}`);
    expect(lead.stage).toBe('contacted'); expect(lead.contacted_at).toBeTruthy(); expect(lead.first_contact_at).toBeTruthy();
    expect(lead.next_follow_up).toBeTruthy();
    expect(Date.parse(lead.next_follow_up)).toBeLessThanOrEqual(Date.parse(fu));
  });

  it('enforces stage rules and runs the Qualified automation', async () => {
    const bad = await api('PATCH', `/api/e/leads/${S.lead.id}`, { stage: 'dead' });
    expect(bad.status).toBe(422); expect(bad.json.error).toMatch(/Dead reason/);
    await ok('PATCH', `/api/e/leads/${S.lead.id}`, { stage: 'qualified' });
    const tasks = await list('tasks', `?lead_id=${S.lead.id}`);
    expect(tasks.some((t: any) => t.title === 'Underwrite 100 Workflow Way' && t.category === 'Underwrite property')).toBe(true);
    const runs = await list('automation_runs');
    const run = runs.find((r: any) => r.subject.includes('Test Seller') && r.steps.some((s: any) => s.action === 'schedule_followup'));
    expect(run.status).toBe('success');
    expect(run.steps.find((s: any) => s.action === 'schedule_followup').status).toBe('skipped'); // one already existed
  });

  it('6-8: underwrites, creates an offer, marks it accepted', async () => {
    const cfg = S.settings.analyzer;
    const inputs = defaultInputs(cfg, { arv: 180000, repairs: 35000, asking: 80000 });
    const results = analyzeDeal(inputs, cfg.thresholds);
    expect(results.mao).toBe(81000);
    S.analysis = await ok('POST', '/api/e/analyses', { name: 'Scenario A', property_id: S.lead.property_id, lead_id: S.lead.id, inputs, results, rating: results.rating, mao: results.mao, offer_price: 76000 });
    S.offer = await ok('POST', '/api/e/offers', { property_id: S.lead.property_id, lead_id: S.lead.id, analysis_id: S.analysis.id, amount: 76000, emd: 1000, status: 'Draft', method: 'Phone' });
    expect(S.offer.contact_id).toBe(S.lead.contact_id);
    await ok('PATCH', `/api/e/offers/${S.offer.id}`, { status: 'Presented' });
    let lead = await ok('GET', `/api/e/leads/${S.lead.id}`);
    expect(lead.stage).toBe('offer_presented'); expect(lead.offer_at).toBeTruthy();
    const counter = await ok('POST', '/api/e/offers', { property_id: S.lead.property_id, lead_id: S.lead.id, parent_id: S.offer.id, from_party: 'Seller', amount: 82000, status: 'Presented' });
    expect((await ok('GET', `/api/e/offers/${S.offer.id}`)).status).toBe('Countered');
    expect((await ok('GET', `/api/e/leads/${S.lead.id}`)).stage).toBe('negotiating');
    S.final = await ok('POST', '/api/e/offers', { property_id: S.lead.property_id, lead_id: S.lead.id, parent_id: counter.id, amount: 78000, status: 'Presented' });
    await ok('PATCH', `/api/e/offers/${S.final.id}`, { status: 'Accepted' });
    const tasks = await list('tasks', `?lead_id=${S.lead.id}`);
    expect(tasks.some((t: any) => /Prepare and send purchase agreement/.test(t.title))).toBe(true);
  });

  it('9-10: contract executed → transaction + checklist + dispo handoff', async () => {
    S.contract = await ok('POST', '/api/e/contracts', { type: 'Purchase Agreement', property_id: S.lead.property_id, lead_id: S.lead.id, offer_id: S.final.id, purchase_price: 78000, emd: 1000, closing_date: new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10), title_company: 'Test Title', status: 'Sent' });
    await ok('PATCH', `/api/e/contracts/${S.contract.id}`, { seller_signed: true });
    const c = await ok('PATCH', `/api/e/contracts/${S.contract.id}`, { company_signed: true });
    expect(c.status).toBe('Fully Executed'); expect(c.transaction_id).toBeTruthy(); expect(c.effective_date).toBeTruthy();
    S.txn = await ok('GET', `/api/e/transactions/${c.transaction_id}`);
    expect(S.txn.purchase_price).toBe(78000); expect(S.txn.checklist.length).toBeGreaterThan(5); expect(S.txn.status).toBe('Under Contract');
    const lead = await ok('GET', `/api/e/leads/${S.lead.id}`);
    expect(lead.stage).toBe('under_contract'); expect(lead.classification).toBe('Under contract'); expect(lead.contract_at).toBeTruthy();
    expect((await list('transactions', `?lead_id=${S.lead.id}`)).length).toBe(1); // automation did not create a second one
    const tasks = await list('tasks', `?lead_id=${S.lead.id}`);
    expect(tasks.some((t: any) => t.title === 'Open title for 100 Workflow Way')).toBe(true);
  });

  it('11-14: disposition, buyer matching, interest tracking, buyer selection', async () => {
    S.dispo = await ok('POST', '/api/e/dispositions', { property_id: S.lead.property_id, asking_price: 92000, summary: 'Test deal' });
    expect(S.dispo.transaction_id).toBe(S.txn.id); expect(S.dispo.purchase_price).toBe(78000); expect(S.dispo.fee_target).toBe(14000);
    expect((await api('POST', '/api/e/dispositions', { property_id: S.lead.property_id, asking_price: 1 })).status).toBe(409);
    expect((await ok('GET', `/api/e/leads/${S.lead.id}`)).stage).toBe('disposition');
    expect((await ok('GET', `/api/e/transactions/${S.txn.id}`)).status).toBe('Marketing to Buyers');
    const interests = await list('buyer_interests', `?disposition_id=${S.dispo.id}`);
    expect(interests.length).toBeGreaterThan(2); // automation matched buyers
    expect(interests.every((i: any) => i.match_score >= 60 && i.status === 'Matched')).toBe(true);
    const send = await ok('POST', `/api/dispositions/${S.dispo.id}/send`, { interestIds: [interests[0].id], channel: 'Email', subject: 'Deal', body: 'Hi' });
    expect(send.results[0].ok).toBe(false); expect(send.results[0].message).toMatch(/not connected/); // never simulates a send
    expect((await ok('GET', `/api/e/buyer_interests/${interests[0].id}`)).status).toBe('Matched');
    const i1 = await ok('PATCH', `/api/e/buyer_interests/${interests[0].id}`, { status: 'Sent' });
    expect(i1.sent_at).toBeTruthy();
    const i2 = await ok('PATCH', `/api/e/buyer_interests/${interests[0].id}`, { offer_amount: 91000, emd: 3000 });
    expect(i2.status).toBe('Offer Made'); expect(i2.responded_at).toBeTruthy();
    const sel = await ok('POST', `/api/dispositions/${S.dispo.id}/select`, { interestId: i2.id });
    expect(sel.disposition.status).toBe('Buyer Selected'); expect(sel.contract.type).toBe('Assignment Agreement');
    expect(sel.contract.assignment_fee).toBe(13000); expect(sel.transaction.assignment_fee).toBe(13000); expect(sel.transaction.buyer_id).toBe(i2.buyer_id);
    S.assign = sel.contract;
  });

  it('15-18: assignment executed, transaction closed, revenue and dashboard updated', async () => {
    await ok('PATCH', `/api/e/contracts/${S.assign.id}`, { buyer_signed: true, company_signed: true });
    expect((await ok('GET', `/api/e/contracts/${S.assign.id}`)).status).toBe('Fully Executed');
    expect((await ok('GET', `/api/e/transactions/${S.txn.id}`)).status).toBe('Assigned');
    expect((await ok('GET', `/api/e/leads/${S.lead.id}`)).stage).toBe('closing');
    await ok('PATCH', `/api/e/transactions/${S.txn.id}`, { status: 'Closed' });
    const [lead, contracts, dispo, revenue] = await Promise.all([ok('GET', `/api/e/leads/${S.lead.id}`), list('contracts', `?transaction_id=${S.txn.id}`), ok('GET', `/api/e/dispositions/${S.dispo.id}`), list('revenue')]);
    expect(lead.stage).toBe('closed_won'); expect(lead.classification).toBe('Closed'); expect(lead.closed_at).toBeTruthy();
    expect(contracts.every((c: any) => c.status === 'Closed')).toBe(true); expect(dispo.status).toBe('Closed');
    expect(revenue.reduce((s: number, r: any) => s + r.amount, 0)).toBe(S.revenueBefore + 13000);
    expect(revenue.filter((r: any) => r.transaction_id === S.txn.id).length).toBe(1);
    const names = ['leads', 'properties', 'contacts', 'offers', 'contracts', 'transactions', 'revenue', 'expenses', 'communications', 'tasks', 'campaigns', 'dispositions', 'buyer_interests', 'buyers', 'markets'];
    const ds: any = Object.fromEntries(await Promise.all(names.map(async n => [n, await list(n)]))); ds.users = S.users;
    const k = kpis(ds, { from: '2000-01-01', to: '2999-01-01' }, S.settings);
    expect(k.revenue.total).toBe(55000); expect(k.revenue.deals).toBe(4); expect(k.revenue.maxFee).toBe(18500);
    const acts = await list('activities', `?lead_id=${S.lead.id}`);
    for (const frag of ['Lead created', 'Stage:', 'Offer $76,000', 'Purchase Agreement', 'Deal closed']) expect(acts.some((a: any) => a.summary.includes(frag))).toBe(true);
    expect((await list('audit_logs')).some((a: any) => a.entity === 'transactions' && a.action === 'update')).toBe(true);
  });

  it('compliance: DNC stops sequences, blocks sends and cannot be overridden', async () => {
    const r = await ok('POST', '/api/leads/intake', { contact: { first_name: 'Dnc', last_name: 'Person', phone: '3305559922', sms_opt_in: true }, property: null, lead: { source: 'Website Form' } });
    const seqs = await list('sequences');
    await ok('POST', `/api/leads/${r.lead.id}/enroll`, { sequenceId: seqs[0].id });
    expect((await api('POST', `/api/leads/${r.lead.id}/enroll`, { sequenceId: seqs[0].id })).status).toBe(409);
    const boot = await ok('GET', '/api/bootstrap');
    const org = (await ok('GET', `/api/e/leads/${r.lead.id}`)) && boot.org.id;
    await tickOrg(org); // day-0 call step becomes a task
    expect((await list('tasks', `?lead_id=${r.lead.id}`)).some((t: any) => /step 1\/7/.test(t.title))).toBe(true);
    await ok('POST', '/api/e/communications', { type: 'Call', direction: 'Outbound', lead_id: r.lead.id, outcome: 'Do not contact' });
    const contact = await ok('GET', `/api/e/contacts/${r.lead.contact_id}`);
    expect(contact.dnc).toBe(true);
    expect((await list('enrollments', `?lead_id=${r.lead.id}`))[0].status).toBe('Stopped');
    expect((await list('suppressions')).some((s: any) => s.value === '(330) 555-9922')).toBe(true);
    expect((await ok('GET', `/api/e/leads/${r.lead.id}`)).classification).toBe('Do not contact');
    expect((await api('POST', `/api/leads/${r.lead.id}/enroll`, { sequenceId: seqs[0].id })).status).toBe(422);
    const send = await api('POST', '/api/messages/send', { channel: 'SMS', kind: 'contacts', personId: contact.id, body: 'hi' });
    expect(send.status).toBe(424); // no provider connected: refuses instead of pretending
  });

  it('automation failures are logged with a reason and can be retried', async () => {
    const a = await ok('POST', '/api/e/automations', { name: 'SMS on new web lead', enabled: true, trigger: 'lead.created', conditions: [{ field: 'source', op: 'eq', value: 'Google Ads' }], actions: [{ type: 'send_sms', params: { templateId: (await list('templates')).find((t: any) => t.channel === 'SMS').id } }, { type: 'add_tag', params: { tag: 'Texted' } }] });
    const r = await ok('POST', '/api/leads/intake', { contact: { first_name: 'Auto', last_name: 'Fail', phone: '3305559933' }, property: null, lead: { source: 'Google Ads' } });
    const run = (await list('automation_runs', `?automation_id=${a.id}`))[0];
    expect(run.status).toBe('failed'); expect(run.error).toMatch(/not connected/); expect(run.steps[1].status).toBe('not_run');
    expect((await ok('GET', `/api/e/leads/${r.lead.id}`)).tags).not.toContain('Texted');
    const skipped = await ok('POST', '/api/leads/intake', { contact: { first_name: 'Other', last_name: 'Source', phone: '3305559944' }, property: null, lead: { source: 'Referral' } });
    expect(skipped.lead.id).toBeTruthy();
    expect((await list('automation_runs', `?automation_id=${a.id}`)).some((x: any) => x.status === 'skipped' && /Condition not met/.test(x.error))).toBe(true);
    const retry = await ok('POST', `/api/automation-runs/${run.id}/retry`);
    expect(retry.status).toBe('failed'); expect(retry.retry_of).toBe(run.id);
  });

  it('role-based access is enforced on the server', async () => {
    const inv = await ok('POST', '/api/users/invite', { name: 'Rep Two', email: 'rep2@test.example', role: 'Acquisition Representative' });
    const ownerCookie = cookie;
    const token = inv.inviteUrl.split('/').pop();
    cookie = '';
    await ok('POST', '/api/auth/accept-invite', { token, password: 'another-long-password' });
    const mine = await list('leads');
    expect(mine.length).toBe(0); // reps only see their own leads
    expect((await api('GET', `/api/e/leads/${S.lead.id}`)).status).toBe(403);
    expect((await api('GET', '/api/e/buyers')).status).toBe(403);
    expect((await api('PUT', '/api/settings', { company: { name: 'Hacked' } })).status).toBe(403);
    expect((await api('POST', '/api/users/invite', { name: 'X', email: 'x@test.example', role: 'Owner' })).status).toBe(403);
    expect((await api('DELETE', '/api/demo')).status).toBe(403);
    const own = await ok('POST', '/api/leads/intake', { contact: { first_name: 'Rep', last_name: 'Lead', phone: '3305559955' }, property: null, lead: {} });
    expect((await list('leads')).length).toBe(1);
    expect((await api('PATCH', `/api/e/leads/${own.lead.id}`, { owner_id: S.me.id })).status).toBe(403);
    expect((await api('DELETE', `/api/e/leads/${own.lead.id}`)).status).toBe(403);
    cookie = ownerCookie;
  });

  it('tenant isolation: a second organization sees nothing from the first', async () => {
    const ownerCookie = cookie; cookie = '';
    await ok('POST', '/api/auth/signup', { company: 'Other Co', name: 'Other Owner', email: 'other@test.example', password: 'correct-horse-battery', demo: false });
    expect((await list('leads')).length).toBe(0);
    expect((await api('GET', `/api/e/leads/${S.lead.id}`)).status).toBe(404);
    expect((await api('PATCH', `/api/e/leads/${S.lead.id}`, { reason: 'x' })).status).toBe(404);
    expect((await api('POST', '/api/e/tasks', { title: 'x', lead_id: S.lead.id })).status).toBe(400);
    expect((await list('automations')).length).toBeGreaterThan(5); // starter config, not demo
    cookie = ownerCookie;
  }, 60_000);

  it('settings: validates pipeline changes; CSV import merges duplicates', async () => {
    const s = { ...S.settings, stages: S.settings.stages.filter((x: any) => x.id !== 'closed_won') };
    expect((await api('PUT', '/api/settings', s)).status).toBe(400);
    const s2 = { ...S.settings, stages: S.settings.stages.filter((x: any) => x.id !== 'new') };
    expect((await api('PUT', '/api/settings', s2)).status).toBe(409);
    const s3 = { ...S.settings, analyzer: { ...S.settings.analyzer, maoPct: 68 } };
    expect((await ok('PUT', '/api/settings', s3)).analyzer.maoPct).toBe(68);
    const imp = await ok('POST', '/api/import/leads', { source: 'Direct Mail', rows: [
      { first_name: 'Csv', last_name: 'One', phone: '330-555-7001', address: '1 Import St', city: 'Akron', zip: '44311' },
      { first_name: 'Csv', last_name: 'One', phone: '(330) 555-7001', address: '1 Import St', city: 'Akron', zip: '44311' },
      { last_name: 'NoFirst' }, { name: 'Full Name', email: 'bad-email' },
    ] });
    expect(imp.created).toBe(1); expect(imp.duplicates).toBe(1); expect(imp.errors.length).toBe(2);
  });

  it('removes all demo data without touching real records', async () => {
    const before = await list('leads');
    const real = before.filter((l: any) => !l.is_demo).length;
    expect(real).toBeGreaterThan(3);
    const r = await ok('DELETE', '/api/demo');
    expect(r.removed).toBeGreaterThan(300);
    const after = await list('leads');
    expect(after.length).toBe(real); expect(after.some((l: any) => l.is_demo)).toBe(false);
    for (const e of ['properties', 'buyers', 'offers', 'contracts', 'transactions', 'tasks', 'campaigns', 'expenses', 'markets']) expect((await list(e)).some((x: any) => x.is_demo)).toBe(false);
    expect((await ok('GET', `/api/e/transactions/${S.txn.id}`)).status).toBe('Closed');
    expect((await list('revenue')).reduce((s: number, x: any) => s + x.amount, 0)).toBe(13000);
    expect((await ok('GET', '/api/bootstrap')).demoCount).toBe(0);
  }, 60_000);
});
