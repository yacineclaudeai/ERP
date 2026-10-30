// Direct connection to LightFunnels: the ERP is an app installed on the LightFunnels account.
// The user accepts the app once (OAuth), then LightFunnels sends each new order by webhook.
import crypto from 'node:crypto';
import { HttpError, createOrder, updateOrder } from './orders.js';
import { parseWilaya, productFor, sheetPhone } from './sheets.js';

const AUTHORIZE_URL = 'https://app.lightfunnels.com/admin/oauth';
const TOKEN_URL = 'https://api.lightfunnels.com/api/v3/access_token';
const GRAPHQL_URL = 'https://services.lightfunnels.com/api/v2';
const SCOPES = 'orders,products,stores';
const TOPICS = { created: 'order/created', confirmed: 'order/confirmed' };

const secret = () => process.env.SESSION_SECRET || 'dev-secret-change-me';
export const configured = () => Boolean(process.env.LF_CLIENT_ID && process.env.LF_CLIENT_SECRET);
export const redirectUri = (origin) => `${origin}/api/lightfunnels/callback`;

// The state travels to LightFunnels and back: it says which link is being connected, and it is signed.
export function signState(linkId) {
  const body = Buffer.from(JSON.stringify({ link: linkId, exp: Date.now() + 15 * 60_000 })).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', secret()).update(`lf:${body}`).digest('base64url')}`;
}

export function readState(state) {
  const [body, mac] = String(state || '').split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', secret()).update(`lf:${body}`).digest('base64url');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p.link : null;
  } catch {
    return null;
  }
}

export function authorizeUrl(origin, linkId) {
  const q = new URLSearchParams({ client_id: process.env.LF_CLIENT_ID, redirect_uri: redirectUri(origin), scope: SCOPES, state: signState(linkId) });
  return `${AUTHORIZE_URL}?${q}`.replace(/%2C/g, ',');
}

async function tokenRequest(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.LF_CLIENT_ID, client_secret: process.env.LF_CLIENT_SECRET, ...params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new HttpError(502, `LightFunnels رفض الربط (${res.status})`);
  return data;
}

async function saveTokens(db, linkId, t) {
  await db.run(`UPDATE lightfunnels_links SET access_token = ?, refresh_token = COALESCE(?, refresh_token),
    expires_at = now() + (? || ' seconds')::interval, last_error = NULL WHERE id = ?`,
  t.access_token, t.refresh_token ?? null, String(Math.max(60, Number(t.expires_in) || 7200)), linkId);
}

// A valid access token; they last 2 hours and each refresh gives a new refresh token.
async function accessToken(db, link) {
  const fresh = await db.get('SELECT * FROM lightfunnels_links WHERE id = ?', link.id);
  if (fresh.access_token && fresh.expires_at && new Date(fresh.expires_at).getTime() - Date.now() > 120_000) return fresh.access_token;
  if (!fresh.refresh_token) throw new HttpError(409, 'لازم تعاود تربط LightFunnels');
  const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: fresh.refresh_token });
  await saveTokens(db, link.id, t);
  return t.access_token;
}

