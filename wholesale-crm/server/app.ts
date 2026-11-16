// HTTP API. Every /api route (except auth and public hooks) requires a session; all writes run inside a
// transaction through the service layer, then queued events (automations, webhooks) are processed.
import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import crypto from 'node:crypto';
import { ENTITY, ROLES, normalizePhone, validate } from '../shared/schema';
import { defaultSettings, mergeSettings, RESOURCES, type OrgSettings } from '../shared/settings';
import { AUTOMATION_TEMPLATES } from '../shared/automation';
import { findDuplicates, contactName } from '../shared/logic';
import { one, q, tx } from './db';
import * as repo from './repo';
import { HttpError } from './repo';
import * as auth from './auth';
import * as svc from './service';
import type { Ctx, User } from './service';
import { drainEvents, enrollLead, matchBuyersToDisposition, retryRun, selectBuyer, tickOrg } from './automation';
import { aiReady, catalog, isSafeWebhookUrl, logIntegration, mergeContext, queueMessage, smtpReady, testIntegration, twilioReady, verifyUnsubToken, appUrl } from './integrations';
import { removeDemo, seedDemo, seedStarterConfig } from './seed';
import * as ai from './ai';

type R = Record<string, any>;
type Env = { Variables: { user: User } };
export const app = new Hono<Env>();

const READ_ONLY = new Set(['audit_logs', 'automation_runs', 'integration_logs']);
const NO_GENERIC_CREATE = new Set(['attachments', 'enrollments', 'revenue_auto']);

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message, details: err.details }, err.status as any);
  const code = String((err as any)?.code ?? '');
  if (code === '23505') return c.json({ error: 'That record already exists.' }, 409);
  if (code === '23503') return c.json({ error: 'This record is linked to other records and cannot be removed or changed that way.' }, 409);
  console.error(err);
  return c.json({ error: 'Something went wrong on the server. The error has been logged.' }, 500);
});

const body = async (c: Context): Promise<R> => { try { const b = await c.req.json(); return b && typeof b === 'object' ? b : {}; } catch { return {}; } };
const ip = (c: Context) => c.req.header('x-forwarded-for')?.split(',')[0].trim() ?? 'local';

/** Runs a write: one transaction, service context for the signed-in user, then automations/webhooks. */
async function mutate<T>(c: Context<Env>, fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  const user = c.get('user');
  return tx(async () => { const ctx = await svc.makeCtx(user.org_id, user); const r = await fn(ctx); await drainEvents(ctx); return r; });
}
const read = async (c: Context<Env>) => svc.makeCtx(c.get('user').org_id, c.get('user'));
function requireAdmin(ctx: Ctx, resource: string) { if (svc.access(ctx, resource, 'write') !== 'all') throw new HttpError(403, `Your role cannot manage ${resource}.`); }

app.use('/api/*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'same-origin');
  if (!c.res.headers.get('Cache-Control')) c.header('Cache-Control', 'no-store');
});

// CSRF: state-changing requests must carry a custom header browsers will not send cross-site without CORS approval.
app.use('/api/*', async (c, next) => {
  const p = c.req.path;
  if (c.req.method !== 'GET' && !p.startsWith('/api/hooks/') && c.req.header('x-requested-with') !== 'crm') return c.json({ error: 'Missing request header.' }, 403);
  await next();
});

// ---------- Auth ----------
const cleanSettings = (s: OrgSettings) => { const o: any = { ...s }; delete o._secret; return o as OrgSettings; };

