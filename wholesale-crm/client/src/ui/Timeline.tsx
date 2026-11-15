import { useMemo, useState } from 'react';
import { ArrowRightLeft, Banknote, Calculator, CheckSquare, FileSignature, FileText, HandCoins, Megaphone, MessageSquare, Paperclip, Phone, PlusCircle, Repeat, ShieldAlert, StickyNote, Trash2, UserCheck } from 'lucide-react';
import { useBoot, useWrite, type R } from '@/lib/app';
import { ago, fdatetime, localDay } from '@/lib/format';
import { cx, Empty, Spinner, toast } from './core';

const ICON: Record<string, [any, string]> = {
  created: [PlusCircle, 'var(--fg-3)'], stage: [ArrowRightLeft, 'var(--s7)'], comm: [Phone, 'var(--s1)'], note: [StickyNote, 'var(--s4)'], task: [CheckSquare, 'var(--s3)'], offer: [HandCoins, 'var(--s2)'],
  contract: [FileSignature, 'var(--s3)'], transaction: [FileText, 'var(--s1)'], revenue: [Banknote, 'var(--good)'], dispo: [Megaphone, 'var(--s7)'], analysis: [Calculator, 'var(--s4)'], assignment: [UserCheck, 'var(--s1)'],
  sequence: [Repeat, 'var(--fg-3)'], compliance: [ShieldAlert, 'var(--critical)'], file: [Paperclip, 'var(--fg-3)'], update: [ArrowRightLeft, 'var(--fg-3)'],
};
const FILTERS: [string, string, string[]][] = [['all', 'All', []], ['comm', 'Conversations', ['comm']], ['note', 'Notes', ['note']], ['deal', 'Deal', ['offer', 'contract', 'transaction', 'revenue', 'dispo', 'analysis']], ['system', 'Changes', ['created', 'stage', 'assignment', 'task', 'sequence', 'compliance', 'file', 'update']]];

/** Chronological activity feed with an inline note composer. */
export function Timeline({ activities, scope, loading, canNote = true }: { activities: R[]; scope: R; loading?: boolean; canNote?: boolean }) {
  const { users, user } = useBoot();
  const w = useWrite();
  const [filter, setFilter] = useState('all'), [note, setNote] = useState(''), [busy, setBusy] = useState(false);
  const names = useMemo(() => new Map(users.map(u => [u.id, u.name])), [users]);
  const list = useMemo(() => { const types = FILTERS.find(f => f[0] === filter)![2]; return activities.filter(a => !types.length || types.includes(a.type)).sort((a, b) => String(b.at).localeCompare(String(a.at))); }, [activities, filter]);
  const groups = useMemo(() => { const g: [string, R[]][] = []; for (const a of list) { const d = localDay(a.at); if (g.length && g[g.length - 1][0] === d) g[g.length - 1][1].push(a); else g.push([d, [a]]); } return g; }, [list]);
  const add = async () => { if (!note.trim()) return; setBusy(true); try { await w.create('activities', { ...scope, body: note.trim() }); setNote(''); } catch (e) { toast.error(e); } finally { setBusy(false); } };
  return (
    <div>
      {canNote && <div className="mb-3"><textarea className="input" rows={2} placeholder="Add an internal note…  (Ctrl+Enter to save)" value={note} onChange={e => setNote(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void add(); }} />
        {note.trim() && <div className="flex justify-end mt-1.5"><button className="btn btn-primary btn-sm" disabled={busy} onClick={add}>{busy && <Spinner size={12} />}Save note</button></div>}</div>}
      <div className="flex items-center gap-1 mb-3 overflow-x-auto">{FILTERS.map(([id, label]) => <button key={id} onClick={() => setFilter(id)} className={cx('h-6 px-2 rounded text-xs font-medium whitespace-nowrap', filter === id ? 'bg-surface-3 text-fg' : 'text-fg-3 hover:text-fg-2')}>{label}</button>)}</div>
      {loading ? <div className="space-y-2">{[0, 1, 2].map(i => <div key={i} className="skeleton h-10" />)}</div> : list.length === 0 ? <Empty title="No activity yet" body="Calls, notes, stage changes, offers and contract updates will appear here in order." /> : (
        <div className="space-y-4">{groups.map(([day, items]) => (
          <div key={day}><div className="text-[11px] font-medium text-fg-3 mb-2">{new Date(day + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</div>
            <ol className="relative ml-[11px] border-l border-line space-y-3">{items.map(a => { const [Icon, color] = a.type === 'comm' && a.data?.type && a.data.type !== 'Call' ? [MessageSquare, 'var(--s1)'] : ICON[a.type] ?? ICON.update; return (
              <li key={a.id} className="relative pl-5 group">
                <span className="absolute -left-[11px] top-0 w-[22px] h-[22px] rounded-full bg-surface border border-line flex items-center justify-center"><Icon size={11} style={{ color }} /></span>
                <div className="flex items-baseline justify-between gap-2"><span className="font-medium leading-[22px]">{a.summary}</span><span className="text-[11px] text-fg-3 whitespace-nowrap shrink-0" title={fdatetime(a.at)}>{ago(a.at)}</span></div>
                {a.body && <div className="mt-0.5 text-fg-2 whitespace-pre-wrap leading-relaxed">{a.body}</div>}
                <div className="mt-0.5 text-[11px] text-fg-3 flex items-center gap-2">{a.user_id ? names.get(a.user_id) ?? 'Former team member' : a.data?.origin === 'import' ? 'Import' : 'Automation / system'}{a.data?.automatic && a.user_id && <span>· automatic</span>}
                  {a.type === 'note' && a.user_id === user.id && <button className="opacity-0 group-hover:opacity-100 hover:text-t-red" aria-label="Delete note" onClick={() => w.remove('activities', a.id).catch(toast.error)}><Trash2 size={11} /></button>}</div>
              </li>); })}</ol>
          </div>))}</div>
      )}
    </div>
  );
}
