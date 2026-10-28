import crypto from 'node:crypto';
import { Hono } from 'hono';
import { getSetting, setSetting } from '../db.js';
import { hashPassword, verifyPassword, setSession, clearSession, authMiddleware, requireAdmin } from '../auth.js';
import { WILAYAS, isValidWilaya } from '../wilayas.js';
import { PROVIDER_NAMES } from '../delivery/index.js';
import {
  STATUSES, HttpError, getOrder, createOrder, updateOrder, applyAction,
  confirmAndDispatch, dispatchOrder, syncTracking, rerouteProductOrders, deleteOrder,
} from '../services/orders.js';
import { getStats, localDay } from '../services/stats.js';
import {
  getAdSettings, saveAdSettings, getAdPlan, listAdCampaigns, recordAdCampaign, updateAdCampaign,
} from '../services/ads.js';
import { scanStore, applyStoreLinks, normalizeName } from '../services/branches.js';
import { SHEET_FIELDS, fetchSheetRows, suggestMapping, syncSheet } from '../services/sheets.js';

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
  r.post('/auth/login', async (c) => {
    const b = body(c);
    const user = await db.get('SELECT * FROM users WHERE username = ?', String(b.username || ''));
    if (!user || !verifyPassword(String(b.password || ''), user.password_hash)) {
      return c.json({ error: 'اسم المستخدم أو كلمة السر غير صحيحة' }, 401);
    }
    setSession(c, user);
    return c.json({ id: user.id, username: user.username, role: user.role });
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

  r.post('/products', requireAdmin, async (c) => {
    const f = productFields(body(c));
    if (!f.name) throw new HttpError(400, 'اسم المنتج ضروري');
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

  r.put('/products/:id', requireAdmin, async (c) => {
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
  r.put('/products/:id/store', requireAdmin, async (c) => {
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
    return c.json({ orders: await rerouteProductOrders(db, id) });
  });

  // Link products to stores from the parcels each store already shipped.
  r.post('/branches/scan', requireAdmin, async (c) => {
    const b = body(c);
    return c.json(await scanStore(db, Number(b.store_id), Math.max(1, Number(b.page) || 1)));
  });
  r.post('/branches/apply', requireAdmin, async (c) => c.json(await applyStoreLinks(db, body(c).texts)));

  r.post('/products/:id/regenerate-key', requireAdmin, async (c) => {
    const { rows: [p] } = await db.run('UPDATE products SET public_key = ? WHERE id = ? RETURNING *', newKey(), idParam(c));
    if (!p) throw new HttpError(404, 'المنتج غير موجود');
    return c.json(p);
  });

  // Stock in (new purchase) or correction. quantity may be negative.
  r.post('/products/:id/stock', requireAdmin, async (c) => {
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
  r.get('/orders', async (c) => {
    const q = c.req.query();
    const where = [];
    const args = [];
    if (q.status) {
      const list = String(q.status).split(',').filter((s) => STATUSES.includes(s));
      if (list.length) where.push(`o.status IN (${list.map(() => '?').join(',')})`), args.push(...list);
    }
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
          WHERE e.order_id = o.id AND e.type = 'confirmed' ORDER BY e.id DESC LIMIT 1) AS confirmed_by
      FROM orders o JOIN products p ON p.id = o.product_id
      LEFT JOIN stores s ON s.id = p.store_id
      LEFT JOIN delivery_companies c ON c.id = o.company_id
      ${whereSql} ORDER BY o.id DESC LIMIT ? OFFSET ?`, ...args, limit, offset);
    const { total } = await db.get(`SELECT COUNT(*) AS total FROM orders o JOIN products p ON p.id = o.product_id ${whereSql}`, ...args);
    return c.json({ rows, total });
  });

  r.get('/orders/:id', async (c) => {
    const order = await getOrder(db, idParam(c));
    const events = await db.all(`
      SELECT e.*, u.username FROM order_events e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.order_id = ? ORDER BY e.id DESC`, order.id);
    return c.json({ ...order, events });
  });

  r.post('/orders', async (c) => c.json(await createOrder(db, body(c), { source: 'manual', userId: c.get('user').id }), 201));

  r.delete('/orders/:id', requireAdmin, async (c) => c.json(await deleteOrder(db, idParam(c))));

  r.put('/orders/:id', async (c) => c.json(await updateOrder(db, idParam(c), body(c), c.get('user').id)));

  r.post('/orders/:id/action', async (c) => {
    const id = idParam(c);
    const b = body(c);
    const opts = { userId: c.get('user').id, note: b.note || null };
    return c.json(b.action === 'confirm'
      ? await confirmAndDispatch(db, id, opts)
      : await applyAction(db, id, String(b.action), opts));
  });

  // Retry a failed dispatch, or record a tracking number by hand.
  r.post('/orders/:id/dispatch', async (c) => c.json(await dispatchOrder(db, idParam(c), {
    userId: c.get('user').id,
    tracking: body(c).tracking ? String(body(c).tracking).trim() : null,
  })));

  r.post('/orders/sync-tracking', async (c) => c.json(await syncTracking(db)));

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

  r.post('/delivery/companies', requireAdmin, async (c) => {
    const f = companyFields(body(c));
    const { rows: [{ id }] } = await db.run(`
      INSERT INTO delivery_companies (name, provider, base_url, api_token, active) VALUES (?, ?, ?, ?, ?) RETURNING id`,
      f.name, f.provider, f.base_url, body(c).api_token || null, f.active);
    if (!await getSetting(db, 'default_company_id')) await setSetting(db, 'default_company_id', id);
    return c.json({ id }, 201);
  });

  r.put('/delivery/companies/:id', requireAdmin, async (c) => {
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

  r.put('/delivery/routes', requireAdmin, async (c) => {
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
    return c.json(stores.map((s) => ({
      ...s,
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

  r.post('/stores', requireAdmin, async (c) => c.json({ id: await saveStore(null, body(c)) }, 201));
  r.put('/stores/:id', requireAdmin, async (c) => c.json({ id: await saveStore(idParam(c), body(c)) }));
  r.delete('/stores/:id', requireAdmin, async (c) => {
    await db.run('DELETE FROM stores WHERE id = ?', idParam(c));
    return c.json({ ok: true });
  });

  // ---- Google Sheets order sources ----
  r.get('/sheets', requireAdmin, async (c) => c.json(await db.all(`
    SELECT g.*, s.name AS store_name FROM sheet_sources g LEFT JOIN stores s ON s.id = g.store_id ORDER BY g.id`)));

  // Reads the sheet's header row so the UI can map columns; start_row defaults to the next new row.
  r.post('/sheets/preview', requireAdmin, async (c) => {
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
  r.post('/sheets', requireAdmin, async (c) => {
    const { rows } = await db.run(`INSERT INTO sheet_sources (name, sheet_url, store_id, kind, mapping, start_row, active)
      VALUES (?, ?, ?, ?, ?::jsonb, ?, ?) RETURNING id`, ...sheetInput(body(c)));
    return c.json({ id: rows[0].id }, 201);
  });
  // Changing the start row restarts reading from there; rows already imported are never imported twice.
  r.put('/sheets/:id', requireAdmin, async (c) => {
    const id = idParam(c);
    const old = await db.get('SELECT start_row FROM sheet_sources WHERE id = ?', id);
    if (!old) throw new HttpError(404, 'الشيت غير موجود');
    const v = sheetInput(body(c));
    await db.run(`UPDATE sheet_sources SET name = ?, sheet_url = ?, store_id = ?, kind = ?, mapping = ?::jsonb, start_row = ?, active = ?
      ${v[5] !== old.start_row ? ', last_row = 0' : ''} WHERE id = ?`, ...v, id);
    return c.json({ id });
  });
  r.delete('/sheets/:id', requireAdmin, async (c) => {
    await db.run('DELETE FROM sheet_sources WHERE id = ?', idParam(c));
    return c.json({ ok: true });
  });
  r.post('/sheets/:id/sync', requireAdmin, async (c) => {
    const source = await db.get('SELECT * FROM sheet_sources WHERE id = ?', idParam(c));
    if (!source) throw new HttpError(404, 'الشيت غير موجود');
    return c.json(await syncSheet(db, source));
  });

  // ---- ad spend (Meta Ads etc.) ----
  r.get('/ad-spend', async (c) => c.json(await db.all(`
    SELECT a.*, p.name AS product_name FROM ad_spend a JOIN products p ON p.id = a.product_id
    ORDER BY a.date DESC, a.id DESC LIMIT 300`)));

  r.post('/ad-spend', requireAdmin, async (c) => {
    const b = body(c);
    const date = String(b.date || '').slice(0, 10);
    const amount = Number(b.amount);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(amount >= 0)) throw new HttpError(400, 'التاريخ أو المبلغ غير صحيح');
    await db.run(`INSERT INTO ad_spend (product_id, date, amount) VALUES (?, ?, ?)
      ON CONFLICT (product_id, date) DO UPDATE SET amount = excluded.amount`,
      Number(b.product_id) || 0, date, amount);
    return c.json({ ok: true });
  });

  r.delete('/ad-spend/:id', requireAdmin, async (c) => {
    await db.run('DELETE FROM ad_spend WHERE id = ?', idParam(c));
    return c.json({ ok: true });
  });

  // ---- ad campaigns (read and written by the launch routine with AUTOMATION_TOKEN) ----
  r.get('/ads/settings', async (c) => c.json(await getAdSettings(db)));
  r.put('/ads/settings', requireAdmin, async (c) => c.json(await saveAdSettings(db, body(c))));
  r.get('/ads/plan', async (c) => c.json(await getAdPlan(db)));
  r.get('/ads/campaigns', async (c) => c.json(await listAdCampaigns(db)));
  r.post('/ads/campaigns', requireAdmin, async (c) => c.json(await recordAdCampaign(db, body(c)), 201));
  r.patch('/ads/campaigns/:id', requireAdmin, async (c) => c.json(await updateAdCampaign(db, idParam(c), body(c))));

  // ---- stats ----
  r.get('/stats', async (c) => {
    const { from, to } = c.req.query();
    const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
    return c.json(await getStats(db, { from: isDate(from) ? from : null, to: isDate(to) ? to : null }));
  });

  // ---- users ----
  r.get('/users', requireAdmin, async (c) => c.json(await db.all('SELECT id, username, role, created_at FROM users ORDER BY id')));

  r.post('/users', requireAdmin, async (c) => {
    const b = body(c);
    const username = String(b.username || '').trim();
    const password = String(b.password || '');
    const role = b.role === 'admin' ? 'admin' : 'agent';
    if (!username || password.length < 6) throw new HttpError(400, 'الاسم ضروري وكلمة السر 6 حروف على الأقل');
    await db.run('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', username, hashPassword(password), role);
    return c.json({ ok: true }, 201);
  });

  r.put('/users/:id/password', async (c) => {
    const id = idParam(c);
    const user = c.get('user');
    if (user.role !== 'admin' && user.id !== id) throw new HttpError(403, 'ممنوع');
    const password = String(body(c).password || '');
    if (password.length < 6) throw new HttpError(400, 'كلمة السر 6 حروف على الأقل');
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), id);
    return c.json({ ok: true });
  });

  r.delete('/users/:id', requireAdmin, async (c) => {
    if (idParam(c) === c.get('user').id) throw new HttpError(400, 'ما تقدرش تمسح روحك');
    await db.run('DELETE FROM users WHERE id = ?', idParam(c));
    return c.json({ ok: true });
  });

  return r;
}
