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
  // Most tests route by store or wilaya; the TEST store for new products has its own test.
  await db.run("UPDATE settings SET value = NULL WHERE key = 'new_product_store_id'");
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
  assert.equal(products[0].stock, 7, 'a return on its way back is not in stock yet');
  assert.equal((await api('POST', `/api/orders/${o2.id}/action`, { action: 'return_received' })).body.return_received_at != null, true);
  products = (await api('GET', '/api/products')).body;
  assert.equal(products[0].stock, 8, 'received return goes back to stock');
  assert.equal((await api('POST', `/api/orders/${o2.id}/action`, { action: 'return_received' })).status, 409);

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
  assert.match(r.dispatch_error, /التوكن/);
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
    name: 'BOUTIQUE ALPHA', company_id: hhd.id, routes: [{ wilaya_code: 35, company_id: dhd.id }],
  })).body;
  const product = (await api('POST', '/api/products', { name: 'Parfum', price: 2900, stock: 5, store_id: store.id })).body;

  const send = async (wilaya) => {
    const o = (await api('POST', '/api/orders', { product_id: product.id, customer_name: 'Z', phone: `055${wilaya}000000`.slice(0, 10), wilaya_code: wilaya })).body;
    return (await api('POST', `/api/orders/${o.id}/action`, { action: 'confirm' })).body;
  };
  assert.equal((await send(16)).company_name, 'HHD');
  assert.equal((await send(35)).company_name, 'DHD');

  const stores = (await api('GET', '/api/stores')).body;
  assert.equal(stores.find((s) => s.name === 'BOUTIQUE ALPHA').routes.length, 1);
  const stats = (await api('GET', '/api/stats')).body;
  assert.equal(stats.by_store.find((s) => s.store_name === 'BOUTIQUE ALPHA').orders, 2);
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
  await api('POST', '/api/users', { username: 'agent1', password: 'agent123', role: 'agent', permissions: ['confirm', 'tracking'] });
  const o = (await api('POST', '/api/orders', { product_id: a.id, customer_name: 'Test', phone: '0550001122', wilaya_code: 16 })).body;
  const agent = (await api('GET', '/api/users')).body.users.find((u) => u.username === 'agent1');
  await api('POST', '/api/orders/assign', { ids: [o.id], user_id: agent.id });

  // Changing the main product is for the admin only; the agent edits the rest.
  let r = await api('PUT', `/api/orders/${o.id}`, { product_id: b.id });
  assert.equal(r.status, 200);
  assert.equal(r.body.product_name, 'Parfum B');
  assert.equal(r.body.unit_price, 3000, 'takes the new product price');
  await api('POST', '/api/auth/login', { username: 'agent1', password: 'agent123' });
  assert.equal((await api('PUT', `/api/orders/${o.id}`, { product_id: a.id })).status, 403);
  r = await api('PUT', `/api/orders/${o.id}`, { stop_desk: true, commune: 'Hydra', quantity: 2 });
  assert.equal(r.body.commune, 'Hydra');
  assert.equal(r.body.total, 3000 * 2 + r.body.delivery_fee);
  assert.equal((await api('PUT', `/api/orders/${o.id}`, { phone: '12' })).status, 400);

  // Once confirmed the stock is held: the product can't change any more.
  await api('POST', `/api/orders/${o.id}/action`, { action: 'confirm' });
  assert.equal((await api('GET', '/api/products')).body.find((p) => p.id === b.id).stock, 3);
  await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  assert.equal((await api('PUT', `/api/orders/${o.id}`, { product_id: a.id })).status, 409);
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

test('a token for an existing store is not saved on a new look-alike store', async () => {
  for (const name of ['yacine', 'YACINE Packers']) {
    const r = await api('POST', '/api/stores', { name });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /YACINE/);
  }
  assert.equal((await api('POST', '/api/stores', { name: 'Nouvelle boutique' })).status, 201);
});

test('changing a store company moves its confirmed orders to the new company', async () => {
  const companies = (await api('GET', '/api/delivery/companies')).body;
  const [a, b] = companies;
  const store = (await api('POST', '/api/stores', { name: 'Boutique Switch', company_id: a.id })).body;
  const p = (await api('POST', '/api/products', { name: 'Switch item', price: 1000, stock: 3, store_id: store.id })).body;
  await api('PUT', `/api/products/${p.id}/store`, { store_id: store.id });
  const o = (await api('POST', '/api/orders', { product_id: p.id, customer_name: 'S', phone: '0551110009', wilaya_code: 16 })).body;
  assert.equal((await api('GET', `/api/orders/${o.id}`)).body.company_id, a.id);
  await api('PUT', `/api/stores/${store.id}`, { name: 'Boutique Switch', company_id: b.id });
  assert.equal((await api('GET', `/api/orders/${o.id}`)).body.company_id, b.id);
});

