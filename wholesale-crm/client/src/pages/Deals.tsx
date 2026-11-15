import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlarmClock, CheckCircle2, Copy, FileSignature, FileText, HandCoins, Megaphone, Pencil, Plus, Printer, Trash2 } from 'lucide-react';
import { analyzeDeal } from '@shared/calc';
import { contactName, propertyLabel, renderTemplate } from '@shared/logic';
import { CONTRACT_STATUSES, OFFER_STATUSES, TXN_STATUSES } from '@shared/schema';
import { useBoot, useData, usePerms, useRows, useWrite, type R } from '@/lib/app';
import { daysSince, fdate, money, todayIso } from '@/lib/format';
import { Badge, Card, confirmDialog, cx, Drawer, Empty, ErrorBox, KV, Modal, PageHeader, promptDialog, StatusBadge, toast, Toggle } from '@/ui/core';
import { DataTable, type Col } from '@/ui/DataTable';
import { RecordModal } from '@/ui/Form';
import { openAction } from '@/ui/actions';
import { Timeline } from '@/ui/Timeline';
import { Attachments, DemoMark, Row2, useNames } from '@/ui/shared';

function useOpen() {
  const [sp, setSp] = useSearchParams();
  return [sp.get('open'), (id: string | null) => { const n = new URLSearchParams(sp); id ? n.set('open', id) : n.delete('open'); setSp(n, { replace: true }); }] as const;
}
const daysTo = (d?: string | null) => (d ? Math.ceil((new Date(d + 'T12:00:00').getTime() - Date.now()) / 864e5) : null);
function Deadline({ label, date }: { label: string; date?: string | null }) {
  const n = daysTo(date);
  if (n === null) return null;
  return <div className={cx('flex items-center gap-2 px-3 py-2 rounded-md border', n < 0 ? 'border-critical/40 bg-critical/5' : n <= 3 ? 'border-warn/50 bg-warn/5' : 'border-line')}><AlarmClock size={14} className={n < 0 ? 'text-t-red' : n <= 3 ? 'text-t-amber' : 'text-fg-3'} /><span className="flex-1">{label}</span><span className="font-medium">{fdate(date)}</span><span className={cx('text-xs tnum w-20 text-right', n < 0 ? 'text-t-red' : 'text-fg-3')}>{n === 0 ? 'today' : n > 0 ? `in ${n} day${n === 1 ? '' : 's'}` : `${-n} day${n === -1 ? '' : 's'} ago`}</span></div>;
}

