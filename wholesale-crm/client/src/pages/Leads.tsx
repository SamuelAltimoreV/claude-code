import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Calculator, CalendarPlus, ChevronLeft, FileUp, HandCoins, Mail, MessageSquare, MoreHorizontal, Pencil, Phone, Play, ShieldAlert, Sparkles, Square, Trash2, UserPlus, Users } from 'lucide-react';
import { contactName, propertyLabel } from '@shared/logic';
import { isTerminal, stageById } from '@shared/settings';
import { api, useBoot, useData, usePerms, useWrite, type R } from '@/lib/app';
import { ago, fdate, fdatetime, money, num, parseCsv } from '@/lib/format';
import { Badge, Card, confirmDialog, cx, Empty, ErrorBox, Field, KV, Loading, Menu, Modal, PageHeader, ScorePill, Spinner, StatusBadge, Tabs, toast, useBusy, UserChip } from '@/ui/core';
import { DataTable, type Col } from '@/ui/DataTable';
import { Combo, RecordModal, TagInput } from '@/ui/Form';
import { newTask, openAction } from '@/ui/actions';
import { Timeline } from '@/ui/Timeline';
import { Attachments, DemoMark, Row2, StageBadge, useNames, useStageChange } from '@/ui/shared';

export function LeadsPage() {
  const { settings, users } = useBoot();
  const d = useData('leads', 'contacts', 'properties', 'campaigns');
  const perms = usePerms(), w = useWrite(), nav = useNavigate(), name = useNames();
  const [importing, setImporting] = useState(false);
  const c = useMemo(() => new Map(d.contacts.map(x => [x.id, x])), [d.contacts]), p = useMemo(() => new Map(d.properties.map(x => [x.id, x])), [d.properties]);
  const cols: Col[] = [
    { key: 'seller', label: 'Seller', width: 220, value: r => contactName(c.get(r.contact_id)), render: r => <span className="flex items-center gap-2 min-w-0"><Row2 a={contactName(c.get(r.contact_id))} b={c.get(r.contact_id)?.phone} /><DemoMark r={r} />{c.get(r.contact_id)?.dnc && <Badge tone="red">DNC</Badge>}</span> },
    { key: 'property', label: 'Property', width: 240, value: r => propertyLabel(p.get(r.property_id)), render: r => (p.get(r.property_id) ? <Row2 a={p.get(r.property_id)!.address} b={[p.get(r.property_id)!.city, p.get(r.property_id)!.zip].filter(Boolean).join(' ')} /> : null) },
    { key: 'stage', label: 'Stage', value: r => stageById(settings, r.stage)?.name, render: r => <StageBadge id={r.stage} /> },
    { key: 'score', label: 'Score', render: r => <ScorePill score={r.score} /> },
    { key: 'motivation', label: 'Motivation', render: r => (r.motivation && r.motivation !== 'Unknown' ? <StatusBadge value={r.motivation} dot={false} /> : null) },
    { key: 'classification', label: 'Status', hidden: true },
    { key: 'source', label: 'Source' },
    { key: 'owner', label: 'Owner', value: r => name(r.owner_id), render: r => <UserChip name={name(r.owner_id)} /> },
    { key: 'asking_price', label: 'Asking', align: 'right', render: r => money(r.asking_price) },
    { key: 'est_fee', label: 'Proj. fee', align: 'right', render: r => money(r.est_fee), hidden: true },
    { key: 'next_follow_up', label: 'Next follow-up', render: r => (r.next_follow_up ? <span className={cx(r.next_follow_up < new Date().toISOString() && 'text-t-red font-medium')}>{ago(r.next_follow_up)}</span> : isTerminal(settings, r.stage) ? null : <span className="text-t-amber">None scheduled</span>) },
    { key: 'last_contact_at', label: 'Last contact', render: r => (r.last_contact_at ? ago(r.last_contact_at) : null) },
    { key: 'tags', label: 'Tags', value: r => r.tags, render: r => (r.tags?.length ? <span className="flex gap-1">{r.tags.slice(0, 2).map((t: string) => <Badge key={t}>{t}</Badge>)}{r.tags.length > 2 && <span className="text-fg-3">+{r.tags.length - 2}</span>}</span> : null), hidden: true },
    { key: 'timeline', label: 'Timeline', hidden: true }, { key: 'city', label: 'City', value: r => p.get(r.property_id)?.city, hidden: true },
    { key: 'created_at', label: 'Created', render: r => fdate(r.created_at) },
  ];
  const bulk = (sel: R[], clear: () => void) => {
    const run = async (body: R, label: string) => { try { const r = await w.bulk('leads', { ids: sel.map(s => s.id), ...body }); r.failed.length ? toast.error(`${r.ok} updated, ${r.failed.length} failed: ${r.failed[0].error}`) : toast.success(`${r.ok} lead${r.ok === 1 ? '' : 's'} ${label}`); clear(); } catch (e) { toast.error(e); } };
    return <>
      <Menu align="left" trigger={<button className="btn btn-sm"><UserPlus size={13} />Assign</button>} items={users.filter(u => u.status === 'active').map(u => ({ label: u.name, hint: u.role, onClick: () => run({ patch: { owner_id: u.id } }, `assigned to ${u.name}`) }))} />
      <Menu align="left" width={220} trigger={<button className="btn btn-sm">Move to stage</button>} items={settings.stages.filter(s => s.milestone !== 'dead' && s.milestone !== 'closed').map(s => ({ label: s.name, onClick: () => run({ patch: { stage: s.id } }, `moved to ${s.name}`) }))} />
      <Menu align="left" trigger={<button className="btn btn-sm">Add tag</button>} items={settings.tags.map(t => ({ label: t, onClick: () => run({ addTags: [t] }, `tagged "${t}"`) }))} />
      <Menu align="left" trigger={<button className="btn btn-sm">Set status</button>} items={settings.leadStatuses.map(t => ({ label: t, onClick: () => run({ patch: { classification: t } }, `set to ${t}`) }))} />
      {perms.del('leads') && <button className="btn btn-sm btn-danger" onClick={async () => { if (await confirmDialog({ title: `Delete ${sel.length} lead${sel.length === 1 ? '' : 's'}?`, body: 'Their timelines, notes and sequence enrollments are deleted. Sellers and properties are kept. This cannot be undone.', danger: true, confirm: 'Delete' })) run({ delete: true }, 'deleted'); }}><Trash2 size={13} />Delete</button>}
    </>;
  };
  if (d.error) return <ErrorBox error={d.error} />;
  return (
    <div>
      <PageHeader title="Leads" subtitle="Every motivated-seller lead, scored and ready to work.">
        {perms.write('leads') && <><button className="btn" onClick={() => setImporting(true)}><FileUp size={14} />Import CSV</button><button className="btn btn-primary" onClick={() => openAction({ type: 'lead' })}><UserPlus size={14} />New lead</button></>}
      </PageHeader>
      <DataTable rows={d.leads} cols={cols} loading={d.loading} onRowClick={r => nav(`/leads/${r.id}`)} viewKey="leads" exportName="leads" bulk={perms.write('leads') ? bulk : undefined} initialSort={{ key: 'score', dir: -1 }}
        filters={[
          { key: 'stage', label: 'Stage', options: settings.stages.map(s => ({ value: s.id, label: s.name })), get: r => r.stage },
          { key: 'owner', label: 'Owner', options: users.map(u => ({ value: u.id, label: u.name })), get: r => r.owner_id },
          { key: 'source', label: 'Source', options: settings.sources.map(s => ({ value: s, label: s })), get: r => r.source },
          { key: 'motivation', label: 'Motivation', options: ['High', 'Medium', 'Low', 'Unknown'].map(s => ({ value: s, label: s })), get: r => r.motivation ?? 'Unknown' },
          { key: 'tag', label: 'Tag', options: settings.tags.map(s => ({ value: s, label: s })), get: r => r.tags },
        ]}
        empty={<Empty icon={<Users size={18} />} title="No leads yet" body="Add your first motivated seller, or import a list from a CSV file." action={perms.write('leads') && <button className="btn btn-primary" onClick={() => openAction({ type: 'lead' })}>New lead</button>} />} />
      {importing && <ImportModal onClose={() => setImporting(false)} campaigns={d.campaigns} />}
    </div>
  );
}

