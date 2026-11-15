// Integration tests for the parts that talk to the outside world, run against local stand-ins:
// an SMTP sink, a mock of the Twilio REST API, a mock of the Anthropic Messages API and a webhook receiver.
// These verify OUR side of each contract (gating, request shape, status handling). They do not prove a real
// provider accepts the requests.
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../server/app';
import { tickOrg } from '../server/automation';
import { initDb } from '../server/db';

type R = Record<string, any>;
let cookie = '';
const RUN = Date.now().toString(36), E = (n: string) => `${n}-${RUN}@int.example`;
async function api(method: string, path: string, body?: unknown, opts: { form?: boolean; headers?: Record<string, string> } = {}) {
  const res = await app.request(path, { method, headers: { 'x-requested-with': 'crm', ...(body && !opts.form && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...opts.headers },
    body: body instanceof FormData || opts.form ? (body as any) : body ? JSON.stringify(body) : undefined });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}
const ok = async (method: string, path: string, body?: unknown) => { const r = await api(method, path, body); if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${r.text.slice(0, 300)}`); return r.json; };
const list = (e: string, qs = '') => ok('GET', `/api/e/${e}${qs}`);
const until = async <T,>(fn: () => Promise<T | null | undefined | false>, ms = 6000): Promise<T> => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('Timed out waiting for condition'); await new Promise(r => setTimeout(r, 60)); } };
const listen = (server: http.Server) => new Promise<number>(res => server.listen(0, '127.0.0.1', () => res((server.address() as AddressInfo).port)));
const readBody = (req: http.IncomingMessage) => new Promise<string>(res => { let b = ''; req.on('data', c => (b += c)); req.on('end', () => res(b)); });
const intake = (first: string, extra: R = {}, lead: R = {}) => ok('POST', '/api/leads/intake', { contact: { first_name: first, last_name: 'Tester', ...extra }, property: null, lead });

const S: R = {};
const servers: { close: () => void }[] = [];
const ENV_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_FROM', 'SMTP_USER', 'SMTP_PASS', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER', 'TWILIO_API_BASE', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ALLOW_PRIVATE_WEBHOOKS', 'APP_URL'];

beforeAll(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.APP_URL = 'http://crm.test';
  await initDb({ memory: true });
  await ok('POST', '/api/auth/signup', { company: 'Integration Co', name: 'Ina Owner', email: E('owner'), password: 'correct-horse-battery', demo: false });
  const boot = await ok('GET', '/api/bootstrap');
  S.me = boot.user; S.org = boot.org.id; S.settings = boot.settings;
  // Deterministic contact hours and a company address (required for email).
  S.settings = await ok('PUT', '/api/settings', { ...boot.settings, company: { ...boot.settings.company, address: '100 Market Ave N, Canton, OH 44702' }, comms: { ...boot.settings.comms, quietStart: 0, quietEnd: 24 } });
}, 120_000);
afterAll(() => { for (const s of servers) s.close(); for (const k of ENV_KEYS) delete process.env[k]; });

describe('record-level access for roles limited to their own records', () => {
  it('a rep cannot read or change another rep\'s seller, even with its id', async () => {
    const mine = await intake('Owned', { phone: '3305550101' });
    const view = await ok('POST', '/api/e/saved_views', { entity: 'leads', name: 'Shared view', shared: true, config: { search: 'x' } });
    const inv = await ok('POST', '/api/users/invite', { name: 'Rita Rep', email: E('rep'), role: 'Acquisition Representative' });
    const owner = cookie; cookie = '';
    await ok('POST', '/api/auth/accept-invite', { token: inv.inviteUrl.split('/').pop(), password: 'another-long-password' });
    expect((await api('GET', `/api/e/contacts/${mine.lead.contact_id}`)).status).toBe(403);
    expect((await api('PATCH', `/api/e/contacts/${mine.lead.contact_id}`, { notes: 'x' })).status).toBe(403);
    expect((await api('GET', `/api/e/activities?lead_id=${mine.lead.id}`)).json.length).toBe(0);
    const own = await intake('Mine', { phone: '3305550102' });
    expect((await api('GET', `/api/e/contacts/${own.lead.contact_id}`)).status).toBe(200);
    expect((await api('PATCH', `/api/e/contacts/${own.lead.contact_id}`, { notes: 'ok' })).status).toBe(200);
    expect((await list('saved_views')).some((v: R) => v.id === view.id)).toBe(true); // shared views are readable
    expect((await api('PATCH', `/api/e/saved_views/${view.id}`, { name: 'Hijacked' })).status).toBe(403); // but not editable
    expect((await api('DELETE', `/api/e/saved_views/${view.id}`)).status).toBe(403);
    S.repLead = own.lead; S.rep = (await ok('GET', '/api/bootstrap')).user;
    cookie = owner;
  });
  it('unassigned leads are assigned before the speed-to-lead task is created', async () => {
    const r = await ok('POST', '/api/import/leads', { owner_id: null, rows: [{ first_name: 'Robin', last_name: 'Round', phone: '3305550103' }] });
    expect(r.created).toBe(1);
    const lead = (await list('leads')).find((l: R) => l.owner_id === S.rep.id && l.id !== S.repLead.id);
    expect(lead).toBeTruthy(); // round robin picked the only acquisition rep
    const task = (await list('tasks', `?lead_id=${lead.id}`)).find((t: R) => /Call new lead: Robin Round/.test(t.title));
    expect(task.assignee_id).toBe(S.rep.id);
  });
});

describe('attachments', () => {
  it('uploads, lists, downloads and rejects disallowed files', async () => {
    const prop = await ok('POST', '/api/e/properties', { address: '1 File St', city: 'Canton', zip: '44702' });
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 1, 2, 3, 250, 251]);
    const fd = new FormData(); fd.append('file', new File([bytes], 'contract.pdf', { type: 'application/pdf' })); fd.append('category', 'Contract'); fd.append('property_id', prop.id);
    const up = await api('POST', '/api/attachments', fd);
    expect(up.status).toBe(200); expect(up.json.size).toBe(bytes.length); expect(up.json.data).toBeUndefined();
    expect((await list('attachments', `?property_id=${prop.id}`)).length).toBe(1);
    const res = await app.request(`/api/attachments/${up.json.id}/download`, { headers: { cookie } });
    expect(res.status).toBe(200); expect(res.headers.get('content-type')).toBe('application/pdf'); expect(res.headers.get('content-disposition')).toMatch(/^attachment/);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...bytes]);
    const bad = new FormData(); bad.append('file', new File(['<script>alert(1)</script>'], 'x.html', { type: 'text/html' })); bad.append('property_id', prop.id);
    expect((await api('POST', '/api/attachments', bad)).status).toBe(415);
    expect((await app.request(`/api/attachments/${up.json.id}/download`)).status).toBe(401);
    S.prop = prop;
  });
});

describe('webhooks and calendar feed', () => {
  it('inbound webhook creates a lead and merges repeat inquiries', async () => {
    const hook = await ok('POST', '/api/e/webhooks', { name: 'Website form', direction: 'Inbound', default_source: 'Website Form', active: true });
    expect(hook.token.length).toBeGreaterThan(20);
    const post = (b: R) => app.request(`/api/hooks/in/${hook.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    const a = await (await post({ first_name: 'Web', last_name: 'Lead', phone: '330-555-0111', email: 'web@lead.example', address: '5 Hook Ln', city: 'Akron', zip: '44311', asking_price: '90000', sms_opt_in: true })).json() as R;
    expect(a.ok).toBe(true); expect(a.duplicate).toBe(false);
    const lead = await ok('GET', `/api/e/leads/${a.lead_id}`);
    expect(lead.source).toBe('Website Form'); expect(lead.asking_price).toBe(90000); expect(lead.property_id).toBeTruthy();
    const b = await (await post({ first_name: 'Web', phone: '(330) 555-0111' })).json() as R;
    expect(b.duplicate).toBe(true); expect(b.lead_id).toBe(a.lead_id);
    expect((await app.request('/api/hooks/in/not-a-token', { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await (await post({ last_name: 'NoFirst' })).json() as R).error).toBeTruthy();
    expect((await list('integration_logs')).filter((l: R) => l.integration === 'webhooks').length).toBeGreaterThanOrEqual(3);
  });
  it('outbound webhook delivers a signed payload; private URLs are refused by default', async () => {
    const got: { sig: string; event: string; body: string }[] = [];
    const server = http.createServer(async (req, res) => { got.push({ sig: String(req.headers['x-signature']), event: String(req.headers['x-event']), body: await readBody(req) }); res.end('ok'); });
    const port = await listen(server); servers.push(server);
    const url = `http://127.0.0.1:${port}/hook`;
    expect((await api('POST', '/api/e/webhooks', { name: 'Local', direction: 'Outbound', url, events: ['lead.created'] })).status).toBe(400);
    process.env.ALLOW_PRIVATE_WEBHOOKS = 'true';
    const hook = await ok('POST', '/api/e/webhooks', { name: 'Local', direction: 'Outbound', url, events: ['lead.created'], active: true });
    const r = await intake('Hooked', { phone: '3305550112' });
    const d = await until(async () => got.find(g => g.event === 'lead.created'));
    expect(JSON.parse(d.body).data.lead_id).toBe(r.lead.id);
    expect(d.sig).toBe(crypto.createHmac('sha256', hook.token).update(d.body).digest('hex'));
    await ok('PATCH', `/api/e/leads/${r.lead.id}`, { stage: 'contacted' });
    await new Promise(res => setTimeout(res, 250));
    expect(got.some(g => g.event === 'lead.stage_changed')).toBe(false); // not subscribed to that event
    delete process.env.ALLOW_PRIVATE_WEBHOOKS;
  });
  it('serves a personal iCalendar feed of open tasks', async () => {
    const boot = await ok('GET', '/api/bootstrap');
    expect(boot.feedUrl).toMatch(/\/api\/calendar\/.+\.ics$/);
    await ok('POST', '/api/e/tasks', { title: 'Calendar; task, one', due_at: new Date(Date.now() + 864e5).toISOString() });
    const res = await app.request(new URL(boot.feedUrl).pathname);
    const text = await res.text();
    expect(res.headers.get('content-type')).toMatch(/text\/calendar/);
    expect(text).toMatch(/BEGIN:VCALENDAR/); expect(text).toContain('SUMMARY:Calendar\\; task\\, one');
    expect((await app.request('/api/calendar/wrong.ics')).status).toBe(404);
  });
});

describe('scheduler: time-based triggers, reminders and expiry', () => {
  it('fires each time-based trigger once per record', async () => {
    const lead = (await intake('Timed', { phone: '3305550120' })).lead;
    const txn = await ok('POST', '/api/e/transactions', { property_id: S.prop.id, lead_id: lead.id, purchase_price: 50000, closing_date: new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10) });
    const overdue = await ok('POST', '/api/e/tasks', { title: 'Way overdue', due_at: new Date(Date.now() - 3 * 36e5).toISOString(), lead_id: lead.id });
    const a1 = await ok('POST', '/api/e/automations', { name: 'T: overdue 1h', enabled: true, trigger: 'task.overdue', trigger_config: { hours: 1 }, actions: [{ type: 'add_note', params: { text: 'Overdue: {{task_title}}' } }] });
    const a2 = await ok('POST', '/api/e/automations', { name: 'T: inactive', enabled: true, trigger: 'lead.inactive', trigger_config: { days: 0 }, conditions: [{ field: 'source', op: 'empty' }], actions: [{ type: 'add_tag', params: { tag: 'Stale' } }] });
    await tickOrg(S.org); await tickOrg(S.org);
    const runs = await list('automation_runs');
    const of = (id: string) => runs.filter((r: R) => r.automation_id === id && r.status === 'success');
    expect(of(a1.id).filter((r: R) => r.context.data.task_id === overdue.id).length).toBe(1);
    expect((await list('activities', `?lead_id=${lead.id}`)).some((a: R) => a.body === 'Overdue: Way overdue')).toBe(true);
    expect(of(a2.id).filter((r: R) => r.context.data.lead_id === lead.id).length).toBe(1);
    expect((await ok('GET', `/api/e/leads/${lead.id}`)).tags).toContain('Stale');
    const closing = (await list('automations')).find((a: R) => a.trigger === 'closing.approaching');
    expect(of(closing.id).filter((r: R) => r.context.data.transaction_id === txn.id).length).toBe(1);
    expect((await list('tasks', `?transaction_id=${txn.id}`)).filter((t: R) => /Confirm closing details for 1 File St/.test(t.title)).length).toBe(1);
    S.lead = lead; S.txn = txn;
  });
  it('sends task reminders and contract deadline alerts once, and expires stale offers', async () => {
    const task = await ok('POST', '/api/e/tasks', { title: 'Soon', due_at: new Date(Date.now() + 10 * 6e4).toISOString(), reminder_min: 30, assignee_id: S.me.id });
    const contract = await ok('POST', '/api/e/contracts', { type: 'Purchase Agreement', property_id: S.prop.id, purchase_price: 50000, status: 'Sent', inspection_end: new Date(Date.now() + 864e5).toISOString().slice(0, 10) });
    const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    const offer = await ok('POST', '/api/e/offers', { property_id: S.prop.id, amount: 40000, status: 'Presented', expires_on: yesterday });
    await tickOrg(S.org); await tickOrg(S.org);
    const notes = await list('notifications');
    expect(notes.filter((n: R) => n.body === 'Soon').length).toBe(1);
    expect((await ok('GET', `/api/e/tasks/${task.id}`)).reminded).toBe(true);
    expect(notes.filter((n: R) => n.dedupe === `deadline:${contract.id}:inspection_end:${contract.inspection_end}`).length).toBe(1);
    expect((await ok('GET', `/api/e/offers/${offer.id}`)).status).toBe('Expired');
  });
});

