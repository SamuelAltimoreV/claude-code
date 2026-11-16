import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlarmClock, LayoutGrid } from 'lucide-react';
import * as M from '@shared/metrics';
import { contactName } from '@shared/logic';
import { stageById } from '@shared/settings';
import { useBoot, useDataset, usePerms, type R } from '@/lib/app';
import { ago, money, num, pct } from '@/lib/format';
import { Card, Loading, Menu, PageHeader, ScorePill, Stat } from '@/ui/core';
import { BarList, Funnel, TimeChart } from '@/ui/charts';
import { DrillModal, StageBadge, type Drill } from '@/ui/shared';

export const RANGES: [string, string][] = [['week', 'This week'], ['month', 'This month'], ['quarter', 'This quarter'], ['year', 'This year'], ['30d', 'Last 30 days'], ['90d', 'Last 90 days'], ['12m', 'Last 12 months'], ['all', 'All time']];
const WIDGETS: [string, string][] = [['finance', 'Financial metrics'], ['pipeline', 'Pipeline metrics'], ['performance', 'Performance metrics'], ['attention', 'Needs attention'], ['revenue', 'Revenue over time'], ['deals', 'Deals closed per month'], ['leads', 'Leads generated'], ['funnel', 'Pipeline conversion'], ['sources', 'Lead source performance'], ['fees', 'Assignment fee distribution'], ['team', 'Acquisition performance'], ['buyers', 'Buyer performance']];
const delta = (cur: number | null | undefined, prev: number | null | undefined) => (prev && cur !== null && cur !== undefined ? ((cur - prev) / Math.abs(prev)) * 100 : null);

