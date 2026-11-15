import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, HandCoins, Info, Plus, Save, Sparkles, Trash2, XCircle } from 'lucide-react';
import { analyzeDeal, compStats, dealChecks, defaultInputs, type DealInputs } from '@shared/calc';
import { contactName, matchBuyer, propertyLabel } from '@shared/logic';
import { api, useBoot, useData, usePerms, useWrite, type R } from '@/lib/app';
import { fdate, money, num, pct } from '@/lib/format';
import { Card, cx, Field, Loading, PageHeader, promptDialog, Segmented, Spinner, StatusBadge, toast, useBusy } from '@/ui/core';
import { Combo, RecordModal } from '@/ui/Form';

function Num({ label, value, onChange, prefix, suffix, help }: { label: string; value: number | undefined; onChange: (v: number) => void; prefix?: string; suffix?: string; help?: string }) {
  const [text, setText] = useState(value ? String(value) : '');
  useEffect(() => { if (Number(text || 0) !== (value ?? 0)) setText(value ? String(value) : ''); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return <Field label={label} help={help}><div className="relative">{prefix && <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-3">{prefix}</span>}
    <input inputMode="decimal" className={cx('input tnum', prefix && 'pl-5', suffix && 'pr-7')} value={text} placeholder="0" onChange={e => { const t = e.target.value.replace(/[^0-9.]/g, ''); setText(t); onChange(Number(t) || 0); }} />
    {suffix && <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-3">{suffix}</span>}</div></Field>;
}

export default function Analyzer() {
  const { settings, providers } = useBoot();
  const cfg = settings.analyzer;
  const [sp, setSp] = useSearchParams();
  const d = useData('properties', 'leads', 'contacts', 'comps', 'analyses', 'markets', 'buyers', 'buyer_interests', 'transactions');
  const perms = usePerms(), w = useWrite();
  const propertyId = sp.get('property'), leadId = sp.get('lead'), analysisId = sp.get('analysis');
  const property = d.properties.find(p => p.id === propertyId), lead = d.leads.find(l => l.id === leadId) ?? d.leads.find(l => l.property_id === propertyId && !l.closed_at && !l.dead_at);
  const [i, setI] = useState<DealInputs>(() => defaultInputs(cfg)), [loaded, setLoaded] = useState<string | null>(null), [scratch, setScratch] = useState<R[]>([]), [comp, setComp] = useState<R | null | 'new'>(null), [offerOpen, setOfferOpen] = useState(false), [ai, setAi] = useState<R | null>(null);
  const { busy, run } = useBusy(), aiBusy = useBusy();
  const set = (p: Partial<DealInputs>) => setI(s => ({ ...s, ...p }));
  const saved = d.analyses.filter(a => a.property_id === propertyId).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

  // Prefill from the property/lead (or a saved scenario) whenever the selection changes.
  useEffect(() => {
    const key = `${propertyId}:${analysisId}`;
    if (loaded === key || d.loading) return;
    const a = d.analyses.find(x => x.id === analysisId);
    if (a) setI({ ...defaultInputs(cfg), ...a.inputs });
    else if (property) { const market = d.markets.find(m => m.id === property.market_id); setI(defaultInputs(cfg, { arv: property.arv ?? 0, repairs: property.repair_cost ?? 0, asking: lead?.asking_price ?? undefined, maoPct: market?.mao_pct ?? cfg.maoPct })); }
    else setI(defaultInputs(cfg));
    setLoaded(key); setAi(null);
  }, [propertyId, analysisId, d.loading]); // eslint-disable-line react-hooks/exhaustive-deps

  const comps = property ? d.comps.filter(c => c.property_id === property.id) : scratch;
  const stats = useMemo(() => compStats(comps as any, property?.sqft), [comps, property]);
  const r = useMemo(() => analyzeDeal(i, cfg.thresholds), [i, cfg]);
  const checks = useMemo(() => dealChecks(i, r, { sqft: property?.sqft, compCount: comps.length, impliedArv: stats.impliedArv, condition: property?.condition, yearBuilt: property?.year_built }), [i, r, property, comps.length, stats.impliedArv]);
  const matches = useMemo(() => (property && r.buyerMaxPrice > 0 ? d.buyers.map(b => ({ b, m: matchBuyer(b, { property, price: r.buyerMaxPrice, arv: i.arv, repairs: i.repairs }, { presented: 0, offers: 0, closed: d.transactions.filter(t => t.buyer_id === b.id && t.status === 'Closed').length }) })).filter(x => !x.m.disqualified && x.m.score >= 60).sort((a, b) => b.m.score - a.m.score) : []), [d.buyers, d.transactions, property, r.buyerMaxPrice, i.arv, i.repairs]);
  const scenarios = useMemo(() => { const base = [['Seller asking', i.asking], ['At MAO', Math.round(r.mao)], ['MAO − $5,000', Math.round(r.mao) - 5000], ['MAO − $10,000', Math.round(r.mao) - 10000], ['Your offer', i.offerPrice]] as [string, number | undefined][]; return base.filter(([, v]) => v && v > 0).map(([label, price]) => ({ label, price: price!, res: analyzeDeal({ ...i, offerPrice: price }, cfg.thresholds) })); }, [i, r.mao, cfg]);
  const purchase = Math.max(r.purchasePrice, 0), fee = Math.max(r.projectedFee, 0);
  const segs = [{ key: 'purchase', label: `Purchase (${r.purchaseBasis})`, v: purchase }, { key: 'fee', label: 'Assignment fee', v: fee }, { key: 'repairs', label: 'Repairs', v: i.repairs }, { key: 'costs', label: 'Buyer costs', v: r.buyerCosts.total }, { key: 'profit', label: 'Buyer profit', v: Math.max(r.investorProfit, 0) }];
  const segTotal = segs.reduce((s, x) => s + x.v, 0) || 1;
  const pick = (id: string | null) => { const n = new URLSearchParams(); if (id) n.set('property', id); setSp(n); };

  const save = () => run(async () => {
    if (!property) throw new Error('Choose a property to save this analysis to.');
    const name = await promptDialog({ title: 'Save deal analysis', confirm: 'Save', input: { label: 'Scenario name', required: true, initial: `Scenario ${saved.length + 1} — ${i.strategy === 'percent' ? `${i.maoPct}% rule` : 'cost-based'}` } });
    if (!name) return;
    const a = await w.create('analyses', { name, property_id: property.id, lead_id: lead?.id ?? null, inputs: i, results: r, rating: r.rating, mao: Math.round(r.mao), offer_price: i.offerPrice ?? null });
    if (property.arv !== i.arv || property.repair_cost !== i.repairs) await w.patch('properties', property.id, { arv: i.arv || null, repair_cost: i.repairs || null });
    if (lead && r.projectedFee > 0) await w.patch('leads', lead.id, { est_fee: Math.round(r.projectedFee) }).catch(() => {});
    toast.success('Analysis saved to the property' + (lead ? ' and lead' : '')); setLoaded(`${property.id}:${a.id}`); const n = new URLSearchParams(sp); n.set('analysis', a.id); setSp(n);
  });

  if (d.loading || loaded !== `${propertyId}:${analysisId}`) return <Loading rows={8} />;
  return (
    <div>
      <PageHeader title="Deal Analyzer" subtitle="Underwrite a wholesale deal, compare offer scenarios and save the result to the property and lead.">
        {perms.write('offers') && <><button className="btn" disabled={!property || r.rating === 'Incomplete'} onClick={() => setOfferOpen(true)}><HandCoins size={14} />Create offer</button><button className="btn btn-primary" disabled={busy || r.rating === 'Incomplete'} onClick={save}>{busy ? <Spinner /> : <Save size={14} />}Save analysis</button></>}
      </PageHeader>
      <div className="grid grid-cols-1 xl:grid-cols-[440px_minmax(0,1fr)] gap-4 items-start">
        <div className="space-y-4">
          <Card title="Property">
            <Combo value={propertyId} onChange={pick} options={d.properties.map(p => ({ value: p.id, label: propertyLabel(p), sub: [p.property_type, p.sqft && `${num(p.sqft)} sq ft`].filter(Boolean).join(' · ') }))} placeholder="Choose a property (or analyze without saving)" />
            {property && <div className="mt-2 text-fg-2 text-xs">{[property.property_type, property.beds && `${property.beds} bd`, property.baths && `${property.baths} ba`, property.sqft && `${num(property.sqft)} sq ft`, property.year_built && `built ${property.year_built}`, property.condition && `${property.condition} condition`].filter(Boolean).join(' · ')}{lead && <> · Lead: <Link className="link" to={`/leads/${lead.id}`}>{contactName(d.contacts.find(c => c.id === lead.contact_id))}</Link></>}</div>}
            {saved.length > 0 && <div className="mt-3"><div className="label">Saved scenarios</div><div className="flex flex-wrap gap-1.5">{saved.map(a => <button key={a.id} className={cx('btn btn-sm', analysisId === a.id && '!border-accent !text-accent-text')} onClick={() => { const n = new URLSearchParams(sp); n.set('analysis', a.id); setSp(n); }}>{a.name}</button>)}</div></div>}
          </Card>
          <Card title="Deal numbers">
            <div className="grid grid-cols-2 gap-3">
              <Num label="Estimated ARV" prefix="$" value={i.arv} onChange={v => set({ arv: v })} help={stats.impliedArv ? `Comps imply ${money(stats.impliedArv)}` : undefined} />
              <Num label="Estimated repairs" prefix="$" value={i.repairs} onChange={v => set({ repairs: v })} help={property?.sqft && i.repairs ? `${money(i.repairs / property.sqft)}/sq ft` : undefined} />
              <Num label="Seller asking price" prefix="$" value={i.asking} onChange={v => set({ asking: v || undefined })} />
              <Num label="Desired assignment fee" prefix="$" value={i.assignmentFee} onChange={v => set({ assignmentFee: v })} />
              <Num label="Your offer (optional)" prefix="$" value={i.offerPrice} onChange={v => set({ offerPrice: v || undefined })} help="Projections use your offer, else asking, else MAO" />
              <Num label="Additional expenses" prefix="$" value={i.additional} onChange={v => set({ additional: v })} />
            </div>
          </Card>
          <Card title="Underwriting strategy" actions={<Segmented value={i.strategy} onChange={v => set({ strategy: v })} options={[{ id: 'percent', label: '% of ARV rule' }, { id: 'cost', label: 'Cost-based' }]} />}>
            {i.strategy === 'percent' ? <div>
              <div className="grid grid-cols-2 gap-3 items-end"><Num label="Offer percentage of ARV" suffix="%" value={i.maoPct} onChange={v => set({ maoPct: v })} /><div className="text-[11px] text-fg-3 leading-snug pb-1">MAO = (ARV × {i.maoPct}%) − repairs − assignment fee</div></div>
              <div className="mt-3"><div className="label">Presets (edit in Settings)</div><div className="flex flex-wrap gap-1.5">{cfg.presets.map(p => <button key={p.name} title={p.note} className={cx('btn btn-sm', i.maoPct === p.maoPct && '!border-accent !text-accent-text')} onClick={() => set({ maoPct: p.maoPct })}>{p.name}</button>)}</div></div>
              <p className="mt-3 text-[11px] text-fg-3 leading-relaxed">No single percentage fits every market. Lower it for heavy rehabs, slow areas and higher-risk deals; raise it where buyers compete or for rental buyers. The buyer cost assumptions below are used to show what margin this leaves your end buyer.</p>
            </div> : <div><Num label="End buyer's required profit" suffix="% ARV" value={i.investorMarginPct} onChange={v => set({ investorMarginPct: v })} /><p className="mt-2 text-[11px] text-fg-3 leading-relaxed">Works backwards from the ARV: subtracts repairs, the buyer's buying, holding, financing and selling costs and their required profit to find the most a buyer can pay. MAO is that price minus your fee.</p></div>}
            <div className="mt-4 pt-4 border-t border-line"><div className="section-t mb-2.5">End buyer's cost assumptions</div><div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <Num label="Purchase closing" suffix="%" value={i.buyerClosingPct} onChange={v => set({ buyerClosingPct: v })} /><Num label="Resale costs" suffix="%" value={i.sellingCostPct} onChange={v => set({ sellingCostPct: v })} help="Commissions + closing, % of ARV" /><Num label="Holding / month" prefix="$" value={i.holdingMonthly} onChange={v => set({ holdingMonthly: v })} />
              <Num label="Months held" value={i.holdingMonths} onChange={v => set({ holdingMonths: v })} /><Num label="Financed" suffix="%" value={i.loanPct} onChange={v => set({ loanPct: v })} help="0 = all cash" /><Num label="Interest rate" suffix="%" value={i.interestRate} onChange={v => set({ interestRate: v })} /><Num label="Points" suffix="%" value={i.points} onChange={v => set({ points: v })} /></div></div>
          </Card>
          <Card title="Comparable sales" actions={<><span className="text-[11px] text-fg-3">manually entered · unverified</span><button className="btn btn-sm" onClick={() => (property ? setComp('new') : setScratch(s => [...s, { id: crypto.randomUUID(), address: `Comp ${s.length + 1}`, sale_price: 0, sqft: 0 }]))}><Plus size={12} />Add</button></>} pad={false}>
            {comps.length === 0 ? <div className="p-5 text-center text-fg-3">Add sold comps to sanity-check the ARV.</div> : <table className="w-full"><thead><tr>{['Address', 'Price', 'Sq ft', '$/sq ft', ''].map(h => <th key={h} className="th">{h}</th>)}</tr></thead><tbody>{comps.map(c => property ? (
              <tr key={c.id} className="row cursor-pointer" onClick={() => setComp(c)}><td className="td font-medium" title={[c.sale_date && `Sold ${fdate(c.sale_date)}`, c.distance != null && `${c.distance} mi`, c.notes].filter(Boolean).join(' · ')}>{c.address}</td><td className="td tnum">{money(c.sale_price)}</td><td className="td tnum">{num(c.sqft)}</td><td className="td tnum">{c.sqft ? money(c.sale_price / c.sqft) : '—'}</td><td className="td w-8"><button className="text-fg-3 hover:text-t-red" aria-label="Delete comp" onClick={e => { e.stopPropagation(); w.remove('comps', c.id).catch(toast.error); }}><Trash2 size={13} /></button></td></tr>
            ) : (
              <tr key={c.id}><td className="td"><input className="input !h-7" value={c.address} onChange={e => setScratch(s => s.map(x => (x.id === c.id ? { ...x, address: e.target.value } : x)))} /></td><td className="td"><input className="input !h-7 tnum" inputMode="numeric" value={c.sale_price || ''} onChange={e => setScratch(s => s.map(x => (x.id === c.id ? { ...x, sale_price: Number(e.target.value.replace(/\D/g, '')) } : x)))} /></td><td className="td"><input className="input !h-7 tnum" inputMode="numeric" value={c.sqft || ''} onChange={e => setScratch(s => s.map(x => (x.id === c.id ? { ...x, sqft: Number(e.target.value.replace(/\D/g, '')) } : x)))} /></td><td className="td tnum">{c.sqft ? money(c.sale_price / c.sqft) : '—'}</td><td className="td w-8"><button className="text-fg-3 hover:text-t-red" aria-label="Delete comp" onClick={() => setScratch(s => s.filter(x => x.id !== c.id))}><Trash2 size={13} /></button></td></tr>))}</tbody></table>}
            {stats.avgPpsf && <div className="px-4 py-2.5 border-t border-line flex flex-wrap items-center justify-between gap-2"><span className="text-fg-2">Average <b className="tnum">{money(stats.avgPpsf)}</b>/sq ft across {stats.usable} comp{stats.usable === 1 ? '' : 's'}{stats.impliedArv ? <> → implied ARV <b className="tnum">{money(stats.impliedArv)}</b></> : property ? ' (add subject square footage to imply an ARV)' : ''}</span>{stats.impliedArv && Math.round(stats.impliedArv) !== i.arv && <button className="btn btn-sm" onClick={() => set({ arv: Math.round(stats.impliedArv! / 500) * 500 })}>Use as ARV</button>}</div>}
          </Card>
        </div>

        <div className="space-y-4 min-w-0">
          <Card>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div><div className="text-xs text-fg-2">Maximum allowable offer</div><div className="text-3xl font-semibold tracking-tight tnum mt-0.5">{r.rating === 'Incomplete' ? '—' : money(r.mao)}</div><div className="mt-2"><StatusBadge value={r.rating} /></div></div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-8 gap-y-3">{[['Buyer purchase price', money(r.buyerMaxPrice)], ['Projected assignment fee', money(r.projectedFee)], ['Spread vs. asking', r.spreadVsAsking === null ? '—' : money(r.spreadVsAsking)], ['Buyer profit', money(r.investorProfit)], ['Buyer margin (of ARV)', pct(r.investorMarginPct, 1)], ['Buyer cash-on-cash', pct(r.investorRoiPct, 0)]].map(([l, v]) => <div key={l}><div className="text-[11px] text-fg-3">{l}</div><div className={cx('font-semibold tnum', r.rating !== 'Incomplete' && String(v).startsWith('-') && 'text-t-red')}>{r.rating === 'Incomplete' ? '—' : v}</div></div>)}</div>
            </div>
            <div className="mt-3 space-y-1">{r.reasons.map((t, n) => <div key={n} className="text-fg-2 leading-snug">{t}</div>)}</div>
          </Card>
          {r.rating !== 'Incomplete' && <Card title="Where the ARV goes" actions={<span className="text-[11px] text-fg-3 tnum">ARV {money(i.arv)}</span>}>
            <div className="flex h-7 gap-[2px] rounded overflow-hidden" role="img" aria-label="Deal breakdown">{segs.filter(s => s.v > 0).map(s => <div key={s.key} title={`${s.label}: ${money(s.v)} (${((s.v / segTotal) * 100).toFixed(0)}%)`} style={{ width: `${(s.v / segTotal) * 100}%`, background: `var(--s${segs.indexOf(s) + 1})` }} />)}</div>
            <div className="mt-3 grid grid-cols-2 sm:grid-cols-5 gap-3">{segs.map((s, n) => <div key={s.key}><div className="flex items-center gap-1.5 text-[11px] text-fg-3"><span className="w-2 h-2 rounded-sm" style={{ background: `var(--s${n + 1})` }} />{s.label}</div><div className="font-semibold tnum mt-0.5">{money(s.v)}</div><div className="text-[11px] text-fg-3 tnum">{i.arv ? pct((s.v / i.arv) * 100) : '—'} of ARV</div></div>)}</div>
            {r.investorProfit < 0 && <div className="mt-3 text-t-red">At this price the end buyer loses {money(-r.investorProfit)} — the numbers exceed the ARV.</div>}
            <div className="mt-3 pt-3 border-t border-line text-[11px] text-fg-3">Buyer costs: closing {money(r.buyerCosts.closing)} · resale {money(r.buyerCosts.selling)} · holding {money(r.buyerCosts.holding)} · financing {money(r.buyerCosts.financing)} · other {money(r.buyerCosts.additional)}</div>
          </Card>}
          {scenarios.length > 0 && <Card title="Offer scenarios" actions={<span className="text-[11px] text-fg-3">how each offer price changes your profit</span>} pad={false}>
            <div className="overflow-x-auto"><table className="w-full"><thead><tr>{['Scenario', 'Offer to seller', 'Buyer pays', 'Your assignment fee', 'Vs. target', 'Rating', ''].map(h => <th key={h} className="th">{h}</th>)}</tr></thead><tbody>{scenarios.map(s => <tr key={s.label} className="row"><td className="td font-medium">{s.label}</td><td className="td tnum">{money(s.price)}</td><td className="td tnum">{money(s.res.buyerMaxPrice)}</td><td className={cx('td tnum font-medium', s.res.projectedFee < 0 && 'text-t-red')}>{money(s.res.projectedFee)}</td><td className="td tnum text-fg-2">{money(s.res.projectedFee - i.assignmentFee)}</td><td className="td"><StatusBadge value={s.res.rating} /></td><td className="td text-right">{s.label !== 'Your offer' && <button className="btn btn-ghost btn-sm" onClick={() => set({ offerPrice: s.price })}>Use</button>}</td></tr>)}</tbody></table></div>
          </Card>}
          {saved.length > 1 && <Card title="Saved scenario comparison" pad={false}><div className="overflow-x-auto"><table className="w-full"><thead><tr>{['Scenario', 'Strategy', 'ARV', 'Repairs', 'MAO', 'Offer', 'Projected fee', 'Rating', 'Saved'].map(h => <th key={h} className="th">{h}</th>)}</tr></thead><tbody>{saved.map(a => <tr key={a.id} className={cx('row', analysisId === a.id && 'bg-accent-soft')}><td className="td font-medium">{a.name}</td><td className="td">{a.inputs?.strategy === 'cost' ? 'Cost-based' : `${a.inputs?.maoPct}% rule`}</td><td className="td tnum">{money(a.inputs?.arv)}</td><td className="td tnum">{money(a.inputs?.repairs)}</td><td className="td tnum">{money(a.mao)}</td><td className="td tnum">{money(a.offer_price)}</td><td className="td tnum">{money(a.results?.projectedFee)}</td><td className="td"><StatusBadge value={a.rating} /></td><td className="td text-fg-3">{fdate(a.created_at)}</td></tr>)}</tbody></table></div></Card>}
          <Card title="Underwriting checks" actions={<span className="text-[11px] text-fg-3">rule-based, not AI</span>}>
            {checks.length === 0 ? <div className="text-fg-2">No issues flagged by the standard checks.</div> : <ul className="space-y-2">{checks.map((c, n) => <li key={n} className="flex items-start gap-2">{c.level === 'risk' ? <XCircle size={15} className="text-t-red mt-0.5 shrink-0" /> : c.level === 'warn' ? <AlertTriangle size={15} className="text-t-amber mt-0.5 shrink-0" /> : <Info size={15} className="text-t-blue mt-0.5 shrink-0" />}<span className="leading-snug">{c.text}</span></li>)}</ul>}
          </Card>
          {property && perms.read('buyers') && <Card title="Likely buyers at this price" actions={<span className="text-[11px] text-fg-3 tnum">{matches.length} buyer{matches.length === 1 ? '' : 's'} score 60+</span>}>
            {matches.length === 0 ? <div className="text-fg-3">No buyers in your database match this deal at {money(r.buyerMaxPrice)}. That is a signal to re-check price or grow the buyer list for {property.city}.</div> : <div className="space-y-1.5">{matches.slice(0, 5).map(({ b, m }) => <Link key={b.id} to={`/buyers/${b.id}`} className="flex items-center gap-3 hover:bg-surface-2 rounded px-1 h-8"><span className="font-medium truncate flex-1">{b.name}</span><span className="text-xs text-fg-3 truncate hidden sm:inline">{m.reasons.filter(x => x.ok).slice(0, 2).map(x => x.text).join(' · ')}</span><span className="tnum font-medium">{m.score}</span></Link>)}</div>}
          </Card>}
          <Card title={<span className="inline-flex items-center gap-1.5"><Sparkles size={13} />AI deal review</span>} actions={providers.ai && r.rating !== 'Incomplete' && <button className="btn btn-ghost btn-sm" disabled={aiBusy.busy} onClick={() => aiBusy.run(async () => setAi(await api('POST', '/api/ai/deal-review', { inputs: i, results: r, propertyId: property?.id, comps, checks, matches: matches.slice(0, 8).map(x => ({ name: x.b.name, strategy: x.b.strategy, score: x.m.score })) })))}>{aiBusy.busy && <Spinner size={12} />}{ai ? 'Review again' : 'Review this deal'}</button>}>
            {!providers.ai ? <div className="text-fg-3">Not connected. Add an Anthropic API key under <Link className="link" to="/integrations">Integrations</Link> for a written second opinion on risks, missing information and negotiation angles. The rule-based checks above work without it.</div>
              : aiBusy.busy ? <div className="flex items-center gap-2 text-fg-3"><Spinner />Reviewing the numbers…</div> : ai ? <div><div className="whitespace-pre-wrap leading-relaxed">{ai.text}</div><div className="mt-2 text-[11px] text-fg-3">AI review is advisory and only sees the numbers on this page. It has no market data of its own.</div></div> : <div className="text-fg-3">Ask for a second opinion on this analysis. Nothing is saved or changed.</div>}
          </Card>
        </div>
      </div>
      {property && <RecordModal entity="comps" open={!!comp} onClose={() => setComp(null)} record={comp === 'new' ? null : comp} defaults={{ property_id: property.id }} exclude={['property_id']} size="md" />}
      {property && offerOpen && <RecordModal entity="offers" open onClose={() => setOfferOpen(false)} title={`New offer — ${property.address}`} fields={['amount', 'status', 'offer_date', 'expires_on', 'closing_date', 'emd', 'fee_target', 'method', 'notes']}
        defaults={{ property_id: property.id, lead_id: lead?.id ?? null, analysis_id: analysisId ?? null, amount: Math.round(i.offerPrice || Math.min(r.mao, i.asking || r.mao)), fee_target: i.assignmentFee, status: 'Draft', from_party: 'Us', emd: 1000 }} />}
    </div>
  );
}