app.post('/api/auth/signup', async c => {
  if (process.env.ALLOW_SIGNUP === 'false') throw new HttpError(403, 'Sign-up is disabled on this server. Ask your administrator for an invite.');
  auth.rateLimit(`signup:${ip(c)}`, 5, 600_000);
  const b = await body(c);
  const email = String(b.email ?? '').trim().toLowerCase(), name = String(b.name ?? '').trim(), company = String(b.company ?? '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new HttpError(400, 'Enter a valid email address');
  if (!name || !company) throw new HttpError(400, 'Name and company are required');
  const password = auth.validatePassword(b.password);
  if (await one('select 1 from users where email = $1', [email])) throw new HttpError(409, 'An account with this email already exists. Sign in instead.');
  const hash = await auth.hashPassword(password);
  const user = await tx(async () => {
    const org = await one('insert into organizations (name, settings) values ($1, $2::jsonb) returning id', [company, JSON.stringify(defaultSettings(company))]);
    const u = await one(`insert into users (org_id, email, name, password_hash, role, department, feed_token) values ($1, $2, $3, $4, 'Owner', 'Leadership', $5) returning id, org_id, email, name, role, status`, [org.id, email, name, hash, auth.newToken()]);
    const ctx = await svc.makeCtx(org.id, null, 'system');
    await seedStarterConfig(ctx);
    if (b.demo !== false) await seedDemo(ctx, u.id);
    return u;
  });
  setCookie(c, 'sid', await auth.createSession(user.id), auth.cookieOpts());
  return c.json({ ok: true });
});

app.post('/api/auth/login', async c => {
  const b = await body(c);
  const email = String(b.email ?? '').trim().toLowerCase();
  auth.rateLimit(`login:${ip(c)}:${email}`);
  const u = await one('select id, password_hash, status from users where email = $1', [email]);
  const ok = await auth.verifyPassword(String(b.password ?? ''), u?.password_hash);
  if (!u || !ok) throw new HttpError(401, 'Incorrect email or password.');
  if (u.status !== 'active') throw new HttpError(403, 'This account is disabled. Contact your administrator.');
  setCookie(c, 'sid', await auth.createSession(u.id), auth.cookieOpts());
  return c.json({ ok: true });
});

app.get('/api/auth/invite/:token', async c => {
  const u = await one(`select u.email, u.name, u.role, o.name as company from users u join organizations o on o.id = u.org_id where u.invite_token = $1 and u.status = 'invited'`, [c.req.param('token')]);
  if (!u) throw new HttpError(404, 'This invite link is invalid or has already been used.');
  return c.json(u);
});
app.post('/api/auth/accept-invite', async c => {
  const b = await body(c);
  auth.rateLimit(`invite:${ip(c)}`);
  const u = await one(`select id from users where invite_token = $1 and status = 'invited'`, [String(b.token ?? '')]);
  if (!u) throw new HttpError(404, 'This invite link is invalid or has already been used.');
  const hash = await auth.hashPassword(auth.validatePassword(b.password));
  await q(`update users set password_hash = $2, status = 'active', invite_token = null, name = coalesce(nullif($3, ''), name), feed_token = $4 where id = $1`, [u.id, hash, String(b.name ?? '').trim(), auth.newToken()]);
  setCookie(c, 'sid', await auth.createSession(u.id), auth.cookieOpts());
  return c.json({ ok: true });
});

// ---------- Public hooks (token-authenticated) ----------
app.post('/api/hooks/in/:token', async c => {
  const hook = await one(`select * from webhooks where token = $1 and direction = 'Inbound' and active = true`, [c.req.param('token')]);
  if (!hook) return c.json({ error: 'Unknown webhook' }, 404);
  auth.rateLimit(`hook:${hook.id}`, 120, 60_000);
  const b = await body(c);
  try {
    const res = await tx(async () => {
      const ctx = await svc.makeCtx(hook.org_id, null, 'import');
      const r = await intake(ctx, { contact: b, property: b.address ? b : null, lead: { ...b, source: b.source ?? hook.default_source ?? 'Website Form' }, mode: 'merge' });
      await drainEvents(ctx); return r;
    });
    await logIntegration(hook.org_id, 'webhooks', 'info', `Inbound "${hook.name}": lead ${res.duplicate ? 'matched existing seller' : 'created'}`, { lead_id: res.lead.id });
    return c.json({ ok: true, lead_id: res.lead.id, duplicate: res.duplicate });
  } catch (e: any) {
    await logIntegration(hook.org_id, 'webhooks', 'error', `Inbound "${hook.name}" rejected: ${e?.message ?? e}`);
    return c.json({ error: e instanceof HttpError ? e.message : 'Invalid payload' }, 400);
  }
});

app.post('/api/hooks/twilio/:token', async c => {
  const hook = await one(`select * from webhooks where token = $1 and direction = 'Inbound' and active = true`, [c.req.param('token')]);
  if (!hook || !twilioReady()) return c.text('Not found', 404);
  const form = Object.fromEntries((await c.req.formData()).entries()) as Record<string, string>;
  const expected = crypto.createHmac('sha1', process.env.TWILIO_AUTH_TOKEN!).update(`${appUrl()}${c.req.path}` + Object.keys(form).sort().map(k => k + form[k]).join('')).digest('base64');
  if (c.req.header('x-twilio-signature') !== expected) return c.text('Bad signature', 403);
  const from = normalizePhone(form.From ?? ''), text = String(form.Body ?? '').trim();
  await tx(async () => {
    const ctx = await svc.makeCtx(hook.org_id, null, 'system');
    const digits = `%${from.slice(-10).split('').join('%')}%`;
    const contact = (await q(`select id from contacts where org_id = $1 and (phone like $2 or phone2 like $2) limit 1`, [hook.org_id, digits])).rows[0];
    const buyer = contact ? null : (await q(`select id from buyers where org_id = $1 and phone like $2 limit 1`, [hook.org_id, digits])).rows[0];
    const stop = /^(stop|stopall|unsubscribe|cancel|end|quit)$/i.test(text);
    if (contact || buyer) {
      await svc.create(ctx, 'communications', { type: 'SMS', direction: 'Inbound', contact_id: contact?.id ?? null, buyer_id: buyer?.id ?? null, body: text, provider: 'twilio' }, { system: true });
      if (stop) await svc.patch(ctx, contact ? 'contacts' : 'buyers', (contact ?? buyer).id, { sms_opt_in: false }, { system: true });
    }
    if (stop && !(await one(`select 1 from suppressions where org_id = $1 and kind = 'Phone' and value = $2`, [hook.org_id, from])))
      await repo.insert(hook.org_id, 'suppressions', { kind: 'Phone', value: from, reason: 'Replied STOP', source: 'Twilio inbound' });
    await drainEvents(ctx);
  });
  return c.body('<Response></Response>', 200, { 'Content-Type': 'text/xml' });
});

app.get('/api/unsubscribe/:token', async c => {
  const t = await verifyUnsubToken(c.req.param('token')).catch(() => null);
  if (!t) return c.html('<p>This unsubscribe link is not valid.</p>', 400);
  await tx(async () => {
    const ctx = await svc.makeCtx(t.org, null, 'system');
    const p = await repo.get(t.org, t.kind, t.id);
    if (!p) return;
    await svc.patch(ctx, t.kind, t.id, { email_opt_in: false }, { system: true });
    if (p.email && !(await one(`select 1 from suppressions where org_id = $1 and kind = 'Email' and value = $2`, [t.org, p.email])))
      await repo.insert(t.org, 'suppressions', { kind: 'Email', value: p.email, reason: 'Unsubscribed via email link', source: 'Unsubscribe link' });
  });
  return c.html('<div style="font:16px system-ui;max-width:480px;margin:80px auto;text-align:center"><h2>You have been unsubscribed</h2><p>You will not receive further emails from us.</p></div>');
});

app.get('/api/calendar/:file', async c => {
  const token = c.req.param('file').replace(/\.ics$/, '');
  const u = await one(`select id, org_id from users where feed_token = $1 and status = 'active'`, [token]);
  if (!u) return c.text('Not found', 404);
  const tasks = (await q(`select id, title, description, due_at from tasks where org_id = $1 and assignee_id = $2 and status in ('Open','In Progress') and due_at is not null`, [u.org_id, u.id])).rows;
  const closings = (await q(`select t.id, t.closing_date, p.address from transactions t join properties p on p.id = t.property_id where t.org_id = $1 and t.status not in ('Closed','Cancelled') and t.closing_date is not null`, [u.org_id])).rows;
  const esc = (s: string) => String(s ?? '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  const stamp = (d: string) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Wholesale CRM//EN', 'X-WR-CALNAME:CRM tasks & closings',
    ...tasks.flatMap(t => ['BEGIN:VEVENT', `UID:task-${t.id}@crm`, `DTSTAMP:${stamp(new Date().toISOString())}`, `DTSTART:${stamp(t.due_at)}`, `DTEND:${stamp(new Date(Date.parse(t.due_at) + 18e5).toISOString())}`, `SUMMARY:${esc(t.title)}`, `DESCRIPTION:${esc(t.description ?? '')}`, 'END:VEVENT']),
    ...closings.flatMap(t => ['BEGIN:VEVENT', `UID:closing-${t.id}@crm`, `DTSTAMP:${stamp(new Date().toISOString())}`, `DTSTART;VALUE=DATE:${String(t.closing_date).replace(/-/g, '')}`, `SUMMARY:${esc(`Closing: ${t.address}`)}`, 'END:VEVENT']),
    'END:VCALENDAR'];
  return c.body(lines.join('\r\n'), 200, { 'Content-Type': 'text/calendar; charset=utf-8' });
});

// ---------- Session guard ----------
app.use('/api/*', async (c, next) => {
  const p = c.req.path;
  if (p.startsWith('/api/auth/') && p !== '/api/auth/logout' && p !== '/api/auth/password') return next();
  const token = getCookie(c, 'sid');
  const user = token ? await auth.sessionUser(token) : null;
  if (!user) return c.json({ error: 'Not signed in' }, 401);
  c.set('user', user);
  await next();
});

app.post('/api/auth/logout', async c => { const t = getCookie(c, 'sid'); if (t) await auth.destroySession(t); deleteCookie(c, 'sid', { path: '/' }); return c.json({ ok: true }); });
app.post('/api/auth/password', async c => {
  const b = await body(c), u = c.get('user');
  auth.rateLimit(`pw:${u.id}`);
  const row = await one('select password_hash from users where id = $1', [u.id]);
  if (!(await auth.verifyPassword(String(b.current ?? ''), row.password_hash))) throw new HttpError(400, 'Current password is incorrect.');
  await q('update users set password_hash = $2 where id = $1', [u.id, await auth.hashPassword(auth.validatePassword(b.next))]);
  return c.json({ ok: true });
});

const userCols = 'id, email, name, role, department, phone, status, is_demo, last_login_at, created_at';
app.get('/api/bootstrap', async c => {
  const user = c.get('user'), ctx = await read(c);
  const org = await one('select id, name from organizations where id = $1', [user.org_id]);
  const users = (await q(`select ${userCols} from users where org_id = $1 order by created_at`, [user.org_id])).rows;
  const demo = (await one(`select (select count(*) from leads where org_id = $1 and is_demo)::int + (select count(*) from buyers where org_id = $1 and is_demo)::int as n`, [user.org_id])).n;
  const me = await one('select feed_token from users where id = $1', [user.id]);
  return c.json({ user, org, settings: cleanSettings(ctx.settings), users, demoCount: demo, providers: { sms: twilioReady(), email: smtpReady(), ai: aiReady() }, feedUrl: me.feed_token ? `${appUrl()}/api/calendar/${me.feed_token}.ics` : null, appUrl: appUrl() });
});

// ---------- Settings ----------
app.put('/api/settings', async c => {
  const b = await body(c);
  const settings = await mutate(c, async ctx => {
    requireAdmin(ctx, 'settings');
    const raw = (await one('select settings from organizations where id = $1', [ctx.org])).settings ?? {};
    const next = mergeSettings({ ...b, _secret: raw._secret }, ctx.settings.company.name);
    if (!Array.isArray(next.stages) || next.stages.length < 2) throw new HttpError(400, 'A pipeline needs at least two stages.');
    const ids = new Set<string>();
    for (const s of next.stages) {
      if (!s.id || !s.name?.trim()) throw new HttpError(400, 'Every stage needs a name.');
      if (ids.has(s.id)) throw new HttpError(400, `Duplicate stage id "${s.id}".`);
      ids.add(s.id);
    }
    for (const m of ['closed', 'dead'] as const) if (!next.stages.some(s => s.milestone === m)) throw new HttpError(400, `The pipeline needs a ${m === 'closed' ? 'won/closed' : 'dead'} stage so deals can finish.`);
    const used = (await q('select stage, count(*)::int as n from leads where org_id = $1 group by stage', [ctx.org])).rows.filter(r => !ids.has(r.stage));
    if (used.length) throw new HttpError(409, `Cannot remove stage "${ctx.settings.stages.find(s => s.id === used[0].stage)?.name ?? used[0].stage}": ${used[0].n} lead(s) are in it. Move them first.`);
    for (const role of ['Owner', 'Administrator'] as const) for (const r of RESOURCES) next.permissions[role][r] = { read: 'all', write: 'all', delete: true };
    await q('update organizations set settings = $2::jsonb, name = $3 where id = $1', [ctx.org, JSON.stringify(next), next.company.name || ctx.settings.company.name]);
    await svc.audit(ctx, 'update', 'settings', ctx.org, 'Updated workspace settings');
    // Changed scoring rules apply to every open lead immediately, not just the next time each one is edited.
    if (JSON.stringify(next.scoring) !== JSON.stringify(ctx.settings.scoring)) {
      const scoped: Ctx = { ...ctx, settings: next };
      for (const l of (await q('select id from leads where org_id = $1 and closed_at is null and dead_at is null', [ctx.org])).rows) await svc.rescoreLead(scoped, l.id);
    }
    return next;
  });
  return c.json(cleanSettings(settings));
});

// ---------- Team ----------
app.post('/api/users/invite', async c => {
  const b = await body(c);
  const res = await mutate(c, async ctx => {
    requireAdmin(ctx, 'team');
    const email = String(b.email ?? '').trim().toLowerCase(), name = String(b.name ?? '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || !name) throw new HttpError(400, 'Name and a valid email are required.');
    if (!ROLES.includes(b.role)) throw new HttpError(400, 'Choose a role.');
    if (b.role === 'Owner' && ctx.user!.role !== 'Owner') throw new HttpError(403, 'Only an owner can invite another owner.');
    if (await one('select 1 from users where email = $1', [email])) throw new HttpError(409, 'A user with this email already exists.');
    const token = auth.newToken();
    const u = await one(`insert into users (org_id, email, name, role, department, status, invite_token) values ($1, $2, $3, $4, $5, 'invited', $6) returning ${userCols}`, [ctx.org, email, name, b.role, b.department ?? null, token]);
    await svc.audit(ctx, 'create', 'users', u.id, `Invited ${name} (${email}) as ${b.role}`);
    return { user: u, inviteUrl: `${appUrl()}/accept-invite/${token}`, emailed: false };
  });
  return c.json(res);
});
app.patch('/api/users/:id', async c => {
  const b = await body(c), id = c.req.param('id');
  const u = await mutate(c, async ctx => {
    const self = id === ctx.user!.id;
    const target = await one('select * from users where id = $1 and org_id = $2', [id, ctx.org]);
    if (!target) throw new HttpError(404, 'User not found');
    const upd: R = {};
    if (self) { for (const k of ['name', 'phone']) if (typeof b[k] === 'string' && b[k].trim()) upd[k] = b[k].trim(); }
    if (b.role !== undefined || b.status !== undefined || b.department !== undefined || (!self && b.name !== undefined)) {
      requireAdmin(ctx, 'team');
      if (target.role === 'Owner' && ctx.user!.role !== 'Owner') throw new HttpError(403, 'Only an owner can change an owner account.');
      if (b.role !== undefined) { if (!ROLES.includes(b.role)) throw new HttpError(400, 'Unknown role'); if (b.role === 'Owner' && ctx.user!.role !== 'Owner') throw new HttpError(403, 'Only an owner can grant the Owner role.'); upd.role = b.role; }
      if (b.status !== undefined) { if (!['active', 'disabled'].includes(b.status) || target.status === 'invited') throw new HttpError(400, 'Invalid status change'); if (self) throw new HttpError(400, 'You cannot disable your own account.'); upd.status = b.status; }
      if (b.department !== undefined) upd.department = b.department || null;
      if (!self && typeof b.name === 'string' && b.name.trim()) upd.name = b.name.trim();
      if ((upd.role && upd.role !== 'Owner' || upd.status === 'disabled') && target.role === 'Owner' && (await one(`select count(*)::int as n from users where org_id = $1 and role = 'Owner' and status = 'active'`, [ctx.org])).n <= 1)
        throw new HttpError(409, 'The workspace needs at least one active owner.');
    }
    if (!Object.keys(upd).length) throw new HttpError(400, 'Nothing to update');
    const keys = Object.keys(upd);
    const row = await one(`update users set ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')} where id = $1 and org_id = $2 returning ${userCols}`, [id, ctx.org, ...keys.map(k => upd[k])]);
    if (upd.status === 'disabled') await auth.destroyUserSessions(id);
    await svc.audit(ctx, 'update', 'users', id, `Updated team member ${row.name}: ${keys.map(k => `${k} → ${upd[k]}`).join(', ')}`, upd);
    return row;
  });
  return c.json(u);
});
app.delete('/api/users/:id', async c => {
  await mutate(c, async ctx => {
    requireAdmin(ctx, 'team');
    const t = await one('select id, name, status from users where id = $1 and org_id = $2', [c.req.param('id'), ctx.org]);
    if (!t) throw new HttpError(404, 'User not found');
    if (t.status !== 'invited') throw new HttpError(409, 'Only pending invites can be deleted. Disable active team members instead so their history is kept.');
    await q('delete from users where id = $1', [t.id]);
    await svc.audit(ctx, 'delete', 'users', t.id, `Revoked invite for ${t.name}`);
  });
  return c.json({ ok: true });
});

// ---------- Lead intake, import, search ----------
interface IntakeInput { contact: R; property: R | null; lead: R; contactId?: string; propertyId?: string; mode?: 'check' | 'force' | 'merge' }
async function intake(ctx: Ctx, input: IntakeInput) {
  svc.assertAccess(ctx, 'leads', 'write');
  let contactId = input.contactId, propertyId = input.propertyId, duplicate = false;
  if (!contactId || (!propertyId && input.property?.address)) {
    const contacts = await repo.list(ctx.org, 'contacts'), properties = await repo.list(ctx.org, 'properties');
    const d = findDuplicates({ phone: input.contact?.phone, email: input.contact?.email, address: input.property?.address, zip: input.property?.zip }, contactId ? [] : contacts, propertyId ? [] : properties);
    if (d.contacts.length || d.properties.length) {
      if (input.mode === 'merge') { contactId ??= d.contacts[0]?.id; propertyId ??= d.properties[0]?.id; duplicate = true; }
      else if (input.mode !== 'force') throw new HttpError(409, 'Possible duplicate found', { duplicates: { contacts: d.contacts.map(x => ({ id: x.id, name: contactName(x), phone: x.phone, email: x.email })), properties: d.properties.map(x => ({ id: x.id, address: x.address, city: x.city })) } });
    }
  }
  if (!contactId) contactId = (await svc.create(ctx, 'contacts', input.contact, { system: true })).id;
  if (!propertyId && input.property?.address) propertyId = (await svc.create(ctx, 'properties', input.property, { system: true })).id;
  if (duplicate) {
    const open = (await repo.list(ctx.org, 'leads', { contact_id: contactId })).find(l => (!propertyId || l.property_id === propertyId) && !l.closed_at && !l.dead_at);
    if (open) { await svc.logActivity(ctx, { type: 'note', summary: 'Duplicate inquiry received', body: `Another inquiry arrived for this seller${input.lead?.source ? ` via ${input.lead.source}` : ''}. No new lead was created.`, lead_id: open.id }); return { lead: open, duplicate: true }; }
  }
  const lead = await svc.create(ctx, 'leads', { ...input.lead, contact_id: contactId, property_id: propertyId ?? null });
  return { lead, duplicate };
}
app.post('/api/leads/intake', async c => { const b = await body(c); return c.json(await mutate(c, ctx => intake(ctx, b as IntakeInput))); });

app.post('/api/import/leads', async c => {
  const b = await body(c);
  const rows: R[] = Array.isArray(b.rows) ? b.rows : [];
  if (!rows.length) throw new HttpError(400, 'No rows to import.');
  if (rows.length > 250) throw new HttpError(400, 'Send at most 250 rows per request.');
  const result = { created: 0, duplicates: 0, errors: [] as { row: number; error: string }[] };
  const user = c.get('user');
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      await tx(async () => {
        const ctx = await svc.makeCtx(user.org_id, user, 'import');
        if (!String(r.first_name ?? '').trim() && String(r.name ?? '').trim()) { const [f, ...rest] = String(r.name).trim().split(/\s+/); r.first_name = f; r.last_name = rest.join(' '); }
        if (!String(r.first_name ?? '').trim()) throw new HttpError(400, 'Missing first name');
        const lead: R = { source: r.source || b.source || null, campaign_id: b.campaign_id || null, owner_id: b.owner_id || null, motivation: r.motivation, asking_price: r.asking_price, reason: r.reason, timeline: r.timeline, tags: r.tags ? String(r.tags).split(/[;|]/) : b.tags ?? [] };
        for (const k of Object.keys(lead)) if (lead[k] === undefined || lead[k] === '') delete lead[k];
        const res = await intake(ctx, { contact: r, property: String(r.address ?? '').trim() ? { ...r, notes: undefined } : null, lead, mode: b.allowDuplicates ? 'force' : 'merge' });
        if (res.duplicate) result.duplicates++; else result.created++;
        await drainEvents(ctx);
      });
    } catch (e: any) { result.errors.push({ row: (b.offset ?? 0) + i + 1, error: e instanceof HttpError ? e.message : 'Could not import this row' }); }
  }
  return c.json(result);
});

