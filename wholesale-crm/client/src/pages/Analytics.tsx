import { useMemo, useState, type ReactNode } from 'react';
import { Download, Printer } from 'lucide-react';
import * as M from '@shared/metrics';
import { useBoot, useDataset, type R } from '@/lib/app';
import { download, money, num, pct, toCsv } from '@/lib/format';
import { Card, cx, Loading, PageHeader, Tabs } from '@/ui/core';
import { DataTable, type Col } from '@/ui/DataTable';
import { BarList, Funnel, TimeChart } from '@/ui/charts';
import { useFilterBar } from './Dashboard';

type Fmt = (v: any) => string;
interface Line { label: string; cur: number | null; prev?: number | null; fmt?: Fmt; invert?: boolean }

function Compare({ title, lines, hasPrev, exportName }: { title: string; lines: Line[]; hasPrev: boolean; exportName: string }) {
  const csv = () => download(`${exportName}.csv`, toCsv(lines as any, [{ label: 'Metric', value: (r: Line) => r.label }, { label: 'This period', value: (r: Line) => r.cur }, ...(hasPrev ? [{ label: 'Previous period', value: (r: Line) => r.prev }, { label: 'Change %', value: (r: Line) => (r.prev ? (((r.cur ?? 0) - r.prev) / Math.abs(r.prev)) * 100 : '') }] : [])]));
  return (
    <Card title={title} actions={<button className="btn btn-ghost btn-sm no-print" onClick={csv}><Download size={12} />CSV</button>} pad={false}>
      <table className="w-full"><thead><tr><th className="th">Metric</th><th className="th text-right">This period</th>{hasPrev && <><th className="th text-right">Previous period</th><th className="th text-right">Change</th></>}</tr></thead>
        <tbody>{lines.map(l => { const f = l.fmt ?? num, d = l.prev ? (((l.cur ?? 0) - l.prev) / Math.abs(l.prev)) * 100 : null, good = d !== null && (l.invert ? d < 0 : d > 0); return (
          <tr key={l.label} className="row"><td className="td">{l.label}</td><td className="td text-right tnum font-medium">{f(l.cur)}</td>{hasPrev && <><td className="td text-right tnum text-fg-2">{f(l.prev)}</td><td className={cx('td text-right tnum', d === null || d === 0 ? 'text-fg-3' : good ? 'text-t-green' : 'text-t-red')}>{d === null ? '—' : `${d > 0 ? '+' : ''}${d.toFixed(0)}%`}</td></>}</tr>); })}</tbody></table>
    </Card>
  );
}

