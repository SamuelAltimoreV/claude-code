// Integration registry + the two message providers (Twilio SMS, SMTP email) and outbound webhooks.
// Nothing here ever reports success for an action that did not actually happen at the provider.
import crypto from 'node:crypto';
import { canContact, renderTemplate } from '../shared/logic';
import { afterCommit, one, q } from './db';
import * as repo from './repo';
import { HttpError } from './repo';
import type { Ctx } from './service';
import { create } from './service';

type R = Record<string, any>;
const env = (k: string) => (process.env[k] ?? '').trim();
export const twilioReady = () => !!(env('TWILIO_ACCOUNT_SID') && env('TWILIO_AUTH_TOKEN') && env('TWILIO_FROM_NUMBER'));
export const smtpReady = () => !!(env('SMTP_HOST') && env('SMTP_FROM'));
export const aiReady = () => !!(env('ANTHROPIC_API_KEY') || env('ANTHROPIC_AUTH_TOKEN'));
const twilioBase = () => env('TWILIO_API_BASE') || 'https://api.twilio.com';
export const appUrl = () => env('APP_URL') || `http://localhost:${env('PORT') || 8787}`;

export type IntegrationStatus = 'connected' | 'not_configured' | 'built_in' | 'planned';
export interface IntegrationInfo { key: string; name: string; category: string; description: string; status: IntegrationStatus; setup: string[]; envVars?: string[]; testable?: boolean; usedFor: string }

