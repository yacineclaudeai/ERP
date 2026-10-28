import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '@hono/node-server';
import { openLocalDb } from '../src/db-local.js';
import { createApp } from '../src/app.js';
import { parseCsv, parseSheetDate, parseSheetUrl, parseWilaya, suggestMapping } from '../src/services/sheets.js';

// The columns of a LightFunnels export, in its order.
const LF_HEADERS = ['Full Name', 'Phone', 'Address', 'Country', 'City', 'Product Name', 'Quantity', 'SKU', 'Funnel Name',
  'Order ID', 'Subtotal', 'Shipping Price', 'Order Total', 'Created At', 'Fulfillment Status', 'Shipping Method',
  'Shipping State', 'Shipping City', 'Item title'];
const HEADERS = ['Order ID', 'Full Name', 'Phone', 'Product Name', 'Quantity', 'Subtotal', 'Shipping Price',
  'Order Total', 'Shipping Method', 'Shipping State', 'Shipping City', 'Address'];
const toCsv = (rows) => rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
const csv = (rows) => toCsv([HEADERS, ...rows]);

// Google Sheets answers with the CSV of whichever sheet id the test put here.
const sheets = {};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const m = String(url).match(/docs\.google\.com\/spreadsheets\/d\/([^/]+)\/export/);
  if (!m) return realFetch(url, init);
  if (!sheets[m[1]]) return new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } });
  return new Response(sheets[m[1]], { headers: { 'content-type': 'text/csv' } });
};

let server, base, db, cookie = '';
async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null) };
}

before(async () => {
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'admin123';
  db = await openLocalDb();
  const app = createApp(db);
  server = await new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' })).status, 200);
});
after(async () => {
  globalThis.fetch = realFetch;
  server.close();
  await db.close();
});

test('csv, sheet links, wilayas and column guessing', () => {
  assert.deepEqual(parseCsv('a,"b, c"\n"x ""y""",2\r\n'), [['a', 'b, c'], ['x "y"', '2']]);
  assert.deepEqual(parseCsv('a,b\n1,"multi\nline"'), [['a', 'b'], ['1', 'multi\nline']]);
  const link = parseSheetUrl('https://docs.google.com/spreadsheets/d/AbC_12-x/edit#gid=345');
  assert.equal(link.csvUrl, 'https://docs.google.com/spreadsheets/d/AbC_12-x/export?format=csv&gid=345');
  assert.throws(() => parseSheetUrl('https://example.com'));
  assert.equal(parseWilaya('16 - Alger'), 16);
  assert.equal(parseWilaya('Bejaia'), 6);
  assert.equal(parseWilaya('وهران'), 31);
  assert.equal(parseWilaya('05'), 5);
  assert.equal(parseWilaya('Paris'), null);
  assert.deepEqual(suggestMapping(LF_HEADERS), {
    customer_name: 'Full Name', phone: 'Phone', product_name: 'Product Name', sku: 'SKU', external_id: 'Order ID',
    address: 'Address', delivery_type: 'Shipping Method', wilaya: 'Shipping State', commune: 'Shipping City',
    quantity: 'Quantity', subtotal: 'Subtotal', shipping_price: 'Shipping Price', total: 'Order Total',
    variant: 'Item title', created_at: 'Created At',
  });
  assert.equal(parseSheetDate('2026-06-25 16:51:00'), '2026-06-25T15:51:00.000Z');
  assert.equal(parseWilaya('Tizi-Ouzou'), 15);
  assert.equal(parseWilaya("M'Sila"), 28);
  assert.equal(parseWilaya('Bordj Bou Arreridj'), 34);
  assert.deepEqual(suggestMapping(HEADERS), {
    customer_name: 'Full Name', phone: 'Phone', product_name: 'Product Name', external_id: 'Order ID',
    delivery_type: 'Shipping Method', wilaya: 'Shipping State', commune: 'Shipping City', address: 'Address',
    quantity: 'Quantity', subtotal: 'Subtotal', shipping_price: 'Shipping Price', total: 'Order Total',
  });
});

