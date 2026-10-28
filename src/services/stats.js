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