app.get('/api/search', async c => {
  const term = String(c.req.query('q') ?? '').trim().toLowerCase();
  if (term.length < 2) return c.json([]);
  const ctx = await read(c);
  const out: R[] = [];
  const add = async (entity: string, label: (r: R) => string, sub: (r: R) => string, link: (r: R) => string, keys: string[]) => {
    if (svc.access(ctx, ENTITY[entity].resource, 'read') === 'none') return;
    for (const r of await svc.listFor(ctx, entity)) {
      if (out.length > 60) break;
      if (keys.some(k => String(r[k] ?? '').toLowerCase().includes(term)) || label(r).toLowerCase().includes(term)) out.push({ entity, id: r.id, label: label(r), sub: sub(r), link: link(r), ref: r });
    }
  };
  const leads = svc.access(ctx, 'leads', 'read') === 'none' ? [] : await svc.listFor(ctx, 'leads');
  const leadByContact = new Map(leads.map(l => [l.contact_id, l]));
  await add('contacts', contactName, r => [r.phone, r.email].filter(Boolean).join(' · '), r => (leadByContact.get(r.id) ? `/leads/${leadByContact.get(r.id)!.id}` : `/leads?contact=${r.id}`), ['phone', 'phone2', 'email', 'mailing_address', 'notes']);
  await add('properties', r => r.address, r => [r.city, r.state, r.zip].filter(Boolean).join(', '), r => `/properties/${r.id}`, ['city', 'zip', 'county', 'parcel_id', 'owner_name', 'notes']);
  await add('buyers', r => r.name, r => r.company ?? '', r => `/buyers/${r.id}`, ['company', 'phone', 'email', 'notes']);
  const props = new Map((await repo.list(ctx.org, 'properties')).map(p => [p.id, p]));
  await add('transactions', r => `Transaction — ${props.get(r.property_id)?.address ?? ''}`, r => r.status, r => `/transactions?open=${r.id}`, ['title_company', 'notes', 'status']);
  await add('contracts', r => `${r.type} — ${props.get(r.property_id)?.address ?? ''}`, r => r.status, r => `/contracts?open=${r.id}`, ['title_company', 'notes', 'contingencies']);
  await add('tasks', r => r.title, r => `Task · ${r.status}`, () => '/tasks', ['description']);
  await add('activities', r => r.summary, r => String(r.body ?? '').slice(0, 80), r => (r.lead_id ? `/leads/${r.lead_id}` : r.property_id ? `/properties/${r.property_id}` : '/'), ['body']);
  return c.json(out.map(({ ref, ...x }) => x));
});

