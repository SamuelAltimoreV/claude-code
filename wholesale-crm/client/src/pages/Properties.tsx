import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Calculator, ChevronLeft, Home, Megaphone, Pencil, Plus, Trash2 } from 'lucide-react';
import { compStats } from '@shared/calc';
import { contactName, propertyLabel } from '@shared/logic';
import { useBoot, useData, usePerms, useWrite, type R } from '@/lib/app';
import { fdate, money, num } from '@/lib/format';
import { Badge, Card, Collapse, confirmDialog, Empty, ErrorBox, KV, Loading, PageHeader, StatusBadge, toast } from '@/ui/core';
import { DataTable, type Col } from '@/ui/DataTable';
import { Combo, RecordModal } from '@/ui/Form';
import { openAction } from '@/ui/actions';
import { Timeline } from '@/ui/Timeline';
import { Attachments, DemoMark, Row2, StageBadge } from '@/ui/shared';

/** Motivated-seller indicators: explicit tags plus signals derived from the property record. */
export function signals(p: R): string[] {
  const s = new Set<string>(p.indicators ?? []);
  if (p.tax_delinquent) s.add('Tax delinquent');
  if (p.occupancy === 'Vacant') s.add('Vacant property');
  if (['Poor', 'Distressed'].includes(p.condition)) s.add('Distressed condition');
  if (p.ownership_status === 'Estate / Heirs') s.add('Inherited property');
  if (p.est_value && p.mortgage_balance != null && (p.est_value - p.mortgage_balance) / p.est_value >= 0.5) s.add('High equity');
  return [...s];
}

export function PropertiesPage() {
  const d = useData('properties', 'leads', 'markets');
  const perms = usePerms(), nav = useNavigate();
  const m = useMemo(() => new Map(d.markets.map(x => [x.id, x])), [d.markets]);
  const leadCount = useMemo(() => { const c = new Map<string, number>(); for (const l of d.leads) if (l.property_id) c.set(l.property_id, (c.get(l.property_id) ?? 0) + 1); return c; }, [d.leads]);
  const cols: Col[] = [
    { key: 'address', label: 'Address', width: 260, render: r => <span className="flex items-center gap-2"><Row2 a={r.address} b={[r.city, r.state, r.zip].filter(Boolean).join(', ')} /><DemoMark r={r} /></span> },
    { key: 'city', label: 'City', hidden: true }, { key: 'zip', label: 'ZIP', hidden: true }, { key: 'county', label: 'County' },
    { key: 'market', label: 'Market', value: r => m.get(r.market_id)?.name }, { key: 'property_type', label: 'Type' },
    { key: 'beds', label: 'Bd/Ba', value: r => (r.beds || r.baths ? `${r.beds ?? '—'}/${r.baths ?? '—'}` : null), noSort: true }, { key: 'sqft', label: 'Sq ft', align: 'right', render: r => num(r.sqft) },
    { key: 'condition', label: 'Condition' }, { key: 'occupancy', label: 'Occupancy', hidden: true },
    { key: 'signals', label: 'Seller signals', value: r => signals(r).length, render: r => { const s = signals(r); return s.length ? <span title={s.join(', ')}><Badge tone={s.length >= 3 ? 'red' : s.length === 2 ? 'amber' : 'gray'}>{s.length} signal{s.length > 1 ? 's' : ''}</Badge></span> : null; } },
    { key: 'est_value', label: 'Value', align: 'right', render: r => money(r.est_value) }, { key: 'arv', label: 'ARV', align: 'right', render: r => money(r.arv) }, { key: 'repair_cost', label: 'Repairs', align: 'right', render: r => money(r.repair_cost) },
    { key: 'equity', label: 'Equity', align: 'right', value: r => (r.est_value != null && r.mortgage_balance != null ? r.est_value - r.mortgage_balance : null), render: r => money(r.est_value != null && r.mortgage_balance != null ? r.est_value - r.mortgage_balance : null) },
    { key: 'leads', label: 'Leads', align: 'right', value: r => leadCount.get(r.id) ?? 0 }, { key: 'owner_name', label: 'Owner of record', hidden: true }, { key: 'parcel_id', label: 'Parcel', hidden: true },
  ];
  if (d.error) return <ErrorBox error={d.error} />;
  return (
    <div>
      <PageHeader title="Properties" subtitle="One record per property, linked to every seller, offer, contract and transaction that touches it.">
        {perms.write('properties') && <button className="btn btn-primary" onClick={() => openAction({ type: 'record', entity: 'properties' })}><Plus size={14} />New property</button>}
      </PageHeader>
      <DataTable rows={d.properties} cols={cols} loading={d.loading} onRowClick={r => nav(`/properties/${r.id}`)} viewKey="properties" exportName="properties"
        filters={[
          { key: 'market', label: 'Market', options: d.markets.map(x => ({ value: x.id, label: x.name })), get: r => r.market_id },
          { key: 'type', label: 'Type', options: [...new Set(d.properties.map(p => p.property_type).filter(Boolean))].map(x => ({ value: x, label: x })), get: r => r.property_type },
          { key: 'county', label: 'County', options: [...new Set(d.properties.map(p => p.county).filter(Boolean))].map(x => ({ value: x, label: x })), get: r => r.county },
          { key: 'city', label: 'City', options: [...new Set(d.properties.map(p => p.city).filter(Boolean))].sort().map(x => ({ value: x, label: x })), get: r => r.city },
          { key: 'sig', label: 'Signals', options: [{ value: '2', label: '2 or more signals' }, { value: '3', label: '3 or more signals' }], get: r => { const n = signals(r).length; return n >= 3 ? ['2', '3'] : n >= 2 ? ['2'] : []; } },
        ]}
        empty={<Empty icon={<Home size={18} />} title="No properties yet" body="Properties are created with leads, or you can add one directly." />} />
    </div>
  );
}

