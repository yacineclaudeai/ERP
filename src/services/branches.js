// Links each product to its store (branch) from what the stores already
// shipped: every store has its own delivery account, so the products named in
// that account's parcels belong to that store. Read-only on the delivery side.
import { getSetting } from '../db.js';
import { getProvider } from '../delivery/index.js';
import { HttpError, companyAccount, rerouteProductOrders } from './orders.js';

// The store every new product starts in (the "TEST" store), or null.
export async function newProductStore(db) {
  const id = Number(await getSetting(db, 'new_product_store_id'));
  if (!id) return null;
  return (await db.get('SELECT id FROM stores WHERE id = ?', id))?.id ?? null;
}

export const normalizeName = (v) => String(v ?? '')
  .toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f\u064b-\u065f]/g, '')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim();

// Product → store, from the parcel texts of each store: { storeId: [text, ...] }.
// A product goes to the store whose parcels name it most, if that store clearly
// leads (twice the runner-up), so one stray parcel doesn't move a product.
export function matchProducts(products, textsByStore) {
  const result = [];
  for (const p of products) {
    const keys = [normalizeName(p.name), normalizeName(p.sku)].filter((k) => k.length >= 3);
    if (!keys.length) continue;
    const counts = Object.entries(textsByStore)
      .map(([storeId, texts]) => [Number(storeId), texts.filter((t) => keys.some((k) => ` ${t} `.includes(` ${k} `))).length])
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1]);
    if (!counts.length) continue;
    const [[storeId, n], second] = counts;
    if (second && n < second[1] * 2) continue;
    result.push({ product_id: p.id, store_id: storeId, parcels: n });
  }
  return result;
}

const DAYS = 60;

// One page of one store's parcels, reduced to normalized product texts.
// The page reads one page per request so each call stays well under the
// function time limit (Ecotrack can take 10-30 s per page).
export async function scanStore(db, storeId, page = 1) {
  const s = await db.get('SELECT id, name, company_id FROM stores WHERE id = ?', storeId);
  if (!s) throw new HttpError(404, 'البوتيك غير موجود');
  if (!s.company_id) throw new HttpError(400, `${s.name}: ما عندهاش شركة توصيل`);
  const company = await companyAccount(db, s.company_id, s.id);
  const provider = getProvider(company.provider);
  if (!provider.listParcels) throw new HttpError(400, `${s.name}: ما نقدرش نقرا طرود ${company.name} مازال`);
  const end = new Date();
  const start = new Date(end.getTime() - DAYS * 86400_000);
  const { parcels, last_page } = await provider.listParcels(company, start, end, page);
  return { store_id: s.id, page, last_page, texts: parcels.map((x) => normalizeName(x.products)).filter(Boolean) };
}

// textsByStore: { storeId: [text, ...] } gathered with scanStore.
export async function applyStoreLinks(db, textsByStore) {
  const stores = new Map((await db.all('SELECT id, name FROM stores')).map((s) => [s.id, s.name]));
  const clean = Object.fromEntries(Object.entries(textsByStore || {})
    .filter(([id, texts]) => stores.has(Number(id)) && Array.isArray(texts))
    .map(([id, texts]) => [id, texts.map(normalizeName)]));
  const products = await db.all('SELECT id, name, sku, store_id FROM products ORDER BY id');
  const matches = matchProducts(products, clean);
  const byId = new Map(products.map((p) => [p.id, p]));
  const linked = [];
  for (const m of matches) {
    const p = byId.get(m.product_id);
    if (p.store_id === m.store_id) continue;
    await db.run('UPDATE products SET store_id = ? WHERE id = ?', m.store_id, p.id);
    const orders = await rerouteProductOrders(db, p.id);
    linked.push({ product: p.name, from: stores.get(p.store_id) || null, to: stores.get(m.store_id), parcels: m.parcels, orders });
  }
  const matched = new Set(matches.map((m) => m.product_id));
  return {
    linked,
    kept: matches.length - linked.length,
    unmatched: products.filter((p) => !matched.has(p.id) && !p.store_id).map((p) => p.name),
  };
}