test('a confirmed or sent order goes back to confirmation; a sent parcel is removed at the company first', async () => {
  const eco = (await api('POST', '/api/delivery/companies', {
    name: 'Eco Back', provider: 'ecotrack', base_url: 'https://back.ecotrack.dz', api_token: 'T-BACK',
  })).body;
  const p = (await api('POST', '/api/products', { name: 'Back item', price: 1000, stock: 5, company_id: eco.id })).body;
  const stock = async () => (await api('GET', '/api/products')).body.find((x) => x.id === p.id).stock;

  const realFetch = globalThis.fetch;
  const calls = [];
  let refuse = false;
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (!u.hostname.endsWith('ecotrack.dz')) return realFetch(url, init);
    calls.push(`${init.method} ${u.pathname} ${u.searchParams.get('tracking') || ''}`.trim());
    if (refuse) return new Response(JSON.stringify({ success: false, message: 'colis déjà ramassé' }), { status: 422 });
    return new Response(JSON.stringify({ success: true, tracking: 'BK-1' }), { status: 200 });
  };
  try {
    const o = (await api('POST', '/api/orders', { product_id: p.id, customer_name: 'B', phone: '0551117777', wilaya_code: 16 })).body;
    const sent = (await api('POST', `/api/orders/${o.id}/action`, { action: 'confirm' })).body;
    assert.equal(sent.status, 'dispatched');
    assert.equal(await stock(), 4);

    refuse = true;
    const no = await api('POST', `/api/orders/${o.id}/back`, {});
    assert.equal(no.status, 409);
    assert.match(no.body.error, /ramassé/);
    assert.equal((await api('GET', `/api/orders/${o.id}`)).body.status, 'dispatched');

    refuse = false;
    const back = (await api('POST', `/api/orders/${o.id}/back`, {})).body;
    assert.deepEqual([back.status, back.tracking, back.stock_reserved], ['new', null, false]);
    assert.equal(await stock(), 5);
    assert.ok(calls.includes('DELETE /api/v1/delete/order BK-1'));

    // Confirmed but not sent (auto send off): back without calling the company.
    await api('PUT', '/api/delivery/routes', { auto_dispatch: false });
    await api('POST', `/api/orders/${o.id}/action`, { action: 'confirm' });
    const n = calls.length;
    assert.equal((await api('POST', `/api/orders/${o.id}/back`, {})).body.status, 'new');
    assert.equal(calls.length, n);
  } finally {
    globalThis.fetch = realFetch;
    await api('PUT', '/api/delivery/routes', { auto_dispatch: true });
  }
});

test('LightFunnels products missing from the ERP were added, existing ones left as they were', async () => {
  const products = (await api('GET', '/api/products')).body;
  const added = products.find((p) => p.name === 'peignoir femme importation avec brodé');
  assert.equal(added.price, 2500);
  assert.equal(added.store_id, null);
  const existing = products.find((p) => p.name === 'Robe très classe ✨');
  assert.equal(existing.price, 0);
  assert.equal(products.filter((p) => p.name === 'Pyjama stitch cute').length, 1);
});

test('product accounting: sales minus every expense, auto, default and manual lines', async () => {
  const sb = (await api('POST', '/api/delivery/companies', { name: 'Compta Express', provider: 'sandbox' })).body;
  await api('PUT', '/api/delivery/routes', { default_company_id: sb.id, routes: [] });
  const p = (await api('POST', '/api/products', { name: 'Compta item', price: 500, cost: 100, stock: 10 })).body;
  const mk = async (quantity, phone) => (await api('POST', '/api/orders', { product_id: p.id, customer_name: 'C', phone, wilaya_code: 16, quantity })).body;
  const [a, b, c] = [await mk(2, '0551110101'), await mk(1, '0551110102'), await mk(1, '0551110103')];
  for (const o of [a, b, c]) assert.equal((await api('POST', `/api/orders/${o.id}/action`, { action: 'confirm' })).body.status, 'dispatched');
  await api('POST', `/api/orders/${a.id}/action`, { action: 'delivered' });
  await api('POST', `/api/orders/${b.id}/action`, { action: 'returned' });

  const row = async () => (await api('GET', '/api/accounting')).body.products.find((x) => x.id === p.id);
  const line = (r, key) => r.lines.find((l) => l.key === key);

  // Nothing priced yet: only the purchase counts, and the missing prices are listed.
  let r = await row();
  assert.equal(r.revenue, 1000);
  assert.equal(line(r, 'purchase').amount, 1000);
  assert.equal(line(r, 'purchase').qty, 10, 'batch = stock left + pieces out');
  assert.ok(r.missing.includes('التأكيد'));
  assert.equal(r.profit, 0);

  await api('PUT', '/api/accounting/defaults', { packaging: 5, labels: 2, confirmation: 50, tracking: 10, fx_rate: 250 });
  r = await row();
  // Packed and labelled once per parcel sent, the return included.
  assert.equal(line(r, 'packaging').amount, 15);
  assert.equal(line(r, 'labels').amount, 6);
  assert.equal(line(r, 'return_packaging'), undefined);
  assert.equal(line(r, 'confirmation').amount, 150, 'confirmed orders, the returned one included');
  assert.equal(line(r, 'tracking').amount, 30);
  assert.equal(r.expenses, 1201);
  assert.equal(r.profit, -201);
  assert.equal(r.state, 'selling');
  assert.equal(r.stock, 6, 'the return is still on its way');
  assert.equal(r.left_value, 600, 'pieces in hand at the purchase price');
  assert.equal(r.returning_value, 100);
  assert.deepEqual(
    { ...r.pieces },
    { bought: null, in_hand: 6, reserved: 0, at_company: 1, out_for_delivery: 0, delivered: 2, returning: 1, returned_back: 0, expected_in_hand: null },
  );

  // Manual values: this product's own confirmation price, ads in dollars, an extra expense, sales stopped.
  await api('PUT', `/api/accounting/products/${p.id}`, { confirmation: 40, ads_usd: 2, selling: false, transport_office: 300 });
  await api('POST', `/api/accounting/products/${p.id}/expenses`, { name: 'Bache', amount: 100 });
  r = await row();
  assert.equal(line(r, 'confirmation').amount, 120);
  assert.equal(line(r, 'confirmation').mode, 'manual');
  assert.equal(line(r, 'ads').amount, 500);
  assert.equal(line(r, 'transport_office').amount, 300);
  assert.equal(r.expenses, 1000 + 15 + 6 + 120 + 30 + 500 + 300 + 100);
  assert.equal(r.state, 'loss');
  const expense = r.lines.find((l) => l.expense_id);
  await api('DELETE', `/api/accounting/expenses/${expense.expense_id}`);
  assert.equal((await row()).lines.some((l) => l.expense_id), false);
  assert.equal((await api('PUT', `/api/accounting/products/${p.id}`, { packaging: -1 })).status, 400);
});

