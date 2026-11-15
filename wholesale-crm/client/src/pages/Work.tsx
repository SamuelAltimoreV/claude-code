import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, MessageSquare, Phone, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { contactName } from '@shared/logic';
import { COMM_TYPES } from '@shared/schema';
import { useBoot, useData, usePerms, useWrite, type R } from '@/lib/app';
import { fdate, fdatetime, ftime, localDay, todayIso } from '@/lib/format';
import { Badge, Card, confirmDialog, cx, Empty, ErrorBox, Loading, PageHeader, Segmented, StatusBadge, Tabs, toast } from '@/ui/core';
import { DataTable, type Col } from '@/ui/DataTable';
import { RecordModal } from '@/ui/Form';
import { newTask, openAction } from '@/ui/actions';
import { useNames } from '@/ui/shared';
import { TaskList } from './Leads';

export function CommunicationsPage() {
  const { settings, users, providers } = useBoot();
  const d = useData('communications', 'contacts', 'buyers', 'leads', 'templates', 'suppressions');
  const perms = usePerms(), w = useWrite(), nav = useNavigate(), name = useNames();
  const [tab, setTab] = useState<'log' | 'templates' | 'compliance'>('log'), [tpl, setTpl] = useState<R | null | 'new'>(null), [sup, setSup] = useState(false);
  const c = useMemo(() => new Map(d.contacts.map(x => [x.id, x])), [d.contacts]), b = useMemo(() => new Map(d.buyers.map(x => [x.id, x])), [d.buyers]);
  const who = (r: R) => (r.contact_id ? contactName(c.get(r.contact_id)) : b.get(r.buyer_id)?.name ?? '—');
  const cols: Col[] = [
    { key: 'at', label: 'When', render: r => fdatetime(r.at), width: 150 }, { key: 'type', label: 'Type', render: r => <span className="inline-flex items-center gap-1.5">{r.type === 'Call' || r.type === 'Voicemail' ? <Phone size={12} className="text-fg-3" /> : <MessageSquare size={12} className="text-fg-3" />}{r.type}</span> },
    { key: 'direction', label: 'Direction', render: r => <Badge tone={r.direction === 'Inbound' ? 'green' : r.direction === 'Missed' ? 'red' : 'gray'}>{r.direction}</Badge> },
    { key: 'who', label: 'With', value: who, render: r => <span className="font-medium">{who(r)} <span className="font-normal text-fg-3">{r.buyer_id ? '· buyer' : '· seller'}</span></span> },
    { key: 'outcome', label: 'Outcome' }, { key: 'duration_min', label: 'Min', align: 'right' }, { key: 'body', label: 'Notes / message', width: 320 }, { key: 'next_action', label: 'Next action', hidden: true },
    { key: 'user', label: 'Team member', value: r => name(r.user_id) }, { key: 'status', label: 'Delivery', render: r => (r.status && r.status !== 'Logged' ? <StatusBadge value={r.status} /> : <span className="text-fg-3">Logged manually</span>) },
  ];
  const dnc = [...d.contacts.filter(x => x.dnc).map(x => ({ id: x.id, name: contactName(x), kind: 'Seller', phone: x.phone, email: x.email, at: x.opted_out_at })), ...d.buyers.filter(x => x.dnc).map(x => ({ id: x.id, name: x.name, kind: 'Buyer', phone: x.phone, email: x.email, at: x.opted_out_at }))];
  const consent = { sms: d.contacts.filter(x => x.sms_opt_in && !x.dnc).length, email: d.contacts.filter(x => x.email_opt_in && !x.dnc).length, total: d.contacts.length };
  if (d.error) return <ErrorBox error={d.error} />;
  return (
    <div>
      <PageHeader title="Communications" subtitle="Every call, text, email and in-person conversation, linked to its seller or buyer.">
        {perms.write('communications') && <button className="btn btn-primary" onClick={() => openAction({ type: 'call' })}><Phone size={14} />Log a conversation</button>}
      </PageHeader>
      <div className="grid sm:grid-cols-3 gap-3 mb-4">{([['SMS (Twilio)', providers.sms], ['Email (SMTP)', providers.email], ['Calling platform', false]] as [string, boolean][]).map(([l, on]) => <div key={l} className="card px-3.5 py-2.5 flex items-center gap-2.5"><span className={cx('w-2 h-2 rounded-full', on ? 'bg-good' : 'bg-surface-3 border border-line-strong')} /><span className="font-medium">{l}</span><span className="text-fg-3 flex-1 truncate">{on ? 'Connected' : l.startsWith('Calling') ? 'No connector — log calls manually' : 'Not connected — sending disabled'}</span>{!on && <Link className="link text-xs" to="/integrations">Set up</Link>}</div>)}</div>
      <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[{ id: 'log', label: 'Conversation log', count: d.communications.length }, { id: 'templates', label: 'Templates', count: d.templates.length }, { id: 'compliance', label: 'Compliance & consent' }]} />
      {tab === 'log' && <DataTable rows={d.communications} cols={cols} loading={d.loading} viewKey="communications" exportName="communications" initialSort={{ key: 'at', dir: -1 }} onRowClick={r => { const lead = r.lead_id ?? d.leads.find(l => l.contact_id === r.contact_id)?.id; nav(lead ? `/leads/${lead}` : r.buyer_id ? `/buyers/${r.buyer_id}` : '/communications'); }}
        filters={[{ key: 'type', label: 'Type', options: COMM_TYPES.map(s => ({ value: s, label: s })), get: r => r.type }, { key: 'dir', label: 'Direction', options: ['Outbound', 'Inbound', 'Missed'].map(s => ({ value: s, label: s })), get: r => r.direction },
          { key: 'outcome', label: 'Outcome', options: settings.callOutcomes.map(s => ({ value: s, label: s })), get: r => r.outcome }, { key: 'user', label: 'Team member', options: users.map(u => ({ value: u.id, label: u.name })), get: r => r.user_id }]}
        empty={<Empty icon={<Phone size={18} />} title="No conversations logged yet" body="Log calls, texts, emails and visits so every lead has a complete history." />} />}
      {tab === 'templates' && <div>
        <div className="flex justify-between items-center mb-3"><p className="text-fg-2">Reusable messages, call scripts and offer summaries. Merge fields: <code className="text-xs">{'{{first_name}} {{property_address}} {{agent_name}} {{company_name}} {{offer_amount}}'}</code></p>{perms.write('communications') && <button className="btn" onClick={() => setTpl('new')}><Plus size={14} />New template</button>}</div>
        {d.templates.length === 0 ? <Empty title="No templates" /> : <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">{d.templates.map(t => <button key={t.id} className="card p-4 text-left hover:border-line-strong" onClick={() => perms.write('communications') && setTpl(t)}><div className="flex items-center justify-between gap-2 mb-1.5"><span className="font-semibold truncate">{t.name}</span><Badge tone={t.channel === 'SMS' ? 'blue' : t.channel === 'Email' ? 'violet' : 'gray'}>{t.channel}</Badge></div>{t.subject && <div className="text-fg-2 truncate mb-1">Subject: {t.subject}</div>}<div className="text-fg-3 line-clamp-4 whitespace-pre-wrap text-xs leading-relaxed">{t.body}</div></button>)}</div>}
      </div>}
      {tab === 'compliance' && <div className="grid lg:grid-cols-2 gap-4 items-start">
        <Card title={<span className="inline-flex items-center gap-1.5"><ShieldCheck size={14} />How outreach is protected</span>}>
          <ul className="space-y-2 leading-relaxed list-disc ml-4 text-fg-2">
            <li><b className="text-fg">Do Not Contact always wins.</b> A person marked DNC cannot be messaged, enrolled in a sequence or reached by any automation. Their phone and email are added to the suppression list.</li>
            <li><b className="text-fg">Consent is required and timestamped.</b> Texts need recorded SMS consent{settings.comms.requireSmsConsent ? '' : ' (currently turned OFF in Settings)'}; emails need recorded email consent{settings.comms.requireEmailConsent ? '' : ' (currently turned OFF in Settings)'}. Each consent stores when and how it was obtained.</li>
            <li><b className="text-fg">Opt-outs are automatic.</b> A reply of STOP (with Twilio connected) or a click on the unsubscribe link removes consent and adds a suppression.</li>
            <li><b className="text-fg">Quiet hours.</b> Texts and automated outreach only go out between {settings.comms.quietStart}:00 and {settings.comms.quietEnd}:00 ({settings.company.timezone}).</li>
            <li><b className="text-fg">Emails identify you.</b> Every email carries your company name, mailing address and an unsubscribe link.</li>
          </ul>
          <p className="mt-3 text-[11px] text-fg-3 leading-relaxed">These controls support TCPA, CAN-SPAM and do-not-call compliance but are not legal advice. You are responsible for scrubbing call lists against the National and Ohio do-not-call registries, registering your texting numbers (A2P 10DLC) and following Ohio telephone solicitation rules. Consult counsel for your outreach program.</p>
          <div className="mt-4 grid grid-cols-3 gap-3">{[['Sellers with SMS consent', consent.sms], ['Sellers with email consent', consent.email], ['Do not contact', dnc.length]].map(([l, v]) => <div key={l as string} className="card p-3"><div className="text-[11px] text-fg-3">{l}</div><div className="text-lg font-semibold tnum">{v}<span className="text-fg-3 text-xs font-normal">{l !== 'Do not contact' ? ` / ${consent.total}` : ''}</span></div></div>)}</div>
        </Card>
        <div className="space-y-4">
          <Card title="Suppression list" actions={perms.write('communications') && <button className="btn btn-sm" onClick={() => setSup(true)}><Plus size={12} />Add</button>} pad={false}>
            {d.suppressions.length === 0 ? <div className="p-6 text-center text-fg-3">No suppressed phone numbers or emails.</div> : <div className="max-h-72 overflow-auto scroll-thin divide-y divide-line">{d.suppressions.map(s => <div key={s.id} className="flex items-center gap-3 px-4 h-10"><Badge>{s.kind}</Badge><span className="font-medium tnum">{s.value}</span><span className="text-fg-3 truncate flex-1">{s.reason} · {s.source} · {fdate(s.created_at)}</span>
              {perms.del('communications') && <button className="btn btn-ghost btn-icon btn-sm" aria-label="Remove suppression" onClick={async () => { if (await confirmDialog({ title: 'Remove from suppression list?', body: `Only do this if ${s.value} has given new consent. Removing it allows outreach to resume if consent is also recorded on their record.`, danger: true, confirm: 'Remove' })) w.remove('suppressions', s.id).catch(toast.error); }}><Trash2 size={12} /></button>}</div>)}</div>}
          </Card>
          <Card title="Do-not-contact records" pad={false}>{dnc.length === 0 ? <div className="p-6 text-center text-fg-3">Nobody is marked do-not-contact.</div> : <div className="divide-y divide-line">{dnc.map(x => <div key={x.id} className="flex items-center gap-3 px-4 h-10"><span className="font-medium">{x.name}</span><Badge>{x.kind}</Badge><span className="text-fg-3 flex-1 truncate">{[x.phone, x.email].filter(Boolean).join(' · ')}</span><span className="text-[11px] text-fg-3">{fdate(x.at)}</span></div>)}</div>}</Card>
        </div>
      </div>}
      <RecordModal entity="templates" open={!!tpl} onClose={() => setTpl(null)} record={tpl === 'new' ? null : tpl} size="md" />
      <RecordModal entity="suppressions" open={sup} onClose={() => setSup(false)} fields={['kind', 'value', 'reason']} defaults={{ source: 'Manual' }} size="md" title="Add to suppression list" />
    </div>
  );
}