export function PropertyDetail() {
  const { id } = useParams();
  const { settings } = useBoot();
  const d = useData('properties', 'contacts', 'leads', 'offers', 'contracts', 'transactions', 'dispositions', 'buyer_interests', 'buyers', 'comps', 'analyses', 'activities', 'property_contacts', 'markets');
  const perms = usePerms(), w = useWrite(), nav = useNavigate();
  const [edit, setEdit] = useState(false), [comp, setComp] = useState<R | null | 'new'>(null), [addOwner, setAddOwner] = useState(false), [ownerPick, setOwnerPick] = useState<string | null>(null);
  const p = d.properties.find(x => x.id === id);
  if (d.loading && !p) return <Loading rows={10} />;
  if (!p) return <Empty title="Property not found" action={<Link className="btn" to="/properties">Back to properties</Link>} />;
  const c = new Map(d.contacts.map(x => [x.id, x]));
  const leads = d.leads.filter(l => l.property_id === p.id), offers = d.offers.filter(o => o.property_id === p.id), contracts = d.contracts.filter(o => o.property_id === p.id), txns = d.transactions.filter(o => o.property_id === p.id);
  const dispos = d.dispositions.filter(o => o.property_id === p.id), comps = d.comps.filter(o => o.property_id === p.id), analyses = d.analyses.filter(o => o.property_id === p.id);
  const owners = d.property_contacts.filter(o => o.property_id === p.id), interests = d.buyer_interests.filter(i => dispos.some(x => x.id === i.disposition_id));
  const stats = compStats(comps as any, p.sqft), sig = signals(p), canWrite = perms.write('properties');
  const equity = p.est_value != null && p.mortgage_balance != null ? p.est_value - p.mortgage_balance : null;
  const openDispo = dispos.find(x => ['Draft', 'Active', 'Buyer Selected'].includes(x.status)), openTxn = txns.find(t => !['Closed', 'Cancelled'].includes(t.status));
  const del = async () => { if (await confirmDialog({ title: 'Delete this property?', body: 'Comps, analyses, photos and documents for this property are deleted. Properties linked to leads, offers, contracts or transactions cannot be deleted.', danger: true, confirm: 'Delete property' })) { try { await w.remove('properties', p.id); toast.success('Property deleted'); nav('/properties'); } catch (e) { toast.error(e); } } };
  const List = ({ rows, empty, render }: { rows: R[]; empty: string; render: (r: R) => React.ReactNode }) => (rows.length ? <div className="border border-line rounded-md divide-y divide-line">{rows.map(r => <div key={r.id}>{render(r)}</div>)}</div> : <div className="text-fg-3 py-3 text-center border border-dashed border-line rounded-md">{empty}</div>);
  return (
    <div>
      <Link to="/properties" className="inline-flex items-center gap-1 text-fg-3 hover:text-fg mb-3"><ChevronLeft size={14} />Properties</Link>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div><div className="flex items-center gap-2"><h1 className="text-xl font-semibold tracking-tight">{p.address}</h1><DemoMark r={p} /></div>
          <div className="mt-1 text-fg-2">{[p.city, p.state, p.zip].filter(Boolean).join(', ')}{p.county && ` · ${p.county} County`}{d.markets.find(m => m.id === p.market_id) && ` · ${d.markets.find(m => m.id === p.market_id)!.name}`}</div>
          {sig.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{sig.map(s => <Badge key={s} tone={sig.length >= 3 ? 'red' : 'amber'}>{s}</Badge>)}</div>}</div>
        <div className="flex flex-wrap gap-2">
          {perms.read('offers') && <Link className="btn" to={`/analyzer?property=${p.id}${leads[0] ? `&lead=${leads[0].id}` : ''}`}><Calculator size={14} />Analyze deal</Link>}
          {perms.write('dispositions') && openTxn && !openDispo && <button className="btn" onClick={() => openAction({ type: 'record', entity: 'dispositions', defaults: { property_id: p.id, transaction_id: openTxn.id, asking_price: (openTxn.purchase_price ?? 0) + settings.analyzer.assignmentFee, status: 'Active' }, fields: ['asking_price', 'fee_target', 'summary', 'owner_id'], title: 'Start disposition campaign' })}><Megaphone size={14} />Start disposition</button>}
          {canWrite && <button className="btn" onClick={() => setEdit(true)}><Pencil size={14} />Edit</button>}
          {perms.del('properties') && <button className="btn btn-icon btn-danger" aria-label="Delete property" onClick={del}><Trash2 size={14} /></button>}
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">{[['Est. as-is value', money(p.est_value)], ['Estimated ARV', money(p.arv)], ['Estimated repairs', money(p.repair_cost)], ['Mortgage balance', money(p.mortgage_balance)], ['Estimated equity', money(equity)]].map(([l, v]) => <div key={l} className="card p-3.5"><div className="text-xs text-fg-2">{l}</div><div className="mt-1 text-lg font-semibold tnum">{v}</div></div>)}</div>
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px] gap-4 items-start">
        <div className="space-y-4 min-w-0">
          <Card title="Property details" actions={<span className="text-[11px] text-fg-3">Source: {p.data_source ?? 'Manual entry'} · not verified against public records</span>}>
            <KV cols={3} rows={[['Type', p.property_type], ['Bedrooms', p.beds], ['Bathrooms', p.baths], ['Square feet', p.sqft && num(p.sqft)], ['Lot size', p.lot_size && `${p.lot_size} ac`], ['Year built', p.year_built], ['Condition', p.condition], ['Occupancy', p.occupancy], ['Listing status', p.listing_status],
              ['Owner of record', p.owner_name], ['Ownership', p.ownership_status], ['Parcel ID', p.parcel_id], ['Tax delinquent', p.tax_delinquent ? 'Yes' : 'No'], ['Taxes owed', money(p.tax_owed)], ['Mortgage notes', p.mortgage_notes], ['Neighborhood', p.neighborhood],
              ...(settings.customFields.properties ?? []).map(f => [f.label, p.custom?.[f.key] === true ? 'Yes' : p.custom?.[f.key]] as [string, any])]} />
            {p.notes && <div className="mt-3 pt-3 border-t border-line whitespace-pre-wrap text-fg-2">{p.notes}</div>}
          </Card>
          <Card title="Photos & documents"><div className="space-y-5"><Attachments scope={{ property_id: p.id }} photos title="Photos" /><Attachments scope={{ property_id: p.id }} /></div></Card>
          <Card title="Comparable sales" actions={<>{stats.avgPpsf && <span className="text-[11px] text-fg-3 tnum">avg {money(stats.avgPpsf)}/sq ft{stats.impliedArv ? ` · implies ${money(stats.impliedArv)}` : ''}</span>}{canWrite && <button className="btn btn-sm" onClick={() => setComp('new')}><Plus size={12} />Add comp</button>}</>} pad={false}>
            {comps.length === 0 ? <div className="p-6 text-center text-fg-3">No comps yet. Add sold comparables to support the ARV.</div> : <div className="overflow-x-auto"><table className="w-full"><thead><tr>{['Address', 'Sale price', 'Sold', 'Sq ft', '$/sq ft', 'Bd/Ba', 'Dist.', 'Notes'].map(h => <th key={h} className="th">{h}</th>)}</tr></thead>
              <tbody>{comps.map(x => <tr key={x.id} className="row cursor-pointer" onClick={() => canWrite && setComp(x)}><td className="td font-medium">{x.address}</td><td className="td tnum">{money(x.sale_price)}</td><td className="td">{fdate(x.sale_date)}</td><td className="td tnum">{num(x.sqft)}</td><td className="td tnum">{x.sqft ? money(x.sale_price / x.sqft) : '—'}</td><td className="td">{x.beds ?? '—'}/{x.baths ?? '—'}</td><td className="td tnum">{x.distance != null ? `${x.distance} mi` : '—'}</td><td className="td text-fg-2">{x.notes}</td></tr>)}</tbody></table></div>}
            <div className="px-4 py-2 border-t border-line text-[11px] text-fg-3">Comps are entered manually and are not verified against MLS or public records.</div>
          </Card>
          <Card title="Property history"><Collapse title="Show all activity for this property" count={d.activities.filter(a => a.property_id === p.id).length} defaultOpen><Timeline activities={d.activities.filter(a => a.property_id === p.id)} scope={{ property_id: p.id }} loading={d.loading} canNote={canWrite} /></Collapse></Card>
        </div>
        <div className="space-y-4 min-w-0">
          <Card title="Sellers & ownership" actions={canWrite && <button className="btn btn-ghost btn-sm" onClick={() => setAddOwner(true)}><Plus size={12} />Link seller</button>}>
            <List rows={owners} empty="No sellers linked" render={o => <div className="flex items-center gap-2 px-3 h-10"><span className="font-medium truncate flex-1">{contactName(c.get(o.contact_id))}</span><Badge>{o.role}</Badge>{canWrite && <button className="btn btn-ghost btn-icon btn-sm" aria-label="Unlink" onClick={() => w.remove('property_contacts', o.id).catch(toast.error)}><Trash2 size={12} /></button>}</div>} />
            {addOwner && <div className="mt-2 flex gap-2"><div className="flex-1"><Combo value={ownerPick} onChange={setOwnerPick} options={d.contacts.filter(x => !owners.some(o => o.contact_id === x.id)).map(x => ({ value: x.id, label: contactName(x), sub: x.phone }))} placeholder="Choose a seller" /></div><button className="btn btn-primary" disabled={!ownerPick} onClick={() => w.create('property_contacts', { property_id: p.id, contact_id: ownerPick, role: 'Co-owner' }).then(() => { setAddOwner(false); setOwnerPick(null); }).catch(toast.error)}>Link</button></div>}
          </Card>
          <Card title="Leads"><List rows={leads} empty="No leads for this property" render={l => <Link to={`/leads/${l.id}`} className="flex items-center gap-2 px-3 h-10 hover:bg-surface-2"><span className="font-medium truncate flex-1">{contactName(c.get(l.contact_id))}</span><StageBadge id={l.stage} /></Link>} /></Card>
          <Card title="Deal analyses"><List rows={analyses} empty="No analyses saved" render={a => <Link to={`/analyzer?property=${p.id}&analysis=${a.id}`} className="flex items-center gap-2 px-3 h-10 hover:bg-surface-2"><span className="font-medium truncate flex-1">{a.name}</span><StatusBadge value={a.rating} /><span className="tnum text-fg-2">{money(a.mao)}</span></Link>} /></Card>
          <Card title="Offers"><List rows={offers} empty="No offers" render={o => <Link to={`/offers?open=${o.id}`} className="flex items-center gap-2 px-3 h-10 hover:bg-surface-2"><span className="font-medium tnum flex-1">{money(o.amount)}</span><span className="text-xs text-fg-3">{o.from_party === 'Seller' ? 'Seller' : 'Us'}</span><StatusBadge value={o.status} /></Link>} /></Card>
          <Card title="Contracts & transactions"><List rows={[...contracts.map(x => ({ ...x, _k: 'c' })), ...txns.map(x => ({ ...x, _k: 't' }))]} empty="Nothing under contract" render={x => <Link to={x._k === 'c' ? `/contracts?open=${x.id}` : `/transactions?open=${x.id}`} className="flex items-center gap-2 px-3 h-10 hover:bg-surface-2"><span className="font-medium truncate flex-1">{x._k === 'c' ? x.type : 'Transaction'}</span><StatusBadge value={x.status} /></Link>} /></Card>
          <Card title="Buyers on this deal"><List rows={interests} empty={dispos.length ? 'No buyers on the campaign yet' : 'Not in disposition'} render={i => <Link to={`/dispositions/${i.disposition_id}`} className="flex items-center gap-2 px-3 h-10 hover:bg-surface-2"><span className="font-medium truncate flex-1">{d.buyers.find(b => b.id === i.buyer_id)?.name ?? 'Buyer'}</span>{i.offer_amount && <span className="tnum text-fg-2">{money(i.offer_amount)}</span>}<StatusBadge value={i.status} /></Link>} /></Card>
        </div>
      </div>
      <RecordModal entity="properties" open={edit} onClose={() => setEdit(false)} record={p} />
      <RecordModal entity="comps" open={!!comp} onClose={() => setComp(null)} record={comp === 'new' ? null : comp} defaults={{ property_id: p.id }} exclude={['property_id']} size="md" title={comp === 'new' ? `Add comparable sale for ${propertyLabel(p)}` : 'Edit comparable sale'} />
    </div>
  );
}
