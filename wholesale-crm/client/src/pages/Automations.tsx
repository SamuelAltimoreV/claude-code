import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowDown, ArrowUp, ChevronDown, CircleCheck, CircleX, Copy, GitBranch, History, Play, Plus, Repeat, RotateCcw, SkipForward, Trash2, Zap } from 'lucide-react';
import { ACTIONS, AUTOMATION_TEMPLATES, CONDITION_FIELDS, OPERATORS, TRIGGERS, type ActionStep, type Condition, type ParamDef, type SequenceStep } from '@shared/automation';
import { PRIORITIES, ROLES } from '@shared/schema';
import { api, useBoot, useData, usePerms, useWrite, type R } from '@/lib/app';
import { ago, fdatetime } from '@/lib/format';
import { Badge, Card, confirmDialog, cx, Empty, ErrorBox, Field, Loading, Menu, Modal, PageHeader, Spinner, StatusBadge, Tabs, toast, Toggle, useBusy } from '@/ui/core';
import { DataTable, type Col } from '@/ui/DataTable';

const trig = (id: string) => TRIGGERS.find(t => t.id === id);
const act = (id: string) => ACTIONS.find(a => a.id === id);

function ParamInput({ p, value, onChange }: { p: ParamDef; value: any; onChange: (v: any) => void }) {
  const { settings, users } = useBoot();
  const d = useData('templates', 'sequences');
  const sel = (opts: { value: string; label: string }[], blank = p.optional) => <select className="input" value={value ?? ''} onChange={e => onChange(e.target.value || null)}>{(blank || !value) && <option value="">{p.optional ? 'Any / none' : 'Choose…'}</option>}{opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;
  switch (p.type) {
    case 'long': return <textarea className="input" rows={2} value={value ?? ''} onChange={e => onChange(e.target.value)} />;
    case 'number': return <input className="input tnum" inputMode="numeric" value={value ?? ''} onChange={e => onChange(e.target.value === '' ? null : Number(e.target.value.replace(/[^0-9.]/g, '')))} />;
    case 'select': return sel((p.options ?? []).map(o => ({ value: o, label: o })));
    case 'stage': return sel(settings.stages.map(s => ({ value: s.id, label: s.name })));
    case 'user': return sel(users.filter(u => u.status === 'active').map(u => ({ value: u.id, label: u.name })));
    case 'assignee': return sel([{ value: 'owner', label: "The lead's owner" }, ...ROLES.map(r => ({ value: `role:${r}`, label: `Everyone with role: ${r}` })), ...ROLES.filter(r => /Rep|Manager|Coordinator/.test(r)).map(r => ({ value: `round_robin:${r}`, label: `Round robin: ${r}` })), ...users.filter(u => u.status === 'active').map(u => ({ value: `user:${u.id}`, label: u.name }))], false);
    case 'template_sms': return sel(d.templates.filter(t => t.channel === 'SMS').map(t => ({ value: t.id, label: t.name })));
    case 'template_email': return sel(d.templates.filter(t => t.channel === 'Email').map(t => ({ value: t.id, label: t.name })));
    case 'sequence': return sel(d.sequences.map(t => ({ value: t.id, label: t.name })));
    case 'tag': return <><input className="input" list="tag-opts" value={value ?? ''} onChange={e => onChange(e.target.value)} /><datalist id="tag-opts">{settings.tags.map(t => <option key={t} value={t} />)}</datalist></>;
    case 'classification': return sel(settings.leadStatuses.map(o => ({ value: o, label: o })));
    case 'category': return sel(settings.taskCategories.map(o => ({ value: o, label: o })));
    case 'priority': return sel(PRIORITIES.map(o => ({ value: o, label: o })), false);
    default: return <input className="input" value={value ?? ''} onChange={e => onChange(e.target.value)} />;
  }
}

function Block({ n, title, hint, children }: { n: string; title: string; hint: string; children: React.ReactNode }) {
  return <div className="relative"><div className="rounded-lg border border-line bg-surface-2/60"><div className="flex items-center gap-2.5 px-4 h-10 border-b border-line"><span className="w-5 h-5 rounded-full bg-accent text-accent-fg text-[11px] font-bold flex items-center justify-center">{n}</span><span className="font-semibold">{title}</span><span className="text-fg-3 text-xs truncate">{hint}</span></div><div className="p-4">{children}</div></div></div>;
}
const Connector = () => <div className="flex justify-center h-6"><div className="w-px bg-line-strong relative"><ChevronDown size={14} className="absolute -bottom-1.5 -left-[7px] text-fg-3" /></div></div>;

function Builder({ initial, onClose }: { initial: R; onClose: () => void }) {
  const { settings, users, providers } = useBoot();
  const w = useWrite();
  const [a, setA] = useState<R>({ name: '', description: '', enabled: true, trigger: 'lead.created', trigger_config: {}, conditions: [], actions: [], ...initial });
  const { busy, run } = useBusy();
  const t = trig(a.trigger), conds: Condition[] = a.conditions ?? [], steps: ActionStep[] = a.actions ?? [];
  const setCond = (i: number, p: Partial<Condition>) => setA(s => ({ ...s, conditions: conds.map((c, j) => (j === i ? { ...c, ...p } : c)) }));
  const setStep = (i: number, params: R) => setA(s => ({ ...s, actions: steps.map((c, j) => (j === i ? { ...c, params } : c)) }));
  const move = (i: number, dir: number) => setA(s => { const x = [...steps]; [x[i], x[i + dir]] = [x[i + dir], x[i]]; return { ...s, actions: x }; });
  const condValue = (c: Condition, i: number) => { const f = CONDITION_FIELDS.find(x => x.id === c.field); if (c.op === 'empty') return null; const opts = f?.options ?? (f?.optsKey ? (settings as any)[f.optsKey] as string[] : null);
    if (f?.type === 'bool') return <select className="input" value={String(c.value ?? 'true')} onChange={e => setCond(i, { value: e.target.value })}><option value="true">Yes</option><option value="false">No</option></select>;
    if (f?.type === 'stage') return <select className="input" value={String(c.value ?? '')} onChange={e => setCond(i, { value: e.target.value })}><option value="">Choose…</option>{settings.stages.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>;
    if (f?.type === 'user') return <select className="input" value={String(c.value ?? '')} onChange={e => setCond(i, { value: e.target.value })}><option value="">Choose…</option>{users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select>;
    if (opts) return <select className="input" value={String(c.value ?? '')} onChange={e => setCond(i, { value: e.target.value })}><option value="">Choose…</option>{opts.map(o => <option key={o}>{o}</option>)}</select>;
    return <input className="input" inputMode={f?.type === 'number' ? 'numeric' : undefined} value={String(c.value ?? '')} onChange={e => setCond(i, { value: f?.type === 'number' ? Number(e.target.value.replace(/[^0-9.]/g, '')) : e.target.value })} />; };
  const save = () => run(async () => {
    if (!a.name.trim()) throw new Error('Give this automation a name.');
    if (!steps.length) throw new Error('Add at least one action.');
    for (const s of steps) for (const p of act(s.type)?.params ?? []) if (!p.optional && (s.params?.[p.k] === undefined || s.params[p.k] === null || s.params[p.k] === '')) throw new Error(`"${act(s.type)!.label}" is missing: ${p.label}`);
    const payload = { name: a.name.trim(), description: a.description, enabled: a.enabled, trigger: a.trigger, trigger_config: a.trigger_config ?? {}, conditions: conds.filter(c => c.field), actions: steps };
    a.id ? await w.patch('automations', a.id, payload) : await w.create('automations', payload);
    toast.success('Automation saved'); onClose();
  });
  return (
    <Modal open onClose={onClose} size="lg" title={a.id ? 'Edit automation' : 'New automation'} footer={<><label className="flex items-center gap-2 mr-auto"><Toggle checked={a.enabled} onChange={v => setA(s => ({ ...s, enabled: v }))} label="Enabled" />{a.enabled ? 'Enabled' : 'Disabled'}</label><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={save}>{busy && <Spinner />}Save automation</button></>}>
      <div className="grid sm:grid-cols-2 gap-3 mb-4"><Field label="Name *"><input className="input" value={a.name} onChange={e => setA(s => ({ ...s, name: e.target.value }))} placeholder="e.g. Qualified → underwriting kickoff" /></Field><Field label="Description"><input className="input" value={a.description ?? ''} onChange={e => setA(s => ({ ...s, description: e.target.value }))} /></Field></div>
      <Block n="1" title="When this happens" hint="Trigger">
        <select className="input" value={a.trigger} onChange={e => setA(s => ({ ...s, trigger: e.target.value, trigger_config: Object.fromEntries((trig(e.target.value)?.config ?? []).filter(p => p.def !== undefined).map(p => [p.k, p.def])) }))}>{['Leads', 'Tasks', 'Deals', 'Time-based'].map(g => <optgroup key={g} label={g}>{TRIGGERS.filter(x => x.group === g).map(x => <option key={x.id} value={x.id}>{x.label}</option>)}</optgroup>)}</select>
        <p className="mt-1.5 text-[11px] text-fg-3">{t?.describe}</p>
        {t?.config && <div className="mt-3 grid sm:grid-cols-2 gap-3">{t.config.map(p => <Field key={p.k} label={p.label}><ParamInput p={p} value={a.trigger_config?.[p.k]} onChange={v => setA(s => ({ ...s, trigger_config: { ...s.trigger_config, [p.k]: v } }))} /></Field>)}</div>}
      </Block>
      <Connector />
      <Block n="2" title="Only if" hint="Conditions — all must be true (optional)">
        {conds.length === 0 && <p className="text-fg-3 mb-2">No conditions: runs every time the trigger fires.</p>}
        <div className="space-y-2">{conds.map((c, i) => { const f = CONDITION_FIELDS.find(x => x.id === c.field); return <div key={i} className="grid grid-cols-[1fr_130px_1fr_28px] gap-2 items-center">
          <select className="input" value={c.field} onChange={e => setCond(i, { field: e.target.value, op: 'eq', value: '' })}>{CONDITION_FIELDS.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}</select>
          <select className="input" value={c.op} onChange={e => setCond(i, { op: e.target.value })}>{Object.entries(OPERATORS).filter(([, o]) => o.types.includes(f?.type ?? 'text')).map(([k, o]) => <option key={k} value={k}>{o.label}</option>)}</select>
          <div>{condValue(c, i)}</div><button className="btn btn-ghost btn-icon btn-sm" aria-label="Remove condition" onClick={() => setA(s => ({ ...s, conditions: conds.filter((_, j) => j !== i) }))}><Trash2 size={13} /></button></div>; })}</div>
        <button className="btn btn-sm mt-2" onClick={() => setA(s => ({ ...s, conditions: [...conds, { field: 'source', op: 'eq', value: '' }] }))}><Plus size={12} />Add condition</button>
      </Block>
      <Connector />
      <Block n="3" title="Do this" hint="Actions run in order; a failed action stops the rest and is logged">
        <div className="space-y-2.5">{steps.map((s, i) => { const def = act(s.type); const blocked = def?.external && !(def.external === 'sms' ? providers.sms : providers.email); return <div key={i} className="card p-3">
          <div className="flex items-center gap-2 mb-2"><span className="text-[11px] text-fg-3 tnum w-4">{i + 1}.</span><span className="font-medium flex-1">{def?.label ?? s.type}</span>
            <button className="btn btn-ghost btn-icon btn-sm" disabled={i === 0} aria-label="Move up" onClick={() => move(i, -1)}><ArrowUp size={13} /></button><button className="btn btn-ghost btn-icon btn-sm" disabled={i === steps.length - 1} aria-label="Move down" onClick={() => move(i, 1)}><ArrowDown size={13} /></button><button className="btn btn-ghost btn-icon btn-sm" aria-label="Remove action" onClick={() => setA(x => ({ ...x, actions: steps.filter((_, j) => j !== i) }))}><Trash2 size={13} /></button></div>
          {blocked && <div className="mb-2 text-t-amber text-xs">No {def!.external === 'sms' ? 'SMS' : 'email'} provider is connected. This action will fail and be logged until one is set up in Integrations. It never sends without recorded consent.</div>}
          {def?.params.length ? <div className="grid sm:grid-cols-2 gap-3">{def.params.map(p => <Field key={p.k} label={p.label + (p.optional ? '' : ' *')} help={p.help} span={p.type === 'long' || p.k === 'title' || p.k === 'message'}><ParamInput p={p} value={s.params?.[p.k]} onChange={v => setStep(i, { ...s.params, [p.k]: v })} /></Field>)}</div> : <p className="text-fg-3 text-xs">No settings. Skips automatically if a transaction already exists.</p>}
        </div>; })}</div>
        <div className="mt-2.5"><Menu align="left" width={300} trigger={<button className="btn btn-sm"><Plus size={12} />Add action</button>} items={ACTIONS.map(x => ({ label: x.label, onClick: () => setA(s => ({ ...s, actions: [...steps, { type: x.id, params: Object.fromEntries(x.params.filter(p => p.def !== undefined).map(p => [p.k, p.def])) }] })) }))} /></div>
      </Block>
    </Modal>
  );
}

function SequenceEditor({ initial, onClose }: { initial: R; onClose: () => void }) {
  const { templates } = useData('templates');
  const w = useWrite();
  const [s, setS] = useState<R>({ name: '', description: '', active: true, steps: [{ day: 0, channel: 'Call', note: 'Initial call' }], ...initial });
  const { busy, run } = useBusy();
  const steps: SequenceStep[] = s.steps ?? [];
  const set = (i: number, p: Partial<SequenceStep>) => setS(x => ({ ...x, steps: steps.map((c, j) => (j === i ? { ...c, ...p } : c)) }));
  const save = () => run(async () => { if (!s.name.trim()) throw new Error('Give this sequence a name.'); if (!steps.length) throw new Error('Add at least one step.'); const payload = { name: s.name.trim(), description: s.description, active: s.active, steps: [...steps].sort((a, b) => a.day - b.day) }; s.id ? await w.patch('sequences', s.id, payload) : await w.create('sequences', payload); toast.success('Sequence saved'); onClose(); });
  return (
    <Modal open onClose={onClose} size="lg" title={s.id ? 'Edit follow-up sequence' : 'New follow-up sequence'} footer={<><label className="flex items-center gap-2 mr-auto"><Toggle checked={s.active} onChange={v => setS(x => ({ ...x, active: v }))} label="Active" />{s.active ? 'Active' : 'Turned off'}</label><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={save}>{busy && <Spinner />}Save sequence</button></>}>
      <div className="grid sm:grid-cols-2 gap-3 mb-4"><Field label="Name *"><input className="input" value={s.name} onChange={e => setS(x => ({ ...x, name: e.target.value }))} /></Field><Field label="Description"><input className="input" value={s.description ?? ''} onChange={e => setS(x => ({ ...x, description: e.target.value }))} /></Field></div>
      <div className="space-y-2">{steps.map((st, i) => <div key={i} className="grid grid-cols-[84px_120px_1fr_1fr_28px] gap-2 items-end">
        <Field label={i === 0 ? 'Day' : undefined}><input className="input tnum" inputMode="numeric" value={st.day} onChange={e => set(i, { day: Number(e.target.value.replace(/\D/g, '')) || 0 })} /></Field>
        <Field label={i === 0 ? 'Channel' : undefined}><select className="input" value={st.channel} onChange={e => set(i, { channel: e.target.value as any, templateId: null })}>{['Call', 'SMS', 'Email', 'Task'].map(c => <option key={c}>{c}</option>)}</select></Field>
        <Field label={i === 0 ? 'Template / script' : undefined}><select className="input" value={st.templateId ?? ''} onChange={e => set(i, { templateId: e.target.value || null })}><option value="">{st.channel === 'SMS' || st.channel === 'Email' ? 'Choose a template…' : 'None'}</option>{templates.filter(t => (st.channel === 'Call' || st.channel === 'Task' ? t.channel === 'Call Script' : t.channel === st.channel)).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
        <Field label={i === 0 ? 'Note' : undefined}><input className="input" value={st.note ?? ''} onChange={e => set(i, { note: e.target.value })} placeholder="e.g. Follow-up call" /></Field>
        <button className="btn btn-ghost btn-icon btn-sm mb-0.5" aria-label="Remove step" onClick={() => setS(x => ({ ...x, steps: steps.filter((_, j) => j !== i) }))}><Trash2 size={13} /></button></div>)}</div>
      <button className="btn btn-sm mt-3" onClick={() => setS(x => ({ ...x, steps: [...steps, { day: (steps[steps.length - 1]?.day ?? 0) + 2, channel: 'Call', note: 'Follow-up call' }] }))}><Plus size={12} />Add step</button>
      <ul className="mt-4 pt-3 border-t border-line text-[11px] text-fg-3 leading-relaxed list-disc ml-4 space-y-0.5"><li>Call and task steps create a task for the lead's owner on that day.</li><li>SMS and email steps only send with recorded consent, inside contact hours, through a connected provider. With no provider they become a manual task; without consent they are skipped and logged.</li><li>The sequence pauses when the seller replies and stops on opt-out, do-not-contact, disqualification or a closed/dead stage.</li></ul>
    </Modal>
  );
}

export default function Automations() {
  const { settings } = useBoot();
  const d = useData('automations', 'automation_runs', 'sequences', 'enrollments');
  const perms = usePerms(), w = useWrite();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') ?? 'workflows') as 'workflows' | 'sequences' | 'history' | 'templates';
  const [edit, setEdit] = useState<R | null>(null), [seq, setSeq] = useState<R | null>(null), [openRun, setOpenRun] = useState<string | null>(null);
  const { busy, run } = useBusy();
  const canWrite = perms.write('automations');
  const stats = useMemo(() => { const m = new Map<string, { ok: number; failed: number; skipped: number; last?: string }>(); for (const r of d.automation_runs) { const s = m.get(r.automation_id) ?? m.set(r.automation_id, { ok: 0, failed: 0, skipped: 0 }).get(r.automation_id)!; r.status === 'success' ? s.ok++ : r.status === 'failed' ? s.failed++ : s.skipped++; if (!s.last || r.started_at > s.last) s.last = r.started_at; } return m; }, [d.automation_runs]);
  const names = useMemo(() => new Map(d.automations.map(a => [a.id, a.name])), [d.automations]);
  const total = d.automation_runs.length, failed = d.automation_runs.filter(r => r.status === 'failed').length, okRuns = d.automation_runs.filter(r => r.status === 'success').length;
  const describe = (a: R) => { const t = trig(a.trigger); const cfg = a.trigger_config ?? {}; const extra = a.trigger === 'lead.stage_changed' && cfg.to ? ` → ${settings.stages.find(s => s.id === cfg.to)?.name ?? cfg.to}` : cfg.days ? ` (${cfg.days} days)` : cfg.hours ? ` (${cfg.hours}h)` : cfg.crosses ? ` (≥ ${cfg.crosses})` : ''; return `${t?.label ?? a.trigger}${extra}`; };
  const runCols: Col[] = [
    { key: 'started_at', label: 'When', render: r => <span title={fdatetime(r.started_at)}>{ago(r.started_at)}</span>, width: 110 }, { key: 'automation', label: 'Automation', value: r => names.get(r.automation_id) ?? 'Deleted automation', width: 280 },
    { key: 'subject', label: 'Record', width: 260 }, { key: 'trigger', label: 'Trigger' }, { key: 'status', label: 'Result', render: r => <StatusBadge value={r.status} /> },
    { key: 'detail', label: 'What happened', width: 360, value: r => r.error ?? (r.steps ?? []).map((s: R) => s.detail).join('; ') },
  ];
  const runRec = d.automation_runs.find(r => r.id === openRun);
  if (d.error) return <ErrorBox error={d.error} />;
  return (
    <div>
      <PageHeader title="Automations" subtitle="Trigger → condition → action workflows and follow-up sequences, with a full execution history.">
        {perms.admin('automations') && <button className="btn" disabled={busy} title="Process due sequence steps, time-based triggers and reminders now instead of waiting for the next minute" onClick={() => run(async () => { await api('POST', '/api/system/tick'); await w.refresh(); }, 'Scheduler ran')}>{busy ? <Spinner /> : <Play size={14} />}Run scheduler now</button>}
        {canWrite && <><button className="btn" onClick={() => setSeq({})}><Repeat size={14} />New sequence</button><button className="btn btn-primary" onClick={() => setEdit({})}><Plus size={14} />New automation</button></>}
      </PageHeader>
      {settings.automation.pauseAll && <div className="mb-4 px-4 py-2.5 rounded-lg border border-warn/50 bg-warn/5">All automations are paused in Settings → Automation. Nothing will run until you resume them.</div>}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">{[['Active automations', d.automations.filter(a => a.enabled).length], ['Runs logged', total], ['Succeeded', okRuns], ['Failed', failed], ['Leads in sequences', d.enrollments.filter(e => e.status === 'Active').length]].map(([l, v]) => <div key={l as string} className="card p-3.5"><div className="text-xs text-fg-2">{l}</div><div className={cx('mt-1 text-xl font-semibold tnum', l === 'Failed' && (v as number) > 0 && 'text-t-red')}>{v}</div></div>)}</div>
      <Tabs className="mb-4" value={tab} onChange={v => setSp({ tab: v })} tabs={[{ id: 'workflows', label: 'Workflows', count: d.automations.length }, { id: 'sequences', label: 'Follow-up sequences', count: d.sequences.length }, { id: 'history', label: 'Execution history', count: total }, { id: 'templates', label: 'Templates' }]} />
      {d.loading ? <Loading /> : <>
        {tab === 'workflows' && (d.automations.length === 0 ? <Empty icon={<Zap size={18} />} title="No automations yet" body="Start from a template or build your own trigger → condition → action workflow." action={canWrite && <button className="btn btn-primary" onClick={() => setSp({ tab: 'templates' })}>Browse templates</button>} /> : <div className="card divide-y divide-line">{[...d.automations].sort((x, y) => Number(y.enabled) - Number(x.enabled) || String(x.created_at).localeCompare(String(y.created_at))).map(a => { const s = stats.get(a.id); return (
          <div key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
            <Toggle checked={a.enabled} disabled={!canWrite} onChange={v => w.patch('automations', a.id, { enabled: v }).then(() => toast.success(v ? 'Automation enabled' : 'Automation disabled')).catch(toast.error)} label={`Enable ${a.name}`} />
            <button className="flex-1 min-w-[240px] text-left" onClick={() => canWrite && setEdit(a)}><div className={cx('font-medium', !a.enabled && 'text-fg-3')}>{a.name}</div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-fg-2"><Badge tone="blue"><Zap size={10} />{describe(a)}</Badge>{(a.conditions ?? []).length > 0 && <><span className="text-fg-3">if</span><Badge tone="amber"><GitBranch size={10} />{a.conditions.length} condition{a.conditions.length > 1 ? 's' : ''}</Badge></>}<span className="text-fg-3">then</span>{(a.actions ?? []).map((x: R, i: number) => <Badge key={i}>{act(x.type)?.label ?? x.type}</Badge>)}</div></button>
            <div className="text-right text-xs"><div className="tnum"><span className="text-t-green">{s?.ok ?? 0} ok</span>{(s?.failed ?? 0) > 0 && <span className="text-t-red"> · {s!.failed} failed</span>}{(s?.skipped ?? 0) > 0 && <span className="text-fg-3"> · {s!.skipped} skipped</span>}</div><div className="text-fg-3">{s?.last ? `Last run ${ago(s.last)}` : 'Never run'}</div></div>
            {canWrite && <Menu trigger={<button className="btn btn-ghost btn-sm">More</button>} items={[{ label: 'Edit', onClick: () => setEdit(a) }, { label: 'Duplicate', icon: <Copy size={13} />, onClick: () => setEdit({ ...a, id: undefined, name: `${a.name} (copy)`, enabled: false }) }, { label: 'View history', icon: <History size={13} />, onClick: () => setSp({ tab: 'history' }) }, { label: '', divider: true }, { label: 'Delete', danger: true, icon: <Trash2 size={13} />, onClick: async () => { if (await confirmDialog({ title: `Delete "${a.name}"?`, body: 'Its execution history is deleted too.', danger: true, confirm: 'Delete' })) w.remove('automations', a.id).catch(toast.error); } }]} />}
          </div>); })}</div>)}
        {tab === 'sequences' && (d.sequences.length === 0 ? <Empty icon={<Repeat size={18} />} title="No sequences yet" body="A sequence is a timed series of calls, texts and emails that keeps a lead from going cold." /> : <div className="grid lg:grid-cols-2 gap-4">{d.sequences.map(s => { const en = d.enrollments.filter(e => e.sequence_id === s.id); return (
          <Card key={s.id} title={<span className="flex items-center gap-2">{s.name}{!s.active && <Badge>Off</Badge>}</span>} actions={<><span className="text-xs text-fg-3 tnum">{en.filter(e => e.status === 'Active').length} active · {en.filter(e => e.status === 'Completed').length} completed</span>{canWrite && <button className="btn btn-ghost btn-sm" onClick={() => setSeq(s)}>Edit</button>}</>}>
            {s.description && <p className="text-fg-2 mb-3">{s.description}</p>}
            <ol className="space-y-1.5">{(s.steps as SequenceStep[]).map((st, i) => <li key={i} className="flex items-center gap-3"><span className="w-14 text-xs text-fg-3 tnum">Day {st.day}</span><Badge tone={st.channel === 'SMS' ? 'blue' : st.channel === 'Email' ? 'violet' : 'gray'}>{st.channel}</Badge><span className="truncate text-fg-2">{st.note || (st.templateId ? 'Uses template' : '')}</span></li>)}</ol>
            <p className="mt-3 text-[11px] text-fg-3">Start a sequence from any lead, or with the "Start follow-up sequence" automation action.</p>
          </Card>); })}</div>)}
        {tab === 'history' && <DataTable rows={d.automation_runs} cols={runCols} exportName="automation-runs" initialSort={{ key: 'started_at', dir: -1 }} onRowClick={r => setOpenRun(r.id)} rowClass={r => (r.status === 'failed' ? 'bg-critical/5' : undefined)}
          filters={[{ key: 'status', label: 'Result', options: ['success', 'failed', 'skipped'].map(s => ({ value: s, label: s })), get: r => r.status }, { key: 'auto', label: 'Automation', options: d.automations.map(a => ({ value: a.id, label: a.name })), get: r => r.automation_id }]}
          empty={<Empty icon={<History size={18} />} title="No runs yet" body="Each time a trigger fires you will see what ran, on which record, and exactly what each step did." />} />}
        {tab === 'templates' && <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">{AUTOMATION_TEMPLATES.map((t, i) => <div key={i} className="card p-4 flex flex-col"><div className="font-semibold">{t.name}</div><p className="text-fg-2 mt-1 flex-1">{t.description}</p><div className="mt-3 flex flex-wrap gap-1.5"><Badge tone="blue">{trig(t.trigger)?.label}</Badge>{t.actions.map((x, j) => <Badge key={j}>{act(x.type)?.label}</Badge>)}</div>
          {canWrite && <button className="btn btn-sm mt-3 self-start" onClick={() => setEdit({ ...t, enabled: false })}><Plus size={12} />Use this template</button>}</div>)}</div>}
      </>}
      {edit && <Builder initial={edit} onClose={() => setEdit(null)} />}
      {seq && <SequenceEditor initial={seq} onClose={() => setSeq(null)} />}
      <Modal open={!!runRec} onClose={() => setOpenRun(null)} size="md" title="Automation run" footer={runRec?.status === 'failed' && perms.admin('automations') ? <button className="btn btn-primary" disabled={busy} onClick={() => run(async () => { const r = await w.post(`/api/automation-runs/${runRec.id}/retry`); toast[r?.status === 'success' ? 'success' : 'info'](r?.status === 'success' ? 'Retry succeeded' : `Retry finished: ${r?.status}${r?.error ? ` — ${r.error}` : ''}`); setOpenRun(r?.id ?? null); })}>{busy ? <Spinner /> : <RotateCcw size={13} />}Retry failed steps</button> : undefined}>
        {runRec && <div className="space-y-3">
          <div><div className="font-semibold">{names.get(runRec.automation_id) ?? 'Deleted automation'}</div><div className="text-fg-2">{runRec.trigger} · {runRec.subject}</div><div className="text-fg-3 text-xs mt-0.5">{fdatetime(runRec.started_at)}{runRec.retry_of && ' · retry of an earlier run'}</div></div>
          <div className="flex items-center gap-2"><StatusBadge value={runRec.status} />{runRec.error && <span className="text-t-red">{runRec.error}</span>}</div>
          {(runRec.steps ?? []).length > 0 ? <ol className="border border-line rounded-md divide-y divide-line">{(runRec.steps as R[]).map((s, i) => <li key={i} className="flex items-start gap-2.5 px-3 py-2">{s.status === 'ok' ? <CircleCheck size={15} className="text-t-green mt-0.5 shrink-0" /> : s.status === 'failed' ? <CircleX size={15} className="text-t-red mt-0.5 shrink-0" /> : <SkipForward size={15} className="text-fg-3 mt-0.5 shrink-0" />}<div><div className="font-medium">{s.label}</div><div className="text-fg-2">{s.detail}</div></div></li>)}</ol> : <p className="text-fg-3">No actions ran. {runRec.error}</p>}
          <p className="text-[11px] text-fg-3">Runs triggered by another automation are limited to {settings.automation.maxChainDepth} levels deep, and an automation can never re-trigger itself. <Link className="link" to="/settings?tab=automation">Automation settings</Link></p>
        </div>}
      </Modal>
    </div>
  );
}