export function catalog(): IntegrationInfo[] {
  const s = (ok: boolean): IntegrationStatus => (ok ? 'connected' : 'not_configured');
  const planned = (key: string, name: string, category: string, description: string, usedFor: string): IntegrationInfo => ({
    key, name, category, description, usedFor, status: 'planned',
    setup: ['No connector has been built for this provider yet.', 'The data model already has the fields it would populate; records carry a data_source so imported data stays distinguishable from manual entry.', 'Until then, use CSV import or inbound webhooks to bring this data in.'],
  });
  return [
    { key: 'twilio', name: 'Twilio SMS', category: 'Communication', description: 'Send and receive text messages from lead and buyer records.', usedFor: 'SMS sending, inbound replies, automatic STOP handling', status: s(twilioReady()), envVars: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'], testable: true,
      setup: ['Create a Twilio account and buy an SMS-capable number (register it for A2P 10DLC before marketing use).', 'Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER in the server environment and restart.', `In Twilio, set the number's incoming-message webhook to ${appUrl()}/api/hooks/twilio/<your inbound token> (shown below once connected).`] },
    { key: 'smtp', name: 'Email (SMTP)', category: 'Communication', description: 'Send email through any SMTP provider (Google Workspace, Microsoft 365, SendGrid, Mailgun, Postmark).', usedFor: 'Emails to sellers and buyers, deal blasts, sequences', status: s(smtpReady()), envVars: ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'], testable: true,
      setup: ['Get SMTP credentials from your email provider.', 'Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and SMTP_FROM in the server environment and restart.', 'Add your company mailing address in Settings — it is appended to every email with an unsubscribe link (CAN-SPAM).'] },
    { key: 'anthropic', name: 'Claude AI (Anthropic)', category: 'AI', description: 'Lead summaries, deal review and the business analyst that answers questions from your CRM records.', usedFor: 'AI assistant features', status: s(aiReady()), envVars: ['ANTHROPIC_API_KEY'], testable: true,
      setup: ['Create an API key at platform.claude.com.', 'Set ANTHROPIC_API_KEY in the server environment and restart.'] },
    { key: 'webhooks', name: 'Webhooks', category: 'Automation', description: 'Outbound: POST signed JSON to any URL when CRM events happen. Inbound: create leads from any system that can send an HTTP request.', usedFor: 'Website forms, custom tools, lead vendors', status: 'built_in', setup: ['Create webhooks below. Outbound payloads are signed with HMAC-SHA256 in the X-Signature header.'] },
    { key: 'zapier', name: 'Zapier', category: 'Automation', description: 'Connect through webhooks: use "Webhooks by Zapier" to catch CRM events or to push leads in.', usedFor: 'Facebook Lead Ads, Google Ads lead forms, 6,000+ apps', status: 'built_in', setup: ['Catch events: create an outbound webhook below pointing at a Zapier "Catch Hook" URL.', 'Push leads in: create an inbound webhook below and use a Zapier "POST" action with JSON fields first_name, last_name, phone, email, address, city, state, zip, source.'] },
    { key: 'make', name: 'Make', category: 'Automation', description: 'Connect through webhooks, same as Zapier, using Make\'s "Custom webhook" and "HTTP" modules.', usedFor: 'Multi-step scenarios', status: 'built_in', setup: ['Use an outbound webhook to a Make custom webhook URL, or an inbound webhook as the target of an HTTP module.'] },
    { key: 'calendar', name: 'Calendar feed (Google / Apple / Outlook)', category: 'Productivity', description: 'Subscribe to your tasks and closings as a read-only iCalendar feed.', usedFor: 'Seeing CRM tasks in your calendar', status: 'built_in', setup: ['Copy your personal feed URL below and add it in Google Calendar under "Other calendars → From URL".', 'This is one-way (CRM → calendar). Two-way Google Calendar sync is not built.'] },
    { key: 'csv', name: 'CSV import & export', category: 'Data', description: 'Import seller lead lists with column mapping and duplicate detection; export any table.', usedFor: 'List providers, skip-traced lists, migrations', status: 'built_in', setup: ['Leads → Import CSV. Any table → Export.'] },
    planned('property_data', 'Property data provider', 'Property data', 'Ownership, tax, mortgage and characteristics from a commercial data API.', 'Auto-filling property profiles'),
    planned('county', 'County auditor / public records', 'Property data', 'Parcel, tax delinquency and transfer history from county sources.', 'Verifying ownership and tax status'),
    planned('skip_trace', 'Skip tracing', 'Property data', 'Phone and email lookup for owners.', 'Finding contact info for list leads'),
    planned('comps', 'Comparable sales / valuation', 'Property data', 'Verified sold comps and automated valuations.', 'ARV support in the Deal Analyzer (manual comps work today)'),
    planned('mls', 'MLS data (where authorized)', 'Property data', 'Listing status and sold data under your MLS license.', 'Listing status and comps'),
    planned('voice', 'Calling platform (Twilio Voice, CallRail, etc.)', 'Communication', 'Click-to-call, call recording and automatic call logging.', 'Dialing from the CRM; calls are logged manually today'),
    planned('esign', 'Electronic signatures', 'Documents', 'Send contracts for signature and track status automatically.', 'Contract signature status (tracked manually today)'),
    planned('storage', 'Google Drive / Dropbox', 'Documents', 'Sync transaction folders to cloud storage.', 'Document storage (files are stored in the CRM database today)'),
    planned('gcal', 'Google Calendar two-way sync', 'Productivity', 'Create and update calendar events from tasks and appointments.', 'Appointments (one-way feed works today)'),
    planned('accounting', 'Accounting (QuickBooks, Xero)', 'Financial', 'Sync revenue and expenses.', 'Bookkeeping (export CSV today)'),
    planned('fb_leads', 'Facebook Lead Ads', 'Lead generation', 'Native lead form sync.', 'Use Zapier/Make → inbound webhook today'),
    planned('google_ads', 'Google Ads', 'Lead generation', 'Lead form extensions and spend import.', 'Use Zapier/Make → inbound webhook today; enter spend as campaign expenses'),
  ];
}

export async function logIntegration(org: string, integration: string, level: 'info' | 'error', message: string, data?: R) {
  await repo.insert(org, 'integration_logs', { integration, level, message: message.slice(0, 480), data: data ?? null });
  await q(`insert into integrations (org_id, key, enabled, last_sync_at, last_error) values ($1, $2, true, now(), $3)
           on conflict (org_id, key) do update set last_sync_at = now(), last_error = excluded.last_error`, [org, integration, level === 'error' ? message.slice(0, 480) : null]);
}

