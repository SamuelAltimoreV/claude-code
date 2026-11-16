import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Building2, Check, ChevronLeft, Mail, Megaphone, MessageSquare, Pencil, Phone, Plus, Search, Send, ShieldAlert, Trash2, Trophy, Users, X } from 'lucide-react';
import { compStats } from '@shared/calc';
import { canContact, matchBuyer, propertyLabel, type MatchResult } from '@shared/logic';
import { buyerStats, EMPTY } from '@shared/metrics';
import { BUYER_CLASSES, BUYER_STRATEGIES, DISPO_STATUSES, INTEREST_STATUSES } from '@shared/schema';
import { api, useBoot, useData, usePerms, useRows, useWrite, type R } from '@/lib/app';
import { ago, daysSince, fdate, fdatetime, money, num, pct } from '@/lib/format';
import { Badge, Card, confirmDialog, cx, Empty, ErrorBox, Field, KV, Loading, Menu, Modal, PageHeader, promptDialog, Spinner, StatusBadge, Tabs, toast, useBusy } from '@/ui/core';
import { DataTable, type Col } from '@/ui/DataTable';
import { RecordModal } from '@/ui/Form';
import { openAction } from '@/ui/actions';
import { Timeline } from '@/ui/Timeline';
import { Attachments, DemoMark, Row2, useNames } from '@/ui/shared';

const useBuyerStats = (d: { buyers: R[]; buyer_interests: R[]; transactions: R[] }) => useMemo(() => new Map(buyerStats({ ...EMPTY, buyers: d.buyers, buyer_interests: d.buyer_interests, transactions: d.transactions }).map(s => [s.buyer.id, s])), [d.buyers, d.buyer_interests, d.transactions]);

/** Compose a message to many buyers. Each recipient is checked for consent and suppression before sending. */
function BulkMessage({ buyers, dispositionId, interests, property, onClose }: { buyers: R[]; dispositionId?: string; interests?: R[]; property?: R; onClose: () => void }) {
  const { settings, providers } = useBoot();
  const d = useData('templates', 'suppressions');
  const w = useWrite();
  const [channel, setChannel] = useState<'Email' | 'SMS'>('Email'), [subject, setSubject] = useState(property ? `New deal: ${property.address}` : ''), [body, setBody] = useState(''), [results, setResults] = useState<R[] | null>(null);
  const { busy, run } = useBusy();
  const checks = buyers.map(b => ({ b, c: canContact(channel, b, settings, d.suppressions) }));
  const ok = checks.filter(x => x.c.allowed), connected = channel === 'SMS' ? providers.sms : providers.email;
  const send = () => run(async () => {
    if (dispositionId && interests) { const r = await w.post(`/api/dispositions/${dispositionId}/send`, { interestIds: interests.filter(i => ok.some(x => x.b.id === i.buyer_id)).map(i => i.id), channel, subject, body }); setResults(r.results); }
    else { const out: R[] = []; for (const { b } of ok) { try { await api('POST', '/api/messages/send', { channel, kind: 'buyers', personId: b.id, subject, body }); out.push({ buyer: b.name, ok: true, message: 'Queued for delivery' }); } catch (e: any) { out.push({ buyer: b.name, ok: false, message: e.message }); } } setResults(out); await w.refresh(); }
  });
  const markSent = () => run(async () => { for (const i of interests ?? []) if (i.status === 'Matched') await w.patch('buyer_interests', i.id, { status: 'Sent', channel: 'Sent outside CRM' }); toast.success('Marked as sent'); onClose(); });
  return (
    <Modal open onClose={onClose} size="lg" title={`Send to ${buyers.length} buyer${buyers.length === 1 ? '' : 's'}`} footer={results ? <button className="btn btn-primary" onClick={onClose}>Done</button> : <>
      {interests && interests.some(i => i.status === 'Matched') && <button className="btn mr-auto" disabled={busy} onClick={markSent} title="Use this if you sent the deal from your own email or phone">I sent it outside the CRM — mark as sent</button>}
      <button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !connected || !ok.length || !body.trim()} onClick={send}>{busy ? <Spinner /> : <Send size={13} />}Send to {ok.length}</button></>}>
      {results ? <div className="border border-line rounded-md divide-y divide-line">{results.map((r, i) => <div key={i} className="flex items-center gap-3 px-3 h-10">{r.ok ? <Check size={14} className="text-t-green" /> : <X size={14} className="text-t-red" />}<span className="font-medium w-48 truncate">{r.buyer}</span><span className="text-fg-2 truncate">{r.message}</span></div>)}</div> : (
        <div className="space-y-3">
          <div className="flex gap-2">{(['Email', 'SMS'] as const).map(ch => <button key={ch} className={cx('btn', channel === ch && '!border-accent !text-accent-text')} onClick={() => setChannel(ch)}>{ch === 'Email' ? <Mail size={13} /> : <MessageSquare size={13} />}{ch}</button>)}
            <select className="input" value="" onChange={e => { const t = d.templates.find(x => x.id === e.target.value); if (t) { setBody(t.body); if (t.subject) setSubject(t.subject); } }}><option value="">Insert template…</option>{d.templates.filter(t => t.channel === channel).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
          {!connected && <div className="flex items-start gap-2 p-2.5 rounded-md border border-line bg-surface-2"><ShieldAlert size={15} className="text-t-amber mt-0.5 shrink-0" /><div>No {channel === 'SMS' ? 'SMS provider (Twilio)' : 'email provider (SMTP)'} is connected, so the CRM cannot send this. <Link className="link" to="/integrations" onClick={onClose}>Connect one in Integrations</Link>{interests ? ', or send the deal yourself and use "mark as sent" below.' : '.'}</div></div>}
          <div className="p-2.5 rounded-md border border-line"><div className="font-medium">{ok.length} of {buyers.length} recipients can be contacted by {channel.toLowerCase()}</div>
            {checks.filter(x => !x.c.allowed).length > 0 && <ul className="mt-1.5 space-y-0.5 text-fg-2 max-h-28 overflow-auto scroll-thin">{checks.filter(x => !x.c.allowed).map(x => <li key={x.b.id}><span className="font-medium">{x.b.name}</span> — skipped: {x.c.reason}</li>)}</ul>}</div>
          {channel === 'Email' && <Field label="Subject"><input className="input" value={subject} onChange={e => setSubject(e.target.value)} /></Field>}
          <Field label="Message" help="Merge fields: {{first_name}} {{property_address}} {{property_city}} {{agent_name}} {{company_name}}. Emails get your company address and an unsubscribe link appended."><textarea className="input" rows={7} value={body} onChange={e => setBody(e.target.value)} /></Field>
        </div>)}
    </Modal>
  );
}