test('purchases: quantity and price bought, and where every piece is now', async () => {
  const sb = (await api('POST', '/api/delivery/companies', { name: 'Stock Express', provider: 'sandbox' })).body;
  await api('PUT', '/api/delivery/routes', { default_company_id: sb.id, routes: [] });
  // 5 pieces of an older batch are already counted in the stock.
  const p = (await api('POST', '/api/products', { name: 'Stock item', price: 2000, cost: 0, stock: 5 })).body;
  assert.equal((await api('POST', `/api/accounting/products/${p.id}/purchases`, { quantity: 10, unit_price: 800 })).status, 201);
  // That older batch is recorded for its cost only.
  await api('POST', `/api/accounting/products/${p.id}/purchases`, { quantity: 5, unit_price: 700, add_to_stock: false, bought_on: '2026-10-01' });
  const prod = async () => (await api('GET', '/api/products')).body.find((x) => x.id === p.id);
  assert.equal((await prod()).stock, 15);
  assert.equal((await prod()).cost, 700, 'purchase price follows the last purchase');

  const mk = async (phone) => (await api('POST', '/api/orders', { product_id: p.id, customer_name: 'S', phone, wilaya_code: 16 })).body;
  const [a, b, c, d] = [await mk('0551220101'), await mk('0551220102'), await mk('0551220103'), await mk('0551220104')];
  for (const o of [a, b, c]) await api('POST', `/api/orders/${o.id}/action`, { action: 'confirm' });
  await api('PUT', '/api/delivery/routes', { auto_dispatch: false });
  await api('POST', `/api/orders/${d.id}/action`, { action: 'confirm' });
  await api('PUT', '/api/delivery/routes', { auto_dispatch: true });
  await api('POST', `/api/orders/${a.id}/action`, { action: 'delivered' });
  await api('POST', `/api/orders/${b.id}/action`, { action: 'returned' });

  const row = async () => (await api('GET', '/api/accounting')).body.products.find((x) => x.id === p.id);
  let r = await row();
  const purchase = r.lines.find((l) => l.key === 'purchase');
  assert.equal(purchase.amount, 10 * 800 + 5 * 700);
  assert.equal(purchase.qty, 15);
  assert.deepEqual({ ...r.pieces }, {
    bought: 15, in_hand: 12, reserved: 1, at_company: 1, out_for_delivery: 0, delivered: 1, returning: 1, returned_back: 0, expected_in_hand: 12,
  });
  await api('POST', `/api/orders/${b.id}/action`, { action: 'return_received' });
  r = await row();
  assert.equal(r.pieces.in_hand, 13);
  assert.equal(r.pieces.expected_in_hand, 13);
  assert.equal(r.pieces.returned_back, 1);

  await api('DELETE', `/api/accounting/purchases/${r.purchases.find((x) => x.quantity === 10).id}`);
  assert.equal((await prod()).stock, 2, 'deleting a purchase that was added to stock takes it back out');
  assert.equal((await api('POST', `/api/accounting/products/${p.id}/purchases`, { quantity: 0, unit_price: 5 })).status, 400);
});

test('new products start in the TEST store with the TEST company, until moved', async () => {
  const stores = (await api('GET', '/api/stores')).body;
  const testStore = stores.find((s) => s.name === 'TEST');
  assert.equal(testStore.company_name, 'TEST');
  assert.equal((await api('PUT', '/api/stores/new-products', { store_id: testStore.id })).status, 200);
  assert.equal((await api('GET', '/api/stores')).body.find((s) => s.id === testStore.id).new_products, true);

  const p = (await api('POST', '/api/products', { name: 'Produit en test', price: 1000 })).body;
  assert.equal(p.store_id, testStore.id);
  const other = stores.find((s) => s.name === 'YACINE');
  const chosen = (await api('POST', '/api/products', { name: 'Produit direct', price: 1000, store_id: other.id })).body;
  assert.equal(chosen.store_id, other.id, 'a store picked by hand is kept');

  const o = (await api('POST', '/api/orders', { product_id: p.id, customer_name: 'T', phone: '0551330101', wilaya_code: 16 })).body;
  assert.equal((await api('GET', `/api/orders/${o.id}`)).body.company_name, 'TEST');
  // Moved to a real store once the test works: its open order follows.
  await api('PUT', `/api/products/${p.id}/store`, { store_id: other.id });
  assert.notEqual((await api('GET', `/api/orders/${o.id}`)).body.company_name, 'TEST');

  await api('PUT', '/api/stores/new-products', { store_id: '' });
  assert.equal((await api('POST', '/api/products', { name: 'Sans boutique', price: 1 })).body.store_id, null);
});

