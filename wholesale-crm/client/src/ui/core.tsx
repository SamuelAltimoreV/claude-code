import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, ChevronDown, Info, Loader2, X } from 'lucide-react';
import { ApiError } from '@/lib/app';
import { initials } from '@/lib/format';

export const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(' ');

// ---------- Tiny external stores for toasts and dialogs ----------
function store<T>(initial: T) {
  let state = initial; const subs = new Set<() => void>();
  return { get: () => state, set: (s: T) => { state = s; subs.forEach(f => f()); }, sub: (f: () => void) => { subs.add(f); return () => subs.delete(f); } };
}
interface Toast { id: number; kind: 'success' | 'error' | 'info'; text: string }
const toasts = store<Toast[]>([]);
let tid = 0;
const push = (kind: Toast['kind'], text: string) => { const id = ++tid; toasts.set([...toasts.get(), { id, kind, text }]); setTimeout(() => toasts.set(toasts.get().filter(t => t.id !== id)), kind === 'error' ? 7000 : 3500); };
export const toast = {
  success: (t: string) => push('success', t), info: (t: string) => push('info', t),
  error: (e: unknown) => push('error', e instanceof Error ? e.message : String(e)),
};
export function Toaster() {
  const list = useSyncExternalStore(toasts.sub, toasts.get);
  return createPortal(
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 w-[340px] max-w-[calc(100vw-2rem)]" role="status" aria-live="polite">
      {list.map(t => (
        <div key={t.id} className="card anim-pop flex items-start gap-2.5 px-3 py-2.5 shadow-[var(--shadow)]">
          {t.kind === 'success' ? <Check size={15} className="mt-0.5 text-t-green shrink-0" /> : t.kind === 'error' ? <AlertTriangle size={15} className="mt-0.5 text-t-red shrink-0" /> : <Info size={15} className="mt-0.5 text-t-blue shrink-0" />}
          <div className="flex-1 text-[13px] leading-snug">{t.text}</div>
          <button className="text-fg-3 hover:text-fg" onClick={() => toasts.set(toasts.get().filter(x => x.id !== t.id))} aria-label="Dismiss"><X size={14} /></button>
        </div>
      ))}
    </div>, document.body);
}

interface Dialog { title: string; body?: ReactNode; confirm?: string; danger?: boolean; input?: { label: string; placeholder?: string; required?: boolean; multiline?: boolean; initial?: string }; resolve: (v: any) => void }
const dialog = store<Dialog | null>(null);
export const confirmDialog = (d: Omit<Dialog, 'resolve' | 'input'>) => new Promise<boolean>(resolve => dialog.set({ ...d, resolve }));
export const promptDialog = (d: Omit<Dialog, 'resolve'> & { input: NonNullable<Dialog['input']> }) => new Promise<string | null>(resolve => dialog.set({ ...d, resolve }));
export function DialogHost() {
  const d = useSyncExternalStore(dialog.sub, dialog.get);
  const [val, setVal] = useState('');
  useEffect(() => { setVal(d?.input?.initial ?? ''); }, [d]);
  if (!d) return null;
  const close = (v: any) => { dialog.set(null); d.resolve(v); };
  const ok = () => close(d.input ? val.trim() : true);
  return (
    <Modal open onClose={() => close(d.input ? null : false)} title={d.title} size="sm"
      footer={<><button className="btn" onClick={() => close(d.input ? null : false)}>Cancel</button><button className={cx('btn', d.danger ? 'btn-primary !bg-critical !text-white' : 'btn-primary')} disabled={!!d.input?.required && !val.trim()} onClick={ok}>{d.confirm ?? 'Confirm'}</button></>}>
      {d.body && <div className="text-fg-2 leading-relaxed">{d.body}</div>}
      {d.input && <div className={d.body ? 'mt-3' : ''}><label className="label">{d.input.label}</label>
        {d.input.multiline ? <textarea autoFocus rows={3} className="input" value={val} placeholder={d.input.placeholder} onChange={e => setVal(e.target.value)} />
          : <input autoFocus className="input" value={val} placeholder={d.input.placeholder} onChange={e => setVal(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (!d.input!.required || val.trim())) ok(); }} />}</div>}
    </Modal>
  );
}

