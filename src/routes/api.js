import crypto from 'node:crypto';
import { Router } from 'express';
import { getSetting, setSetting, tx } from '../db.js';
import { hashPassword, verifyPassword, setSession, clearSession, authMiddleware, requireAdmin } from '../auth.js';
import { WILAYAS, isValidWilaya } from '../wilayas.js';
import { PROVIDER_NAMES } from '../delivery/index.js';
import {
  STATUSES, HttpError, getOrder, createOrder, updateOrder, applyAction,
  confirmAndDispatch, dispatchOrder, syncTracking,
} from '../services/orders.js';
import { getStats } from '../services/stats.js';
import {
  getAdSettings, saveAdSettings, getAdPlan, listAdCampaigns, recordAdCampaign, updateAdCampaign,
} from '../services/ads.js';

const newKey = () => crypto.randomBytes(12).toString('base64url');

export function apiRouter(db) {
  const r = Router();

  // ---- auth ----
  r.post('/auth/login', (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(req.body.username || ''));
    if (!user || !verifyPassword(String(req.body.password || ''), user.password_hash)) {
      return res.status(401).json({ error: 'اسم المستخدم أو كلمة السر غير صحيحة' });
    }
    setSession(res, user);
    res.json({ id: user.id, username: user.username, role: user.role });
  });
  r.post('/auth/logout', (req, res) => {
    clearSession(res);
    res.json({ ok: true });
  });

  r.use(authMiddleware(db));
  r.get('/auth/me', (req, res) => res.json(req.user));

  r.get('/meta', (req, res) => res.json({ wilayas: WILAYAS, statuses: STATUSES, providers: PROVIDER_NAMES }));

  // ---- products ----
  r.get('/products', (req, res) => {
    res.json(db.prepare(`
      SELECT p.*, s.name AS store_name,
        (SELECT COUNT(*) FROM orders o WHERE o.product_id = p.id) AS orders_count,
        (SELECT COUNT(*) FROM orders o WHERE o.product_id = p.id AND o.status IN ('new','no_answer','postponed')) AS pending_count
      FROM products p LEFT JOIN stores s ON s.id = p.store_id
      ORDER BY p.active DESC, p.id DESC`).all());
  });

  const productFields = (b) => ({
    name: String(b.name || '').trim(),
    sku: b.sku ? String(b.sku).trim() : null,
    price: Number(b.price) || 0,
    cost: Number(b.cost) || 0,
    landing_url: b.landing_url ? String(b.landing_url).trim() : null,
    store_id: b.store_id ? Number(b.store_id) : null,
    active: b.active === false || b.active === 0 ? 0 : 1,
    ad_daily_budget: Number(b.ad_daily_budget) > 0 ? Number(b.ad_daily_budget) : null,
    ad_creative_folder: b.ad_creative_folder ? String(b.ad_creative_folder).trim() : null,
  });

  r.post('/products', requireAdmin, (req, res) => {
    const f = productFields(req.body);
    if (!f.name) throw new HttpError(400, 'اسم المنتج ضروري');
    const stock = Math.floor(Number(req.body.stock) || 0);
    const id = tx(db, () => {
      const { lastInsertRowid } = db.prepare(`
        INSERT INTO products (name, sku, price, cost, stock, landing_url, store_id, active, ad_daily_budget, ad_creative_folder, public_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(f.name, f.sku, f.price, f.cost, stock, f.landing_url, f.store_id, f.active, f.ad_daily_budget, f.ad_creative_folder, newKey());
      if (stock) {
        db.prepare(`INSERT INTO stock_movements (product_id, quantity, reason) VALUES (?, ?, 'مخزون أولي')`)
          .run(lastInsertRowid, stock);
      }
      return lastInsertRowid;
    });
    res.status(201).json(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
  });

  r.put('/products/:id', requireAdmin, (req, res) => {
    const f = productFields(req.body);
    if (!f.name) throw new HttpError(400, 'اسم المنتج ضروري');
    const { changes } = db.prepare(`
      UPDATE products SET name = ?, sku = ?, price = ?, cost = ?, landing_url = ?, store_id = ?, active = ? WHERE id = ?`)
      .run(f.name, f.sku, f.price, f.cost, f.landing_url, f.store_id, f.active, req.params.id);
    if (!changes) throw new HttpError(404, 'المنتج غير موجود');
    // Only touch the ad fields the caller sends, so older forms do not wipe them.
    for (const key of ['ad_daily_budget', 'ad_creative_folder']) {
      if (req.body[key] !== undefined) db.prepare(`UPDATE products SET ${key} = ? WHERE id = ?`).run(f[key], req.params.id);
    }
    res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id));
  });

  r.post('/products/:id/regenerate-key', requireAdmin, (req, res) => {
    db.prepare('UPDATE products SET public_key = ? WHERE id = ?').run(newKey(), req.params.id);
    res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id));
  });

  // Stock in (new purchase) or correction. quantity may be negative.
  r.post('/products/:id/stock', requireAdmin, (req, res) => {
    const qty = Math.floor(Number(req.body.quantity));
    if (!qty) throw new HttpError(400, 'الكمية ضرورية');
    const reason = String(req.body.reason || (qty > 0 ? 'دخول سلعة' : 'تصحيح'));
    tx(db, () => {
      const { changes } = db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(qty, req.params.id);
      if (!changes) throw new HttpError(404, 'المنتج غير موجود');
      db.prepare('INSERT INTO stock_movements (product_id, quantity, reason) VALUES (?, ?, ?)').run(req.params.id, qty, reason);
    });
    res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id));
  });

  r.get('/products/:id/stock-movements', (req, res) => {
    res.json(db.prepare(`
      SELECT m.*, o.reference FROM stock_movements m LEFT JOIN orders o ON o.id = m.order_id
      WHERE m.product_id = ? ORDER BY m.id DESC LIMIT 200`).all(req.params.id));
  });

  // ---- orders ----
  r.get('/orders', (req, res) => {
    const where = [];
    const args = [];
    if (req.query.status) {
      const list = String(req.query.status).split(',').filter((s) => STATUSES.includes(s));
      if (list.length) where.push(`o.status IN (${list.map(() => '?').join(',')})`), args.push(...list);
    }
    if (req.query.product_id) where.push('o.product_id = ?'), args.push(Number(req.query.product_id));
    if (req.query.store_id) where.push('p.store_id = ?'), args.push(Number(req.query.store_id));
    if (req.query.wilaya) where.push('o.wilaya_code = ?'), args.push(Number(req.query.wilaya));
    if (req.query.company_id) where.push('o.company_id = ?'), args.push(Number(req.query.company_id));
    if (req.query.from) where.push('date(o.created_at) >= date(?)'), args.push(req.query.from);
    if (req.query.to) where.push('date(o.created_at) <= date(?)'), args.push(req.query.to);
    if (req.query.dispatch_error === '1') where.push('o.dispatch_error IS NOT NULL');
    if (req.query.q) {
      const q = `%${String(req.query.q).trim()}%`;
      where.push('(o.customer_name LIKE ? OR o.phone LIKE ? OR o.reference LIKE ? OR o.tracking LIKE ?)');
      args.push(q, q, q, q);
    }
    const limit = Math.min(500, Number(req.query.limit) || 100);
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db.prepare(`
      SELECT o.*, p.name AS product_name, s.name AS store_name, c.name AS company_name
      FROM orders o JOIN products p ON p.id = o.product_id
      LEFT JOIN stores s ON s.id = p.store_id
      LEFT JOIN delivery_companies c ON c.id = o.company_id
      ${whereSql} ORDER BY o.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM orders o JOIN products p ON p.id = o.product_id ${whereSql}`).get(...args);
    res.json({ rows, total });
  });

  r.get('/orders/:id', (req, res) => {
    const order = getOrder(db, Number(req.params.id));
    const events = db.prepare(`
      SELECT e.*, u.username FROM order_events e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.order_id = ? ORDER BY e.id DESC`).all(order.id);
    res.json({ ...order, events });
  });

  r.post('/orders', (req, res) => {
    res.status(201).json(createOrder(db, req.body, { source: 'manual', userId: req.user.id }));
  });

  r.put('/orders/:id', (req, res) => {
    res.json(updateOrder(db, Number(req.params.id), req.body, req.user.id));
  });

  r.post('/orders/:id/action', async (req, res) => {
    const id = Number(req.params.id);
    const opts = { userId: req.user.id, note: req.body.note || null };
    const order = req.body.action === 'confirm'
      ? await confirmAndDispatch(db, id, opts)
      : applyAction(db, id, String(req.body.action), opts);
    res.json(order);
  });

  // Retry a failed dispatch, or record a tracking number by hand.
  r.post('/orders/:id/dispatch', async (req, res) => {
    res.json(await dispatchOrder(db, Number(req.params.id), {
      userId: req.user.id,
      tracking: req.body.tracking ? String(req.body.tracking).trim() : null,
    }));
  });

  r.post('/orders/sync-tracking', async (req, res) => {
    res.json(await syncTracking(db));
  });

  // ---- delivery companies & routing ----
  r.get('/delivery/companies', (req, res) => {
    const rows = db.prepare('SELECT * FROM delivery_companies ORDER BY id').all();
    res.json(rows.map((c) => ({ ...c, api_token: c.api_token ? '••••' + c.api_token.slice(-4) : null })));
  });

  const companyFields = (b) => {
    const provider = String(b.provider || '');
    if (!PROVIDER_NAMES.includes(provider)) throw new HttpError(400, 'نوع غير معروف');
    const name = String(b.name || '').trim();
    if (!name) throw new HttpError(400, 'الاسم ضروري');
    return { name, provider, base_url: b.base_url ? String(b.base_url).trim() : null, active: b.active === false ? 0 : 1 };
  };

  r.post('/delivery/companies', requireAdmin, (req, res) => {
    const f = companyFields(req.body);
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO delivery_companies (name, provider, base_url, api_token, active) VALUES (?, ?, ?, ?, ?)`)
      .run(f.name, f.provider, f.base_url, req.body.api_token || null, f.active);
    if (!getSetting(db, 'default_company_id')) setSetting(db, 'default_company_id', lastInsertRowid);
    res.status(201).json({ id: Number(lastInsertRowid) });
  });

  r.put('/delivery/companies/:id', requireAdmin, (req, res) => {
    const f = companyFields(req.body);
    // An empty token field means "keep the current one".
    const token = req.body.api_token ? String(req.body.api_token) : undefined;
    db.prepare(`UPDATE delivery_companies SET name = ?, provider = ?, base_url = ?, active = ?
      ${token !== undefined ? ', api_token = ?' : ''} WHERE id = ?`)
      .run(...[f.name, f.provider, f.base_url, f.active, ...(token !== undefined ? [token] : []), req.params.id]);
    res.json({ ok: true });
  });

  r.get('/delivery/routes', (req, res) => {
    const routes = db.prepare('SELECT * FROM delivery_routes').all();
    const byCode = Object.fromEntries(routes.map((x) => [x.wilaya_code, x]));
    res.json({
      default_company_id: Number(getSetting(db, 'default_company_id')) || null,
      auto_dispatch: getSetting(db, 'auto_dispatch') !== '0',
      routes: WILAYAS.map((w) => ({
        ...w,
        company_id: byCode[w.code]?.company_id ?? null,
        home_fee: byCode[w.code]?.home_fee ?? 0,
        desk_fee: byCode[w.code]?.desk_fee ?? 0,
      })),
    });
  });

  r.put('/delivery/routes', requireAdmin, (req, res) => {
    const { routes = [], default_company_id, auto_dispatch } = req.body;
    tx(db, () => {
      const upsert = db.prepare(`
        INSERT INTO delivery_routes (wilaya_code, company_id, home_fee, desk_fee) VALUES (?, ?, ?, ?)
        ON CONFLICT(wilaya_code) DO UPDATE SET company_id = excluded.company_id,
          home_fee = excluded.home_fee, desk_fee = excluded.desk_fee`);
      for (const x of routes) {
        const code = Number(x.wilaya_code ?? x.code);
        if (!isValidWilaya(code)) continue;
        upsert.run(code, x.company_id ? Number(x.company_id) : null, Number(x.home_fee) || 0, Number(x.desk_fee) || 0);
      }
      if (default_company_id !== undefined) setSetting(db, 'default_company_id', default_company_id || null);
      if (auto_dispatch !== undefined) setSetting(db, 'auto_dispatch', auto_dispatch ? '1' : '0');
    });
    res.json({ ok: true });
  });

  // ---- stores (boutiques) ----
  r.get('/stores', (req, res) => {
    const stores = db.prepare(`
      SELECT s.*, c.name AS company_name,
        (SELECT COUNT(*) FROM products p WHERE p.store_id = s.id) AS products_count
      FROM stores s LEFT JOIN delivery_companies c ON c.id = s.company_id ORDER BY s.name`).all();
    const routes = db.prepare(`
      SELECT r.*, c.name AS company_name FROM store_routes r JOIN delivery_companies c ON c.id = r.company_id
      ORDER BY r.wilaya_code`).all();
    res.json(stores.map((s) => ({ ...s, routes: routes.filter((r) => r.store_id === s.id) })));
  });

  const saveStore = (id, b) => {
    const name = String(b.name || '').trim();
    if (!name) throw new HttpError(400, 'اسم البوتيك ضروري');
    const companyId = b.company_id ? Number(b.company_id) : null;
    return tx(db, () => {
      try {
        if (id) db.prepare('UPDATE stores SET name = ?, company_id = ? WHERE id = ?').run(name, companyId, id);
        else id = Number(db.prepare('INSERT INTO stores (name, company_id) VALUES (?, ?)').run(name, companyId).lastInsertRowid);
      } catch {
        throw new HttpError(409, 'هاد الاسم مستعمل');
      }
      if (b.ad_account_id !== undefined) {
        const account = String(b.ad_account_id || '').replace(/^act_/, '').trim() || null;
        db.prepare('UPDATE stores SET ad_account_id = ? WHERE id = ?').run(account, id);
      }
      if (Array.isArray(b.routes)) {
        db.prepare('DELETE FROM store_routes WHERE store_id = ?').run(id);
        const insert = db.prepare('INSERT OR REPLACE INTO store_routes (store_id, wilaya_code, company_id) VALUES (?, ?, ?)');
        for (const x of b.routes) {
          const code = Number(x.wilaya_code);
          if (isValidWilaya(code) && x.company_id) insert.run(id, code, Number(x.company_id));
        }
      }
      return id;
    });
  };

  r.post('/stores', requireAdmin, (req, res) => res.status(201).json({ id: saveStore(null, req.body) }));
  r.put('/stores/:id', requireAdmin, (req, res) => res.json({ id: saveStore(Number(req.params.id), req.body) }));
  r.delete('/stores/:id', requireAdmin, (req, res) => {
    db.prepare('DELETE FROM stores WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // ---- ad spend (Meta Ads etc.) ----
  r.get('/ad-spend', (req, res) => {
    res.json(db.prepare(`
      SELECT a.*, p.name AS product_name FROM ad_spend a JOIN products p ON p.id = a.product_id
      ORDER BY a.date DESC, a.id DESC LIMIT 300`).all());
  });

  r.post('/ad-spend', requireAdmin, (req, res) => {
    const date = String(req.body.date || '').slice(0, 10);
    const amount = Number(req.body.amount);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(amount >= 0)) throw new HttpError(400, 'التاريخ أو المبلغ غير صحيح');
    db.prepare(`INSERT INTO ad_spend (product_id, date, amount) VALUES (?, ?, ?)
      ON CONFLICT(product_id, date) DO UPDATE SET amount = excluded.amount`)
      .run(Number(req.body.product_id), date, amount);
    res.json({ ok: true });
  });

  r.delete('/ad-spend/:id', requireAdmin, (req, res) => {
    db.prepare('DELETE FROM ad_spend WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // ---- ad campaigns (read and written by the launch routine with AUTOMATION_TOKEN) ----
  r.get('/ads/settings', (req, res) => res.json(getAdSettings(db)));
  r.put('/ads/settings', requireAdmin, (req, res) => res.json(saveAdSettings(db, req.body)));
  r.get('/ads/plan', (req, res) => res.json(getAdPlan(db)));
  r.get('/ads/campaigns', (req, res) => res.json(listAdCampaigns(db)));
  r.post('/ads/campaigns', requireAdmin, (req, res) => res.status(201).json(recordAdCampaign(db, req.body)));
  r.patch('/ads/campaigns/:id', requireAdmin, (req, res) => res.json(updateAdCampaign(db, Number(req.params.id), req.body)));

  // ---- stats ----
  r.get('/stats', (req, res) => {
    res.json(getStats(db, { from: req.query.from || null, to: req.query.to || null }));
  });

  // ---- users ----
  r.get('/users', requireAdmin, (req, res) => {
    res.json(db.prepare('SELECT id, username, role, created_at FROM users ORDER BY id').all());
  });

  r.post('/users', requireAdmin, (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const role = req.body.role === 'admin' ? 'admin' : 'agent';
    if (!username || password.length < 6) throw new HttpError(400, 'الاسم ضروري وكلمة السر 6 حروف على الأقل');
    try {
      db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(username, hashPassword(password), role);
    } catch {
      throw new HttpError(409, 'هذا الاسم مستعمل');
    }
    res.status(201).json({ ok: true });
  });

  r.put('/users/:id/password', (req, res) => {
    const id = Number(req.params.id);
    if (req.user.role !== 'admin' && req.user.id !== id) throw new HttpError(403, 'ممنوع');
    const password = String(req.body.password || '');
    if (password.length < 6) throw new HttpError(400, 'كلمة السر 6 حروف على الأقل');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), id);
    res.json({ ok: true });
  });

  r.delete('/users/:id', requireAdmin, (req, res) => {
    if (Number(req.params.id) === req.user.id) throw new HttpError(400, 'ما تقدرش تمسح روحك');
    db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  return r;
}
