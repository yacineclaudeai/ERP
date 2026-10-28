import { getSetting, setSetting } from '../db.js';
import { HttpError } from './orders.js';

// Rules the launch routine follows. Budgets are in the ad account currency (EUR or USD on Meta, not DZD).
const DEFAULTS = {
  mode: 'approval', // approval: build the campaign as a draft and wait for a yes; auto: go live directly
  min_stock: 20, // launch only when at least this many units are in stock
  pause_below: 5, // pause a running campaign when stock drops under this
  daily_budget: 0, // budget of each new campaign; 0 = not set yet, nothing is launched
  max_total_daily_budget: 0, // cap on the sum of running campaigns; 0 = no cap
  ad_account_id: '', // default account; a store's own ad_account_id wins
};

const LIVE = ['draft', 'active'];

export function getAdSettings(db) {
  const out = {};
  for (const [key, def] of Object.entries(DEFAULTS)) {
    const v = getSetting(db, `ads.${key}`);
    out[key] = v == null ? def : typeof def === 'number' ? Number(v) : v;
  }
  return out;
}

export function saveAdSettings(db, body) {
  for (const [key, def] of Object.entries(DEFAULTS)) {
    if (body[key] === undefined) continue;
    let v = body[key];
    if (typeof def === 'number') {
      v = Number(v);
      if (!(v >= 0)) throw new HttpError(400, `قيمة غير صحيحة: ${key}`);
    } else {
      v = String(v ?? '').trim();
    }
    if (key === 'mode' && !['approval', 'auto'].includes(v)) throw new HttpError(400, 'mode لازم approval ولا auto');
    setSetting(db, `ads.${key}`, v);
  }
  return getAdSettings(db);
}

// What the launch routine should do now: which products to launch, which campaigns to pause.
export function getAdPlan(db) {
  const s = getAdSettings(db);
  const products = db.prepare(`
    SELECT p.id, p.name, p.sku, p.price, p.stock, p.landing_url, p.active,
      s.name AS store_name, COALESCE(NULLIF(s.ad_account_id, ''), ?) AS ad_account_id,
      (SELECT COUNT(*) FROM orders o WHERE o.product_id = p.id
        AND o.created_at >= datetime('now', '-7 days')) AS orders_7d
    FROM products p LEFT JOIN stores s ON s.id = p.store_id`).all(s.ad_account_id || null);
  const campaigns = db.prepare(`SELECT * FROM ad_campaigns WHERE status IN ('draft', 'active')`).all();
  const liveByProduct = new Set(campaigns.map((c) => c.product_id));
  const byId = new Map(products.map((p) => [p.id, p]));

  let budgetUsed = campaigns.filter((c) => c.status === 'active').reduce((t, c) => t + c.daily_budget, 0);
  const cap = s.max_total_daily_budget;
  const to_launch = [];
  const skipped = [];

  const candidates = products
    .filter((p) => p.active && p.stock >= s.min_stock && !liveByProduct.has(p.id))
    .sort((a, b) => b.stock - a.stock);
  for (const p of candidates) {
    const item = { ...p, days_of_stock: p.orders_7d ? Math.round((p.stock / (p.orders_7d / 7)) * 10) / 10 : null };
    if (!p.landing_url) skipped.push({ ...item, reason: 'ما عندوش لاندينغ بيج' });
    else if (!p.ad_account_id) skipped.push({ ...item, reason: 'ما كانش حساب إعلاني للبوتيك' });
    else if (!(s.daily_budget > 0)) skipped.push({ ...item, reason: 'البودجي اليومي ما تحددش' });
    else if (cap > 0 && budgetUsed + s.daily_budget > cap) skipped.push({ ...item, reason: 'فات السقف اليومي' });
    else {
      to_launch.push({ ...item, daily_budget: s.daily_budget });
      budgetUsed += s.daily_budget;
    }
  }

  const to_pause = campaigns
    .filter((c) => {
      const p = byId.get(c.product_id);
      return !p || !p.active || p.stock < s.pause_below;
    })
    .map((c) => ({ ...c, product_name: byId.get(c.product_id)?.name, stock: byId.get(c.product_id)?.stock ?? 0 }));

  return { settings: s, to_launch, to_pause, skipped, planned_daily_budget: budgetUsed };
}

export function listAdCampaigns(db) {
  return db.prepare(`
    SELECT c.*, p.name AS product_name, p.stock FROM ad_campaigns c JOIN products p ON p.id = c.product_id
    ORDER BY c.id DESC LIMIT 300`).all();
}

const STATUSES = ['draft', 'active', 'paused', 'stopped'];

export function recordAdCampaign(db, body) {
  const productId = Number(body.product_id);
  if (!db.prepare('SELECT 1 FROM products WHERE id = ?').get(productId)) throw new HttpError(404, 'المنتج ما كانش');
  const status = body.status || 'draft';
  if (!STATUSES.includes(status)) throw new HttpError(400, 'حالة غير صحيحة');
  const live = db.prepare(`SELECT id FROM ad_campaigns WHERE product_id = ? AND status IN (${LIVE.map(() => '?').join(',')})`)
    .get(productId, ...LIVE);
  if (live && LIVE.includes(status)) throw new HttpError(409, 'هذا المنتج عندو حملة شاعلة');
  const r = db.prepare(`INSERT INTO ad_campaigns (product_id, ad_account_id, meta_campaign_id, daily_budget, status, note)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    productId, body.ad_account_id ? String(body.ad_account_id) : null,
    body.meta_campaign_id ? String(body.meta_campaign_id) : null,
    Number(body.daily_budget) || 0, status, body.note ? String(body.note) : null,
  );
  return db.prepare('SELECT * FROM ad_campaigns WHERE id = ?').get(Number(r.lastInsertRowid));
}

export function updateAdCampaign(db, id, body) {
  const c = db.prepare('SELECT * FROM ad_campaigns WHERE id = ?').get(id);
  if (!c) throw new HttpError(404, 'الحملة ما كانش');
  const status = body.status ?? c.status;
  if (!STATUSES.includes(status)) throw new HttpError(400, 'حالة غير صحيحة');
  db.prepare(`UPDATE ad_campaigns SET status = ?, meta_campaign_id = ?, daily_budget = ?, note = ?,
    updated_at = datetime('now') WHERE id = ?`).run(
    status, body.meta_campaign_id ?? c.meta_campaign_id,
    body.daily_budget != null ? Number(body.daily_budget) : c.daily_budget, body.note ?? c.note, id,
  );
  return db.prepare('SELECT * FROM ad_campaigns WHERE id = ?').get(id);
}