test('statistics pages: confirmation and delivery, filtered by store', async () => {
  const sb = (await api('POST', '/api/delivery/companies', { name: 'Stats Express', provider: 'sandbox' })).body;
  const store = (await api('POST', '/api/stores', { name: 'BOUTIQUE STATS', company_id: sb.id })).body;
  const p = (await api('POST', '/api/products', { name: 'Stats item', price: 1000, stock: 20, store_id: store.id })).body;
  const mk = async (phone) => (await api('POST', '/api/orders', { product_id: p.id, customer_name: 'S', phone, wilaya_code: 16 })).body;
  const orders = [];
  for (let i = 0; i < 5; i += 1) orders.push(await mk(`055144010${i}`));
  await api('POST', `/api/orders/${orders[0].id}/action`, { action: 'confirm' });
  await api('POST', `/api/orders/${orders[1].id}/action`, { action: 'confirm' });
  await api('POST', `/api/orders/${orders[2].id}/action`, { action: 'cancel' });
  await api('POST', `/api/orders/${orders[3].id}/action`, { action: 'no_answer' });
  await api('POST', `/api/orders/${orders[0].id}/action`, { action: 'delivered' });
  await api('POST', `/api/orders/${orders[1].id}/action`, { action: 'returned' });

  const c = (await api('GET', `/api/stats/confirmation?store_id=${store.id}`)).body;
  assert.deepEqual([c.orders, c.confirmed, c.cancelled, c.failed, c.pending], [5, 2, 1, 1, 1]);
  assert.equal(c.rate, 66.7);
  assert.equal(c.team[0].username, 'admin');
  assert.equal(c.team[0].confirmed, 2);

  const d = (await api('GET', `/api/stats/delivery?store_id=${store.id}`)).body;
  assert.deepEqual([d.shipped, d.delivered, d.returning, d.rate], [2, 1, 1, 50]);
  assert.equal(d.companies[0].name, 'Stats Express');

  const other = (await api('GET', '/api/stats/confirmation?store_id=999999')).body;
  assert.equal(other.orders, 0);
  assert.equal((await api('GET', '/api/stats/other')).status, 404);
});

test('each account sees only the pages ticked for it', async () => {
  const p = (await api('POST', '/api/products', { name: 'Perm item', price: 1000, stock: 5 })).body;
  const o = (await api('POST', '/api/orders', { product_id: p.id, customer_name: 'P', phone: '0551550101', wilaya_code: 16 })).body;
  assert.equal((await api('POST', '/api/users', { username: 'empty', password: 'secret1', role: 'agent', permissions: [] })).status, 400);
  assert.equal((await api('POST', '/api/users', { username: 'conf', password: 'secret1', role: 'agent', permissions: ['confirm', 'nonsense'] })).status, 201);
  await api('POST', '/api/users', { username: 'suivi', password: 'secret1', role: 'agent', permissions: ['tracking'] });
  await api('POST', '/api/users', { username: 'compta', password: 'secret1', role: 'agent', permissions: ['accounting', 'stats'] });
  const users = (await api('GET', '/api/users')).body.users;
  assert.deepEqual(users.find((u) => u.username === 'conf').permissions, ['confirm']);
  await api('POST', '/api/orders/assign', { ids: [o.id], user_id: users.find((u) => u.username === 'conf').id });

  const as = async (username) => api('POST', '/api/auth/login', { username, password: 'secret1' });
  await as('conf');
  assert.deepEqual((await api('GET', '/api/auth/me')).body.permissions, ['confirm']);
  assert.ok((await api('GET', '/api/orders?status=new')).body.rows.some((x) => x.id === o.id));
  assert.equal((await api('GET', '/api/orders?status=delivered')).body.total, 0, 'tracking orders stay hidden');
  assert.equal((await api('GET', '/api/accounting')).status, 403);
  assert.equal((await api('GET', '/api/stats')).status, 403);
  assert.equal((await api('GET', '/api/users')).status, 403);
  await api('PUT', '/api/delivery/routes', {}).then((r) => assert.equal(r.status, 403));
  const confirmed = (await api('POST', `/api/orders/${o.id}/action`, { action: 'confirm' })).body;
  assert.ok(['confirmed', 'dispatched'].includes(confirmed.status));
  assert.equal((await api('POST', `/api/orders/${o.id}/action`, { action: 'delivered' })).status, 403);

  await as('suivi');
  assert.equal((await api('POST', '/api/orders', { product_id: p.id, customer_name: 'X', phone: '0551550102', wilaya_code: 16 })).status, 403);
  assert.ok((await api('GET', `/api/orders/${o.id}`)).status === 200);

  await as('compta');
  assert.equal((await api('GET', '/api/accounting')).status, 200);
  assert.equal((await api('GET', '/api/stats/confirmation')).status, 200);
  assert.equal((await api('GET', '/api/orders')).status, 403);

  await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  const conf = users.find((u) => u.username === 'conf');
  await api('PUT', `/api/users/${conf.id}/permissions`, { role: 'agent', permissions: ['confirm', 'stats'] });
  assert.deepEqual((await api('GET', '/api/users')).body.users.find((u) => u.id === conf.id).permissions, ['confirm', 'stats']);
});