// ---------- Providers ----------
async function twilioSend(to: string, body: string) {
  const sid = env('TWILIO_ACCOUNT_SID');
  const digits = to.replace(/\D/g, '');
  const res = await fetch(`${twilioBase()}/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${env('TWILIO_AUTH_TOKEN')}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: digits.length === 10 ? `+1${digits}` : `+${digits}`, From: env('TWILIO_FROM_NUMBER'), Body: body }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${json.message ?? 'request failed'}`);
  return String(json.sid);
}
async function smtpTransport() {
  const nodemailer = (await import('nodemailer')).default;
  const port = Number(env('SMTP_PORT') || 587);
  return nodemailer.createTransport({ host: env('SMTP_HOST'), port, secure: port === 465, auth: env('SMTP_USER') ? { user: env('SMTP_USER'), pass: env('SMTP_PASS') } : undefined });
}
async function smtpSend(to: string, subject: string, text: string) {
  const info = await (await smtpTransport()).sendMail({ from: env('SMTP_FROM'), to, subject, text });
  return String(info.messageId);
}

export async function testIntegration(key: string): Promise<{ ok: boolean; message: string }> {
  try {
    if (key === 'twilio') {
      if (!twilioReady()) return { ok: false, message: 'Twilio environment variables are not set.' };
      const sid = env('TWILIO_ACCOUNT_SID');
      const res = await fetch(`${twilioBase()}/2010-04-01/Accounts/${sid}.json`, { headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${env('TWILIO_AUTH_TOKEN')}`).toString('base64') } });
      return res.ok ? { ok: true, message: 'Twilio credentials verified.' } : { ok: false, message: `Twilio rejected the credentials (HTTP ${res.status}).` };
    }
    if (key === 'smtp') {
      if (!smtpReady()) return { ok: false, message: 'SMTP environment variables are not set.' };
      await (await smtpTransport()).verify();
      return { ok: true, message: 'SMTP server accepted the connection.' };
    }
    if (key === 'anthropic') {
      if (!aiReady()) return { ok: false, message: 'ANTHROPIC_API_KEY is not set.' };
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      await new Anthropic().models.retrieve('claude-opus-5-5');
      return { ok: true, message: 'Anthropic API key verified.' };
    }
    return { ok: false, message: 'This integration has no connection test.' };
  } catch (e: any) { return { ok: false, message: String(e?.message ?? e).slice(0, 300) }; }
}

// ---------- Unsubscribe tokens ----------
async function orgSecret(org: string) {
  const row = await one(`select settings->>'_secret' as s from organizations where id = $1`, [org]);
  if (row?.s) return row.s as string;
  const s = crypto.randomBytes(24).toString('hex');
  await q(`update organizations set settings = jsonb_set(settings, '{_secret}', to_jsonb($2::text)) where id = $1`, [org, s]);
  return s;
}
export async function unsubToken(org: string, kind: 'contacts' | 'buyers', id: string) {
  const sig = crypto.createHmac('sha256', await orgSecret(org)).update(`${kind}:${id}`).digest('base64url').slice(0, 24);
  return Buffer.from(`${org}:${kind}:${id}:${sig}`).toString('base64url');
}
export async function verifyUnsubToken(token: string) {
  const [org, kind, id, sig] = Buffer.from(token, 'base64url').toString().split(':');
  if (!org || !id || (kind !== 'contacts' && kind !== 'buyers')) return null;
  const good = crypto.createHmac('sha256', await orgSecret(org)).update(`${kind}:${id}`).digest('base64url').slice(0, 24);
  return sig && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good)) ? { org, kind, id } : null;
}

// ---------- Messaging ----------
export interface MessageReq { channel: 'SMS' | 'Email'; kind: 'contacts' | 'buyers'; personId: string; body: string; subject?: string; lead_id?: string | null; property_id?: string | null; automated?: boolean }

/** Checks provider + compliance, records the message as Queued, and delivers after the transaction commits. */
export async function queueMessage(ctx: Ctx, m: MessageReq): Promise<R> {
  const provider = m.channel === 'SMS' ? 'twilio' : 'smtp';
  if (!(m.channel === 'SMS' ? twilioReady() : smtpReady()))
    throw new HttpError(424, `${m.channel === 'SMS' ? 'SMS provider (Twilio)' : 'Email provider (SMTP)'} is not connected. Connect it under Integrations — nothing was sent.`);
  const person = await repo.get(ctx.org, m.kind, m.personId);
  const suppressions = await repo.list(ctx.org, 'suppressions');
  const check = canContact(m.channel, person, ctx.settings, suppressions, { automated: m.automated });
  if (!check.allowed) throw new HttpError(422, `Message blocked: ${check.reason}`);
  if (!m.body?.trim()) throw new HttpError(400, 'Message body is empty');
  let body = m.body.trim();
  if (m.channel === 'Email') {
    const c = ctx.settings.company;
    body += `\n\n--\n${c.name}\n${c.address}\nUnsubscribe: ${appUrl()}/api/unsubscribe/${await unsubToken(ctx.org, m.kind, m.personId)}${ctx.settings.comms.emailFooter ? `\n${ctx.settings.comms.emailFooter}` : ''}`;
  }
  const comm = await create(ctx, 'communications', { type: m.channel, direction: 'Outbound', [m.kind === 'contacts' ? 'contact_id' : 'buyer_id']: m.personId, lead_id: m.lead_id ?? null, property_id: m.property_id ?? null,
    subject: m.subject ?? null, body, status: 'Queued', provider }, { system: true });
  const org = ctx.org, to = m.channel === 'SMS' ? person!.phone : person!.email;
  afterCommit(async () => {
    try {
      const id = m.channel === 'SMS' ? await twilioSend(to, body) : await smtpSend(to, m.subject || `Message from ${ctx.settings.company.name}`, body);
      await repo.update(org, 'communications', comm.id, { status: 'Sent' });
      await logIntegration(org, provider, 'info', `${m.channel} delivered to provider`, { comm_id: comm.id, provider_id: id });
    } catch (e: any) {
      await repo.update(org, 'communications', comm.id, { status: 'Failed' });
      await logIntegration(org, provider, 'error', `${m.channel} failed: ${e?.message ?? e}`, { comm_id: comm.id });
    }
  });
  return comm;
}

export function mergeContext(ctx: Ctx, x: { contact?: R | null; property?: R | null; offer?: R | null; user?: R | null }) {
  return (text: string) => renderTemplate(text, { ...x, company: ctx.settings.company.name });
}

// ---------- Outbound webhooks ----------
function safeUrl(url: string) {
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    if (env('ALLOW_PRIVATE_WEBHOOKS') === 'true') return true;
    const h = u.hostname;
    return !(h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1|\[?f[cd])/.test(h));
  } catch { return false; }
}
export const isSafeWebhookUrl = safeUrl;

export async function fireWebhooks(org: string, event: string, data: R) {
  const hooks = (await repo.list(org, 'webhooks', { direction: 'Outbound', active: true })).filter(h => !h.events?.length || h.events.includes(event));
  for (const h of hooks) afterCommit(async () => {
    if (!safeUrl(h.url)) return logIntegration(org, 'webhooks', 'error', `Webhook "${h.name}": destination URL is not allowed`, { event });
    const payload = JSON.stringify({ event, data, sent_at: new Date().toISOString() });
    try {
      const res = await fetch(h.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': crypto.createHmac('sha256', h.token ?? '').update(payload).digest('hex'), 'X-Event': event }, body: payload, signal: AbortSignal.timeout(8000) });
      await logIntegration(org, 'webhooks', res.ok ? 'info' : 'error', `Webhook "${h.name}" ${event} → HTTP ${res.status}`, { event });
    } catch (e: any) { await logIntegration(org, 'webhooks', 'error', `Webhook "${h.name}" ${event} failed: ${e?.message ?? e}`, { event }); }
  });
}
