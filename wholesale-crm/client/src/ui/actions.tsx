// Global quick actions, available from the command menu, the "+ New" button and record pages.
import { useMemo, useState, useSyncExternalStore } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { AlertTriangle, ShieldAlert, ShieldCheck } from 'lucide-react';
import { ENTITY } from '@shared/schema';
import { canContact, contactName, renderTemplate } from '@shared/logic';
import { ApiError, useBoot, useData, useWrite, type R } from '@/lib/app';
import { Field, Modal, Spinner, toast, cx } from './core';
import { EntityForm, FieldInput, RecordModal, useRefOptions } from './Form';

type Action =
  | { type: 'lead' } | { type: 'call'; lead_id?: string; buyer_id?: string; contact_id?: string }
  | { type: 'record'; entity: string; record?: R | null; defaults?: R; fields?: string[]; exclude?: string[]; title?: string; lockFields?: string[] }
  | { type: 'message'; kind: 'contacts' | 'buyers'; personId: string; lead_id?: string; property_id?: string; channel?: 'SMS' | 'Email' }
  | { type: 'followup'; lead_id: string };
let current: Action | null = null; const subs = new Set<() => void>();
export function openAction(a: Action | null) { current = a; subs.forEach(f => f()); }
const useAction = () => useSyncExternalStore(f => { subs.add(f); return () => subs.delete(f); }, () => current);
export const newTask = (defaults: R = {}) => openAction({ type: 'record', entity: 'tasks', defaults, exclude: ['offer_id', 'contract_id'] });

export function ActionHost() {
  const a = useAction();
  const { user } = useBoot();
  if (!a) return null;
  const close = () => openAction(null);
  if (a.type === 'lead') return <NewLeadModal onClose={close} />;
  if (a.type === 'call') return <LogCallModal {...a} onClose={close} />;
  if (a.type === 'message') return <MessageModal {...a} onClose={close} />;
  if (a.type === 'followup') {
    const d = new Date(Date.now() + 2 * 864e5); d.setHours(10, 0, 0, 0);
    return <RecordModal entity="tasks" open onClose={close} title="Schedule follow-up" size="md" fields={['title', 'due_at', 'priority', 'assignee_id', 'description']} defaults={{ title: 'Follow up with seller', category: 'Follow up', due_at: d.toISOString(), lead_id: a.lead_id, assignee_id: user.id, priority: 'Normal', status: 'Open' }} />;
  }
  return <RecordModal open onClose={close} entity={a.entity} record={a.record} defaults={a.entity === 'tasks' ? { assignee_id: user.id, ...a.defaults } : a.defaults} fields={a.fields} exclude={a.exclude} title={a.title} lockFields={a.lockFields} />;
}

const defs = (entity: string, keys: string[]) => keys.map(k => ENTITY[entity].fields.find(f => f.k === k)!);
const C_FIELDS = defs('contacts', ['first_name', 'last_name', 'phone', 'email', 'preferred_contact', 'best_time']);
const P_FIELDS = defs('properties', ['address', 'city', 'state', 'zip', 'property_type', 'condition', 'occupancy', 'beds', 'baths', 'sqft', 'est_value', 'mortgage_balance']);
const L_FIELDS = defs('leads', ['source', 'campaign_id', 'owner_id', 'motivation', 'timeline', 'asking_price', 'reason', 'tags']);