// ---------- Offers ----------
export function OffersPage() {
  const { settings, user } = useBoot();
  const d = useData('offers', 'properties', 'contacts', 'leads', 'analyses', 'contracts', 'templates');
  const perms = usePerms(), w = useWrite(), name = useNames();
  const [open, setOpen] = useOpen();
  const [modal, setModal] = useState<{ record?: R; defaults?: R; title?: string } | null>(null), [doc, setDoc] = useState<string | null>(null), [contractFor, setContractFor] = useState<R | null>(null);
  const p = useMemo(() => new Map(d.properties.map(x => [x.id, x])), [d.properties]), c = useMemo(() => new Map(d.contacts.map(x => [x.id, x])), [d.contacts]);
  const cols: Col[] = [
    { key: 'property', label: 'Property', width: 250, value: r => propertyLabel(p.get(r.property_id)), render: r => <span className="flex items-center gap-2"><Row2 a={p.get(r.property_id)?.address ?? '—'} b={contactName(c.get(r.contact_id))} /><DemoMark r={r} /></span> },
    { key: 'from_party', label: 'From', render: r => <Badge tone={r.from_party === 'Seller' ? 'violet' : 'gray'}>{r.from_party === 'Seller' ? 'Seller counter' : 'Our offer'}</Badge> },
    { key: 'amount', label: 'Amount', align: 'right', render: r => money(r.amount) }, { key: 'status', label: 'Status', render: r => <StatusBadge value={r.status} /> },
    { key: 'offer_date', label: 'Offer date', render: r => fdate(r.offer_date) }, { key: 'expires_on', label: 'Expires', render: r => (r.expires_on ? <span className={cx(['Presented', 'Countered', 'Pending Approval'].includes(r.status) && r.expires_on < todayIso() && 'text-t-red')}>{fdate(r.expires_on)}</span> : null) },
    { key: 'closing_date', label: 'Closing', render: r => fdate(r.closing_date), hidden: true }, { key: 'emd', label: 'EMD', align: 'right', render: r => money(r.emd) }, { key: 'fee_target', label: 'Fee target', align: 'right', render: r => money(r.fee_target) },
    { key: 'method', label: 'Method', hidden: true }, { key: 'owner', label: 'Owner', value: r => name(r.owner_id) },
  ];
  const o = d.offers.find(x => x.id === open), prop = o && p.get(o.property_id);
  const thread = o ? d.offers.filter(x => x.property_id === o.property_id).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))) : [];
  const analysis = o && (d.analyses.find(a => a.id === o.analysis_id) ?? d.analyses.filter(a => a.property_id === o.property_id).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0]);
  const at = o && analysis?.inputs ? analyzeDeal({ ...analysis.inputs, offerPrice: o.amount }, settings.analyzer.thresholds) : null;
  const canWrite = perms.write('offers'), existingContract = o && d.contracts.find(x => x.offer_id === o.id);
  const setStatus = (status: string) => o && w.patch('offers', o.id, { status }).then(() => toast.success(`Offer marked ${status}`)).catch(toast.error);
  const summary = () => { if (!o) return; const tpl = d.templates.find(t => t.channel === 'Offer'); setDoc(renderTemplate(tpl?.body ?? 'Offer for {{property_address}}: {{offer_amount}}. This summary is not a contract.', { contact: c.get(o.contact_id), property: prop, offer: o, user, company: settings.company.name })); };
  if (d.error) return <ErrorBox error={d.error} />;
  return (
    <div>
      <PageHeader title="Offers" subtitle="Every offer and counteroffer, tied to its property, seller and underwriting.">
        {canWrite && <button className="btn btn-primary" onClick={() => setModal({ defaults: { status: 'Draft', from_party: 'Us' } })}><Plus size={14} />New offer</button>}
      </PageHeader>
      <DataTable rows={d.offers} cols={cols} loading={d.loading} onRowClick={r => setOpen(r.id)} viewKey="offers" exportName="offers" initialSort={{ key: 'offer_date', dir: -1 }}
        filters={[{ key: 'status', label: 'Status', options: OFFER_STATUSES.map(s => ({ value: s, label: s })), get: r => r.status }, { key: 'from', label: 'From', options: [{ value: 'Us', label: 'Our offers' }, { value: 'Seller', label: 'Seller counters' }], get: r => r.from_party }]}
        empty={<Empty icon={<HandCoins size={18} />} title="No offers yet" body="Create an offer from the Deal Analyzer or from a lead once you have underwritten the property." />} />
      <Drawer open={!!o} onClose={() => setOpen(null)} width={560} title={o ? `${o.from_party === 'Seller' ? 'Seller counter' : 'Offer'} · ${money(o.amount)}` : ''} actions={o && canWrite && <><button className="btn btn-ghost btn-sm" onClick={() => setModal({ record: o })}><Pencil size={12} />Edit</button>{perms.del('offers') && <button className="btn btn-ghost btn-icon btn-sm" aria-label="Delete offer" onClick={async () => { if (await confirmDialog({ title: 'Delete this offer?', danger: true, confirm: 'Delete' })) w.remove('offers', o.id).then(() => setOpen(null)).catch(toast.error); }}><Trash2 size={13} /></button>}</>}>
        {o && <div className="p-5 space-y-5">
          <div className="flex flex-wrap items-center gap-2"><StatusBadge value={o.status} />{prop && <Link className="link" to={`/properties/${prop.id}`}>{propertyLabel(prop)}</Link>}{o.lead_id && <Link className="link" to={`/leads/${o.lead_id}`}>· {contactName(c.get(o.contact_id))}</Link>}</div>
          {canWrite && <div className="flex flex-wrap gap-2">
            {['Draft', 'Pending Approval'].includes(o.status) && <button className="btn btn-primary btn-sm" onClick={() => setStatus('Presented')}>Mark presented</button>}
            {['Presented', 'Countered'].includes(o.status) && <><button className="btn btn-primary btn-sm" onClick={() => setStatus('Accepted')}><CheckCircle2 size={12} />Mark accepted</button><button className="btn btn-sm" onClick={() => setStatus('Rejected')}>Rejected</button>
              <button className="btn btn-sm" onClick={() => setModal({ title: o.from_party === 'Seller' ? 'Counter back to seller' : 'Record seller counteroffer', defaults: { property_id: o.property_id, lead_id: o.lead_id, contact_id: o.contact_id, parent_id: o.id, from_party: o.from_party === 'Seller' ? 'Us' : 'Seller', status: 'Presented', emd: o.emd, fee_target: o.fee_target } })}>{o.from_party === 'Seller' ? 'Counter back' : 'Record counter'}</button>
              {o.from_party !== 'Seller' && <button className="btn btn-sm" onClick={() => setStatus('Withdrawn')}>Withdraw</button>}</>}
            {o.status === 'Accepted' && (existingContract ? <Link className="btn btn-sm" to={`/contracts?open=${existingContract.id}`}><FileSignature size={12} />Open contract</Link> : perms.write('contracts') && <button className="btn btn-primary btn-sm" onClick={() => setContractFor(o)}><FileSignature size={12} />Create contract</button>)}
            <button className="btn btn-sm" onClick={summary}><FileText size={12} />Offer summary</button>
          </div>}
          <KV rows={[['Amount', <b className="tnum">{money(o.amount)}</b>], ['Offer date', fdate(o.offer_date)], ['Expires', fdate(o.expires_on)], ['Desired closing', fdate(o.closing_date)], ['Earnest money', money(o.emd)], ['Assignment fee target', money(o.fee_target)], ['Method', o.method], ['Owner', name(o.owner_id)]]} />
          {o.notes && <div><div className="section-t mb-1.5">Negotiation notes</div><div className="whitespace-pre-wrap text-fg-2">{o.notes}</div></div>}
          <div><div className="section-t mb-2">Underwriting at this price</div>
            {at && analysis ? <div className="card p-3"><div className="flex items-center justify-between gap-2 mb-2"><Link className="link font-medium" to={`/analyzer?property=${o.property_id}&analysis=${analysis.id}`}>{analysis.name}</Link><StatusBadge value={at.rating} /></div>
              <KV cols={3} rows={[['MAO', money(analysis.mao)], ['Offer vs. MAO', <span className={cx('tnum', o.amount > analysis.mao && 'text-t-red')}>{money(o.amount - analysis.mao)}</span>], ['Projected fee', <b className="tnum">{money(at.projectedFee)}</b>], ['Buyer pays', money(at.buyerMaxPrice)], ['ARV', money(analysis.inputs.arv)], ['Repairs', money(analysis.inputs.repairs)]]} />
              {o.amount > analysis.mao && <div className="mt-2 text-t-red">This offer is above the maximum allowable offer from underwriting.</div>}</div>
              : <div className="text-fg-3 border border-dashed border-line rounded-md p-3 text-center">No deal analysis saved for this property. <Link className="link" to={`/analyzer?property=${o.property_id}`}>Underwrite it</Link></div>}</div>
          <div><div className="section-t mb-2">Offer history for this property</div><div className="border border-line rounded-md divide-y divide-line">{thread.map(x => <button key={x.id} onClick={() => setOpen(x.id)} className={cx('w-full flex items-center gap-3 px-3 h-10 text-left hover:bg-surface-2', x.id === o.id && 'bg-surface-2')}><span className="text-[11px] text-fg-3 w-16">{fdate(x.offer_date).slice(0, 5)}</span><Badge tone={x.from_party === 'Seller' ? 'violet' : 'gray'}>{x.from_party === 'Seller' ? 'Seller' : 'Us'}</Badge><span className="font-medium tnum flex-1">{money(x.amount)}</span>{thread.indexOf(x) > 0 && <span className="text-[11px] tnum text-fg-3">{x.amount - thread[thread.indexOf(x) - 1].amount >= 0 ? '+' : ''}{money(x.amount - thread[thread.indexOf(x) - 1].amount)}</span>}<StatusBadge value={x.status} /></button>)}</div></div>
        </div>}
      </Drawer>
      {modal && <RecordModal entity="offers" open onClose={() => setModal(null)} record={modal.record} defaults={modal.defaults} title={modal.title} exclude={['parent_id', 'analysis_id', 'contact_id', 'from_party', ...(modal.defaults?.parent_id ? ['property_id', 'lead_id'] : [])]} />}
      {contractFor && <RecordModal entity="contracts" open onClose={() => setContractFor(null)} title="Create purchase agreement from accepted offer" fields={['type', 'purchase_price', 'emd', 'effective_date', 'inspection_end', 'closing_date', 'title_company', 'status', 'contingencies', 'notes']}
        defaults={{ type: 'Purchase Agreement', property_id: contractFor.property_id, lead_id: contractFor.lead_id, contact_id: contractFor.contact_id, offer_id: contractFor.id, purchase_price: contractFor.amount, emd: contractFor.emd, closing_date: contractFor.closing_date, status: 'Draft' }} />}
      <Modal open={doc !== null} onClose={() => setDoc(null)} title="Offer summary" size="md" footer={<><button className="btn" onClick={() => { void navigator.clipboard.writeText(doc ?? ''); toast.success('Copied'); }}><Copy size={13} />Copy</button><button className="btn" onClick={() => window.print()}><Printer size={13} />Print</button></>}>
        <div className="whitespace-pre-wrap leading-relaxed">{doc}</div>
        <p className="mt-4 pt-3 border-t border-line text-[11px] text-fg-3">Generated from your "Offer" template (Communications → Templates). This is a plain-language summary, not a legally binding document. Use your attorney-approved purchase agreement for the contract itself.</p>
      </Modal>
    </div>
  );
}