// ---------- Domain commands ----------
app.post('/api/leads/:id/enroll', async c => { const b = await body(c); return c.json(await mutate(c, async ctx => { await svc.getFor(ctx, 'leads', c.req.param('id'), 'write'); return enrollLead(ctx, c.req.param('id'), b.sequenceId); })); });
app.post('/api/enrollments/:id/stop', async c => c.json(await mutate(c, async ctx => {
  const e = await repo.get(ctx.org, 'enrollments', c.req.param('id'));
  if (!e) throw new HttpError(404, 'Enrollment not found');
  await svc.getFor(ctx, 'leads', e.lead_id, 'write');
  await svc.stopEnrollments(ctx, e.lead_id, `Stopped by ${ctx.user!.name}`);
  return { ok: true };
})));
app.post('/api/dispositions/:id/match', async c => { const b = await body(c); return c.json(await mutate(c, async ctx => { await svc.getFor(ctx, 'dispositions', c.req.param('id'), 'write'); return matchBuyersToDisposition(ctx, c.req.param('id'), Number(b.minScore ?? 60)); })); });
app.post('/api/dispositions/:id/select', async c => { const b = await body(c); return c.json(await mutate(c, async ctx => { await svc.getFor(ctx, 'dispositions', c.req.param('id'), 'write'); return selectBuyer(ctx, c.req.param('id'), b.interestId); })); });

