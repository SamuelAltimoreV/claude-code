import { useMemo, useState } from 'react';
import { Plus, Target } from 'lucide-react';
import * as M from '@shared/metrics';
import { useBoot, useData, useDataset, usePerms, type R } from '@/lib/app';
import { fdate, money, num, pct } from '@/lib/format';
import { Card, Empty, PageHeader, StatusBadge, Tabs } from '@/ui/core';
import { DataTable, type Col } from '@/ui/DataTable';
import { RecordModal } from '@/ui/Form';
import { BarList } from '@/ui/charts';
import { DemoMark } from '@/ui/shared';
import { RANGES } from './Dashboard';

export default function Marketing() {
  const { settings } = useBoot();
  const { ds, loading } = useDataset();
  const { markets } = useData('markets');
  const perms = usePerms();
  const [tab, setTab] = useState<'performance' | 'campaigns' | 'expenses'>('performance'), [preset, setPreset] = useState('all');
  const [camp, setCamp] = useState<R | null | 'new'>(null), [exp, setExp] = useState<R | null | 'new'>(null), [expDefaults, setExpDefaults] = useState<R>({});
  const f = useMemo(() => M.presetRange(preset), [preset]);
  const sources = useMemo(() => M.sourceStats(ds, f), [ds, f]);
  const camps = useMemo(() => M.campaignStats(ds, preset === 'all' ? {} : f), [ds, f, preset]);
  const totals = { leads: M.sum(sources as any, 'leads'), spend: M.sum(sources as any, 'spend'), revenue: M.sum(sources as any, 'revenue'), qualified: M.sum(sources as any, 'qualified'), contracts: M.sum(sources as any, 'contracts') };
  const canWrite = perms.write('marketing'), fin = perms.read('finance');
  const srcCols: Col[] = [
    { key: 'source', label: 'Channel', render: r => <span className="font-medium">{r.source}</span> }, { key: 'leads', label: 'Leads', align: 'right' }, { key: 'contacted', label: 'Contacted', align: 'right' }, { key: 'qualified', label: 'Qualified', align: 'right' },
    { key: 'qualifiedRate', label: 'Qualified %', align: 'right', render: r => pct(r.qualifiedRate) }, { key: 'avgScore', label: 'Avg score', align: 'right', render: r => num(r.avgScore) }, { key: 'contracts', label: 'Contracts', align: 'right' }, { key: 'closed', label: 'Closed', align: 'right' },
    ...(fin ? [{ key: 'spend', label: 'Spend', align: 'right', render: (r: R) => money(r.spend) }, { key: 'revenue', label: 'Revenue', align: 'right', render: (r: R) => money(r.revenue) }, { key: 'avgFee', label: 'Avg fee', align: 'right', render: (r: R) => money(r.avgFee) }, { key: 'cpl', label: 'Cost / lead', align: 'right', value: (r: R) => (r.leads && r.spend ? r.spend / r.leads : null), render: (r: R) => money(r.leads && r.spend ? r.spend / r.leads : null) }, { key: 'roi', label: 'ROI', align: 'right', render: (r: R) => pct(r.roi) }] as Col[] : []),
  ];
  const campCols: Col[] = [
    { key: 'name', label: 'Campaign', width: 260, value: r => r.campaign.name, render: r => <span className="flex items-center gap-2"><span className="font-medium truncate">{r.campaign.name}</span><DemoMark r={r.campaign} /></span> }, { key: 'source', label: 'Lead source', value: r => r.campaign.source },
    { key: 'status', label: 'Status', value: r => r.campaign.status, render: r => <StatusBadge value={r.campaign.status} /> }, { key: 'market', label: 'Market', value: r => markets.find(m => m.id === r.campaign.market_id)?.name, hidden: true },
    { key: 'budget', label: 'Budget', align: 'right', value: r => r.campaign.budget, render: r => money(r.campaign.budget) }, { key: 'spend', label: 'Spend', align: 'right', render: r => money(r.spend) },
    { key: 'leads', label: 'Leads', align: 'right' }, { key: 'qualified', label: 'Qualified', align: 'right' }, { key: 'contracts', label: 'Contracts', align: 'right' }, { key: 'closed', label: 'Closed', align: 'right' }, { key: 'revenue', label: 'Revenue', align: 'right', render: r => money(r.revenue) },
    { key: 'cpl', label: 'Cost / lead', align: 'right', render: r => money(r.cpl) }, { key: 'cpql', label: 'Cost / qualified', align: 'right', render: r => money(r.cpql) }, { key: 'cpa', label: 'Cost / acquisition', align: 'right', render: r => money(r.cpa) }, { key: 'roi', label: 'ROI', align: 'right', render: r => (r.roi === null ? '—' : <span className={r.roi >= 0 ? 'text-t-green font-medium' : 'text-t-red font-medium'}>{pct(r.roi)}</span>) },
    { key: 'start', label: 'Started', value: r => r.campaign.start_date, render: r => fdate(r.campaign.start_date), hidden: true },
  ];
  const expCols: Col[] = [{ key: 'date', label: 'Date', render: r => fdate(r.date) }, { key: 'category', label: 'Category' }, { key: 'subcategory', label: 'Type' }, { key: 'campaign', label: 'Campaign', value: r => ds.campaigns.find(c => c.id === r.campaign_id)?.name }, { key: 'vendor', label: 'Vendor' }, { key: 'amount', label: 'Amount', align: 'right', render: r => money(r.amount) }, { key: 'notes', label: 'Notes' }];
  const best = (key: 'revenue' | 'avgFee' | 'qualifiedRate') => [...sources].filter(s => (s[key] ?? 0) > 0).sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0))[0];
  return (
    <div>
      <PageHeader title="Marketing & Lead Generation" subtitle="Which channels and campaigns produce qualified leads, contracts and assignment fees.">
        <select className="input !w-auto" value={preset} onChange={e => setPreset(e.target.value)} aria-label="Date range">{RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        {canWrite && <button className="btn btn-primary" onClick={() => setCamp('new')}><Plus size={14} />New campaign</button>}
      </PageHeader>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">{[['Leads generated', num(totals.leads)], ['Qualified leads', num(totals.qualified)], ['Contracts', num(totals.contracts)], ...(fin ? [['Marketing spend', money(totals.spend)], ['Cost per lead', money(totals.leads && totals.spend ? totals.spend / totals.leads : null)]] : [])].map(([l, v]) => <div key={l} className="card p-3.5"><div className="text-xs text-fg-2">{l}</div><div className="mt-1 text-xl font-semibold tnum">{v}</div></div>)}</div>
      <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[{ id: 'performance', label: 'Channel performance' }, { id: 'campaigns', label: 'Campaigns', count: ds.campaigns.length }, ...(fin ? [{ id: 'expenses' as const, label: 'Expenses', count: ds.expenses.length }] : [])]} />
      {tab === 'performance' && <div className="space-y-4">
        {sources.length > 0 && <div className="grid md:grid-cols-3 gap-3">{([['Most revenue', best('revenue'), (s: any) => money(s.revenue)], ['Highest average fee', best('avgFee'), (s: any) => money(s.avgFee)], ['Best qualification rate', best('qualifiedRate'), (s: any) => pct(s.qualifiedRate)]] as [string, any, (s: any) => string][]).filter(([l]) => fin || l.startsWith('Best')).map(([l, s, fmt]) => <div key={l} className="card p-3.5"><div className="text-xs text-fg-2">{l}</div><div className="mt-1 font-semibold">{s ? s.source : '—'}</div><div className="text-fg-3 tnum">{s ? fmt(s) : 'Not enough data'}</div></div>)}</div>}
        <div className="grid lg:grid-cols-3 gap-4">
          <Card title="Leads by channel"><BarList items={[...sources].sort((a, b) => b.leads - a.leads).map(s => ({ label: s.source, value: s.leads, sub: `${s.qualified} qualified` }))} /></Card>
          {fin && <Card title="Revenue by channel"><BarList items={sources.filter(s => s.revenue > 0).map(s => ({ label: s.source, value: s.revenue, sub: `${s.closed} deal${s.closed === 1 ? '' : 's'}`, color: 'var(--s3)' }))} fmt={v => money(v)} empty="No closed deals in this period" /></Card>}
          {fin && <Card title="Average assignment fee by channel"><BarList items={[...sources].filter(s => s.avgFee).sort((a, b) => (b.avgFee ?? 0) - (a.avgFee ?? 0)).map(s => ({ label: s.source, value: s.avgFee ?? 0, color: 'var(--s7)' }))} fmt={v => money(v)} empty="No closed deals in this period" /></Card>}
        </div>
        <DataTable rows={sources.map(s => ({ ...s, id: s.source }))} cols={srcCols} loading={loading} exportName="channel-performance" initialSort={{ key: 'leads', dir: -1 }} empty={<Empty icon={<Target size={18} />} title="No leads in this period" body="Every lead keeps its original source and campaign, so this fills in as leads arrive." />} />
        <p className="text-[11px] text-fg-3">Lead sources are configured in Settings → Lists. Spend comes from expenses linked to a campaign with that source. Facebook Lead Ads, Google Ads and web forms can feed leads in through inbound webhooks (Integrations).</p>
      </div>}
      {tab === 'campaigns' && <DataTable rows={camps.map(c => ({ ...c, id: c.campaign.id }))} cols={campCols.filter(c => fin || !['budget', 'spend', 'revenue', 'cpl', 'cpql', 'cpa', 'roi'].includes(c.key))} loading={loading} exportName="campaigns" onRowClick={r => canWrite && setCamp(r.campaign)} initialSort={{ key: 'leads', dir: -1 }}
        toolbar={canWrite && fin ? <button className="btn" onClick={() => { setExpDefaults({ category: 'Marketing', date: new Date().toISOString().slice(0, 10) }); setExp('new'); }}><Plus size={14} />Log spend</button> : undefined}
        empty={<Empty icon={<Target size={18} />} title="No campaigns yet" body="Create a campaign for each mail drop, ad set or list so you can see cost per lead and return on investment." action={canWrite && <button className="btn btn-primary" onClick={() => setCamp('new')}>New campaign</button>} />} />}
      {tab === 'expenses' && <DataTable rows={ds.expenses} cols={expCols} loading={loading} exportName="expenses" onRowClick={r => perms.write('finance') && setExp(r)} initialSort={{ key: 'date', dir: -1 }} filters={[{ key: 'cat', label: 'Category', options: [{ value: 'Marketing', label: 'Marketing' }, { value: 'Operating', label: 'Operating' }], get: r => r.category }]}
        toolbar={perms.write('finance') ? <button className="btn" onClick={() => { setExpDefaults({ date: new Date().toISOString().slice(0, 10) }); setExp('new'); }}><Plus size={14} />New expense</button> : undefined} empty={<Empty title="No expenses recorded" body="Record marketing and operating expenses to see true net profit." />} />}
      <RecordModal entity="campaigns" open={!!camp} onClose={() => setCamp(null)} record={camp === 'new' ? null : camp} size="md" />
      <RecordModal entity="expenses" open={!!exp} onClose={() => setExp(null)} record={exp === 'new' ? null : exp} defaults={expDefaults} size="md" />
      <span className="hidden">{settings.sources.length}</span>
    </div>
  );
}
