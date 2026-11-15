// API client, session bootstrap, data hooks and permission helpers.
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { ENTITY } from '@shared/schema';
import type { OrgSettings, Resource } from '@shared/settings';
import type { Dataset } from '@shared/metrics';

export type R = Record<string, any>;
export class ApiError extends Error { constructor(public status: number, message: string, public details?: any) { super(message); } }

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(path, { method, credentials: 'same-origin', headers: { 'x-requested-with': 'crm', ...(body && !isForm ? { 'content-type': 'application/json' } : {}) }, body: isForm ? (body as FormData) : body ? JSON.stringify(body) : undefined });
  } catch { throw new ApiError(0, 'Cannot reach the server. Check your connection and try again.'); }
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, json?.error ?? `Request failed (${res.status})`, json?.details);
  return json as T;
}

export interface Boot { user: R; org: R; settings: OrgSettings; users: R[]; demoCount: number; providers: { sms: boolean; email: boolean; ai: boolean }; feedUrl: string | null; appUrl: string }
const BootCtx = createContext<Boot | null>(null);
export const BootProvider = ({ value, children }: { value: Boot; children: ReactNode }) => <BootCtx.Provider value={value}>{children}</BootCtx.Provider>;
export function useBoot(): Boot { const b = useContext(BootCtx); if (!b) throw new Error('Not signed in'); return b; }
export const useBootQuery = () => useQuery({ queryKey: ['boot'], queryFn: () => api<Boot>('GET', '/api/bootstrap'), retry: false, staleTime: 60_000 });

export function usePerms() {
  const { user, settings } = useBoot();
  return useMemo(() => {
    const p = settings.permissions[user.role as keyof typeof settings.permissions] ?? ({} as any);
    const of = (name: string) => (ENTITY[name]?.resource ?? name) as Resource;
    return {
      read: (name: string) => of(name) === ('self' as any) || (p[of(name)]?.read ?? 'none') !== 'none',
      write: (name: string) => of(name) === ('self' as any) || (p[of(name)]?.write ?? 'none') !== 'none',
      del: (name: string) => of(name) === ('self' as any) || !!p[of(name)]?.delete,
      admin: (name: string) => p[of(name)]?.write === 'all',
      scope: (name: string) => p[of(name)]?.read ?? 'none',
    };
  }, [user.role, settings]);
}

/** Loads full collections for the given entities. Entities the role cannot read come back empty. */
export function useData<K extends string>(...names: K[]): { [P in K]: R[] } & { loading: boolean; error: Error | null } {
  const perms = usePerms();
  const qs = useQueries({ queries: names.map(n => ({ queryKey: ['e', n], queryFn: () => api<R[]>('GET', `/api/e/${n}`), enabled: perms.read(n), staleTime: 20_000 })) });
  const out: any = { loading: qs.some((q, i) => perms.read(names[i]) && q.isLoading), error: (qs.find(q => q.error)?.error as Error) ?? null };
  names.forEach((n, i) => { out[n] = qs[i].data ?? EMPTY_ARR; });
  return out;
}
const EMPTY_ARR: R[] = [];

/** Loads the rows of one collection that belong to a single record (e.g. a lead's activities). */
export function useRows(entity: string, params: Record<string, string | null | undefined>): { rows: R[]; loading: boolean } {
  const perms = usePerms();
  const qs = Object.entries(params).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`).join('&');
  const on = perms.read(entity) && Object.values(params).every(Boolean);
  const q = useQuery({ queryKey: ['e', entity, qs], queryFn: () => api<R[]>('GET', `/api/e/${entity}?${qs}`), enabled: on, staleTime: 20_000 });
  return { rows: q.data ?? EMPTY_ARR, loading: on && q.isLoading };
}

export const DATASET_KEYS = ['leads', 'properties', 'contacts', 'offers', 'contracts', 'transactions', 'revenue', 'expenses', 'communications', 'tasks', 'campaigns', 'dispositions', 'buyer_interests', 'buyers', 'markets'] as const;
export function useDataset(): { ds: Dataset; loading: boolean } {
  const d = useData(...DATASET_KEYS);
  const { users } = useBoot();
  const ds = useMemo(() => ({ ...Object.fromEntries(DATASET_KEYS.map(k => [k, d[k]])), users }) as unknown as Dataset, [users, ...DATASET_KEYS.map(k => d[k])]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ds, loading: d.loading };
}

export function useMaps<T extends Record<string, R[]>>(lists: T): { [P in keyof T]: Map<string, R> } {
  return useMemo(() => Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, new Map(v.map(r => [r.id, r]))])) as any, Object.values(lists)); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Write helpers. Any write can trigger server-side automations, so all cached collections are refreshed. */
export function useWrite() {
  const qc = useQueryClient();
  return useMemo(() => {
    const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['e'] }), qc.invalidateQueries({ queryKey: ['x'] })]);
    const run = async <T,>(p: Promise<T>) => { try { return await p; } finally { void refresh(); } };
    return {
      refresh,
      create: (entity: string, data: R) => run(api<R>('POST', `/api/e/${entity}`, data)),
      patch: (entity: string, id: string, data: R) => run(api<R>('PATCH', `/api/e/${entity}/${id}`, data)),
      remove: (entity: string, id: string) => run(api('DELETE', `/api/e/${entity}/${id}`)),
      bulk: (entity: string, body: R) => run(api<{ ok: number; failed: { id: string; error: string }[] }>('POST', `/api/e/${entity}/bulk`, body)),
      post: <T = any,>(path: string, body?: unknown) => run(api<T>('POST', path, body)),
      call: <T = any,>(method: string, path: string, body?: unknown) => run(api<T>(method, path, body)),
      refreshBoot: () => qc.invalidateQueries({ queryKey: ['boot'] }),
    };
  }, [qc]);
}
