// Spreadsheet-style table: search, quick filters, advanced conditions, saved views, sorting, column
// visibility, selection with bulk actions, CSV export and pagination.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Bookmark, ChevronLeft, ChevronRight, Columns3, Download, ListFilter, Plus, Search, Trash2, X } from 'lucide-react';
import { useBoot, useData, useWrite, type R } from '@/lib/app';
import { download, toCsv } from '@/lib/format';
import { cx, Empty, Loading, Menu, promptDialog, toast } from './core';

export interface Col<T = R> { key: string; label: string; value?: (r: T) => unknown; render?: (r: T) => ReactNode; align?: 'right'; width?: number; hidden?: boolean; noSort?: boolean }
export interface QuickFilter<T = R> { key: string; label: string; options: { value: string; label: string }[]; get: (r: T) => unknown }
interface Cond { col: string; op: string; value: string }
interface ViewState { search: string; quick: Record<string, string>; conds: Cond[]; sort: { key: string; dir: 1 | -1 } | null; hidden: string[] }
const OPS: [string, string][] = [['contains', 'contains'], ['eq', 'is'], ['neq', 'is not'], ['gt', '>'], ['lt', '<'], ['empty', 'is empty'], ['filled', 'is not empty']];

function test(v: unknown, c: Cond) {
  const s = Array.isArray(v) ? v.join(', ').toLowerCase() : String(v ?? '').toLowerCase(), t = c.value.toLowerCase();
  switch (c.op) {
    case 'contains': return s.includes(t);
    case 'eq': return Array.isArray(v) ? v.some(x => String(x).toLowerCase() === t) : s === t;
    case 'neq': return Array.isArray(v) ? !v.some(x => String(x).toLowerCase() === t) : s !== t;
    case 'gt': return v !== null && v !== undefined && v !== '' && (isNaN(Number(v)) || isNaN(Number(c.value)) ? s > t : Number(v) > Number(c.value));
    case 'lt': return v !== null && v !== undefined && v !== '' && (isNaN(Number(v)) || isNaN(Number(c.value)) ? s < t : Number(v) < Number(c.value));
    case 'empty': return v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);
    default: return !(v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length));
  }
}

export interface TableProps<T extends R> {
  rows: T[]; cols: Col<T>[]; loading?: boolean; onRowClick?: (r: T) => void; filters?: QuickFilter<T>[]; viewKey?: string;
  bulk?: (selected: T[], clear: () => void) => ReactNode; empty?: ReactNode; exportName?: string; toolbar?: ReactNode; initialSort?: { key: string; dir: 1 | -1 };
  pageSize?: number; dense?: boolean; initialQuick?: Record<string, string>; noToolbar?: boolean; rowClass?: (r: T) => string | undefined;
}

