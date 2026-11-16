// Org-scoped data access. Every statement is constrained by org_id — this is the tenant isolation chokepoint.
import { ENTITY, type Entity } from '../shared/schema';
import { q, one } from './db';

type R = Record<string, any>;
const JSON_T = new Set(['multi', 'json']);

export function ent(name: string): Entity {
  const e = ENTITY[name];
  if (!e) throw new HttpError(404, `Unknown entity "${name}"`);
  return e;
}
export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}

const colsOf = (e: Entity) => e.fields.map(f => f.k);
const selectCols = (e: Entity) => ['id', 'created_at', 'updated_at', 'created_by', 'is_demo', 'custom', ...colsOf(e)].join(', ');

export async function list(org: string, name: string, where: R = {}, opts: { order?: string; limit?: number; extra?: string; params?: unknown[] } = {}): Promise<R[]> {
  const e = ent(name);
  const params: unknown[] = [org, ...(opts.params ?? [])];
  const conds = ['org_id = $1'];
  if (opts.extra) conds.push(opts.extra);
  for (const [k, v] of Object.entries(where)) {
    if (k !== 'id' && k !== 'is_demo' && !e.fields.some(f => f.k === k)) throw new HttpError(400, `Unknown filter ${k}`);
    if (v === null) conds.push(`${k} is null`);
    else if (Array.isArray(v)) { params.push(v); conds.push(`${k} = any($${params.length})`); }
    else { params.push(v); conds.push(`${k} = $${params.length}`); }
  }
  const sql = `select ${selectCols(e)} from ${name} where ${conds.join(' and ')} order by ${opts.order ?? 'created_at desc'}${opts.limit ? ` limit ${Math.floor(opts.limit)}` : ''}`;
  return (await q(sql, params)).rows;
}

export const get = async (org: string, name: string, id?: string | null): Promise<R | null> =>
  id ? one(`select ${selectCols(ent(name))} from ${name} where org_id = $1 and id = $2`, [org, id]) : null;

export async function insert(org: string, name: string, data: R, meta: { userId?: string | null; demo?: boolean; createdAt?: string } = {}): Promise<R> {
  const e = ent(name);
  const keys = ['org_id', 'created_by', 'is_demo'], vals: unknown[] = [org, meta.userId ?? null, !!meta.demo], ph = ['$1', '$2', '$3'];
  const push = (k: string, v: unknown, cast = '') => { keys.push(k); vals.push(v); ph.push(`$${vals.length}${cast}`); };
  if (data.id) push('id', data.id);
  if (meta.createdAt) { push('created_at', meta.createdAt); push('updated_at', meta.createdAt); }
  if (data.custom) push('custom', JSON.stringify(data.custom), '::jsonb');
  for (const f of e.fields) {
    const v = data[f.k];
    if (v === undefined) continue;
    if (JSON_T.has(f.t)) push(f.k, v === null ? null : JSON.stringify(v), '::jsonb'); else push(f.k, v);
  }
  return (await q(`insert into ${name} (${keys.join(',')}) values (${ph.join(',')}) returning ${selectCols(e)}`, vals)).rows[0];
}

export async function update(org: string, name: string, id: string, patch: R): Promise<R | null> {
  const e = ent(name);
  const sets = ['updated_at = now()'], vals: unknown[] = [org, id];
  if (patch.custom !== undefined) { vals.push(JSON.stringify(patch.custom)); sets.push(`custom = $${vals.length}::jsonb`); }
  for (const f of e.fields) {
    const v = patch[f.k];
    if (v === undefined) continue;
    vals.push(JSON_T.has(f.t) && v !== null ? JSON.stringify(v) : v);
    sets.push(`${f.k} = $${vals.length}${JSON_T.has(f.t) ? '::jsonb' : ''}`);
  }
  return (await q(`update ${name} set ${sets.join(', ')} where org_id = $1 and id = $2 returning ${selectCols(e)}`, vals)).rows[0] ?? null;
}

export async function remove(org: string, name: string, id: string): Promise<boolean> {
  ent(name);
  try { return ((await q(`delete from ${name} where org_id = $1 and id = $2 returning id`, [org, id])).rows.length) > 0; }
  catch (err: any) {
    if (String(err?.code) === '23503') throw new HttpError(409, 'This record is linked to other records (offers, contracts, transactions or leads). Remove or reassign those first.');
    throw err;
  }
}
export const count = async (org: string, name: string, extra = 'true', params: unknown[] = []) =>
  Number((await one(`select count(*)::int as n from ${ent(name).name} where org_id = $1 and ${extra}`, [org, ...params])).n);
