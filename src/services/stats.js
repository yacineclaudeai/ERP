// Calendar day in Algeria for a timestamp column.
export const localDay = (col) => `(${col} AT TIME ZONE 'Africa/Algiers')::date`;

const range = (dayExpr, from, to) => {
  const where = [];
  const args = [];
  if (from) where.push(`${dayExpr} >= ?::date`), args.push(from);
  if (to) where.push(`${dayExpr} <= ?::date`), args.push(to);
  return { sql: where.length ? where.join(' AND ') : '1=1', args };
};

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

export async function getStats(db, { from = null, to = null } = {}) {
  const r = range(localDay('o.created_at'), from, to);

  const byStatus = Object.fromEntries(
    (await db.all(`SELECT status, COUNT(*) AS n FROM orders o WHERE ${r.sql} GROUP BY status`, ...r.args))
      .map((x) => [x.status, x.n]),
  );
  const n = (s) => byStatus[s] || 0;
  const confirmed = n('confirmed') + n('dispatched') + n('delivered') + n('returned');
  const decided = confirmed + n('cancelled');
  const closedShipments = n('delivered') + n('returned');

  const products = await db.all(`
    SELECT p.id, p.name, p.stock, p.cost, p.store_id, s.name AS store_name,
      COUNT(o.id) FILTER (WHERE o.status <> 'fake') AS orders,
      COUNT(o.id) FILTER (WHERE o.status = 'fake') AS fake,
      COUNT(o.id) FILTER (WHERE o.status IN ('confirmed','dispatched','delivered','returned')) AS confirmed,
      COUNT(o.id) FILTER (WHERE o.status = 'cancelled') AS cancelled,
      COUNT(o.id) FILTER (WHERE o.status = 'delivered') AS delivered,
      COUNT(o.id) FILTER (WHERE o.status = 'returned') AS returned,
      SUM(CASE WHEN o.status = 'delivered' THEN o.unit_price * o.quantity ELSE 0 END) AS revenue,
      SUM(CASE WHEN o.status = 'delivered' THEN p.cost * o.quantity ELSE 0 END) AS cogs
    FROM products p LEFT JOIN stores s ON s.id = p.store_id
    LEFT JOIN orders o ON o.product_id = p.id AND ${r.sql}
    GROUP BY p.id, s.name ORDER BY orders DESC, p.id`, ...r.args);

  const ads = range('date', from, to);
  const spend = Object.fromEntries(
    (await db.all(`SELECT product_id, SUM(amount) AS total FROM ad_spend WHERE ${ads.sql} GROUP BY product_id`, ...ads.args))
      .map((x) => [x.product_id, x.total]),
  );

  const perProduct = products.map((p) => {
    const ad_spend = spend[p.id] || 0;
    const revenue = p.revenue || 0;
    const cogs = p.cogs || 0;
    return {
      ...p,
      confirmed: p.confirmed || 0,
      cancelled: p.cancelled || 0,
      delivered: p.delivered || 0,
      returned: p.returned || 0,
      revenue,
      cogs,
      ad_spend,
      profit: revenue - cogs - ad_spend,
      confirmation_rate: pct(p.confirmed || 0, (p.confirmed || 0) + (p.cancelled || 0)),
      delivery_rate: pct(p.delivered || 0, (p.delivered || 0) + (p.returned || 0)),
      cost_per_order: p.orders ? Math.round(ad_spend / p.orders) : null,
      cost_per_delivered: p.delivered ? Math.round(ad_spend / p.delivered) : null,
    };
  });

  const byWilaya = await db.all(`
    SELECT wilaya_code, COUNT(*) AS orders, COUNT(*) FILTER (WHERE status = 'delivered') AS delivered,
      COUNT(*) FILTER (WHERE status = 'returned') AS returned
    FROM orders o WHERE ${r.sql} AND status <> 'fake' GROUP BY wilaya_code ORDER BY orders DESC`, ...r.args);

  const daily = await db.all(`
    SELECT ${localDay('created_at')} AS day, COUNT(*) AS orders,
      COUNT(*) FILTER (WHERE status IN ('confirmed','dispatched','delivered','returned')) AS confirmed
    FROM orders WHERE created_at >= now() - interval '29 days' AND status <> 'fake' GROUP BY day ORDER BY day`);

  const totals = perProduct.reduce(
    (t, p) => ({ revenue: t.revenue + p.revenue, cogs: t.cogs + p.cogs, ad_spend: t.ad_spend + p.ad_spend, profit: t.profit + p.profit }),
    { revenue: 0, cogs: 0, ad_spend: 0, profit: 0 },
  );

  const byStore = Object.values(perProduct.reduce((acc, p) => {
    const key = p.store_id ?? 0;
    const s = (acc[key] ||= { store_id: p.store_id, store_name: p.store_name, orders: 0, delivered: 0, returned: 0, revenue: 0, ad_spend: 0, profit: 0 });
    for (const k of ['orders', 'delivered', 'returned', 'revenue', 'ad_spend', 'profit']) s[k] += p[k];
    return acc;
  }, {}));

  return {
    by_status: byStatus,
    orders: Object.values(byStatus).reduce((a, b) => a + b, 0) - n('fake'),
    fake: n('fake'),
    confirmation_rate: pct(confirmed, decided),
    delivery_rate: pct(n('delivered'), closedShipments),
    ...totals,
    products: perProduct,
    by_store: byStore,
    by_wilaya: byWilaya,
    daily,
    low_stock: await db.all('SELECT id, name, stock FROM products WHERE active AND stock <= 5 ORDER BY stock'),
  };
}