const IMPORT_FIELDS: [string, string, RegExp][] = [
  ['first_name', 'First name', /^(first|fname|owner.?first)/i], ['last_name', 'Last name', /^(last|lname|surname|owner.?last)/i], ['name', 'Full name', /^(name|full.?name|owner|owner.?name|seller)$/i],
  ['phone', 'Phone', /^(phone|mobile|cell|phone.?1|primary.?phone)/i], ['phone2', 'Secondary phone', /(phone.?2|alt|secondary)/i], ['email', 'Email', /e-?mail/i],
  ['mailing_address', 'Mailing address', /mail.*(addr|street)/i], ['mailing_city', 'Mailing city', /mail.*city/i], ['mailing_state', 'Mailing state', /mail.*state/i], ['mailing_zip', 'Mailing ZIP', /mail.*zip/i],
  ['address', 'Property address', /^(address|property.?address|street|site.?address|prop.*addr)/i], ['city', 'Property city', /^(city|property.?city|site.?city)/i], ['state', 'Property state', /^(state|property.?state|st)$/i], ['zip', 'Property ZIP', /^(zip|zipcode|postal|property.?zip)/i], ['county', 'County', /county/i],
  ['property_type', 'Property type', /(prop.*type|^type$)/i], ['beds', 'Bedrooms', /bed/i], ['baths', 'Bathrooms', /bath/i], ['sqft', 'Square feet', /(sq.?ft|square|living.?area)/i], ['year_built', 'Year built', /year/i],
  ['est_value', 'Estimated value', /(value|avm|estimate)/i], ['mortgage_balance', 'Mortgage balance', /(mortgage|loan.?bal)/i], ['asking_price', 'Asking price', /asking/i], ['motivation', 'Motivation', /motivation/i], ['reason', 'Reason for selling', /reason/i], ['source', 'Lead source', /source/i], ['tags', 'Tags (separated by ;)', /tags?/i],
];