export function BuyersPage() {
  const { settings } = useBoot();
  const d = useData('buyers', 'buyer_interests', 'transactions');
  const perms = usePerms(), w = useWrite(), nav = useNavigate();
  const stats = useBuyerStats(d);
  const [bulk, setBulk] = useState<R[] | null>(null);
  const cols: Col[] = [
    { key: 'name', label: 'Buyer', width: 230, render: r => <span className="flex items-center gap-2"><Row2 a={r.name} b={r.company} /><DemoMark r={r} />{r.dnc && <Badge tone="red">DNC</Badge>}</span> },
    { key: 'company', label: 'Company', hidden: true }, { key: 'classifications', label: 'Classification', render: r => <span className="flex gap-1">{(r.classifications ?? []).slice(0, 2).map((t: string) => <Badge key={t} tone={t === 'Verified Buyer' ? 'green' : t === 'Inactive Buyer' ? 'gray' : 'blue'}>{t.replace(' Buyer', '')}</Badge>)}{(r.classifications ?? []).length > 2 && <span className="text-fg-3">+{r.classifications.length - 2}</span>}</span> },
    { key: 'strategy', label: 'Strategy' }, { key: 'areas', label: 'Buys in', width: 200, value: r => [...(r.cities ?? []), ...(r.counties ?? []).map((x: string) => `${x} Co.`)].join(', ') },
    { key: 'price', label: 'Price range', value: r => r.max_price, render: r => (r.min_price || r.max_price ? `${money(r.min_price, true)} – ${money(r.max_price, true)}` : null) },
    { key: 'pof_status', label: 'Proof of funds', render: r => <StatusBadge value={r.pof_status} /> }, { key: 'financing', label: 'Financing', hidden: true }, { key: 'groups', label: 'Lists', hidden: true },
    { key: 'presented', label: 'Presented', align: 'right', value: r => stats.get(r.id)?.presented ?? 0 }, { key: 'offers', label: 'Offers', align: 'right', value: r => stats.get(r.id)?.offers ?? 0 }, { key: 'closed', label: 'Closed', align: 'right', value: r => stats.get(r.id)?.closed ?? 0 },
    { key: 'volume', label: 'Volume', align: 'right', value: r => stats.get(r.id)?.volume ?? 0, render: r => (stats.get(r.id)?.volume ? money(stats.get(r.id)!.volume, true) : null) },
    { key: 'reliability', label: 'Reliability', align: 'right', value: r => stats.get(r.id)?.reliability, render: r => pct(stats.get(r.id)?.reliability), hidden: true }, { key: 'phone', label: 'Phone', hidden: true }, { key: 'email', label: 'Email', hidden: true },
  ];
  const actions = (sel: R[], clear: () => void) => <>
    <button className="btn btn-sm" onClick={() => setBulk(sel)}><Mail size={13} />Email / text</button>
    <Menu align="left" trigger={<button className="btn btn-sm">Add to list</button>} items={[...settings.buyerGroups.map(g => ({ label: g, onClick: async () => { let n = 0; for (const b of sel) if (!(b.groups ?? []).includes(g)) { await w.patch('buyers', b.id, { groups: [...(b.groups ?? []), g] }).catch(toast.error); n++; } toast.success(`${n} buyer(s) added to ${g}`); clear(); } })),
      { label: 'New list…', onClick: async () => { const g = await promptDialog({ title: 'New buyer list', confirm: 'Create and add', input: { label: 'List name', required: true } }); if (!g) return; try { await api('PUT', '/api/settings', { ...settings, buyerGroups: [...new Set([...settings.buyerGroups, g])] }); for (const b of sel) await w.patch('buyers', b.id, { groups: [...new Set([...(b.groups ?? []), g])] }); await w.refreshBoot(); toast.success(`List "${g}" created`); clear(); } catch (e) { toast.error(e); } } }]} />
  </>;
  if (d.error) return <ErrorBox error={d.error} />;
  return (
    <div>
      <PageHeader title="Cash Buyers" subtitle="Your buyer database with buy boxes, proof of funds and track record.">
        {perms.write('buyers') && <button className="btn btn-primary" onClick={() => openAction({ type: 'record', entity: 'buyers' })}><Plus size={14} />New buyer</button>}
      </PageHeader>
      <DataTable rows={d.buyers} cols={cols} loading={d.loading} onRowClick={r => nav(`/buyers/${r.id}`)} viewKey="buyers" exportName="buyers" bulk={perms.write('buyers') ? actions : undefined} initialSort={{ key: 'closed', dir: -1 }}
        filters={[{ key: 'class', label: 'Classification', options: BUYER_CLASSES.map(s => ({ value: s, label: s })), get: r => r.classifications }, { key: 'strategy', label: 'Strategy', options: BUYER_STRATEGIES.map(s => ({ value: s, label: s })), get: r => r.strategy },
          { key: 'pof', label: 'POF', options: ['Verified', 'Received', 'Requested', 'Not Requested', 'Expired'].map(s => ({ value: s, label: s })), get: r => r.pof_status }, { key: 'group', label: 'List', options: settings.buyerGroups.map(s => ({ value: s, label: s })), get: r => r.groups },
          { key: 'city', label: 'City', options: [...new Set(d.buyers.flatMap(b => b.cities ?? []))].sort().map(s => ({ value: s, label: s })), get: r => r.cities }]}
        empty={<Empty icon={<Building2 size={18} />} title="No buyers yet" body="Add cash buyers with their buy box so deals can be matched to them automatically." />} />
      {bulk && <BulkMessage buyers={bulk} onClose={() => setBulk(null)} />}
    </div>
  );
}

