import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('admin', 'agent')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  sku TEXT,
  price REAL NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  landing_url TEXT,
  public_key TEXT NOT NULL UNIQUE,
  store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS delivery_companies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('ecotrack', 'sandbox', 'manual')),
  base_url TEXT,
  api_token TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A store (boutique) ships through its own delivery account by default.
CREATE TABLE IF NOT EXISTS stores (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  company_id INTEGER REFERENCES delivery_companies(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-store exceptions: this wilaya goes through another company.
CREATE TABLE IF NOT EXISTS store_routes (
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  wilaya_code INTEGER NOT NULL CHECK (wilaya_code BETWEEN 1 AND 58),
  company_id INTEGER NOT NULL REFERENCES delivery_companies(id) ON DELETE CASCADE,
  PRIMARY KEY (store_id, wilaya_code)
);

-- Which company delivers each wilaya, and what the customer pays for shipping there.
CREATE TABLE IF NOT EXISTS delivery_routes (
  wilaya_code INTEGER PRIMARY KEY CHECK (wilaya_code BETWEEN 1 AND 58),
  company_id INTEGER REFERENCES delivery_companies(id) ON DELETE SET NULL,
  home_fee REAL NOT NULL DEFAULT 0,
  desk_fee REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  reference TEXT UNIQUE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL,
  delivery_fee REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  phone2 TEXT,
  wilaya_code INTEGER NOT NULL,
  commune TEXT,
  address TEXT,
  stop_desk INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  landing_url TEXT,
  utm_source TEXT,
  utm_campaign TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  call_attempts INTEGER NOT NULL DEFAULT 0,
  duplicate_of INTEGER,
  company_id INTEGER REFERENCES delivery_companies(id),
  tracking TEXT,
  dispatch_error TEXT,
  stock_reserved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at TEXT,
  dispatched_at TEXT,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders(phone);
CREATE INDEX IF NOT EXISTS idx_orders_product ON orders(product_id);

CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  order_id INTEGER REFERENCES orders(id),
  quantity INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ad_spend (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  UNIQUE (product_id, date)
);

-- Meta Ads campaigns launched for a product, so they can be paused when stock runs out.
CREATE TABLE IF NOT EXISTS ad_campaigns (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  ad_account_id TEXT,
  meta_campaign_id TEXT,
  daily_budget REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'stopped')),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ad_campaigns_product ON ad_campaigns(product_id);
`;

export function openDb(file = process.env.DB_PATH || './data/erp.db') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  // Columns added after v1: CREATE TABLE IF NOT EXISTS does not add them to existing databases.
  const storeCols = db.prepare('PRAGMA table_info(stores)').all().map((c) => c.name);
  if (!storeCols.includes('ad_account_id')) db.exec('ALTER TABLE stores ADD COLUMN ad_account_id TEXT');
  const productCols = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
  if (!productCols.includes('ad_daily_budget')) db.exec('ALTER TABLE products ADD COLUMN ad_daily_budget REAL');
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getSetting(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value == null ? null : String(value));
}