function ImportModal({ onClose, campaigns }: { onClose: () => void; campaigns: R[] }) {
  const { settings, users, user } = useBoot();
  const w = useWrite();
  const file = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<string[][] | null>(null), [map, setMap] = useState<Record<number, string>>({}), [opts, setOpts] = useState<R>({ source: '', campaign_id: null, owner_id: user.id, tags: [], allowDuplicates: false });
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null), [result, setResult] = useState<R | null>(null), [err, setErr] = useState('');
  const load = async (f?: File) => {
    if (!f) return; setErr('');
    if (f.size > 8 * 1024 * 1024) return setErr('That file is larger than 8 MB. Split it into smaller files.');
    const parsed = parseCsv(await f.text());
    if (parsed.length < 2) return setErr('The file needs a header row and at least one data row.');
    const m: Record<number, string> = {}; const used = new Set<string>();
    parsed[0].forEach((h, i) => { const hit = IMPORT_FIELDS.find(([k, , re]) => !used.has(k) && re.test(h.trim())); if (hit) { m[i] = hit[0]; used.add(hit[0]); } });
    setRows(parsed); setMap(m);
  };
  const mapped = Object.values(map), ready = rows && (mapped.includes('first_name') || mapped.includes('name'));
  const run = async () => {
    if (!rows) return;
    const data = rows.slice(1).map(r => { const o: R = {}; for (const [i, k] of Object.entries(map)) if (k && r[+i]?.trim()) o[k] = r[+i].trim(); return o; });
    const total = data.length, res = { created: 0, duplicates: 0, errors: [] as R[] };
    setProgress({ done: 0, total });
    try {
      for (let i = 0; i < total; i += 50) {
        const r = await api<R>('POST', '/api/import/leads', { rows: data.slice(i, i + 50), offset: i + 1, ...opts });
        res.created += r.created; res.duplicates += r.duplicates; res.errors.push(...r.errors); setProgress({ done: Math.min(i + 50, total), total });
      }
      setResult(res);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Import failed'); setResult(res.created ? res : null); } finally { setProgress(null); await w.refresh(); }
  };
  return (
    <Modal open onClose={onClose} size="lg" title="Import leads from CSV" footer={result ? <button className="btn btn-primary" onClick={onClose}>Done</button> : rows ? <><button className="btn" onClick={() => setRows(null)} disabled={!!progress}>Choose another file</button><button className="btn btn-primary" disabled={!ready || !!progress} onClick={run}>{progress ? <><Spinner />Importing {progress.done}/{progress.total}</> : `Import ${rows.length - 1} rows`}</button></> : undefined}>
      {result ? (
        <div><div className="grid grid-cols-3 gap-3">{[['Leads created', result.created], ['Duplicates merged', result.duplicates], ['Rows with errors', result.errors.length]].map(([l, v]) => <div key={l as string} className="card p-3"><div className="text-xs text-fg-2">{l}</div><div className="text-xl font-semibold tnum">{v}</div></div>)}</div>
          <p className="mt-3 text-fg-2">Duplicates (same phone, email or property address) were attached to the existing seller instead of creating a second record.</p>
          {result.errors.length > 0 && <div className="mt-3 max-h-48 overflow-auto scroll-thin border border-line rounded-md divide-y divide-line">{result.errors.map((e: R, i: number) => <div key={i} className="px-3 py-1.5 flex gap-3"><span className="text-fg-3 tnum w-16 shrink-0">Row {e.row + 1}</span><span>{e.error}</span></div>)}</div>}</div>
      ) : !rows ? (
        <div><input ref={file} type="file" accept=".csv,text/csv" hidden onChange={e => load(e.target.files?.[0])} />
          <button className="w-full border border-dashed border-line-strong rounded-lg py-10 flex flex-col items-center gap-2 hover:bg-surface-2" onClick={() => file.current?.click()}><FileUp size={22} className="text-fg-3" /><span className="font-medium">Choose a CSV file</span><span className="text-fg-3">First row must be column headers. You will map columns next.</span></button>
          {err && <div className="mt-3 text-t-red">{err}</div>}</div>
      ) : (
        <div className="space-y-4">
          <div><div className="section-t mb-2">Map columns</div><div className="border border-line rounded-md divide-y divide-line max-h-64 overflow-auto scroll-thin">{rows[0].map((h, i) => <div key={i} className="flex items-center gap-3 px-3 py-1.5"><div className="w-2/5 min-w-0"><div className="font-medium truncate">{h || `Column ${i + 1}`}</div><div className="text-[11px] text-fg-3 truncate">{rows[1]?.[i] || '—'}</div></div>
            <select className="input" value={map[i] ?? ''} onChange={e => setMap(m => ({ ...m, [i]: e.target.value }))}><option value="">Do not import</option>{IMPORT_FIELDS.map(([k, l]) => <option key={k} value={k} disabled={mapped.includes(k) && map[i] !== k}>{l}</option>)}</select></div>)}</div>
            {!ready && <div className="mt-2 text-t-amber">Map a column to First name or Full name to continue.</div>}</div>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Lead source for these leads"><select className="input" value={opts.source} onChange={e => setOpts({ ...opts, source: e.target.value })}><option value="">— (or use the mapped column)</option>{settings.sources.map(s => <option key={s}>{s}</option>)}</select></Field>
            <Field label="Campaign"><Combo value={opts.campaign_id} onChange={v => setOpts({ ...opts, campaign_id: v })} options={campaigns.map(c => ({ value: c.id, label: c.name }))} placeholder="None" /></Field>
            <Field label="Assign to"><Combo value={opts.owner_id} onChange={v => setOpts({ ...opts, owner_id: v })} options={users.filter(u => u.status === 'active').map(u => ({ value: u.id, label: u.name, sub: u.role }))} placeholder="Unassigned (automations can round-robin)" /></Field>
            <Field label="Tags"><TagInput value={opts.tags} onChange={v => setOpts({ ...opts, tags: v })} suggestions={settings.tags} /></Field>
          </div>
          <label className="flex items-center gap-2 text-fg-2"><input type="checkbox" checked={opts.allowDuplicates} onChange={e => setOpts({ ...opts, allowDuplicates: e.target.checked })} />Create new records even when a seller or property already exists (not recommended)</label>
          <p className="text-[11px] text-fg-3">Imported sellers have no SMS or email consent recorded. Automated texts and emails stay blocked for them until consent is captured.</p>
          {err && <div className="text-t-red">{err}</div>}
        </div>
      )}
    </Modal>
  );
}