// ---------- Overlays ----------
function useEscape(open: boolean, onClose: () => void) {
  useEffect(() => { if (!open) return; const h = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [open, onClose]);
}
export function Modal({ open, onClose, title, children, footer, size = 'md' }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  useEscape(open, onClose);
  if (!open) return null;
  const w = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' }[size];
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:pt-[8vh] bg-black/40 anim-fade overflow-y-auto" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" className={cx('card w-full shadow-[var(--shadow-lg)] anim-pop flex flex-col max-h-[86vh]', w)}>
        <div className="flex items-center justify-between px-5 h-12 border-b border-line shrink-0"><h2 className="text-sm font-semibold">{title}</h2><button className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label="Close"><X size={15} /></button></div>
        <div className="px-5 py-4 overflow-y-auto scroll-thin">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-line shrink-0">{footer}</div>}
      </div>
    </div>, document.body);
}
export function Drawer({ open, onClose, title, children, width = 520, actions }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; width?: number; actions?: ReactNode }) {
  useEscape(open, onClose);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-40 bg-black/30 anim-fade" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="absolute right-0 top-0 h-full bg-surface border-l border-line shadow-[var(--shadow-lg)] anim-slide flex flex-col max-w-full" style={{ width }}>
        <div className="flex items-center justify-between gap-2 px-5 h-12 border-b border-line shrink-0"><div className="text-sm font-semibold truncate">{title}</div><div className="flex items-center gap-1">{actions}<button className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label="Close"><X size={15} /></button></div></div>
        <div className="flex-1 overflow-y-auto scroll-thin">{children}</div>
      </div>
    </div>, document.body);
}

export interface MenuItem { label: string; icon?: ReactNode; onClick?: () => void; danger?: boolean; disabled?: boolean; divider?: boolean; hint?: string }
export function Menu({ trigger, items, align = 'right', width = 200 }: { trigger: ReactNode; items: MenuItem[]; align?: 'left' | 'right'; width?: number }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!open) return; const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, [open]);
  return (
    <div className="relative inline-flex" ref={ref}>
      <span onClick={e => { e.stopPropagation(); setOpen(o => !o); }}>{trigger}</span>
      {open && <div className={cx('absolute top-full mt-1 z-30 card shadow-[var(--shadow)] py-1 anim-pop', align === 'right' ? 'right-0' : 'left-0')} style={{ width }} role="menu">
        {items.map((it, i) => it.divider ? <div key={i} className="my-1 border-t border-line" /> : (
          <button key={i} role="menuitem" disabled={it.disabled} title={it.hint} onClick={e => { e.stopPropagation(); setOpen(false); it.onClick?.(); }}
            className={cx('w-full flex items-center gap-2 px-3 h-8 text-left text-[13px] hover:bg-surface-2 disabled:opacity-45 disabled:cursor-not-allowed', it.danger && 'text-t-red')}>{it.icon}<span className="truncate">{it.label}</span></button>
        ))}
      </div>}
    </div>
  );
}

