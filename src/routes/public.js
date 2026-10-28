import { Router } from 'express';
import { WILAYAS } from '../wilayas.js';
import { createOrder, resolveRoute } from '../services/orders.js';

// Endpoints called from the product landing pages (any domain), so CORS is open.
export function publicRouter(db) {
  const r = Router();
  const hits = new Map();

  r.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Basic flood protection: 20 orders per IP per 10 minutes.
  const limit = (req, res, next) => {
    const now = Date.now();
    const list = (hits.get(req.ip) || []).filter((t) => now - t < 600_000);
    if (list.length >= 20) return res.status(429).json({ error: 'طلبات كثيرة، حاول لاحقاً' });
    list.push(now);
    hits.set(req.ip, list);
    next();
  };

  r.get('/products/:key', (req, res) => {
    const p = db.prepare('SELECT name, price, active FROM products WHERE public_key = ?').get(req.params.key);
    if (!p || !p.active) return res.status(404).json({ error: 'المنتج غير موجود' });
    const wilayas = WILAYAS.map((w) => {
      const route = resolveRoute(db, w.code);
      return { ...w, home_fee: route.home_fee, desk_fee: route.desk_fee };
    });
    res.json({ name: p.name, price: p.price, wilayas });
  });

  r.post('/orders', limit, (req, res) => {
    const b = req.body || {};
    // Honeypot field: real visitors never fill it.
    if (b.website) return res.status(201).json({ ok: true });
    const order = createOrder(db, {
      key: b.key,
      customer_name: b.name ?? b.customer_name,
      phone: b.phone,
      phone2: b.phone2,
      wilaya_code: b.wilaya ?? b.wilaya_code,
      commune: b.commune,
      address: b.address,
      quantity: b.quantity,
      stop_desk: b.stop_desk === true || b.stop_desk === '1' || b.stop_desk === 1,
      notes: b.notes,
      landing_url: b.landing_url || req.get('referer') || null,
      utm_source: b.utm_source,
      utm_campaign: b.utm_campaign,
    }, { source: 'landing' });
    res.status(201).json({ ok: true, reference: order.reference, total: order.total });
  });

  return r;
}
