import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Copy, Plug, Plus, Trash2, UserPlus } from 'lucide-react';
import { WEBHOOK_EVENTS } from '@shared/automation';
import * as M from '@shared/metrics';
import { ROLES } from '@shared/schema';
import { api, useBoot, useData, useDataset, usePerms, useWrite, type R } from '@/lib/app';
import { ago, fdate, fdatetime, money } from '@/lib/format';
import { Badge, Card, Collapse, confirmDialog, cx, ErrorBox, Field, Loading, Modal, PageHeader, promptDialog, Spinner, StatusBadge, Tabs, toast, useBusy, UserChip } from '@/ui/core';
import { DataTable, type Col } from '@/ui/DataTable';
import { RecordModal } from '@/ui/Form';
import { presetRange } from '@shared/metrics';

const copy = (text: string, label = 'Copied') => navigator.clipboard.writeText(text).then(() => toast.success(label), () => toast.error('Could not copy — select the text and copy it manually.'));

export function TeamPage() {
  const { users, user, providers } = useBoot();
  const { audit_logs } = useData('audit_logs');
  const { ds } = useDataset();
  const perms = usePerms(), w = useWrite();
  const [tab, setTab] = useState<'members' | 'performance' | 'activity'>('members'), [invite, setInvite] = useState(false), [form, setForm] = useState({ name: '', email: '', role: 'Acquisition Representative', department: '' }), [link, setLink] = useState<string | null>(null);
  const { busy, run } = useBusy();
  const admin = perms.admin('team');
  const stats = useMemo(() => new Map(M.teamStats(ds, presetRange('90d')).map(s => [s.user.id, s])), [ds]);
  const names = useMemo(() => new Map(users.map(u => [u.id, u.name])), [users]);
  const update = (id: string, body: R, msg: string) => w.call('PATCH', `/api/users/${id}`, body).then(async () => { await w.refreshBoot(); toast.success(msg); }).catch(toast.error);
  const cols: Col[] = [
    { key: 'name', label: 'Team member', width: 240, render: r => <span className="flex items-center gap-2"><UserChip name={r.name} />{r.id === user.id && <Badge>You</Badge>}{r.is_demo && <Badge>Demo</Badge>}</span> }, { key: 'email', label: 'Email', width: 240 },
    { key: 'role', label: 'Role', render: r => (admin && r.id !== user.id && r.status !== 'invited' ? <select className="input !h-7 !w-56 !text-xs" value={r.role} onClick={e => e.stopPropagation()} onChange={e => update(r.id, { role: e.target.value }, `${r.name} is now ${e.target.value}`)} aria-label={`Role for ${r.name}`}>{ROLES.map(x => <option key={x}>{x}</option>)}</select> : r.role) },
    { key: 'department', label: 'Department', render: r => (admin ? <button className="hover:underline text-left" title="Change department" onClick={async () => { const v = await promptDialog({ title: `Department for ${r.name}`, confirm: 'Save', input: { label: 'Department', initial: r.department ?? '', placeholder: 'e.g. Acquisitions' } }); if (v !== null) void update(r.id, { department: v }, 'Department updated'); }}>{r.department || <span className="muted">Set…</span>}</button> : r.department) }, { key: 'status', label: 'Status', render: r => <StatusBadge value={r.status} /> }, { key: 'last_login_at', label: 'Last sign-in', render: r => (r.last_login_at ? ago(r.last_login_at) : r.status === 'invited' ? 'Invite pending' : 'Never') },
    { key: 'actions', label: '', noSort: true, render: r => (admin && r.id !== user.id ? r.status === 'invited' ? <button className="btn btn-ghost btn-sm btn-danger" onClick={() => w.call('DELETE', `/api/users/${r.id}`).then(() => w.refreshBoot()).catch(toast.error)}>Revoke invite</button> : <button className="btn btn-ghost btn-sm" onClick={async () => { if (r.status === 'active' && !(await confirmDialog({ title: `Disable ${r.name}?`, body: 'They are signed out immediately and cannot sign in. Their records and history are kept.', danger: true, confirm: 'Disable' }))) return; void update(r.id, { status: r.status === 'active' ? 'disabled' : 'active' }, r.status === 'active' ? 'Account disabled' : 'Account re-enabled'); }}>{r.status === 'active' ? 'Disable' : 'Re-enable'}</button> : null) },
  ];
  const perfCols: Col[] = [{ key: 'name', label: 'Team member', value: r => r.user.name, render: r => <UserChip name={r.user.name} />, width: 220 }, { key: 'role', label: 'Role', value: r => r.user.role }, { key: 'calls', label: 'Calls', align: 'right' }, { key: 'conversations', label: 'Conversations', align: 'right' }, { key: 'qualified', label: 'Qualified', align: 'right' }, { key: 'offers', label: 'Offers', align: 'right' }, { key: 'contracts', label: 'Contracts', align: 'right' }, { key: 'closed', label: 'Closed', align: 'right' }, { key: 'revenue', label: 'Revenue', align: 'right', render: r => money(r.revenue) }, { key: 'tasksOverdue', label: 'Overdue tasks', align: 'right' }];
  const auditCols: Col[] = [{ key: 'created_at', label: 'When', render: r => <span title={fdatetime(r.created_at)}>{ago(r.created_at)}</span>, width: 110 }, { key: 'user', label: 'Who', value: r => names.get(r.user_id) ?? 'System / automation' }, { key: 'action', label: 'Action', render: r => <Badge tone={r.action === 'delete' ? 'red' : r.action === 'create' ? 'green' : 'blue'}>{r.action}</Badge> }, { key: 'entity', label: 'Record type' }, { key: 'summary', label: 'What changed', width: 520 }];
  return (
    <div>
      <PageHeader title="Team" subtitle="Members, roles, performance and an audit trail of important changes.">
        {admin && <button className="btn btn-primary" onClick={() => { setInvite(true); setLink(null); setForm({ name: '', email: '', role: 'Acquisition Representative', department: '' }); }}><UserPlus size={14} />Invite team member</button>}
      </PageHeader>
      <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[{ id: 'members', label: 'Members', count: users.length }, { id: 'performance', label: 'Performance (90 days)' }, { id: 'activity', label: 'Audit log', count: audit_logs.length }]} />
      {tab === 'members' && <><DataTable rows={users} cols={cols} noToolbar /><p className="mt-3 text-[11px] text-fg-3">What each role can see and do is set in <Link className="link" to="/settings?tab=roles">Settings → Roles & permissions</Link>. Permissions are enforced on the server for every request.</p></>}
      {tab === 'performance' && <DataTable rows={[...stats.values()].map(s => ({ ...s, id: s.user.id }))} cols={perfCols} exportName="team-performance-90d" initialSort={{ key: 'revenue', dir: -1 }} />}
      {tab === 'activity' && <DataTable rows={audit_logs} cols={auditCols} exportName="audit-log" initialSort={{ key: 'created_at', dir: -1 }} filters={[{ key: 'user', label: 'Who', options: users.map(u => ({ value: u.id, label: u.name })), get: r => r.user_id }, { key: 'action', label: 'Action', options: ['create', 'update', 'delete'].map(x => ({ value: x, label: x })), get: r => r.action }, { key: 'entity', label: 'Record type', options: [...new Set(audit_logs.map(a => a.entity))].map(x => ({ value: x, label: x })), get: r => r.entity }]} />}
      <Modal open={invite} onClose={() => setInvite(false)} size="sm" title="Invite a team member" footer={link ? <button className="btn btn-primary" onClick={() => setInvite(false)}>Done</button> : <><button className="btn" onClick={() => setInvite(false)}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={() => run(async () => { const r = await w.post('/api/users/invite', form); await w.refreshBoot(); setLink(r.inviteUrl); })}>{busy && <Spinner />}Create invite</button></>}>
        {link ? <div><div className="flex items-center gap-2 text-t-green font-medium mb-2"><CheckCircle2 size={16} />Invite created</div><p className="text-fg-2 mb-3">Send this one-time link to {form.name}. {providers.email ? 'It was not emailed automatically.' : 'No email provider is connected, so it was not emailed.'} They will choose their own password.</p><div className="flex gap-2"><input className="input text-xs" readOnly value={link} onFocus={e => e.target.select()} /><button className="btn" onClick={() => copy(link, 'Invite link copied')}><Copy size={13} />Copy</button></div></div>
          : <div className="space-y-3"><Field label="Full name"><input className="input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field><Field label="Email"><input className="input" type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></Field><Field label="Role"><select className="input" value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}>{ROLES.filter(r => r !== 'Owner' || user.role === 'Owner').map(r => <option key={r}>{r}</option>)}</select></Field><Field label="Department"><input className="input" list="depts" value={form.department} onChange={e => setForm({ ...form, department: e.target.value })} /><datalist id="depts">{['Acquisitions', 'Dispositions', 'Transactions', 'Leadership', 'Marketing'].map(x => <option key={x} value={x} />)}</datalist></Field></div>}
      </Modal>
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = { connected: 'Connected', not_configured: 'Not connected', built_in: 'Built in', planned: 'Not built yet' };

export function IntegrationsPage() {
  const { feedUrl, appUrl, settings } = useBoot();
  const { data: list, isLoading, error, refetch } = useQuery({ queryKey: ['x', 'integrations'], queryFn: () => api<R[]>('GET', '/api/integrations') });
  const d = useData('webhooks', 'integration_logs');
  const perms = usePerms(), w = useWrite();
  const [hook, setHook] = useState<R | null | 'new'>(null), [testing, setTesting] = useState<string | null>(null), [result, setResult] = useState<Record<string, { ok: boolean; message: string }>>({});
  const admin = perms.admin('integrations');
  const test = async (key: string) => { setTesting(key); try { const r = await api('POST', `/api/integrations/${key}/test`); setResult(s => ({ ...s, [key]: r })); await refetch(); await w.refresh(); } catch (e) { toast.error(e); } finally { setTesting(null); } };
  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const cats = [...new Set((list ?? []).map(i => i.category))];
  const logCols: Col[] = [{ key: 'created_at', label: 'When', render: r => <span title={fdatetime(r.created_at)}>{ago(r.created_at)}</span>, width: 110 }, { key: 'integration', label: 'Integration' }, { key: 'level', label: 'Level', render: r => <Badge tone={r.level === 'error' ? 'red' : 'gray'}>{r.level}</Badge> }, { key: 'message', label: 'Message', width: 640 }];
  return (
    <div>
      <PageHeader title="Integrations" subtitle="An integration only shows as connected when its credentials are configured on the server. Nothing here simulates a connection." />
      <div className="space-y-6">
        {cats.map(cat => <div key={cat}><div className="section-t mb-2">{cat}</div><div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">{(list ?? []).filter(i => i.category === cat).map(i => (
          <div key={i.key} className={cx('card p-4 flex flex-col', i.status === 'planned' && 'opacity-80')}>
            <div className="flex items-start justify-between gap-2"><div className="font-semibold">{i.name}</div><Badge tone={i.status === 'connected' ? 'green' : i.status === 'built_in' ? 'blue' : 'gray'} dot={i.status === 'connected'}>{STATUS_LABEL[i.status]}</Badge></div>
            <p className="text-fg-2 mt-1 flex-1">{i.description}</p><p className="text-[11px] text-fg-3 mt-1.5">Used for: {i.usedFor}</p>
            {i.last_error && !result[i.key] && <p className="mt-2 text-xs text-t-red">Last error: {i.last_error}</p>}{i.last_sync_at && !i.last_error && !result[i.key] && <p className="mt-2 text-[11px] text-fg-3">Last activity {ago(i.last_sync_at)}</p>}
            {result[i.key] && <p className={cx('mt-2 text-xs', result[i.key].ok ? 'text-t-green' : 'text-t-red')}>{result[i.key].message}</p>}
            <div className="mt-3 pt-3 border-t border-line"><Collapse title="Setup instructions"><ol className="list-decimal ml-4 space-y-1 text-fg-2 text-xs leading-relaxed">{i.setup.map((s: string, n: number) => <li key={n}>{s}</li>)}</ol>{i.envVars && <div className="mt-2 flex flex-wrap gap-1">{i.envVars.map((v: string) => <code key={v} className="text-[10px] px-1.5 py-0.5 rounded bg-surface-2 border border-line">{v}</code>)}</div>}
              {i.envVars && <p className="mt-2 text-[11px] text-fg-3">Credentials are read from server environment variables and are never stored in the database or shown in the browser.</p>}</Collapse>
              {i.testable && admin && <button className="btn btn-sm mt-2.5" disabled={testing === i.key} onClick={() => test(i.key)}>{testing === i.key ? <Spinner size={12} /> : <Plug size={12} />}Test connection</button>}</div>
          </div>))}</div></div>)}

        <Card title="Webhooks" actions={admin && <button className="btn btn-sm" onClick={() => setHook('new')}><Plus size={12} />New webhook</button>} pad={false}>
          {d.webhooks.length === 0 ? <div className="p-6 text-center text-fg-3">No webhooks yet. Create an inbound webhook to receive leads from your website, Zapier or Make, or an outbound webhook to notify other systems of CRM events.</div> : <div className="divide-y divide-line">{d.webhooks.map(h => { const url = h.direction === 'Inbound' ? `${appUrl}/api/hooks/in/${h.token}` : h.url; return (
            <div key={h.id} className="px-4 py-3"><div className="flex flex-wrap items-center gap-2"><span className="font-medium">{h.name}</span><Badge tone={h.direction === 'Inbound' ? 'green' : 'blue'}>{h.direction}</Badge>{!h.active && <Badge>Paused</Badge>}<span className="flex-1" />{admin && <><button className="btn btn-ghost btn-sm" onClick={() => setHook(h)}>Edit</button><button className="btn btn-ghost btn-icon btn-sm" aria-label="Delete webhook" onClick={async () => { if (await confirmDialog({ title: `Delete webhook "${h.name}"?`, danger: true, confirm: 'Delete' })) w.remove('webhooks', h.id).catch(toast.error); }}><Trash2 size={13} /></button></>}</div>
              <div className="mt-1.5 flex items-center gap-2"><code className="text-xs px-2 py-1 rounded bg-surface-2 border border-line truncate flex-1">{h.direction === 'Inbound' ? 'POST ' : ''}{url}</code><button className="btn btn-ghost btn-icon btn-sm" aria-label="Copy URL" onClick={() => copy(url, 'URL copied')}><Copy size={13} /></button></div>
              {h.direction === 'Inbound' ? <p className="mt-1.5 text-[11px] text-fg-3">Send JSON with first_name, last_name, phone, email, address, city, state, zip, source, asking_price, motivation. Treat this URL like a password. Leads default to source "{h.default_source ?? 'Website Form'}".</p>
                : <p className="mt-1.5 text-[11px] text-fg-3">Events: {(h.events ?? []).length ? h.events.join(', ') : 'all'} · signed with HMAC-SHA256 in <code>X-Signature</code> using secret <button className="link" onClick={() => copy(h.token, 'Signing secret copied')}>copy secret</button></p>}
            </div>); })}</div>}
        </Card>

        <Card title="Calendar feed">{feedUrl ? <div><p className="text-fg-2 mb-2">Your personal read-only feed of open tasks and upcoming closings. Add it in Google Calendar (Other calendars → From URL), Apple Calendar or Outlook.</p><div className="flex gap-2"><input className="input text-xs" readOnly value={feedUrl} onFocus={e => e.target.select()} /><button className="btn" onClick={() => copy(feedUrl, 'Feed URL copied')}><Copy size={13} />Copy</button></div><p className="mt-2 text-[11px] text-fg-3">Anyone with this URL can read your task titles. Calendar apps refresh subscribed feeds on their own schedule (often every few hours).</p></div> : <p className="text-fg-3">No feed token on this account.</p>}</Card>

        <div><div className="section-t mb-2">Sync history & error log</div><DataTable rows={d.integration_logs} cols={logCols} pageSize={15} initialSort={{ key: 'created_at', dir: -1 }} noToolbar empty={<div className="p-6 text-center text-fg-3">No integration activity yet. Connection tests, message deliveries and webhook calls are logged here.</div>} /></div>
      </div>
      {hook && <WebhookModal hook={hook === 'new' ? null : hook} onClose={() => setHook(null)} sources={settings.sources} />}
    </div>
  );
}