// ---------- Primitives ----------
type Tone = 'gray' | 'blue' | 'green' | 'amber' | 'red' | 'violet' | 'orange';
const TONES: Record<Tone, [string, string]> = { gray: ['var(--fg-3)', 'var(--t-gray)'], blue: ['var(--s1)', 'var(--t-blue)'], green: ['var(--good)', 'var(--t-green)'], amber: ['var(--warn)', 'var(--t-amber)'], red: ['var(--critical)', 'var(--t-red)'], violet: ['var(--s7)', 'var(--t-violet)'], orange: ['var(--serious)', 'var(--t-orange)'] };
export function Badge({ tone = 'gray', children, dot, title }: { tone?: Tone; children: ReactNode; dot?: boolean; title?: string }) {
  return <span className="badge" title={title} style={{ ['--bc' as any]: TONES[tone][0], ['--bt' as any]: TONES[tone][1] }}>{dot && <span className="w-1.5 h-1.5 rounded-full" style={{ background: TONES[tone][0] }} />}{children}</span>;
}
const STATUS_TONE: Record<string, Tone> = {
  Draft: 'gray', 'Pending Approval': 'amber', Presented: 'blue', Accepted: 'green', Rejected: 'red', Countered: 'violet', Expired: 'gray', Withdrawn: 'gray',
  Sent: 'blue', 'Awaiting Signature': 'amber', 'Fully Executed': 'green', 'Under Review': 'amber', Assigned: 'violet', 'Closing Pending': 'amber', Closed: 'green', Terminated: 'red',
  'Under Contract': 'blue', 'Title Opened': 'blue', 'Marketing to Buyers': 'violet', 'Buyer Found': 'amber', 'Clear to Close': 'green', Cancelled: 'red',
  Active: 'green', 'Buyer Selected': 'amber', Matched: 'gray', Opened: 'blue', Responded: 'blue', 'Requested Info': 'violet', 'Showing Requested': 'violet', 'Offer Made': 'amber', Passed: 'gray',
  Open: 'blue', 'In Progress': 'amber', Done: 'green', Urgent: 'red', High: 'orange', Normal: 'gray', Low: 'gray', Medium: 'amber', Unknown: 'gray',
  Planned: 'gray', Paused: 'amber', Completed: 'green', Stopped: 'gray', Logged: 'gray', Queued: 'amber', Failed: 'red',
  success: 'green', failed: 'red', skipped: 'gray', ok: 'green', not_run: 'gray', active: 'green', invited: 'amber', disabled: 'gray',
  Verified: 'green', Received: 'blue', Requested: 'amber', 'Not Requested': 'gray', Hot: 'red', Warm: 'amber', Cold: 'blue',
  'Excellent deal': 'green', 'Potential deal': 'blue', 'Marginal deal': 'amber', 'Poor deal': 'red', Incomplete: 'gray',
  connected: 'green', not_configured: 'gray', built_in: 'blue', planned: 'gray',
};
export const StatusBadge = ({ value, dot = true }: { value?: string | null; dot?: boolean }) => (value ? <Badge tone={STATUS_TONE[value] ?? 'gray'} dot={dot}>{value.replace(/_/g, ' ')}</Badge> : <span className="muted">—</span>);
export const DemoTag = () => <span className="inline-flex items-center h-4 px-1 rounded text-[9px] font-bold tracking-wider border border-dashed border-line-strong text-fg-3" title="Demonstration record — remove all demo data in Settings">DEMO</span>;
export const ScorePill = ({ score }: { score?: number | null }) => {
  if (score === null || score === undefined) return <span className="muted">—</span>;
  const c = score >= 70 ? 'var(--critical)' : score >= 45 ? 'var(--warn)' : 'var(--s1)';
  return <span className="inline-flex items-center gap-1.5 tnum font-medium" title={score >= 70 ? 'Hot' : score >= 45 ? 'Warm' : 'Cold'}><span className="w-8 h-1.5 rounded-full bg-surface-3 overflow-hidden"><span className="block h-full rounded-full" style={{ width: `${score}%`, background: c }} /></span>{score}</span>;
};
export function Avatar({ name, size = 22 }: { name?: string | null; size?: number }) {
  if (!name) return <span className="inline-flex items-center justify-center rounded-full border border-dashed border-line-strong text-fg-3" style={{ width: size, height: size, fontSize: size * 0.45 }}>?</span>;
  const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return <span className="inline-flex items-center justify-center rounded-full font-semibold shrink-0" title={name} style={{ width: size, height: size, fontSize: size * 0.42, background: `hsl(${hue} 45% 88%)`, color: `hsl(${hue} 45% 28%)` }}>{initials(name)}</span>;
}
export const UserChip = ({ name }: { name?: string | null }) => (name ? <span className="inline-flex items-center gap-1.5 min-w-0"><Avatar name={name} size={18} /><span className="truncate">{name}</span></span> : <span className="muted">Unassigned</span>);

