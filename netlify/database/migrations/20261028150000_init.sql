CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('admin', 'agent')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE delivery_companies (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('ecotrack', 'sandbox', 'manual')),
  base_url TEXT,
  api_token TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A store (boutique) ships through its own delivery account and advertises from its own ad account.
CREATE TABLE stores (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  company_id INTEGER REFERENCES delivery_companies(id) ON DELETE SET NULL,
  ad_account_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-store exceptions: this wilaya goes through another company.
CREATE TABLE store_routes (
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  wilaya_code INTEGER NOT NULL CHECK (wilaya_code BETWEEN 1 AND 58),
  company_id INTEGER NOT NULL REFERENCES delivery_companies(id) ON DELETE CASCADE,
  PRIMARY KEY (store_id, wilaya_code)
);

-- Fallback company per wilaya, and what the customer pays for shipping there.
CREATE TABLE delivery_routes (
  wilaya_code INTEGER PRIMARY KEY CHECK (wilaya_code BETWEEN 1 AND 58),
  company_id INTEGER REFERENCES delivery_companies(id) ON DELETE SET NULL,
  home_fee DOUBLE PRECISION NOT NULL DEFAULT 0,
  desk_fee DOUBLE PRECISION NOT NULL DEFAULT 0
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  sku TEXT,
  price DOUBLE PRECISION NOT NULL DEFAULT 0,
  cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  landing_url TEXT,
  public_key TEXT NOT NULL UNIQUE,
  store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  ad_daily_budget DOUBLE PRECISION,
  ad_creative_folder TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  reference TEXT UNIQUE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price DOUBLE PRECISION NOT NULL,
  delivery_fee DOUBLE PRECISION NOT NULL DEFAULT 0,
  total DOUBLE PRECISION NOT NULL,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  phone2 TEXT,
  wilaya_code INTEGER NOT NULL,
  commune TEXT,
  address TEXT,
  stop_desk BOOLEAN NOT NULL DEFAULT false,
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  landing_url TEXT,
  utm_source TEXT,
  utm_campaign TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  call_attempts INTEGER NOT NULL DEFAULT 0,
  duplicate_of INTEGER,
  company_id INTEGER REFERENCES delivery_companies(id) ON DELETE SET NULL,
  tracking TEXT,
  dispatch_error TEXT,
  stock_reserved BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ,
  dispatched_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ
);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_phone ON orders(phone);
CREATE INDEX idx_orders_product ON orders(product_id);
CREATE INDEX idx_orders_created ON orders(created_at);

CREATE TABLE order_events (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_order_events_order ON order_events(order_id);

CREATE TABLE stock_movements (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  quantity INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ad_spend (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  UNIQUE (product_id, date)
);

-- Meta Ads campaigns launched for a product, so they can be paused when stock runs out.
CREATE TABLE ad_campaigns (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  ad_account_id TEXT,
  meta_campaign_id TEXT,
  daily_budget DOUBLE PRECISION NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'stopped')),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ad_campaigns_product ON ad_campaigns(product_id);