async function graphql(db, link, query, variables) {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await accessToken(db, link)}` },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.errors?.length) throw new HttpError(502, `LightFunnels: ${data.errors?.[0]?.message || res.status}`);
  return data.data;
}

// After the user accepts: keep the tokens and ask LightFunnels to send the orders here.
export async function connectLink(db, linkId, code, origin) {
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(origin) });
  await saveTokens(db, linkId, t);
  const link = await db.get('SELECT * FROM lightfunnels_links WHERE id = ?', linkId);
  const done = [];
  const errors = [];
  for (const [path, type] of Object.entries(TOPICS)) {
    try {
      await graphql(db, link, `mutation($node: WebhookInput!) { createWebhook(node: $node) { type url } }`,
        { node: { type, url: `${origin}/api/public/lightfunnels/${link.id}/${path}`, settings: {} } });
      done.push(type);
    } catch (e) {
      errors.push(`${type}: ${e.message}`);
    }
  }
  await db.run('UPDATE lightfunnels_links SET webhooks = ?, last_error = ? WHERE id = ?', done.join(','), errors.join('\n') || null, linkId);
  return { webhooks: done, errors };
}

// LightFunnels signs the raw body with the app secret (HMAC-SHA256, base64) in the lightfunnels-hmac header.
export function validSignature(rawBody, header) {
  if (!process.env.LF_CLIENT_SECRET || !header) return false;
  const expected = crypto.createHmac('sha256', process.env.LF_CLIENT_SECRET).update(rawBody, 'utf8').digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(header));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const pick = (obj, ...paths) => {
  for (const p of paths) {
    const v = p.split('.').reduce((a, k) => a?.[k], obj);
    if (v != null && String(v).trim() !== '') return v;
  }
  return null;
};
const num = (v) => {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const text = (v) => (v == null ? null : String(v).trim() || null);

// A LightFunnels order (the webhook's "node") to what the ERP needs. Field names are tried in
// several spellings, because the payload is only partly documented. Throws with the reason.
export function nodeToOrder(node) {
  const ship = node.shipping_address || {};
  const name = text(ship.full_name) || text([ship.first_name, ship.last_name].filter(Boolean).join(' '))
    || text(pick(node, 'customer.full_name', 'billing_address.full_name'));
  if (!name) throw new HttpError(400, 'الاسم ناقص');
  const phone = sheetPhone(pick(node, 'shipping_address.phone', 'customer.phone', 'billing_address.phone', 'phone'));
  if (!phone) throw new HttpError(400, `رقم غير صحيح "${pick(node, 'shipping_address.phone', 'customer.phone') ?? ''}"`);
  const stateRaw = pick(node, 'shipping_address.state', 'shipping_address.province', 'shipping_address.state_code', 'shipping_address.region');
  const wilaya = parseWilaya(stateRaw);
  if (!wilaya) throw new HttpError(400, `ولاية غير معروفة "${stateRaw ?? ''}"`);
  const items = (Array.isArray(node.items) ? node.items : []).map((i) => ({
    title: text(pick(i, 'title', 'name', 'product.title')),
    sku: text(pick(i, 'sku', 'variant.sku')),
    quantity: Math.max(1, Math.floor(num(pick(i, 'quantity', 'qty')) ?? 1)),
    price: num(pick(i, 'price', 'unit_price')),
    variant: text(pick(i, 'variant_title', 'variant.title', 'variant_name')),
  })).filter((i) => i.title || i.sku);
  if (!items.length) throw new HttpError(400, 'ما كاش منتجات في الطلبية');
  const method = text(pick(node, 'shipping_method.title', 'shipping_line.title', 'shipping_method', 'shipping_title')) || '';
  return {
    customer_name: name,
    phone,
    wilaya_code: wilaya,
    commune: text(pick(node, 'shipping_address.city', 'shipping_address.commune')),
    address: text([ship.address1 ?? ship.address, ship.address2].filter(Boolean).join(' ')),
    stop_desk: /desk|bureau|stop|agence|office|مكتب/i.test(method),
    delivery_fee: num(pick(node, 'shipping', 'shipping_price', 'shipping_total')),
    total: num(node.total),
    notes: [text(node.notes), ...items.map((i) => i.variant)].filter(Boolean).join(' | ') || null,
    created_at: text(pick(node, 'created_at', 'date')),
    items,
  };
}

// Imports one webhook call. created = order just placed; confirmed = the complete order
// (after upsells): it fills in a still-untouched order, or imports it if "created" never came.
export async function handleOrderEvent(db, link, topic, node) {
  const lfId = text(node._id ?? node.id);
  if (!lfId) throw new HttpError(400, 'رقم الطلبية ناقص');
  if (node.test === true) return { ignored: 'test' };
  const parsed = nodeToOrder(node);

  const claim = await db.run('INSERT INTO lightfunnels_orders (link_id, lf_order_id) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING lf_order_id', link.id, lfId);
  if (!claim.rows.length) {
    const known = await db.get('SELECT order_id FROM lightfunnels_orders WHERE link_id = ? AND lf_order_id = ?', link.id, lfId);
    if (topic === 'confirmed' && known?.order_id) await refreshOrder(db, known.order_id, link, parsed);
    return { order_id: known?.order_id ?? null, duplicate: true };
  }
  try {
    const lines = await orderLines(db, link, parsed);
    const [main, ...rest] = lines;
    const order = await createOrder(db, {
      product_id: main.product_id, quantity: main.quantity, unit_price: main.unit_price,
      customer_name: parsed.customer_name, phone: parsed.phone, wilaya_code: parsed.wilaya_code, commune: parsed.commune,
      address: parsed.address, stop_desk: parsed.stop_desk, delivery_fee: parsed.delivery_fee, total: parsed.total,
      notes: parsed.notes, items: rest,
    }, { source: 'lightfunnels' });
    await db.run('UPDATE lightfunnels_orders SET order_id = ? WHERE link_id = ? AND lf_order_id = ?', order.id, link.id, lfId);
    await db.run('UPDATE orders SET external_id = ? WHERE id = ?', node.name ? String(node.name) : lfId, order.id);
    if (parsed.created_at && !Number.isNaN(Date.parse(parsed.created_at))) {
      await db.run('UPDATE orders SET created_at = ? WHERE id = ?', new Date(parsed.created_at).toISOString(), order.id);
    }
    return { order_id: order.id };
  } catch (e) {
    await db.run('DELETE FROM lightfunnels_orders WHERE link_id = ? AND lf_order_id = ?', link.id, lfId);
    throw e;
  }
}

async function orderLines(db, link, parsed) {
  const lines = [];
  for (const i of parsed.items) {
    const productId = await productFor(db, { store_id: link.store_id }, i.title || i.sku, i.sku, i.price);
    lines.push({ product_id: productId, quantity: i.quantity, unit_price: i.price });
  }
  return lines;
}

// "confirmed" carries the upsells: update the products of an order nobody touched yet.
async function refreshOrder(db, orderId, link, parsed) {
  const order = await db.get('SELECT status, stock_reserved FROM orders WHERE id = ?', orderId);
  if (!order || order.status !== 'new' || order.stock_reserved) return;
  const [main, ...rest] = await orderLines(db, link, parsed);
  await updateOrder(db, orderId, {
    product_id: main.product_id, quantity: main.quantity, unit_price: main.unit_price,
    delivery_fee: parsed.delivery_fee ?? undefined, items: rest,
  });
}

export async function recordEvent(db, link, topic, node, status, error = null, orderId = null) {
  await db.run(`INSERT INTO lightfunnels_events (link_id, topic, lf_order_id, payload, status, error, order_id)
    VALUES (?, ?, ?, ?::jsonb, ?, ?, ?)`, link.id, topic, text(node?._id ?? node?.id), JSON.stringify(node ?? null), status, error, orderId ?? null);
  await db.run(`UPDATE lightfunnels_links SET last_event_at = now(), last_error = ?,
    imported_count = imported_count + ? WHERE id = ?`, status === 'error' ? error : null, status === 'imported' ? 1 : 0, link.id);
}