app.post('/api/messages/send', async c => {
  const b = await body(c);
  return c.json(await mutate(c, async ctx => {
    svc.assertAccess(ctx, 'communications', 'write');
    if (!['SMS', 'Email'].includes(b.channel) || !['contacts', 'buyers'].includes(b.kind)) throw new HttpError(400, 'Invalid message request');
    const person = await svc.getFor(ctx, b.kind, b.personId);
    const lead = b.lead_id ? await repo.get(ctx.org, 'leads', b.lead_id) : null, property = await repo.get(ctx.org, 'properties', b.property_id ?? lead?.property_id);
    const merge = mergeContext(ctx, { contact: person, property, user: ctx.user });
    return queueMessage(ctx, { channel: b.channel, kind: b.kind, personId: b.personId, body: merge(String(b.body ?? '')), subject: b.subject ? merge(String(b.subject)) : undefined, lead_id: b.lead_id, property_id: property?.id });
  }));
});
/** Sends a deal to selected buyers on a disposition. Each buyer is checked individually; results are reported per buyer. */
app.post('/api/dispositions/:id/send', async c => {
  const b = await body(c), user = c.get('user');
  const ids: string[] = Array.isArray(b.interestIds) ? b.interestIds : [];
  const results: { buyer: string; ok: boolean; message: string }[] = [];
  for (const iid of ids.slice(0, 200)) {
    let name = 'Buyer';
    try {
      await tx(async () => {
        const ctx = await svc.makeCtx(user.org_id, user);
        const d = await svc.getFor(ctx, 'dispositions', c.req.param('id'), 'write');
        const i = await repo.get(ctx.org, 'buyer_interests', iid);
        if (!i || i.disposition_id !== d.id) throw new HttpError(404, 'Buyer is not on this campaign');
        const buyer = await repo.get(ctx.org, 'buyers', i.buyer_id), property = await repo.get(ctx.org, 'properties', d.property_id);
        name = buyer?.name ?? name;
        const merge = mergeContext(ctx, { contact: buyer, property, user: ctx.user });
        await queueMessage(ctx, { channel: b.channel === 'SMS' ? 'SMS' : 'Email', kind: 'buyers', personId: i.buyer_id, body: merge(String(b.body ?? '')), subject: b.subject ? merge(String(b.subject)) : undefined, property_id: d.property_id });
        if (i.status === 'Matched') await svc.patch(ctx, 'buyer_interests', i.id, { status: 'Sent', channel: b.channel === 'SMS' ? 'SMS' : 'Email' }, { system: true });
        await drainEvents(ctx);
      });
      results.push({ buyer: name, ok: true, message: 'Queued for delivery' });
    } catch (e: any) { results.push({ buyer: name, ok: false, message: e instanceof HttpError ? e.message : 'Failed' }); }
  }
  return c.json({ results });
});

