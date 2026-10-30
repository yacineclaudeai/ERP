import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { WILAYAS } from '../wilayas.js';
import { createOrder, HttpError } from '../services/orders.js';
import { readBody } from './api.js';
import * as lf from '../services/lightfunnels.js';

// Endpoints called from the product landing pages (any domain), so CORS is open.
export function publicRouter(db) {
  const r = new Hono();
  const hits = new Map();

  r.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type'] }));

  // Basic flood protection: 20 orders per IP per 10 minutes. Best effort: each
  // serverless instance keeps its own counter.
  const limit = async (c, next) => {
    const ip = c.env?.ip || c.req.header('x-nf-client-connection-ip') || c.req.header('x-forwarded-for') || 'unknown';
    const now = Date.now();
    const list = (hits.get(ip) || []).filter((t) => now - t < 600_000);
    if (list.length >= 20) return c.json({ error: 'طلبات كثيرة، حاول لاحقاً' }, 429);
    list.push(now);
    hits.set(ip, list);
    return next();
  };

  r.get('/products/:key', async (c) => {
    const p = await db.get('SELECT name, price, active FROM products WHERE public_key = ?', c.req.param('key'));
    if (!p || !p.active) throw new HttpError(404, 'المنتج غير موجود');
    const fees = Object.fromEntries((await db.all('SELECT * FROM delivery_routes')).map((x) => [x.wilaya_code, x]));
    const wilayas = WILAYAS.map((w) => ({ ...w, home_fee: fees[w.code]?.home_fee ?? 0, desk_fee: fees[w.code]?.desk_fee ?? 0 }));
    return c.json({ name: p.name, price: p.price, wilayas });
  });

  r.post('/orders', limit, async (c) => {
    const b = await readBody(c);
    // Honeypot field: real visitors never fill it.
    if (b.website) return c.json({ ok: true }, 201);
    const order = await createOrder(db, {
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
      landing_url: b.landing_url || c.req.header('referer') || null,
      utm_source: b.utm_source,
      utm_campaign: b.utm_campaign,
    }, { source: 'landing' });
    return c.json({ ok: true, reference: order.reference, total: order.total }, 201);
  });

  // LightFunnels sends the orders here (webhooks registered when the app is connected).
  // The body is signed with the app secret; a bad signature gets 403 and unexpected errors 500 (LightFunnels retries).
  r.post('/lightfunnels/:linkId/:topic', async (c) => {
    const topic = c.req.param('topic');
    if (!['created', 'confirmed', 'checkout'].includes(topic)) return c.json({ error: 'Not found' }, 404);
    const raw = await c.req.text();
    if (!lf.validSignature(raw, c.req.header('lightfunnels-hmac'))) return c.json({ error: 'bad signature' }, 403);
    const link = await db.get('SELECT * FROM lightfunnels_links WHERE id = ?', Number(c.req.param('linkId')) || 0);
    if (!link || !link.active) return c.json({ error: 'Not found' }, 404);
    let node = null;
    try {
      const payload = JSON.parse(raw);
      node = payload.node ?? payload;
      const result = topic === 'checkout' ? await lf.handleCheckoutEvent(db, link, node) : await lf.handleOrderEvent(db, link, topic, node);
      if (result.ignored && topic === 'checkout') console.log('lightfunnels checkout ignored:', result.ignored, JSON.stringify(result.node ?? node).slice(0, 1500));
      await lf.recordEvent(db, link, topic, result.node ?? node, result.ignored ? 'ignored' : result.duplicate ? 'duplicate' : 'imported', typeof result.ignored === 'string' ? result.ignored : null, result.order_id);
      return c.json({ ok: true });
    } catch (e) {
      if (!(e instanceof HttpError) && !(e instanceof SyntaxError)) throw e;
      // An order we can't read is kept with the reason; answering 200 stops LightFunnels from retrying it.
      if (topic === 'checkout') console.log('lightfunnels checkout error:', e.message, JSON.stringify(node).slice(0, 1500));
      await lf.recordEvent(db, link, topic, node, 'error', e.message);
      return c.json({ ok: false, error: e.message });
    }
  });

  return r;
}
