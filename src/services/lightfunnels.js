// Direct connection to LightFunnels: the ERP is an app installed on the LightFunnels account.
// The user accepts the app once (OAuth), then LightFunnels sends each new order by webhook.
import crypto from 'node:crypto';
import { HttpError, createOrder, deleteOrder, updateOrder } from './orders.js';
import { parseWilaya, productFor, sheetPhone, splitVariant } from './sheets.js';

const AUTHORIZE_URL = 'https://app.lightfunnels.com/admin/oauth';
const TOKEN_URL = 'https://api.lightfunnels.com/api/v3/access_token';
const GRAPHQL_URL = 'https://services.lightfunnels.com/api/v2';
const SCOPES = 'orders,products,stores';
// webhook path -> LightFunnels topics sent to it ("checkout" = a customer who started but did not finish: abandoned)
const TOPICS = [['created', 'order/created'], ['confirmed', 'order/confirmed'], ['checkout', 'checkout/created'], ['checkout', 'checkout/updated']];

const secret = () => process.env.SESSION_SECRET || 'dev-secret-change-me';
export const configured = () => Boolean(process.env.LF_CLIENT_ID && process.env.LF_CLIENT_SECRET);
// Which of the two Netlify variables the server can see, so the page can say exactly what is missing.
export const missingKeys = () => ['LF_CLIENT_ID', 'LF_CLIENT_SECRET'].filter((k) => !process.env[k]);
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

// LightFunnels refuses introspection, so the fields are written out (developer.lightfunnels.com/orders/types).
const ADDRESS = 'shipping_address { first_name last_name phone line1 line2 city area state }';
const ORDER_FIELDS = `id _id name total shipping test created_at notes phone customer { full_name phone } ${ADDRESS}
  items { ... on VariantSnapshot { title sku price variant { title product { title } } } ... on OrderBumpSnapshot { title sku price product { title } } }`;
const CHECKOUT_FIELDS = `id _id phone total created_at recovered customer { full_name first_name last_name phone } ${ADDRESS}
  variants { quantity variant { title sku price product { title } } }`;

// The checkout webhook only carries the checkout id: the details are read back from the API.
export async function fetchCheckout(db, link, id) {
  const d = await graphql(db, link, `query($id: ID!) { node(id: $id) { ... on Checkout { ${CHECKOUT_FIELDS} } } }`, { id });
  const c = d.node;
  if (!c) return null;
  // A checkout lists variants; the reader wants items like an order's.
  c.items = (c.variants || []).map((v) => ({
    title: v.variant?.product?.title || v.variant?.title, sku: v.variant?.sku, price: v.variant?.price, quantity: v.quantity,
    variant_title: v.variant?.product?.title && v.variant?.title !== v.variant?.product?.title ? v.variant?.title : null,
  }));
  return c;
}

// Catch-up: reads the latest orders of the account and imports the ones the webhooks did not bring.
export async function pullRecent(db, link, { first = 25 } = {}) {
  const data = await graphql(db, link, `query($first: Int) { orders(query: "order_by:id order_dir:desc", first: $first) { edges { node { ${ORDER_FIELDS} } } } }`, { first });
  const nodes = (data.orders?.edges || []).map((e) => e.node).reverse();
  const result = { seen: nodes.length, imported: 0, errors: [] };
  for (const node of nodes) {
    try {
      const r = await handleOrderEvent(db, link, 'created', node);
      await recordEvent(db, link, 'pull', node, r.ignored ? 'ignored' : r.duplicate ? 'duplicate' : 'imported', null, r.order_id);
      if (!r.ignored && !r.duplicate) result.imported++;
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      await recordEvent(db, link, 'pull', node, 'error', e.message);
      result.errors.push(`${node.name || node._id || node.id}: ${e.message}`);
    }
  }
  return result;
}

