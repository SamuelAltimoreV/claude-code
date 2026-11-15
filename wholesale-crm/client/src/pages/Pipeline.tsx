import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlarmClock, Settings2, UserPlus } from 'lucide-react';
import { contactName } from '@shared/logic';
import { useBoot, useData, usePerms, type R } from '@/lib/app';
import { daysSince, money } from '@/lib/format';
import { Avatar, cx, DemoTag, ErrorBox, Loading, PageHeader, ScorePill } from '@/ui/core';
import { openAction } from '@/ui/actions';
import { useNames, useStageChange } from '@/ui/shared';

export default function Pipeline() {
  const { settings, users } = useBoot();
  const d = useData('leads', 'contacts', 'properties');
  const perms = usePerms(), nav = useNavigate(), name = useNames(), changeStage = useStageChange();
  const [owner, setOwner] = useState(''), [source, setSource] = useState(''), [text, setText] = useState(''), [drag, setDrag] = useState<string | null>(null), [over, setOver] = useState<string | null>(null), [allDone, setAllDone] = useState(false);
  const c = useMemo(() => new Map(d.contacts.map(x => [x.id, x])), [d.contacts]), p = useMemo(() => new Map(d.properties.map(x => [x.id, x])), [d.properties]);
  const leads = useMemo(() => { const t = text.trim().toLowerCase(); return d.leads.filter(l => (!owner || l.owner_id === owner) && (!source || l.source === source) && (!t || `${contactName(c.get(l.contact_id))} ${p.get(l.property_id)?.address ?? ''} ${p.get(l.property_id)?.city ?? ''}`.toLowerCase().includes(t))); }, [d.leads, owner, source, text, c, p]);
  const stages = settings.stages, idx = new Map(stages.map((s, i) => [s.id, i]));
  const alive = leads.filter(l => stages[idx.get(l.stage) ?? 0]?.milestone !== 'dead');
  const reached = (i: number) => alive.filter(l => (idx.get(l.stage) ?? 0) >= i).length;
  const now = new Date().toISOString(), canWrite = perms.write('leads');
  if (d.error) return <ErrorBox error={d.error} />;
  return (
    <div className="flex flex-col" style={{ height: 'calc(100vh - 150px)', minHeight: 480 }}>
      <PageHeader title="Acquisition Pipeline" subtitle="Drag a lead to move it. Stage changes are logged and trigger automations.">
        <input className="input !w-44" placeholder="Search…" value={text} onChange={e => setText(e.target.value)} aria-label="Search pipeline" />
        <select className="input !w-auto" value={owner} onChange={e => setOwner(e.target.value)} aria-label="Owner"><option value="">All owners</option>{users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
        <select className="input !w-auto" value={source} onChange={e => setSource(e.target.value)} aria-label="Source"><option value="">All sources</option>{settings.sources.map(s => <option key={s}>{s}</option>)}</select>
        {perms.admin('settings') && <Link className="btn" to="/settings?tab=pipeline"><Settings2 size={14} />Customize stages</Link>}
        {canWrite && <button className="btn btn-primary" onClick={() => openAction({ type: 'lead' })}><UserPlus size={14} />New lead</button>}
      </PageHeader>
      {d.loading ? <Loading /> : (
        <div className="flex-1 min-h-0 flex gap-3 overflow-x-auto scroll-thin pb-2">
          {stages.map((s, i) => {
            const terminal = s.milestone === 'closed' || s.milestone === 'dead';
            let list = leads.filter(l => l.stage === s.id).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
            const total = list.length, value = list.reduce((t, l) => t + (Number(l.est_fee) || 0), 0);
            const ages = list.map(l => daysSince(l.stage_changed_at)).filter((x): x is number => x !== null), avgAge = ages.length ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : null;
            const here = reached(i), next = i < stages.length - 1 && !terminal ? reached(i + 1) : null, conv = next !== null && here > 0 ? Math.round((next / here) * 100) : null;
            const owners = [...new Set(list.map(l => l.owner_id).filter(Boolean))].slice(0, 4);
            if (terminal && !allDone) list = list.filter(l => (daysSince(l.stage_changed_at) ?? 0) <= 30);
            return (
              <div key={s.id} className={cx('w-[272px] shrink-0 flex flex-col rounded-lg border bg-surface-2 transition-colors', over === s.id && drag ? 'border-accent bg-accent-soft' : 'border-line')}
                onDragOver={e => { if (drag) { e.preventDefault(); setOver(s.id); } }} onDragLeave={() => setOver(o => (o === s.id ? null : o))}
                onDrop={e => { e.preventDefault(); const lead = d.leads.find(l => l.id === drag); setDrag(null); setOver(null); if (lead) void changeStage(lead, s.id); }}>
                <div className="px-3 pt-2.5 pb-2 border-b border-line">
                  <div className="flex items-center gap-2"><span className="w-2 h-2 rounded-full shrink-0" style={{ background: s.color }} /><span className="font-semibold truncate flex-1">{s.name}</span><span className="tnum text-fg-2 font-medium">{total}</span></div>
                  <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-fg-3"><span className="tnum" title="Total projected assignment fees in this stage">{value ? money(value, true) : '—'}</span><span className="tnum" title="Average days in this stage">{avgAge !== null ? `${avgAge}d avg` : ''}</span><span className="tnum" title="Share of leads that reached this stage and moved on to the next">{conv !== null ? `${conv}% advance` : ''}</span>
                    <span className="flex -space-x-1">{owners.map(o => <Avatar key={o} name={name(o)} size={16} />)}</span></div>
                </div>
                <div className="flex-1 overflow-y-auto scroll-thin p-2 space-y-2">
                  {list.map(l => { const ct = c.get(l.contact_id), pr = p.get(l.property_id), age = daysSince(l.stage_changed_at), late = l.next_follow_up && l.next_follow_up < now, none = !l.next_follow_up && !terminal && s.milestone !== 'contract'; return (
                    <div key={l.id} draggable={canWrite} onDragStart={e => { setDrag(l.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', l.id); }} onDragEnd={() => { setDrag(null); setOver(null); }} onClick={() => nav(`/leads/${l.id}`)}
                      className={cx('card p-2.5 cursor-pointer hover:border-line-strong shadow-[0_1px_1px_rgb(0_0_0/0.03)]', drag === l.id && 'opacity-40')} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') nav(`/leads/${l.id}`); }}>
                      <div className="flex items-start justify-between gap-2"><span className="font-medium truncate">{contactName(ct)}</span>{l.is_demo && <DemoTag />}</div>
                      <div className="text-fg-3 text-xs truncate mt-0.5">{pr ? `${pr.address}, ${pr.city ?? ''}` : 'No property yet'}</div>
                      <div className="mt-2 flex items-center justify-between gap-2"><ScorePill score={l.score} /><span className="flex items-center gap-2 text-[11px] text-fg-3">
                        {(late || none) && <span className={cx('inline-flex items-center gap-0.5', late ? 'text-t-red' : 'text-t-amber')} title={late ? 'Follow-up overdue' : 'No follow-up scheduled'}><AlarmClock size={11} />{late ? 'Overdue' : 'No follow-up'}</span>}
                        {l.est_fee ? <span className="tnum">{money(l.est_fee, true)}</span> : null}{age !== null && <span className="tnum" title="Days in stage">{age}d</span>}<Avatar name={name(l.owner_id)} size={18} /></span></div>
                    </div>); })}
                  {list.length === 0 && <div className="text-center text-[11px] text-fg-3 py-6">{total ? 'Older leads hidden' : drag ? 'Drop here' : 'No leads'}</div>}
                  {terminal && total > list.length && <button className="w-full text-[11px] text-fg-3 hover:text-fg py-1" onClick={() => setAllDone(true)}>Show {total - list.length} older</button>}
                </div>
              </div>);
          })}
        </div>
      )}
    </div>
  );
}
