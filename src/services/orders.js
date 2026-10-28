import { getSetting } from '../db.js';
import { isValidWilaya } from '../wilayas.js';
import { getProvider } from '../delivery/index.js';

// 'fake' comes from a fake-orders sheet: kept for the stats, never confirmed or shipped.
export const STATUSES = ['new', 'no_answer', 'postponed', 'confirmed', 'cancelled', 'dispatched', 'delivered', 'returned', 'fake'];
const OPEN = ['new', 'no_answer', 'postponed'];
const EDITABLE = [...OPEN, 'confirmed'];

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function normalizePhone(raw) {
  if (raw == null) return null;
  let p = String(raw).replace(/[\s.\-()]/g, '');
  if (p.startsWith('+213')) p = '0' + p.slice(4);
  else if (p.startsWith('00213')) p = '0' + p.slice(5);
  else if (p.startsWith('213') && p.length === 12) p = '0' + p.slice(3);
  return /^0\d{8,9}$/.test(p) ? p : null;
}

// Company choice, most specific first: the store's exception for this wilaya,
// the store's own account, the global wilaya route, then the default company.
// Shipping fees always come from the global wilaya table.
export async function resolveRoute(db, wilayaCode, storeId = null) {
  const route = await db.get('SELECT * FROM delivery_routes WHERE wilaya_code = ?', wilayaCode);
  const fallback = await getSetting(db, 'default_company_id');
  let companyId = null;
  if (storeId) {
    companyId = (await db.get('SELECT company_id FROM store_routes WHERE store_id = ? AND wilaya_code = ?', storeId, wilayaCode))?.company_id
      ?? (await db.get('SELECT company_id FROM stores WHERE id = ?', storeId))?.company_id
      ?? null;
  }
  return {
    company_id: companyId ?? route?.company_id ?? (fallback ? Number(fallback) : null),
    home_fee: route?.home_fee ?? 0,
    desk_fee: route?.desk_fee ?? 0,
  };
}

function logEvent(db, orderId, type, message, userId = null) {
  return db.run('INSERT INTO order_events (order_id, user_id, type, message) VALUES (?, ?, ?, ?)',
    orderId, userId, type, message ?? null);
}

async function moveStock(db, productId, orderId, quantity, reason) {
  await db.run('UPDATE products SET stock = stock + ? WHERE id = ?', quantity, productId);
  await db.run('INSERT INTO stock_movements (product_id, order_id, quantity, reason) VALUES (?, ?, ?, ?)',
    productId, orderId, quantity, reason);
}

// lock = true takes a row lock on the order, for read-then-write inside a transaction.
export async function getOrder(db, id, { lock = false } = {}) {
  const order = await db.get(`
    SELECT o.*, p.name AS product_name, p.store_id, s.name AS store_name, c.name AS company_name, c.provider AS company_provider
    FROM orders o
    JOIN products p ON p.id = o.product_id
    LEFT JOIN stores s ON s.id = p.store_id
    LEFT JOIN delivery_companies c ON c.id = o.company_id
    WHERE o.id = ?${lock ? ' FOR UPDATE OF o' : ''}`, id);
  if (!order) throw new HttpError(404, 'Commande introuvable');
  return order;
}

function validateOrderFields(input) {
  const customer_name = String(input.customer_name ?? input.name ?? '').trim();
  const phone = normalizePhone(input.phone);
  const phone2 = input.phone2 ? normalizePhone(input.phone2) : null;
  const wilaya_code = Number(input.wilaya_code ?? input.wilaya);
  const quantity = Math.max(1, Math.floor(Number(input.quantity ?? 1)) || 1);
  if (!customer_name) throw new HttpError(400, 'الاسم ضروري');
  if (!phone) throw new HttpError(400, 'رقم الهاتف غير صحيح');
  if (input.phone2 && !phone2) throw new HttpError(400, 'رقم الهاتف الثاني غير صحيح');
  if (!isValidWilaya(wilaya_code)) throw new HttpError(400, 'الولاية غير صحيحة');
  return {
    customer_name,
    phone,
    phone2,
    wilaya_code,
    quantity,
    commune: input.commune ? String(input.commune).trim() : null,
    address: input.address ? String(input.address).trim() : null,
    stop_desk: Boolean(input.stop_desk),
    notes: input.notes ? String(input.notes).trim() : null,
  };
}

