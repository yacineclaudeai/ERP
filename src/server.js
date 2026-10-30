// Local server: embedded Postgres (PGlite) stored in ./data/pg, or a real Postgres via DATABASE_URL.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { openPgDb } from './db.js';
import { openLocalDb } from './db-local.js';
import { createApp } from './app.js';
import { syncTracking } from './services/orders.js';
import { syncAllSheets } from './services/sheets.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {
  // no .env file: rely on real environment variables
}

const db = process.env.DATABASE_URL
  ? openPgDb(process.env.DATABASE_URL)
  : await openLocalDb(process.env.DB_PATH || path.join(root, 'data/pg'));

const app = new Hono();
app.route('/', createApp(db));
app.use('/*', serveStatic({ root: path.relative(process.cwd(), path.join(root, 'public')) || '.' }));

const port = Number(process.env.PORT) || 3000;
serve({ fetch: app.fetch, port }, () => console.log(`ERP running on http://localhost:${port}`));

// Pull delivered/returned statuses from the delivery companies every 30 minutes
// (on Netlify the scheduled function sync-tracking does this).
setInterval(() => syncTracking(db).catch((e) => console.error('sync failed', e)), 30 * 60_000);
setInterval(() => syncAllSheets(db).catch((e) => console.error('sheets sync failed', e)), 5 * 60_000);
