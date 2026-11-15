import type { OrgSettings } from '@shared/settings';

let currency = 'USD', dateFormat: OrgSettings['formats']['dateFormat'] = 'MM/DD/YYYY';
export function configureFormats(s: OrgSettings) { currency = s.formats.currency || 'USD'; dateFormat = s.formats.dateFormat; }

export const money = (v: unknown, compact = false) => {
  if (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0, ...(compact && Math.abs(Number(v)) >= 10000 ? { notation: 'compact', maximumFractionDigits: 1 } : {}) }).format(Number(v));
};
export const num = (v: unknown, digits = 0) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: digits }));
export const pct = (v: unknown, digits = 0) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : `${Number(v).toFixed(digits)}%`);

const parse = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v + 'T12:00:00') : new Date(v));
export function fdate(v?: string | null) {
  if (!v) return '—';
  const d = parse(v); if (isNaN(d.getTime())) return '—';
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
  return dateFormat === 'YYYY-MM-DD' ? `${y}-${m}-${dd}` : dateFormat === 'DD/MM/YYYY' ? `${dd}/${m}/${y}` : `${m}/${dd}/${y}`;
}
export const ftime = (v?: string | null) => (v ? parse(v).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '');
export const fdatetime = (v?: string | null) => (v ? `${fdate(v)} ${ftime(v)}` : '—');
export const shortDate = (v?: string | null) => (v ? parse(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—');

export function ago(v?: string | null) {
  if (!v) return '—';
  const s = (Date.now() - parse(v).getTime()) / 1000, a = Math.abs(s);
  const f = (n: number, u: string) => (s >= 0 ? `${n}${u} ago` : `in ${n}${u}`);
  if (a < 60) return 'just now';
  if (a < 3600) return f(Math.round(a / 60), 'm');
  if (a < 86400) return f(Math.round(a / 3600), 'h');
  if (a < 86400 * 45) return f(Math.round(a / 86400), 'd');
  return fdate(v);
}
export const daysSince = (v?: string | null) => (v ? Math.floor((Date.now() - parse(v).getTime()) / 864e5) : null);
export const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const localDay = (v: string) => { const d = parse(v); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
/** ISO → value for <input type="datetime-local"> in local time. */
export const toLocalInput = (v?: string | null) => { if (!v) return ''; const d = new Date(v); return isNaN(d.getTime()) ? '' : `${localDay(v)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

export function toCsv(rows: Record<string, unknown>[], cols: { label: string; value: (r: any) => unknown }[]) {
  const esc = (v: unknown) => { let s = v === null || v === undefined ? '' : Array.isArray(v) ? v.join('; ') : String(v); if (/^[=+\-@]/.test(s)) s = `'${s}`; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.map(c => esc(c.label)).join(','), ...rows.map(r => cols.map(c => esc(c.value(r))).join(','))].join('\n');
}
export function download(name: string, content: string, type = 'text/csv') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
/** Minimal RFC-4180 CSV parser (quoted fields, embedded commas/newlines). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cur = '', q = false;
  const t = text.replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some(x => x.trim())) rows.push(row); row = []; }
    else cur += c;
  }
  row.push(cur); if (row.some(x => x.trim())) rows.push(row);
  return rows;
}
export const initials = (name?: string) => (name ?? '?').split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();