test('one order, several products in one parcel', async () => {
  const sb = (await api('POST', '/api/delivery/companies', { name: 'Multi Express', provider: 'sandbox' })).body;
  await api('PUT', '/api/delivery/routes', { default_company_id: sb.id, routes: [] });
  const a = (await api('POST', '/api/products', { name: 'Multi A', price: 2000, stock: 10 })).body;
  const b = (await api('POST', '/api/products', { name: 'Multi B', price: 1500, stock: 10 })).body;
  const stock = async (id) => (await api('GET', '/api/products')).body.find((p) => p.id === id).stock;

  let o = (await api('POST', '/api/orders', {
    product_id: a.id, quantity: 1, customer_name: 'M', phone: '0551660101', wilaya_code: 16, delivery_fee: 400,
    items: [{ product_id: b.id, quantity: 2 }],
  })).body;
  assert.equal(o.items.length, 1);
  assert.equal(o.items[0].product_name, 'Multi B');
  assert.equal(o.total, 2000 + 2 * 1500 + 400);
  assert.equal((await api('GET', '/api/orders?status=new')).body.rows.find((x) => x.id === o.id).items.length, 1);

  // Changing the extra products while still open.
  o = (await api('PUT', `/api/orders/${o.id}`, { items: [{ product_id: b.id, quantity: 1, unit_price: 1000 }] })).body;
  assert.equal(o.total, 2000 + 1000 + 400);

  o = (await api('POST', `/api/orders/${o.id}/action`, { action: 'confirm' })).body;
  assert.equal(o.status, 'dispatched');
  assert.equal(await stock(a.id), 9);
  assert.equal(await stock(b.id), 9, 'the extra product leaves the stock too');
  assert.equal((await api('PUT', `/api/orders/${o.id}`, { items: [] })).status, 409);

  await api('POST', `/api/orders/${o.id}/action`, { action: 'delivered' });
  const acc = (await api('GET', '/api/accounting')).body.products;
  assert.equal(acc.find((p) => p.id === a.id).revenue, 2000);
  assert.equal(acc.find((p) => p.id === b.id).revenue, 1000, 'each product gets its own sales');
  const tracking = (x) => x.lines.find((l) => l.key === 'tracking').qty;
  assert.equal(tracking(acc.find((p) => p.id === a.id)), 1);
  assert.equal(tracking(acc.find((p) => p.id === b.id)), 0, 'one parcel, counted once');

  // A second one cancelled after confirmation gives both products back.
  await api('PUT', '/api/delivery/routes', { auto_dispatch: false });
  const c = (await api('POST', '/api/orders', {
    product_id: a.id, customer_name: 'N', phone: '0551660102', wilaya_code: 16, items: [{ product_id: b.id, quantity: 3 }],
  })).body;
  await api('POST', `/api/orders/${c.id}/action`, { action: 'confirm' });
  assert.equal(await stock(b.id), 6);
  await api('POST', `/api/orders/${c.id}/action`, { action: 'cancel' });
  assert.equal(await stock(a.id), 9);
  assert.equal(await stock(b.id), 9);
  await api('PUT', '/api/delivery/routes', { auto_dispatch: true });
});

test('an accountant sees the profit of the stores ticked for them only', async () => {
  const s1 = (await api('POST', '/api/stores', { name: 'COMPTA UN' })).body;
  const s2 = (await api('POST', '/api/stores', { name: 'COMPTA DEUX' })).body;
  const p1 = (await api('POST', '/api/products', { name: 'Compta P1', price: 100, store_id: s1.id })).body;
  const p2 = (await api('POST', '/api/products', { name: 'Compta P2', price: 100, store_id: s2.id })).body;
  assert.equal((await api('POST', '/api/users', {
    username: 'compta1', password: 'secret1', role: 'agent', permissions: ['accounting'], accounting_store_ids: [s1.id],
  })).status, 201);
  const u = (await api('GET', '/api/users')).body.users.find((x) => x.username === 'compta1');
  assert.deepEqual(u.accounting_store_ids, [s1.id]);

  await api('POST', '/api/auth/login', { username: 'compta1', password: 'secret1' });
  const ids = (await api('GET', '/api/accounting')).body.products.map((p) => p.id);
  assert.ok(ids.includes(p1.id));
  assert.ok(!ids.includes(p2.id), 'other stores stay hidden');
  assert.equal((await api('PUT', `/api/accounting/products/${p1.id}`, { creative: 500 })).status, 200);
  assert.equal((await api('PUT', `/api/accounting/products/${p2.id}`, { creative: 500 })).status, 403);
  assert.equal((await api('POST', `/api/accounting/products/${p2.id}/purchases`, { quantity: 1, unit_price: 1 })).status, 403);
  assert.equal((await api('PUT', '/api/accounting/defaults', { confirmation: 1 })).status, 403);

  await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  await api('PUT', `/api/users/${u.id}/permissions`, { role: 'agent', permissions: ['accounting'], accounting_store_ids: [] });
  await api('POST', '/api/auth/login', { username: 'compta1', password: 'secret1' });
  assert.ok((await api('GET', '/api/accounting')).body.products.some((p) => p.id === p2.id), 'no store ticked = every store');
  await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
});

