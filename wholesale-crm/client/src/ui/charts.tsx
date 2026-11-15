// Chart primitives. Colors come from the validated categorical palette (CSS variables, light + dark).
import type { ReactNode } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { cx, Empty } from './core';
import { BarChart3 } from 'lucide-react';

export const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)'];
export interface SeriesDef { key: string; label: string; color?: string; muted?: boolean }

export const fmtBucket = (k: string) => {
  if (/^\d{4}-\d{2}$/.test(k)) return new Date(k + '-15T12:00:00').toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
  if (/^\d{4}-\d{2}-\d{2}$/.test(k)) return new Date(k + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return k;
};
const axisNum = (v: number) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1).replace(/\.0$/, '')}M` : `${(v / 1e3).toFixed(1).replace(/\.0$/, '')}K`);

function Tip({ active, payload, label, series, fmt }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="card shadow-[var(--shadow)] px-2.5 py-2 text-xs min-w-[120px]">
      <div className="font-medium mb-1">{fmtBucket(String(label))}</div>
      {payload.map((p: any) => { const s = (series as SeriesDef[]).find(x => x.key === p.dataKey); return (
        <div key={p.dataKey} className="flex items-center justify-between gap-4"><span className="flex items-center gap-1.5 text-fg-2"><span className="w-2 h-2 rounded-sm" style={{ background: p.color ?? p.stroke }} />{s?.label ?? p.dataKey}</span><span className="tnum font-medium">{fmt ? fmt(p.value) : p.value}</span></div>); })}
    </div>
  );
}
export function Legend({ series }: { series: SeriesDef[] }) {
  return <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-2">{series.map((s, i) => <span key={s.key} className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: s.muted ? 'var(--fg-3)' : s.color ?? SERIES[i] }} />{s.label}</span>)}</div>;
}

export function TimeChart({ data, series, kind = 'bar', fmt, height = 220, xKey = 'key', onBarClick }: { data: Record<string, any>[]; series: SeriesDef[]; kind?: 'bar' | 'line' | 'area'; fmt?: (v: number) => string; height?: number; xKey?: string; onBarClick?: (row: any) => void }) {
  const hasData = data.some(d => series.some(s => Number(d[s.key]) > 0));
  if (!data.length || !hasData) return <div style={{ height }} className="flex items-center justify-center"><Empty icon={<BarChart3 size={18} />} title="No data in this period" body="Try a wider date range or remove filters." /></div>;
  const color = (s: SeriesDef, i: number) => (s.muted ? 'var(--fg-3)' : s.color ?? SERIES[i]);
  const peak = Math.max(...data.flatMap(d => series.map(s => Math.abs(Number(d[s.key]) || 0))));
  const compact = peak >= 1e4, prefix = fmt?.(0).startsWith('$') ? '$' : '';
  const common = { data, margin: { top: 8, right: 8, bottom: 0, left: 0 } };
  const axes = <>
    <CartesianGrid vertical={false} strokeDasharray="" />
    <XAxis dataKey={xKey} tickFormatter={fmtBucket} tickLine={false} axisLine={{ stroke: 'var(--line-strong)' }} minTickGap={24} interval="preserveStartEnd" />
    <YAxis tickFormatter={v => (compact ? (v === 0 ? (fmt ? fmt(0) : '0') : prefix + axisNum(v)) : fmt ? fmt(v) : v.toLocaleString())} tickLine={false} axisLine={false} width={48} allowDecimals={false} />
    <Tooltip content={<Tip series={series} fmt={fmt} />} cursor={kind === 'bar' ? { fill: 'var(--surface-2)' } : { stroke: 'var(--line-strong)' }} />
  </>;
  return (
    <div>
      {series.length > 1 && <div className="mb-2"><Legend series={series} /></div>}
      <div style={{ height }} role="img" aria-label={`${kind} chart: ${series.map(s => s.label).join(', ')}`}>
        <ResponsiveContainer width="100%" height="100%">
          {kind === 'bar' ? <BarChart {...common} barGap={2} barCategoryGap="22%">{axes}{series.map((s, i) => <Bar key={s.key} dataKey={s.key} fill={color(s, i)} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} onClick={onBarClick ? (d: any) => onBarClick(d?.payload ?? d) : undefined} cursor={onBarClick ? 'pointer' : undefined} />)}</BarChart>
            : kind === 'area' ? <AreaChart {...common}>{axes}{series.map((s, i) => <Area key={s.key} type="monotone" dataKey={s.key} stroke={color(s, i)} strokeWidth={2} fill={color(s, i)} fillOpacity={s.muted ? 0 : 0.1} strokeDasharray={s.muted ? '4 3' : undefined} dot={false} activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }} isAnimationActive={false} />)}</AreaChart>
            : <LineChart {...common}>{axes}{series.map((s, i) => <Line key={s.key} type="monotone" dataKey={s.key} stroke={color(s, i)} strokeWidth={2} strokeDasharray={s.muted ? '4 3' : undefined} dot={false} activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }} isAnimationActive={false} />)}</LineChart>}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export interface BarItem { label: string; value: number; sub?: ReactNode; onClick?: () => void; color?: string }
/** Ranked horizontal bars with direct value labels. Single series, so one color and no legend. */
export function BarList({ items, fmt = v => v.toLocaleString(), max, empty = 'No data yet', limit = 8 }: { items: BarItem[]; fmt?: (v: number) => string; max?: number; empty?: string; limit?: number }) {
  const list = items.slice(0, limit), top = max ?? Math.max(...list.map(i => i.value), 0);
  if (!list.length || top <= 0) return <div className="py-6 text-center text-fg-3">{empty}</div>;
  return <div className="space-y-2">{list.map(it => {
    const C: any = it.onClick ? 'button' : 'div';
    return <C key={it.label} onClick={it.onClick} className={cx('block w-full text-left group', it.onClick && 'cursor-pointer')} title={`${it.label}: ${fmt(it.value)}`}>
      <div className="flex items-baseline justify-between gap-3 mb-1"><span className={cx('truncate text-fg-2', it.onClick && 'group-hover:text-fg')}>{it.label}</span><span className="tnum font-medium shrink-0">{fmt(it.value)}{it.sub && <span className="ml-1.5 font-normal text-fg-3">{it.sub}</span>}</span></div>
      <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden"><div className="h-full rounded-full" style={{ width: `${Math.max((it.value / top) * 100, it.value > 0 ? 1.5 : 0)}%`, background: it.color ?? 'var(--s1)' }} /></div>
    </C>; })}</div>;
}

/** Pipeline funnel: each step shows its count and conversion from the previous step. */
export function Funnel({ steps }: { steps: { label: string; value: number; onClick?: () => void }[] }) {
  const top = Math.max(steps[0]?.value ?? 0, 1);
  if (!steps[0]?.value) return <div className="py-6 text-center text-fg-3">No leads in this period</div>;
  return <div className="space-y-1.5">{steps.map((s, i) => {
    const prev = i > 0 ? steps[i - 1].value : null, conv = prev ? (s.value / prev) * 100 : null;
    const C: any = s.onClick ? 'button' : 'div';
    return <C key={s.label} onClick={s.onClick} className="flex items-center gap-3 w-full text-left group" title={`${s.label}: ${s.value}`}>
      <span className="w-24 shrink-0 text-fg-2 truncate group-hover:text-fg">{s.label}</span>
      <span className="flex-1 h-6 rounded bg-surface-2 overflow-hidden"><span className="block h-full rounded" style={{ width: `${Math.max((s.value / top) * 100, s.value ? 1 : 0)}%`, background: 'var(--s1)', opacity: 1 - i * 0.11 }} /></span>
      <span className="w-9 text-right tnum font-medium">{s.value}</span>
      <span className="w-12 text-right tnum text-[11px] text-fg-3">{conv === null ? '' : `${conv.toFixed(0)}%`}</span>
    </C>; })}</div>;
}
