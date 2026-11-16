// Cross-page building blocks: stage badge + stage change flow, drill-down modal, attachments panel.
import { useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Download, FileText, Paperclip, Trash2, Upload } from 'lucide-react';
import { contactName } from '@shared/logic';
import { stageById } from '@shared/settings';
import { api, ApiError, useBoot, useData, usePerms, useWrite, type R } from '@/lib/app';
import { ago, fdate, money } from '@/lib/format';
import { Badge, confirmDialog, DemoTag, Empty, Modal, promptDialog, Spinner, toast } from './core';
import { DataTable, type Col } from './DataTable';

export function StageBadge({ id }: { id?: string | null }) {
  const { settings } = useBoot();
  const s = stageById(settings, id);
  if (!s) return <span className="muted">—</span>;
  return <span className="badge" style={{ ['--bc' as any]: s.color, ['--bt' as any]: 'var(--fg)' }}><span className="w-1.5 h-1.5 rounded-full" style={{ background: s.color }} />{s.name}</span>;
}

/** Moves a lead to a stage, collecting anything the stage's transition rules require. */
export function useStageChange() {
  const w = useWrite();
  const { settings } = useBoot();
  return async (lead: R, stageId: string): Promise<boolean> => {
    if (lead.stage === stageId) return false;
    const st = stageById(settings, stageId);
    const patch: R = { stage: stageId };
    if (st?.milestone === 'dead') {
      const reason = await promptDialog({ title: `Mark lead as ${st.name}?`, body: 'The lead keeps its full history and can be revived later. Active follow-up sequences will stop.', confirm: `Move to ${st.name}`, danger: true, input: { label: 'Reason (required)', required: true, placeholder: 'e.g. Sold to another buyer, no equity, unrealistic price' } });
      if (!reason) return false;
      patch.dead_reason = reason;
    } else if (st?.milestone === 'closed' && !(await confirmDialog({ title: `Move to ${st.name}?`, body: 'This marks the deal as won. Normally this happens automatically when its transaction is closed and the assignment fee is recorded.', confirm: 'Move lead' }))) return false;
    try { await w.patch('leads', lead.id, patch); toast.success(`Moved to ${st?.name ?? stageId}`); return true; }
    catch (e) { toast.error(e instanceof ApiError && e.status === 422 ? `${e.message} Open the lead to add the missing details.` : e); return false; }
  };
}

export function useNames() {
  const { users } = useBoot();
  const m = new Map(users.map(u => [u.id, u.name as string]));
  return (id?: string | null) => (id ? m.get(id) ?? null : null);
}

export type DrillKind = 'leads' | 'revenue' | 'tasks' | 'offers' | 'transactions' | 'dispositions';
export interface Drill { title: string; kind: DrillKind; rows: R[] }
/** Shows the records behind a dashboard number. */
export function DrillModal({ drill, onClose }: { drill: Drill | null; onClose: () => void }) {
  const d = useData('contacts', 'properties', 'leads');
  const name = useNames();
  if (!drill) return null;
  const c = new Map(d.contacts.map(x => [x.id, x])), p = new Map(d.properties.map(x => [x.id, x])), l = new Map(d.leads.map(x => [x.id, x]));
  const leadLink = (lead?: R) => (lead ? <Link className="link" to={`/leads/${lead.id}`} onClick={onClose}>{contactName(c.get(lead.contact_id))}</Link> : null);
  const cols: Record<DrillKind, Col[]> = {
    leads: [{ key: 'seller', label: 'Seller', value: r => contactName(c.get(r.contact_id)), render: r => leadLink(r) }, { key: 'property', label: 'Property', value: r => p.get(r.property_id)?.address }, { key: 'stage', label: 'Stage', render: r => <StageBadge id={r.stage} /> }, { key: 'score', label: 'Score', align: 'right' }, { key: 'source', label: 'Source' }, { key: 'owner', label: 'Owner', value: r => name(r.owner_id) }, { key: 'created_at', label: 'Created', render: r => fdate(r.created_at) }],
    revenue: [{ key: 'date', label: 'Date', render: r => fdate(r.date) }, { key: 'property', label: 'Property', value: r => r.property?.address }, { key: 'seller', label: 'Seller', value: r => contactName(c.get(r.lead?.contact_id)), render: r => leadLink(r.lead) }, { key: 'source', label: 'Lead source' }, { key: 'owner', label: 'Acquisition rep', value: r => name(r.ownerId) }, { key: 'amount', label: 'Assignment fee', align: 'right', render: r => money(r.amount) }],
    tasks: [{ key: 'title', label: 'Task' }, { key: 'due_at', label: 'Due', render: r => ago(r.due_at) }, { key: 'status', label: 'Status' }, { key: 'assignee', label: 'Assigned', value: r => name(r.assignee_id) }, { key: 'lead', label: 'Lead', value: r => contactName(c.get(l.get(r.lead_id)?.contact_id)), render: r => leadLink(l.get(r.lead_id)) }],
    offers: [{ key: 'property', label: 'Property', value: r => p.get(r.property_id)?.address }, { key: 'amount', label: 'Amount', align: 'right', render: r => money(r.amount) }, { key: 'status', label: 'Status' }, { key: 'offer_date', label: 'Date', render: r => fdate(r.offer_date) }, { key: 'lead', label: 'Lead', value: r => contactName(c.get(l.get(r.lead_id)?.contact_id)), render: r => leadLink(l.get(r.lead_id)) }],
    transactions: [{ key: 'property', label: 'Property', value: r => p.get(r.property_id)?.address, render: r => <Link className="link" to={`/transactions?open=${r.id}`} onClick={onClose}>{p.get(r.property_id)?.address}</Link> }, { key: 'status', label: 'Status' }, { key: 'closing_date', label: 'Closing', render: r => fdate(r.closing_date) }, { key: 'assignment_fee', label: 'Fee', align: 'right', render: r => money(r.assignment_fee) }],
    dispositions: [{ key: 'property', label: 'Property', value: r => p.get(r.property_id)?.address, render: r => <Link className="link" to={`/dispositions/${r.id}`} onClick={onClose}>{p.get(r.property_id)?.address}</Link> }, { key: 'status', label: 'Status' }, { key: 'asking_price', label: 'Asking', align: 'right', render: r => money(r.asking_price) }],
  };
  return <Modal open onClose={onClose} size="xl" title={<span>{drill.title} <span className="text-fg-3 font-normal tnum">· {drill.rows.length} record{drill.rows.length === 1 ? '' : 's'}</span></span>}>
    <div className="-mx-5 -my-4"><DataTable rows={drill.rows} cols={cols[drill.kind]} exportName={drill.title.toLowerCase().replace(/\W+/g, '-')} pageSize={25} empty={<Empty title="No records behind this number yet" />} /></div></Modal>;
}