function NewLeadModal({ onClose }: { onClose: () => void }) {
  const { user } = useBoot();
  const w = useWrite(), nav = useNavigate();
  const [c, setC] = useState<R>({ sms_opt_in: false, email_opt_in: false }), [p, setP] = useState<R>({ state: 'OH' }), [l, setL] = useState<R>({ owner_id: user.id, tags: [] });
  const [errors, setErrors] = useState<Record<string, string>>({}), [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const [dupes, setDupes] = useState<{ contacts: R[]; properties: R[] } | null>(null);
  const refOptions = useRefOptions(['campaigns', 'users']);
  const clean = (o: R) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v !== null && v !== undefined));
  const submit = async (opts: { mode?: 'force'; contactId?: string; propertyId?: string } = {}) => {
    const e: Record<string, string> = {};
    if (!String(c.first_name ?? '').trim() && !opts.contactId) e.first_name = 'First name is required';
    if (!c.phone && !c.email && !opts.contactId) e.phone = 'Enter a phone number or an email';
    setErrors(e); if (Object.keys(e).length) return;
    setBusy(true); setErr('');
    try {
      const res = await w.post('/api/leads/intake', { contact: clean(c), property: String(p.address ?? '').trim() ? clean(p) : null, lead: clean(l), ...opts });
      toast.success('Lead created'); onClose(); nav(`/leads/${res.lead.id}`);
    } catch (x) {
      if (x instanceof ApiError && x.status === 409 && x.details?.duplicates) setDupes(x.details.duplicates);
      else if (x instanceof ApiError && x.details?.fields) { setErrors(x.details.fields); setErr(x.message); } else setErr(x instanceof Error ? x.message : 'Could not create lead');
    } finally { setBusy(false); }
  };
  const grid = (fields: typeof C_FIELDS, vals: R, set: (v: R) => void) => <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">{fields.map(f => <Field key={f.k} label={f.label + (f.k === 'first_name' ? ' *' : '')} error={errors[f.k]} span={f.t === 'multi'}><FieldInput f={f} value={vals[f.k]} onChange={v => set({ ...vals, [f.k]: v })} refOptions={refOptions} /></Field>)}</div>;
  return (
    <Modal open onClose={onClose} size="lg" title="New seller lead" footer={!dupes && <><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={() => submit()}>{busy && <Spinner />}Create lead</button></>}>
      {dupes ? (
        <div>
          <div className="flex items-start gap-2.5 p-3 rounded-md border border-line bg-surface-2"><AlertTriangle size={16} className="text-t-amber mt-0.5 shrink-0" /><div><div className="font-medium">Possible duplicate</div><div className="text-fg-2">Records with the same phone, email or address already exist. Reuse them to keep one history per seller and property.</div></div></div>
          {dupes.contacts.length > 0 && <div className="mt-4"><div className="section-t mb-2">Matching sellers</div>{dupes.contacts.map(d => <div key={d.id} className="flex items-center justify-between gap-3 py-2 border-b border-line"><div><div className="font-medium">{d.name}</div><div className="text-fg-3 text-xs">{[d.phone, d.email].filter(Boolean).join(' · ')}</div></div><button className="btn btn-sm" disabled={busy} onClick={() => submit({ contactId: d.id, propertyId: dupes.properties[0]?.id })}>Use this seller</button></div>)}</div>}
          {dupes.properties.length > 0 && <div className="mt-4"><div className="section-t mb-2">Matching properties</div>{dupes.properties.map(d => <div key={d.id} className="flex items-center justify-between gap-3 py-2 border-b border-line"><div><div className="font-medium">{d.address}</div><div className="text-fg-3 text-xs">{d.city}</div></div><button className="btn btn-sm" disabled={busy} onClick={() => submit({ propertyId: d.id, contactId: dupes.contacts[0]?.id })}>Use this property</button></div>)}</div>}
          <div className="flex justify-between mt-5"><button className="btn" onClick={() => setDupes(null)}>Back to form</button><button className="btn" disabled={busy} onClick={() => submit({ mode: 'force' })}>Create new records anyway</button></div>
        </div>
      ) : (
        <div className="space-y-5">
          <div><div className="section-t mb-2.5">Seller</div>{grid(C_FIELDS, c, setC)}
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-fg-2">
              <label className="inline-flex items-center gap-2"><input type="checkbox" checked={!!c.sms_opt_in} onChange={e => setC({ ...c, sms_opt_in: e.target.checked })} />Seller consented to text messages</label>
              <label className="inline-flex items-center gap-2"><input type="checkbox" checked={!!c.email_opt_in} onChange={e => setC({ ...c, email_opt_in: e.target.checked })} />Seller consented to email</label>
            </div>
            {(c.sms_opt_in || c.email_opt_in) && <div className="mt-2 max-w-sm"><Field label="How was consent obtained?"><input className="input" placeholder="e.g. web form checkbox, verbal on call" value={c.consent_source ?? ''} onChange={e => setC({ ...c, consent_source: e.target.value })} /></Field></div>}
          </div>
          <div><div className="section-t mb-2.5">Property <span className="normal-case font-normal tracking-normal">(optional — can be added later)</span></div>{grid(P_FIELDS, p, setP)}</div>
          <div><div className="section-t mb-2.5">Lead</div>{grid(L_FIELDS, l, setL)}</div>
          {err && <div className="text-t-red" role="alert">{err}</div>}
        </div>
      )}
    </Modal>
  );
}