// ---------- Contracts ----------
export function ContractsPage() {
  const d = useData('contracts', 'properties', 'contacts', 'buyers', 'transactions');
  const perms = usePerms(), w = useWrite();
  const [open, setOpen] = useOpen(), [modal, setModal] = useState<{ record?: R } | null>(null);
  const p = useMemo(() => new Map(d.properties.map(x => [x.id, x])), [d.properties]), c = useMemo(() => new Map(d.contacts.map(x => [x.id, x])), [d.contacts]), b = useMemo(() => new Map(d.buyers.map(x => [x.id, x])), [d.buyers]);
  const sig = (r: R) => { const need = r.type === 'Assignment Agreement' ? ['buyer_signed', 'company_signed'] : ['seller_signed', 'company_signed']; return `${need.filter(k => r[k]).length}/${need.length}`; };
  const cols: Col[] = [
    { key: 'property', label: 'Property', width: 240, value: r => propertyLabel(p.get(r.property_id)), render: r => <span className="flex items-center gap-2"><Row2 a={p.get(r.property_id)?.address ?? '—'} b={r.type} /><DemoMark r={r} /></span> },
    { key: 'type', label: 'Type', hidden: true }, { key: 'party', label: 'Counterparty', value: r => (r.type === 'Assignment Agreement' ? b.get(r.buyer_id)?.name : contactName(c.get(r.contact_id))) },
    { key: 'status', label: 'Status', render: r => <StatusBadge value={r.status} /> }, { key: 'signatures', label: 'Signatures', value: sig },
    { key: 'purchase_price', label: 'Purchase', align: 'right', render: r => money(r.purchase_price) }, { key: 'assignment_fee', label: 'Assignment fee', align: 'right', render: r => money(r.assignment_fee) },
    { key: 'effective_date', label: 'Effective', render: r => fdate(r.effective_date) }, { key: 'inspection_end', label: 'Inspection ends', render: r => fdate(r.inspection_end) }, { key: 'closing_date', label: 'Closing', render: r => fdate(r.closing_date) }, { key: 'title_company', label: 'Title company', hidden: true },
  ];
  const live = d.contracts.filter(x => !['Closed', 'Terminated', 'Draft'].includes(x.status));
  const deadlines = live.flatMap(x => [['Inspection period ends', x.inspection_end], ['Closing', x.closing_date]].filter(([, dt]) => { const n = daysTo(dt as string); return n !== null && n <= 14 && n >= -7; }).map(([label, dt]) => ({ id: x.id, label: `${label} — ${p.get(x.property_id)?.address ?? ''}`, date: dt as string }))).sort((a, z) => a.date.localeCompare(z.date));
  const k = d.contracts.find(x => x.id === open), canWrite = perms.write('contracts'), isAssign = k?.type === 'Assignment Agreement';
  const patch = (data: R, msg?: string) => k && w.patch('contracts', k.id, data).then(r => toast.success(msg ?? (r.status !== k.status ? `Contract is now ${r.status}` : 'Saved'))).catch(toast.error);
  if (d.error) return <ErrorBox error={d.error} />;
  return (
    <div>
      <PageHeader title="Contracts" subtitle="Purchase and assignment agreements with signature status, deadlines and documents.">
        {canWrite && <button className="btn btn-primary" onClick={() => setModal({})}><Plus size={14} />New contract</button>}
      </PageHeader>
      {deadlines.length > 0 && <Card title="Upcoming deadlines" className="mb-4"><div className="grid md:grid-cols-2 gap-2">{deadlines.slice(0, 6).map((x, i) => <button key={i} className="text-left" onClick={() => setOpen(x.id)}><Deadline label={x.label} date={x.date} /></button>)}</div></Card>}
      <DataTable rows={d.contracts} cols={cols} loading={d.loading} onRowClick={r => setOpen(r.id)} viewKey="contracts" exportName="contracts" initialSort={{ key: 'closing_date', dir: 1 }}
        filters={[{ key: 'status', label: 'Status', options: CONTRACT_STATUSES.map(s => ({ value: s, label: s })), get: r => r.status }, { key: 'type', label: 'Type', options: ['Purchase Agreement', 'Assignment Agreement', 'Double Close (B-C)', 'Other'].map(s => ({ value: s, label: s })), get: r => r.type }]}
        empty={<Empty icon={<FileSignature size={18} />} title="No contracts yet" body="Create a contract from an accepted offer. Marking a purchase agreement fully executed opens its transaction automatically." />} />
      <Drawer open={!!k} onClose={() => setOpen(null)} width={560} title={k ? `${k.type} · ${p.get(k.property_id)?.address ?? ''}` : ''} actions={k && canWrite && <><button className="btn btn-ghost btn-sm" onClick={() => setModal({ record: k })}><Pencil size={12} />Edit</button>{perms.del('contracts') && <button className="btn btn-ghost btn-icon btn-sm" aria-label="Delete contract" onClick={async () => { if (await confirmDialog({ title: 'Delete this contract record?', body: 'Uploaded documents for it are deleted too.', danger: true, confirm: 'Delete' })) w.remove('contracts', k.id).then(() => setOpen(null)).catch(toast.error); }}><Trash2 size={13} /></button>}</>}>
        {k && <div className="p-5 space-y-5">
          <div className="flex flex-wrap items-center gap-2"><StatusBadge value={k.status} /><Link className="link" to={`/properties/${k.property_id}`}>{propertyLabel(p.get(k.property_id))}</Link>{k.lead_id && <Link className="link" to={`/leads/${k.lead_id}`}>· Lead</Link>}{k.transaction_id && <Link className="link" to={`/transactions?open=${k.transaction_id}`}>· Transaction</Link>}</div>
          {canWrite && <div><div className="label">Status</div><select className="input !w-60" value={k.status} onChange={e => patch({ status: e.target.value })}>{CONTRACT_STATUSES.map(s => <option key={s}>{s}</option>)}</select></div>}
          <div><div className="section-t mb-2">Signatures</div><div className="border border-line rounded-md divide-y divide-line">{([[isAssign ? 'buyer_signed' : 'seller_signed', isAssign ? `Buyer${b.get(k.buyer_id) ? ` — ${b.get(k.buyer_id)!.name}` : ''}` : `Seller — ${contactName(c.get(k.contact_id))}`], ['company_signed', 'Our company']] as [string, string][]).map(([key, label]) => <div key={key} className="flex items-center gap-3 px-3 h-10"><span className="flex-1">{label}</span><span className={cx('text-xs', k[key] ? 'text-t-green' : 'text-fg-3')}>{k[key] ? 'Signed' : 'Not signed'}</span><Toggle checked={!!k[key]} disabled={!canWrite || ['Closed', 'Terminated'].includes(k.status)} onChange={v => patch({ [key]: v })} label={label} /></div>)}</div>
            <p className="mt-1.5 text-[11px] text-fg-3">Signature status is tracked manually. When all parties have signed, the contract becomes Fully Executed{isAssign ? ' and the transaction moves to Assigned' : ' and its transaction is opened'}. E-signature sync is not connected.</p></div>
          <div className="space-y-2"><Deadline label="Inspection period ends" date={k.inspection_end} /><Deadline label="Closing date" date={k.closing_date} /></div>
          <KV rows={[['Purchase price', money(k.purchase_price)], ['Assignment price', money(k.assignment_price)], ['Assignment fee', <b className="tnum">{money(k.assignment_fee)}</b>], ['Earnest money', money(k.emd)], ['Effective date', fdate(k.effective_date)], ['Title company', k.title_company], ['Seller', contactName(c.get(k.contact_id))], ['Buyer', b.get(k.buyer_id)?.name]]} />
          {k.contingencies && <div><div className="section-t mb-1.5">Important contingencies</div><div className="whitespace-pre-wrap text-fg-2">{k.contingencies}</div></div>}
          {k.notes && <div><div className="section-t mb-1.5">Internal notes</div><div className="whitespace-pre-wrap text-fg-2">{k.notes}</div></div>}
          <Attachments scope={{ contract_id: k.id }} category="Contract" title="Contract documents" />
          <p className="text-[11px] text-fg-3 leading-relaxed">This CRM tracks contracts and stores your documents; it does not draft legal agreements. Upload contracts prepared from your own attorney-approved templates.</p>
        </div>}
      </Drawer>
      {modal && <RecordModal entity="contracts" open onClose={() => setModal(null)} record={modal.record} exclude={['offer_id', 'transaction_id', 'seller_signed', 'buyer_signed', 'company_signed']} />}
    </div>
  );
}

