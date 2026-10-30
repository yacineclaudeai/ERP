-- Direct LightFunnels connection (an app installed on the LightFunnels account):
-- LightFunnels sends every new order to the ERP by webhook.
CREATE TABLE lightfunnels_links (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
  access_token TEXT,
  refresh_token TEXT,
  expires_at TIMESTAMPTZ,
  webhooks TEXT,
  imported_count INTEGER NOT NULL DEFAULT 0,
  last_event_at TIMESTAMPTZ,
  last_error TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Each LightFunnels order is imported once.
CREATE TABLE lightfunnels_orders (
  link_id INTEGER NOT NULL REFERENCES lightfunnels_links(id) ON DELETE CASCADE,
  lf_order_id TEXT NOT NULL,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  PRIMARY KEY (link_id, lf_order_id)
);

-- What LightFunnels sent, kept so a payload we could not read can be fixed later.
CREATE TABLE lightfunnels_events (
  id SERIAL PRIMARY KEY,
  link_id INTEGER REFERENCES lightfunnels_links(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  lf_order_id TEXT,
  payload JSONB,
  status TEXT NOT NULL,
  error TEXT,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_lf_events_link ON lightfunnels_events(link_id, id DESC);
