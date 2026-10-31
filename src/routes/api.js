import crypto from 'node:crypto';
import { Hono } from 'hono';
import { getSetting, setSetting } from '../db.js';
import {
  hashPassword, verifyPassword, setSession, clearSession, authMiddleware, requireAdmin, requirePerm, can, publicUser, parsePermissions, parseIds, PERMISSIONS,
} from '../auth.js';
import { WILAYAS, isValidWilaya } from '../wilayas.js';
import { PROVIDER_NAMES } from '../delivery/index.js';
import {
  STATUSES, HttpError, getOrder, createOrder, updateOrder, applyAction, assignOrders,
  confirmAndDispatch, dispatchOrder, backToConfirmation, syncTracking, rerouteProductOrders, deleteOrder,
} from '../services/orders.js';
import { getStats, localDay, getConfirmationStats, getDeliveryStats } from '../services/stats.js';
import {
  getAccounting, saveDefaults, saveProductCosts, addExpense, deleteExpense, addPurchase, deletePurchase,
} from '../services/accounting.js';
import {
  getAdSettings, saveAdSettings, getAdPlan, listAdCampaigns, recordAdCampaign, updateAdCampaign,
} from '../services/ads.js';
import { scanStore, applyStoreLinks, normalizeName, newProductStore } from '../services/branches.js';
import { SHEET_FIELDS, fetchSheetRows, mergeVariantProducts, suggestMapping, syncSheet, syncAllSheets } from '../services/sheets.js';
import * as lf from '../services/lightfunnels.js';

const newKey = () => crypto.randomBytes(12).toString('base64url');
const idParam = (c) => Math.max(0, Math.floor(Number(c.req.param('id')))) || 0;

// JSON from the admin UI, or a classic form post.
export async function readBody(c) {
  const type = c.req.header('content-type') || '';
  if (type.includes('application/json')) return (await c.req.json().catch(() => ({}))) || {};
  if (type.includes('form')) return c.req.parseBody();
  return {};
}