test('LightFunnels sheet: new rows come in once, products are matched or created', async () => {
  const store = (await api('POST', '/api/stores', { name: 'yacine boutique' })).body;
  const watch = (await api('POST', '/api/products', { name: 'Montre Luxe', price: 3000, stock: 4, store_id: store.id })).body;
  const url = 'https://docs.google.com/spreadsheets/d/real-sheet/edit#gid=0';

  assert.equal((await api('POST', '/api/sheets/preview', { sheet_url: 'https://docs.google.com/spreadsheets/d/private/edit' })).status, 400);

  sheets['real-sheet'] = csv([
    ['#1001', 'Old Order', '0550000000', 'Montre Luxe', 1, 3000, 400, 3400, 'Home', '16 - Alger', 'Bab Ezzouar', ''],
  ]);
  const preview = (await api('POST', '/api/sheets/preview', { sheet_url: url })).body;
  assert.equal(preview.next_row, 3);
  assert.equal(preview.mapping.wilaya, 'Shipping State');

  // Start after the old order, like Ecotrack's "start from row".
  const { id } = (await api('POST', '/api/sheets', {
    name: 'yacine boutique', sheet_url: url, store_id: store.id, kind: 'real', mapping: preview.mapping, start_row: preview.next_row,
  })).body;

  sheets['real-sheet'] = csv([
    ['#1001', 'Old Order', '0550000000', 'Montre Luxe', 1, 3000, 400, 3400, 'Home', '16 - Alger', 'Bab Ezzouar', ''],
    ['#1002', 'Amine B', '+213 661 11 22 33', 'montre luxe', 2, 5800, 0, 5800, 'Stop desk', 'Oran', 'Bir El Djir', 'Cité 1'],
    ['#1003', 'Sara K', '770123456', 'Sac Cuir', 1, 2500, 500, 3000, 'Home', '06', 'Akbou', ''],
    ['#1004', 'Bad Row', '0550000001', 'Sac Cuir', 1, 2500, 500, 3000, 'Home', 'Paris', '', ''],
  ]);
  const first = (await api('POST', `/api/sheets/${id}/sync`)).body;
  assert.equal(first.imported, 2);
  assert.equal(first.errors.length, 1);
  assert.match(first.errors[0], /سطر 5/);

  const orders = (await api('GET', '/api/orders?status=new')).body.rows;
  const amine = orders.find((o) => o.customer_name === 'Amine B');
  assert.equal(amine.product_id, watch.id);
  assert.equal(amine.quantity, 2);
  assert.equal(amine.unit_price, 2900);
  assert.equal(amine.delivery_fee, 0);
  assert.equal(amine.total, 5800);
  assert.equal(amine.stop_desk, true);
  assert.equal(amine.wilaya_code, 31);
  assert.equal(amine.phone, '0661112233');
  const sara = orders.find((o) => o.customer_name === 'Sara K');
  assert.equal(sara.phone, '0770123456');
  assert.equal(sara.wilaya_code, 6);
  const bag = (await api('GET', '/api/products')).body.find((p) => p.name === 'Sac Cuir');
  assert.equal(bag.store_id, store.id);
  assert.equal(sara.product_id, bag.id);
  assert.equal(orders.some((o) => o.customer_name === 'Old Order'), false);

  // Next sync: only the newly added row.
  sheets['real-sheet'] += '\n' + csv([['#1005', 'Nadia M', '0555667788', 'Sac Cuir', 1, 2500, 500, 3000, 'Home', 'Blida', '', '']]).split('\n')[1];
  const second = (await api('POST', `/api/sheets/${id}/sync`)).body;
  assert.equal(second.imported, 1);

  // Moving the start row back never imports a row twice.
  const sheet = (await api('GET', '/api/sheets')).body.find((g) => g.id === id);
  assert.equal(sheet.imported_count, 3);
  await api('PUT', `/api/sheets/${id}`, { ...sheet, start_row: 2 });
  const replay = (await api('POST', `/api/sheets/${id}/sync`)).body;
  assert.equal(replay.imported, 1); // only the old #1001
  assert.equal(replay.skipped, 3);
});

