import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import fs from 'node:fs';
import path from 'node:path';
import { app } from './app';
import { tickAll } from './automation';
import { secureHeaders } from 'hono/secure-headers';
import { closeDb, initDb } from './db';

// Minimal .env loader (no dependency): KEY=value lines, existing env wins.
const envFile = path.resolve('.env');
if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const port = Number(process.env.PORT || 8787);
await initDb({ memory: process.env.DB_MEMORY === 'true' });

const dist = path.resolve('dist');
if (fs.existsSync(dist)) {
  // Web app pages: strict Content-Security-Policy (no inline or third-party scripts), no framing.
  app.use('/*', secureHeaders({
    contentSecurityPolicy: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'blob:'], fontSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"], frameAncestors: ["'none'"] },
    xFrameOptions: 'DENY', referrerPolicy: 'same-origin', crossOriginEmbedderPolicy: false,
  }));
  app.use('/*', serveStatic({ root: './dist' }));
  app.get('*', c => c.html(fs.readFileSync(path.join(dist, 'index.html'), 'utf8')));
}

const server = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => console.log(`Wholesale CRM API listening on http://localhost:${port} (${process.env.DATABASE_URL ? 'PostgreSQL' : 'embedded PGlite'})`));

// Scheduler: follow-up sequences, time-based automations, reminders, offer expiry.
let ticking = false;
setInterval(async () => { if (ticking) return; ticking = true; try { await tickAll(); } finally { ticking = false; } }, 60_000);
setTimeout(() => tickAll().catch(e => console.error(e)), 5_000);

// Flush and close the database cleanly on shutdown.
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, async () => { server.close(); await closeDb()?.catch(() => {}); process.exit(0); });
