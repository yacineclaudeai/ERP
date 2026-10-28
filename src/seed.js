// Demo data: node src/seed.js (uses DB_PATH, default ./data/erp.db)
import { openDb, setSetting } from './db.js';
import { ensureAdmin } from './server.js';
import { createOrder, applyAction, confirmAndDispatch } from './services/orders.js';

const db = openDb();
ensureAdmin(db);

const company = db.prepare(`INSERT INTO delivery_companies (name, provider) VALUES ('Livraison test', 'sandbox')`).run();
setSetting(db, 'default_company_id', company.lastInsertRowid);
for (let code = 1; code <= 58; code++) {
  db.prepare('INSERT OR REPLACE INTO delivery_routes (wilaya_code, company_id, home_fee, desk_fee) VALUES (?, NULL, ?, ?)')
    .run(code, code === 16 ? 400 : 700, code === 16 ? 300 : 450);
}

const dhd = db.prepare(`INSERT INTO delivery_companies (name, provider) VALUES ('DHD test', 'sandbox')`).run().lastInsertRowid;
const storeA = db.prepare('INSERT INTO stores (name, company_id) VALUES (?, ?)').run('Boutique A', company.lastInsertRowid).lastInsertRowid;
const storeB = db.prepare('INSERT INTO stores (name, company_id) VALUES (?, ?)').run('Boutique B', dhd).lastInsertRowid;
db.prepare('INSERT INTO store_routes (store_id, wilaya_code, company_id) VALUES (?, 35, ?)').run(storeA, dhd);

const products = [
  ['Montre connectée', 4900, 2100, 40],
  ['Sac à main', 3200, 1300, 25],
  ['Lampe LED', 2500, 900, 4],
].map(([name, price, cost, stock], i) => {
  const r = db.prepare('INSERT INTO products (name, price, cost, stock, public_key, landing_url, store_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(name, price, cost, stock, `demo-key-${i + 1}`, `https://example.com/produit-${i + 1}`, i === 1 ? storeB : storeA);
  return Number(r.lastInsertRowid);
});

const names = ['Amine', 'Sara', 'Yacine', 'Nour', 'Karim', 'Lina', 'Walid', 'Imene', 'Sofiane', 'Meriem', 'Bilal', 'Asma'];
const wilayas = [16, 31, 25, 9, 19, 6, 15, 35, 5, 23, 13, 42];
for (let i = 0; i < 24; i++) {
  const o = createOrder(db, {
    product_id: products[i % 3],
    customer_name: names[i % names.length],
    phone: `05${String(50000000 + i * 7919).padStart(8, '0')}`,
    wilaya_code: wilayas[i % wilayas.length],
    commune: 'Centre',
    quantity: 1 + (i % 2),
  }, { source: 'landing' });
  if (i % 6 === 0) continue;
  if (i % 6 === 1) applyAction(db, o.id, 'no_answer');
  else if (i % 6 === 2) applyAction(db, o.id, 'cancel');
  else {
    await confirmAndDispatch(db, o.id);
    if (i % 6 === 3) applyAction(db, o.id, 'delivered');
    if (i % 6 === 4 && i > 10) applyAction(db, o.id, 'returned');
  }
}
const day = new Date().toISOString().slice(0, 10);
products.forEach((id, i) => db.prepare('INSERT INTO ad_spend (product_id, date, amount) VALUES (?, ?, ?)').run(id, day, 3000 + i * 1500));
console.log('Demo data created.');
