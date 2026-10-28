import crypto from 'node:crypto';

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
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  return payload.exp > Date.now() ? payload : null;
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function setSession(res, user) {
  const token = sign({ uid: user.id, exp: Date.now() + SESSION_DAYS * 86400_000 });
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', maxAge: SESSION_DAYS * 86400_000 });
}

export function clearSession(res) {
  res.clearCookie(COOKIE);
}

// The campaign-launch routine has no browser session: it sends AUTOMATION_TOKEN as a bearer token,
// which only opens the /ads routes.
function isAutomation(req) {
  const token = process.env.AUTOMATION_TOKEN;
  const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token || !given || !req.path.startsWith('/ads/')) return false;
  return given.length === token.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

export function authMiddleware(db) {
  return (req, res, next) => {
    if (isAutomation(req)) {
      req.user = { id: null, username: 'automation', role: 'admin' };
      return next();
    }
    const session = unsign(readCookie(req, COOKIE));
    const user = session && db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(session.uid);
    if (!user) return res.status(401).json({ error: 'غير مسجل' });
    req.user = user;
    next();
  };
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'للمدير فقط' });
  next();
}