test('orders are given to agents; failed twice, they go to the product\'s second agent (still الفاشلة 2)', async () => {
  const p = (await api('POST', '/api/products', { name: 'Assign item', price: 1000, stock: 5 })).body;
  await api('POST', '/api/users', { username: 'sara', password: 'secret1', role: 'agent', permissions: ['confirm'] });
  await api('POST', '/api/users', { username: 'amina', password: 'secret1', role: 'agent', permissions: ['confirm'] });
  const users = (await api('GET', '/api/users')).body.users;
  const sara = users.find((u) => u.username === 'sara');
  const amina = users.find((u) => u.username === 'amina');
  const mk = async (phone) => (await api('POST', '/api/orders', { product_id: p.id, customer_name: 'A', phone, wilaya_code: 16 })).body;
  const [o1, o2, o3] = [await mk('0551770201'), await mk('0551770202'), await mk('0551770203')];
  // No second agent on this product: a failed order stays with its agent.
  const lone = (await api('POST', '/api/products', { name: 'Lone item', price: 1000, stock: 5 })).body;
  const o4 = (await api('POST', '/api/orders', { product_id: lone.id, customer_name: 'A', phone: '0551770204', wilaya_code: 16 })).body;
  await api('POST', '/api/orders/assign', { ids: [o4.id], user_id: sara.id });
  for (let i = 0; i < 2; i++) await api('POST', `/api/orders/${o4.id}/action`, { action: 'no_answer' });
  assert.equal((await api('GET', `/api/orders/${o4.id}`)).body.assigned_to, sara.id);
  await api('POST', '/api/orders/assign', { ids: [o4.id], user_id: null });
  assert.equal((await api('PUT', `/api/products/${p.id}/store`, { backup_agent_id: amina.id })).status, 200);
  // Chain: the order with sara goes to the second agent (amina), then to the third (nour).
  await api('POST', '/api/users', { username: 'nour', password: 'secret1', role: 'agent', permissions: ['confirm'] });
  const nour = (await api('GET', '/api/users')).body.users.find((u) => u.username === 'nour');
  await api('PUT', `/api/products/${lone.id}/store`, { backup_agent_id: amina.id, third_agent_id: nour.id });
  const o5 = (await api('POST', '/api/orders', { product_id: lone.id, customer_name: 'A', phone: '0551770205', wilaya_code: 16 })).body;
  await api('POST', '/api/orders/assign', { ids: [o5.id], user_id: sara.id });
  const holders = [];
  for (let i = 0; i < 6; i++) {
    await api('POST', `/api/orders/${o5.id}/action`, { action: 'no_answer' });
    holders.push((await api('GET', `/api/orders/${o5.id}`)).body.assigned_to);
  }
  assert.deepEqual(holders, [sara.id, amina.id, amina.id, nour.id, nour.id, nour.id]);
  await api('DELETE', `/api/orders/${o5.id}`);
  assert.equal((await api('POST', '/api/orders/assign', { ids: [o1.id, o2.id], user_id: sara.id })).body.assigned, 2);
  assert.equal((await api('GET', `/api/orders?assigned_to=${sara.id}`)).body.total, 2);
  assert.ok((await api('GET', '/api/orders?assigned_to=none')).body.rows.some((x) => x.id === o3.id));
  assert.equal((await api('GET', '/api/orders/agents')).body.auto_transfer_after, 2);

  const as = (username) => api('POST', '/api/auth/login', { username, password: 'secret1' });
  await as('sara');
  let mine = (await api('GET', '/api/orders?status=new,no_answer,postponed')).body.rows.map((x) => x.id);
  assert.deepEqual(mine.sort(), [o1.id, o2.id].sort(), 'an agent sees only her orders');
  assert.equal((await api('GET', `/api/orders/${o3.id}`)).status, 403);
  assert.equal((await api('POST', '/api/orders/assign', { ids: [o1.id], user_id: sara.id })).status, 403);

  await api('POST', `/api/orders/${o1.id}/action`, { action: 'no_answer' });
  let r = await api('GET', `/api/orders/${o1.id}`);
  assert.equal(r.body.status, 'no_answer');
  await api('POST', `/api/orders/${o1.id}/action`, { action: 'no_answer' });
  assert.equal((await api('GET', `/api/orders/${o1.id}`)).status, 403, 'gone to the other agent');

  await as('amina');
  r = (await api('GET', `/api/orders/${o1.id}`)).body;
  assert.equal(r.status, 'no_answer', 'it stays failed (الفاشلة 2) for the next agent');
  assert.equal(r.call_attempts, 2);
  assert.equal(r.assigned_to, amina.id);
  assert.ok(r.events.some((e) => e.type === 'transferred'));
  assert.equal((await api('GET', '/api/orders/counts')).body.by_status.failed_2, 1);
  assert.deepEqual((await api('GET', '/api/orders?status=failed_2')).body.rows.map((x) => x.id), [o1.id]);
  assert.equal((await api('GET', '/api/orders?status=failed_1')).body.total, 0);
  await api('POST', `/api/orders/${o1.id}/action`, { action: 'no_answer' });
  assert.equal((await api('GET', '/api/orders?status=failed_3')).body.total, 1, 'الفاشلة 3 stays with amina');
  await api('POST', `/api/orders/${o1.id}/action`, { action: 'no_answer' });
  assert.equal((await api('GET', `/api/orders/${o1.id}`)).body.assigned_to, amina.id, 'no third agent: stays with amina');
  await api('POST', `/api/orders/${o1.id}/action`, { action: 'unfail' });
  await api('POST', `/api/orders/${o1.id}/action`, { action: 'set_failed', attempts: 1 });
  assert.equal((await api('GET', `/api/orders/${o1.id}`)).body.call_attempts, 1, 'back to الفاشلة 1');
  assert.equal((await api('POST', `/api/orders/${o1.id}/action`, { action: 'set_failed', attempts: 9 })).status, 400);
  await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  await api('POST', `/api/orders/${o1.id}/action`, { action: 'no_answer' });
  await api('POST', `/api/orders/${o1.id}/action`, { action: 'unfail' });
  assert.equal((await api('GET', `/api/orders/${o1.id}`)).body.call_attempts, 1, '-1: الفاشلة 2 back to 1');
  await api('POST', `/api/orders/${o1.id}/action`, { action: 'unfail' });
  assert.equal((await api('GET', `/api/orders/${o1.id}`)).body.status, 'new', '-1 on الفاشلة 1: new');

  await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  const team = (await api('GET', '/api/stats/confirmation')).body.team;
  assert.equal(team.find((t) => t.username === 'sara').failed, 1, 'still failed for sara');

  // The admin moves a failed one by hand, as a new order.
  await as('sara');
  await api('POST', `/api/orders/${o2.id}/action`, { action: 'no_answer' });
  await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  await api('POST', '/api/orders/assign', { ids: [o2.id], user_id: amina.id, as_new: true });
  r = (await api('GET', `/api/orders/${o2.id}`)).body;
  assert.deepEqual([r.status, r.call_attempts, r.assigned_to], ['new', 0, amina.id]);
  await api('PUT', '/api/orders/agents', { auto_transfer_after: 0 });
  assert.equal((await api('GET', '/api/orders/agents')).body.auto_transfer_after, 0);
});

