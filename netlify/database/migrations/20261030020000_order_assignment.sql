-- The confirmation agent each order is given to. A non-admin confirmation
-- agent sees only the orders given to them.
ALTER TABLE orders ADD COLUMN assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX idx_orders_assigned ON orders(assigned_to);
-- After this many "no answer", an order goes by itself to the next agent as a new order.
INSERT INTO settings (key, value) VALUES ('auto_transfer_after', '2') ON CONFLICT (key) DO NOTHING;