export function apiRouter(db) {
  const r = new Hono();
  r.use('*', async (c, next) => {
    if (['POST', 'PUT', 'PATCH'].includes(c.req.method)) c.set('body', await readBody(c));
    return next();
  });
  const body = (c) => c.get('body') || {};

  // ---- auth ----
  // Wrong passwords: 20 tries per address per 10 minutes, and an account is locked 15 minutes after 5 in a row.
  const loginHits = new Map();
  r.post('/auth/login', async (c) => {
    const b = body(c);
    const ip = c.req.header('x-nf-client-connection-ip') || c.req.header('x-forwarded-for') || 'unknown';
    const now = Date.now();
    const recent = (loginHits.get(ip) || []).filter((t) => now - t < 600_000);
    if (recent.length >= 20) return c.json({ error: 'محاولات كثيرة، عاود من بعد 10 دقايق' }, 429);
    const user = await db.get('SELECT * FROM users WHERE username = ?', String(b.username || ''));
    if (user?.locked_until && new Date(user.locked_until).getTime() > now) {
      return c.json({ error: 'الحساب مقفول 15 دقيقة بسبب محاولات غالطة كثيرة' }, 429);
    }
    if (!user || !verifyPassword(String(b.password || ''), user.password_hash)) {
      loginHits.set(ip, [...recent, now]);
      if (user) {
        await db.run(`UPDATE users SET failed_logins = failed_logins + 1,
          locked_until = CASE WHEN failed_logins + 1 >= 5 THEN now() + interval '15 minutes' ELSE locked_until END WHERE id = ?`, user.id);
      }
      return c.json({ error: 'اسم المستخدم أو كلمة السر غير صحيحة' }, 401);
    }
    if (user.failed_logins || user.locked_until) await db.run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', user.id);
    setSession(c, user);
    return c.json(publicUser(user));
  });
  r.post('/auth/logout', (c) => {
    clearSession(c);
    return c.json({ ok: true });
  });

  r.use('*', authMiddleware(db));
  r.get('/auth/me', (c) => c.json(c.get('user')));

  r.get('/meta', (c) => c.json({ wilayas: WILAYAS, statuses: STATUSES, providers: PROVIDER_NAMES }));

  // ---- products ----
  r.get('/products', async (c) => c.json(await db.all(`
    SELECT p.*, s.name AS store_name, COALESCE(pc.name, sc.name) AS company_name, p.company_id IS NULL AS company_from_store,
      (SELECT COUNT(*) FROM orders o WHERE o.product_id = p.id) AS orders_count,
      (SELECT COUNT(*) FROM orders o WHERE o.product_id = p.id AND o.status IN ('new','no_answer','postponed')) AS pending_count
    FROM products p LEFT JOIN stores s ON s.id = p.store_id
    LEFT JOIN delivery_companies pc ON pc.id = p.company_id
    LEFT JOIN delivery_companies sc ON sc.id = s.company_id
    ORDER BY p.active DESC, p.id DESC`)));

  const productFields = (b) => ({
    name: String(b.name || '').trim(),
    sku: b.sku ? String(b.sku).trim() : null,
    price: Number(b.price) || 0,
    cost: Number(b.cost) || 0,
    landing_url: b.landing_url ? String(b.landing_url).trim() : null,
    store_id: b.store_id ? Number(b.store_id) : null,
    company_id: b.company_id ? Number(b.company_id) : null,
    active: !(b.active === false || b.active === 0 || b.active === '0'),
    ad_daily_budget: Number(b.ad_daily_budget) > 0 ? Number(b.ad_daily_budget) : null,
    ad_creative_folder: b.ad_creative_folder ? String(b.ad_creative_folder).trim() : null,
  });

  r.post('/products', requirePerm('products'), async (c) => {
    const f = productFields(body(c));
    if (!f.name) throw new HttpError(400, 'اسم المنتج ضروري');
    // A new product is a test until the user moves it to a real store.
    f.store_id ??= await newProductStore(db);
    const stock = Math.floor(Number(body(c).stock) || 0);
    const product = await db.tx(async (t) => {
      const { rows: [p] } = await t.run(`
        INSERT INTO products (name, sku, price, cost, stock, landing_url, store_id, company_id, active, ad_daily_budget, ad_creative_folder, public_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        f.name, f.sku, f.price, f.cost, stock, f.landing_url, f.store_id, f.company_id, f.active, f.ad_daily_budget, f.ad_creative_folder, newKey());
      if (stock) {
        await t.run(`INSERT INTO stock_movements (product_id, quantity, reason) VALUES (?, ?, 'مخزون أولي')`, p.id, stock);
      }
      return p;
    });
    return c.json(product, 201);
  });

  r.post('/products/merge-variants', requireAdmin, async (c) => c.json(await mergeVariantProducts(db)));

  r.put('/products/:id', requirePerm('products'), async (c) => {
    const id = idParam(c);
    const b = body(c);
    const f = productFields(b);
    if (!f.name) throw new HttpError(400, 'اسم المنتج ضروري');
    const { changes } = await db.run(`
      UPDATE products SET name = ?, sku = ?, price = ?, cost = ?, landing_url = ?, store_id = ?, active = ? WHERE id = ?`,
      f.name, f.sku, f.price, f.cost, f.landing_url, f.store_id, f.active, id);
    if (!changes) throw new HttpError(404, 'المنتج غير موجود');
    // Only touch the ad and company fields the caller sends, so older forms do not wipe them.
    for (const key of ['ad_daily_budget', 'ad_creative_folder', 'company_id']) {
      if (b[key] !== undefined) await db.run(`UPDATE products SET ${key} = ? WHERE id = ?`, f[key], id);
    }
    await rerouteProductOrders(db, id);
    return c.json(await db.get('SELECT * FROM products WHERE id = ?', id));
  });

  // Move a product to a store (branch) and/or delivery company from the orders
  // table; its open orders follow.
  r.put('/products/:id/store', requirePerm('products'), async (c) => {
    const id = idParam(c);
    const b = body(c);
    if (!await db.get('SELECT id FROM products WHERE id = ?', id)) throw new HttpError(404, 'المنتج غير موجود');
    if (b.store_id !== undefined) {
      const storeId = b.store_id ? Number(b.store_id) : null;
      if (storeId && !await db.get('SELECT id FROM stores WHERE id = ?', storeId)) throw new HttpError(404, 'البوتيك غير موجود');
      await db.run('UPDATE products SET store_id = ? WHERE id = ?', storeId, id);
    }
    if (b.company_id !== undefined) {
      const companyId = b.company_id ? Number(b.company_id) : null;
      if (companyId && !await db.get('SELECT id FROM delivery_companies WHERE id = ?', companyId)) throw new HttpError(404, 'الشركة غير موجودة');
      await db.run('UPDATE products SET company_id = ? WHERE id = ?', companyId, id);
    }
    // The second and third confirmation agents (admin only): failed orders go to them.
    for (const key of ['backup_agent_id', 'third_agent_id']) {
      if (b[key] === undefined) continue;
      if (c.get('user').role !== 'admin') throw new HttpError(403, 'غير المدير');
      const agentId = b[key] ? Number(b[key]) : null;
      if (agentId && !await db.get('SELECT id FROM users WHERE id = ?', agentId)) throw new HttpError(404, 'المستخدم غير موجود');
      await db.run(`UPDATE products SET ${key} = ? WHERE id = ?`, agentId, id);
    }
    return c.json({ orders: await rerouteProductOrders(db, id) });
  });

  // Link products to stores from the parcels each store already shipped.
  r.post('/branches/scan', requirePerm('products'), async (c) => {
    const b = body(c);
    return c.json(await scanStore(db, Number(b.store_id), Math.max(1, Number(b.page) || 1)));
  });
  r.post('/branches/apply', requirePerm('products'), async (c) => c.json(await applyStoreLinks(db, body(c).texts)));

  r.post('/products/:id/regenerate-key', requirePerm('products'), async (c) => {
    const { rows: [p] } = await db.run('UPDATE products SET public_key = ? WHERE id = ? RETURNING *', newKey(), idParam(c));
    if (!p) throw new HttpError(404, 'المنتج غير موجود');
    return c.json(p);
  });

  // Stock in (new purchase) or correction. quantity may be negative.
  r.post('/products/:id/stock', requirePerm('products'), async (c) => {
    const id = idParam(c);
    const qty = Math.floor(Number(body(c).quantity));
    if (!qty) throw new HttpError(400, 'الكمية ضرورية');
    const reason = String(body(c).reason || (qty > 0 ? 'دخول سلعة' : 'تصحيح'));
    const product = await db.tx(async (t) => {
      const { rows: [p] } = await t.run('UPDATE products SET stock = stock + ? WHERE id = ? RETURNING *', qty, id);
      if (!p) throw new HttpError(404, 'المنتج غير موجود');
      await t.run('INSERT INTO stock_movements (product_id, quantity, reason) VALUES (?, ?, ?)', id, qty, reason);
      return p;
    });
    return c.json(product);
  });

  r.get('/products/:id/stock-movements', async (c) => c.json(await db.all(`
    SELECT m.*, o.reference FROM stock_movements m LEFT JOIN orders o ON o.id = m.order_id
    WHERE m.product_id = ? ORDER BY m.id DESC LIMIT 200`, idParam(c))));

  // ---- orders ----
  // Orders: the confirmation page and the tracking page each need their own permission.
  const CONFIRM_STATUSES = ['new', 'no_answer', 'postponed', 'cancelled', 'fake'];
  const TRACKING_STATUSES = ['confirmed', 'dispatched', 'delivered', 'returned'];
  const TRACKING_ACTIONS = ['delivered', 'returned', 'return_received'];
  const ordersAccess = requirePerm('confirm', 'tracking');
  const FAILED_RE = /^failed_([1-5])$/;
  const FAILED_N = (alias) => `LEAST(5, GREATEST(1, ${alias}.call_attempts))`;
  const allowedStatuses = (user) => [
    ...(can(user, 'confirm') ? CONFIRM_STATUSES : []), ...(can(user, 'tracking') ? TRACKING_STATUSES : []),
  ];
  // A non-admin sees, at the confirmation stage, only the orders given to them.
  const mineOnly = (user, alias = 'o') => (user.role === 'admin' ? null : {
    sql: `(${alias}.status NOT IN (${CONFIRM_STATUSES.map(() => '?').join(',')}) OR ${alias}.assigned_to = ?)`,
    args: [...CONFIRM_STATUSES, user.id],
  });
  const checkOrderAccess = async (user, id) => {
    const order = await getOrder(db, id);
    if (!allowedStatuses(user).includes(order.status)) throw new HttpError(403, 'ما عندكش الصلاحية على هاد الطلبية');
    if (user.role !== 'admin' && CONFIRM_STATUSES.includes(order.status) && order.assigned_to !== user.id) {
      throw new HttpError(403, 'هاد الطلبية ماشي تاعك');
    }
  };

  r.get('/orders', ordersAccess, async (c) => {
    const q = c.req.query();
    const where = [];
    const args = [];
    const allowed = allowedStatuses(c.get('user'));
    const tokens = q.status ? String(q.status).split(',') : [];
    const asked = tokens.filter((s) => STATUSES.includes(s));
    // failed_N: "ما ردش" orders on their Nth failed call (failed_5 = 5 or more).
    const failed = can(c.get('user'), 'confirm') ? tokens.map((s) => FAILED_RE.exec(s)?.[1]).filter(Boolean).map(Number) : [];
    const list = (asked.length || failed.length ? asked : allowed).filter((s) => allowed.includes(s));
    if (failed.length) {
      where.push(`(o.status IN (${list.map(() => '?').join(',') || 'NULL'})
        OR (o.status = 'no_answer' AND ${FAILED_N('o')} IN (${failed.map(() => '?').join(',')})))`);
      args.push(...list, ...failed);
    } else if (list.length < STATUSES.length) where.push(`o.status IN (${list.map(() => '?').join(',') || 'NULL'})`), args.push(...list);
    const mine = mineOnly(c.get('user'));
    if (mine) where.push(mine.sql), args.push(...mine.args);
    if (q.assigned_to === 'none') where.push('o.assigned_to IS NULL');
    else if (Number(q.assigned_to)) where.push('o.assigned_to = ?'), args.push(Number(q.assigned_to));
    if (Number(q.product_id)) where.push('o.product_id = ?'), args.push(Number(q.product_id));
    if (Number(q.store_id)) where.push('p.store_id = ?'), args.push(Number(q.store_id));
    if (Number(q.wilaya)) where.push('o.wilaya_code = ?'), args.push(Number(q.wilaya));
    if (Number(q.company_id)) where.push('o.company_id = ?'), args.push(Number(q.company_id));
    if (q.source) where.push('o.source = ?'), args.push(String(q.source));
    if (q.stop_desk === '0' || q.stop_desk === '1') where.push('o.stop_desk = ?'), args.push(q.stop_desk === '1');
    const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
    if (isDate(q.from)) where.push(`${localDay('o.created_at')} >= ?::date`), args.push(q.from);
    if (isDate(q.to)) where.push(`${localDay('o.created_at')} <= ?::date`), args.push(q.to);
    if (q.dispatch_error === '1') where.push('o.dispatch_error IS NOT NULL');
    if (q.q) {
      const like = `%${String(q.q).trim()}%`;
      where.push('(o.customer_name ILIKE ? OR o.phone LIKE ? OR o.reference ILIKE ? OR o.tracking ILIKE ?)');
      args.push(like, like, like, like);
    }
    const limit = Math.min(500, Number(q.limit) || 100);
    const offset = Math.max(0, Number(q.offset) || 0);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await db.all(`
      SELECT o.*, p.name AS product_name, p.store_id, p.company_id AS product_company_id, s.name AS store_name, c.name AS company_name,
        (SELECT u.username FROM order_events e JOIN users u ON u.id = e.user_id
          WHERE e.order_id = o.id AND e.type = 'confirmed' ORDER BY e.id DESC LIMIT 1) AS confirmed_by,
        (SELECT username FROM users WHERE id = o.assigned_to) AS assigned_name
      FROM orders o JOIN products p ON p.id = o.product_id
      LEFT JOIN stores s ON s.id = p.store_id
      LEFT JOIN delivery_companies c ON c.id = o.company_id
      ${whereSql} ORDER BY o.id DESC LIMIT ? OFFSET ?`, ...args, limit, offset);
    const { total } = await db.get(`SELECT COUNT(*) AS total FROM orders o JOIN products p ON p.id = o.product_id ${whereSql}`, ...args);
    // The extra products of these orders.
    const items = rows.length ? await db.all(`SELECT i.order_id, i.product_id, i.quantity, i.unit_price, p.name AS product_name
      FROM order_items i JOIN products p ON p.id = i.product_id
      WHERE i.order_id IN (${rows.map(() => '?').join(',')}) ORDER BY i.id`, ...rows.map((o) => o.id)) : [];
    for (const o of rows) o.items = items.filter((i) => i.order_id === o.id);
    // Customer check: how many of this phone's orders were delivered or returned (all stores, our own data).
    const phones = [...new Set(rows.map((o) => o.phone).filter(Boolean))];
    const history = phones.length ? await db.all(`SELECT phone, COUNT(*) FILTER (WHERE status = 'delivered') AS delivered,
      COUNT(*) FILTER (WHERE status = 'returned') AS returned FROM orders
      WHERE phone IN (${phones.map(() => '?').join(',')}) GROUP BY phone`, ...phones) : [];
    const byPhone = new Map(history.map((h) => [h.phone, h]));
    for (const o of rows) {
      const h = byPhone.get(o.phone);
      o.delivered_count = Number(h?.delivered || 0);
      o.returned_count = Number(h?.returned || 0);
    }
    return c.json({ rows, total });
  });

  // How many orders in each status, for the tabs of the orders pages.
  r.get('/orders/counts', ordersAccess, async (c) => {
    const allowed = allowedStatuses(c.get('user'));
    const mine = mineOnly(c.get('user'), 'orders');
    const rows = await db.all(`SELECT CASE WHEN status = 'no_answer' THEN 'failed_' || ${FAILED_N('orders')} ELSE status END AS status,
      COUNT(*) AS n FROM orders ${mine ? `WHERE ${mine.sql}` : ''} GROUP BY 1`, ...(mine?.args || []));
    const byStatus = {};
    for (const x of rows) {
      const status = x.status.startsWith('failed_') ? 'no_answer' : x.status;
      if (!allowed.includes(status)) continue;
      if (status !== x.status) byStatus[x.status] = Number(x.n);
      byStatus[status] = (byStatus[status] || 0) + Number(x.n);
    }
    return c.json({ by_status: byStatus });
  });

  // The admin gives orders to a confirmation agent (as_new: start them again as new orders).
  r.post('/orders/assign', requireAdmin, async (c) => {
    const b = body(c);
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter((n) => n > 0);
    if (!ids.length) throw new HttpError(400, 'ما اخترت حتى طلبية');
    return c.json(await assignOrders(db, ids, Number(b.user_id) || null, { asNew: Boolean(b.as_new), byUserId: c.get('user').id }));
  });
  r.get('/orders/agents', ordersAccess, async (c) => c.json({
    agents: (await db.all("SELECT id, username, permissions FROM users WHERE role = 'agent' ORDER BY id"))
      .filter((u) => parsePermissions(u.permissions).includes('confirm')).map((u) => ({ id: u.id, username: u.username })),
    auto_transfer_after: Number(await getSetting(db, 'auto_transfer_after')) || 0,
  }));
  r.put('/orders/agents', requireAdmin, async (c) => {
    const n = Math.max(0, Math.min(20, Math.floor(Number(body(c).auto_transfer_after)) || 0));
    await setSetting(db, 'auto_transfer_after', String(n));
    return c.json({ auto_transfer_after: n });
  });

  // The "update" button of the confirmation page: reads the Google Sheets and the LightFunnels accounts now.
  r.post('/orders/pull', requireAdmin, async (c) => {
    const sheets = await syncAllSheets(db);
    const lfLinks = await db.all('SELECT * FROM lightfunnels_links WHERE active AND access_token IS NOT NULL ORDER BY id');
    const lightfunnels = { imported: 0, errors: [] };
    for (const link of lfLinks) {
      try {
        const hooks = await lf.ensureWebhooks(db, link, new URL(c.req.url).origin);
        lightfunnels.errors.push(...hooks.errors);
        const r = await lf.pullRecent(db, link);
        lightfunnels.imported += r.imported;
        lightfunnels.errors.push(...r.errors);
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        lightfunnels.errors.push(`${link.name}: ${e.message}`);
        await db.run('UPDATE lightfunnels_links SET last_error = ? WHERE id = ?', e.message, link.id);
      }
    }
    return c.json({
      sheets: Object.values(sheets).reduce((a, x) => a + (x.imported || 0), 0),
      sheet_errors: Object.values(sheets).flatMap((x) => x.errors || []),
      lightfunnels: lightfunnels.imported,
      lightfunnels_errors: lightfunnels.errors,
    });
  });

  r.get('/orders/:id', ordersAccess, async (c) => {
    await checkOrderAccess(c.get('user'), idParam(c));
    const order = await getOrder(db, idParam(c));
    const events = await db.all(`
      SELECT e.*, u.username FROM order_events e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.order_id = ? ORDER BY e.id DESC`, order.id);
    return c.json({ ...order, events });
  });

  r.post('/orders', requirePerm('confirm'), async (c) => {
    const user = c.get('user');
    const order = await createOrder(db, body(c), { source: 'manual', userId: user.id });
    // An agent's own manual order is theirs to confirm.
    if (user.role !== 'admin') await db.run('UPDATE orders SET assigned_to = ? WHERE id = ?', user.id, order.id);
    return c.json(await getOrder(db, order.id), 201);
  });


  r.delete('/orders/:id', requireAdmin, async (c) => c.json(await deleteOrder(db, idParam(c))));

  r.put('/orders/:id', ordersAccess, async (c) => {
    await checkOrderAccess(c.get('user'), idParam(c));
    // Only the admin changes the main product of an order (the others can add products).
    const b = body(c);
    if (c.get('user').role !== 'admin' && b.product_id != null && b.product_id !== '') {
      const current = await db.get('SELECT product_id FROM orders WHERE id = ?', idParam(c));
      if (Number(b.product_id) !== current?.product_id) throw new HttpError(403, 'المدير برك يبدل المنتج الرئيسي');
    }
    return c.json(await updateOrder(db, idParam(c), b, c.get('user').id));
  });

  r.post('/orders/:id/action', ordersAccess, async (c) => {
    const id = idParam(c);
    const b = body(c);
    if (!can(c.get('user'), TRACKING_ACTIONS.includes(String(b.action)) ? 'tracking' : 'confirm')) {
      throw new HttpError(403, 'ما عندكش الصلاحية');
    }
    const opts = { userId: c.get('user').id, note: b.note || null, attempts: b.attempts ?? null };
    return c.json(b.action === 'confirm'
      ? await confirmAndDispatch(db, id, opts)
      : await applyAction(db, id, String(b.action), opts));
  });

  r.post('/orders/:id/back', requirePerm('tracking'), async (c) => {
    const id = idParam(c);
    // Removing a parcel at the delivery company is for admins only.
    if ((await getOrder(db, id)).status === 'dispatched' && c.get('user').role !== 'admin') {
      throw new HttpError(403, 'غير المدير يرجّع طلبية راهي عند التوصيل');
    }
    return c.json(await backToConfirmation(db, id, { userId: c.get('user').id }));
  });

  // Retry a failed dispatch, or record a tracking number by hand.
  r.post('/orders/:id/dispatch', requirePerm('tracking'), async (c) => c.json(await dispatchOrder(db, idParam(c), {
    userId: c.get('user').id,
    tracking: body(c).tracking ? String(body(c).tracking).trim() : null,
  })));

  r.post('/orders/sync-tracking', requirePerm('tracking'), async (c) => c.json(await syncTracking(db)));

  // ---- delivery companies & routing ----
  r.get('/delivery/companies', async (c) => {
    const rows = await db.all('SELECT * FROM delivery_companies ORDER BY id');
    return c.json(rows.map((x) => ({ ...x, api_token: x.api_token ? '••••' + x.api_token.slice(-4) : null })));
  });

  const companyFields = (b) => {
    const provider = String(b.provider || '');
    if (!PROVIDER_NAMES.includes(provider)) throw new HttpError(400, 'نوع غير معروف');
    const name = String(b.name || '').trim();
    if (!name) throw new HttpError(400, 'الاسم ضروري');
    return { name, provider, base_url: b.base_url ? String(b.base_url).trim() : null, active: b.active !== false };
  };

  r.post('/delivery/companies', requirePerm('delivery'), async (c) => {
    const f = companyFields(body(c));
    const { rows: [{ id }] } = await db.run(`
      INSERT INTO delivery_companies (name, provider, base_url, api_token, active) VALUES (?, ?, ?, ?, ?) RETURNING id`,
      f.name, f.provider, f.base_url, body(c).api_token || null, f.active);
    if (!await getSetting(db, 'default_company_id')) await setSetting(db, 'default_company_id', id);
    return c.json({ id }, 201);
  });

  r.put('/delivery/companies/:id', requirePerm('delivery'), async (c) => {
    const f = companyFields(body(c));
    // An empty token field means "keep the current one".
    const token = body(c).api_token ? String(body(c).api_token) : undefined;
    await db.run(`UPDATE delivery_companies SET name = ?, provider = ?, base_url = ?, active = ?
      ${token !== undefined ? ', api_token = ?' : ''} WHERE id = ?`,
      f.name, f.provider, f.base_url, f.active, ...(token !== undefined ? [token] : []), idParam(c));
    return c.json({ ok: true });
  });

  r.get('/delivery/routes', async (c) => {
    const routes = await db.all('SELECT * FROM delivery_routes');
    const byCode = Object.fromEntries(routes.map((x) => [x.wilaya_code, x]));
    return c.json({
      default_company_id: Number(await getSetting(db, 'default_company_id')) || null,
      auto_dispatch: await getSetting(db, 'auto_dispatch') !== '0',
      routes: WILAYAS.map((w) => ({
        ...w,
        company_id: byCode[w.code]?.company_id ?? null,
        home_fee: byCode[w.code]?.home_fee ?? 0,
        desk_fee: byCode[w.code]?.desk_fee ?? 0,
      })),
    });
  });

  r.put('/delivery/routes', requirePerm('delivery'), async (c) => {
    const { routes = [], default_company_id, auto_dispatch } = body(c);
    await db.tx(async (t) => {
      for (const x of routes) {
        const code = Number(x.wilaya_code ?? x.code);
        if (!isValidWilaya(code)) continue;
        await t.run(`
          INSERT INTO delivery_routes (wilaya_code, company_id, home_fee, desk_fee) VALUES (?, ?, ?, ?)
          ON CONFLICT (wilaya_code) DO UPDATE SET company_id = excluded.company_id,
            home_fee = excluded.home_fee, desk_fee = excluded.desk_fee`,
          code, x.company_id ? Number(x.company_id) : null, Number(x.home_fee) || 0, Number(x.desk_fee) || 0);
      }
      if (default_company_id !== undefined) await setSetting(t, 'default_company_id', default_company_id || null);
      if (auto_dispatch !== undefined) await setSetting(t, 'auto_dispatch', auto_dispatch ? '1' : '0');
    });
    return c.json({ ok: true });
  });

  // ---- stores (boutiques) ----
  r.get('/stores', async (c) => {
    const stores = await db.all(`
      SELECT s.*, c.name AS company_name,
        (SELECT COUNT(*) FROM products p WHERE p.store_id = s.id) AS products_count
      FROM stores s LEFT JOIN delivery_companies c ON c.id = s.company_id ORDER BY s.name`);
    // Tokens never leave the server: only whether one is set.
    const accounts = await db.all(`
      SELECT a.store_id, a.company_id, c.name AS company_name, a.api_token IS NOT NULL AND a.api_token <> '' AS has_token,
        a.api_key IS NOT NULL AND a.api_key <> '' AS has_key
      FROM store_accounts a JOIN delivery_companies c ON c.id = a.company_id ORDER BY c.name`);
    const routes = await db.all(`
      SELECT r.*, c.name AS company_name FROM store_routes r JOIN delivery_companies c ON c.id = r.company_id
      ORDER BY r.wilaya_code`);
    const newStore = await newProductStore(db);
    return c.json(stores.map((s) => ({
      ...s,
      new_products: s.id === newStore,
      routes: routes.filter((x) => x.store_id === s.id),
      accounts: accounts.filter((x) => x.store_id === s.id),
    })));
  });

  const saveStore = (id, b) => {
    const name = String(b.name || '').trim();
    if (!name) throw new HttpError(400, 'اسم البوتيك ضروري');
    const companyId = b.company_id ? Number(b.company_id) : null;
    return db.tx(async (t) => {
      // A token for an existing store goes on that store (تعديل), not on a new
      // one: a new "YACINE packers" store would hold the token with no products.
      const key = normalizeName(name);
      const clash = (await t.all('SELECT id, name FROM stores WHERE id <> ?', id || 0))
        .find((s) => { const n = normalizeName(s.name); return n === key || (!id && n && ` ${key} `.includes(` ${n} `)); });
      if (clash) throw new HttpError(409, `البوتيك ${clash.name} كاينة: باش تزيد التوكن اضغط "تعديل" قدامها`);
      if (id) {
        const { changes } = await t.run('UPDATE stores SET name = ?, company_id = ? WHERE id = ?', name, companyId, id);
        if (!changes) throw new HttpError(404, 'البوتيك ما كانش');
      } else {
        id = (await t.run('INSERT INTO stores (name, company_id) VALUES (?, ?) RETURNING id', name, companyId)).rows[0].id;
      }
      if (b.ad_account_id !== undefined) {
        const account = String(b.ad_account_id || '').replace(/^act_/, '').trim() || null;
        await t.run('UPDATE stores SET ad_account_id = ? WHERE id = ?', account, id);
      }
      // The store's own token (and key, for My Ecom) at each company. Empty = keep.
      for (const a of Array.isArray(b.accounts) ? b.accounts : []) {
        if (!a.company_id) continue;
        const token = a.api_token ? String(a.api_token).trim() : null;
        const key = a.api_key ? String(a.api_key).trim() : null;
        if (!token && !key && !a.clear) continue;
        await t.run(`INSERT INTO store_accounts (store_id, company_id, api_token, api_key) VALUES (?, ?, ?, ?)
          ON CONFLICT (store_id, company_id) DO UPDATE SET
            api_token = CASE WHEN ? THEN NULL ELSE COALESCE(excluded.api_token, store_accounts.api_token) END,
            api_key = CASE WHEN ? THEN NULL ELSE COALESCE(excluded.api_key, store_accounts.api_key) END`,
        id, Number(a.company_id), token, key, Boolean(a.clear), Boolean(a.clear));
      }
      if (Array.isArray(b.routes)) {
        await t.run('DELETE FROM store_routes WHERE store_id = ?', id);
        for (const x of b.routes) {
          const code = Number(x.wilaya_code);
          if (!isValidWilaya(code) || !x.company_id) continue;
          await t.run(`INSERT INTO store_routes (store_id, wilaya_code, company_id) VALUES (?, ?, ?)
            ON CONFLICT (store_id, wilaya_code) DO UPDATE SET company_id = excluded.company_id`, id, code, Number(x.company_id));
        }
      }
      return id;
    });
  };

  r.put('/stores/new-products', requirePerm('stores'), async (c) => {
    const id = Number(body(c).store_id) || null;
    if (id && !await db.get('SELECT id FROM stores WHERE id = ?', id)) throw new HttpError(404, 'البوتيك غير موجودة');
    await setSetting(db, 'new_product_store_id', id ? String(id) : null);
    return c.json({ ok: true });
  });
  r.post('/stores', requirePerm('stores'), async (c) => c.json({ id: await saveStore(null, body(c)) }, 201));
  r.put('/stores/:id', requirePerm('stores'), async (c) => {
    const id = await saveStore(idParam(c), body(c));
    // A store that changed company takes its unsent orders along.
    for (const p of await db.all('SELECT id FROM products WHERE store_id = ?', id)) await rerouteProductOrders(db, p.id);
    return c.json({ id });
  });
  r.delete('/stores/:id', requirePerm('stores'), async (c) => {
    await db.run('DELETE FROM stores WHERE id = ?', idParam(c));
    return c.json({ ok: true });
  });

  // ---- Google Sheets order sources ----
  r.get('/sheets', requirePerm('sheets'), async (c) => c.json(await db.all(`
    SELECT g.*, s.name AS store_name FROM sheet_sources g LEFT JOIN stores s ON s.id = g.store_id ORDER BY g.id`)));

  // Reads the sheet's header row so the UI can map columns; start_row defaults to the next new row.
  r.post('/sheets/preview', requirePerm('sheets'), async (c) => {
    const rows = await fetchSheetRows(body(c).sheet_url);
    const headers = rows[0] || [];
    return c.json({ headers, rows: rows.length, next_row: rows.length + 1, mapping: suggestMapping(headers), fields: Object.keys(SHEET_FIELDS) });
  });

  const sheetInput = (b) => {
    const name = String(b.name || '').trim();
    const sheetUrl = String(b.sheet_url || '').trim();
    if (!name || !sheetUrl) throw new HttpError(400, 'الاسم والرابط ضروريين');
    const mapping = Object.fromEntries(Object.entries(b.mapping || {})
      .filter(([f, h]) => SHEET_FIELDS[f] && h).map(([f, h]) => [f, String(h)]));
    return [name, sheetUrl, b.store_id ? Number(b.store_id) : null, ['fake', 'abandoned'].includes(b.kind) ? b.kind : 'real',
      JSON.stringify(mapping), Math.max(2, Math.floor(Number(b.start_row)) || 2), b.active !== false && b.active !== 'false'];
  };
  r.post('/sheets', requirePerm('sheets'), async (c) => {
    const { rows } = await db.run(`INSERT INTO sheet_sources (name, sheet_url, store_id, kind, mapping, start_row, active)
      VALUES (?, ?, ?, ?, ?::jsonb, ?, ?) RETURNING id`, ...sheetInput(body(c)));
    return c.json({ id: rows[0].id }, 201);
  });
  // Changing the start row restarts reading from there; rows already imported are never imported twice.
  r.put('/sheets/:id', requirePerm('sheets'), async (c) => {
    const id = idParam(c);
    const old = await db.get('SELECT start_row FROM sheet_sources WHERE id = ?', id);
    if (!old) throw new HttpError(404, 'الشيت غير موجود');
    const v = sheetInput(body(c));
    await db.run(`UPDATE sheet_sources SET name = ?, sheet_url = ?, store_id = ?, kind = ?, mapping = ?::jsonb, start_row = ?, active = ?
      ${v[5] !== old.start_row ? ', last_row = 0' : ''} WHERE id = ?`, ...v, id);
    return c.json({ id });
  });
  r.delete('/sheets/:id', requirePerm('sheets'), async (c) => {
    await db.run('DELETE FROM sheet_sources WHERE id = ?', idParam(c));
    return c.json({ ok: true });
  });
  r.post('/sheets/:id/sync', requirePerm('sheets'), async (c) => {
    const source = await db.get('SELECT * FROM sheet_sources WHERE id = ?', idParam(c));
    if (!source) throw new HttpError(404, 'الشيت غير موجود');
    return c.json(await syncSheet(db, source));
  });

  // ---- direct LightFunnels connection (OAuth app + order webhooks) ----
  r.get('/lightfunnels', requirePerm('sheets'), async (c) => c.json({
    configured: lf.configured(),
    missing: lf.missingKeys(),
    redirect_uri: lf.redirectUri(new URL(c.req.url).origin),
    links: await db.all(`SELECT l.id, l.name, l.store_id, s.name AS store_name, l.webhooks, l.imported_count, l.last_event_at,
        l.last_error, l.active, (l.access_token IS NOT NULL) AS connected
      FROM lightfunnels_links l LEFT JOIN stores s ON s.id = l.store_id ORDER BY l.id`),
    events: await db.all(`SELECT e.id, e.link_id, e.topic, e.lf_order_id, e.status, e.error, e.order_id, e.created_at
      FROM lightfunnels_events e ORDER BY e.id DESC LIMIT 15`),
  }));
  r.post('/lightfunnels', requirePerm('sheets'), async (c) => {
    const b = body(c);
    const name = String(b.name || '').trim();
    if (!name) throw new HttpError(400, 'الاسم ضروري');
    const { rows } = await db.run('INSERT INTO lightfunnels_links (name, store_id) VALUES (?, ?) RETURNING id', name, b.store_id ? Number(b.store_id) : null);
    return c.json({ id: rows[0].id }, 201);
  });
  // The user comes back from LightFunnels here after accepting the app. Registered before /:id routes.
  r.get('/lightfunnels/callback', requirePerm('sheets'), async (c) => {
    const linkId = lf.readState(c.req.query('state'));
    const code = c.req.query('code');
    if (!linkId || !code) throw new HttpError(400, 'رابط الربط غير صالح أو انتهت صلاحيتو، عاود من صفحة الشيتات');
    const origin = new URL(c.req.url).origin;
    const r2 = await lf.connectLink(db, linkId, code, origin);
    return c.redirect(`/#/sheets?lf=${r2.errors.length ? 'partial' : 'ok'}`);
  });
  r.get('/lightfunnels/:id/connect', requirePerm('sheets'), async (c) => {
    if (!lf.configured()) throw new HttpError(409, 'LF_CLIENT_ID و LF_CLIENT_SECRET ما تحطوش في Netlify');
    const link = await db.get('SELECT id FROM lightfunnels_links WHERE id = ?', idParam(c));
    if (!link) throw new HttpError(404, 'الربط غير موجود');
    return c.redirect(lf.authorizeUrl(new URL(c.req.url).origin, link.id));
  });
  r.delete('/lightfunnels/:id', requirePerm('sheets'), async (c) => {
    await db.run('DELETE FROM lightfunnels_links WHERE id = ?', idParam(c));
    return c.json({ ok: true });
  });

  // ---- ad spend (Meta Ads etc.) ----
  r.get('/ad-spend', requirePerm('ads', 'accounting'), async (c) => c.json(await db.all(`
    SELECT a.*, p.name AS product_name FROM ad_spend a JOIN products p ON p.id = a.product_id
    ORDER BY a.date DESC, a.id DESC LIMIT 300`)));

  r.post('/ad-spend', requirePerm('ads'), async (c) => {
    const b = body(c);
    const date = String(b.date || '').slice(0, 10);
    const amount = Number(b.amount);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(amount >= 0)) throw new HttpError(400, 'التاريخ أو المبلغ غير صحيح');
    await db.run(`INSERT INTO ad_spend (product_id, date, amount) VALUES (?, ?, ?)
      ON CONFLICT (product_id, date) DO UPDATE SET amount = excluded.amount`,
      Number(b.product_id) || 0, date, amount);
    return c.json({ ok: true });
  });

  r.delete('/ad-spend/:id', requirePerm('ads'), async (c) => {
    await db.run('DELETE FROM ad_spend WHERE id = ?', idParam(c));
    return c.json({ ok: true });
  });

  // ---- ad campaigns (read and written by the launch routine with AUTOMATION_TOKEN) ----
  r.get('/ads/settings', requirePerm('ads'), async (c) => c.json(await getAdSettings(db)));
  r.put('/ads/settings', requirePerm('ads'), async (c) => c.json(await saveAdSettings(db, body(c))));
  r.get('/ads/plan', requirePerm('ads'), async (c) => c.json(await getAdPlan(db)));
  r.get('/ads/campaigns', requirePerm('ads'), async (c) => c.json(await listAdCampaigns(db)));
  r.post('/ads/campaigns', requirePerm('ads'), async (c) => c.json(await recordAdCampaign(db, body(c)), 201));
  r.patch('/ads/campaigns/:id', requirePerm('ads'), async (c) => c.json(await updateAdCampaign(db, idParam(c), body(c))));

  // ---- stats ----
  r.get('/stats', requirePerm('dashboard'), async (c) => {
    const { from, to } = c.req.query();
    const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
    return c.json(await getStats(db, { from: isDate(from) ? from : null, to: isDate(to) ? to : null }));
  });

  r.get('/stats/:tab{confirmation|delivery}', requirePerm('stats'), async (c) => {
    const q = c.req.query();
    const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
    const id = (v) => (Number(v) > 0 ? Number(v) : null);
    const filters = {
      from: isDate(q.from) ? q.from : null, to: isDate(q.to) ? q.to : null,
      store_id: id(q.store_id), product_id: id(q.product_id), user_id: id(q.user_id),
    };
    return c.json(c.req.param('tab') === 'confirmation' ? await getConfirmationStats(db, filters) : await getDeliveryStats(db, filters));
  });

  // ---- accounting (profit of each product) ----
  // An accountant limited to some stores sees and changes only their products.
  const accountingStores = (c) => c.get('user').accounting_store_ids || [];
  const checkAccountingProduct = async (c, productId) => {
    const stores = accountingStores(c);
    if (!stores.length) return;
    const p = await db.get('SELECT store_id FROM products WHERE id = ?', productId);
    if (!p || !stores.includes(p.store_id)) throw new HttpError(403, 'هاد المنتج ماشي من البوتيكات تاعك');
  };
  const accountingProduct = async (c, next) => {
    await checkAccountingProduct(c, idParam(c));
    return next();
  };
  r.get('/accounting', requirePerm('accounting'), async (c) => c.json(await getAccounting(db, { storeIds: accountingStores(c) })));
  r.put('/accounting/defaults', requirePerm('accounting'), async (c) => {
    // The fixed values are shared by every store.
    if (accountingStores(c).length) throw new HttpError(403, 'القيم الثابتة تاع كل البوتيكات، يبدلها غير اللي يشوف كل البوتيكات');
    return c.json(await saveDefaults(db, body(c)));
  });
  r.put('/accounting/products/:id', requirePerm('accounting'), accountingProduct, async (c) => {
    await saveProductCosts(db, idParam(c), body(c));
    return c.json({ ok: true });
  });
  r.post('/accounting/products/:id/expenses', requirePerm('accounting'), accountingProduct, async (c) => {
    await addExpense(db, idParam(c), body(c));
    return c.json({ ok: true }, 201);
  });
  r.delete('/accounting/expenses/:id', requirePerm('accounting'), async (c) => {
    const e = await db.get('SELECT product_id FROM product_expenses WHERE id = ?', idParam(c));
    if (e) await checkAccountingProduct(c, e.product_id);
    await deleteExpense(db, idParam(c));
    return c.json({ ok: true });
  });
  r.post('/accounting/products/:id/purchases', requirePerm('accounting'), accountingProduct, async (c) => {
    await addPurchase(db, idParam(c), body(c));
    return c.json({ ok: true }, 201);
  });
  r.delete('/accounting/purchases/:id', requirePerm('accounting'), async (c) => {
    const x = await db.get('SELECT product_id FROM product_purchases WHERE id = ?', idParam(c));
    if (x) await checkAccountingProduct(c, x.product_id);
    await deletePurchase(db, idParam(c));
    return c.json({ ok: true });
  });

  // ---- users ----
  r.get('/users', requireAdmin, async (c) => c.json({
    users: (await db.all('SELECT id, username, role, permissions, accounting_store_ids, created_at FROM users ORDER BY id'))
      .map((u) => ({ ...publicUser(u), created_at: u.created_at })),
    permissions: PERMISSIONS,
  }));

  r.post('/users', requireAdmin, async (c) => {
    const b = body(c);
    const username = String(b.username || '').trim();
    const password = String(b.password || '');
    const role = b.role === 'admin' ? 'admin' : 'agent';
    if (!username || password.length < 6) throw new HttpError(400, 'الاسم ضروري وكلمة السر 6 حروف على الأقل');
    const permissions = parsePermissions(Array.isArray(b.permissions) ? b.permissions.join(',') : b.permissions).join(',');
    if (role === 'agent' && !permissions) throw new HttpError(400, 'اختار على الأقل صفحة وحدة يشوفها');
    if (await db.get('SELECT id FROM users WHERE username = ?', username)) throw new HttpError(409, 'هاد الاسم كاين من قبل');
    const storeIds = parseIds(Array.isArray(b.accounting_store_ids) ? b.accounting_store_ids.join(',') : b.accounting_store_ids).join(',') || null;
    await db.run('INSERT INTO users (username, password_hash, role, permissions, accounting_store_ids) VALUES (?, ?, ?, ?, ?)',
      username, hashPassword(password), role, permissions, storeIds);
    return c.json({ ok: true }, 201);
  });

  r.put('/users/:id/password', async (c) => {
    const id = idParam(c);
    const user = c.get('user');
    if (user.role !== 'admin' && user.id !== id) throw new HttpError(403, 'ممنوع');
    const password = String(body(c).password || '');
    if (password.length < 6) throw new HttpError(400, 'كلمة السر 6 حروف على الأقل');
    const hash = hashPassword(password);
    await db.run('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?', hash, id);
    // Other sessions of that account end; this browser stays signed in when it changed its own password.
    if (user.id === id) setSession(c, { id, password_hash: hash });
    return c.json({ ok: true });
  });

  r.put('/users/:id/permissions', requireAdmin, async (c) => {
    const b = body(c);
    const id = idParam(c);
    const role = b.role === 'admin' ? 'admin' : 'agent';
    if (id === c.get('user').id && role !== 'admin') throw new HttpError(400, 'ما تقدرش تنحي المدير على روحك');
    const permissions = parsePermissions(Array.isArray(b.permissions) ? b.permissions.join(',') : b.permissions).join(',');
    if (role === 'agent' && !permissions) throw new HttpError(400, 'اختار على الأقل صفحة وحدة يشوفها');
    const storeIds = parseIds(Array.isArray(b.accounting_store_ids) ? b.accounting_store_ids.join(',') : b.accounting_store_ids).join(',') || null;
    await db.run('UPDATE users SET role = ?, permissions = ?, accounting_store_ids = ? WHERE id = ?', role, permissions, storeIds, id);
    return c.json({ ok: true });
  });

  r.delete('/users/:id', requireAdmin, async (c) => {
    if (idParam(c) === c.get('user').id) throw new HttpError(400, 'ما تقدرش تمسح روحك');
    await db.run('DELETE FROM users WHERE id = ?', idParam(c));
    return c.json({ ok: true });
  });

  return r;
}