export function DataTable<T extends R>({ rows, cols, loading, onRowClick, filters = [], viewKey, bulk, empty, exportName, toolbar, initialSort, pageSize = 50, initialQuick, noToolbar, rowClass }: TableProps<T>) {
  const [st, setSt] = useState<ViewState>({ search: '', quick: initialQuick ?? {}, conds: [], sort: initialSort ?? null, hidden: cols.filter(c => c.hidden).map(c => c.key) });
  const [sel, setSel] = useState<Set<string>>(new Set()), [page, setPage] = useState(0), [showConds, setShowConds] = useState(false);
  const set = (p: Partial<ViewState>) => { setSt(s => ({ ...s, ...p })); setPage(0); };
  const val = (c: Col<T>, r: T) => (c.value ? c.value(r) : (r as R)[c.key]);
  const colMap = useMemo(() => new Map(cols.map(c => [c.key, c])), [cols]);

  const filtered = useMemo(() => {
    const term = st.search.trim().toLowerCase();
    let out = rows.filter(r => {
      for (const f of filters) { const want = st.quick[f.key]; if (!want) continue; const got = f.get(r); if (Array.isArray(got) ? !got.map(String).includes(want) : String(got ?? '') !== want) return false; }
      for (const c of st.conds) { const col = colMap.get(c.col); if (col && (c.value || c.op === 'empty' || c.op === 'filled') && !test(val(col, r), c)) return false; }
      if (term && !cols.some(c => { const v = val(c, r); return v !== null && v !== undefined && (Array.isArray(v) ? v.join(' ') : String(v)).toLowerCase().includes(term); })) return false;
      return true;
    });
    if (st.sort) {
      const col = colMap.get(st.sort.key), dir = st.sort.dir;
      if (col) out = [...out].sort((a, b) => { const x = val(col, a), y = val(col, b); if (x === y) return 0; if (x === null || x === undefined || x === '') return 1; if (y === null || y === undefined || y === '') return -1; return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * dir; });
    }
    return out;
  }, [rows, st, filters, cols, colMap]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setSel(s => { const ids = new Set(rows.map(r => r.id)); const n = new Set([...s].filter(id => ids.has(id))); return n.size === s.size ? s : n; }); }, [rows]);

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize)), pg = Math.min(page, pages - 1);
  const visible = filtered.slice(pg * pageSize, (pg + 1) * pageSize);
  const shown = cols.filter(c => !st.hidden.includes(c.key));
  const selected = filtered.filter(r => sel.has(r.id));
  const allOnPage = visible.length > 0 && visible.every(r => sel.has(r.id));
  const active = st.conds.length + Object.values(st.quick).filter(Boolean).length + (st.search ? 1 : 0);

  return (
    <div className="card overflow-hidden flex flex-col min-h-0">
      {!noToolbar && <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-line">
        <div className="relative w-56 max-w-full"><Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-3" /><input className="input pl-8" placeholder="Search…" value={st.search} onChange={e => set({ search: e.target.value })} aria-label="Search table" /></div>
        {filters.map(f => <select key={f.key} className={cx('input !w-auto max-w-[170px]', st.quick[f.key] && '!border-accent')} value={st.quick[f.key] ?? ''} onChange={e => set({ quick: { ...st.quick, [f.key]: e.target.value } })} aria-label={f.label}><option value="">{f.label}: All</option>{f.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>)}
        <button className={cx('btn', (showConds || st.conds.length > 0) && '!border-accent')} onClick={() => { setShowConds(s => !s); if (!st.conds.length) set({ conds: [{ col: cols[0].key, op: 'contains', value: '' }] }); }}><ListFilter size={14} />Filter{st.conds.length > 0 && <span className="tnum">· {st.conds.length}</span>}</button>
        {active > 0 && <button className="btn btn-ghost" onClick={() => { set({ search: '', quick: {}, conds: [] }); setShowConds(false); }}><X size={14} />Clear</button>}
        <div className="flex-1" />
        {toolbar}
        {viewKey && <SavedViews viewKey={viewKey} state={st} apply={v => set(v)} />}
        <Menu width={220} trigger={<button className="btn btn-icon" title="Columns" aria-label="Choose columns"><Columns3 size={14} /></button>} items={cols.map(c => ({ label: `${st.hidden.includes(c.key) ? '○' : '●'}  ${c.label}`, onClick: () => set({ hidden: st.hidden.includes(c.key) ? st.hidden.filter(k => k !== c.key) : [...st.hidden, c.key] }) }))} />
        {exportName && <button className="btn btn-icon" title={`Export ${filtered.length} rows to CSV`} aria-label="Export CSV" onClick={() => { download(`${exportName}-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(filtered, shown.map(c => ({ label: c.label, value: (r: T) => val(c, r) })))); toast.success(`Exported ${filtered.length} rows`); }}><Download size={14} /></button>}
      </div>}
      {showConds && <div className="px-3 py-2 border-b border-line bg-surface-2 space-y-1.5">
        {st.conds.map((c, i) => <div key={i} className="flex flex-wrap items-center gap-1.5">
          <span className="w-10 text-xs text-fg-3">{i === 0 ? 'Where' : 'and'}</span>
          <select className="input !w-44" value={c.col} onChange={e => set({ conds: st.conds.map((x, j) => (j === i ? { ...x, col: e.target.value } : x)) })}>{cols.map(col => <option key={col.key} value={col.key}>{col.label}</option>)}</select>
          <select className="input !w-32" value={c.op} onChange={e => set({ conds: st.conds.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)) })}>{OPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          {!['empty', 'filled'].includes(c.op) && <input className="input !w-48" placeholder="Value" value={c.value} onChange={e => set({ conds: st.conds.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />}
          <button className="btn btn-ghost btn-icon btn-sm" aria-label="Remove condition" onClick={() => set({ conds: st.conds.filter((_, j) => j !== i) })}><X size={13} /></button>
        </div>)}
        <button className="btn btn-ghost btn-sm" onClick={() => set({ conds: [...st.conds, { col: cols[0].key, op: 'contains', value: '' }] })}><Plus size={13} />Add condition</button>
      </div>}
      {bulk && selected.length > 0 && <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-line bg-accent-soft"><span className="font-medium text-accent-text">{selected.length} selected</span>{bulk(selected, () => setSel(new Set()))}<div className="flex-1" /><button className="btn btn-ghost btn-sm" onClick={() => setSel(new Set())}>Clear selection</button></div>}
      <div className="overflow-auto scroll-thin flex-1">
        {loading ? <Loading /> : filtered.length === 0 ? (rows.length === 0 && empty ? empty : <Empty icon={<Search size={18} />} title="No matching records" body={active ? 'Try removing a filter or changing your search.' : undefined} />) : (
          <table className="w-full border-collapse">
            <thead className="sticky top-0 z-10"><tr>
              {bulk && <th className="th w-9"><input type="checkbox" aria-label="Select page" checked={allOnPage} onChange={() => setSel(s => { const n = new Set(s); visible.forEach(r => (allOnPage ? n.delete(r.id) : n.add(r.id))); return n; })} /></th>}
              {shown.map(c => <th key={c.key} className={cx('th', c.align === 'right' && 'text-right', !c.noSort && 'cursor-pointer select-none hover:text-fg-2')} style={{ width: c.width }} onClick={() => !c.noSort && set({ sort: st.sort?.key === c.key ? (st.sort.dir === 1 ? { key: c.key, dir: -1 } : null) : { key: c.key, dir: 1 } })}>
                <span className="inline-flex items-center gap-1">{c.label}{st.sort?.key === c.key && (st.sort.dir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}</span></th>)}
            </tr></thead>
            <tbody>{visible.map(r => <tr key={r.id} className={cx('row', onRowClick && 'cursor-pointer', rowClass?.(r))} onClick={() => onRowClick?.(r)}>
              {bulk && <td className="td w-9" onClick={e => e.stopPropagation()}><input type="checkbox" aria-label="Select row" checked={sel.has(r.id)} onChange={() => setSel(s => { const n = new Set(s); n.has(r.id) ? n.delete(r.id) : n.add(r.id); return n; })} /></td>}
              {shown.map(c => { const v = c.render ? c.render(r) : val(c, r); return <td key={c.key} className={cx('td', c.align === 'right' && 'text-right tnum')} style={{ maxWidth: c.width ?? 260 }}>{v === null || v === undefined || v === '' ? <span className="muted">—</span> : Array.isArray(v) ? v.join(', ') : (v as ReactNode)}</td>; })}
            </tr>)}</tbody>
          </table>
        )}
      </div>
      {!loading && filtered.length > 0 && <div className="flex items-center justify-between px-3 h-9 border-t border-line text-xs text-fg-3 shrink-0">
        <span className="tnum">{filtered.length === rows.length ? `${rows.length} records` : `${filtered.length} of ${rows.length} records`}</span>
        {pages > 1 && <span className="flex items-center gap-1 tnum"><button className="btn btn-ghost btn-icon btn-sm" disabled={pg === 0} onClick={() => setPage(pg - 1)} aria-label="Previous page"><ChevronLeft size={14} /></button>{pg + 1} / {pages}<button className="btn btn-ghost btn-icon btn-sm" disabled={pg >= pages - 1} onClick={() => setPage(pg + 1)} aria-label="Next page"><ChevronRight size={14} /></button></span>}
      </div>}
    </div>
  );
}

function SavedViews({ viewKey, state, apply }: { viewKey: string; state: ViewState; apply: (v: ViewState) => void }) {
  const { saved_views } = useData('saved_views');
  const { user } = useBoot();
  const w = useWrite();
  const mine = saved_views.filter(v => v.entity === viewKey);
  return <Menu width={240} trigger={<button className="btn" title="Saved views"><Bookmark size={14} />Views{mine.length > 0 && <span className="tnum text-fg-3">{mine.length}</span>}</button>} items={[
    ...mine.map(v => ({ label: v.name, icon: <Bookmark size={13} />, onClick: () => apply({ search: '', quick: {}, conds: [], sort: null, hidden: [], ...v.config }) })),
    ...(mine.length ? [{ label: '', divider: true }] : []),
    { label: 'Save current view…', icon: <Plus size={13} />, onClick: async () => { const name = await promptDialog({ title: 'Save view', confirm: 'Save', input: { label: 'View name', required: true, placeholder: 'e.g. Hot leads without follow-up' } }); if (name) { try { await w.create('saved_views', { entity: viewKey, name, config: state, user_id: user.id }); toast.success('View saved'); } catch (e) { toast.error(e); } } } },
    ...mine.filter(v => v.user_id === user.id).map(v => ({ label: `Delete "${v.name}"`, icon: <Trash2 size={13} />, danger: true, onClick: () => w.remove('saved_views', v.id).catch(toast.error) })),
  ]} />;
}
