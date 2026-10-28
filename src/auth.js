import crypto from 'node:crypto';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

const SESSION_DAYS = 30;
const COOKIE = 'erp_session';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

function secret() {
  return process.env.SESSION_SECRET || 'dev-secret-change-me';
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function unsign(token) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

export function setSession(c, user) {
  const token = sign({ uid: user.id, exp: Date.now() + SESSION_DAYS * 86400_000 });
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: new URL(c.req.url).protocol === 'https:',
    path: '/',
    maxAge: SESSION_DAYS * 86400,
  });
}

export function clearSession(c) {
  deleteCookie(c, COOKIE, { path: '/' });
}

// The campaign-launch routine has no browser session: it sends AUTOMATION_TOKEN as a bearer token,
// which only opens the /api/ads routes.
function isAutomation(c) {
  const token = process.env.AUTOMATION_TOKEN;
  const given = (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token || !given || !c.req.path.startsWith('/api/ads/')) return false;
  return given.length === token.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

export function authMiddleware(db) {
  return async (c, next) => {
    if (isAutomation(c)) {
      c.set('user', { id: null, username: 'automation', role: 'admin' });
      return next();
    }
    const session = unsign(getCookie(c, COOKIE));
    const user = session && await db.get('SELECT id, username, role FROM users WHERE id = ?', session.uid);
    if (!user) return c.json({ error: 'غير مسجل' }, 401);
    c.set('user', user);
    return next();
  };
}

export async function requireAdmin(c, next) {
  if (c.get('user')?.role !== 'admin') return c.json({ error: 'للمدير فقط' }, 403);
  return next();
}