// ---------- Transactions ----------
export function TransactionsPage() {
  const { settings } = useBoot();
  const d = useData('transactions', 'properties', 'contacts', 'buyers', 'contracts', 'dispositions', 'revenue');
  const perms = usePerms(), w = useWrite(), name = useNames();
  const [open, setOpen] = useOpen();
  const history = useRows('activities', { transaction_id: open });
  const [modal, setModal] = useState<{ record?: R } | null>(null), [item, setItem] = useState('');
  const p = useMemo(() => new Map(d.properties.map(x => [x.id, x])), [d.properties]), c = useMemo(() => new Map(d.contacts.map(x => [x.id, x])), [d.contacts]), b = useMemo(() => new Map(d.buyers.map(x => [x.id, x])), [d.buyers]);
  const progress = (r: R) => { const cl: R[] = r.checklist ?? []; return cl.length ? Math.round((cl.filter(x => x.done).length / cl.length) * 100) : 0; };
  const cols: Col[] = [
    { key: 'property', label: 'Property', width: 240, value: r => propertyLabel(p.get(r.property_id)), render: r => <span className="flex items-center gap-2"><Row2 a={p.get(r.property_id)?.address ?? '—'} b={`Seller: ${contactName(c.get(r.contact_id))}`} /><DemoMark r={r} /></span> },
    { key: 'status', label: 'Status', render: r => <StatusBadge value={r.status} /> }, { key: 'buyer', label: 'End buyer', value: r => b.get(r.buyer_id)?.name },
    { key: 'purchase_price', label: 'Purchase', align: 'right', render: r => money(r.purchase_price) }, { key: 'assignment_price', label: 'Buyer price', align: 'right', render: r => money(r.assignment_price) }, { key: 'assignment_fee', label: 'Assignment fee', align: 'right', render: r => <b>{money(r.assignment_fee)}</b> },
    { key: 'closing_date', label: 'Closing', render: r => { const n = daysTo(r.closing_date); return r.closing_date ? <span className={cx(!['Closed', 'Cancelled'].includes(r.status) && n !== null && n < 0 && 'text-t-red font-medium')}>{fdate(r.status === 'Closed' ? r.closed_on : r.closing_date)}</span> : null; }, value: r => r.closed_on ?? r.closing_date },
    { key: 'checklist', label: 'Checklist', value: progress, render: r => <span className="inline-flex items-center gap-2"><span className="w-14 h-1.5 rounded-full bg-surface-3 overflow-hidden"><span className="block h-full bg-good rounded-full" style={{ width: `${progress(r)}%` }} /></span><span className="tnum text-xs text-fg-3">{progress(r)}%</span></span> },
    { key: 'days', label: 'Days open', align: 'right', value: r => (r.status === 'Closed' ? null : daysSince(r.created_at)) }, { key: 'title_company', label: 'Title company' }, { key: 'coordinator', label: 'Coordinator', value: r => name(r.coordinator_id) },
  ];
  const t = d.transactions.find(x => x.id === open), canWrite = perms.write('transactions');
  const patch = (data: R, msg?: string) => t && w.patch('transactions', t.id, data).then(() => msg && toast.success(msg)).catch(toast.error);
  const toggle = (i: number) => t && patch({ checklist: (t.checklist as R[]).map((x, j) => (j === i ? { ...x, done: !x.done, done_at: !x.done ? new Date().toISOString() : null } : x)) });
  const close = async () => {
    if (!t) return;
    if (t.assignment_fee == null) { const v = await promptDialog({ title: 'Assignment fee', body: 'Enter the fee received at closing to record the revenue.', confirm: 'Continue', input: { label: 'Assignment fee ($)', required: true } }); if (!v || isNaN(Number(v.replace(/[$,]/g, '')))) return; await patch({ assignment_fee: Number(v.replace(/[$,]/g, '')) }); }
    if (await confirmDialog({ title: 'Close this transaction?', body: 'This records the assignment fee as revenue, closes the linked contracts and disposition, and moves the lead to Closed Won.', confirm: 'Close transaction' })) await patch({ status: 'Closed' }, 'Transaction closed and revenue recorded');
  };
  const contracts = t ? d.contracts.filter(x => x.transaction_id === t.id) : [], dispo = t && d.dispositions.find(x => x.transaction_id === t.id), rev = t && d.revenue.find(r => r.transaction_id === t.id);
  const open5 = d.transactions.filter(x => !['Closed', 'Cancelled'].includes(x.status));
  if (d.error) return <ErrorBox error={d.error} />;
  return (
    <div>
      <PageHeader title="Transactions" subtitle="Every deal from executed contract to closing, with its checklist, parties and documents.">
        {canWrite && <button className="btn btn-primary" onClick={() => setModal({})}><Plus size={14} />New transaction</button>}
      </PageHeader>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">{[['Open transactions', String(open5.length)], ['Projected fees (open)', money(open5.reduce((s, x) => s + (x.assignment_fee ?? 0), 0))], ['Closing in 7 days', String(open5.filter(x => { const n = daysTo(x.closing_date); return n !== null && n <= 7; }).length)], ['Closed (all time)', String(d.transactions.filter(x => x.status === 'Closed').length)]].map(([l, v]) => <div key={l} className="card p-3.5"><div className="text-xs text-fg-2">{l}</div><div className="mt-1 text-xl font-semibold tnum">{v}</div></div>)}</div>
      <DataTable rows={d.transactions} cols={cols} loading={d.loading} onRowClick={r => setOpen(r.id)} viewKey="transactions" exportName="transactions" initialSort={{ key: 'closing_date', dir: -1 }}
        filters={[{ key: 'status', label: 'Status', options: TXN_STATUSES.map(s => ({ value: s, label: s })), get: r => r.status }, { key: 'open', label: 'Show', options: [{ value: 'open', label: 'Open only' }, { value: 'done', label: 'Closed / cancelled' }], get: r => (['Closed', 'Cancelled'].includes(r.status) ? 'done' : 'open') }]}
        empty={<Empty icon={<FileText size={18} />} title="No transactions yet" body="A transaction opens automatically when a purchase agreement is fully executed." />} />
      <Drawer open={!!t} onClose={() => setOpen(null)} width={600} title={t ? `Transaction · ${p.get(t.property_id)?.address ?? ''}` : ''} actions={t && canWrite && <button className="btn btn-ghost btn-sm" onClick={() => setModal({ record: t })}><Pencil size={12} />Edit</button>}>
        {t && <div className="p-5 space-y-5">
          <div className="flex flex-wrap items-center gap-2"><StatusBadge value={t.status} /><Link className="link" to={`/properties/${t.property_id}`}>{propertyLabel(p.get(t.property_id))}</Link>{t.lead_id && <Link className="link" to={`/leads/${t.lead_id}`}>· Lead</Link>}{dispo && <Link className="link" to={`/dispositions/${dispo.id}`}>· Disposition</Link>}</div>
          <div className="grid grid-cols-3 gap-3">{[['Purchase price', money(t.purchase_price)], ['Buyer price', money(t.assignment_price)], ['Assignment fee', money(t.assignment_fee)]].map(([l, v]) => <div key={l} className="card p-3"><div className="text-[11px] text-fg-3">{l}</div><div className="font-semibold tnum text-base mt-0.5">{v}</div></div>)}</div>
          {canWrite && !['Closed', 'Cancelled'].includes(t.status) && <div className="flex flex-wrap items-end gap-2"><div><div className="label">Status</div><select className="input !w-56" value={t.status} onChange={e => (e.target.value === 'Closed' ? close() : patch({ status: e.target.value }, `Status: ${e.target.value}`))}>{TXN_STATUSES.map(s => <option key={s}>{s}</option>)}</select></div>
            <button className="btn btn-primary" onClick={close}><CheckCircle2 size={14} />Close & record fee</button>
            {!dispo && perms.write('dispositions') && <button className="btn" onClick={() => openAction({ type: 'record', entity: 'dispositions', defaults: { property_id: t.property_id, transaction_id: t.id, asking_price: (t.purchase_price ?? 0) + settings.analyzer.assignmentFee, status: 'Active' }, fields: ['asking_price', 'fee_target', 'summary', 'owner_id'], title: 'Start disposition campaign' })}><Megaphone size={14} />Start disposition</button>}</div>}
          {t.status === 'Closed' && <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-good/40 bg-good/5"><CheckCircle2 size={15} className="text-t-green" /><span>Closed {fdate(t.closed_on)}. {rev ? `Assignment fee of ${money(rev.amount)} recorded as revenue.` : ''}</span></div>}
          {!['Closed', 'Cancelled'].includes(t.status) && <Deadline label="Scheduled closing" date={t.closing_date} />}
          <KV rows={[['Seller', contactName(c.get(t.contact_id))], ['End buyer', b.get(t.buyer_id) ? <Link className="link" to={`/buyers/${t.buyer_id}`}>{b.get(t.buyer_id)!.name}</Link> : null], ['Title company', t.title_company], ['Title contact', t.title_contact], ['Coordinator', name(t.coordinator_id)], ['Opened', fdate(t.created_at)]]} />
          <div className="flex flex-wrap gap-x-8 gap-y-2">{([['emd_deposited', 'Our EMD deposited'], ['buyer_emd_received', 'Buyer EMD received']] as [string, string][]).map(([key, label]) => <label key={key} className="flex items-center gap-2"><Toggle checked={!!t[key]} disabled={!canWrite} onChange={v => patch({ [key]: v })} label={label} />{label}</label>)}</div>
          <div><div className="flex items-center justify-between mb-2"><div className="section-t">Closing checklist</div><span className="text-xs text-fg-3 tnum">{(t.checklist ?? []).filter((x: R) => x.done).length} of {(t.checklist ?? []).length} done</span></div>
            <div className="border border-line rounded-md divide-y divide-line">{(t.checklist as R[] ?? []).map((x, i) => <label key={i} className="flex items-center gap-3 px-3 min-h-9 py-1.5 cursor-pointer hover:bg-surface-2"><input type="checkbox" checked={!!x.done} disabled={!canWrite} onChange={() => toggle(i)} /><span className={cx('flex-1', x.done && 'line-through text-fg-3')}>{x.label}</span>{x.done_at && <span className="text-[11px] text-fg-3">{fdate(x.done_at)}</span>}</label>)}</div>
            {canWrite && <form className="mt-2 flex gap-2" onSubmit={e => { e.preventDefault(); if (item.trim()) { void patch({ checklist: [...(t.checklist ?? []), { label: item.trim(), done: false }] }); setItem(''); } }}><input className="input" placeholder="Add a checklist item" value={item} onChange={e => setItem(e.target.value)} /><button className="btn" disabled={!item.trim()}>Add</button></form>}</div>
          {contracts.length > 0 && <div><div className="section-t mb-2">Contracts</div><div className="border border-line rounded-md divide-y divide-line">{contracts.map(x => <Link key={x.id} to={`/contracts?open=${x.id}`} className="flex items-center gap-3 px-3 h-10 hover:bg-surface-2"><span className="font-medium flex-1">{x.type}</span><StatusBadge value={x.status} /></Link>)}</div></div>}
          <Attachments scope={{ transaction_id: t.id }} category="Title" title="Transaction documents" />
          {t.notes && <div><div className="section-t mb-1.5">Notes</div><div className="whitespace-pre-wrap text-fg-2">{t.notes}</div></div>}
          <div><div className="section-t mb-2">Activity</div><Timeline activities={history.rows} scope={{ transaction_id: t.id, lead_id: t.lead_id, property_id: t.property_id }} loading={history.loading} canNote={canWrite} /></div>
        </div>}
      </Drawer>
      {modal && <RecordModal entity="transactions" open onClose={() => setModal(null)} record={modal.record} exclude={['status', 'closed_on', ...(modal.record ? ['property_id'] : [])]} />}
    </div>
  );
}