describe('email through an SMTP server (local sink)', () => {
  const mails: string[] = [];
  const decode = (raw: string) => raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  beforeAll(async () => {
    const smtp = new SMTPServer({ authOptional: true, disabledCommands: ['STARTTLS', 'AUTH'], onData(stream, _s, cb) { let d = ''; stream.on('data', c => (d += c)); stream.on('end', () => { mails.push(d); cb(); }); } });
    const port = await new Promise<number>(res => smtp.listen(0, '127.0.0.1', function (this: any) { res((smtp.server.address() as AddressInfo).port); }));
    servers.push({ close: () => smtp.close() });
    Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_FROM: 'deals@integration.example' });
  });
  it('refuses to send without consent, then sends with footer and unsubscribe link', async () => {
    expect((await ok('GET', '/api/bootstrap')).providers.email).toBe(true);
    const r = await intake('Emma', { email: 'emma@seller.example' });
    const send = (body: R) => api('POST', '/api/messages/send', { channel: 'Email', kind: 'contacts', personId: r.lead.contact_id, lead_id: r.lead.id, ...body });
    const blocked = await send({ body: 'Hi' });
    expect(blocked.status).toBe(422); expect(blocked.json.error).toMatch(/consent/i); expect(mails.length).toBe(0);
    await ok('PATCH', `/api/e/contacts/${r.lead.contact_id}`, { email_opt_in: true, consent_source: 'Web form' });
    const sent = await send({ subject: 'About {{property_address}} from {{company_name}}', body: 'Hi {{first_name}}, this is {{agent_name}}.' });
    expect(sent.status).toBe(200); expect(sent.json.status).toBe('Queued');
    const comm = await until(async () => { const c = await ok('GET', `/api/e/communications/${sent.json.id}`); return c.status !== 'Queued' && c; });
    expect(comm.status).toBe('Sent'); expect(comm.provider).toBe('smtp');
    const mail = decode(mails[0]);
    expect(mail).toMatch(/To: emma@seller\.example/); expect(mail).toMatch(/From: deals@integration\.example/); expect(mail).toMatch(/Subject: About  from Integration Co/);
    expect(mail).toContain('Hi Emma, this is Ina Owner.'); expect(mail).toContain('100 Market Ave N, Canton, OH 44702');
    const link = mail.match(/Unsubscribe: (http:\/\/crm\.test\/api\/unsubscribe\/[\w-]+)/)![1];
    expect((await list('activities', `?lead_id=${r.lead.id}`)).some((a: R) => a.summary === 'Outgoing email')).toBe(true);
    expect((await list('integration_logs')).some((l: R) => l.integration === 'smtp' && l.level === 'info')).toBe(true);
    // Unsubscribe link: no login needed, removes consent, adds a suppression, and blocks the next send.
    expect((await app.request('/api/unsubscribe/garbage')).status).toBe(400);
    const un = await app.request(new URL(link).pathname);
    expect(un.status).toBe(200); expect(await un.text()).toMatch(/unsubscribed/i);
    const contact = await ok('GET', `/api/e/contacts/${r.lead.contact_id}`);
    expect(contact.email_opt_in).toBe(false); expect(contact.opted_out_at).toBeTruthy();
    expect((await list('suppressions')).some((s: R) => s.kind === 'Email' && s.value === 'emma@seller.example')).toBe(true);
    await ok('PATCH', `/api/e/contacts/${r.lead.contact_id}`, { email_opt_in: true }); // consent re-ticked by mistake
    const again = await send({ body: 'Hi again' });
    expect(again.status).toBe(422); expect(again.json.error).toMatch(/suppression/i); expect(mails.length).toBe(1);
  });
  it('automations and sequences send email only to consenting sellers', async () => {
    const tpl = await ok('POST', '/api/e/templates', { name: 'Auto email', channel: 'Email', subject: 'Hello {{first_name}}', body: 'Automated hello to {{first_name}}.' });
    const auto = await ok('POST', '/api/e/automations', { name: 'T: email referral leads', enabled: true, trigger: 'lead.created', conditions: [{ field: 'source', op: 'eq', value: 'Referral' }], actions: [{ type: 'send_email', params: { templateId: tpl.id } }] });
    const before = mails.length;
    const yes = await intake('Yes', { email: 'yes@seller.example', email_opt_in: true }, { source: 'Referral' });
    const no = await intake('No', { email: 'no@seller.example' }, { source: 'Referral' });
    await until(async () => mails.length > before);
    const runs = await list('automation_runs', `?automation_id=${auto.id}`);
    const run = (leadId: string) => runs.find((x: R) => x.context.data.lead_id === leadId);
    expect(run(yes.lead.id).status).toBe('success'); expect(run(no.lead.id).status).toBe('failed'); expect(run(no.lead.id).error).toMatch(/consent/i);
    await new Promise(res => setTimeout(res, 200));
    expect(mails.length).toBe(before + 1); expect(decode(mails[before])).toContain('Automated hello to Yes.');
    // Sequence: day-0 email step. Consenting seller gets it; the other is skipped with a logged reason.
    const seq = await ok('POST', '/api/e/sequences', { name: 'T: email now', active: true, steps: [{ day: 0, channel: 'Email', templateId: tpl.id }, { day: 5, channel: 'Call', note: 'Call' }] });
    await ok('POST', `/api/leads/${yes.lead.id}/enroll`, { sequenceId: seq.id }); await ok('POST', `/api/leads/${no.lead.id}/enroll`, { sequenceId: seq.id });
    const n = mails.length;
    await tickOrg(S.org);
    await until(async () => mails.length > n);
    await new Promise(res => setTimeout(res, 200));
    expect(mails.length).toBe(n + 1);
    expect((await list('activities', `?lead_id=${no.lead.id}`)).some((a: R) => /Email step skipped — No email consent/.test(a.summary))).toBe(true);
    const en = await list('enrollments', `?lead_id=${yes.lead.id}`);
    expect(en[0].step_index).toBe(1); expect(en[0].status).toBe('Active');
    // An inbound reply pauses the sequence.
    await ok('POST', '/api/e/communications', { type: 'Email', direction: 'Inbound', lead_id: yes.lead.id, body: 'Call me' });
    expect((await list('enrollments', `?lead_id=${yes.lead.id}`))[0].status).toBe('Paused');
  });
});

