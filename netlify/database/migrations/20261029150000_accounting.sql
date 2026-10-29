-- Product accounting (profit of each product): manual values per product and
-- free-form extra expenses. Prices shared by every product live in `settings`
-- (acc_packaging, acc_labels, ...). An empty value means "not set".
CREATE TABLE product_costs (
  product_id INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  batch_qty INTEGER,
  packaging DOUBLE PRECISION,
  labels DOUBLE PRECISION,
  return_packaging DOUBLE PRECISION,
  confirmation DOUBLE PRECISION,
  tracking DOUBLE PRECISION,
  creative DOUBLE PRECISION,
  transport_office DOUBLE PRECISION,
  transport_home DOUBLE PRECISION,
  ads_usd DOUBLE PRECISION,
  fx_rate DOUBLE PRECISION,
  selling BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT
);

CREATE TABLE product_expenses (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_product_expenses_product ON product_expenses(product_id);
