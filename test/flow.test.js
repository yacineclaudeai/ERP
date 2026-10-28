import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '@hono/node-server';
import { openLocalDb } from '../src/db-local.js';
import { createApp } from '../src/app.js';
import { normalizePhone } from '../src/services/orders.js';
import { mapEcotrackStatus } from '../src/delivery/ecotrack.js';

let server, base, db, cookie = '';

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
  // The build runs with the real admin account in the environment; tests use their own.
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'admin123';
  delete process.env.AUTOMATION_TOKEN;
  db = await openLocalDb();
  const app = createApp(db);
  server = await new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close();
  await db.close();
});

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
    name: 'BOUTIQUE TEST', company_id: hhd.id, routes: [{ wilaya_code: 35, company_id: dhd.id }],
  })).body;
  const product = (await api('POST', '/api/products', { name: 'Parfum', price: 2900, stock: 5, store_id: store.id })).body;

  const send = async (wilaya) => {
    const o = (await api('POST', '/api/orders', { product_id: product.id, customer_name: 'Z', phone: `055${wilaya}000000`.slice(0, 10), wilaya_code: wilaya })).body;
    return (await api('POST', `/api/orders/${o.id}/action`, { action: 'confirm' })).body;
  };
  assert.equal((await send(16)).company_name, 'HHD');
  assert.equal((await send(35)).company_name, 'DHD');

  const stores = (await api('GET', '/api/stores')).body;
  assert.equal(stores.find((s) => s.name === 'BOUTIQUE TEST').routes.length, 1);
  const stats = (await api('GET', '/api/stats')).body;
  assert.equal(stats.by_store.find((s) => s.store_name === 'BOUTIQUE TEST').orders, 2);
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

test('a confirmation agent edits an order from the table, product included', async () => {
  const a = (await api('POST', '/api/products', { name: 'Parfum A', price: 2500, stock: 5 })).body;
  const b = (await api('POST', '/api/products', { name: 'Parfum B', price: 3000, stock: 5 })).body;
  await api('POST', '/api/users', { username: 'agent1', password: 'agent123', role: 'agent' });
  const o = (await api('POST', '/api/orders', { product_id: a.id, customer_name: 'Test', phone: '0550001122', wilaya_code: 16 })).body;

  await api('POST', '/api/auth/login', { username: 'agent1', password: 'agent123' });
  let r = await api('PUT', `/api/orders/${o.id}`, { product_id: b.id });
  assert.equal(r.status, 200);
  assert.equal(r.body.product_name, 'Parfum B');
  assert.equal(r.body.unit_price, 3000, 'takes the new product price');
  r = await api('PUT', `/api/orders/${o.id}`, { stop_desk: true, commune: 'Hydra', quantity: 2 });
  assert.equal(r.body.commune, 'Hydra');
  assert.equal(r.body.total, 3000 * 2 + r.body.delivery_fee);
  assert.equal((await api('PUT', `/api/orders/${o.id}`, { phone: '12' })).status, 400);

  // Once confirmed the stock is held: the product can't change any more.
  await api('POST', `/api/orders/${o.id}/action`, { action: 'confirm' });
  assert.equal((await api('GET', '/api/products')).body.find((p) => p.id === b.id).stock, 3);
  assert.equal((await api('PUT', `/api/orders/${o.id}`, { product_id: a.id })).status, 409);
  await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
});

test('no answer or postponed can go back to new', async () => {
  const p = (await api('POST', '/api/products', { name: 'Reset', price: 1000 })).body;
  const o = (await api('POST', '/api/orders', { product_id: p.id, customer_name: 'R', phone: '0551239876', wilaya_code: 16 })).body;
  await api('POST', `/api/orders/${o.id}/action`, { action: 'no_answer' });
  await api('POST', `/api/orders/${o.id}/action`, { action: 'no_answer' });
  const r = (await api('POST', `/api/orders/${o.id}/action`, { action: 'reset' })).body;
  assert.equal(r.status, 'new');
  assert.equal(r.call_attempts, 0);
  assert.equal((await api('POST', `/api/orders/${o.id}/action`, { action: 'reset' })).status, 409);
});