const fold = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Side by side: the latest LightFunnels orders (whose items name `q`) and what the ERP has for each.
// `importMissing` brings in the ones the ERP doesn't have (at most 40 per call, to stay under the time limit).
export async function compareOrders(db, link, { q = '', pages = 6, importMissing = false } = {}) {
  const words = fold(q).split(' ').filter(Boolean);
  const nodes = [];
  let after = null;
  for (let page = 0; page < Math.min(Math.max(1, pages), 10); page++) {
    const data = await graphql(db, link, `query($first: Int, $after: String) { orders(query: "order_by:id order_dir:desc", first: $first, after: $after) { edges { cursor node { ${ORDER_FIELDS} } } } }`, { first: 50, after });
    const edges = data.orders?.edges || [];
    nodes.push(...edges.map((e) => e.node));
    if (edges.length < 50 || !edges.at(-1).cursor) break;
    after = edges.at(-1).cursor;
  }
  const titles = (n) => (n.items || []).map((i) => i?.title).filter(Boolean);
  const wanted = nodes.filter((n) => !n.test && (!words.length || words.every((w) => fold(titles(n).join(' ')).includes(w))));
  const rows = [];
  let imported = 0;
  for (const n of wanted) {
    const lfId = text(n._id ?? n.id);
    let known = await db.get(`SELECT o.id, o.reference, o.status, p.name AS product, s.name AS store FROM lightfunnels_orders l
      JOIN orders o ON o.id = l.order_id JOIN products p ON p.id = o.product_id LEFT JOIN stores s ON s.id = p.store_id
      WHERE l.link_id = ? AND l.lf_order_id = ?`, link.id, lfId);
    let error = null;
    if (!known && importMissing && imported < 40) {
      try {
        const r = await handleOrderEvent(db, link, 'created', n);
        await recordEvent(db, link, 'pull', n, r.ignored ? 'ignored' : r.duplicate ? 'duplicate' : 'imported', typeof r.ignored === 'string' ? r.ignored : null, r.order_id);
        if (r.order_id && !r.duplicate) imported++;
        if (r.ignored) error = r.ignored;
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        error = e.message;
      }
      known = await db.get(`SELECT o.id, o.reference, o.status, p.name AS product, s.name AS store FROM lightfunnels_orders l
        JOIN orders o ON o.id = l.order_id JOIN products p ON p.id = o.product_id LEFT JOIN stores s ON s.id = p.store_id
        WHERE l.link_id = ? AND l.lf_order_id = ?`, link.id, lfId);
    }
    rows.push({
      lf_name: text(n.name) || lfId, created_at: text(n.created_at), items: titles(n).join(' + '),
      phone: text(n.phone ?? n.shipping_address?.phone ?? n.customer?.phone),
      order_id: known?.id ?? null, reference: known?.reference ?? null, status: known?.status ?? null,
      product: known?.product ?? null, store: known?.store ?? null, error,
    });
  }
  return { scanned: nodes.length, oldest: text(nodes.at(-1)?.created_at), matched: rows.length, missing: rows.filter((r) => !r.order_id).length, imported, rows };
}

// After the user accepts: keep the tokens and ask LightFunnels to send the orders here.
export async function connectLink(db, linkId, code, origin) {
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(origin) });
  await saveTokens(db, linkId, t);
  const link = await db.get('SELECT * FROM lightfunnels_links WHERE id = ?', linkId);
  return registerWebhooks(db, link, origin, []);
}

async function registerWebhooks(db, link, origin, have) {
  const done = [...have];
  const errors = [];
  for (const [path, type] of TOPICS) {
    if (done.includes(type)) continue;
    try {
      await graphql(db, link, `mutation($node: WebhookInput!) { createWebhook(node: $node) { type url } }`,
        { node: { type, url: `${origin}/api/public/lightfunnels/${link.id}/${path}`, settings: {} } });
      done.push(type);
    } catch (e) {
      errors.push(`${type}: ${e.message}`);
    }
  }
  await db.run('UPDATE lightfunnels_links SET webhooks = ?, last_error = ? WHERE id = ?', done.join(','), errors.join('\n') || null, link.id);
  return { webhooks: done, errors };
}