app.post('/api/automations/from-template', async c => {
  const b = await body(c);
  return c.json(await mutate(c, async ctx => {
    const t = AUTOMATION_TEMPLATES[Number(b.index)];
    if (!t) throw new HttpError(404, 'Template not found');
    return svc.create(ctx, 'automations', { name: t.name, description: t.description, enabled: false, trigger: t.trigger, trigger_config: t.trigger_config ?? {}, conditions: t.conditions ?? [], actions: t.actions });
  }));
});
app.post('/api/automation-runs/:id/retry', async c => c.json(await mutate(c, async ctx => { requireAdmin(ctx, 'automations'); return retryRun(ctx, c.req.param('id')); })));
app.post('/api/system/tick', async c => { const ctx = await read(c); requireAdmin(ctx, 'automations'); return c.json(await tickOrg(ctx.org)); });

app.get('/api/integrations', async c => {
  const ctx = await read(c); svc.assertAccess(ctx, 'integrations', 'read');
  const rows = (await q('select key, last_sync_at, last_error from integrations where org_id = $1', [ctx.org])).rows;
  return c.json(catalog().map(i => ({ ...i, ...(rows.find(r => r.key === i.key) ?? {}) })));
});
app.post('/api/integrations/:key/test', async c => {
  const ctx = await read(c); requireAdmin(ctx, 'integrations');
  const r = await testIntegration(c.req.param('key'));
  await logIntegration(ctx.org, c.req.param('key'), r.ok ? 'info' : 'error', `Connection test: ${r.message}`);
  return c.json(r);
});

