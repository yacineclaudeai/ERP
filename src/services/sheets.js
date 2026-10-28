// Orders imported from Google Sheets (LightFunnels and others write one order per row).
// The sheet is read as CSV through its share link, so it must be shared as "anyone with the link: viewer".
import { WILAYAS } from '../wilayas.js';
import { HttpError, createOrder, normalizePhone } from './orders.js';

// Fields an order can take from a sheet column, with the header names that usually hold them.
export const SHEET_FIELDS = {
  customer_name: ['full name', 'name', 'nom', 'nom complet', 'الاسم', 'الاسم الكامل'],
  phone: ['phone', 'telephone', 'téléphone', 'tel', 'الهاتف', 'رقم الهاتف'],
  phone2: ['phone 2', 'phone2', 'telephone 2', 'الهاتف 2'],
  product_name: ['product name', 'product', 'produit', 'اسم المنتج', 'المنتج'],
  sku: ['sku'],
  external_id: ['order id', 'order number', 'order', 'id', 'رقم الطلبية'],
  address: ['address', 'adresse', 'العنوان'],
  delivery_type: ['shipping method', 'delivery type', 'type de livraison', 'نوعية التوصيل'],
  wilaya: ['shipping state', 'wilaya', 'state', 'province', 'الولاية'],
  commune: ['shipping city', 'commune', 'city', 'البلدية'],
  quantity: ['quantity', 'qty', 'quantité', 'الكمية'],
  subtotal: ['subtotal', 'product price', 'prix', 'سعر المنتج'],
  shipping_price: ['shipping price', 'shipping', 'frais de livraison', 'سعر التوصيل'],
  discount: ['discount', 'remise', 'تخفيض'],
  total: ['order total', 'total', 'السعر الكلي'],
  notes: ['note', 'notes', 'comment', 'comments', 'ملاحظة', 'التعليقات'],
  variant: ['item title', 'variant', 'options', 'المقاس واللون'],
  created_at: ['created at', 'order date', 'date', 'التاريخ'],
};
const REQUIRED = ['customer_name', 'phone', 'wilaya'];
const MAX_ROWS_PER_SYNC = 300;

const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[\s_\-']+/g, ' ').trim();

// RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') field += '"', i++;
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') row.push(field), (field = '');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field), rows.push(row), (row = []), (field = '');
    } else field += ch;
  }
  if (field !== '' || row.length) row.push(field), rows.push(row);
  return rows;
}