// Links connected before the abandoned-checkout topics existed get them added with the stored token.
export async function ensureWebhooks(db, link, origin) {
  const have = String(link.webhooks || '').split(',').filter(Boolean);
  if (TOPICS.every(([, type]) => have.includes(type))) return { webhooks: have, errors: [] };
  return registerWebhooks(db, link, origin, have);
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

// LightFunnels variant titles repeat the product name ("Pyjama Taille :XL/42"): keep only "Taille :XL/42".
function variantOnly(title, variant) {
  if (!variant || variant === title) return null;
  return title && variant.startsWith(title) ? variant.slice(title.length).trim() || null : variant;
}

// A LightFunnels order (the webhook's "node") to what the ERP needs. Field names are tried in
// several spellings, because the payload is only partly documented. Throws with the reason.
export function nodeToOrder(node) {
  const ship = node.shipping_address || {};
  const name = text(ship.full_name) || text([ship.first_name, ship.last_name].filter(Boolean).join(' '))
    || text(pick(node, 'customer.full_name', 'billing_address.full_name', 'full_name', 'customer_name'))
    || text([pick(node, 'customer.first_name', 'first_name'), pick(node, 'customer.last_name', 'last_name')].filter(Boolean).join(' '));
  if (!name) throw new HttpError(400, 'الاسم ناقص');
  const phone = sheetPhone(pick(node, 'shipping_address.phone', 'customer.phone', 'billing_address.phone', 'phone'));
  if (!phone) throw new HttpError(400, `رقم غير صحيح "${pick(node, 'shipping_address.phone', 'customer.phone') ?? ''}"`);
  const stateRaw = pick(node, 'shipping_address.state', 'shipping_address.province', 'shipping_address.state_code', 'shipping_address.region');
  // Some landing pages put the wilaya in the city field and leave the state empty.
  const wilaya = parseWilaya(stateRaw) || parseWilaya(pick(node, 'shipping_address.city'));
  if (!wilaya) throw new HttpError(400, `ولاية غير معروفة "${stateRaw ?? ''}"`);
  const items = ([node.items, node.line_items, node.lines, node.products].find(Array.isArray) || []).map((i) => {
    // The product name without its options: from the product itself when sent, else cut from the line title.
    const full = text(pick(i, 'title', 'name'));
    const [cut, rest] = splitVariant(full);
    const title = text(pick(i, 'product.title', 'variant.product.title', 'product_title')) || cut;
    return {
      title,
      sku: text(pick(i, 'sku', 'variant.sku')),
      quantity: Math.max(1, Math.floor(num(pick(i, 'quantity', 'qty')) ?? 1)),
      price: num(pick(i, 'price', 'unit_price')),
      variant: variantOnly(title, text(pick(i, 'variant_title', 'variant_name'))) || variantOnly(title, full) || rest
        || variantOnly(title, text(pick(i, 'variant.title'))),
    };
  }).filter((i) => i.title || i.sku).reduce((acc, i) => {
    const same = acc.find((x) => x.title === i.title && x.sku === i.sku && x.price === i.price && x.variant === i.variant);
    if (same) same.quantity += i.quantity; else acc.push(i);
    return acc;
  }, []);
  if (!items.length) throw new HttpError(400, 'ما كاش منتجات في الطلبية');
  const method = text(pick(node, 'shipping_method.title', 'shipping_line.title', 'shipping_method', 'shipping_title')) || '';
  return {
    customer_name: name,
    phone,
    wilaya_code: wilaya,
    commune: text(pick(node, 'shipping_address.city', 'shipping_address.commune', 'shipping_address.area')),
    address: text([ship.address1 ?? ship.line1 ?? ship.address, ship.address2 ?? ship.line2].filter(Boolean).join(' ')),
    stop_desk: /desk|bureau|stop|agence|office|مكتب/i.test(method),
    delivery_fee: num(pick(node, 'shipping', 'shipping_price', 'shipping_total')),
    total: num(node.total),
    variant: items[0].variant,
    notes: [text(node.notes), ...items.slice(1).map((i) => i.variant && `${i.title}: ${i.variant}`)].filter(Boolean).join(' | ') || null,
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
      notes: parsed.notes, variant: parsed.variant, items: rest,
    }, { source: 'lightfunnels' });
    await db.run('UPDATE lightfunnels_orders SET order_id = ? WHERE link_id = ? AND lf_order_id = ?', order.id, link.id, lfId);
    await dropAbandonedCopies(db, parsed.phone, order.id);
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

// A checkout the customer left without ordering: kept as an "abandoned" order for the confirmation team.
// A checkout still being filled in (no name/phone/wilaya yet) is skipped, later updates bring the rest.
export async function handleCheckoutEvent(db, link, node) {
  const rawId = text(node._id ?? node.id);
  if (!rawId) throw new HttpError(400, 'رقم الـ checkout ناقص');
  if (!node.items && !node.line_items && !node.shipping_address) {
    const full = await fetchCheckout(db, link, text(node.id) ?? rawId);
    if (!full) return { ignored: 'checkout ما لقيناهش' };
    if (full.recovered) return { ignored: 'الزبون كمل الطلبية', node: full };
    node = { ...node, ...full };
  }
  if (node.test === true) return { ignored: 'test', node };
  const lfId = `co:${rawId}`;
  let parsed;
  try {
    parsed = nodeToOrder(node);
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    return { ignored: `ناقص: ${e.message}`, node };
  }
  if (await db.get("SELECT 1 AS x FROM orders WHERE phone = ? AND source = 'lightfunnels' AND created_at > now() - interval '3 days'", parsed.phone)) {
    return { ignored: 'الزبون دار الطلبية', node };
  }
  const claim = await db.run('INSERT INTO lightfunnels_orders (link_id, lf_order_id) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING lf_order_id', link.id, lfId);
  if (!claim.rows.length) return { duplicate: true, node };
  try {
    const [main, ...rest] = await orderLines(db, link, parsed);
    const order = await createOrder(db, {
      product_id: main.product_id, quantity: main.quantity, unit_price: main.unit_price,
      customer_name: parsed.customer_name, phone: parsed.phone, wilaya_code: parsed.wilaya_code, commune: parsed.commune,
      address: parsed.address, stop_desk: parsed.stop_desk, delivery_fee: parsed.delivery_fee, total: parsed.total,
      notes: parsed.notes, variant: parsed.variant, items: rest,
    }, { source: 'abandoned' });
    await db.run('UPDATE lightfunnels_orders SET order_id = ? WHERE link_id = ? AND lf_order_id = ?', order.id, link.id, lfId);
    return { order_id: order.id, node };
  } catch (e) {
    await db.run('DELETE FROM lightfunnels_orders WHERE link_id = ? AND lf_order_id = ?', link.id, lfId);
    throw e;
  }
}

// The customer finished the order after all: the untouched abandoned copy of the same phone goes away.
async function dropAbandonedCopies(db, phone, exceptId) {
  const rows = await db.all(`SELECT id FROM orders WHERE phone = ? AND source = 'abandoned' AND status = 'new'
    AND call_attempts = 0 AND assigned_to IS NULL AND id <> ? AND created_at > now() - interval '3 days'`, phone, exceptId);
  for (const r of rows) {
    console.log('lightfunnels checkout replaced by real order:', r.id, '->', exceptId);
    try { await deleteOrder(db, r.id); } catch (e) { if (!(e instanceof HttpError)) throw e; }
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
