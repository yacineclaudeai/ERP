import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp, ensureAdmin } from '../src/server.js';
import { normalizePhone } from '../src/services/orders.js';
import { mapEcotrackStatus } from '../src/delivery/ecotrack.js';

let server, base, cookie = '';

async function api(method, path, body, { auth = true } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth && cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null) };
}

before(async () => {
  const db = openDb(':memory:');
  ensureAdmin(db);
  server = createApp(db).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('phone normalization', () => {
  assert.equal(normalizePhone('+213 555 12 34 56'), '0555123456');
  assert.equal(normalizePhone('0661-11-22-33'), '0661112233');
  assert.equal(normalizePhone('12345'), null);
});

test('ecotrack status mapping', () => {
  assert.equal(mapEcotrackStatus('livre_non_encaisse'), 'delivered');
  assert.equal(mapEcotrackStatus('encaisse_non_paye'), 'delivered');
  assert.equal(mapEcotrackStatus('retour_chez_partenaire'), 'returned');
  assert.equal(mapEcotrackStatus('en_livraison'), 'dispatched');
});

test('landing order → confirm → auto dispatch by wilaya → delivered, with stock', async () => {
  assert.equal((await api('GET', '/api/products')).status, 401);
  assert.equal((await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' })).status, 200);

  const product = (await api('POST', '/api/products', { name: 'Montre', price: 3500, cost: 1200, stock: 10 })).body;
  const oran = (await api('POST', '/api/delivery/companies', { name: 'Oran Express', provider: 'sandbox' })).body;
  const algiers = (await api('POST', '/api/delivery/companies', { name: 'Alger Express', provider: 'sandbox' })).body;
  await api('PUT', '/api/delivery/routes', {
    default_company_id: algiers.id,
    routes: [{ wilaya_code: 31, company_id: oran.id, home_fee: 600, desk_fee: 400 }],
  });

  // Landing page: no cookie, only the product's public key.
  const info = await api('GET', `/api/public/products/${product.public_key}`, null, { auth: false });
  assert.equal(info.body.price, 3500);
  const created = await api('POST', '/api/public/orders', {
    key: product.public_key, name: 'Amine', phone: '0555 12 34 56', wilaya: 31, commune: 'Bir El Djir', quantity: 2,
  }, { auth: false });
  assert.equal(created.status, 201);
  assert.equal(created.body.total, 3500 * 2 + 600);

  const bad = await api('POST', '/api/public/orders', { key: product.public_key, name: 'X', phone: '12', wilaya: 31 }, { auth: false });
  assert.equal(bad.status, 400);

  const { rows } = (await api('GET', '/api/orders?status=new')).body;
  assert.equal(rows.length, 1);
  const id = rows[0].id;

  await api('POST', `/api/orders/${id}/action`, { action: 'no_answer' });
  const confirmed = (await api('POST', `/api/orders/${id}/action`, { action: 'confirm' })).body;
  assert.equal(confirmed.status, 'dispatched');
  assert.equal(confirmed.company_name, 'Oran Express');
  assert.match(confirmed.tracking, /^TEST-/);
  assert.equal(confirmed.call_attempts, 1);

  let products = (await api('GET', '/api/products')).body;
  assert.equal(products[0].stock, 8);

  assert.equal((await api('POST', `/api/orders/${id}/action`, { action: 'delivered' })).body.status, 'delivered');

  // A second order in another wilaya goes to the default company, then comes back as a return.
  const o2 = (await api('POST', '/api/orders', { product_id: product.id, customer_name: 'Sara', phone: '0770000000', wilaya_code: 16 })).body;
  const d2 = (await api('POST', `/api/orders/${o2.id}/action`, { action: 'confirm' })).body;
  assert.equal(d2.company_name, 'Alger Express');
  await api('POST', `/api/orders/${o2.id}/action`, { action: 'returned' });
  products = (await api('GET', '/api/products')).body;
  assert.equal(products[0].stock, 8, 'returned stock goes back');

  await api('POST', '/api/ad-spend', { product_id: product.id, date: new Date().toISOString().slice(0, 10), amount: 2000 });
  const stats = (await api('GET', '/api/stats')).body;
  assert.equal(stats.delivery_rate, 50);
  const p = stats.products[0];
  assert.equal(p.revenue, 7000);
  assert.equal(p.profit, 7000 - 2400 - 2000);
});

test('duplicate landing orders are flagged', async () => {
  const product = (await api('POST', '/api/products', { name: 'Sac', price: 2000 })).body;
  const send = () => api('POST', '/api/public/orders', { key: product.public_key, name: 'Ali', phone: '0661112233', wilaya: 9 }, { auth: false });
  await send();
  await send();
  const { rows } = (await api('GET', `/api/orders?product_id=${product.id}`)).body;
  assert.equal(rows.filter((o) => o.duplicate_of).length, 1);
});

test('dispatch failure keeps the order confirmed with the error', async () => {
  const product = (await api('POST', '/api/products', { name: 'Lampe', price: 1500, stock: 3 })).body;
  const eco = (await api('POST', '/api/delivery/companies', { name: 'Eco sans token', provider: 'ecotrack' })).body;
  await api('PUT', '/api/delivery/routes', { routes: [{ wilaya_code: 25, company_id: eco.id }] });
  const o = (await api('POST', '/api/orders', { product_id: product.id, customer_name: 'K', phone: '0550000000', wilaya_code: 25 })).body;
  const r = (await api('POST', `/api/orders/${o.id}/action`, { action: 'confirm' })).body;
  assert.equal(r.status, 'confirmed');
  assert.match(r.dispatch_error, /api_token/);
  const manual = (await api('POST', `/api/orders/${o.id}/dispatch`, { tracking: 'ABC123' })).body;
  assert.equal(manual.status, 'dispatched');
  assert.equal(manual.tracking, 'ABC123');
});

test('ecotrack sends api_token as a query parameter and accepts base_url with /api/v1', async () => {
  const { ecotrack } = await import('../src/delivery/ecotrack.js');
  const realFetch = globalThis.fetch;
  let called;
  globalThis.fetch = async (url, init) => {
    called = { url: String(url), init };
    return new Response(JSON.stringify({ success: true, tracking: 'ECO123' }), { status: 200 });
  };
  try {
    const r = await ecotrack.createShipment(
      { base_url: 'https://demo.ecotrack.dz/api/v1/', api_token: 'TOK' },
      { reference: 'CMD-1', customer_name: 'A', phone: '0555000000', wilaya_code: 16, total: 1000, quantity: 1 },
      { name: 'P' },
    );
    assert.equal(r.tracking, 'ECO123');
    assert.equal(called.url, 'https://demo.ecotrack.dz/api/v1/create/order?api_token=TOK');
    assert.equal(called.init.headers.Authorization, undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a store ships through its own account, with per-wilaya exceptions', async () => {
  const hhd = (await api('POST', '/api/delivery/companies', { name: 'HHD', provider: 'sandbox' })).body;
  const dhd = (await api('POST', '/api/delivery/companies', { name: 'DHD', provider: 'sandbox' })).body;
  const store = (await api('POST', '/api/stores', {
    name: 'YACINE', company_id: hhd.id, routes: [{ wilaya_code: 35, company_id: dhd.id }],
  })).body;
  const product = (await api('POST', '/api/products', { name: 'Parfum', price: 2900, stock: 5, store_id: store.id })).body;

  const send = async (wilaya) => {
    const o = (await api('POST', '/api/orders', { product_id: product.id, customer_name: 'Z', phone: `055${wilaya}000000`.slice(0, 10), wilaya_code: wilaya })).body;
    return (await api('POST', `/api/orders/${o.id}/action`, { action: 'confirm' })).body;
  };
  assert.equal((await send(16)).company_name, 'HHD');
  assert.equal((await send(35)).company_name, 'DHD');

  const stores = (await api('GET', '/api/stores')).body;
  assert.equal(stores.find((s) => s.name === 'YACINE').routes.length, 1);
  const stats = (await api('GET', '/api/stats')).body;
  assert.equal(stats.by_store.find((s) => s.store_name === 'YACINE').orders, 2);
});

test('ad plan launches in-stock products and pauses sold-out campaigns', async () => {
  const store = (await api('POST', '/api/stores', { name: 'ADS', ad_account_id: 'act_111' })).body;
  const mk = async (name, stock, landing_url = 'https://shop.dz/p') =>
    (await api('POST', '/api/products', { name, price: 3000, stock, landing_url, store_id: store.id, ad_creative_folder: 'https://drive.google.com/drive/folders/x' })).body;
  const ready = await mk('Ready', 50);
  const low = await mk('Low', 3);
  const noPage = await mk('NoPage', 40, '');

  let plan = (await api('GET', '/api/ads/plan')).body;
  assert.equal(plan.to_launch.find((p) => p.id === ready.id).daily_budget, 9, 'default budget is 9');
  await api('PUT', `/api/products/${ready.id}`, { name: 'Ready', price: 3000, landing_url: 'https://shop.dz/p', store_id: store.id, ad_daily_budget: 15 });
  plan = (await api('GET', '/api/ads/plan')).body;
  assert.equal(plan.to_launch.find((p) => p.id === ready.id).daily_budget, 15, 'product budget wins');
  await api('PUT', `/api/products/${ready.id}`, { name: 'Ready', price: 3000, landing_url: 'https://shop.dz/p', store_id: store.id, ad_daily_budget: 0 });

  await api('PUT', '/api/ads/settings', { daily_budget: 2000, max_total_daily_budget: 3000, min_stock: 20 });
  plan = (await api('GET', '/api/ads/plan')).body;
  const launchIds = plan.to_launch.map((p) => p.id);
  assert.ok(launchIds.includes(ready.id));
  assert.ok(!launchIds.includes(low.id));
  assert.equal(plan.to_launch.find((p) => p.id === ready.id).ad_account_id, '111');
  assert.equal(plan.skipped.find((p) => p.id === noPage.id).reason, 'ما عندوش لاندينغ بيج');

  const c = (await api('POST', '/api/ads/campaigns', { product_id: ready.id, meta_campaign_id: '999', daily_budget: 2000, status: 'active' })).body;
  assert.equal((await api('POST', '/api/ads/campaigns', { product_id: ready.id, status: 'draft' })).status, 409);
  plan = (await api('GET', '/api/ads/plan')).body;
  assert.ok(!plan.to_launch.some((p) => p.id === ready.id));

  await api('POST', `/api/products/${ready.id}/stock`, { quantity: -48, reason: 'test' });
  plan = (await api('GET', '/api/ads/plan')).body;
  assert.equal(plan.to_pause[0].id, c.id);
  assert.equal((await api('PATCH', `/api/ads/campaigns/${c.id}`, { status: 'paused' })).body.status, 'paused');
});

test('automation token opens only the ads routes', async () => {
  process.env.AUTOMATION_TOKEN = 'robot-token-123';
  const call = (path) => fetch(base + path, { headers: { Authorization: 'Bearer robot-token-123' } });
  try {
    assert.equal((await call('/api/ads/plan')).status, 200);
    assert.equal((await call('/api/orders')).status, 401);
    assert.equal((await fetch(base + '/api/ads/plan', { headers: { Authorization: 'Bearer nope' } })).status, 401);
  } finally {
    delete process.env.AUTOMATION_TOKEN;
  }
});