function WebhookModal({ hook, onClose, sources }: { hook: R | null; onClose: () => void; sources: string[] }) {
  const w = useWrite();
  const [f, setF] = useState<R>(hook ?? { name: '', direction: 'Inbound', url: '', events: [], default_source: 'Website Form', active: true });
  const { busy, run } = useBusy();
  const save = () => run(async () => { if (!f.name.trim()) throw new Error('Name is required.'); const body = { name: f.name, direction: f.direction, url: f.direction === 'Outbound' ? f.url : null, events: f.direction === 'Outbound' ? f.events : [], default_source: f.default_source || null, active: f.active }; hook ? await w.patch('webhooks', hook.id, body) : await w.create('webhooks', body); toast.success('Webhook saved'); onClose(); });
  return <Modal open onClose={onClose} size="md" title={hook ? 'Edit webhook' : 'New webhook'} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={save}>{busy && <Spinner />}Save</button></>}>
    <div className="space-y-3"><Field label="Name"><input className="input" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} placeholder="e.g. Website contact form" /></Field>
      <Field label="Direction"><select className="input" value={f.direction} disabled={!!hook} onChange={e => setF({ ...f, direction: e.target.value })}><option value="Inbound">Inbound — other systems send leads to the CRM</option><option value="Outbound">Outbound — the CRM notifies another system</option></select></Field>
      {f.direction === 'Outbound' ? <><Field label="Destination URL" help="Must be a public http(s) address."><input className="input" value={f.url ?? ''} onChange={e => setF({ ...f, url: e.target.value })} placeholder="https://hooks.zapier.com/…" /></Field>
        <Field label="Events" help="Leave all unchecked to send every event."><div className="grid grid-cols-2 gap-1.5">{WEBHOOK_EVENTS.map(ev => <label key={ev} className="flex items-center gap-2"><input type="checkbox" checked={(f.events ?? []).includes(ev)} onChange={e => setF({ ...f, events: e.target.checked ? [...(f.events ?? []), ev] : f.events.filter((x: string) => x !== ev) })} /><code className="text-xs">{ev}</code></label>)}</div></Field></>
        : <Field label="Lead source for incoming leads"><select className="input" value={f.default_source ?? ''} onChange={e => setF({ ...f, default_source: e.target.value })}>{sources.map(s => <option key={s}>{s}</option>)}</select></Field>}
      <label className="flex items-center gap-2"><input type="checkbox" checked={!!f.active} onChange={e => setF({ ...f, active: e.target.checked })} />Active</label></div>
  </Modal>;
}
export { fdate };
