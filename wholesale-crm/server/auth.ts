import crypto from 'node:crypto';
import { q, one } from './db';
import { HttpError } from './repo';

const scrypt = (pw: string, salt: Buffer) => new Promise<Buffer>((res, rej) => crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k))));

export async function hashPassword(pw: string) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw, salt);
  return ['scrypt', salt.toString('hex'), hash.toString('hex')].join(':');
}
export async function verifyPassword(pw: string, stored?: string | null) {
  if (!stored) return false;
  const [, saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const hash = Buffer.from(hashHex, 'hex');
  return crypto.timingSafeEqual(hash, await scrypt(pw, Buffer.from(saltHex, 'hex')));
}
export function validatePassword(pw: unknown): string {
  if (typeof pw !== 'string' || pw.length < 10) throw new HttpError(400, 'Password must be at least 10 characters');
  if (pw.length > 200) throw new HttpError(400, 'Password is too long');
  return pw;
}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const newToken = () => crypto.randomBytes(32).toString('base64url');
const SESSION_DAYS = 30;

export async function createSession(userId: string) {
  const token = newToken();
  await q(`insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + interval '30 days')`, [sha(token), userId]);
  await q('update users set last_login_at = now() where id = $1', [userId]);
  return token;
}
export const sessionUser = (token: string) =>
  one(`select u.id, u.org_id, u.email, u.name, u.role, u.department, u.phone, u.status, u.is_demo from sessions s join users u on u.id = s.user_id
       where s.token_hash = $1 and s.expires_at > now() and u.status = 'active'`, [sha(token)]);
export const destroySession = (token: string) => q('delete from sessions where token_hash = $1', [sha(token)]);
export const destroyUserSessions = (userId: string) => q('delete from sessions where user_id = $1', [userId]);
export const cookieOpts = () => ({ httpOnly: true, sameSite: 'Lax' as const, secure: process.env.COOKIE_SECURE === 'true', path: '/', maxAge: SESSION_DAYS * 86400 });

// Small in-memory limiter for credential endpoints.
const hits = new Map<string, number[]>();
export function rateLimit(key: string, max = 8, windowMs = 60_000) {
  const now = Date.now(), arr = (hits.get(key) ?? []).filter(t => now - t < windowMs);
  if (arr.length >= max) throw new HttpError(429, 'Too many attempts. Please wait a minute and try again.');
  arr.push(now); hits.set(key, arr);
  if (hits.size > 5000) hits.clear();
}