/** File uploads tied to a record. Photos render as thumbnails. */
export function Attachments({ scope, category = 'Other', title = 'Documents', photos }: { scope: R; category?: string; title?: string; photos?: boolean }) {
  const { attachments } = useData('attachments');
  const perms = usePerms(), w = useWrite();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false), [cat, setCat] = useState(category);
  const [key, id] = Object.entries(scope)[0] as [string, string];
  const list = attachments.filter(a => a[key] === id && (photos ? a.category === 'Photo' : a.category !== 'Photo'));
  const upload = async (files: FileList | null) => {
    if (!files?.length) return; setBusy(true);
    try { for (const f of Array.from(files)) { const fd = new FormData(); fd.append('file', f); fd.append('category', photos ? 'Photo' : cat); fd.append(key, id); await api('POST', '/api/attachments', fd); } toast.success(`${files.length} file${files.length > 1 ? 's' : ''} uploaded`); }
    catch (e) { toast.error(e); } finally { setBusy(false); await w.refresh(); if (input.current) input.current.value = ''; }
  };
  const del = async (a: R) => { if (await confirmDialog({ title: 'Delete file?', body: a.name, danger: true, confirm: 'Delete' })) w.remove('attachments', a.id).catch(toast.error); };
  const canWrite = perms.write('properties');
  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-2"><div className="section-t">{title}</div>
        {canWrite && <div className="flex items-center gap-1.5">{!photos && <select className="input !h-7 !w-auto !text-xs" value={cat} onChange={e => setCat(e.target.value)} aria-label="Document category">{['Contract', 'Proof of Funds', 'Title', 'Inspection', 'Other'].map(c => <option key={c}>{c}</option>)}</select>}
          <input ref={input} type="file" multiple hidden accept={photos ? 'image/*' : '.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,image/*'} onChange={e => upload(e.target.files)} />
          <button className="btn btn-sm" disabled={busy} onClick={() => input.current?.click()}>{busy ? <Spinner size={12} /> : <Upload size={12} />}Upload</button></div>}</div>
      {list.length === 0 ? <div className="text-fg-3 py-3 text-center border border-dashed border-line rounded-md">{photos ? 'No photos yet' : 'No documents yet'}</div>
        : photos ? <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">{list.map(a => <div key={a.id} className="relative group aspect-[4/3] rounded-md overflow-hidden border border-line bg-surface-2"><a href={`/api/attachments/${a.id}/download?inline=1`} target="_blank" rel="noreferrer"><img src={`/api/attachments/${a.id}/download?inline=1`} alt={a.name} className="w-full h-full object-cover" loading="lazy" /></a>{canWrite && <button className="absolute top-1 right-1 w-6 h-6 rounded bg-black/60 text-white hidden group-hover:flex items-center justify-center" aria-label="Delete photo" onClick={() => del(a)}><Trash2 size={12} /></button>}</div>)}</div>
        : <ul className="divide-y divide-line border border-line rounded-md">{list.map(a => <li key={a.id} className="flex items-center gap-2.5 px-3 h-10"><FileText size={14} className="text-fg-3 shrink-0" /><span className="truncate flex-1" title={a.name}>{a.name}</span><Badge>{a.category}</Badge><span className="text-[11px] text-fg-3 tnum hidden sm:inline">{(a.size / 1024).toFixed(0)} KB · {fdate(a.created_at)}</span>
          <a className="btn btn-ghost btn-icon btn-sm" href={`/api/attachments/${a.id}/download`} aria-label={`Download ${a.name}`}><Download size={13} /></a>{canWrite && <button className="btn btn-ghost btn-icon btn-sm" aria-label="Delete" onClick={() => del(a)}><Trash2 size={13} /></button>}</li>)}</ul>}
    </div>
  );
}
export const DemoMark = ({ r }: { r: R }) => (r.is_demo ? <DemoTag /> : null);
export const Row2 = ({ a, b }: { a: ReactNode; b?: ReactNode }) => <span className="block min-w-0"><span className="block truncate font-medium">{a}</span>{b && <span className="block truncate text-[11px] text-fg-3">{b}</span>}</span>;
export { Paperclip };
