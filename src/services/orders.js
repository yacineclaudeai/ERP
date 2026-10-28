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

// Company choice, most specific first: the company set on the product, the
// store's exception for this wilaya, the store's own company, the global
// wilaya route, then the default company.
// Shipping fees always come from the global wilaya table.
export async function resolveRoute(db, wilayaCode, storeId = null, productCompanyId = null) {
  const route = await db.get('SELECT * FROM delivery_routes WHERE wilaya_code = ?', wilayaCode);
  const fallback = await getSetting(db, 'default_company_id');
  let companyId = productCompanyId ?? null;
  if (storeId && !companyId) {
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

// A company as one store uses it: the store's own token and key at that
// company win over the company-wide ones.
export async function companyAccount(db, companyId, storeId = null) {
  const company = await db.get('SELECT * FROM delivery_companies WHERE id = ?', companyId);
  if (!company || !storeId) return company;
  const account = await db.get('SELECT api_token, api_key FROM store_accounts WHERE store_id = ? AND company_id = ?', storeId, companyId);
  return { ...company, api_token: account?.api_token || company.api_token, api_key: account?.api_key || null };
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
    SELECT o.*, p.name AS product_name, p.store_id, p.company_id AS product_company_id, s.name AS store_name, c.name AS company_name, c.provider AS company_provider
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
  const route = await resolveRoute(db, f.wilaya_code, product.store_id, product.company_id);
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
    // The product can change only while no stock is held for the order.
    let product = null;
    if (input.product_id != null && Number(input.product_id) !== order.product_id) {
      if (order.stock_reserved) throw new HttpError(409, 'لا يمكن تبديل المنتج بعد التأكيد، ألغي الطلبية وعاود');
      product = await t.get('SELECT * FROM products WHERE id = ?', Number(input.product_id) || 0);
      if (!product) throw new HttpError(404, 'المنتج غير موجود');
    }
    const storeId = product ? product.store_id : order.store_id;
    const productCompanyId = product ? product.company_id : order.product_company_id;
    const route = await resolveRoute(t, f.wilaya_code, storeId, productCompanyId);
    const unit_price = input.unit_price != null ? Number(input.unit_price) : product ? product.price : order.unit_price;
    const delivery_fee = input.delivery_fee != null
      ? Number(input.delivery_fee)
      : (f.wilaya_code !== order.wilaya_code || f.stop_desk !== order.stop_desk)
        ? (f.stop_desk ? route.desk_fee : route.home_fee)
        : order.delivery_fee;
    const company_id = input.company_id !== undefined
      ? (input.company_id ? Number(input.company_id) : null)
      : f.wilaya_code !== order.wilaya_code || product ? route.company_id : order.company_id;

    if (order.stock_reserved && f.quantity !== order.quantity) {
      await moveStock(t, order.product_id, id, order.quantity - f.quantity, 'تعديل الكمية');
    }
    await t.run(`
      UPDATE orders SET product_id = ?, customer_name = ?, phone = ?, phone2 = ?, wilaya_code = ?, commune = ?, address = ?,
        stop_desk = ?, notes = ?, quantity = ?, unit_price = ?, delivery_fee = ?, total = ?, company_id = ?,
        updated_at = now()
      WHERE id = ?`,
      product ? product.id : order.product_id, f.customer_name, f.phone, f.phone2, f.wilaya_code, f.commune, f.address, f.stop_desk, f.notes,
      f.quantity, unit_price, delivery_fee, unit_price * f.quantity + delivery_fee, company_id, id,
    );
    await logEvent(t, id, 'edited', product ? `المنتج: ${product.name}` : null, userId);
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
      case 'reset':
        // Undo no_answer/postpone: back to new, attempts start again.
        if (!['no_answer', 'postponed'].includes(order.status)) throw new HttpError(409, 'الحالة لا تسمح');
        await set('new', ', call_attempts = 0');
        await logEvent(t, id, 'reopened', note || 'رجعت جديدة', userId);
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
  const companyId = order.company_id ?? (await resolveRoute(db, order.wilaya_code, order.store_id, order.product_company_id)).company_id;
  const company = companyId && await companyAccount(db, companyId, order.store_id);
  const fail = async (msg) => {
    await db.run(`UPDATE orders SET dispatch_error = ?, updated_at = now() WHERE id = ?`, msg, id);
    await logEvent(db, id, 'dispatch_failed', msg, userId);
    return getOrder(db, id);
  };
  if (!company) return fail('ما كاين حتى شركة توصيل مربوطة بهاد البوتيك');
  if (!company.active) return fail(`شركة التوصيل ${company.name} موقفة`);
  if (!tracking && company.provider === 'ecotrack' && !company.api_token) {
    return fail(`ما كاينش التوكن تاع ${order.store_name || 'البوتيك'} عند ${company.name}: حطو في صفحة البوتيكات`);
  }

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

// Back to the confirmation page as a new order, to fix a wrong confirmation or
// a parcel sent to the wrong company. A sent parcel is first removed at the
// company; if the company refuses (already picked up), nothing changes here.
export async function backToConfirmation(db, id, { userId = null } = {}) {
  const order = await getOrder(db, id);
  if (!['confirmed', 'dispatched'].includes(order.status)) throw new HttpError(409, 'غير المؤكدة ولا اللي عند التوصيل ترجع للتأكيد');
  let note = 'رجعت للتأكيد';
  if (order.status === 'dispatched' && order.tracking) {
    const company = order.company_id && await companyAccount(db, order.company_id, order.store_id);
    const provider = company && getProvider(company.provider);
    if (provider?.cancelShipment) {
      try {
        await provider.cancelShipment(company, order.tracking);
      } catch (err) {
        throw new HttpError(409, `${company.name} ما قبلتش تحذف الطرد ${order.tracking}: ${err.message}`);
      }
      note = `رجعت للتأكيد، والطرد ${order.tracking} تحذف عند ${company.name}`;
    } else {
      note = `رجعت للتأكيد. الطرد ${order.tracking} لازم يتحذف باليد عند ${company?.name || 'شركة التوصيل'}`;
    }
  }
  return db.tx(async (t) => {
    const current = await getOrder(t, id, { lock: true });
    if (current.status !== order.status) throw new HttpError(409, 'الطلبية تبدلت، عاود حاول');
    if (current.stock_reserved) await moveStock(t, current.product_id, id, current.quantity, 'رجوع للتأكيد');
    await t.run(`UPDATE orders SET status = 'new', stock_reserved = false, tracking = NULL, dispatch_error = NULL,
      confirmed_at = NULL, dispatched_at = NULL, call_attempts = 0, updated_at = now() WHERE id = ?`, id);
    await logEvent(t, id, 'reopened', note, userId);
    return getOrder(t, id);
  });
}

export async function confirmAndDispatch(db, id, opts = {}) {
  const order = await applyAction(db, id, 'confirm', opts);
  if (await getSetting(db, 'auto_dispatch') === '0') return order;
  return dispatchOrder(db, id, opts);
}

// Pulls the latest status of dispatched orders from the delivery APIs.
export async function syncTracking(db) {
  const rows = await db.all(`
    SELECT o.id AS order_id, o.tracking, o.company_id, p.store_id
    FROM orders o JOIN products p ON p.id = o.product_id JOIN delivery_companies c ON c.id = o.company_id
    WHERE o.status = 'dispatched' AND o.tracking IS NOT NULL AND c.provider != 'manual'`);
  const summary = { checked: 0, delivered: 0, returned: 0, errors: 0 };
  for (const row of rows) {
    summary.checked += 1;
    try {
      const company = await companyAccount(db, row.company_id, row.store_id);
      const { status } = await getProvider(company.provider).getStatus(company, row.tracking);
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

// A product moved to another store (branch): its orders not yet sent follow it
// to that store's delivery company.
export async function rerouteProductOrders(db, productId) {
  const product = await db.get('SELECT store_id, company_id FROM products WHERE id = ?', productId);
  if (!product) return 0;
  const orders = await db.all(`SELECT id, wilaya_code FROM orders WHERE product_id = ? AND status IN (${EDITABLE.map(() => '?').join(', ')})`,
    productId, ...EDITABLE);
  for (const o of orders) {
    const route = await resolveRoute(db, o.wilaya_code, product.store_id, product.company_id);
    await db.run('UPDATE orders SET company_id = ?, updated_at = now() WHERE id = ?', route.company_id, o.id);
  }
  return orders.length;
}

// Removes an order that never reached a delivery company; held stock goes back.
export async function deleteOrder(db, id) {
  return db.tx(async (t) => {
    const order = await getOrder(t, id, { lock: true });
    if (['dispatched', 'delivered', 'returned'].includes(order.status)) throw new HttpError(409, 'ما تنجمش تحذف طلبية تبعثت');
    if (order.stock_reserved) await moveStock(t, order.product_id, null, order.quantity, `حذف الطلبية ${order.reference}`);
    await t.run('DELETE FROM order_events WHERE order_id = ?', id);
    await t.run('UPDATE stock_movements SET order_id = NULL WHERE order_id = ?', id);
    await t.run('UPDATE orders SET duplicate_of = NULL WHERE duplicate_of = ?', id);
    await t.run('DELETE FROM orders WHERE id = ?', id);
    return { ok: true };
  });
}