function LogCallModal({ lead_id, buyer_id, contact_id, onClose }: { lead_id?: string; buyer_id?: string; contact_id?: string; onClose: () => void }) {
  const w = useWrite();
  const preset = !!(lead_id || buyer_id || contact_id);
  return (
    <Modal open onClose={onClose} size="lg" title="Log a conversation">
      <EntityForm entity="communications" onCancel={onClose} submitLabel="Save to timeline"
        fields={[...(preset ? [] : ['lead_id', 'buyer_id']), 'type', 'direction', 'outcome', 'duration_min', 'at', 'body', 'next_action', 'follow_up_at', 'transcript']}
        initial={{ type: 'Call', direction: 'Outbound', at: new Date().toISOString() }}
        onSubmit={async data => {
          if (!preset && !data.lead_id && !data.buyer_id) throw new Error('Choose the lead or buyer this conversation was with.');
          await w.create('communications', { ...data, lead_id: lead_id ?? data.lead_id, buyer_id: buyer_id ?? data.buyer_id, contact_id });
          toast.success(data.follow_up_at ? 'Conversation logged and follow-up scheduled' : 'Conversation logged'); onClose();
        }}
        extra={<p className="text-[11px] text-fg-3 leading-relaxed">Logging a conversation updates the lead's last-contact date, score and timeline. Setting a follow-up date creates a task. Choosing "Do not contact" blocks all future outreach to this person.</p>} />
    </Modal>
  );
}

function MessageModal({ kind, personId, lead_id, property_id, channel: initial = 'SMS', onClose }: { kind: 'contacts' | 'buyers'; personId: string; lead_id?: string; property_id?: string; channel?: 'SMS' | 'Email'; onClose: () => void }) {
  const { settings, user, providers } = useBoot();
  const d = useData(kind, 'templates', 'suppressions', 'properties', 'leads');
  const w = useWrite();
  const [channel, setChannel] = useState<'SMS' | 'Email'>(initial), [body, setBody] = useState(''), [subject, setSubject] = useState(''), [busy, setBusy] = useState(false);
  const person = (d[kind] as R[]).find(p => p.id === personId);
  const lead = d.leads.find(x => x.id === lead_id), property = d.properties.find(x => x.id === (property_id ?? lead?.property_id));
  const check = useMemo(() => canContact(channel, person, settings, d.suppressions), [channel, person, settings, d.suppressions]);
  const connected = channel === 'SMS' ? providers.sms : providers.email;
  const preview = renderTemplate(body, { contact: person, property, user, company: settings.company.name });
  const send = async () => { setBusy(true); try { await w.post('/api/messages/send', { channel, kind, personId, body, subject, lead_id, property_id: property?.id }); toast.success(`${channel} queued for delivery`); onClose(); } catch (e) { toast.error(e); } finally { setBusy(false); } };
  return (
    <Modal open onClose={onClose} size="md" title={`Message ${person ? (kind === 'contacts' ? contactName(person) : person.name) : ''}`}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !check.allowed || !connected || !body.trim()} onClick={send}>{busy && <Spinner />}Send {channel}</button></>}>
      <div className="space-y-3">
        <div className="flex gap-2">{(['SMS', 'Email'] as const).map(ch => <button key={ch} className={cx('btn', channel === ch && '!border-accent !text-accent-text')} onClick={() => setChannel(ch)}>{ch}</button>)}
          <select className="input" value="" onChange={e => { const t = d.templates.find(x => x.id === e.target.value); if (t) { setBody(t.body); setSubject(t.subject ?? ''); } }}><option value="">Insert template…</option>{d.templates.filter(t => t.channel === channel).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
        <div className={cx('flex items-start gap-2 p-2.5 rounded-md border text-[13px]', check.allowed ? 'border-line bg-surface-2' : 'border-critical/40 bg-critical/5')}>
          {check.allowed ? <ShieldCheck size={15} className="text-t-green mt-0.5 shrink-0" /> : <ShieldAlert size={15} className="text-t-red mt-0.5 shrink-0" />}
          <div>{check.allowed ? `Compliance check passed: ${channel === 'SMS' ? 'SMS' : 'email'} consent on file, not on a suppression list, within contact hours.` : <><b>Blocked:</b> {check.reason}.</>}</div></div>
        {!connected && <div className="flex items-start gap-2 p-2.5 rounded-md border border-line bg-surface-2"><AlertTriangle size={15} className="text-t-amber mt-0.5 shrink-0" /><div>No {channel === 'SMS' ? 'SMS provider (Twilio)' : 'email provider (SMTP)'} is connected, so this cannot be sent from the CRM. <Link className="link" to="/integrations" onClick={onClose}>Connect it in Integrations</Link>, or send it yourself and log the conversation.</div></div>}
        {channel === 'Email' && <Field label="Subject"><input className="input" value={subject} onChange={e => setSubject(e.target.value)} /></Field>}
        <Field label="Message" help="Merge fields: {{first_name}} {{property_address}} {{agent_name}} {{company_name}}"><textarea className="input" rows={5} value={body} onChange={e => setBody(e.target.value)} /></Field>
        {body && preview !== body && <div><div className="label">Preview</div><div className="p-2.5 rounded-md bg-surface-2 border border-line whitespace-pre-wrap">{preview}</div></div>}
        {channel === 'SMS' && body && <div className="text-[11px] text-fg-3 tnum">{preview.length} characters · {Math.ceil(preview.length / 160)} segment(s)</div>}
      </div>
    </Modal>
  );
}