export function BuyerDetail() {
  const { id } = useParams();
  const d = useData('buyers', 'buyer_interests', 'transactions', 'dispositions', 'properties');
  const history = useRows('activities', { buyer_id: id });
  const perms = usePerms(), w = useWrite(), nav = useNavigate(), name = useNames();
  const stats = useBuyerStats(d);
  const [edit, setEdit] = useState(false);
  const b = d.buyers.find(x => x.id === id);
  if (d.loading && !b) return <Loading rows={8} />;
  if (!b) return <Empty title="Buyer not found" action={<Link className="btn" to="/buyers">Back to buyers</Link>} />;
  const s = stats.get(b.id), canWrite = perms.write('buyers');
  const ints = d.buyer_interests.filter(i => i.buyer_id === b.id).sort((a, z) => String(z.created_at).localeCompare(String(a.created_at)));
  const dp = new Map(d.dispositions.map(x => [x.id, x])), pp = new Map(d.properties.map(x => [x.id, x]));
  return (
    <div>
      <Link to="/buyers" className="inline-flex items-center gap-1 text-fg-3 hover:text-fg mb-3"><ChevronLeft size={14} />Buyers</Link>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div><div className="flex items-center gap-2"><h1 className="text-xl font-semibold tracking-tight">{b.name}</h1><DemoMark r={b} />{b.dnc && <Badge tone="red">Do not contact</Badge>}</div><div className="mt-1 text-fg-2">{[b.company, b.strategy, b.financing].filter(Boolean).join(' · ')}</div>
          <div className="mt-2 flex flex-wrap gap-1">{(b.classifications ?? []).map((t: string) => <Badge key={t} tone={t === 'Verified Buyer' ? 'green' : 'blue'}>{t}</Badge>)}{(b.groups ?? []).map((t: string) => <Badge key={t}>{t}</Badge>)}</div></div>
        {canWrite && <div className="flex flex-wrap gap-2"><button className="btn" disabled={b.dnc} onClick={() => openAction({ type: 'call', buyer_id: b.id })}><Phone size={14} />Log call</button><button className="btn" disabled={b.dnc} onClick={() => openAction({ type: 'message', kind: 'buyers', personId: b.id, channel: 'Email' })}><Mail size={14} />Message</button><button className="btn" onClick={() => setEdit(true)}><Pencil size={14} />Edit</button>
          {perms.del('buyers') && <button className="btn btn-icon btn-danger" aria-label="Delete buyer" onClick={async () => { if (await confirmDialog({ title: 'Delete this buyer?', body: 'Their interest history on campaigns is removed. Buyers on transactions cannot be deleted.', danger: true, confirm: 'Delete' })) w.remove('buyers', b.id).then(() => nav('/buyers')).catch(toast.error); }}><Trash2 size={14} /></button>}</div>}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3 mb-4">{[['Deals presented', num(s?.presented ?? 0)], ['Offers made', num(s?.offers ?? 0)], ['Offers accepted', num(s?.accepted ?? 0)], ['Deals closed', num(s?.closed ?? 0)], ['Avg purchase price', money(s?.avgPrice)], ['Total volume', money(s?.volume ?? 0)], ['Avg response time', s?.avgResponseHours == null ? '—' : `${num(s.avgResponseHours, 1)}h`], ['Reliability', pct(s?.reliability)]].map(([l, v]) => <div key={l} className="card p-3"><div className="text-[11px] text-fg-3 truncate">{l}</div><div className="mt-0.5 font-semibold tnum">{v}</div></div>)}</div>
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px] gap-4 items-start">
        <div className="space-y-4 min-w-0">
          <Card title="Buy box">
            <KV cols={3} rows={[['Strategy', b.strategy], ['Cities', (b.cities ?? []).join(', ')], ['ZIP codes', (b.zips ?? []).join(', ')], ['Counties', (b.counties ?? []).join(', ')], ['Property types', (b.property_types ?? []).join(', ')], ['Min bedrooms', b.min_beds], ['Purchase price', b.min_price || b.max_price ? `${money(b.min_price)} – ${money(b.max_price)}` : null], ['Preferred ARV', b.min_arv || b.max_arv ? `${money(b.min_arv)} – ${money(b.max_arv)}` : null], ['Max repairs', money(b.max_repairs)], ['Assignment fee range', b.fee_min || b.fee_max ? `${money(b.fee_min)} – ${money(b.fee_max)}` : null], ['Financing', b.financing]]} />
            {b.notes && <div className="mt-3 pt-3 border-t border-line whitespace-pre-wrap text-fg-2">{b.notes}</div>}
          </Card>
          <Card title="Deals presented" pad={false}>{ints.length === 0 ? <div className="p-6 text-center text-fg-3">This buyer has not been added to any disposition campaign yet.</div> : <table className="w-full"><thead><tr>{['Property', 'Status', 'Match', 'Offer', 'Sent', 'Feedback'].map(h => <th key={h} className="th">{h}</th>)}</tr></thead><tbody>{ints.map(i => { const dd = dp.get(i.disposition_id); return <tr key={i.id} className="row cursor-pointer" onClick={() => nav(`/dispositions/${i.disposition_id}`)}><td className="td font-medium">{pp.get(dd?.property_id)?.address ?? '—'}</td><td className="td"><StatusBadge value={i.status} /></td><td className="td tnum">{i.match_score ?? '—'}</td><td className="td tnum">{money(i.offer_amount)}</td><td className="td">{i.sent_at ? ago(i.sent_at) : '—'}</td><td className="td text-fg-2">{i.feedback}</td></tr>; })}</tbody></table>}</Card>
          <Card title="Activity"><Timeline activities={history.rows} scope={{ buyer_id: b.id }} loading={history.loading} canNote={canWrite} /></Card>
        </div>
        <div className="space-y-4 min-w-0">
          <Card title="Contact"><KV rows={[['Phone', b.phone && <a className="link" href={`tel:${b.phone}`}>{b.phone}</a>], ['Email', b.email && <a className="link break-all" href={`mailto:${b.email}`}>{b.email}</a>], ['Prefers', b.preferred_contact], ['Website', b.website], ['Our rep', name(b.rep_id)]]} />
            <div className="mt-3 pt-3 border-t border-line flex flex-wrap gap-1.5"><Badge tone={b.email_opt_in ? 'green' : 'gray'} title={b.email_opt_in_at ? `Consent recorded ${fdatetime(b.email_opt_in_at)}` : undefined}>Email {b.email_opt_in ? 'consent' : 'no consent'}</Badge><Badge tone={b.sms_opt_in ? 'green' : 'gray'} title={b.sms_opt_in_at ? `Consent recorded ${fdatetime(b.sms_opt_in_at)}` : undefined}>SMS {b.sms_opt_in ? 'consent' : 'no consent'}</Badge></div></Card>
          <Card title="Proof of funds">
            <div className="flex items-center gap-3"><StatusBadge value={b.pof_status} />{b.pof_verified_on && <span className="text-fg-3">verified {fdate(b.pof_verified_on)}</span>}</div>
            {canWrite && <select className="input mt-3" value={b.pof_status ?? 'Not Requested'} onChange={e => w.patch('buyers', b.id, { pof_status: e.target.value }).then(() => toast.success('Proof of funds status updated')).catch(toast.error)} aria-label="Proof of funds status">{['Not Requested', 'Requested', 'Received', 'Verified', 'Expired'].map(x => <option key={x}>{x}</option>)}</select>}
            <div className="mt-4"><Attachments scope={{ buyer_id: b.id }} category="Proof of Funds" title="POF documents" /></div>
          </Card>
        </div>
      </div>
      <RecordModal entity="buyers" open={edit} onClose={() => setEdit(false)} record={b} />
    </div>
  );
}

