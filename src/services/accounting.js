// Profit of each product: sales minus every expense, the whole batch included.
// Each expense line is either computed from the orders (auto), priced by a value
// shared by all products (default), or typed for this product (manual).
import { getSetting, setSetting } from '../db.js';
import { HttpError } from './orders.js';

// Prices per unit, shared by all products unless a product has its own.
export const UNIT_FIELDS = {
  packaging: { label: 'التغليف', per: 'قطعة مبعوثة' },
  labels: { label: 'الإتيكات', per: 'قطعة مبعوثة' },
  return_packaging: { label: 'تغليف الرتور', per: 'قطعة راجعة' },
  confirmation: { label: 'التأكيد', per: 'طلبية مؤكدة' },
  tracking: { label: 'السويفي (التتبع)', per: 'كولي' },
};
// Lump sums typed for each product.
export const LUMP_FIELDS = {
  creative: { label: 'الكرياتيف' },
  transport_office: { label: 'نقل السلعة: مكتب لمكتب' },
  transport_home: { label: 'نقل السلعة: مكتب لدار الفرع' },
};
const PRODUCT_NUMBERS = ['batch_qty', ...Object.keys(UNIT_FIELDS), ...Object.keys(LUMP_FIELDS), 'ads_usd', 'fx_rate'];
const DEFAULT_KEYS = [...Object.keys(UNIT_FIELDS), 'creative', 'fx_rate'];

const num = (v) => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'رقم غير صحيح');
  return n;
};

export async function getDefaults(db) {
  const out = {};
  for (const k of DEFAULT_KEYS) out[k] = num(await getSetting(db, `acc_${k}`));
  return out;
}

export async function saveDefaults(db, body) {
  await db.tx(async (t) => {
    for (const k of DEFAULT_KEYS) if (k in body) await setSetting(t, `acc_${k}`, num(body[k]));
  });
  return getDefaults(db);
}

export async function saveProductCosts(db, productId, body) {
  if (!await db.get('SELECT id FROM products WHERE id = ?', productId)) throw new HttpError(404, 'المنتج غير موجود');
  const current = await db.get('SELECT * FROM product_costs WHERE product_id = ?', productId) || {};
  const next = { ...current };
  for (const k of PRODUCT_NUMBERS) if (k in body) next[k] = k === 'batch_qty' && body[k] !== '' && body[k] != null ? Math.round(num(body[k])) : num(body[k]);
  if ('selling' in body) next.selling = Boolean(body.selling);
  if ('notes' in body) next.notes = body.notes ? String(body.notes).slice(0, 500) : null;
  const cols = [...PRODUCT_NUMBERS, 'selling', 'notes'];
  await db.run(`INSERT INTO product_costs (product_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})
    ON CONFLICT (product_id) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}`,
  productId, ...cols.map((c) => next[c] ?? (c === 'selling' ? true : null)));
}

export async function addExpense(db, productId, { name, amount }) {
  const n = String(name || '').trim();
  const a = num(amount);
  if (!n || a == null) throw new HttpError(400, 'الاسم والمبلغ ضروريين');
  if (!await db.get('SELECT id FROM products WHERE id = ?', productId)) throw new HttpError(404, 'المنتج غير موجود');
  await db.run('INSERT INTO product_expenses (product_id, name, amount) VALUES (?, ?, ?)', productId, n, a);
}

export async function deleteExpense(db, id) {
  await db.run('DELETE FROM product_expenses WHERE id = ?', id);
}

const round = (n) => Math.round(n * 100) / 100;