// sheet: { source_id, external_id, name } for an order imported from a Google Sheet.
export async function createOrder(db, input, { source = 'manual', userId = null, sheet = null } = {}) {
  const product = input.product_id != null
    ? await db.get('SELECT * FROM products WHERE id = ?', Number(input.product_id) || 0)
    : await db.get('SELECT * FROM products WHERE public_key = ?', String(input.key ?? ''));
  if (!product || (source === 'landing' && !product.active)) throw new HttpError(404, 'المنتج غير موجود');

  const f = validateOrderFields(input);
  const route = await resolveRoute(db, f.wilaya_code, product.store_id);
  const trusted = source !== 'landing';
  const unit_price = input.unit_price != null && trusted ? Number(input.unit_price) : product.price;
  const delivery_fee = input.delivery_fee != null && trusted ? Number(input.delivery_fee) : f.stop_desk ? route.desk_fee : route.home_fee;
  const total = input.total != null && trusted ? Number(input.total) : unit_price * f.quantity + delivery_fee;
  const status = sheet && input.status === 'fake' ? 'fake' : 'new';

  return db.tx(async (t) => {
    const dup = await t.get(`
      SELECT id FROM orders
      WHERE phone = ? AND product_id = ? AND status <> 'fake' AND created_at >= now() - interval '3 days'
      ORDER BY id LIMIT 1`, f.phone, product.id);

    const { rows: [{ id }] } = await t.run(`
      INSERT INTO orders (product_id, quantity, unit_price, delivery_fee, total, customer_name, phone, phone2,
        wilaya_code, commune, address, stop_desk, notes, source, landing_url, utm_source, utm_campaign,
        duplicate_of, company_id, status, sheet_source_id, external_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      product.id, f.quantity, unit_price, delivery_fee, total, f.customer_name, f.phone, f.phone2,
      f.wilaya_code, f.commune, f.address, f.stop_desk, f.notes, source,
      input.landing_url ?? null, input.utm_source ?? null, input.utm_campaign ?? null,
      dup?.id ?? null, route.company_id, status, sheet?.source_id ?? null, sheet?.external_id ?? null,
    );
    await t.run('UPDATE orders SET reference = ? WHERE id = ?', `CMD-${String(id).padStart(6, '0')}`, id);
    const origin = sheet ? `من الشيت ${sheet.name}` : source === 'landing' ? 'من صفحة الهبوط' : 'يدوياً';
    await logEvent(t, id, 'created', origin, userId);
    if (dup) await logEvent(t, id, 'duplicate', `طلبية مكررة محتملة (#${dup.id})`);
    return getOrder(t, id);
  });
}

export async function updateOrder(db, id, input, userId = null) {
  return db.tx(async (t) => {
    const order = await getOrder(t, id, { lock: true });
    if (!EDITABLE.includes(order.status)) throw new HttpError(409, 'لا يمكن تعديل طلبية بعد إرسالها');
    const f = validateOrderFields({ ...order, ...input });
    const route = await resolveRoute(t, f.wilaya_code, order.store_id);
    const unit_price = input.unit_price != null ? Number(input.unit_price) : order.unit_price;
    const delivery_fee = input.delivery_fee != null
      ? Number(input.delivery_fee)
      : (f.wilaya_code !== order.wilaya_code || f.stop_desk !== order.stop_desk)
        ? (f.stop_desk ? route.desk_fee : route.home_fee)
        : order.delivery_fee;
    const company_id = input.company_id !== undefined
      ? (input.company_id ? Number(input.company_id) : null)
      : f.wilaya_code !== order.wilaya_code ? route.company_id : order.company_id;

    if (order.stock_reserved && f.quantity !== order.quantity) {
      await moveStock(t, order.product_id, id, order.quantity - f.quantity, 'تعديل الكمية');
    }
    await t.run(`
      UPDATE orders SET customer_name = ?, phone = ?, phone2 = ?, wilaya_code = ?, commune = ?, address = ?,
        stop_desk = ?, notes = ?, quantity = ?, unit_price = ?, delivery_fee = ?, total = ?, company_id = ?,
        updated_at = now()
      WHERE id = ?`,
      f.customer_name, f.phone, f.phone2, f.wilaya_code, f.commune, f.address, f.stop_desk, f.notes,
      f.quantity, unit_price, delivery_fee, unit_price * f.quantity + delivery_fee, company_id, id,
    );
    await logEvent(t, id, 'edited', null, userId);
    return getOrder(t, id);
  });
}

// Confirmation-team actions. Returns the updated order; confirming also
// triggers the automatic dispatch (see confirmAndDispatch).
export async function applyAction(db, id, action, { userId = null, note = null } = {}) {
  return db.tx(async (t) => {
    const order = await getOrder(t, id, { lock: true });
    const set = (status, extra = '') =>
      t.run(`UPDATE orders SET status = ?, updated_at = now()${extra} WHERE id = ?`, status, id);

    switch (action) {
      case 'no_answer':
        if (!OPEN.includes(order.status)) throw new HttpError(409, 'الحالة لا تسمح');
        await t.run(`UPDATE orders SET status = 'no_answer', call_attempts = call_attempts + 1,
          updated_at = now() WHERE id = ?`, id);
        await logEvent(t, id, 'no_answer', note || `محاولة ${order.call_attempts + 1}`, userId);
        break;
      case 'postpone':
        if (!OPEN.includes(order.status)) throw new HttpError(409, 'الحالة لا تسمح');
        await set('postponed');
        await logEvent(t, id, 'postponed', note, userId);
        break;
      case 'confirm':
        if (!OPEN.includes(order.status)) throw new HttpError(409, 'الطلبية مؤكدة أو مغلقة من قبل');
        await moveStock(t, order.product_id, id, -order.quantity, 'تأكيد طلبية');
        await set('confirmed', ', stock_reserved = true, confirmed_at = now(), dispatch_error = NULL');
        await logEvent(t, id, 'confirmed', note, userId);
        break;
      case 'cancel':
        if (![...OPEN, 'confirmed'].includes(order.status)) throw new HttpError(409, 'لا يمكن إلغاء طلبية مرسلة');
        if (order.stock_reserved) await moveStock(t, order.product_id, id, order.quantity, 'إلغاء طلبية');
        await set('cancelled', ', stock_reserved = false, closed_at = now()');
        await logEvent(t, id, 'cancelled', note, userId);
        break;
      case 'reopen':
        if (!['cancelled', 'fake'].includes(order.status)) throw new HttpError(409, 'الحالة لا تسمح');
        await set('new', ', closed_at = NULL');
        await logEvent(t, id, 'reopened', note, userId);
        break;
      case 'delivered':
        if (order.status !== 'dispatched') throw new HttpError(409, 'الطلبية لم ترسل بعد');
        await set('delivered', ', closed_at = now()');
        await logEvent(t, id, 'delivered', note, userId);
        break;
      case 'returned':
        if (order.status !== 'dispatched') throw new HttpError(409, 'الطلبية لم ترسل بعد');
        if (order.stock_reserved) await moveStock(t, order.product_id, id, order.quantity, 'روتور');
        await set('returned', ', stock_reserved = false, closed_at = now()');
        await logEvent(t, id, 'returned', note, userId);
        break;
      default:
        throw new HttpError(400, `Action inconnue: ${action}`);
    }
    return getOrder(t, id);
  });
}

// Sends a confirmed order to its store's delivery company.
export async function dispatchOrder(db, id, { userId = null, tracking = null } = {}) {
  const order = await getOrder(db, id);
  if (order.status !== 'confirmed') throw new HttpError(409, 'لازم الطلبية تكون مؤكدة');
  const companyId = order.company_id ?? (await resolveRoute(db, order.wilaya_code, order.store_id)).company_id;
  const company = companyId && await db.get('SELECT * FROM delivery_companies WHERE id = ?', companyId);
  const fail = async (msg) => {
    await db.run(`UPDATE orders SET dispatch_error = ?, updated_at = now() WHERE id = ?`, msg, id);
    await logEvent(db, id, 'dispatch_failed', msg, userId);
    return getOrder(db, id);
  };
  if (!company) return fail('ما كاين حتى شركة توصيل مربوطة بهاد البوتيك');
  if (!company.active) return fail(`شركة التوصيل ${company.name} موقفة`);

  const product = await db.get('SELECT * FROM products WHERE id = ?', order.product_id);
  let result;
  try {
    result = tracking ? { tracking } : await getProvider(company.provider).createShipment(company, order, product);
  } catch (err) {
    return fail(err.message);
  }
  // Only flip a still-confirmed order, so a double click cannot record two shipments.
  const { changes } = await db.run(`UPDATE orders SET status = 'dispatched', company_id = ?, tracking = ?, dispatch_error = NULL,
    dispatched_at = now(), updated_at = now() WHERE id = ? AND status = 'confirmed'`,
    company.id, result.tracking ?? null, id);
  if (changes) await logEvent(db, id, 'dispatched', `${company.name}${result.tracking ? ` — ${result.tracking}` : ''}`, userId);
  return getOrder(db, id);
}

export async function confirmAndDispatch(db, id, opts = {}) {
  const order = await applyAction(db, id, 'confirm', opts);
  if (await getSetting(db, 'auto_dispatch') === '0') return order;
  return dispatchOrder(db, id, opts);
}

// Pulls the latest status of dispatched orders from the delivery APIs.
export async function syncTracking(db) {
  const rows = await db.all(`
    SELECT c.*, o.id AS order_id, o.tracking FROM orders o JOIN delivery_companies c ON c.id = o.company_id
    WHERE o.status = 'dispatched' AND o.tracking IS NOT NULL AND c.provider != 'manual'`);
  const summary = { checked: 0, delivered: 0, returned: 0, errors: 0 };
  for (const row of rows) {
    summary.checked += 1;
    try {
      const { status } = await getProvider(row.provider).getStatus(row, row.tracking);
      if (status === 'delivered' || status === 'returned') {
        await applyAction(db, row.order_id, status, { note: 'تحديث أوتوماتيكي من شركة التوصيل' });
        summary[status] += 1;
      }
    } catch {
      summary.errors += 1;
    }
  }
  return summary;
}
