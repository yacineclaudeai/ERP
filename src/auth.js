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

// A short fingerprint of the stored password: a session made before a password change stops working.
const passwordVersion = (hash) => crypto.createHash('sha256').update(String(hash)).digest('base64url').slice(0, 12);

export function setSession(c, user) {
  const token = sign({ uid: user.id, pv: passwordVersion(user.password_hash), exp: Date.now() + SESSION_DAYS * 86400_000 });
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
    const row = session && await db.get('SELECT id, username, role, permissions, accounting_store_ids, password_hash FROM users WHERE id = ?', session.uid);
    if (!row || session.pv !== passwordVersion(row.password_hash)) return c.json({ error: 'غير مسجل' }, 401);
    c.set('user', publicUser(row));
    return next();
  };
}

// What a non-admin account can be allowed to see and do, by page like Ecotrack's
// employee roles: the first key of a group opens the page, the others are its actions.
export const PERMISSION_GROUPS = [
  ['قيد التأكيد', {
    confirm: 'يشوف الطلبيات قيد التأكيد',
    'confirm.all': 'يشوف طلبيات كل المؤكدين (ماشي غير تاعو)',
    'confirm.add': 'إضافة طلبية يدوية',
    'confirm.edit': 'تعديل (الاسم، الهاتف، العنوان، الولاية، الكمية...)',
    'confirm.price': 'تعديل سعر المنتج',
    'confirm.delivery_price': 'تعديل سعر التوصيل',
    'confirm.company': 'تبديل شركة التوصيل',
    'confirm.confirm': 'تأكيد',
    'confirm.fail': 'ما ردش (الفاشلة) / مؤجلة',
    'confirm.cancel': 'إلغاء / وهمية / إرجاعها جديدة',
    'confirm.delete': 'حذف',
    'confirm.assign': 'تعيين الطلبيات للمؤكدين',
  }],
  ['تتبع الطلبيات', {
    tracking: 'يشوف الطلبيات المؤكدة والمرسلة',
    'tracking.edit': 'تعديل طلبية مؤكدة',
    'tracking.dispatch': 'إرسال لشركة التوصيل',
    'tracking.back': 'رجوع للتأكيد (الشاحنة الحمراء)',
    'tracking.back_dispatched': 'رجوع طلبية راهي عند التوصيل (يتحذف الطرد)',
    'tracking.cancel': 'إلغاء طلبية مؤكدة',
    'tracking.delivered': 'مستلمة',
    'tracking.returned': 'روتور / وصل الروتور',
    'tracking.sync': 'تحديث حالات التوصيل',
  }],
  ['المنتجات', {
    products: 'يشوف المنتجات',
    'products.edit': 'إضافة وتعديل (البوتيك، الشركة، السعر)',
    'products.stock': 'المخزون',
    'products.delete': 'حذف وإخفاء',
  }],
  ['الإحصائيات', { stats: 'الإحصائيات', dashboard: 'لوحة التحكم' }],
  ['الفايدة لكل منتج', { accounting: 'الفايدة لكل منتج' }],
  ['مصاريف الإشهار', { ads: 'مصاريف الإشهار' }],
  ['البوتيكات', { stores: 'البوتيكات' }],
  ['الشيتات', { sheets: 'الشيتات' }],
  ['التوصيل', { delivery: 'التوصيل' }],
];

export const PERMISSIONS = Object.assign({}, ...PERMISSION_GROUPS.map(([, perms]) => perms));

export const parsePermissions = (v) => String(v || '').split(',').map((s) => s.trim()).filter((s) => s in PERMISSIONS);

export const parseIds = (v) => [...new Set(String(v || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0))];

export function publicUser(row) {
  const admin = row.role === 'admin';
  const permissions = admin ? Object.keys(PERMISSIONS) : parsePermissions(row.permissions);
  // Stores whose accounting this account sees; empty = all of them.
  const accounting_store_ids = admin ? [] : parseIds(row.accounting_store_ids);
  return { id: row.id, username: row.username, role: row.role, permissions, accounting_store_ids };
}

export const can = (user, perm) => user?.role === 'admin' || Boolean(user?.permissions?.includes(perm));

// Lets the request through when the account has any of these permissions.
export const requirePerm = (...perms) => async (c, next) => {
  if (!perms.some((p) => can(c.get('user'), p))) return c.json({ error: 'ما عندكش الصلاحية' }, 403);
  return next();
};

export async function requireAdmin(c, next) {
  if (c.get('user')?.role !== 'admin') return c.json({ error: 'للمدير فقط' }, 403);
  return next();
}