export default function Analytics() {
  const { settings } = useBoot();
  const { ds, loading } = useDataset();
  const fb = useFilterBar();
  const [tab, setTab] = useState<'acquisition' | 'dispositions' | 'financial' | 'team' | 'markets'>('acquisition');
  const f = fb.filter, p = fb.prev, hasPrev = !!p;
  const k = useMemo(() => M.kpis(ds, f, settings), [ds, f, settings]), kp = useMemo(() => (p ? M.kpis(ds, p, settings) : null), [ds, p, settings]);
  const fin = useMemo(() => M.financials(ds, f), [ds, f]), finP = useMemo(() => (p ? M.financials(ds, p) : null), [ds, p]);
  const dsp = useMemo(() => M.dispoStats(ds, f), [ds, f]), dspP = useMemo(() => (p ? M.dispoStats(ds, p) : null), [ds, p]);
  const team = useMemo(() => M.teamStats(ds, f), [ds, f]), markets = useMemo(() => M.marketStats(ds, f), [ds, f]);
  const users = useMemo(() => new Map(ds.users.map(u => [u.id, u.name])), [ds.users]), mk = useMemo(() => new Map(ds.markets.map(m => [m.id, m.name])), [ds.markets]);
  const { from, to } = fb.range, chartFrom = fb.preset === 'all' ? ds.leads.reduce((m, l) => (l.created_at < m ? l.created_at : m), to).slice(0, 10) : from, bucket = M.pickBucket(chartFrom, to);
  const days = (v: number | null) => (v === null || v === undefined ? '—' : `${num(v, 1)} days`);
  const byGroup = (rows: M.RevenueRow[], key: (r: M.RevenueRow) => string) => [...M.groupBy(rows, key)].map(([label, v]) => ({ label, value: M.sum(v, 'amount'), sub: `${v.length} deal${v.length === 1 ? '' : 's'}` })).sort((a, b) => b.value - a.value);
  const teamCols: Col[] = [{ key: 'name', label: 'Team member', value: r => r.user.name, render: r => <span className="font-medium">{r.user.name} <span className="font-normal text-fg-3">· {r.user.role}</span></span>, width: 280 }, { key: 'calls', label: 'Calls made', align: 'right' }, { key: 'conversations', label: 'Conversations', align: 'right' }, { key: 'leadsAssigned', label: 'New leads', align: 'right' }, { key: 'qualified', label: 'Qualified', align: 'right' }, { key: 'offers', label: 'Offers', align: 'right' }, { key: 'contracts', label: 'Contracts', align: 'right' }, { key: 'closed', label: 'Closed', align: 'right' }, { key: 'revenue', label: 'Revenue', align: 'right', render: r => money(r.revenue) }, { key: 'contractRate', label: 'Lead → contract', align: 'right', render: r => pct(r.contractRate) }, { key: 'tasksDone', label: 'Tasks done', align: 'right' }, { key: 'tasksOverdue', label: 'Overdue now', align: 'right', render: r => <span className={r.tasksOverdue ? 'text-t-red font-medium' : ''}>{r.tasksOverdue}</span> }];
  const marketCols: Col[] = [{ key: 'name', label: 'Market', value: r => r.market.name, render: r => <span className="font-medium">{r.market.name}</span> }, { key: 'properties', label: 'Properties', align: 'right' }, { key: 'leads', label: 'New leads', align: 'right' }, { key: 'active', label: 'Active leads', align: 'right' }, { key: 'qualified', label: 'Qualified', align: 'right' }, { key: 'contracts', label: 'Contracts', align: 'right' }, { key: 'closed', label: 'Closed', align: 'right' }, { key: 'revenue', label: 'Revenue', align: 'right', render: r => money(r.revenue) }, { key: 'avgFee', label: 'Avg fee', align: 'right', render: r => money(r.avgFee) }, { key: 'conversion', label: 'Lead → close', align: 'right', render: r => pct(r.conversion) }];
  const P = k.pipeline, PP = kp?.pipeline;
  const byCity = useMemo(() => { const prop = new Map(ds.properties.map(x => [x.id, x])); return [...M.groupBy(P.created, l => { const pr = prop.get(l.property_id); return pr ? `${pr.city ?? 'Unknown'}${pr.zip ? ` ${pr.zip}` : ''}` : 'No property'; })].map(([label, v]) => ({ label, value: v.length, sub: `${v.filter(l => l.contract_at).length} contracts` })).sort((a, b) => b.value - a.value); }, [P.created, ds.properties]);
  const section: Record<string, ReactNode> = {
    acquisition: <div className="grid lg:grid-cols-2 gap-4">
      <Compare title="Acquisition report" exportName="acquisition-report" hasPrev={hasPrev} lines={[
        { label: 'Leads generated', cur: P.created.length, prev: PP?.created.length }, { label: 'Leads contacted', cur: P.contacted.length, prev: PP?.contacted.length }, { label: 'Qualified leads', cur: P.qualified.length, prev: PP?.qualified.length },
        { label: 'Offers submitted', cur: P.offers.length, prev: PP?.offers.length }, { label: 'Contracts signed', cur: P.contractsSigned.length, prev: PP?.contractsSigned.length }, { label: 'Dead leads', cur: P.dead.length, prev: PP?.dead.length, invert: true },
        { label: 'Lead → contact', cur: k.funnel.leadToContact, prev: kp?.funnel.leadToContact, fmt: pct }, { label: 'Contact → qualified', cur: k.funnel.contactToQualified, prev: kp?.funnel.contactToQualified, fmt: pct }, { label: 'Qualified → contract', cur: k.funnel.qualifiedToContract, prev: kp?.funnel.qualifiedToContract, fmt: pct }, { label: 'Contract → close', cur: k.funnel.contractToClose, prev: kp?.funnel.contractToClose, fmt: pct },
        { label: 'Avg lead → contract', cur: k.perf.avgDaysLeadToContract, prev: kp?.perf.avgDaysLeadToContract, fmt: days, invert: true }, { label: 'Lead response time (hours)', cur: k.perf.responseHours, prev: kp?.perf.responseHours, fmt: v => num(v, 1), invert: true }, { label: 'Follow-up completion', cur: k.perf.followUpRate, prev: kp?.perf.followUpRate, fmt: pct }]} />
      <div className="space-y-4">
        <Card title="Where leads drop off"><Funnel steps={[{ label: 'Leads', value: k.funnel.total }, { label: 'Contacted', value: k.funnel.contacted }, { label: 'Qualified', value: k.funnel.qualified }, { label: 'Offer made', value: k.funnel.offer }, { label: 'Contract', value: k.funnel.contract }, { label: 'Closed', value: k.funnel.closed }]} /></Card>
        <Card title="Leads and contracts over time"><TimeChart kind="line" data={M.series(P.created, 'created_at', () => 1, chartFrom, to, bucket).map((x, i) => ({ key: x.key, leads: x.value, contracts: M.series(P.contractsSigned, 'contract_at', () => 1, chartFrom, to, bucket)[i]?.value ?? 0 }))} series={[{ key: 'leads', label: 'Leads generated' }, { key: 'contracts', label: 'Contracts signed' }]} /></Card>
      </div>
    </div>,
    dispositions: <div className="grid lg:grid-cols-2 gap-4">
      <Compare title="Disposition report" exportName="disposition-report" hasPrev={hasPrev} lines={[{ label: 'Deals marketed', cur: dsp.marketed, prev: dspP?.marketed }, { label: 'Buyers contacted', cur: dsp.buyersContacted, prev: dspP?.buyersContacted }, { label: 'Buyer offers received', cur: dsp.buyerOffers, prev: dspP?.buyerOffers }, { label: 'Assignment contracts', cur: dsp.assigned, prev: dspP?.assigned }, { label: 'Deals closed', cur: dsp.closed, prev: dspP?.closed }, { label: 'Average disposition time', cur: dsp.avgDays, prev: dspP?.avgDays, fmt: days, invert: true }, { label: 'Avg days contract → close', cur: k.perf.avgDaysToClose, prev: kp?.perf.avgDaysToClose, fmt: days, invert: true }]} />
      <Card title="Buyers by closed volume" actions={<span className="text-[11px] text-fg-3">all time</span>}><BarList items={M.buyerStats(ds).filter(b => b.volume > 0).sort((a, b) => b.volume - a.volume).map(b => ({ label: b.buyer.name, value: b.volume, sub: `${b.closed} closed · ${b.offers} offers` }))} fmt={v => money(v)} empty="No closed buyer transactions yet" /></Card>
    </div>,
    financial: <div className="grid lg:grid-cols-2 gap-4">
      <Compare title="Financial report" exportName="financial-report" hasPrev={hasPrev} lines={[{ label: 'Gross assignment revenue', cur: fin.gross, prev: finP?.gross, fmt: money }, { label: 'Marketing expenses', cur: fin.marketing, prev: finP?.marketing, fmt: money, invert: true }, { label: 'Operating expenses', cur: fin.operating, prev: finP?.operating, fmt: money, invert: true }, { label: 'Net business profit', cur: fin.net, prev: finP?.net, fmt: money }, { label: 'Deals closed', cur: fin.deals, prev: finP?.deals }, { label: 'Average assignment fee', cur: fin.avgFee, prev: finP?.avgFee, fmt: money }, { label: 'Projected revenue (open deals)', cur: k.revenue.projected, fmt: money }]} />
      <Card title="Revenue vs. expenses"><TimeChart kind="bar" fmt={v => money(v)} data={M.series(fin.rev, 'date', r => r.amount, chartFrom, to, 'month').map((x, i) => ({ key: x.key, revenue: x.value, expenses: M.series(fin.exp, 'date', r => r.amount, chartFrom, to, 'month')[i]?.value ?? 0 }))} series={[{ key: 'revenue', label: 'Assignment revenue' }, { key: 'expenses', label: 'Expenses' }]} /></Card>
      <Card title="Revenue by market"><BarList items={byGroup(fin.rev, r => mk.get(r.marketId ?? '') ?? 'No market')} fmt={v => money(v)} empty="No revenue in this period" /></Card>
      <Card title="Revenue by team member"><BarList items={byGroup(fin.rev, r => users.get(r.ownerId ?? '') ?? 'Unassigned')} fmt={v => money(v)} empty="No revenue in this period" /></Card>
      <Card title="Revenue by lead source"><BarList items={byGroup(fin.rev, r => r.source)} fmt={v => money(v)} empty="No revenue in this period" /></Card>
      <Card title="Expenses by type"><BarList items={[...M.groupBy(fin.exp as R[], e => `${e.category}: ${e.subcategory ?? 'Other'}`)].map(([label, v]) => ({ label, value: M.sum(v, 'amount'), color: 'var(--s2)' })).sort((a, b) => b.value - a.value)} fmt={v => money(v)} empty="No expenses in this period" /></Card>
    </div>,
    team: <div className="space-y-4"><DataTable rows={team.map(t => ({ ...t, id: t.user.id }))} cols={teamCols} exportName="team-performance" initialSort={{ key: 'revenue', dir: -1 }} />
      <div className="grid lg:grid-cols-2 gap-4"><Card title="Calls made"><BarList items={team.filter(t => t.calls > 0).sort((a, b) => b.calls - a.calls).map(t => ({ label: t.user.name, value: t.calls, sub: `${t.conversations} conversations` }))} empty="No calls logged in this period" /></Card><Card title="Contracts acquired"><BarList items={team.filter(t => t.contracts > 0).sort((a, b) => b.contracts - a.contracts).map(t => ({ label: t.user.name, value: t.contracts, sub: money(t.revenue), color: 'var(--s3)' }))} empty="No contracts in this period" /></Card></div></div>,
    markets: <div className="space-y-4">{ds.markets.length === 0 ? <Card><p className="text-fg-2">No markets are defined yet. Add markets (counties, cities, ZIP codes) in Settings → Markets and properties will be assigned to them automatically.</p></Card> : <DataTable rows={markets.map(m => ({ ...m, id: m.market.id }))} cols={marketCols} exportName="market-performance" initialSort={{ key: 'revenue', dir: -1 }} />}
      <div className="grid lg:grid-cols-2 gap-4"><Card title="New leads by city / ZIP"><BarList items={byCity} limit={12} empty="No leads in this period" /></Card><Card title="Revenue by market"><BarList items={markets.filter(m => m.revenue > 0).map(m => ({ label: m.market.name, value: m.revenue, sub: `${m.closed} closed`, color: 'var(--s3)' }))} fmt={v => money(v)} empty="No revenue in this period" /></Card></div></div>,
  };
  return (
    <div>
      <PageHeader title="Analytics & Reports" subtitle="Where the business makes money, where deals are lost, and which activity pays off.">
        <span className="contents no-print">{fb.bar(ds)}<button className="btn" onClick={() => window.print()} title="Use your browser's Save as PDF"><Printer size={14} />Print / PDF</button></span>
      </PageHeader>
      <Tabs className="mb-4 no-print" value={tab} onChange={setTab} tabs={[{ id: 'acquisition', label: 'Acquisition' }, { id: 'dispositions', label: 'Dispositions' }, { id: 'financial', label: 'Financial' }, { id: 'team', label: 'Team' }, { id: 'markets', label: 'Markets' }]} />
      {loading ? <Loading rows={8} /> : section[tab]}
      <p className="mt-4 text-[11px] text-fg-3">Period: {from} to {to}{p ? ` · compared with ${p.from} to ${p.to}` : ''}. Conversion rates follow leads created in the period; revenue uses the closing date.</p>
    </div>
  );
}