export const Spinner = ({ size = 14 }: { size?: number }) => <Loader2 size={size} className="animate-spin" />;
export function Loading({ rows = 6 }: { rows?: number }) { return <div className="p-4 space-y-2.5" aria-busy="true">{Array.from({ length: rows }).map((_, i) => <div key={i} className="skeleton h-8" style={{ width: `${92 - (i % 3) * 14}%` }} />)}</div>; }
export function Empty({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: ReactNode; action?: ReactNode }) {
  return <div className="flex flex-col items-center justify-center text-center py-12 px-6"><div className="w-10 h-10 rounded-lg bg-surface-2 border border-line flex items-center justify-center text-fg-3 mb-3">{icon ?? <Info size={18} />}</div><div className="font-semibold">{title}</div>{body && <div className="text-fg-2 mt-1 max-w-sm leading-relaxed">{body}</div>}{action && <div className="mt-4">{action}</div>}</div>;
}
export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  const denied = error instanceof ApiError && error.status === 403;
  return <Empty icon={<AlertTriangle size={18} />} title={denied ? 'You do not have access to this' : 'Something went wrong'} body={error instanceof Error ? error.message : String(error)} action={retry && !denied ? <button className="btn" onClick={retry}>Try again</button> : undefined} />;
}
export function PageHeader({ title, subtitle, children }: { title: ReactNode; subtitle?: ReactNode; children?: ReactNode }) {
  return <div className="flex flex-wrap items-end justify-between gap-3 mb-4"><div className="min-w-0"><h1 className="text-lg font-semibold tracking-tight">{title}</h1>{subtitle && <p className="text-fg-2 mt-0.5">{subtitle}</p>}</div><div className="flex flex-wrap items-center gap-2">{children}</div></div>;
}
export function Tabs<T extends string>({ tabs, value, onChange, className }: { tabs: { id: T; label: ReactNode; count?: number }[]; value: T; onChange: (v: T) => void; className?: string }) {
  return <div className={cx('flex items-center gap-4 border-b border-line overflow-x-auto scroll-thin', className)} role="tablist">{tabs.map(t => (
    <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)} className={cx('relative h-9 text-[13px] font-medium whitespace-nowrap transition-colors', value === t.id ? 'text-fg' : 'text-fg-3 hover:text-fg-2')}>
      {t.label}{t.count !== undefined && <span className="ml-1.5 text-[11px] text-fg-3 tnum">{t.count}</span>}{value === t.id && <span className="absolute left-0 right-0 -bottom-px h-0.5 bg-accent rounded-full" />}
    </button>))}</div>;
}
export function Segmented<T extends string>({ options, value, onChange }: { options: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return <div className="inline-flex p-0.5 rounded-md bg-surface-2 border border-line">{options.map(o => <button key={o.id} onClick={() => onChange(o.id)} className={cx('h-7 px-2.5 rounded text-xs font-medium inline-flex items-center gap-1.5 transition-colors', value === o.id ? 'bg-surface text-fg shadow-sm' : 'text-fg-3 hover:text-fg-2')}>{o.label}</button>)}</div>;
}
export function Stat({ label, value, sub, delta, onClick, invert }: { label: string; value: ReactNode; sub?: ReactNode; delta?: number | null; onClick?: () => void; invert?: boolean }) {
  const good = delta !== null && delta !== undefined && (invert ? delta < 0 : delta > 0);
  const C: any = onClick ? 'button' : 'div';
  return (
    <C onClick={onClick} className={cx('card p-3.5 text-left min-w-0', onClick && 'hover:border-line-strong transition-colors cursor-pointer')} title={onClick ? 'View the records behind this number' : undefined}>
      <div className="text-xs text-fg-2 truncate">{label}</div>
      <div className="mt-1 text-xl font-semibold tracking-tight tnum truncate">{value}</div>
      <div className="mt-0.5 h-4 text-[11px] text-fg-3 flex items-center gap-1.5 truncate">
        {delta !== null && delta !== undefined && Number.isFinite(delta) && <span className={cx('font-medium', delta === 0 ? 'text-fg-3' : good ? 'text-t-green' : 'text-t-red')}>{delta > 0 ? '▲' : delta < 0 ? '▼' : '•'} {Math.abs(delta).toFixed(0)}%</span>}
        <span className="truncate">{sub === 'vs previous period' && (delta === null || delta === undefined || !Number.isFinite(delta)) ? 'no earlier data to compare' : sub}</span>
      </div>
    </C>
  );
}
export function Field({ label, children, help, error, span }: { label?: string; children: ReactNode; help?: string; error?: string; span?: boolean }) {
  return <div className={span ? 'sm:col-span-2' : ''} role={label ? 'group' : undefined} aria-label={label?.replace(/ \*$/, '')}>{label && <span className="label">{label}</span>}{children}{error ? <div className="mt-1 text-xs text-t-red">{error}</div> : help ? <div className="mt-1 text-[11px] text-fg-3 leading-snug">{help}</div> : null}</div>;
}
export function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} className={cx('relative w-8 h-[18px] rounded-full transition-colors shrink-0 disabled:opacity-50', checked ? 'bg-accent' : 'bg-surface-3 border border-line-strong')}><span className={cx('absolute top-[2px] w-3.5 h-3.5 rounded-full bg-white shadow transition-all', checked ? 'left-[16px]' : 'left-[2px]')} /></button>;
}
export function KV({ rows, cols = 2 }: { rows: [string, ReactNode][]; cols?: 1 | 2 | 3 }) {
  return <dl className={cx('grid gap-x-6 gap-y-2.5', cols === 3 ? 'grid-cols-2 lg:grid-cols-3' : cols === 2 ? 'grid-cols-2' : 'grid-cols-1')}>{rows.map(([k, v]) => <div key={k} className="min-w-0"><dt className="text-[11px] text-fg-3">{k}</dt><dd className="mt-0.5 break-words">{v === null || v === undefined || v === '' ? <span className="muted">—</span> : v}</dd></div>)}</dl>;
}
export function Card({ title, actions, children, className, pad = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return <section className={cx('card', className)}>{title && <div className="card-h"><h3 className="card-t truncate">{title}</h3><div className="flex items-center gap-1.5 shrink-0">{actions}</div></div>}<div className={pad ? 'p-4' : ''}>{children}</div></section>;
}
export function Collapse({ title, children, defaultOpen = false, count }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean; count?: number }) {
  const [open, setOpen] = useState(defaultOpen);
  return <div><button onClick={() => setOpen(o => !o)} className="flex items-center gap-1.5 text-xs font-medium text-fg-2 hover:text-fg"><ChevronDown size={13} className={cx('transition-transform', !open && '-rotate-90')} />{title}{count !== undefined && <span className="text-fg-3 tnum">{count}</span>}</button>{open && <div className="mt-2">{children}</div>}</div>;
}
/** Runs an async action with a busy flag and toasts errors. */
export function useBusy() {
  const [busy, setBusy] = useState(false);
  const run = async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
    setBusy(true);
    try { const r = await fn(); if (success) toast.success(success); return r; } catch (e) { toast.error(e); return undefined; } finally { setBusy(false); }
  };
  return { busy, run };
}
