// Database access. Uses real PostgreSQL when DATABASE_URL is set (e.g. Supabase), otherwise an embedded
// PostgreSQL (PGlite) persisted to ./data/pg so the app runs with zero setup. Same SQL either way.
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { ENTITIES, type Field } from '../shared/schema';

type Rows = { rows: any[] };
interface Queryable { query(sql: string, params?: unknown[]): Promise<Rows> }
interface Driver extends Queryable { exec(sql: string): Promise<void>; transaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T>; close(): Promise<void> }

interface TxStore { q: Queryable; after: (() => Promise<void> | void)[] }
const als = new AsyncLocalStorage<TxStore>();
let driver: Driver;

const iso = (v: string) => new Date(v).toISOString();

async function pgliteDriver(dir: string | undefined): Promise<Driver> {
  const { PGlite, types } = await import('@electric-sql/pglite');
  if (dir) fs.mkdirSync(path.dirname(dir), { recursive: true });
  const db = new PGlite(dir);
  await db.waitReady;
  const o = { parsers: { [types.DATE]: (v: string) => v, [types.TIMESTAMPTZ]: iso, [types.TIMESTAMP]: iso } };
  return {
    query: (sql, params) => db.query(sql, params as any[], o) as Promise<Rows>,
    exec: async sql => { await db.exec(sql); },
    transaction: fn => db.transaction(tx => fn({ query: (s, p) => tx.query(s, p as any[], o) as Promise<Rows> })) as Promise<any>,
    close: () => db.close(),
  };
}

async function pgDriver(url: string): Promise<Driver> {
  const pg = (await import('pg')).default;
  pg.types.setTypeParser(1082, v => v);
  pg.types.setTypeParser(1184, iso);
  pg.types.setTypeParser(1114, iso);
  const pool = new pg.Pool({ connectionString: url, max: 10, ssl: /sslmode=require|supabase\.co/.test(url) ? { rejectUnauthorized: false } : undefined });
  return {
    query: (sql, params) => pool.query(sql, params as any[]),
    exec: async sql => { await pool.query(sql); },
    transaction: async fn => {
      const c = await pool.connect();
      try { await c.query('begin'); const r = await fn({ query: (s, p) => c.query(s, p as any[]) }); await c.query('commit'); return r; }
      catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
    },
    close: () => pool.end(),
  };
}

export const q = (sql: string, params: unknown[] = []) => (als.getStore()?.q ?? driver).query(sql, params);
export const one = async (sql: string, params: unknown[] = []) => (await q(sql, params)).rows[0] ?? null;

/** Runs fn atomically. Nested calls join the outer transaction. Callbacks registered with afterCommit run once it commits. */
export async function tx<T>(fn: () => Promise<T>): Promise<T> {
  if (als.getStore()) return fn();
  const store: TxStore = { q: driver, after: [] };
  const result = await driver.transaction(t => { store.q = t; return als.run(store, fn); });
  for (const cb of store.after) Promise.resolve().then(cb).catch(e => console.error('afterCommit failed', e));
  return result;
}
/** Defers side effects that must not run inside a DB transaction (HTTP calls to providers, webhooks). */
export function afterCommit(cb: () => Promise<void> | void) {
  const s = als.getStore();
  if (s) s.after.push(cb); else Promise.resolve().then(cb).catch(e => console.error('afterCommit failed', e));
}

let spSeq = 0;
/** Runs fn inside a savepoint so a failed statement does not poison the surrounding transaction. */
export async function savepoint<T>(fn: () => Promise<T>): Promise<T> {
  if (!als.getStore()) return tx(fn);
  const name = `sp_${++spSeq}`;
  await q(`savepoint ${name}`);
  try { const r = await fn(); await q(`release savepoint ${name}`); return r; }
  catch (e) { await q(`rollback to savepoint ${name}`); throw e; }
}

const SQL_TYPE:Record<Field['t'], string> = {
  text: 'text', long: 'text', email: 'text', phone: 'text', select: 'text', int: 'integer', num: 'double precision', money: 'double precision', pct: 'double precision',
  bool: 'boolean', date: 'date', datetime: 'timestamptz', multi: "jsonb", json: 'jsonb', ref: 'uuid',
};
const UNIQUE: Record<string, string[]> = { buyer_interests: ['disposition_id', 'buyer_id'], property_contacts: ['property_id', 'contact_id'] };

export async function initDb(opts: { memory?: boolean } = {}) {
  const url = process.env.DATABASE_URL;
  driver = url ? await pgDriver(url) : await pgliteDriver(opts.memory ? undefined : path.resolve(process.env.DATA_DIR ?? 'data', 'pg'));
  const ddl: string[] = [`
    create table if not exists organizations (id uuid primary key default gen_random_uuid(), name text not null, settings jsonb not null default '{}', created_at timestamptz not null default now());
    create table if not exists users (id uuid primary key default gen_random_uuid(), org_id uuid not null references organizations(id) on delete cascade,
      email text not null unique, name text not null, password_hash text, role text not null, department text, phone text, status text not null default 'active',
      invite_token text, is_demo boolean not null default false, last_login_at timestamptz, created_at timestamptz not null default now());
    alter table users add column if not exists feed_token text;
    create index if not exists users_org on users(org_id);
    create table if not exists sessions (token_hash text primary key, user_id uuid not null references users(id) on delete cascade, expires_at timestamptz not null, created_at timestamptz not null default now());
    create table if not exists integrations (org_id uuid not null references organizations(id) on delete cascade, key text not null, enabled boolean not null default false,
      config jsonb not null default '{}', last_sync_at timestamptz, last_error text, primary key (org_id, key));`];
  for (const e of ENTITIES) {
    ddl.push(`create table if not exists ${e.name} (id uuid primary key default gen_random_uuid(), org_id uuid not null references organizations(id) on delete cascade,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(), created_by uuid, is_demo boolean not null default false, custom jsonb not null default '{}');
      create index if not exists ${e.name}_org on ${e.name}(org_id, created_at);`);
  }
  for (const e of ENTITIES) {
    for (const f of e.fields) {
      let col = `${f.k} ${SQL_TYPE[f.t]}`;
      if (f.t === 'ref') col += ` references ${f.ref}(id) on delete ${f.cascade ? 'cascade' : f.req ? 'restrict' : 'set null'}`;
      ddl.push(`alter table ${e.name} add column if not exists ${col};`);
      if (f.idx) ddl.push(`create index if not exists ${e.name}_${f.k} on ${e.name}(org_id, ${f.k});`);
    }
    if (UNIQUE[e.name]) ddl.push(`create unique index if not exists ${e.name}_uniq on ${e.name}(${UNIQUE[e.name].join(',')});`);
  }
  ddl.push('alter table attachments add column if not exists data bytea;');
  await driver.exec(ddl.join('\n'));
  return driver;
}
export const closeDb = () => driver?.close();
