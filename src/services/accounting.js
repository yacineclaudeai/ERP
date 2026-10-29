// Profit of each product: sales minus every expense, the whole batch included.
// Each expense line is either computed from the orders (auto), priced by a value
// shared by all products (default), or typed for this product (manual).
import { getSetting, setSetting } from '../db.js';
import { HttpError } from './orders.js';

// Prices per unit, shared by all products unless a product has its own.
export const UNIT_FIELDS = {
  // Every parcel sent is packed and labelled once, even if it comes back as a return.
  packaging: { label: 'التغليف', per: 'طلبية مبعوثة' },
  labels: { label: 'الإتيكات', per: 'طلبية مبعوثة' },
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

// A purchase of goods: its pieces join the stock unless they were already counted there.
export async function addPurchase(db, productId, { quantity, unit_price, bought_on, note, add_to_stock = true }) {
  const qty = Math.round(num(quantity) ?? 0);
  const price = num(unit_price);
  if (!qty || price == null) throw new HttpError(400, 'الكمية والسعر ضروريين');
  const day = bought_on && /^\d{4}-\d{2}-\d{2}$/.test(bought_on) ? bought_on : null;
  await db.tx(async (t) => {
    if (!await t.get('SELECT id FROM products WHERE id = ?', productId)) throw new HttpError(404, 'المنتج غير موجود');
    const added = Boolean(add_to_stock);
    const { id } = await t.get(`INSERT INTO product_purchases (product_id, quantity, unit_price, bought_on, added_to_stock, note)
      VALUES (?, ?, ?, COALESCE(?::date, CURRENT_DATE), ?, ?) RETURNING id`, productId, qty, price, day, added, note ? String(note).slice(0, 300) : null);
    if (added) await stockMove(t, productId, qty, `شرية رقم ${id}`);
    // The product's purchase price follows the last purchase.
    await t.run('UPDATE products SET cost = ? WHERE id = ?', price, productId);
  });
}

export async function deletePurchase(db, id) {
  await db.tx(async (t) => {
    const p = await t.get('SELECT * FROM product_purchases WHERE id = ?', id);
    if (!p) throw new HttpError(404, 'الشرية غير موجودة');
    if (p.added_to_stock) await stockMove(t, p.product_id, -p.quantity, `حذف الشرية رقم ${id}`);
    await t.run('DELETE FROM product_purchases WHERE id = ?', id);
  });
}

async function stockMove(t, productId, quantity, reason) {
  await t.run('UPDATE products SET stock = stock + ? WHERE id = ?', quantity, productId);
  await t.run('INSERT INTO stock_movements (product_id, quantity, reason) VALUES (?, ?, ?)', productId, quantity, reason);
}

// "On its way to the customer" in the delivery company's own words.
const OUT_FOR_DELIVERY = /en.?livraison|sortie|out.?for|vers.?client|chez.?livreur/i;

const round = (n) => Math.round(n * 100) / 100;

export async function getAccounting(db) {
  const defaults = await getDefaults(db);
  const rows = await db.all(`
    SELECT p.id, p.name, p.cost, p.stock, p.store_id, s.name AS store_name,
      COALESCE(SUM(o.unit_price * o.quantity) FILTER (WHERE o.status = 'delivered'), 0) AS revenue,
      COALESCE(SUM(o.quantity) FILTER (WHERE o.status = 'delivered'), 0) AS delivered_qty,
      COUNT(o.id) FILTER (WHERE o.status IN ('confirmed','dispatched','delivered','returned')) AS confirmed_orders,
      COUNT(o.id) FILTER (WHERE o.status IN ('dispatched','delivered','returned')) AS parcels,
      COALESCE(SUM(o.quantity) FILTER (WHERE o.stock_reserved), 0) AS out_qty,
      COALESCE(SUM(o.quantity) FILTER (WHERE o.status = 'confirmed' AND o.stock_reserved), 0) AS reserved_qty,
      COALESCE(SUM(o.quantity) FILTER (WHERE o.status = 'returned' AND o.return_received_at IS NULL AND o.stock_reserved), 0) AS returning_qty,
      COALESCE(SUM(o.quantity) FILTER (WHERE o.status = 'returned' AND o.return_received_at IS NOT NULL), 0) AS returned_back_qty,
      (SELECT COALESCE(SUM(amount), 0) FROM ad_spend a WHERE a.product_id = p.id) AS ads_dzd
    FROM products p LEFT JOIN stores s ON s.id = p.store_id
    LEFT JOIN orders o ON o.product_id = p.id AND o.status <> 'fake'
    GROUP BY p.id, s.name ORDER BY p.id`);
  const costs = new Map((await db.all('SELECT * FROM product_costs')).map((c) => [c.product_id, c]));
  const expenses = await db.all('SELECT id, product_id, name, amount FROM product_expenses ORDER BY id');
  const purchases = await db.all(`SELECT id, product_id, quantity, unit_price, to_char(bought_on, 'YYYY-MM-DD') AS bought_on, added_to_stock, note
    FROM product_purchases ORDER BY bought_on, id`);
  const purchasesOf = new Map();
  for (const x of purchases) (purchasesOf.get(x.product_id) || purchasesOf.set(x.product_id, []).get(x.product_id)).push(x);
  // Parcels at the delivery company, split by what the company last said about them.
  const shipping = new Map();
  for (const o of await db.all("SELECT product_id, quantity, delivery_status FROM orders WHERE status = 'dispatched'")) {
    const s = shipping.get(o.product_id) || shipping.set(o.product_id, { at_company: 0, out_for_delivery: 0 }).get(o.product_id);
    s[OUT_FOR_DELIVERY.test(o.delivery_status || '') ? 'out_for_delivery' : 'at_company'] += o.quantity;
  }
  const byProduct = new Map();
  for (const e of expenses) (byProduct.get(e.product_id) || byProduct.set(e.product_id, []).get(e.product_id)).push(e);

  const products = rows.map((p) => {
    const c = costs.get(p.id) || {};
    const lines = [];
    const missing = [];
    const batchAuto = p.stock + p.out_qty;
    const bought = purchasesOf.get(p.id) || [];
    const boughtQty = bought.reduce((a, x) => a + x.quantity, 0);
    if (bought.length) {
      const amount = bought.reduce((a, x) => a + x.quantity * x.unit_price, 0);
      lines.push({ key: 'purchase', label: 'الشراء (كل الشريات)', qty: boughtQty, amount, mode: 'manual',
        note: bought.map((x) => `${x.quantity} × ${x.unit_price}`).join(' + ') });
    } else {
      const batch = c.batch_qty ?? batchAuto;
      lines.push({ key: 'purchase', label: 'الشراء (الدفعة كاملة)', qty: batch, unit: p.cost, amount: batch * p.cost,
        mode: c.batch_qty != null ? 'manual' : 'auto', note: `${batch} قطعة × ${p.cost}` });
      if (!p.cost) missing.push('سعر الشراء');
    }
    // Where every piece is: with me (touchable), out with the company, or coming back.
    const ship = shipping.get(p.id) || { at_company: 0, out_for_delivery: 0 };
    const pieces = {
      bought: bought.length ? boughtQty : null,
      in_hand: p.stock + p.reserved_qty,
      reserved: p.reserved_qty,
      at_company: ship.at_company,
      out_for_delivery: ship.out_for_delivery,
      delivered: p.delivered_qty,
      returning: p.returning_qty,
      returned_back: p.returned_back_qty,
    };
    // What should be left from the purchases, to compare with the stock counted by the ERP.
    pieces.expected_in_hand = bought.length
      ? boughtQty - pieces.at_company - pieces.out_for_delivery - pieces.delivered - pieces.returning
      : null;
    const basis = { packaging: p.parcels, labels: p.parcels, confirmation: p.confirmed_orders, tracking: p.parcels };
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
      id: p.id, name: p.name, store_id: p.store_id, store_name: p.store_name, stock: p.stock, cost: p.cost,
      // Pieces left, priced at the purchase price: in hand, and returns still on their way.
      left_value: round(pieces.in_hand * p.cost), returning_value: round(pieces.returning * p.cost),
      revenue: round(p.revenue), delivered_qty: p.delivered_qty,
      expenses: round(expensesTotal), profit: round(profit),
      state: !p.revenue && !expensesTotal ? 'none' : profit >= 0 ? 'profit' : selling ? 'selling' : 'loss',
      selling, batch_auto: batchAuto, batch_manual: c.batch_qty ?? null, notes: c.notes ?? null,
      pieces, purchases: bought,
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
