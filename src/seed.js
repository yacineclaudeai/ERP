// Demo data for the local database: npm run seed (uses DB_PATH, default ./data/pg)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setSetting } from './db.js';
import { openLocalDb } from './db-local.js';
import { ensureAdmin } from './app.js';
import { createOrder, applyAction, confirmAndDispatch } from './services/orders.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const db = await openLocalDb(process.env.DB_PATH || path.join(root, 'data/pg'));
await ensureAdmin(db);

const insertId = async (sql, ...args) => (await db.run(`${sql} RETURNING id`, ...args)).rows[0].id;

const test = await insertId(`INSERT INTO delivery_companies (name, provider) VALUES ('Livraison test', 'sandbox')`);
const dhd = await insertId(`INSERT INTO delivery_companies (name, provider) VALUES ('DHD test', 'sandbox')`);
await setSetting(db, 'default_company_id', test);
for (let code = 1; code <= 58; code++) {
  await db.run(`INSERT INTO delivery_routes (wilaya_code, company_id, home_fee, desk_fee) VALUES (?, NULL, ?, ?)
    ON CONFLICT (wilaya_code) DO NOTHING`, code, code === 16 ? 400 : 700, code === 16 ? 300 : 450);
}

const storeA = await insertId('INSERT INTO stores (name, company_id) VALUES (?, ?)', 'Boutique A', test);
const storeB = await insertId('INSERT INTO stores (name, company_id) VALUES (?, ?)', 'Boutique B', dhd);
await db.run('INSERT INTO store_routes (store_id, wilaya_code, company_id) VALUES (?, 35, ?)', storeA, dhd);

const products = [];
for (const [i, [name, price, cost, stock]] of [
  ['Montre connectée', 4900, 2100, 40],
  ['Sac à main', 3200, 1300, 25],
  ['Lampe LED', 2500, 900, 4],
].entries()) {
  products.push(await insertId(
    'INSERT INTO products (name, price, cost, stock, public_key, landing_url, store_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    name, price, cost, stock, `demo-key-${i + 1}`, `https://example.com/produit-${i + 1}`, i === 1 ? storeB : storeA,
  ));
}

const names = ['Amine', 'Sara', 'Yacine', 'Nour', 'Karim', 'Lina', 'Walid', 'Imene', 'Sofiane', 'Meriem', 'Bilal', 'Asma'];
const wilayas = [16, 31, 25, 9, 19, 6, 15, 35, 5, 23, 13, 42];
for (let i = 0; i < 24; i++) {
  const o = await createOrder(db, {
    product_id: products[i % 3],
    customer_name: names[i % names.length],
    phone: `05${String(50000000 + i * 7919).padStart(8, '0')}`,
    wilaya_code: wilayas[i % wilayas.length],
    commune: 'Centre',
    quantity: 1 + (i % 2),
  }, { source: 'landing' });
  if (i % 6 === 0) continue;
  if (i % 6 === 1) await applyAction(db, o.id, 'no_answer');
  else if (i % 6 === 2) await applyAction(db, o.id, 'cancel');
  else {
    await confirmAndDispatch(db, o.id);
    if (i % 6 === 3) await applyAction(db, o.id, 'delivered');
    if (i % 6 === 4 && i > 10) await applyAction(db, o.id, 'returned');
  }
}
const day = new Date().toISOString().slice(0, 10);
for (const [i, id] of products.entries()) {
  await db.run('INSERT INTO ad_spend (product_id, date, amount) VALUES (?, ?, ?)', id, day, 3000 + i * 1500);
}
await db.close();
console.log('Demo data created.');