export function DispositionsPage() {
  const { settings } = useBoot();
  const d = useData('dispositions', 'properties', 'buyer_interests', 'transactions', 'buyers');
  const perms = usePerms(), nav = useNavigate(), name = useNames();
  const [pick, setPick] = useState(false);
  const p = useMemo(() => new Map(d.properties.map(x => [x.id, x])), [d.properties]);
  const ints = useMemo(() => { const m = new Map<string, R[]>(); for (const i of d.buyer_interests) (m.get(i.disposition_id) ?? m.set(i.disposition_id, []).get(i.disposition_id)!).push(i); return m; }, [d.buyer_interests]);
  const top = (r: R) => Math.max(0, ...(ints.get(r.id) ?? []).map(i => i.offer_amount ?? 0)) || null;
  const cols: Col[] = [
    { key: 'property', label: 'Property', width: 250, value: r => propertyLabel(p.get(r.property_id)), render: r => <span className="flex items-center gap-2"><Row2 a={p.get(r.property_id)?.address ?? '—'} b={p.get(r.property_id)?.city} /><DemoMark r={r} /></span> },
    { key: 'status', label: 'Status', render: r => <StatusBadge value={r.status} /> }, { key: 'purchase_price', label: 'Contract price', align: 'right', render: r => money(r.purchase_price) }, { key: 'asking_price', label: 'Asking', align: 'right', render: r => money(r.asking_price) }, { key: 'fee_target', label: 'Target fee', align: 'right', render: r => money(r.fee_target) },
    { key: 'buyers', label: 'Buyers', align: 'right', value: r => (ints.get(r.id) ?? []).length }, { key: 'offers', label: 'Offers', align: 'right', value: r => (ints.get(r.id) ?? []).filter(i => i.offer_amount).length }, { key: 'top', label: 'Top offer', align: 'right', value: top, render: r => money(top(r)) },
    { key: 'buyer', label: 'Selected buyer', value: r => d.buyers.find(b => b.id === r.selected_buyer_id)?.name }, { key: 'days', label: 'Days', align: 'right', value: r => (r.ended_on ? Math.round((Date.parse(r.ended_on) - Date.parse(r.started_on ?? r.created_at)) / 864e5) : daysSince(r.started_on ?? r.created_at)) }, { key: 'owner', label: 'Owner', value: r => name(r.owner_id) },
  ];
  const ready = d.transactions.filter(t => !['Closed', 'Cancelled'].includes(t.status) && !d.dispositions.some(x => x.property_id === t.property_id && ['Draft', 'Active', 'Buyer Selected', 'Assigned'].includes(x.status)));
  const start = (t: R) => { setPick(false); openAction({ type: 'record', entity: 'dispositions', defaults: { property_id: t.property_id, transaction_id: t.id, asking_price: (t.purchase_price ?? 0) + settings.analyzer.assignmentFee, status: 'Active' }, fields: ['asking_price', 'fee_target', 'summary', 'owner_id'], title: `Start disposition — ${p.get(t.property_id)?.address ?? ''}` }); };
  if (d.error) return <ErrorBox error={d.error} />;
  return (
    <div>
      <PageHeader title="Dispositions" subtitle="Market deals under contract to matched buyers and track interest through to assignment.">
        {perms.write('dispositions') && <button className="btn btn-primary" onClick={() => setPick(true)}><Plus size={14} />New disposition{ready.length > 0 && <span className="ml-1 px-1.5 rounded bg-white/20 tnum">{ready.length}</span>}</button>}
      </PageHeader>
      <DataTable rows={d.dispositions} cols={cols} loading={d.loading} onRowClick={r => nav(`/dispositions/${r.id}`)} viewKey="dispositions" exportName="dispositions"
        filters={[{ key: 'status', label: 'Status', options: DISPO_STATUSES.map(s => ({ value: s, label: s })), get: r => r.status }]}
        empty={<Empty icon={<Megaphone size={18} />} title="No disposition campaigns yet" body="When a property is under contract, start a campaign to match and market it to your buyers." />} />
      <Modal open={pick} onClose={() => setPick(false)} title="Start a disposition campaign" size="md">
        {ready.length === 0 ? <Empty title="No deals waiting for disposition" body="Deals appear here once a purchase agreement is fully executed and its transaction is open." /> : <div><p className="text-fg-2 mb-3">Deals under contract without an active campaign:</p><div className="border border-line rounded-md divide-y divide-line">{ready.map(t => <button key={t.id} className="w-full flex items-center gap-3 px-3 h-11 text-left hover:bg-surface-2" onClick={() => start(t)}><span className="font-medium flex-1 truncate">{propertyLabel(p.get(t.property_id))}</span><span className="tnum text-fg-2">{money(t.purchase_price)}</span><StatusBadge value={t.status} /></button>)}</div></div>}
      </Modal>
    </div>
  );
}