export function LeadDetail() {
  const { id } = useParams();
  const { settings, providers } = useBoot();
  const d = useData('leads', 'contacts', 'properties', 'activities', 'tasks', 'offers', 'communications', 'enrollments', 'sequences', 'analyses', 'contracts', 'transactions', 'campaigns', 'suppressions');
  const perms = usePerms(), w = useWrite(), nav = useNavigate(), name = useNames(), changeStage = useStageChange();
  const [tab, setTab] = useState<'timeline' | 'tasks' | 'deal' | 'files'>('timeline'), [edit, setEdit] = useState<null | 'lead' | 'contact'>(null);
  const lead = d.leads.find(l => l.id === id);
  if (d.loading && !lead) return <Loading rows={10} />;
  if (!lead) return <Empty title="Lead not found" body="It may have been deleted, or it is assigned to someone else." action={<Link className="btn" to="/leads">Back to leads</Link>} />;
  const contact = d.contacts.find(c => c.id === lead.contact_id), property = d.properties.find(p => p.id === lead.property_id);
  const acts = d.activities.filter(a => a.lead_id === lead.id), tasks = d.tasks.filter(t => t.lead_id === lead.id).sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)));
  const offers = d.offers.filter(o => o.lead_id === lead.id), analyses = d.analyses.filter(a => a.lead_id === lead.id || (property && a.property_id === property.id));
  const contracts = d.contracts.filter(c => c.lead_id === lead.id), txn = d.transactions.find(t => t.lead_id === lead.id);
  const enrollment = d.enrollments.find(e => e.lead_id === lead.id && e.status === 'Active'), seq = d.sequences.find(s => s.id === enrollment?.sequence_id);
  const openTasks = tasks.filter(t => t.status === 'Open' || t.status === 'In Progress'), canWrite = perms.write('leads');
  const terminal = isTerminal(settings, lead.stage), blocked = !!contact?.dnc;
  const equity = property?.est_value != null && property?.mortgage_balance != null ? property.est_value - property.mortgage_balance : null;
  const del = async () => { if (await confirmDialog({ title: 'Delete this lead?', body: 'The lead, its timeline and notes are deleted permanently. The seller and property records are kept.', danger: true, confirm: 'Delete lead' })) { try { await w.remove('leads', lead.id); toast.success('Lead deleted'); nav('/leads'); } catch (e) { toast.error(e); } } };
  const enroll = async (sequenceId: string) => { try { await w.post(`/api/leads/${lead.id}/enroll`, { sequenceId }); toast.success('Follow-up sequence started'); } catch (e) { toast.error(e); } };
  return (
    <div>
      <Link to="/leads" className="inline-flex items-center gap-1 text-fg-3 hover:text-fg mb-3"><ChevronLeft size={14} />Leads</Link>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2"><h1 className="text-xl font-semibold tracking-tight">{contactName(contact)}</h1><DemoMark r={lead} />{blocked && <Badge tone="red"><ShieldAlert size={11} />Do not contact</Badge>}{lead.classification && !blocked && <Badge>{lead.classification}</Badge>}</div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-fg-2">{property ? <Link className="link" to={`/properties/${property.id}`}>{propertyLabel(property)}</Link> : <button className="link" onClick={() => setEdit('lead')}>Add a property</button>}<span>·</span><span>{lead.source ?? 'No source'}</span><span>·</span><span>Created {fdate(lead.created_at)}</span><span>·</span><UserChip name={name(lead.owner_id)} /></div>
        </div>
        {canWrite && <div className="flex flex-wrap items-center gap-2">
          <button className="btn" disabled={blocked} title={blocked ? 'Seller is marked Do Not Contact' : undefined} onClick={() => openAction({ type: 'call', lead_id: lead.id })}><Phone size={14} />Log call</button>
          <button className="btn" disabled={blocked} onClick={() => openAction({ type: 'message', kind: 'contacts', personId: lead.contact_id, lead_id: lead.id })}><MessageSquare size={14} />Message</button>
          <button className="btn" onClick={() => openAction({ type: 'followup', lead_id: lead.id })}><CalendarPlus size={14} />Follow-up</button>
          {property && perms.read('offers') && <Link className="btn" to={`/analyzer?property=${property.id}&lead=${lead.id}`}><Calculator size={14} />Analyze</Link>}
          <Menu trigger={<button className="btn btn-icon" aria-label="More actions"><MoreHorizontal size={15} /></button>} items={[
            { label: 'Edit lead', icon: <Pencil size={13} />, onClick: () => setEdit('lead') }, { label: 'Edit seller', icon: <Pencil size={13} />, onClick: () => setEdit('contact') },
            ...(property && perms.write('offers') ? [{ label: 'New offer', icon: <HandCoins size={13} />, onClick: () => openAction({ type: 'record', entity: 'offers', defaults: { property_id: property.id, lead_id: lead.id, status: 'Draft' }, exclude: ['parent_id', 'analysis_id', 'contact_id', 'lead_id'] }) }] : []),
            { label: 'New task', icon: <Square size={13} />, onClick: () => newTask({ lead_id: lead.id, property_id: lead.property_id }) },
            { label: '', divider: true }, ...(perms.del('leads') ? [{ label: 'Delete lead', icon: <Trash2 size={13} />, danger: true, onClick: del }] : []),
          ]} />
        </div>}
      </div>

      <div className="card px-4 py-3 mb-4 flex flex-wrap items-center gap-x-8 gap-y-3">
        <div><div className="text-[11px] text-fg-3 mb-1">Pipeline stage</div><select className="input !w-56 font-medium" value={lead.stage} disabled={!canWrite} onChange={e => changeStage(lead, e.target.value)} aria-label="Pipeline stage">{settings.stages.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
        <div><div className="text-[11px] text-fg-3 mb-1">Lead score</div><div className="h-8 flex items-center gap-2"><ScorePill score={lead.score} />{lead.score_detail?.band && <StatusBadge value={lead.score_detail.band} dot={false} />}</div></div>
        <div><div className="text-[11px] text-fg-3 mb-1">Next follow-up</div><div className={cx('h-8 flex items-center font-medium', !lead.next_follow_up && !terminal && 'text-t-amber', lead.next_follow_up && lead.next_follow_up < new Date().toISOString() && 'text-t-red')}>{lead.next_follow_up ? fdatetime(lead.next_follow_up) : terminal ? '—' : 'None scheduled'}</div></div>
        <div><div className="text-[11px] text-fg-3 mb-1">Last contact</div><div className="h-8 flex items-center">{lead.last_contact_at ? ago(lead.last_contact_at) : 'Never'}</div></div>
        <div><div className="text-[11px] text-fg-3 mb-1">Asking</div><div className="h-8 flex items-center tnum">{money(lead.asking_price)}</div></div>
        <div><div className="text-[11px] text-fg-3 mb-1">Est. equity</div><div className="h-8 flex items-center tnum">{money(equity)}</div></div>
        <div><div className="text-[11px] text-fg-3 mb-1">Projected fee</div><div className="h-8 flex items-center tnum">{money(txn?.assignment_fee ?? lead.est_fee)}</div></div>
      </div>
      {!terminal && !lead.next_follow_up && canWrite && <div className="mb-4 flex items-center gap-3 px-4 py-2.5 rounded-lg border border-warn/40 bg-warn/5"><CalendarPlus size={15} className="text-t-amber shrink-0" /><span className="flex-1">This lead has no follow-up scheduled. Leads without a next step are the ones that slip through the cracks.</span><button className="btn btn-sm" onClick={() => openAction({ type: 'followup', lead_id: lead.id })}>Schedule one</button></div>}

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px] gap-4 items-start">
        <div className="card min-w-0">
          <Tabs className="px-4" value={tab} onChange={setTab} tabs={[{ id: 'timeline', label: 'Timeline', count: acts.length }, { id: 'tasks', label: 'Tasks', count: openTasks.length }, { id: 'deal', label: 'Underwriting & offers', count: offers.length + analyses.length }, { id: 'files', label: 'Files' }]} />
          <div className="p-4">
            {tab === 'timeline' && <Timeline activities={acts} scope={{ lead_id: lead.id, property_id: lead.property_id }} loading={d.loading} canNote={canWrite} />}
            {tab === 'tasks' && <TaskList tasks={tasks} onNew={() => newTask({ lead_id: lead.id, property_id: lead.property_id })} />}
            {tab === 'deal' && <div className="space-y-5">
              <div><div className="flex items-center justify-between mb-2"><div className="section-t">Deal analyses</div>{property && <Link className="btn btn-sm" to={`/analyzer?property=${property.id}&lead=${lead.id}`}><Calculator size={12} />New analysis</Link>}</div>
                {analyses.length === 0 ? <div className="text-fg-3 py-3 text-center border border-dashed border-line rounded-md">{property ? 'No underwriting saved yet.' : 'Add a property to underwrite this deal.'}</div> : <div className="border border-line rounded-md divide-y divide-line">{analyses.map(a => <Link key={a.id} to={`/analyzer?property=${a.property_id}&lead=${lead.id}&analysis=${a.id}`} className="flex items-center gap-3 px-3 h-11 hover:bg-surface-2"><span className="font-medium flex-1 truncate">{a.name}</span><StatusBadge value={a.rating} /><span className="tnum text-fg-2">MAO {money(a.mao)}</span><span className="text-[11px] text-fg-3">{fdate(a.created_at)}</span></Link>)}</div>}</div>
              <div><div className="flex items-center justify-between mb-2"><div className="section-t">Offers</div>{property && perms.write('offers') && <button className="btn btn-sm" onClick={() => openAction({ type: 'record', entity: 'offers', defaults: { property_id: property.id, lead_id: lead.id, status: 'Draft' }, exclude: ['parent_id', 'analysis_id', 'contact_id', 'lead_id'] })}><HandCoins size={12} />New offer</button>}</div>
                {offers.length === 0 ? <div className="text-fg-3 py-3 text-center border border-dashed border-line rounded-md">No offers yet.</div> : <div className="border border-line rounded-md divide-y divide-line">{[...offers].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).map(o => <Link key={o.id} to={`/offers?open=${o.id}`} className="flex items-center gap-3 px-3 h-11 hover:bg-surface-2"><span className="font-medium tnum w-24">{money(o.amount)}</span><Badge tone={o.from_party === 'Seller' ? 'violet' : 'gray'}>{o.from_party === 'Seller' ? 'Seller counter' : 'Our offer'}</Badge><StatusBadge value={o.status} /><span className="flex-1" /><span className="text-[11px] text-fg-3">{fdate(o.offer_date)}</span></Link>)}</div>}</div>
              {(contracts.length > 0 || txn) && <div><div className="section-t mb-2">Contracts & transaction</div><div className="border border-line rounded-md divide-y divide-line">
                {contracts.map(c => <Link key={c.id} to={`/contracts?open=${c.id}`} className="flex items-center gap-3 px-3 h-11 hover:bg-surface-2"><span className="font-medium flex-1">{c.type}</span><StatusBadge value={c.status} /><span className="tnum text-fg-2">{money(c.type === 'Assignment Agreement' ? c.assignment_price : c.purchase_price)}</span></Link>)}
                {txn && <Link to={`/transactions?open=${txn.id}`} className="flex items-center gap-3 px-3 h-11 hover:bg-surface-2"><span className="font-medium flex-1">Transaction</span><StatusBadge value={txn.status} /><span className="text-fg-2">Closing {fdate(txn.closing_date)}</span></Link>}</div></div>}
            </div>}
            {tab === 'files' && <Attachments scope={{ lead_id: lead.id }} />}
          </div>
        </div>

        <div className="space-y-4 min-w-0">
          <Card title="Seller" actions={canWrite && <button className="btn btn-ghost btn-sm" onClick={() => setEdit('contact')}><Pencil size={12} />Edit</button>}>
            <KV rows={[['Phone', contact?.phone && <a className="link" href={`tel:${contact.phone}`}>{contact.phone}</a>], ['Secondary phone', contact?.phone2], ['Email', contact?.email && <a className="link break-all" href={`mailto:${contact.email}`}>{contact.email}</a>], ['Prefers', contact?.preferred_contact], ['Best time', contact?.best_time], ['Mailing address', [contact?.mailing_address, contact?.mailing_city, contact?.mailing_state, contact?.mailing_zip].filter(Boolean).join(', ')]]} />
            <div className="mt-3 pt-3 border-t border-line flex flex-wrap gap-1.5">
              {contact?.dnc ? <Badge tone="red">Do not contact</Badge> : <>
                <Badge tone={contact?.sms_opt_in ? 'green' : 'gray'} title={contact?.sms_opt_in_at ? `Consent recorded ${fdatetime(contact.sms_opt_in_at)}${contact.consent_source ? ` via ${contact.consent_source}` : ''}` : 'No SMS consent on file'}><MessageSquare size={10} />SMS {contact?.sms_opt_in ? 'consent' : 'no consent'}</Badge>
                <Badge tone={contact?.email_opt_in ? 'green' : 'gray'} title={contact?.email_opt_in_at ? `Consent recorded ${fdatetime(contact.email_opt_in_at)}` : 'No email consent on file'}><Mail size={10} />Email {contact?.email_opt_in ? 'consent' : 'no consent'}</Badge></>}
            </div>
          </Card>
          <Card title="Seller situation" actions={canWrite && <button className="btn btn-ghost btn-sm" onClick={() => setEdit('lead')}><Pencil size={12} />Edit</button>}>
            <KV rows={[['Motivation', lead.motivation && <StatusBadge value={lead.motivation} dot={false} />], ['Timeline', lead.timeline], ['Reason for selling', lead.reason], ['Negotiation', lead.negotiation], ['Decision authority', lead.decision_authority], ['Other decision-makers', lead.other_decision_makers]]} />
            {(lead.circumstances || lead.financial_situation) && <div className="mt-3 space-y-2">{lead.circumstances && <div><div className="text-[11px] text-fg-3">Circumstances</div><div className="whitespace-pre-wrap">{lead.circumstances}</div></div>}{lead.financial_situation && <div><div className="text-[11px] text-fg-3">Financial situation (as disclosed)</div><div className="whitespace-pre-wrap">{lead.financial_situation}</div></div>}</div>}
            {settings.customFields.leads.length > 0 && <div className="mt-3 pt-3 border-t border-line"><KV rows={settings.customFields.leads.map(f => [f.label, lead.custom?.[f.key] === true ? 'Yes' : lead.custom?.[f.key] === false ? 'No' : lead.custom?.[f.key]] as [string, any])} /></div>}
            {lead.tags?.length > 0 && <div className="mt-3 flex flex-wrap gap-1">{lead.tags.map((t: string) => <Badge key={t}>{t}</Badge>)}</div>}
            {lead.dead_reason && <div className="mt-3 text-t-red">Dead reason: {lead.dead_reason}</div>}
          </Card>
          {property && <Card title="Property" actions={<Link className="btn btn-ghost btn-sm" to={`/properties/${property.id}`}>Open</Link>}>
            <KV rows={[['Type', property.property_type], ['Bed / bath', property.beds || property.baths ? `${property.beds ?? '—'} / ${property.baths ?? '—'}` : null], ['Sq ft', property.sqft && num(property.sqft)], ['Year built', property.year_built], ['Condition', property.condition], ['Occupancy', property.occupancy], ['Est. value', money(property.est_value)], ['ARV', money(property.arv)], ['Repairs', money(property.repair_cost)], ['Mortgage', money(property.mortgage_balance)], ['Tax delinquent', property.tax_delinquent ? `Yes${property.tax_owed ? ` (${money(property.tax_owed)})` : ''}` : 'No'], ['Ownership', property.ownership_status]]} />
          </Card>}
          <Card title="Why this score">
            {lead.score_detail?.factors ? <div className="space-y-2.5">{(lead.score_detail.factors as R[]).map(f => <div key={f.key}><div className="flex items-baseline justify-between gap-2"><span className="font-medium">{f.label}</span><span className="tnum text-fg-2">{f.points}<span className="text-fg-3">/{f.max}</span></span></div><div className="h-1 rounded-full bg-surface-2 my-1 overflow-hidden"><div className="h-full rounded-full bg-accent" style={{ width: `${f.max ? (f.points / f.max) * 100 : 0}%` }} /></div><div className="text-[11px] text-fg-3 leading-snug">{f.reason}</div></div>)}
              <div className="pt-2 border-t border-line text-[11px] text-fg-3">Weights are configurable in Settings → Lead scoring.</div></div> : <div className="text-fg-3">Not scored yet.</div>}
          </Card>
          <Card title="Follow-up sequence">
            {enrollment && seq ? <div><div className="font-medium">{seq.name}</div><div className="text-fg-2 mt-0.5">Step {Math.min(enrollment.step_index + 1, seq.steps.length)} of {seq.steps.length} · next {enrollment.next_run_at ? ago(enrollment.next_run_at) : '—'}</div>
              {canWrite && <button className="btn btn-sm mt-2.5" onClick={() => w.post(`/api/enrollments/${enrollment.id}/stop`).then(() => toast.success('Sequence stopped')).catch(toast.error)}><Square size={12} />Stop sequence</button>}</div>
              : blocked ? <div className="text-fg-3">Sequences are blocked: seller is marked Do Not Contact.</div> : terminal ? <div className="text-fg-3">Lead is closed; sequences are not available.</div>
              : <div><div className="text-fg-2 mb-2">Not in a sequence. Sequences pause automatically when the seller replies, opts out or the lead closes.</div>
                {canWrite && <Menu align="left" width={280} trigger={<button className="btn btn-sm"><Play size={12} />Start a sequence</button>} items={d.sequences.filter(s => s.active).map(s => ({ label: s.name, onClick: () => enroll(s.id) }))} />}
                {(!providers.sms || !providers.email) && <div className="text-[11px] text-fg-3 mt-2">No {!providers.sms && !providers.email ? 'SMS or email' : !providers.sms ? 'SMS' : 'email'} provider is connected, so those steps become manual tasks.</div>}</div>}
          </Card>
          <AiSummary leadId={lead.id} />
        </div>
      </div>
      <RecordModal entity="leads" open={edit === 'lead'} onClose={() => setEdit(null)} record={lead} exclude={['contact_id', 'stage']} />
      <RecordModal entity="contacts" open={edit === 'contact'} onClose={() => setEdit(null)} record={contact} />
    </div>
  );
}