// Ecotrack-style statistics pages: one shop (store), product or agent at a time.
// Confirmation counts orders by the day they came in; delivery counts parcels by
// the day they were sent.
const CONFIRMED = "('confirmed','dispatched','delivered','returned')";
// No "?" in this SQL: the db layer turns every "?" into a parameter.
const OUT_FOR_DELIVERY = "o.delivery_status ~* '(en.{0,1}livraison|sortie|out.{0,1}for|vers.{0,1}client|chez.{0,1}livreur)'";

function performanceFilter({ from, to, store_id, product_id, user_id }, dayCol) {
  const r = range(localDay(dayCol), from, to);
  const where = [r.sql, "o.status <> 'fake'"];
  const args = [...r.args];
  if (store_id) where.push('p.store_id = ?'), args.push(store_id);
  if (product_id) where.push('o.product_id = ?'), args.push(product_id);
  if (user_id) where.push('EXISTS (SELECT 1 FROM order_events e WHERE e.order_id = o.id AND e.user_id = ?)'), args.push(user_id);
  return { sql: where.join(' AND '), args };
}

export async function getConfirmationStats(db, filters = {}) {
  const f = performanceFilter(filters, 'o.created_at');
  const from = 'FROM orders o JOIN products p ON p.id = o.product_id';
  const c = await db.get(`SELECT
      COUNT(*) AS orders,
      COUNT(*) FILTER (WHERE o.status IN ${CONFIRMED}) AS confirmed,
      COUNT(*) FILTER (WHERE o.status = 'cancelled') AS cancelled,
      COUNT(*) FILTER (WHERE o.status = 'no_answer') AS failed,
      COUNT(*) FILTER (WHERE o.status = 'new') AS pending,
      COUNT(*) FILTER (WHERE o.status = 'postponed') AS postponed,
      COUNT(*) FILTER (WHERE o.duplicate_of IS NOT NULL) AS duplicates
    ${from} WHERE ${f.sql}`, ...f.args);
  const daily = (await db.all(`SELECT ${localDay('o.created_at')} AS day, COUNT(*) AS orders,
      COUNT(*) FILTER (WHERE o.status IN ${CONFIRMED}) AS confirmed,
      COUNT(*) FILTER (WHERE o.status = 'cancelled') AS cancelled
    ${from} WHERE ${f.sql} GROUP BY day ORDER BY day`, ...f.args))
    .map((d) => ({ ...d, rate: pct(d.confirmed, d.confirmed + d.cancelled) }));
  // Each agent's work on these orders: the orders they confirmed, cancelled...
  const team = (await db.all(`SELECT u.id, u.username,
      COUNT(DISTINCT e.order_id) FILTER (WHERE e.type = 'confirmed') AS confirmed,
      COUNT(DISTINCT e.order_id) FILTER (WHERE e.type = 'cancelled') AS cancelled,
      COUNT(DISTINCT e.order_id) FILTER (WHERE e.type = 'no_answer') AS failed,
      COUNT(DISTINCT e.order_id) FILTER (WHERE e.type = 'postponed') AS postponed
    FROM order_events e JOIN users u ON u.id = e.user_id
    JOIN orders o ON o.id = e.order_id JOIN products p ON p.id = o.product_id
    WHERE ${f.sql} GROUP BY u.id ORDER BY confirmed DESC, u.username`, ...f.args))
    .map((t) => ({ ...t, rate: pct(t.confirmed, t.confirmed + t.cancelled) }));
  const products = (await db.all(`SELECT p.id, p.name, COUNT(*) AS orders,
      COUNT(*) FILTER (WHERE o.status IN ${CONFIRMED}) AS confirmed,
      COUNT(*) FILTER (WHERE o.status = 'cancelled') AS cancelled
    ${from} WHERE ${f.sql} GROUP BY p.id ORDER BY orders DESC LIMIT 15`, ...f.args))
    .map((p) => ({ ...p, rate: pct(p.confirmed, p.confirmed + p.cancelled) }));
  return { ...c, rate: pct(c.confirmed, c.confirmed + c.cancelled), daily, team, products };
}