test('LightFunnels app: signed webhooks import orders once, bad ones are kept with the reason', async () => {
  const crypto = await import('node:crypto');
  process.env.LF_CLIENT_ID = 'test-client';
  process.env.LF_CLIENT_SECRET = 'test-secret';
  await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  const store = (await api('POST', '/api/stores', { name: 'Boutique LF Probe' })).body;
  const link = (await api('POST', '/api/lightfunnels', { name: 'compte test', store_id: store.id })).body;
  const list = (await api('GET', '/api/lightfunnels')).body;
  assert.equal(list.configured, true);
  assert.deepEqual(list.missing, []);
  assert.equal(list.links[0].connected, false);

  const send = (topic, payload, { sign = true } = {}) => {
    const raw = JSON.stringify(payload);
    const mac = crypto.createHmac('sha256', 'test-secret').update(raw).digest('base64');
    return fetch(`${base}/api/public/lightfunnels/${link.id}/${topic}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(sign ? { 'lightfunnels-hmac': mac } : {}) }, body: raw,
    });
  };
  const node = (extra = {}) => ({
    node: {
      id: 'order_abc', _id: 4101, name: '#LF4101', total: 4900, subtotal: 4400, shipping: 500, test: false,
      customer: { full_name: 'Client Test' },
      shipping_address: { first_name: 'Client', last_name: 'Test', phone: '0551990011', address1: 'Rue 1', city: 'Bab Ezzouar', state: 'Alger' },
      items: [{ title: 'LF Probe Item', price: 2200, quantity: 2 }],
      ...extra,
    },
  });

  assert.equal((await send('created', node(), { sign: false })).status, 403, 'unsigned calls are refused');
  assert.equal((await send('created', node())).status, 200);
  let orders = (await api('GET', '/api/orders?q=0551990011')).body.rows;
  assert.equal(orders.length, 1);
  assert.deepEqual([orders[0].source, orders[0].quantity, orders[0].unit_price, orders[0].delivery_fee, orders[0].total, orders[0].wilaya_code],
    ['lightfunnels', 2, 2200, 500, 4900, 16]);
  assert.equal(orders[0].store_name, 'Boutique LF Probe');

  // The same order again: nothing new. "confirmed" brings the upsell and fills the untouched order.
  await send('created', node());
  assert.equal((await api('GET', '/api/orders?q=0551990011')).body.total, 1);
  const upsell = node();
  upsell.node.items.push({ title: 'LF Probe Upsell', price: 900, quantity: 1 });
  upsell.node.total = 5800;
  await send('confirmed', upsell);
  orders = (await api('GET', '/api/orders?q=0551990011')).body.rows;
  assert.equal(orders.length, 1);
  assert.equal(orders[0].items.length, 1);
  assert.equal(orders[0].total, 5800);

  // Unreadable orders (unknown wilaya) are not lost: the event keeps the reason.
  const bad = node({ _id: 4102, id: 'order_bad', shipping_address: { first_name: 'A', phone: '0551990022', state: 'Nowhere' } });
  assert.equal((await send('created', bad)).status, 200);
  assert.equal((await api('GET', '/api/orders?q=0551990022')).body.total, 0);
  const events = (await api('GET', '/api/lightfunnels')).body.events;
  assert.ok(events.some((e) => e.status === 'error' && /ولاية/.test(e.error)));
  assert.ok(events.some((e) => e.status === 'imported'));
  // A test order from LightFunnels is ignored.
  await send('created', node({ _id: 4103, id: 'order_test', test: true }));
  assert.equal((await api('GET', '/api/orders?q=0551990011')).body.total, 1);

  // The connect link points at LightFunnels with a signed state.
  const res = await fetch(`${base}/api/lightfunnels/${link.id}/connect`, { redirect: 'manual', headers: { cookie } });
  const loc = new URL(res.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, 'https://app.lightfunnels.com/admin/oauth');
  assert.equal(loc.searchParams.get('client_id'), 'test-client');
  assert.equal(loc.searchParams.get('scope'), 'orders,products,stores');
  delete process.env.LF_CLIENT_ID;
  delete process.env.LF_CLIENT_SECRET;
});

test('"update orders" button: pulls the latest LightFunnels orders that webhooks did not bring', async () => {
  process.env.LF_CLIENT_ID = 'test-client';
  process.env.LF_CLIENT_SECRET = 'test-secret';
  await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  const { id } = (await api('POST', '/api/lightfunnels', { name: 'compte pull' })).body;
  await db.run("UPDATE lightfunnels_links SET access_token = 'tok', expires_at = now() + interval '1 hour' WHERE id = ?", id);
  const kinds = {
    Order: { id: 'ID', _id: 'Int', name: 'String', total: 'Float', shipping: 'Float', test: 'Boolean', date: 'String', customer: 'Customer', shipping_address: 'Address', items: 'OrderItem' },
    Customer: { full_name: 'String' },
    Address: { first_name: 'String', phone: 'String', address1: 'String', city: 'String', state: 'String' },
    OrderItem: { title: 'String', price: 'Float', qty: 'Int' },
  };
  const real = globalThis.fetch;
  let ordersQuery = '';
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://services.lightfunnels.com')) return real(url, init);
    const { query, variables } = JSON.parse(init.body);
    if (query.includes('__type')) {
      const fields = Object.entries(kinds[variables.n]).map(([name, t]) => ({ name,
        type: { name: kinds[t] ? t : t, kind: kinds[t] ? 'OBJECT' : 'SCALAR', ofType: null } }));
      return Response.json({ data: { __type: { fields } } });
    }
    ordersQuery = query;
    return Response.json({ data: { orders: { edges: [{ node: {
      id: 'order_pull', _id: 5001, name: '#LF5001', total: 3100, shipping: 600, test: false, date: '2026-10-30T10:00:00Z',
      customer: { full_name: 'Pull Client' },
      shipping_address: { first_name: 'Pull', phone: '0551990033', address1: 'Rue 2', city: 'Oran', state: 'Oran' },
      items: [{ title: 'LF Pull Item', price: 2500, qty: 1 }],
    } }] } } });
  };
  try {
    const r = (await api('POST', '/api/orders/pull')).body;
    assert.equal(r.lightfunnels, 1);
    assert.deepEqual(r.lightfunnels_errors, []);
    assert.match(ordersQuery, /shipping_address \{ first_name phone address1 city state \}/);
    const found = (await api('GET', '/api/orders?q=0551990033')).body.rows;
    assert.equal(found.length, 1);
    assert.equal(found[0].wilaya_code, 31);
    assert.equal((await api('POST', '/api/orders/pull')).body.lightfunnels, 0, 'the same order is not imported twice');
  } finally {
    globalThis.fetch = real;
    delete process.env.LF_CLIENT_ID;
    delete process.env.LF_CLIENT_SECRET;
  }
});

test('LightFunnels checkouts: unfinished ones become abandoned orders, finished ones replace them', async () => {
  const crypto = await import('node:crypto');
  process.env.LF_CLIENT_ID = 'test-client';
  process.env.LF_CLIENT_SECRET = 'test-secret';
  await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  const link = (await api('POST', '/api/lightfunnels', { name: 'compte checkout' })).body;
  const send = (topic, node) => {
    const raw = JSON.stringify({ node });
    const mac = crypto.createHmac('sha256', 'test-secret').update(raw).digest('base64');
    return fetch(`${base}/api/public/lightfunnels/${link.id}/${topic}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'lightfunnels-hmac': mac }, body: raw });
  };
  const checkout = (extra = {}) => ({
    id: 'checkout_1', _id: 7001,
    shipping_address: { first_name: 'Aban', phone: '0551990044', city: 'Oran', state: 'Oran' },
    items: [{ title: 'LF Checkout Item', price: 1800, quantity: 1 }],
    ...extra,
  });
  // Still being filled in: nothing yet.
  assert.equal((await send('checkout', checkout({ shipping_address: {} }))).status, 200);
  assert.equal((await api('GET', '/api/orders?q=0551990044')).body.total, 0);
  // Complete contact details: one abandoned order, however many updates follow.
  await send('checkout', checkout());
  await send('checkout', checkout());
  let found = (await api('GET', '/api/orders?q=0551990044')).body.rows;
  assert.equal(found.length, 1);
  assert.equal(found[0].source, 'abandoned');
  assert.equal(found[0].status, 'new');
  // The customer then orders: the abandoned copy is replaced by the real order.
  await send('created', { id: 'order_after', _id: 7002, name: '#LF7002', total: 2300, shipping: 500, test: false,
    shipping_address: { first_name: 'Aban', phone: '0551990044', city: 'Oran', state: 'Oran' },
    items: [{ title: 'LF Checkout Item', price: 1800, quantity: 1 }] });
  found = (await api('GET', '/api/orders?q=0551990044')).body.rows;
  assert.deepEqual(found.map((o) => o.source), ['lightfunnels']);
  // A checkout arriving after the real order is ignored.
  await send('checkout', checkout({ id: 'checkout_2', _id: 7003 }));
  assert.equal((await api('GET', '/api/orders?q=0551990044')).body.total, 1);
  delete process.env.LF_CLIENT_ID;
  delete process.env.LF_CLIENT_SECRET;
});