export function TaskList({ tasks, onNew, showLead }: { tasks: R[]; onNew?: () => void; showLead?: (t: R) => React.ReactNode }) {
  const w = useWrite(), name = useNames(), perms = usePerms();
  const now = new Date().toISOString();
  return <div>
    {onNew && perms.write('tasks') && <div className="flex justify-end mb-2"><button className="btn btn-sm" onClick={onNew}><CalendarPlus size={12} />New task</button></div>}
    {tasks.length === 0 ? <Empty title="No tasks" body="Create a task or schedule a follow-up so this never goes cold." /> : <ul className="border border-line rounded-md divide-y divide-line">{tasks.map(t => { const done = t.status === 'Done', overdue = !done && t.status !== 'Cancelled' && t.due_at && t.due_at < now; return (
      <li key={t.id} className="flex items-center gap-3 px-3 min-h-11 py-1.5">
        <input type="checkbox" className="shrink-0" checked={done} aria-label={`Mark "${t.title}" ${done ? 'not done' : 'done'}`} onChange={() => w.patch('tasks', t.id, { status: done ? 'Open' : 'Done' }).catch(toast.error)} />
        <button className="flex-1 min-w-0 text-left" onClick={() => openAction({ type: 'record', entity: 'tasks', record: t, exclude: ['offer_id', 'contract_id'] })}><span className={cx('block truncate font-medium', done && 'line-through text-fg-3')}>{t.title}</span><span className="block truncate text-[11px] text-fg-3">{[t.category, t.origin].filter(Boolean).join(' · ')}{showLead?.(t)}</span></button>
        {t.priority && t.priority !== 'Normal' && !done && <StatusBadge value={t.priority} dot={false} />}
        <span className={cx('text-xs whitespace-nowrap', overdue ? 'text-t-red font-medium' : 'text-fg-3')}>{t.due_at ? (done ? fdate(t.due_at) : ago(t.due_at)) : 'No due date'}</span>
        <UserChip name={name(t.assignee_id)?.split(' ')[0]} />
      </li>); })}</ul>}
  </div>;
}