// Accepts the link copied from the browser or from "Share".
export function parseSheetUrl(url) {
  const id = String(url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)?.[1];
  if (!id) throw new HttpError(400, 'رابط الشيت غير صحيح');
  const gid = String(url).match(/[#&?]gid=(\d+)/)?.[1] || '0';
  return { id, gid, csvUrl: `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}` };
}

export async function fetchSheetRows(url) {
  const { csvUrl } = parseSheetUrl(url);
  let res;
  try {
    res = await fetch(csvUrl, { redirect: 'follow' });
  } catch (e) {
    throw new HttpError(400, `ما قدرناش نوصلو للشيت: ${e.message}`);
  }
  const type = res.headers.get('content-type') || '';
  if (!res.ok || type.includes('text/html')) {
    console.warn('sheet not readable', res.status, type, new URL(res.url).host);
    throw new HttpError(400, 'الشيت ماهوش مشارك: دير Partager ← "Tous les utilisateurs disposant du lien" ← Lecteur');
  }
  return parseCsv(await res.text());
}

// Header name per field: exact names first, in the order listed (so "Shipping City" wins over "City"),
// then partial matches; a column is used once.
export function suggestMapping(headers) {
  const folded = headers.map(fold);
  const used = new Set();
  const mapping = {};
  const match = { exact: (h, n) => h === n, partial: (h, n) => n.length > 3 && h.includes(n) };
  for (const pass of ['exact', 'partial']) {
    for (const [field, names] of Object.entries(SHEET_FIELDS)) {
      for (const n of names) {
        if (mapping[field]) break;
        const i = folded.findIndex((h, idx) => !used.has(idx) && h && match[pass](h, fold(n)));
        if (i >= 0) mapping[field] = headers[i], used.add(i);
      }
    }
  }
  return mapping;
}

// "2026-06-25 16:51:00" as written by LightFunnels, in Algeria's time (UTC+1, no DST).
export function parseSheetDate(value) {
  const v = String(value ?? '').trim();
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${(m[4] || '0').padStart(2, '0')}:${m[5] || '00'}:${m[6] || '00'}+01:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// "16", "16 - Alger", "Alger", "الجزائر", "Bejaia"...
const WILAYA_NAMES = new Map(WILAYAS.flatMap((w) => [[fold(w.name_fr), w.code], [fold(w.name_ar), w.code]]));
export function parseWilaya(value) {
  const v = fold(value);
  const num = v.match(/^0*(\d{1,2})\b/)?.[1];
  if (num && Number(num) >= 1 && Number(num) <= 58) return Number(num);
  if (WILAYA_NAMES.has(v)) return WILAYA_NAMES.get(v);
  for (const [name, code] of WILAYA_NAMES) if (name.length > 3 && v.includes(name)) return code;
  return null;
}

const number = (v) => {
  const n = Number(String(v ?? '').replace(/[^\d.,-]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const isDesk = (v) => /desk|bureau|stop|agence|office|مكتب/i.test(String(v || ''));

function sheetPhone(v) {
  const p = String(v ?? '').replace(/[\s.\-()]/g, '');
  return normalizePhone(/^[567]\d{8}$/.test(p) ? `0${p}` : p);
}

// The product a row is for: same name or SKU in this store, else created in the store with stock 0.
async function productFor(db, source, name, sku, unitPrice) {
  const key = fold(name);
  const products = await db.all('SELECT id, name, sku, store_id FROM products');
  const sameStore = (p) => !source.store_id || p.store_id === source.store_id;
  const found = (sku && products.find((p) => sameStore(p) && p.sku && fold(p.sku) === fold(sku)))
    || products.find((p) => sameStore(p) && fold(p.name) === key)
    || products.find((p) => fold(p.name) === key);
  if (found) return found.id;
  const { rows } = await db.run(`
    INSERT INTO products (name, sku, price, public_key, store_id) VALUES (?, ?, ?, ?, ?) RETURNING id`,
  String(name).trim(), sku || null, unitPrice ?? 0, `sheet-${crypto.randomUUID()}`, source.store_id);
  return rows[0].id;
}

// One sheet row to createOrder input. Throws HttpError with the reason when the row can't be used.
export function rowToOrder(get, kind) {
  for (const f of REQUIRED) if (!String(get(f) ?? '').trim()) throw new HttpError(400, `${f} فارغ`);
  const wilaya = parseWilaya(get('wilaya'));
  if (!wilaya) throw new HttpError(400, `ولاية غير معروفة "${get('wilaya')}"`);
  const phone = sheetPhone(get('phone'));
  if (!phone) throw new HttpError(400, `رقم غير صحيح "${get('phone')}"`);
  const quantity = Math.max(1, Math.floor(number(get('quantity')) || 1));
  const subtotal = number(get('subtotal'));
  const shipping = number(get('shipping_price'));
  const total = number(get('total'));
  const unit_price = subtotal != null ? subtotal / quantity
    : total != null ? Math.max(0, total - (shipping || 0)) / quantity : null;
  const discount = number(get('discount'));
  const notes = [get('variant'), get('notes'), discount ? `تخفيض: ${discount}` : null]
    .filter((x) => String(x ?? '').trim()).join(' | ');
  return {
    customer_name: String(get('customer_name')).trim(),
    phone,
    phone2: sheetPhone(get('phone2')) || null,
    wilaya_code: wilaya,
    commune: get('commune') || null,
    address: get('address') || null,
    stop_desk: isDesk(get('delivery_type')),
    quantity,
    unit_price,
    delivery_fee: shipping,
    total,
    notes: notes || null,
    status: kind === 'fake' ? 'fake' : 'new',
    created_at: parseSheetDate(get('created_at')),
  };
}

// Reads the rows added since the last sync and creates their orders.
export async function importSheet(db, source, { rows = null } = {}) {
  const all = rows ?? await fetchSheetRows(source.sheet_url);
  const headers = all[0] || [];
  const mapping = source.mapping || {};
  const col = Object.fromEntries(Object.entries(mapping).map(([f, h]) => [f, headers.indexOf(h)]).filter(([, i]) => i >= 0));
  const missing = REQUIRED.filter((f) => col[f] == null);
  if (col.product_name == null && col.sku == null) missing.push('product_name');
  if (missing.length) throw new HttpError(400, `أعمدة ناقصة: ${missing.join(', ')}`);

  // Sheet row numbers start at 1 with the header row.
  const first = Math.max(2, source.start_row || 2, (source.last_row || 0) + 1);
  const last = Math.min(all.length, first + MAX_ROWS_PER_SYNC - 1);
  const result = { imported: 0, skipped: 0, errors: [], last_row: source.last_row || 0 };
  for (let n = first; n <= last; n++) {
    const cells = all[n - 1];
    result.last_row = n;
    if (!cells || cells.every((x) => !String(x).trim())) continue;
    const get = (f) => (col[f] == null ? null : cells[col[f]]?.trim() ?? null);
    // Abandoned-checkout sheets put the same text ("Abandoned checkout") in Order ID: only a value with a digit is an id.
    const orderId = get('external_id');
    const externalId = /\d/.test(orderId || '') ? orderId : `row-${n}`;
    try {
      if (await db.get('SELECT id FROM orders WHERE sheet_source_id = ? AND external_id = ?', source.id, externalId)) {
        result.skipped++;
        continue;
      }
      const order = rowToOrder(get, source.kind);
      const productId = await productFor(db, source, get('product_name') || get('sku'), get('sku'), order.unit_price);
      const created = await createOrder(db, { ...order, product_id: productId }, {
        source: 'sheet', sheet: { source_id: source.id, external_id: externalId, name: source.name },
      });
      if (order.created_at) await db.run('UPDATE orders SET created_at = ? WHERE id = ?', order.created_at, created.id);
      result.imported++;
    } catch (e) {
      if (!(e instanceof HttpError) && e.code !== '23505') throw e;
      if (e.code === '23505') result.skipped++;
      else result.errors.push(`سطر ${n}: ${e.message}`);
    }
  }
  return result;
}

export async function syncSheet(db, source) {
  try {
    const r = await importSheet(db, source);
    await db.run(`UPDATE sheet_sources SET last_row = ?, last_sync_at = now(), imported_count = imported_count + ?,
      last_error = ? WHERE id = ?`, r.last_row, r.imported, r.errors.slice(-5).join('\n') || null, source.id);
    return r;
  } catch (e) {
    await db.run('UPDATE sheet_sources SET last_sync_at = now(), last_error = ? WHERE id = ?', e.message, source.id);
    if (e instanceof HttpError) return { imported: 0, skipped: 0, errors: [e.message] };
    throw e;
  }
}

export async function syncAllSheets(db) {
  const sources = await db.all('SELECT * FROM sheet_sources WHERE active ORDER BY id');
  const out = {};
  for (const s of sources) out[s.name] = await syncSheet(db, s);
  return out;
}
