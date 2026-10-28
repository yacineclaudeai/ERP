-- Google Sheets that orders are imported from (LightFunnels writes one order per row).
-- kind = 'fake' for a sheet of fake orders: they are imported with the 'fake' status.
CREATE TABLE sheet_sources (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  sheet_url TEXT NOT NULL,
  store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'real' CHECK (kind IN ('real', 'fake')),
  mapping JSONB NOT NULL DEFAULT '{}',
  start_row INTEGER NOT NULL DEFAULT 2,
  last_row INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  imported_count INTEGER NOT NULL DEFAULT 0,
  last_sync_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE orders ADD COLUMN sheet_source_id INTEGER REFERENCES sheet_sources(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN external_id TEXT;
CREATE UNIQUE INDEX idx_orders_sheet_row ON orders(sheet_source_id, external_id) WHERE external_id IS NOT NULL;
