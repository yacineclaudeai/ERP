import { Hono } from 'hono';
import { hashPassword } from './auth.js';
import { apiRouter } from './routes/api.js';
import { publicRouter } from './routes/public.js';

// The HTTP API, shared by the Netlify function (production) and src/server.js (local).
export function createApp(db) {
  const app = new Hono();
  let adminChecked = false;
  app.use('/api/*', async (c, next) => {
    if (!adminChecked) {
      await ensureAdmin(db);
      adminChecked = true;
    }
    return next();
  });
  app.route('/api/public', publicRouter(db));
  app.route('/api', apiRouter(db));
  app.notFound((c) => c.json({ error: 'Not found' }, 404));
  app.onError((err, c) => {
    // 23505 = unique violation (a name or username already used).
    const status = err.status || (err.code === '23505' ? 409 : 500);
    if (status >= 500) console.error(err);
    const message = status >= 500 ? 'خطأ في السيرفر' : err.code === '23505' ? 'هاد الاسم مستعمل' : err.message;
    return c.json({ error: message }, status);
  });
  return app;
}

// First start: create the admin account from ADMIN_USERNAME / ADMIN_PASSWORD.
export async function ensureAdmin(db) {
  const { n } = await db.get('SELECT COUNT(*) AS n FROM users');
  if (n) return;
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  await db.run(`INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin') ON CONFLICT (username) DO NOTHING`,
    username, hashPassword(password));
  console.log(`Admin created: ${username} (change the password after first login)`);
}