export async function getAccounting(db) {
  const defaults = await getDefaults(db);
  const rows = await db.all(`
    SELECT p.id, p.name, p.cost, p.stock, s.name AS store_name,
      COALESCE(SUM(o.unit_price * o.quantity) FILTER (WHERE o.status = 'delivered'), 0) AS revenue,
      COALESCE(SUM(o.quantity) FILTER (WHERE o.status = 'delivered'), 0) AS delivered_qty,
      COALESCE(SUM(o.quantity) FILTER (WHERE o.status IN ('dispatched','delivered','returned')), 0) AS shipped_qty,
      COALESCE(SUM(o.quantity) FILTER (WHERE o.status = 'returned'), 0) AS returned_qty,
      COUNT(o.id) FILTER (WHERE o.status IN ('confirmed','dispatched','delivered','returned')) AS confirmed_orders,
      COUNT(o.id) FILTER (WHERE o.status IN ('dispatched','delivered','returned')) AS parcels,
      COALESCE(SUM(o.quantity) FILTER (WHERE o.stock_reserved), 0) AS out_qty,
      (SELECT COALESCE(SUM(amount), 0) FROM ad_spend a WHERE a.product_id = p.id) AS ads_dzd
    FROM products p LEFT JOIN stores s ON s.id = p.store_id
    LEFT JOIN orders o ON o.product_id = p.id AND o.status <> 'fake'
    GROUP BY p.id, s.name ORDER BY p.id`);
  const costs = new Map((await db.all('SELECT * FROM product_costs')).map((c) => [c.product_id, c]));
  const expenses = await db.all('SELECT id, product_id, name, amount FROM product_expenses ORDER BY id');
  const byProduct = new Map();
  for (const e of expenses) (byProduct.get(e.product_id) || byProduct.set(e.product_id, []).get(e.product_id)).push(e);

  const products = rows.map((p) => {
    const c = costs.get(p.id) || {};
    const lines = [];
    const missing = [];
    const batchAuto = p.stock + p.out_qty;
    const batch = c.batch_qty ?? batchAuto;
    lines.push({ key: 'purchase', label: 'الشراء (الدفعة كاملة)', qty: batch, unit: p.cost, amount: batch * p.cost,
      mode: c.batch_qty != null ? 'manual' : 'auto', note: `${batch} قطعة × ${p.cost}` });
    if (!p.cost) missing.push('سعر الشراء');
    const basis = { packaging: p.shipped_qty, labels: p.shipped_qty, return_packaging: p.returned_qty, confirmation: p.confirmed_orders, tracking: p.parcels };
    for (const [key, f] of Object.entries(UNIT_FIELDS)) {
      const own = c[key];
      const unit = own ?? defaults[key];
      if (unit == null) missing.push(f.label);
      lines.push({ key, label: f.label, qty: basis[key], per: f.per, unit: unit ?? 0, amount: (unit ?? 0) * basis[key],
        mode: own != null ? 'manual' : unit != null ? 'default' : 'empty' });
    }
    for (const [key, f] of Object.entries(LUMP_FIELDS)) {
      const own = c[key];
      const v = own ?? (key === 'creative' ? defaults.creative : null);
      lines.push({ key, label: f.label, amount: v ?? 0, mode: own != null ? 'manual' : v != null ? 'default' : 'empty' });
    }
    const fx = c.fx_rate ?? defaults.fx_rate;
    if (c.ads_usd != null) {
      if (fx == null) missing.push('سعر الصرف');
      lines.push({ key: 'ads', label: 'الأدس (دولار × الصرف)', amount: c.ads_usd * (fx ?? 0), mode: 'manual', note: `${c.ads_usd}$ × ${fx ?? '؟'}` });
    } else {
      lines.push({ key: 'ads', label: 'الأدس', amount: p.ads_dzd, mode: p.ads_dzd ? 'auto' : 'empty', note: 'من مصاريف الإشهار المسجلة' });
    }
    const others = byProduct.get(p.id) || [];
    for (const e of others) lines.push({ key: `expense-${e.id}`, label: e.name, amount: e.amount, mode: 'manual', expense_id: e.id });
    const expensesTotal = lines.reduce((a, l) => a + l.amount, 0);
    const profit = p.revenue - expensesTotal;
    const selling = c.selling ?? true;
    return {
      id: p.id, name: p.name, store_name: p.store_name, stock: p.stock,
      revenue: round(p.revenue), delivered_qty: p.delivered_qty,
      expenses: round(expensesTotal), profit: round(profit),
      state: !p.revenue && !expensesTotal ? 'none' : profit >= 0 ? 'profit' : selling ? 'selling' : 'loss',
      selling, batch_auto: batchAuto, batch_manual: c.batch_qty ?? null, notes: c.notes ?? null,
      manual: Object.fromEntries([...PRODUCT_NUMBERS].map((k) => [k, c[k] ?? null])),
      missing, lines: lines.map((l) => ({ ...l, amount: round(l.amount) })),
    };
  });
  return {
    defaults,
    unit_fields: UNIT_FIELDS,
    lump_fields: LUMP_FIELDS,
    products,
    totals: {
      revenue: round(products.reduce((a, p) => a + p.revenue, 0)),
      expenses: round(products.reduce((a, p) => a + p.expenses, 0)),
      profit: round(products.reduce((a, p) => a + p.profit, 0)),
    },
  };
}