app.post('/api/demo/load', async c => c.json(await mutate(c, async ctx => {
  requireAdmin(ctx, 'settings');
  if ((await one('select count(*)::int as n from leads where org_id = $1 and is_demo', [ctx.org])).n) throw new HttpError(409, 'Demo data is already loaded.');
  return seedDemo(ctx, ctx.user!.id);
})));
app.delete('/api/demo', async c => c.json(await mutate(c, async ctx => { requireAdmin(ctx, 'settings'); const r = await removeDemo(ctx.org, ctx.user!.id); await svc.audit(ctx, 'delete', 'demo', ctx.org, `Removed ${r.removed} demo records`); return r; })));

// ---------- AI ----------
app.post('/api/ai/lead-summary', async c => { const b = await body(c); return c.json(await ai.leadSummary(await read(c), String(b.leadId))); });
app.post('/api/ai/call-summary', async c => { const b = await body(c); return c.json(await ai.callSummary(await read(c), String(b.commId))); });
app.post('/api/ai/deal-review', async c => { const ctx = await read(c); svc.assertAccess(ctx, 'offers', 'read'); return c.json(await ai.dealReview(ctx, await body(c) as any)); });
app.post('/api/ai/ask', async c => { const b = await body(c); const ctx = await read(c); svc.assertAccess(ctx, 'analytics', 'read'); return c.json(await ai.ask(ctx, String(b.question ?? ''), Array.isArray(b.history) ? b.history : [])); });