function MatchReasons({ m }: { m: MatchResult }) {
  return <ul className="space-y-0.5">{m.reasons.map((r, i) => <li key={i} className="flex items-start gap-1.5 text-xs">{r.ok ? <Check size={12} className="text-t-green mt-0.5 shrink-0" /> : <X size={12} className="text-t-red mt-0.5 shrink-0" />}<span className={r.ok ? '' : 'text-fg-2'}>{r.text}</span><span className="ml-auto tnum text-fg-3 shrink-0">{r.points}/{r.max}</span></li>)}</ul>;
}

export function DispositionDetail() {
  const { id } = useParams();
  const d = useData('dispositions', 'properties', 'buyers', 'buyer_interests', 'transactions', 'comps');
  const history = useRows('activities', { disposition_id: id });
  const perms = usePerms(), w = useWrite(), nav = useNavigate();
  const stats = useBuyerStats(d);
  const [tab, setTab] = useState<'interest' | 'find' | 'offers' | 'history'>('interest'), [sel, setSel] = useState<Set<string>>(new Set()), [send, setSend] = useState(false), [edit, setEdit] = useState(false), [offerFor, setOfferFor] = useState<R | null>(null), [expanded, setExpanded] = useState<string | null>(null), [minScore, setMinScore] = useState(50), [text, setText] = useState('');
  const { busy, run } = useBusy();
  const dp = d.dispositions.find(x => x.id === id), property = d.properties.find(x => x.id === dp?.property_id);
  const interests = useMemo(() => d.buyer_interests.filter(i => i.disposition_id === id), [d.buyer_interests, id]);
  const bm = useMemo(() => new Map(d.buyers.map(b => [b.id, b])), [d.buyers]);
  const scored = useMemo(() => (dp && property ? d.buyers.map(b => { const s = stats.get(b.id); return { b, m: matchBuyer(b, { property, price: dp.asking_price, arv: property.arv, repairs: property.repair_cost }, { presented: s?.presented ?? 0, offers: s?.offers ?? 0, closed: s?.closed ?? 0 }) }; }).sort((a, z) => z.m.score - a.m.score) : []), [d.buyers, dp, property, stats]);
  const scoreOf = useMemo(() => new Map(scored.map(x => [x.b.id, x.m])), [scored]);
  if (d.loading && !dp) return <Loading rows={8} />;
  if (!dp) return <Empty title="Disposition not found" action={<Link className="btn" to="/dispositions">Back to dispositions</Link>} />;
  const canWrite = perms.write('dispositions'), done = ['Closed', 'Cancelled'].includes(dp.status);
  const comps = d.comps.filter(c => c.property_id === dp.property_id), cs = compStats(comps as any, property?.sqft);
  const offers = interests.filter(i => i.offer_amount).sort((a, z) => z.offer_amount - a.offer_amount);
  const count = (...st: string[]) => interests.filter(i => st.includes(i.status)).length;
  const engaged = [...interests].sort((a, z) => INTEREST_STATUSES.indexOf(z.status) - INTEREST_STATUSES.indexOf(a.status));
  const candidates = scored.filter(x => !interests.some(i => i.buyer_id === x.b.id) && x.m.score >= minScore && (!text || `${x.b.name} ${x.b.company ?? ''}`.toLowerCase().includes(text.toLowerCase())));
  const add = (buyerId: string, score: number) => w.create('buyer_interests', { disposition_id: dp.id, buyer_id: buyerId, status: 'Matched', match_score: score }).catch(toast.error);
  const choose = async (i: R) => { const b = bm.get(i.buyer_id); if (await confirmDialog({ title: `Select ${b?.name} as the buyer?`, body: `This links them to the deal at ${money(i.offer_amount ?? dp.asking_price)}, drafts the assignment agreement and updates the transaction${dp.purchase_price != null ? ` (assignment fee ${money((i.offer_amount ?? dp.asking_price) - dp.purchase_price)})` : ''}.`, confirm: 'Select buyer' })) run(async () => { const r = await w.post(`/api/dispositions/${dp.id}/select`, { interestId: i.id }); toast.success('Buyer selected — assignment agreement drafted'); if (r.contract) nav(`/contracts?open=${r.contract.id}`); }); };
  const toggleSel = (iid: string) => setSel(s => { const n = new Set(s); n.has(iid) ? n.delete(iid) : n.add(iid); return n; });
  const selected = interests.filter(i => sel.has(i.id));
  return (
    <div>
      <Link to="/dispositions" className="inline-flex items-center gap-1 text-fg-3 hover:text-fg mb-3"><ChevronLeft size={14} />Dispositions</Link>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div><div className="flex items-center gap-2"><h1 className="text-xl font-semibold tracking-tight">{property?.address ?? 'Disposition'}</h1><StatusBadge value={dp.status} /><DemoMark r={dp} /></div>
          <div className="mt-1 text-fg-2 flex flex-wrap gap-x-3">{property && <Link className="link" to={`/properties/${property.id}`}>{[property.city, property.state, property.zip].filter(Boolean).join(', ')}</Link>}{dp.transaction_id && <Link className="link" to={`/transactions?open=${dp.transaction_id}`}>Transaction</Link>}<span>Started {fdate(dp.started_on)}</span></div></div>
        {canWrite && <div className="flex flex-wrap gap-2">{!done && <select className="input !w-auto" value={dp.status} onChange={e => w.patch('dispositions', dp.id, { status: e.target.value }).catch(toast.error)} aria-label="Campaign status">{DISPO_STATUSES.map(s => <option key={s}>{s}</option>)}</select>}<button className="btn" onClick={() => setEdit(true)}><Pencil size={14} />Edit</button></div>}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3 mb-4">{[['Contract price', money(dp.purchase_price)], ['Asking price', money(dp.asking_price)], ['Target fee', money(dp.fee_target)], ['Top offer', money(offers[0]?.offer_amount)], ['Fee at top offer', offers[0] && dp.purchase_price != null ? money(offers[0].offer_amount - dp.purchase_price) : '—'], ['ARV', money(property?.arv)], ['Repairs', money(property?.repair_cost)]].map(([l, v]) => <div key={l} className="card p-3"><div className="text-[11px] text-fg-3">{l}</div><div className="mt-0.5 font-semibold tnum">{v}</div></div>)}</div>
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-4 items-start">
        <div className="card min-w-0">
          <Tabs className="px-4" value={tab} onChange={setTab} tabs={[{ id: 'interest', label: 'Buyer interest', count: interests.length }, { id: 'find', label: 'Find buyers', count: scored.filter(x => !interests.some(i => i.buyer_id === x.b.id) && x.m.score >= 60).length }, { id: 'offers', label: 'Compare offers', count: offers.length }, { id: 'history', label: 'Marketing history' }]} />
          {tab === 'interest' && <div>
            <div className="grid grid-cols-3 sm:grid-cols-6 border-b border-line">{[['Matched', interests.length], ['Sent', interests.filter(i => i.sent_at).length], ['Opened', count('Opened')], ['Responded', interests.filter(i => i.responded_at).length], ['Showings', count('Showing Requested')], ['Offers', offers.length]].map(([l, v]) => <div key={l as string} className="px-4 py-3 border-r border-line last:border-0"><div className="text-[11px] text-fg-3">{l}</div><div className="text-lg font-semibold tnum">{v}</div></div>)}</div>
            {canWrite && !done && <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-line">
              <button className="btn btn-sm" disabled={busy} onClick={() => run(async () => { const r = await w.post(`/api/dispositions/${dp.id}/match`, { minScore: 60 }); toast.success(r.added ? `${r.added} matching buyer(s) added` : 'No new buyers score 60 or higher'); })}><Users size={12} />Auto-match buyers (60+)</button>
              <button className="btn btn-sm" disabled={!selected.length} onClick={() => setSend(true)}><Send size={12} />Send deal to {selected.length || 'selected'}</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setSel(new Set(sel.size === interests.length ? [] : interests.filter(i => i.status === 'Matched').length && sel.size === 0 ? interests.filter(i => i.status === 'Matched').map(i => i.id) : interests.map(i => i.id)))}>{sel.size ? 'Clear selection' : 'Select not-yet-sent'}</button>
              <span className="ml-auto text-[11px] text-fg-3">"Opened" is only tracked when your email provider reports it.</span></div>}
            {interests.length === 0 ? <Empty icon={<Users size={18} />} title="No buyers on this campaign yet" body="Auto-match adds every buyer whose buy box fits this deal. You can also pick buyers by hand under Find buyers." /> : <div className="overflow-x-auto"><table className="w-full"><thead><tr><th className="th w-9" /><th className="th">Buyer</th><th className="th">Match</th><th className="th">Status</th><th className="th text-right">Offer</th><th className="th">Last activity</th><th className="th" /></tr></thead>
              <tbody>{engaged.map(i => { const b = bm.get(i.buyer_id), m = scoreOf.get(i.buyer_id); return [
                <tr key={i.id} className="row"><td className="td"><input type="checkbox" aria-label={`Select ${b?.name}`} checked={sel.has(i.id)} onChange={() => toggleSel(i.id)} /></td>
                  <td className="td"><Link className="font-medium hover:underline" to={`/buyers/${i.buyer_id}`}>{b?.name ?? 'Buyer'}</Link><div className="text-[11px] text-fg-3">{b?.company}</div></td>
                  <td className="td"><button className="inline-flex items-center gap-1.5 tnum font-medium hover:underline" onClick={() => setExpanded(e => (e === i.id ? null : i.id))} title="Why this buyer matches"><span className="w-8 h-1.5 rounded-full bg-surface-3 overflow-hidden"><span className="block h-full rounded-full bg-accent" style={{ width: `${m?.score ?? i.match_score ?? 0}%` }} /></span>{m?.score ?? i.match_score ?? '—'}</button></td>
                  <td className="td">{canWrite && !done ? <select className="input !h-7 !w-40 !text-xs" value={i.status} onChange={e => w.patch('buyer_interests', i.id, { status: e.target.value }).catch(toast.error)} aria-label="Interest status">{INTEREST_STATUSES.map(s => <option key={s}>{s}</option>)}</select> : <StatusBadge value={i.status} />}</td>
                  <td className="td text-right tnum">{i.offer_amount ? <b>{money(i.offer_amount)}</b> : canWrite && !done ? <button className="link text-xs" onClick={() => setOfferFor(i)}>Record offer</button> : '—'}</td>
                  <td className="td text-fg-3 text-xs">{i.responded_at ? `Responded ${ago(i.responded_at)}` : i.sent_at ? `Sent ${ago(i.sent_at)}` : 'Not sent'}</td>
                  <td className="td text-right">{canWrite && <Menu trigger={<button className="btn btn-ghost btn-sm">Actions</button>} items={[{ label: 'Record offer / feedback', onClick: () => setOfferFor(i) }, { label: 'Log a call', onClick: () => openAction({ type: 'call', buyer_id: i.buyer_id }) }, ...(!done && dp.status !== 'Assigned' ? [{ label: 'Select as buyer', icon: <Trophy size={13} />, onClick: () => choose(i) }] : []), { label: '', divider: true }, { label: 'Remove from campaign', danger: true, onClick: () => w.remove('buyer_interests', i.id).catch(toast.error) }]} />}</td></tr>,
                expanded === i.id && m ? <tr key={`${i.id}-x`}><td /><td colSpan={6} className="px-3 py-3 border-b border-line bg-surface-2"><div className="max-w-xl"><MatchReasons m={m} />{i.feedback && <div className="mt-2 text-fg-2"><b>Feedback:</b> {i.feedback}</div>}</div></td></tr> : null]; })}</tbody></table></div>}
          </div>}
          {tab === 'find' && <div>
            <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-line"><div className="relative w-52"><Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-3" /><input className="input pl-8" placeholder="Search buyers" value={text} onChange={e => setText(e.target.value)} /></div>
              <label className="flex items-center gap-2 text-fg-2">Minimum match score<select className="input !w-20" value={minScore} onChange={e => setMinScore(Number(e.target.value))}>{[0, 30, 50, 60, 70, 80].map(v => <option key={v} value={v}>{v}+</option>)}</select></label>
              {canWrite && candidates.length > 0 && <button className="btn btn-sm ml-auto" onClick={async () => { for (const x of candidates) await add(x.b.id, x.m.score); toast.success(`${candidates.length} buyers added`); setTab('interest'); }}><Plus size={12} />Add all {candidates.length}</button>}</div>
            {candidates.length === 0 ? <Empty title="No additional buyers at this score" body="Lower the minimum score, or add buyers whose buy box covers this area and price." /> : <div className="divide-y divide-line">{candidates.map(({ b, m }) => <div key={b.id} className="px-4 py-3 flex flex-wrap gap-4">
              <div className="w-56 min-w-0"><Link className="font-medium hover:underline" to={`/buyers/${b.id}`}>{b.name}</Link><div className="text-[11px] text-fg-3 truncate">{[b.company, b.strategy].filter(Boolean).join(' · ')}</div><div className="mt-1.5 flex items-center gap-2"><span className="text-xl font-semibold tnum">{m.score}</span><span className="text-[11px] text-fg-3">match score</span></div>{m.disqualified && <Badge tone="red">{m.disqualified}</Badge>}</div>
              <div className="flex-1 min-w-[240px]"><MatchReasons m={m} /></div>
              {canWrite && !m.disqualified && <button className="btn btn-sm self-start" onClick={() => add(b.id, m.score)}><Plus size={12} />Add to campaign</button>}</div>)}</div>}
          </div>}
          {tab === 'offers' && (offers.length === 0 ? <Empty icon={<Trophy size={18} />} title="No buyer offers yet" body="Record offers from the Buyer interest tab to compare them side by side." /> : <div className="overflow-x-auto"><table className="w-full"><thead><tr>{['Buyer', 'Offer', 'Your fee', 'Vs. target', 'EMD', 'Proposed close', 'Proof of funds', 'Closed with us', 'Reliability', ''].map(h => <th key={h} className="th">{h}</th>)}</tr></thead>
            <tbody>{offers.map((i, n) => { const b = bm.get(i.buyer_id), s = stats.get(i.buyer_id), fee = dp.purchase_price != null ? i.offer_amount - dp.purchase_price : null; return <tr key={i.id} className={cx('row', dp.selected_buyer_id === i.buyer_id && 'bg-accent-soft')}><td className="td font-medium">{n === 0 && <Trophy size={12} className="inline mr-1 text-t-amber" />}{b?.name}</td><td className="td tnum font-medium">{money(i.offer_amount)}</td><td className="td tnum">{money(fee)}</td><td className={cx('td tnum', fee != null && dp.fee_target != null && fee < dp.fee_target && 'text-t-red')}>{fee != null && dp.fee_target != null ? money(fee - dp.fee_target) : '—'}</td><td className="td tnum">{money(i.emd)}</td><td className="td">{fdate(i.proposed_close)}</td><td className="td"><StatusBadge value={b?.pof_status} /></td><td className="td tnum">{s?.closed ?? 0}</td><td className="td tnum">{pct(s?.reliability)}</td>
              <td className="td text-right">{dp.selected_buyer_id === i.buyer_id ? <Badge tone="green">Selected</Badge> : canWrite && !done && dp.status !== 'Assigned' && <button className="btn btn-sm" disabled={busy} onClick={() => choose(i)}>Select buyer</button>}</td></tr>; })}</tbody></table>
            <p className="px-4 py-2.5 text-[11px] text-fg-3 border-t border-line">The highest offer is not always the best one: weigh proof of funds, earnest money, closing date and each buyer's history of actually closing.</p></div>)}
          {tab === 'history' && <div className="p-4"><Timeline activities={history.rows} scope={{ disposition_id: dp.id, property_id: dp.property_id }} loading={history.loading} canNote={canWrite} /></div>}
        </div>
        <div className="space-y-4 min-w-0">
          <Card title="Deal summary">{dp.summary ? <p className="whitespace-pre-wrap leading-relaxed">{dp.summary}</p> : <p className="text-fg-3">No summary yet. Add the pitch buyers will read.</p>}
            {property && <div className="mt-3 pt-3 border-t border-line"><KV rows={[['Type', property.property_type], ['Bed / bath', `${property.beds ?? '—'} / ${property.baths ?? '—'}`], ['Sq ft', num(property.sqft)], ['Year built', property.year_built], ['Condition', property.condition], ['Occupancy', property.occupancy]]} /></div>}</Card>
          <Card title="Comparable sales">{comps.length === 0 ? <p className="text-fg-3">No comps on this property. <Link className="link" to={`/properties/${dp.property_id}`}>Add comps</Link></p> : <div><div className="space-y-1.5">{comps.map(c => <div key={c.id} className="flex justify-between gap-3"><span className="truncate text-fg-2">{c.address}</span><span className="tnum font-medium">{money(c.sale_price)}</span></div>)}</div>{cs.avgPpsf && <div className="mt-2 pt-2 border-t border-line text-fg-2">Avg {money(cs.avgPpsf)}/sq ft{cs.impliedArv ? ` → ${money(cs.impliedArv)}` : ''} <span className="text-fg-3">(manual comps)</span></div>}</div>}</Card>
          <Card title="Photos"><Attachments scope={{ property_id: dp.property_id }} photos title="Property photos" /></Card>
        </div>
      </div>
      <RecordModal entity="dispositions" open={edit} onClose={() => setEdit(false)} record={dp} fields={['asking_price', 'fee_target', 'purchase_price', 'summary', 'owner_id']} size="md" />
      {offerFor && <RecordModal entity="buyer_interests" open onClose={() => setOfferFor(null)} record={offerFor} fields={['status', 'offer_amount', 'emd', 'proposed_close', 'feedback']} size="md" title={`Offer & feedback — ${bm.get(offerFor.buyer_id)?.name ?? ''}`} />}
      {send && <BulkMessage buyers={selected.map(i => bm.get(i.buyer_id)!).filter(Boolean)} dispositionId={dp.id} interests={selected} property={property} onClose={() => { setSend(false); setSel(new Set()); }} />}
    </div>
  );
}