describe('SMS through the Twilio REST API (local mock)', () => {
  const calls: { path: string; auth: string; form: URLSearchParams }[] = [];
  let failNext = false;
  beforeAll(async () => {
    const server = http.createServer(async (req, res) => {
      const form = new URLSearchParams(await readBody(req));
      calls.push({ path: req.url ?? '', auth: String(req.headers.authorization), form });
      res.setHeader('content-type', 'application/json');
      if (failNext) { failNext = false; res.statusCode = 400; return res.end(JSON.stringify({ code: 21211, message: "The 'To' number is not a valid phone number." })); }
      res.statusCode = 201; res.end(JSON.stringify({ sid: 'SM_test_1', status: 'queued' }));
    });
    const port = await listen(server); servers.push(server);
    Object.assign(process.env, { TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'secret-token', TWILIO_FROM_NUMBER: '+13305550000', TWILIO_API_BASE: `http://127.0.0.1:${port}` });
  });
  it('sends only with consent and inside contact hours; records failures honestly', async () => {
    const r = await intake('Sam', { phone: '330-555-0130' });
    const send = (body = 'Hi {{first_name}}') => api('POST', '/api/messages/send', { channel: 'SMS', kind: 'contacts', personId: r.lead.contact_id, lead_id: r.lead.id, body });
    expect((await send()).json.error).toMatch(/consent/i); expect(calls.length).toBe(0);
    await ok('PATCH', `/api/e/contacts/${r.lead.contact_id}`, { sms_opt_in: true });
    await ok('PUT', '/api/settings', { ...S.settings, comms: { ...S.settings.comms, quietStart: 0, quietEnd: 0 } });
    expect((await send()).json.error).toMatch(/contact hours/i); expect(calls.length).toBe(0);
    await ok('PUT', '/api/settings', S.settings);
    const sent = await send();
    expect(sent.status).toBe(200);
    expect((await until(async () => { const c = await ok('GET', `/api/e/communications/${sent.json.id}`); return c.status !== 'Queued' && c; })).status).toBe('Sent');
    expect(calls[0].path).toBe('/2010-04-01/Accounts/ACtest/Messages.json');
    expect(calls[0].auth).toBe('Basic ' + Buffer.from('ACtest:secret-token').toString('base64'));
    expect(Object.fromEntries(calls[0].form)).toEqual({ To: '+13305550130', From: '+13305550000', Body: 'Hi Sam' });
    failNext = true;
    const bad = await send('Second');
    const failed = await until(async () => { const c = await ok('GET', `/api/e/communications/${bad.json.id}`); return c.status !== 'Queued' && c; });
    expect(failed.status).toBe('Failed');
    expect((await list('integration_logs')).some((l: R) => l.integration === 'twilio' && l.level === 'error' && /not a valid phone number/.test(l.message))).toBe(true);
    S.smsLead = r.lead;
  });
  it('inbound STOP reply opts the seller out; forged requests are rejected', async () => {
    const hook = await ok('POST', '/api/e/webhooks', { name: 'Twilio inbound', direction: 'Inbound', active: true });
    const path = `/api/hooks/twilio/${hook.token}`;
    const post = (params: Record<string, string>, token = 'secret-token') => {
      const sig = crypto.createHmac('sha1', token).update('http://crm.test' + path + Object.keys(params).sort().map(k => k + params[k]).join('')).digest('base64');
      return app.request(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig }, body: new URLSearchParams(params).toString() });
    };
    expect((await post({ From: '+13305550130', Body: 'STOP' }, 'wrong-token')).status).toBe(403);
    expect((await ok('GET', `/api/e/contacts/${S.smsLead.contact_id}`)).sms_opt_in).toBe(true);
    const res = await post({ From: '+13305550130', Body: 'Stop' });
    expect(res.status).toBe(200); expect(await res.text()).toBe('<Response></Response>');
    const contact = await ok('GET', `/api/e/contacts/${S.smsLead.contact_id}`);
    expect(contact.sms_opt_in).toBe(false); expect(contact.opted_out_at).toBeTruthy();
    expect((await list('suppressions')).some((s: R) => s.kind === 'Phone' && s.reason === 'Replied STOP')).toBe(true);
    expect((await list('communications', `?lead_id=${S.smsLead.id}`)).length).toBe(2); // the two outbound attempts
    expect((await list('communications', `?contact_id=${S.smsLead.contact_id}`)).some((c: R) => c.direction === 'Inbound' && c.body === 'Stop')).toBe(true);
    const n = calls.length;
    const again = await api('POST', '/api/messages/send', { channel: 'SMS', kind: 'contacts', personId: S.smsLead.contact_id, body: 'Still there?' });
    expect(again.status).toBe(422); expect(calls.length).toBe(n);
  });
});