function AiSummary({ leadId }: { leadId: string }) {
  const { providers } = useBoot();
  const [data, setData] = useState<R | null>(null);
  const { busy, run } = useBusy();
  return (
    <Card title={<span className="inline-flex items-center gap-1.5"><Sparkles size={13} />AI lead summary</span>} actions={providers.ai && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(async () => setData(await api('POST', '/api/ai/lead-summary', { leadId })))}>{busy ? <Spinner size={12} /> : null}{data ? 'Regenerate' : 'Generate'}</button>}>
      {!providers.ai ? <div className="text-fg-3">The AI assistant is not connected. Add an Anthropic API key under <Link className="link" to="/integrations">Integrations</Link> to summarize this lead's full history on demand.</div>
        : busy ? <div className="flex items-center gap-2 text-fg-3"><Spinner />Reading this lead's history…</div>
        : !data ? <div className="text-fg-3">Generates a summary of motivation, condition, price, timeline, objections and recommended next steps from this lead's records. Nothing is changed without your approval.</div>
        : <div className="space-y-3">
          <p className="leading-relaxed">{data.summary}</p>
          <KV rows={[['Motivation', data.motivation], ['Condition', data.property_condition], ['Asking price', data.asking_price], ['Timeline', data.timeline], ['Sentiment', data.seller_sentiment]]} />
          {data.objections?.length > 0 && <div><div className="text-[11px] text-fg-3 mb-1">Objections</div><ul className="list-disc ml-4 space-y-0.5">{data.objections.map((o: string, i: number) => <li key={i}>{o}</li>)}</ul></div>}
          {data.missing_information?.length > 0 && <div><div className="text-[11px] text-fg-3 mb-1">Missing information</div><ul className="list-disc ml-4 space-y-0.5">{data.missing_information.map((o: string, i: number) => <li key={i}>{o}</li>)}</ul></div>}
          {data.next_steps?.length > 0 && <div><div className="text-[11px] text-fg-3 mb-1">Suggested next steps (create the ones you agree with)</div><div className="space-y-1.5">{data.next_steps.map((s: R, i: number) => <div key={i} className="flex items-start gap-2 p-2 rounded-md border border-line"><div className="flex-1 min-w-0"><div className="font-medium">{s.title}</div><div className="text-[11px] text-fg-3">{s.why}</div></div>
            <button className="btn btn-sm shrink-0" onClick={() => newTask({ title: s.title, category: s.category, lead_id: leadId, due_at: new Date(Date.now() + (s.due_in_days ?? 1) * 864e5).toISOString() })}>Create task</button></div>)}</div></div>}
          <div className="text-[11px] text-fg-3">Generated {ago(data.generated_at)} from {data.based_on.conversations} conversation(s) and {data.based_on.activities} timeline entries. AI output can be wrong — verify against the timeline.</div>
        </div>}
    </Card>
  );
}