export function useFilterBar() {
  const { users, settings } = useBoot();
  const [preset, setPreset] = useState('12m'), [f, setF] = useState<M.Filter>({}), [compare, setCompare] = useState(true);
  const range = useMemo(() => M.presetRange(preset), [preset]);
  const prev = useMemo(() => (compare ? M.previousRange(preset, range) : null), [preset, range, compare]);
  const filter = useMemo(() => ({ ...f, ...range }), [f, range]);
  const bar = (ds: M.Dataset) => <>
    <select className="input !w-auto" value={preset} onChange={e => setPreset(e.target.value)} aria-label="Date range">{RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
    <select className="input !w-auto max-w-[150px]" value={f.ownerId ?? ''} onChange={e => setF({ ...f, ownerId: e.target.value || undefined })} aria-label="Team member"><option value="">All team</option>{users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
    <select className="input !w-auto max-w-[150px]" value={f.source ?? ''} onChange={e => setF({ ...f, source: e.target.value || undefined })} aria-label="Lead source"><option value="">All sources</option>{settings.sources.map(s => <option key={s}>{s}</option>)}</select>
    {ds.campaigns.length > 0 && <select className="input !w-auto max-w-[150px]" value={f.campaignId ?? ''} onChange={e => setF({ ...f, campaignId: e.target.value || undefined })} aria-label="Campaign"><option value="">All campaigns</option>{ds.campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
    {ds.markets.length > 0 && <select className="input !w-auto max-w-[150px]" value={f.marketId ?? ''} onChange={e => setF({ ...f, marketId: e.target.value || undefined })} aria-label="Market"><option value="">All markets</option>{ds.markets.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
    {preset !== 'all' && <label className="inline-flex items-center gap-1.5 text-fg-2 whitespace-nowrap"><input type="checkbox" checked={compare} onChange={e => setCompare(e.target.checked)} />Compare to previous period</label>}
  </>;
  return { filter, prev: prev ? { ...f, ...prev } : null, range, preset, bar };
}

export default function Dashboard() {
  const { user, settings, users } = useBoot();
  const perms = usePerms();
  const { ds, loading } = useDataset();
  const fb = useFilterBar();
  const [drill, setDrill] = useState<Drill | null>(null);
  const [hidden, setHidden] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem('dash.hidden') ?? '[]'); } catch { return []; } });
  const toggle = (id: string) => setHidden(h => { const n = h.includes(id) ? h.filter(x => x !== id) : [...h, id]; try { localStorage.setItem('dash.hidden', JSON.stringify(n)); } catch { /* ignore */ } return n; });
  const show = (id: string) => !hidden.includes(id);
  const k = useMemo(() => M.kpis(ds, fb.filter, settings), [ds, fb.filter, settings]);
  const kp = useMemo(() => (fb.prev ? M.kpis(ds, fb.prev, settings) : null), [ds, fb.prev, settings]);
  const fin = useMemo(() => M.financials(ds, fb.filter), [ds, fb.filter]);
  const { from, to } = fb.range, chartFrom = fb.preset === 'all' ? (ds.leads.reduce((m, l) => (l.created_at < m ? l.created_at : m), to).slice(0, 10)) : from;
  const bucket = M.pickBucket(chartFrom, to);
  const revSeries = useMemo(() => { const cur = M.series(k.revenue.rows, 'date', r => r.amount, chartFrom, to, bucket); const pv = kp && fb.prev ? M.series(kp.revenue.rows, 'date', r => r.amount, fb.prev.from!, fb.prev.to!, bucket) : null; return cur.map((p, i) => ({ key: p.key, revenue: p.value, deals: 0, prev: pv?.[i]?.value ?? 0 })); }, [k, kp, chartFrom, to, bucket, fb.prev]);
  const dealSeries = useMemo(() => M.series(k.revenue.rows, 'date', () => 1, chartFrom, to, 'month'), [k, chartFrom, to]);
  const leadSeries = useMemo(() => { const cur = M.series(k.pipeline.created, 'created_at', () => 1, chartFrom, to, bucket); const pv = kp && fb.prev ? M.series(kp.pipeline.created, 'created_at', () => 1, fb.prev.from!, fb.prev.to!, bucket) : null; return cur.map((p, i) => ({ key: p.key, leads: p.value, prev: pv?.[i]?.value ?? 0 })); }, [k, kp, chartFrom, to, bucket, fb.prev]);
  const sources = useMemo(() => M.sourceStats(ds, fb.filter), [ds, fb.filter]);
  const team = useMemo(() => M.teamStats(ds, fb.filter).filter(t => t.revenue > 0 || t.contracts > 0 || t.leadsAssigned > 0), [ds, fb.filter]);
  const buyers = useMemo(() => M.buyerStats(ds).filter(b => b.closed > 0 || b.offers > 0).sort((a, b) => b.volume - a.volume || b.offers - a.offers), [ds]);
  const feeDist = useMemo(() => { const edges = [0, 5000, 10000, 15000, 20000, 30000]; return edges.map((lo, i) => { const hi = edges[i + 1] ?? Infinity; const rows = k.revenue.rows.filter(r => r.amount >= lo && r.amount < hi); return { key: hi === Infinity ? `$${lo / 1000}K+` : `$${lo / 1000}–${hi / 1000}K`, deals: rows.length, rows }; }); }, [k]);
  const leadsDrill = (title: string, rows: R[]) => () => setDrill({ title, kind: 'leads', rows });
  const c = useMemo(() => new Map(ds.contacts.map(x => [x.id, x])), [ds.contacts]);
  const now = new Date().toISOString();
  const myTasks = ds.tasks.filter(t => t.assignee_id === user.id && ['Open', 'In Progress'].includes(t.status) && t.due_at && t.due_at.slice(0, 10) <= now.slice(0, 10)).sort((a, b) => a.due_at.localeCompare(b.due_at));
  const attention = [...k.pipeline.needFollowUp].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 6);
  const P = k.pipeline, hasCmp = !!kp;
  if (loading) return <Loading rows={10} />;
  const cmp = hasCmp ? 'vs previous period' : undefined;
  return (
    <div className="space-y-4">
      <PageHeader title={`Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}, ${user.name.split(' ')[0]}`} subtitle="Every number below is calculated from your CRM records. Click one to see the records behind it.">
        {fb.bar(ds)}
        <Menu width={240} trigger={<button className="btn" title="Choose dashboard widgets"><LayoutGrid size={14} />Widgets</button>} items={WIDGETS.map(([id, label]) => ({ label: `${show(id) ? '●' : '○'}  ${label}`, onClick: () => toggle(id) }))} />
      </PageHeader>

      {show('finance') && perms.read('finance') && <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
        <Stat label="Revenue (period)" value={money(k.revenue.inRange)} delta={delta(k.revenue.inRange, kp?.revenue.inRange)} sub={cmp ?? `${k.revenue.deals} deals`} onClick={() => setDrill({ title: 'Revenue in period', kind: 'revenue', rows: k.revenue.rows })} />
        <Stat label="Revenue this month" value={money(k.revenue.month)} sub="calendar month" />
        <Stat label="Revenue this year" value={money(k.revenue.year)} sub="calendar year" />
        <Stat label="Total revenue" value={money(k.revenue.total)} sub="all time" />
        <Stat label="Projected revenue" value={money(k.revenue.projected)} sub={`${k.openTxns.length} open deals`} onClick={() => setDrill({ title: 'Open transactions (projected revenue)', kind: 'transactions', rows: k.openTxns })} />
        <Stat label="Avg assignment fee" value={money(k.revenue.avgFee)} delta={delta(k.revenue.avgFee, kp?.revenue.avgFee)} sub={cmp ?? 'profit per deal'} />
        <Stat label="Highest fee" value={money(k.revenue.maxFee)} sub="in period" />
        <Stat label="Net profit (period)" value={money(fin.net)} sub={`after ${money(fin.marketing + fin.operating, true)} expenses`} />
      </div>}

      {show('pipeline') && <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6 gap-3">
        <Stat label="Active leads" value={num(P.active.length)} sub="open right now" onClick={leadsDrill('Active leads', P.active)} />
        <Stat label="New leads" value={num(P.created.length)} delta={delta(P.created.length, kp?.pipeline.created.length)} sub={cmp ?? 'created in period'} onClick={leadsDrill('Leads created in period', P.created)} />
        <Stat label="Contacted" value={num(P.contacted.length)} sub="of new leads" onClick={leadsDrill('Leads contacted', P.contacted)} />
        <Stat label="Qualified" value={num(P.qualified.length)} delta={delta(P.qualified.length, kp?.pipeline.qualified.length)} sub={cmp ?? 'of new leads'} onClick={leadsDrill('Qualified leads', P.qualified)} />
        <Stat label="Need follow-up" value={num(P.needFollowUp.length)} sub="overdue or none set" invert onClick={leadsDrill('Leads needing follow-up', P.needFollowUp)} />
        <Stat label="Offers submitted" value={num(P.offers.length)} delta={delta(P.offers.length, kp?.pipeline.offers.length)} sub={cmp ?? 'in period'} onClick={() => setDrill({ title: 'Offers submitted', kind: 'offers', rows: P.offers })} />
        <Stat label="Contracts signed" value={num(P.contractsSigned.length)} delta={delta(P.contractsSigned.length, kp?.pipeline.contractsSigned.length)} sub={cmp ?? 'in period'} onClick={leadsDrill('Contracts signed in period', P.contractsSigned)} />
        <Stat label="Under contract" value={num(P.underContract.length)} sub="open deals" onClick={leadsDrill('Deals under contract', P.underContract)} />
        <Stat label="In disposition" value={num(P.inDispo.length)} sub="being marketed" onClick={() => setDrill({ title: 'Deals in disposition', kind: 'dispositions', rows: P.inDispo })} />
        <Stat label="Deals closed" value={num(P.closed.length)} delta={delta(P.closed.length, kp?.pipeline.closed.length)} sub={cmp ?? 'in period'} onClick={leadsDrill('Deals closed in period', P.closed)} />
        <Stat label="Dead leads" value={num(P.dead.length)} sub="in period" invert onClick={leadsDrill('Leads marked dead in period', P.dead)} />
        <Stat label="Lead → close" value={pct(k.funnel.leadToClose)} sub="of leads created in period" />
      </div>}

      {show('performance') && <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
        <Stat label="Lead → contact" value={pct(k.funnel.leadToContact)} delta={delta(k.funnel.leadToContact, kp?.funnel.leadToContact)} sub={cmp} />
        <Stat label="Contact → qualified" value={pct(k.funnel.contactToQualified)} delta={delta(k.funnel.contactToQualified, kp?.funnel.contactToQualified)} sub={cmp} />
        <Stat label="Qualified → contract" value={pct(k.funnel.qualifiedToContract)} delta={delta(k.funnel.qualifiedToContract, kp?.funnel.qualifiedToContract)} sub={cmp} />
        <Stat label="Contract → close" value={pct(k.funnel.contractToClose)} sub="of period's contracts" />
        <Stat label="Avg days to close" value={k.perf.avgDaysToClose === null ? '—' : num(k.perf.avgDaysToClose)} sub="contract to closing" />
        <Stat label="Lead → contract" value={k.perf.avgDaysLeadToContract === null ? '—' : `${num(k.perf.avgDaysLeadToContract)}d`} sub="average" />
        <Stat label="Follow-up completion" value={pct(k.perf.followUpRate)} sub={`${k.perf.followUpTasks.length} due in period`} onClick={() => setDrill({ title: 'Follow-up tasks due in period', kind: 'tasks', rows: k.perf.followUpTasks })} />
        <Stat label="Lead response time" value={k.perf.responseHours === null ? '—' : k.perf.responseHours < 48 ? `${num(k.perf.responseHours, 1)}h` : `${num(k.perf.responseHours / 24, 1)}d`} sub="creation to first attempt" />
      </div>}

      {show('attention') && <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Leads that need a next step" actions={<button className="btn btn-ghost btn-sm" onClick={leadsDrill('Leads needing follow-up', P.needFollowUp)}>View all {P.needFollowUp.length}</button>} pad={false}>
          {attention.length === 0 ? <div className="p-6 text-center text-fg-3">Every active lead has a follow-up scheduled. </div> : <ul className="divide-y divide-line">{attention.map(l => <li key={l.id}><Link to={`/leads/${l.id}`} className="flex items-center gap-3 px-4 h-11 hover:bg-surface-2"><span className="font-medium truncate flex-1">{contactName(c.get(l.contact_id))}</span><StageBadge id={l.stage} /><ScorePill score={l.score} /><span className={`w-28 text-right text-xs ${l.next_follow_up ? 'text-t-red' : 'text-t-amber'}`}>{l.next_follow_up ? `Due ${ago(l.next_follow_up)}` : 'No follow-up set'}</span></Link></li>)}</ul>}
        </Card>
        <Card title="My tasks due" actions={<Link className="btn btn-ghost btn-sm" to="/tasks">Open tasks</Link>} pad={false}>
          {myTasks.length === 0 ? <div className="p-6 text-center text-fg-3">Nothing due today. </div> : <ul className="divide-y divide-line">{myTasks.slice(0, 6).map(t => <li key={t.id}><Link to={t.lead_id ? `/leads/${t.lead_id}` : '/tasks'} className="flex items-center gap-3 px-4 h-11 hover:bg-surface-2"><AlarmClock size={14} className={t.due_at < now ? 'text-t-red' : 'text-fg-3'} /><span className="font-medium truncate flex-1">{t.title}</span><span className="text-xs text-fg-3">{t.category}</span><span className={`w-20 text-right text-xs ${t.due_at < now ? 'text-t-red font-medium' : 'text-fg-3'}`}>{ago(t.due_at)}</span></Link></li>)}</ul>}
        </Card>
      </div>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {show('revenue') && perms.read('finance') && <Card title="Revenue over time"><TimeChart data={revSeries} kind="bar" fmt={v => money(v)} series={[{ key: 'revenue', label: 'Assignment revenue' }, ...(hasCmp ? [{ key: 'prev', label: 'Previous period', muted: true }] : [])]} onBarClick={row => setDrill({ title: `Revenue — ${row.key}`, kind: 'revenue', rows: k.revenue.rows.filter(r => M.bucketKey(r.date, bucket) === row.key) })} /></Card>}
        {show('deals') && <Card title="Deals closed per month"><TimeChart data={dealSeries.map(p => ({ key: p.key, deals: p.value }))} kind="bar" series={[{ key: 'deals', label: 'Deals closed', color: 'var(--s3)' }]} /></Card>}
        {show('leads') && <Card title="Leads generated over time"><TimeChart data={leadSeries} kind="area" series={[{ key: 'leads', label: 'New leads' }, ...(hasCmp ? [{ key: 'prev', label: 'Previous period', muted: true }] : [])]} /></Card>}
        {show('funnel') && <Card title="Pipeline conversion" actions={<span className="text-[11px] text-fg-3">leads created in period</span>}>
          <Funnel steps={[{ label: 'Leads', value: k.funnel.total, onClick: leadsDrill('Leads created in period', P.created) }, { label: 'Contacted', value: k.funnel.contacted, onClick: leadsDrill('Contacted', P.created.filter(l => l.contacted_at)) }, { label: 'Qualified', value: k.funnel.qualified, onClick: leadsDrill('Qualified', P.created.filter(l => l.qualified_at)) }, { label: 'Offer made', value: k.funnel.offer, onClick: leadsDrill('Offer made', P.created.filter(l => l.offer_at)) }, { label: 'Under contract', value: k.funnel.contract, onClick: leadsDrill('Reached contract', P.created.filter(l => l.contract_at)) }, { label: 'Closed', value: k.funnel.closed, onClick: leadsDrill('Closed', P.created.filter(l => l.closed_at)) }]} /></Card>}
        {show('sources') && <Card title="Lead source performance" actions={<span className="text-[11px] text-fg-3">{perms.read('finance') ? 'revenue · leads' : 'leads'}</span>}>
          <BarList items={sources.map(s => ({ label: s.source, value: perms.read('finance') && sources.some(x => x.revenue > 0) ? s.revenue : s.leads, sub: `${s.leads} lead${s.leads === 1 ? '' : 's'} · ${s.qualified} qualified`, onClick: leadsDrill(`Leads from ${s.source}`, P.created.filter(l => (l.source ?? 'Unattributed') === s.source)) }))} fmt={perms.read('finance') && sources.some(x => x.revenue > 0) ? v => money(v) : undefined} empty="No leads in this period" /></Card>}
        {show('fees') && perms.read('finance') && <Card title="Assignment fee distribution"><TimeChart data={feeDist} kind="bar" series={[{ key: 'deals', label: 'Deals', color: 'var(--s7)' }]} onBarClick={row => setDrill({ title: `Deals with fee ${row.key}`, kind: 'revenue', rows: row.rows })} /></Card>}
        {show('team') && perms.read('finance') && <Card title="Acquisition performance" actions={<span className="text-[11px] text-fg-3">revenue by acquisition rep</span>}>
          <BarList items={team.sort((a, b) => b.revenue - a.revenue || b.contracts - a.contracts).map(t => ({ label: t.user.name, value: t.revenue, sub: `${t.contracts} contract${t.contracts === 1 ? '' : 's'} · ${t.leadsAssigned} leads`, onClick: () => setDrill({ title: `Revenue — ${t.user.name}`, kind: 'revenue', rows: k.revenue.rows.filter(r => r.ownerId === t.user.id) }) }))} fmt={v => money(v)} max={Math.max(...team.map(t => t.revenue), 1)} empty="No acquisition activity in this period" /></Card>}
        {show('buyers') && perms.read('buyers') && <Card title="Buyer performance" actions={<span className="text-[11px] text-fg-3">closed volume, all time</span>}>
          <BarList items={buyers.map(b => ({ label: b.buyer.name, value: b.volume, sub: `${b.closed} closed · ${b.offers} offers` }))} fmt={v => money(v)} empty="No buyer transactions yet" /></Card>}
      </div>
      <DrillModal drill={drill} onClose={() => setDrill(null)} />
      {users.length === 1 && ds.leads.length === 0 && <Card><div className="text-center py-4"><div className="font-semibold">Your workspace is empty</div><p className="text-fg-2 mt-1">Add your first lead with the <b>New</b> button, import a CSV from the Leads page, or load demo data in Settings → Data.</p></div></Card>}
    </div>
  );
}