test('only the admin changes the main product of an order; an agent can add another product', async () => {
  await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  const a = (await api('POST', '/api/products', { name: 'Main one', price: 1000, stock: 5 })).body;
  const b = (await api('POST', '/api/products', { name: 'Other one', price: 700, stock: 5 })).body;
  await api('POST', '/api/users', { username: 'hamid', password: 'secret1', role: 'agent', permissions: ['confirm'] });
  const hamid = (await api('GET', '/api/users')).body.users.find((u) => u.username === 'hamid');
  const o = (await api('POST', '/api/orders', { product_id: a.id, customer_name: 'A', phone: '0551880301', wilaya_code: 16 })).body;
  await api('POST', '/api/orders/assign', { ids: [o.id], user_id: hamid.id });
  await api('POST', '/api/auth/login', { username: 'hamid', password: 'secret1' });
  assert.equal((await api('PUT', `/api/orders/${o.id}`, { product_id: b.id })).status, 403);
  assert.equal((await api('PUT', `/api/orders/${o.id}`, { product_id: a.id, quantity: 2 })).status, 200, 'same product is fine');
  const added = await api('PUT', `/api/orders/${o.id}`, { items: [{ product_id: b.id, quantity: 1 }] });
  assert.equal(added.status, 200);
  assert.equal(added.body.items.length, 1);
  await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  assert.equal((await api('PUT', `/api/orders/${o.id}`, { product_id: b.id })).status, 200, 'the admin can');
});