test('products are linked to their store from the parcels each store shipped', async () => {
  const eco = (await api('POST', '/api/delivery/companies', {
    name: 'Packers test', provider: 'ecotrack', base_url: 'https://packers-test.ecotrack.dz', api_token: 'T1',
  })).body;
  const hhd = (await api('POST', '/api/delivery/companies', { name: 'HHD test', provider: 'sandbox' })).body;
  const azzou = (await api('POST', '/api/stores', { name: 'BOUTIQUE LIEN', company_id: eco.id })).body;
  const other = (await api('POST', '/api/stores', { name: 'SANS API', company_id: hhd.id })).body;
  const ring = (await api('POST', '/api/products', { name: 'Bague Lune', price: 1900 })).body;
  const none = (await api('POST', '/api/products', { name: 'Jamais Vendu', price: 100 })).body;
  const o = (await api('POST', '/api/orders', { product_id: ring.id, customer_name: 'B', phone: '0551230000', wilaya_code: 16 })).body;

  const realFetch = globalThis.fetch;
  const pages = {
    1: { data: [{ tracking: 'A1', products: 'Bague lune x1' }, { tracking: 'A2', products: 'BAGUE LUNE (2)' }], last_page: 2 },
    2: { data: [{ tracking: 'A3', products: 'Autre chose' }], last_page: 2 },
  };
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (!u.hostname.endsWith('ecotrack.dz')) return realFetch(url, init);
    assert.equal(u.pathname, '/api/v1/get/orders');
    assert.equal(u.searchParams.get('api_token'), 'T1');
    assert.ok(u.searchParams.get('start_date') && u.searchParams.get('end_date'));
    return new Response(JSON.stringify(pages[u.searchParams.get('page')]), { status: 200 });
  };
  try {
    const p1 = (await api('POST', '/api/branches/scan', { store_id: azzou.id, page: 1 })).body;
    assert.equal(p1.last_page, 2);
    const p2 = (await api('POST', '/api/branches/scan', { store_id: azzou.id, page: 2 })).body;
    assert.equal((await api('POST', '/api/branches/scan', { store_id: other.id })).status, 400, 'sandbox has no parcel list');
    const r = (await api('POST', '/api/branches/apply', { texts: { [azzou.id]: [...p1.texts, ...p2.texts] } })).body;
    assert.deepEqual(r.linked.map((l) => [l.product, l.to, l.orders]), [['Bague Lune', 'BOUTIQUE LIEN', 1]]);
    assert.ok(r.unmatched.includes(none.name));
  } finally {
    globalThis.fetch = realFetch;
  }
  const after = (await api('GET', `/api/orders/${o.id}`)).body;
  assert.equal(after.store_name, 'BOUTIQUE LIEN');
  assert.equal(after.company_name, 'Packers test', 'open orders follow the product to its store company');

  // By hand from the orders table.
  const moved = (await api('PUT', `/api/products/${ring.id}/store`, { store_id: other.id })).body;
  assert.equal(moved.orders, 1);
  assert.equal((await api('GET', `/api/orders/${o.id}`)).body.company_name, 'HHD test');
});