// ---------- Attachments ----------
app.post('/api/attachments', async c => {
  const form = await c.req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) throw new HttpError(400, 'Choose a file to upload.');
  if (file.size > 15 * 1024 * 1024) throw new HttpError(413, 'Files must be 15 MB or smaller.');
  if (!/^(application\/pdf|image\/(png|jpeg|webp|gif|heic)|text\/(plain|csv)|application\/(msword|vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet)|vnd\.ms-excel))$/.test(file.type)) throw new HttpError(415, 'Unsupported file type. Upload PDFs, images, Word/Excel or text files.');
  const data = Buffer.from(await file.arrayBuffer());
  const row = await mutate(c, async ctx => {
    const meta: R = { name: file.name.slice(0, 200), mime: file.type, size: file.size, category: String(form.get('category') ?? 'Other') };
    for (const k of ['lead_id', 'property_id', 'contract_id', 'transaction_id', 'buyer_id']) if (form.get(k)) meta[k] = String(form.get(k));
    const parent = meta.contract_id ? 'contracts' : meta.transaction_id ? 'transactions' : meta.buyer_id ? 'buyers' : meta.lead_id ? 'leads' : 'properties';
    svc.assertAccess(ctx, ENTITY[parent].resource, 'write');
    const v = validate(ENTITY.attachments, meta);
    if (!v.ok) throw new HttpError(400, Object.values(v.errors)[0]);
    const r = await repo.insert(ctx.org, 'attachments', v.data, { userId: ctx.user!.id });
    await q('update attachments set data = $2 where id = $1', [r.id, data]);
    await svc.logActivity(ctx, { type: 'file', summary: `File uploaded: ${meta.name}`, lead_id: meta.lead_id ?? null, property_id: meta.property_id ?? null, transaction_id: meta.transaction_id ?? null, buyer_id: meta.buyer_id ?? null });
    return r;
  });
  return c.json(row);
});
app.get('/api/attachments/:id/download', async c => {
  const ctx = await read(c);
  const meta = await svc.getFor(ctx, 'attachments', c.req.param('id'));
  const row = await one('select data from attachments where id = $1 and org_id = $2', [meta.id, ctx.org]);
  if (!row?.data) throw new HttpError(404, 'File content not found');
  const inline = /^(image\/|application\/pdf)/.test(meta.mime ?? '') && c.req.query('inline') === '1';
  return c.body(new Uint8Array(row.data), 200, { 'Content-Type': meta.mime || 'application/octet-stream', 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(meta.name)}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=300' });
});

app.post('/api/notifications/read-all', async c => { await q('update notifications set read = true where org_id = $1 and user_id = $2', [c.get('user').org_id, c.get('user').id]); return c.json({ ok: true }); });

// ---------- Generic entity API ----------
app.get('/api/e/:entity', async c => {
  const ctx = await read(c), name = c.req.param('entity');
  const where: R = {};
  for (const [k, v] of Object.entries(c.req.query())) where[k] = v === 'null' ? null : v;
  return c.json(await svc.listFor(ctx, name, where));
});
app.get('/api/e/:entity/:id', async c => c.json(await svc.getFor(await read(c), c.req.param('entity'), c.req.param('id'))));
app.post('/api/e/:entity', async c => {
  const name = c.req.param('entity'), b = await body(c);
  if (READ_ONLY.has(name) || NO_GENERIC_CREATE.has(name)) throw new HttpError(405, 'These records are created by the system.');
  return c.json(await mutate(c, async ctx => {
    if (name === 'activities') {
      // Only internal notes can be created directly; every other activity is written by the system.
      if (!String(b.body ?? '').trim()) throw new HttpError(400, 'Write a note first.');
      // The author must be able to read at least one of the records the note is attached to.
      const parents = ([['leads', b.lead_id], ['buyers', b.buyer_id], ['transactions', b.transaction_id], ['dispositions', b.disposition_id], ['properties', b.property_id]] as [string, string | undefined][]).filter(([, id]) => id);
      if (!parents.length) throw new HttpError(400, 'A note must belong to a record.');
      let allowed = false;
      for (const [entity, id] of parents) { try { await svc.getFor(ctx, entity, id!, 'read'); allowed = true; break; } catch (e) { if (!(e instanceof HttpError) || e.status === 404) throw e; } }
      if (!allowed) throw new HttpError(403, 'You do not have access to this record.');
      return svc.logActivity(ctx, { type: 'note', summary: 'Note', body: String(b.body).slice(0, 20000), lead_id: b.lead_id ?? null, property_id: b.property_id ?? null, buyer_id: b.buyer_id ?? null, transaction_id: b.transaction_id ?? null, disposition_id: b.disposition_id ?? null });
    }
    if (name === 'webhooks') { if (b.direction !== 'Inbound' && !isSafeWebhookUrl(String(b.url ?? ''))) throw new HttpError(400, 'Enter a public http(s) destination URL.'); const row = await svc.create(ctx, name, b); await repo.update(ctx.org, 'webhooks', row.id, { token: auth.newToken() }); return repo.get(ctx.org, 'webhooks', row.id); }
    return svc.create(ctx, name, b);
  }));
});
app.post('/api/e/:entity/bulk', async c => {
  const name = c.req.param('entity'), b = await body(c);
  if (READ_ONLY.has(name)) throw new HttpError(405, 'These records are read-only.');
  const ids: string[] = Array.isArray(b.ids) ? b.ids.slice(0, 500) : [];
  const user = c.get('user');
  const result = { ok: 0, failed: [] as { id: string; error: string }[] };
  for (const id of ids) {
    try {
      await tx(async () => {
        const ctx = await svc.makeCtx(user.org_id, user);
        if (b.delete === true) await svc.destroy(ctx, name, id);
        else {
          const p = { ...(b.patch ?? {}) };
          if (b.addTags?.length) { const cur = await svc.getFor(ctx, name, id, 'write'); p.tags = [...new Set([...(cur.tags ?? []), ...b.addTags])]; }
          await svc.patch(ctx, name, id, p);
        }
        await drainEvents(ctx);
      });
      result.ok++;
    } catch (e: any) { result.failed.push({ id, error: e instanceof HttpError ? e.message : 'Failed' }); }
  }
  return c.json(result);
});
app.patch('/api/e/:entity/:id', async c => {
  const name = c.req.param('entity'), b = await body(c);
  if (READ_ONLY.has(name) || name === 'activities') throw new HttpError(405, 'These records are read-only.');
  if (name === 'webhooks' && b.url !== undefined && b.url && !isSafeWebhookUrl(String(b.url))) throw new HttpError(400, 'Enter a public http(s) destination URL.');
  return c.json(await mutate(c, ctx => svc.patch(ctx, name, c.req.param('id'), b)));
});
app.delete('/api/e/:entity/:id', async c => {
  const name = c.req.param('entity');
  if (READ_ONLY.has(name)) throw new HttpError(405, 'These records are read-only.');
  await mutate(c, async ctx => {
    if (name === 'activities') { const a = await svc.getFor(ctx, name, c.req.param('id'), 'write'); if (a.type !== 'note' || (a.user_id !== ctx.user!.id && !svc.canDelete(ctx, 'leads'))) throw new HttpError(403, 'Only notes can be deleted, by their author or a manager.'); await repo.remove(ctx.org, name, a.id); return; }
    await svc.destroy(ctx, name, c.req.param('id'));
  });
  return c.json({ ok: true });
});

app.all('/api/*', c => c.json({ error: 'Not found' }, 404));
