// Schema-driven forms: every entity form is rendered from the shared field definitions and validated
// with the same validator the server uses.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronsUpDown, X } from 'lucide-react';
import { ENTITY, validate, type Field as FieldDef } from '@shared/schema';
import { contactName, propertyLabel } from '@shared/logic';
import { ApiError, useBoot, useData, useWrite, type R } from '@/lib/app';
import { money, toLocalInput } from '@/lib/format';
import { cx, Field, Modal, Spinner, toast, Toggle } from './core';

export function recordLabel(entity: string, r: R | undefined | null, maps: Record<string, Map<string, R>> = {}): string {
  if (!r) return '—';
  switch (entity) {
    case 'contacts': return contactName(r);
    case 'properties': return propertyLabel(r);
    case 'leads': return `${contactName(maps.contacts?.get(r.contact_id))}${maps.properties?.get(r.property_id) ? ` — ${maps.properties.get(r.property_id)!.address}` : ''}`;
    case 'offers': return `${money(r.amount)} · ${r.status}${maps.properties?.get(r.property_id) ? ` · ${maps.properties.get(r.property_id)!.address}` : ''}`;
    case 'contracts': return `${r.type}${maps.properties?.get(r.property_id) ? ` — ${maps.properties.get(r.property_id)!.address}` : ''}`;
    case 'transactions': case 'dispositions': return `${maps.properties?.get(r.property_id)?.address ?? 'Deal'} · ${r.status}`;
    default: return r.name ?? r.title ?? r.address ?? String(r.id).slice(0, 8);
  }
}
const REF_DEPS: Record<string, string[]> = { leads: ['contacts', 'properties'], offers: ['properties'], contracts: ['properties'], transactions: ['properties'], dispositions: ['properties'] };

export function TagInput({ value, onChange, suggestions = [], placeholder }: { value: string[]; onChange: (v: string[]) => void; suggestions?: readonly string[]; placeholder?: string }) {
  const [text, setText] = useState(''), [open, setOpen] = useState(false);
  const add = (t: string) => { const v = t.trim(); if (v && !value.includes(v)) onChange([...value, v]); setText(''); };
  const sugg = suggestions.filter(s => !value.includes(s) && s.toLowerCase().includes(text.toLowerCase())).slice(0, 12);
  return (
    <div className="relative">
      <div className="input !h-auto min-h-8 py-1 flex flex-wrap items-center gap-1 cursor-text" onClick={e => (e.currentTarget.querySelector('input') as HTMLInputElement)?.focus()}>
        {value.map(t => <span key={t} className="badge !h-[22px] !text-xs">{t}<button type="button" className="hover:text-fg" aria-label={`Remove ${t}`} onClick={() => onChange(value.filter(x => x !== t))}><X size={11} /></button></span>)}
        <input className="flex-1 min-w-[80px] bg-transparent outline-none h-6 text-[13px]" value={text} placeholder={value.length ? '' : placeholder ?? 'Type and press Enter'} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => { setOpen(false); if (text.trim()) add(text); }, 150)}
          onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(text); } else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1)); }} />
      </div>
      {open && sugg.length > 0 && <div className="absolute z-30 left-0 right-0 mt-1 card shadow-[var(--shadow)] py-1 max-h-48 overflow-auto scroll-thin">{sugg.map(s => <button type="button" key={s} className="w-full text-left px-3 h-7 hover:bg-surface-2" onMouseDown={e => { e.preventDefault(); add(s); }}>{s}</button>)}</div>}
    </div>
  );
}

export function Combo({ value, onChange, options, placeholder = 'Select…', clearable = true, disabled }: { value: string | null | undefined; onChange: (v: string | null) => void; options: { value: string; label: string; sub?: string }[]; placeholder?: string; clearable?: boolean; disabled?: boolean }) {
  const [open, setOpen] = useState(false), [text, setText] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!open) return; const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, [open]);
  const cur = options.find(o => o.value === value);
  const list = useMemo(() => { const t = text.toLowerCase(); return (t ? options.filter(o => `${o.label} ${o.sub ?? ''}`.toLowerCase().includes(t)) : options).slice(0, 60); }, [options, text]);
  return (
    <div className="relative" ref={ref}>
      <button type="button" disabled={disabled} className="input flex items-center justify-between gap-2 text-left disabled:opacity-60" onClick={() => { setOpen(o => !o); setText(''); }}>
        <span className={cx('truncate', !cur && 'text-fg-3')}>{cur?.label ?? placeholder}</span>
        <span className="flex items-center gap-1 text-fg-3 shrink-0">{clearable && cur && <span role="button" aria-label="Clear" onClick={e => { e.stopPropagation(); onChange(null); }}><X size={13} /></span>}<ChevronsUpDown size={13} /></span>
      </button>
      {open && <div className="absolute z-30 left-0 right-0 mt-1 card shadow-[var(--shadow)] anim-pop">
        <div className="p-1.5 border-b border-line"><input autoFocus className="input !h-7" placeholder="Search…" value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && list[0]) { e.preventDefault(); onChange(list[0].value); setOpen(false); } if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } }} /></div>
        <div className="max-h-56 overflow-auto scroll-thin py-1">
          {list.length === 0 && <div className="px-3 py-2 text-fg-3">No matches</div>}
          {list.map(o => <button type="button" key={o.value} className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-surface-2" onClick={() => { onChange(o.value); setOpen(false); }}>
            <span className="min-w-0"><span className="block truncate">{o.label}</span>{o.sub && <span className="block truncate text-[11px] text-fg-3">{o.sub}</span>}</span>{o.value === value && <Check size={13} className="text-accent-text shrink-0" />}</button>)}
        </div>
      </div>}
    </div>
  );
}