export async function getDeliveryStats(db, filters = {}) {
  const f = performanceFilter(filters, 'o.dispatched_at');
  const from = 'FROM orders o JOIN products p ON p.id = o.product_id LEFT JOIN delivery_companies c ON c.id = o.company_id';
  const sent = `o.dispatched_at IS NOT NULL AND o.status IN ('dispatched','delivered','returned')`;
  const d = await db.get(`SELECT
      COUNT(*) AS shipped,
      COUNT(*) FILTER (WHERE o.status = 'dispatched' AND NOT COALESCE(${OUT_FOR_DELIVERY}, false)) AS at_company,
      COUNT(*) FILTER (WHERE o.status = 'dispatched' AND COALESCE(${OUT_FOR_DELIVERY}, false)) AS out_for_delivery,
      COUNT(*) FILTER (WHERE o.status = 'delivered') AS delivered,
      COUNT(*) FILTER (WHERE o.status = 'returned' AND o.return_received_at IS NULL) AS returning,
      COUNT(*) FILTER (WHERE o.status = 'returned' AND o.return_received_at IS NOT NULL) AS returned_back,
      COALESCE(SUM(o.unit_price * o.quantity) FILTER (WHERE o.status = 'delivered'), 0) AS revenue
    ${from} WHERE ${sent} AND ${f.sql}`, ...f.args);
  const waiting = await db.get(`SELECT COUNT(*) AS n FROM orders o JOIN products p ON p.id = o.product_id
    WHERE o.status = 'confirmed' AND ${performanceFilter({ ...filters, from: null, to: null }, 'o.created_at').sql}`,
  ...performanceFilter({ ...filters, from: null, to: null }, 'o.created_at').args);
  const returned = d.returning + d.returned_back;
  const daily = (await db.all(`SELECT ${localDay('o.dispatched_at')} AS day, COUNT(*) AS shipped,
      COUNT(*) FILTER (WHERE o.status = 'delivered') AS delivered,
      COUNT(*) FILTER (WHERE o.status = 'returned') AS returned
    ${from} WHERE ${sent} AND ${f.sql} GROUP BY day ORDER BY day`, ...f.args))
    .map((x) => ({ ...x, rate: pct(x.delivered, x.delivered + x.returned) }));
  const group = async (key, label) => (await db.all(`SELECT ${key} AS key, ${label} AS name, COUNT(*) AS shipped,
      COUNT(*) FILTER (WHERE o.status = 'delivered') AS delivered,
      COUNT(*) FILTER (WHERE o.status = 'returned') AS returned,
      COUNT(*) FILTER (WHERE o.status = 'dispatched') AS in_progress
    ${from} WHERE ${sent} AND ${f.sql} GROUP BY ${key}, ${label} ORDER BY shipped DESC`, ...f.args))
    .map((x) => ({ ...x, rate: pct(x.delivered, x.delivered + x.returned) }));
  return {
    ...d, returned, waiting: waiting.n,
    rate: pct(d.delivered, d.delivered + returned),
    daily,
    companies: await group('o.company_id', 'c.name'),
    wilayas: await group('o.wilaya_code', 'o.wilaya_code'),
    products: (await group('p.id', 'p.name')).slice(0, 15),
  };
}