test('real company names, the user product list, and each store ships with its own token', async () => {
  const companies = (await api('GET', '/api/delivery/companies')).body;
  for (const name of ['HHD Express', 'Packers Delivery', 'DHD Delivery', 'My Ecom Delivery']) {
    assert.equal(companies.filter((c) => c.name === name).length, 1, name);
  }
  assert.ok(!companies.some((c) => / - [A-Z ]+$/.test(c.name)), 'no per-store company rows left');

  const stores = (await api('GET', '/api/stores')).body;
  const store = (name) => stores.find((x) => x.name === name);
  assert.equal(store('YAMIR').company_name, 'My Ecom Delivery');
  assert.equal(store('BOUCHRA').company_name, 'DHD Delivery');

  const products = (await api('GET', '/api/products')).body;
  const product = (name) => products.find((p) => p.name === name);
  assert.equal(products.filter((p) => p.public_key.startsWith('list-')).length, 120);
  assert.deepEqual([product('Robe N & R').store_name, product('Robe N & R').company_name], ['AZZOU', 'Packers Delivery']);
  // YAMIR ships this one through its Packers account, not its main My Ecom one.
  assert.deepEqual([product('pyjama namri importation').store_name, product('pyjama namri importation').company_name], ['YAMIR', 'Packers Delivery']);
  assert.equal(product('Basket Active 2026').store_id, null);

  // The token is the store's own account at the company.
  const packers = companies.find((c) => c.name === 'Packers Delivery');
  await api('PUT', `/api/stores/${store('YAMIR').id}`, {
    name: 'YAMIR', company_id: store('YAMIR').company_id, accounts: [{ company_id: packers.id, api_token: 'YAMIR-PACKERS' }],
  });
  const yamir = (await api('GET', '/api/stores')).body.find((x) => x.name === 'YAMIR');
  assert.deepEqual(yamir.accounts.map((a) => [a.company_name, a.has_token]), [['Packers Delivery', true]]);
  assert.ok(!JSON.stringify(yamir).includes('YAMIR-PACKERS'), 'tokens never sent back');

  const p = product('pyjama namri importation');
  const realFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (!u.hostname.endsWith('ecotrack.dz')) return realFetch(url, init);
    sent = u;
    return new Response(JSON.stringify({ success: true, tracking: 'PK-1' }), { status: 200 });
  };
  try {
    const o = (await api('POST', '/api/orders', { product_id: p.id, customer_name: 'Y', phone: '0551119999', wilaya_code: 16 })).body;
    assert.equal(o.company_name, 'Packers Delivery');
    const d = (await api('POST', `/api/orders/${o.id}/action`, { action: 'confirm' })).body;
    assert.equal(d.status, 'dispatched');
    assert.equal(sent.hostname, 'packers.ecotrack.dz');
    assert.equal(sent.searchParams.get('api_token'), 'YAMIR-PACKERS');
  } finally {
    globalThis.fetch = realFetch;
  }

  // Changing the product's company from the products page.
  const dhd = companies.find((c) => c.name === 'DHD Delivery');
  await api('PUT', `/api/products/${p.id}/store`, { company_id: dhd.id });
  assert.equal((await api('GET', '/api/products')).body.find((x) => x.id === p.id).company_name, 'DHD Delivery');
});

test('orders list filters by source and delivery type; admins delete unsent orders', async () => {
  const p = (await api('POST', '/api/products', { name: 'Filtre', price: 1000, stock: 3 })).body;
  const home = (await api('POST', '/api/orders', { product_id: p.id, customer_name: 'H', phone: '0551110001', wilaya_code: 16 })).body;
  const desk = (await api('POST', '/api/orders', { product_id: p.id, customer_name: 'D', phone: '0551110002', wilaya_code: 16, stop_desk: true })).body;
  const ids = (qs) => api('GET', `/api/orders?product_id=${p.id}&${qs}`).then((r) => r.body.rows.map((o) => o.id));
  assert.deepEqual(await ids('stop_desk=1'), [desk.id]);
  assert.deepEqual(await ids('source=manual&stop_desk=0'), [home.id]);
  assert.deepEqual(await ids('source=landing'), []);

  await api('POST', `/api/orders/${home.id}/action`, { action: 'cancel' });
  assert.equal((await api('DELETE', `/api/orders/${home.id}`)).status, 200);
  assert.equal((await api('GET', `/api/orders/${home.id}`)).status, 404);
});