/** Options for a 'ref' field, loaded from the referenced collection. */
export function useRefOptions(targets: string[]) {
  const { users } = useBoot();
  const need = [...new Set(targets.filter(t => t !== 'users').flatMap(t => [t, ...(REF_DEPS[t] ?? [])]))];
  const data = useData(...need) as Record<string, any>;
  return useMemo(() => {
    const maps: Record<string, Map<string, R>> = Object.fromEntries(need.map(n => [n, new Map((data[n] as R[]).map(r => [r.id, r]))]));
    const out: Record<string, { value: string; label: string; sub?: string }[]> = { users: users.filter(u => u.status !== 'disabled').map(u => ({ value: u.id, label: u.name, sub: u.role })) };
    for (const t of targets) if (t !== 'users') out[t] = (data[t] as R[]).map(r => ({ value: r.id, label: recordLabel(t, r, maps), sub: t === 'contacts' ? r.phone : t === 'buyers' ? r.company : undefined }));
    return out;
  }, [users, ...need.map(n => data[n])]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function FieldInput({ f, value, onChange, refOptions, disabled }: { f: FieldDef; value: any; onChange: (v: any) => void; refOptions?: Record<string, { value: string; label: string; sub?: string }[]>; disabled?: boolean }) {
  const { settings } = useBoot();
  const opts: readonly string[] | undefined = f.opts ?? (f.optsKey && f.optsKey !== 'stages' ? ((settings as any)[f.optsKey] as string[]) : undefined);
  switch (f.t) {
    case 'long': return <textarea className="input" rows={3} value={value ?? ''} disabled={disabled} onChange={e => onChange(e.target.value)} />;
    case 'bool': return <div className="h-8 flex items-center"><Toggle checked={!!value} onChange={onChange} disabled={disabled} label={f.label} /></div>;
    case 'date': return <input type="date" className="input" value={value ? String(value).slice(0, 10) : ''} disabled={disabled} onChange={e => onChange(e.target.value || null)} />;
    case 'datetime': return <input type="datetime-local" className="input" value={toLocalInput(value)} disabled={disabled} onChange={e => onChange(e.target.value ? new Date(e.target.value).toISOString() : null)} />;
    case 'int': case 'num': case 'money': case 'pct':
      return <div className="relative">{f.t === 'money' && <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-3">$</span>}
        <input inputMode="decimal" className={cx('input tnum', f.t === 'money' && 'pl-5', f.t === 'pct' && 'pr-6')} value={value ?? ''} disabled={disabled} onChange={e => onChange(e.target.value.replace(/[^0-9.\-]/g, ''))} />
        {f.t === 'pct' && <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-3">%</span>}</div>;
    case 'select':
      if (f.optsKey === 'stages') return <select className="input" value={value ?? ''} disabled={disabled} onChange={e => onChange(e.target.value || null)}>{settings.stages.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>;
      return <select className="input" value={value ?? ''} disabled={disabled} onChange={e => onChange(e.target.value || null)}><option value="">—</option>{(opts ?? []).map(o => <option key={o}>{o}</option>)}{value && !(opts ?? []).includes(value) && <option>{value}</option>}</select>;
    case 'multi': return <TagInput value={Array.isArray(value) ? value : []} onChange={onChange} suggestions={opts} />;
    case 'ref': return <Combo value={value} onChange={onChange} options={refOptions?.[f.ref!] ?? []} disabled={disabled} clearable={!f.req} />;
    default: return <input className="input" type={f.t === 'email' ? 'email' : 'text'} value={value ?? ''} disabled={disabled} onChange={e => onChange(e.target.value)} />;
  }
}

export interface FormProps {
  entity: string; initial?: R; fields?: string[]; exclude?: string[]; lockFields?: string[];
  onSubmit: (data: R) => Promise<unknown>; onCancel?: () => void; submitLabel?: string; extra?: ReactNode; partial?: boolean;
}
export function EntityForm({ entity, initial, fields, exclude = [], lockFields = [], onSubmit, onCancel, submitLabel = 'Save', extra, partial }: FormProps) {
  const e = ENTITY[entity];
  const { settings } = useBoot();
  const defs = useMemo(() => (fields ? fields.map(k => e.fields.find(f => f.k === k)!).filter(Boolean) : e.fields.filter(f => !f.system && f.t !== 'json' && !exclude.includes(f.k))), [entity, fields?.join(), exclude.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const custom = ((settings.customFields as any)[entity] ?? []) as { key: string; label: string; type: string; options?: string[] }[];
  const [vals, setVals] = useState<R>(() => { const v: R = {}; for (const f of defs) v[f.k] = initial?.[f.k] ?? (initial?.id ? null : f.def ?? null); v.custom = { ...(initial?.custom ?? {}) }; return v; });
  const [errors, setErrors] = useState<Record<string, string>>({}), [busy, setBusy] = useState(false), [formError, setFormError] = useState('');
  const refOptions = useRefOptions(defs.filter(f => f.t === 'ref').map(f => f.ref!));
  const groups = useMemo(() => { const g: [string, FieldDef[]][] = []; for (const f of defs) { const k = f.group ?? ''; const hit = g.find(x => x[0] === k); if (hit) hit[1].push(f); else g.push([k, [f]]); } return g; }, [defs]);

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault(); ev.stopPropagation();
    const payload: R = {}; for (const f of defs) if (!lockFields.includes(f.k)) payload[f.k] = vals[f.k] === undefined ? null : vals[f.k];
    const v = validate({ ...e, fields: defs.filter(f => !lockFields.includes(f.k)) }, payload, { partial });
    if (!v.ok) { setErrors(v.errors); setFormError('Fix the highlighted fields.'); return; }
    if (custom.length) payload.custom = vals.custom;
    setBusy(true); setErrors({}); setFormError('');
    try { await onSubmit(payload); }
    catch (err) { if (err instanceof ApiError && err.details?.fields) setErrors(err.details.fields); setFormError(err instanceof Error ? err.message : 'Could not save'); }
    finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} noValidate>
      <div className="space-y-5">
        {groups.map(([g, fs]) => (
          <div key={g}>{g && <div className="section-t mb-2.5">{g}</div>}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
              {fs.map(f => <Field key={f.k} label={`${f.label}${f.req ? ' *' : ''}`} help={f.help} error={errors[f.k]} span={f.t === 'long' || f.t === 'multi'}>
                <FieldInput f={f} value={vals[f.k]} onChange={v => setVals(s => ({ ...s, [f.k]: v }))} refOptions={refOptions} disabled={lockFields.includes(f.k)} /></Field>)}
            </div>
          </div>
        ))}
        {custom.length > 0 && <div><div className="section-t mb-2.5">Custom fields</div><div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
          {custom.map(c => <Field key={c.key} label={c.label}><FieldInput f={{ k: c.key, label: c.label, t: c.type === 'select' ? 'select' : (c.type as any), opts: c.options }} value={vals.custom?.[c.key]} onChange={v => setVals(s => ({ ...s, custom: { ...s.custom, [c.key]: v } }))} /></Field>)}</div></div>}
        {extra}
      </div>
      {formError && <div className="mt-4 text-[13px] text-t-red" role="alert">{formError}</div>}
      <div className="flex justify-end gap-2 mt-5 pt-4 border-t border-line -mx-5 px-5">
        {onCancel && <button type="button" className="btn" onClick={onCancel}>Cancel</button>}
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy && <Spinner />}{submitLabel}</button>
      </div>
    </form>
  );
}

export interface RecordModalProps { entity: string; open: boolean; onClose: () => void; record?: R | null; defaults?: R; fields?: string[]; exclude?: string[]; lockFields?: string[]; title?: string; onSaved?: (r: R) => void; size?: 'md' | 'lg' }
/** Create/edit modal for any entity. */
export function RecordModal({ entity, open, onClose, record, defaults, fields, exclude, lockFields, title, onSaved, size = 'lg' }: RecordModalProps) {
  const w = useWrite();
  const e = ENTITY[entity];
  if (!open) return null;
  return (
    <Modal open onClose={onClose} size={size} title={title ?? `${record?.id ? 'Edit' : 'New'} ${e.label.toLowerCase()}`}>
      <EntityForm entity={entity} initial={record ?? defaults} fields={fields} exclude={exclude} lockFields={lockFields} partial={!!record?.id} onCancel={onClose} submitLabel={record?.id ? 'Save changes' : `Create ${e.label.toLowerCase()}`}
        onSubmit={async data => { const r = record?.id ? await w.patch(entity, record.id, data) : await w.create(entity, { ...defaults, ...data }); toast.success(`${e.label} ${record?.id ? 'updated' : 'created'}`); onSaved?.(r); onClose(); }} />
    </Modal>
  );
}