const startOfWeek = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - x.getDay()); return x; };
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function TasksPage() {
  const { user, users } = useBoot();
  const d = useData('tasks', 'leads', 'contacts', 'transactions', 'properties');
  const perms = usePerms(), name = useNames();
  const [view, setView] = useState<'day' | 'week' | 'month' | 'overdue' | 'upcoming' | 'team' | 'done'>('day'), [scope, setScope] = useState<'mine' | 'all'>('mine'), [cursor, setCursor] = useState(() => new Date());
  const teamAllowed = perms.scope('tasks') === 'all';
  const c = useMemo(() => new Map(d.contacts.map(x => [x.id, x])), [d.contacts]), l = useMemo(() => new Map(d.leads.map(x => [x.id, x])), [d.leads]), p = useMemo(() => new Map(d.properties.map(x => [x.id, x])), [d.properties]);
  const mine = scope === 'mine' || !teamAllowed;
  const tasks = useMemo(() => d.tasks.filter(t => !mine || t.assignee_id === user.id), [d.tasks, mine, user.id]);
  const open = tasks.filter(t => t.status === 'Open' || t.status === 'In Progress'), now = new Date().toISOString(), today = todayIso();
  const byDue = (a: R, b: R) => String(a.due_at ?? '9').localeCompare(String(b.due_at ?? '9'));
  const overdue = open.filter(t => t.due_at && t.due_at < now).sort(byDue), todays = open.filter(t => t.due_at && localDay(t.due_at) === today && t.due_at >= now).sort(byDue);
  const upcoming = open.filter(t => !t.due_at || localDay(t.due_at) > today).sort(byDue);
  const leadLink = (t: R) => { const lead = l.get(t.lead_id); return lead ? <> · <Link className="link" to={`/leads/${lead.id}`} onClick={e => e.stopPropagation()}>{contactName(c.get(lead.contact_id))}</Link></> : null; };
  const closings = d.transactions.filter(t => !['Closed', 'Cancelled'].includes(t.status) && t.closing_date);
  const dayMap = useMemo(() => { const m = new Map<string, R[]>(); for (const t of tasks) if (t.due_at && t.status !== 'Cancelled') { const k = localDay(t.due_at); (m.get(k) ?? m.set(k, []).get(k)!).push(t); } return m; }, [tasks]);
  const Chip = ({ t }: { t: R }) => <button onClick={() => openAction({ type: 'record', entity: 'tasks', record: t, exclude: ['offer_id', 'contract_id'] })} title={t.title} className={cx('w-full text-left px-1.5 py-0.5 rounded text-[11px] truncate border', t.status === 'Done' ? 'line-through text-fg-3 border-transparent' : t.due_at < now ? 'border-critical/40 bg-critical/5 text-t-red' : 'border-line bg-surface-2 hover:border-line-strong')}><span className="tnum text-fg-3 mr-1">{ftime(t.due_at).replace(':00', '').replace(' ', '').toLowerCase()}</span>{t.title}</button>;
  const DayCell = ({ day, dim, tall }: { day: Date; dim?: boolean; tall?: boolean }) => { const k = iso(day), list = (dayMap.get(k) ?? []).sort(byDue), cl = closings.filter(t => t.closing_date === k); return (
    <div className={cx('border-r border-b border-line p-1.5 min-w-0', tall ? 'min-h-[340px]' : 'min-h-[104px]', dim && 'bg-surface-2/60')}>
      <div className="flex items-center justify-between mb-1"><span className={cx('text-[11px] tnum w-5 h-5 inline-flex items-center justify-center rounded-full', k === today ? 'bg-accent text-accent-fg font-semibold' : dim ? 'text-fg-3' : 'text-fg-2')}>{day.getDate()}</span>{perms.write('tasks') && <button className="text-fg-3 hover:text-fg opacity-0 hover:opacity-100 focus:opacity-100" aria-label={`Add task on ${k}`} onClick={() => { const dt = new Date(day); dt.setHours(9, 0, 0, 0); newTask({ due_at: dt.toISOString() }); }}><Plus size={12} /></button>}</div>
      <div className="space-y-0.5">{cl.map(t => <Link key={t.id} to={`/transactions?open=${t.id}`} className="block px-1.5 py-0.5 rounded text-[11px] truncate bg-good/10 text-t-green" title={`Closing: ${p.get(t.property_id)?.address}`}>Closing · {p.get(t.property_id)?.address}</Link>)}{list.slice(0, tall ? 30 : 3).map(t => <Chip key={t.id} t={t} />)}{!tall && list.length > 3 && <button className="text-[11px] text-fg-3 hover:text-fg px-1.5" onClick={() => { setCursor(day); setView('week'); }}>+{list.length - 3} more</button>}</div>
    </div>); };
  const weekStart = startOfWeek(cursor), monthStart = startOfWeek(new Date(cursor.getFullYear(), cursor.getMonth(), 1));
  const shift = (n: number) => setCursor(cur => { const x = new Date(cur); view === 'week' ? x.setDate(x.getDate() + n * 7) : x.setMonth(x.getMonth() + n); return x; });
  if (d.error) return <ErrorBox error={d.error} />;
  return (
    <div>
      <PageHeader title="Tasks & Calendar" subtitle="Follow-ups, calls, underwriting and closing work — nothing slips.">
        {teamAllowed && <Segmented value={scope} onChange={setScope} options={[{ id: 'mine', label: 'My tasks' }, { id: 'all', label: 'Whole team' }]} />}
        {perms.write('tasks') && <button className="btn btn-primary" onClick={() => newTask()}><Plus size={14} />New task</button>}
      </PageHeader>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">{([['Overdue', overdue.length, 'overdue'], ['Due later today', todays.length, 'day'], ['Upcoming', upcoming.length, 'upcoming'], ['Completed', tasks.filter(t => t.status === 'Done').length, 'done']] as [string, number, any][]).map(([label, v, target]) => <button key={label} className="card p-3.5 text-left hover:border-line-strong" onClick={() => setView(target)}><div className="text-xs text-fg-2">{label}</div><div className={cx('mt-1 text-xl font-semibold tnum', label === 'Overdue' && v > 0 && 'text-t-red')}>{v}</div></button>)}</div>
      <Tabs className="mb-4" value={view} onChange={setView} tabs={[{ id: 'day', label: 'Today' }, { id: 'week', label: 'Week' }, { id: 'month', label: 'Month' }, { id: 'overdue', label: 'Overdue', count: overdue.length }, { id: 'upcoming', label: 'Upcoming', count: upcoming.length }, ...(teamAllowed ? [{ id: 'team' as const, label: 'Team' }] : []), { id: 'done', label: 'Completed' }]} />
      {d.loading ? <Loading /> : <>
        {view === 'day' && <div className="space-y-5 max-w-4xl">{overdue.length > 0 && <div><div className="section-t mb-2 !text-t-red">Overdue · {overdue.length}</div><TaskList tasks={overdue} showLead={leadLink} /></div>}
          <div><div className="section-t mb-2">Today · {todays.length}</div>{todays.length === 0 && overdue.length === 0 ? <Empty title="Nothing due today" body="Use the time to work your hottest leads or schedule follow-ups." /> : todays.length === 0 ? <div className="text-fg-3">Nothing else due today.</div> : <TaskList tasks={todays} showLead={leadLink} />}</div>
          {upcoming.length > 0 && <div><div className="section-t mb-2">Next up</div><TaskList tasks={upcoming.slice(0, 5)} showLead={leadLink} /></div>}</div>}
        {(view === 'week' || view === 'month') && <div className="card overflow-hidden">
          <div className="flex items-center justify-between px-4 h-11 border-b border-line"><div className="font-semibold">{view === 'week' ? `Week of ${weekStart.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}` : cursor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</div><div className="flex items-center gap-1"><button className="btn btn-sm" onClick={() => setCursor(new Date())}>Today</button><button className="btn btn-ghost btn-icon btn-sm" aria-label="Previous" onClick={() => shift(-1)}><ChevronLeft size={14} /></button><button className="btn btn-ghost btn-icon btn-sm" aria-label="Next" onClick={() => shift(1)}><ChevronRight size={14} /></button></div></div>
          <div className="overflow-x-auto"><div className="min-w-[760px]"><div className="grid grid-cols-7 border-b border-line">{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(x => <div key={x} className="px-2 h-7 flex items-center text-[11px] font-medium uppercase tracking-wide text-fg-3 border-r border-line">{x}</div>)}</div>
            <div className="grid grid-cols-7">{Array.from({ length: view === 'week' ? 7 : 42 }).map((_, i) => { const day = new Date(view === 'week' ? weekStart : monthStart); day.setDate(day.getDate() + i); return <DayCell key={i} day={day} tall={view === 'week'} dim={view === 'month' && day.getMonth() !== cursor.getMonth()} />; })}</div></div></div>
        </div>}
        {view === 'overdue' && <div className="max-w-4xl">{overdue.length ? <TaskList tasks={overdue} showLead={leadLink} /> : <Empty title="No overdue tasks" body="Everything is on schedule." />}</div>}
        {view === 'upcoming' && <div className="max-w-4xl">{upcoming.length ? <TaskList tasks={upcoming} showLead={leadLink} /> : <Empty title="No upcoming tasks" />}</div>}
        {view === 'done' && <div className="max-w-4xl"><TaskList tasks={tasks.filter(t => t.status === 'Done').sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at))).slice(0, 100)} showLead={leadLink} /></div>}
        {view === 'team' && <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">{users.filter(u => u.status === 'active').map(u => { const ut = d.tasks.filter(t => t.assignee_id === u.id && ['Open', 'In Progress'].includes(t.status)).sort(byDue), od = ut.filter(t => t.due_at && t.due_at < now).length; return (
          <Card key={u.id} title={<span>{u.name} <span className="font-normal text-fg-3">· {u.role}</span></span>} actions={<span className="text-xs tnum"><span className={od ? 'text-t-red font-medium' : 'text-fg-3'}>{od} overdue</span> · {ut.length} open</span>} pad={false}>
            {ut.length === 0 ? <div className="p-5 text-center text-fg-3">No open tasks</div> : <div className="divide-y divide-line">{ut.slice(0, 6).map(t => <button key={t.id} className="w-full flex items-center gap-2 px-4 h-9 text-left hover:bg-surface-2" onClick={() => openAction({ type: 'record', entity: 'tasks', record: t, exclude: ['offer_id', 'contract_id'] })}><span className="truncate flex-1">{t.title}</span><span className={cx('text-[11px] whitespace-nowrap', t.due_at && t.due_at < now ? 'text-t-red' : 'text-fg-3')}>{fdate(t.due_at)}</span></button>)}{ut.length > 6 && <div className="px-4 h-8 flex items-center text-[11px] text-fg-3">+{ut.length - 6} more</div>}</div>}
          </Card>); })}</div>}
      </>}
      <p className="mt-4 text-[11px] text-fg-3">Unassigned tasks: {d.tasks.filter(t => !t.assignee_id && ['Open', 'In Progress'].includes(t.status)).length}. Subscribe to your tasks in Google, Apple or Outlook calendar from <Link className="link" to="/integrations">Integrations → Calendar feed</Link>. {name(user.id) ? '' : ''}</p>
    </div>
  );
}