describe('AI features against a mock of the Anthropic Messages API', () => {
  const reqs: R[] = [];
  beforeAll(async () => {
    const msg = (content: R[], stop_reason = 'end_turn') => ({ id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } });
    const server = http.createServer(async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}'); reqs.push({ url: req.url, key: String(req.headers['x-api-key'] ?? req.headers.authorization), beta: req.headers['anthropic-beta'], body });
      const system = typeof body.system === 'string' ? body.system : JSON.stringify(body.system ?? '');
      res.setHeader('content-type', 'application/json');
      if (/summarize motivated-seller leads/.test(system)) return res.end(JSON.stringify(msg([{ type: 'text', text: JSON.stringify({ summary: 'Motivated seller.', motivation: 'High', property_condition: 'Poor', asking_price: '$80,000', timeline: 'ASAP', seller_sentiment: 'positive', objections: [], missing_information: ['Roof age'], next_steps: [{ title: 'Call seller with offer', due_in_days: 1, category: 'Call seller', why: 'Asked for an offer' }] }) }])));
      if (/summarize sales calls/.test(system)) return res.end(JSON.stringify(msg([{ type: 'text', text: JSON.stringify({ summary: 'Discussed price.', seller_sentiment: 'neutral', important_details: ['Wants $80k'], action_items: [{ title: 'Send comps', due_in_days: 2, category: 'Follow up' }], follow_up_recommendation: 'Call Friday.' }) }])));
      if (/underwriting reviewer/.test(system)) return res.end(JSON.stringify(msg([{ type: 'text', text: 'Risk: repairs look light.' }])));
      const last = body.messages[body.messages.length - 1];
      const hasResult = Array.isArray(last.content) && last.content.some((b: R) => b.type === 'tool_result');
      if (!hasResult) return res.end(JSON.stringify(msg([{ type: 'tool_use', id: 'toolu_1', name: 'business_metrics', input: { report: 'lead_sources' } }, { type: 'tool_use', id: 'toolu_2', name: 'list_records', input: { entity: 'leads', filters: [{ field: 'source', op: 'eq', value: 'Referral' }], fields: ['source', 'seller'], limit: 5 } }], 'tool_use')));
      res.end(JSON.stringify(msg([{ type: 'text', text: 'Referral produced the most leads.' }])));
    });
    const port = await listen(server); servers.push(server);
    Object.assign(process.env, { ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` });
  });
  it('lead summary and call summary return structured output built from CRM records', async () => {
    expect((await ok('GET', '/api/bootstrap')).providers.ai).toBe(true);
    await ok('POST', '/api/e/communications', { type: 'Call', direction: 'Outbound', lead_id: S.lead.id, outcome: 'Interested', body: 'Wants 80k', transcript: 'Agent: Hello.\nSeller: I want $80k.' });
    const s = await ok('POST', '/api/ai/lead-summary', { leadId: S.lead.id });
    expect(s.summary).toBe('Motivated seller.'); expect(s.next_steps[0].category).toBe('Call seller'); expect(s.based_on.conversations).toBe(1);
    const sent = reqs[reqs.length - 1];
    expect(sent.key).toContain('sk-test'); expect(sent.body.fallbacks).toBe('default'); expect(sent.body.model).toBe('claude-opus-5-5'); expect(sent.body.output_config.effort).toBe('medium'); expect(sent.body.output_config.format.type).toBe('json_schema');
    expect(sent.body.messages[0].content).toContain('Wants 80k'); expect(sent.body.messages[0].content).toContain('"first_name":"Timed"');
    const comm = (await list('communications', `?lead_id=${S.lead.id}`))[0];
    const c = await ok('POST', '/api/ai/call-summary', { commId: comm.id });
    expect(c.action_items[0].title).toBe('Send comps'); expect(reqs[reqs.length - 1].body.messages[0].content).toContain('Seller: I want $80k.');
    const noTranscript = await ok('POST', '/api/e/communications', { type: 'Call', direction: 'Outbound', lead_id: S.lead.id, outcome: 'No answer' });
    expect((await api('POST', '/api/ai/call-summary', { commId: noTranscript.id })).status).toBe(422);
  });
  it('deal review returns text; the analyst runs its tools on real records', async () => {
    const review = await ok('POST', '/api/ai/deal-review', { inputs: { arv: 100000, repairs: 5000 }, results: { mao: 55000 }, comps: [], checks: [] });
    expect(review.text).toBe('Risk: repairs look light.');
    const n = reqs.length;
    const a = await ok('POST', '/api/ai/ask', { question: 'Which source produced the most leads?' });
    expect(a.answer).toBe('Referral produced the most leads.');
    expect(a.trace.map((t: R) => t.tool)).toEqual(['business_metrics', 'list_records']);
    expect(a.trace[1].rows).toBe(2); // the two Referral leads created in the email tests
    const [first, second] = reqs.slice(n);
    expect(first.body.max_iterations).toBeUndefined(); expect(first.body.stream).toBe(false); expect(first.body.fallbacks).toBe('default'); expect(first.beta).toContain('server-side-fallback-2026-07-01');
    expect(first.body.tools.map((t: R) => t.name)).toEqual(['list_records', 'business_metrics']);
    expect(first.body.messages[first.body.messages.length - 1].content).toBe('Which source produced the most leads?');
    const results = second.body.messages[second.body.messages.length - 1].content.filter((b: R) => b.type === 'tool_result');
    expect(results.length).toBe(2);
    const text = (b: R) => (typeof b.content === 'string' ? b.content : b.content.map((x: R) => x.text).join(''));
    expect(JSON.parse(text(results[0])).find((s: R) => s.source === 'Referral').leads).toBe(2);
    expect(JSON.parse(text(results[1])).total_matching).toBe(2);
  });
  it('AI endpoints respect permissions and report a missing key instead of inventing an answer', async () => {
    const owner = cookie; cookie = '';
    await ok('POST', '/api/auth/login', { email: E('rep'), password: 'another-long-password' });
    expect((await api('POST', '/api/ai/ask', { question: 'Revenue?' })).status).toBe(403); // reps have no analytics access
    expect((await api('POST', '/api/ai/lead-summary', { leadId: S.lead.id })).status).toBe(403); // not their lead
    cookie = owner;
    delete process.env.ANTHROPIC_API_KEY;
    const r = await api('POST', '/api/ai/ask', { question: 'Revenue?' });
    expect(r.status).toBe(424); expect(r.json.error).toMatch(/not connected/i);
  });
});