test('fake-orders sheet: imported as fake, never confirmed, kept out of the order count', async () => {
  const before = (await api('GET', '/api/stats')).body;
  sheets['fake-sheet'] = csv([['F1', 'Fake Guy', '0699999999', 'Montre Luxe', 1, 3000, 400, 3400, 'Home', 'Setif', '', '']]);
  const url = 'https://docs.google.com/spreadsheets/d/fake-sheet/edit';
  const preview = (await api('POST', '/api/sheets/preview', { sheet_url: url })).body;
  const { id } = (await api('POST', '/api/sheets', { name: 'fake', sheet_url: url, kind: 'fake', mapping: preview.mapping, start_row: 2 })).body;
  assert.equal((await api('POST', `/api/sheets/${id}/sync`)).body.imported, 1);

  const fake = (await api('GET', '/api/orders?status=fake')).body.rows;
  assert.equal(fake.length, 1);
  assert.equal((await api('POST', `/api/orders/${fake[0].id}/action`, { action: 'confirm' })).status, 409);
  const after = (await api('GET', '/api/stats')).body;
  assert.equal(after.orders, before.orders);
  assert.equal(after.fake, 1);
});

test('a sheet without the required columns reports what is missing', async () => {
  sheets['bad-sheet'] = 'Nom,Tel\nA,0550000000';
  const url = 'https://docs.google.com/spreadsheets/d/bad-sheet/edit';
  const { id } = (await api('POST', '/api/sheets', { name: 'bad', sheet_url: url, mapping: { customer_name: 'Nom' } })).body;
  const r = (await api('POST', `/api/sheets/${id}/sync`)).body;
  assert.equal(r.imported, 0);
  assert.match(r.errors[0], /phone/);
  assert.match((await api('GET', '/api/sheets')).body.find((g) => g.id === id).last_error, /أعمدة ناقصة/);
});

test('abandoned checkouts: same "Order ID" text on every row, LightFunnels date and variant kept', async () => {
  sheets['abandoned'] = toCsv([LF_HEADERS,
    ['Client Un ', '550101010', '', 'Algeria', 'Ras El Oued', 'Pyjama 3 pcs love', 1, '', 'PYjAMA7COULEURS',
      'Abandoned checkout', 1900, '', 1900, '2026-06-26 20:03:08', '', '', 'Bordj Bou Arreridj', 'Ras El Oued', 'Pyjama 3 pcs love TAILLE:36/S'],
    ['Client Deux ', '770202020', '', 'Algeria', 'Ain Boucif', 'Pyjama 4 pcs', 1, '', 'pyjama4pcsnoir',
      'Abandoned checkout', 1900, '', 1900, '2026-06-26 20:07:00', '', '', 'Médéa', 'Ain Boucif', 'Pyjama 4 pcs taille:M/38'],
    ['', '0', '', 'Algeria', '', 'Pyjama 3 pcs love', 1, '', '', 'Abandoned checkout', 1900, '', 1900, '2026-06-26 21:41:55', '', '', '', '', ''],
  ]);
  const url = 'https://docs.google.com/spreadsheets/d/abandoned/edit';
  const preview = (await api('POST', '/api/sheets/preview', { sheet_url: url })).body;
  const { id } = (await api('POST', '/api/sheets', { name: 'abandoned', sheet_url: url, kind: 'fake', mapping: preview.mapping, start_row: 2 })).body;
  const r = (await api('POST', `/api/sheets/${id}/sync`)).body;
  assert.equal(r.imported, 2);
  assert.equal(r.errors.length, 1);
  const rows = (await api('GET', '/api/orders?status=fake&q=Client Deux')).body.rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].wilaya_code, 26);
  assert.equal(rows[0].phone, '0770202020');
  assert.equal(rows[0].notes, 'Pyjama 4 pcs taille:M/38');
  assert.equal(new Date(rows[0].created_at).toISOString(), '2026-06-26T19:07:00.000Z');
});
