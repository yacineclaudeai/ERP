import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { openDb } from './db.js';
import { hashPassword } from './auth.js';
import { apiRouter } from './routes/api.js';
import { publicRouter } from './routes/public.js';
import { syncTracking } from './services/orders.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function createApp(db) {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '200kb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use('/api/public', publicRouter(db));
  app.use('/api', apiRouter(db));
  app.use(express.static(path.join(root, 'public')));

  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'خطأ في السيرفر' : err.message });
  });
  return app;
}

export function ensureAdmin(db) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (n) return;
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  db.prepare(`INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')`).run(username, hashPassword(password));
  console.log(`Admin created: ${username} / ${password} (change the password after first login)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.loadEnvFile(path.join(root, '.env'));
  } catch {
    // no .env file: rely on real environment variables
  }
  const db = openDb();
  ensureAdmin(db);
  const port = Number(process.env.PORT) || 3000;
  createApp(db).listen(port, () => console.log(`ERP running on http://localhost:${port}`));

  // Pull delivered/returned statuses from the delivery companies every 30 minutes.
  setInterval(() => syncTracking(db).catch((e) => console.error('sync failed', e)), 30 * 60_000);
}
