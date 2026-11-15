import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import fs from 'node:fs';
import path from 'node:path';
import { app } from './app';
import { tickAll } from './automation';
import { initDb } from './db';

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
  app.use('/*', serveStatic({ root: './dist' }));
  app.get('*', c => c.html(fs.readFileSync(path.join(dist, 'index.html'), 'utf8')));
}

serve({ fetch: app.fetch, port }, () => console.log(`Wholesale CRM API listening on http://localhost:${port} (${process.env.DATABASE_URL ? 'PostgreSQL' : 'embedded PGlite'})`));

// Scheduler: follow-up sequences, time-based automations, reminders, offer expiry.
let ticking = false;
setInterval(async () => { if (ticking) return; ticking = true; try { await tickAll(); } finally { ticking = false; } }, 60_000);
setTimeout(() => tickAll().catch(e => console.error(e)), 5_000);
