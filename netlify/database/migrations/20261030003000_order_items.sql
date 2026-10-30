-- An order can hold several products in one parcel. The first product stays on
-- the order row itself; the others are listed here.
CREATE TABLE order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price DOUBLE PRECISION NOT NULL DEFAULT 0
);
CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_order_items_product ON order_items(product_id);

-- Every product line of every order (the order's own product and the extra
-- ones), with the order's status, for counting per product.
CREATE VIEW order_lines AS
  SELECT o.id AS order_id, TRUE AS is_main, o.product_id, o.quantity, o.unit_price,
    o.status, o.stock_reserved, o.return_received_at, o.delivery_status, o.created_at, o.dispatched_at
  FROM orders o
  UNION ALL
  SELECT o.id, FALSE, i.product_id, i.quantity, i.unit_price,
    o.status, o.stock_reserved, o.return_received_at, o.delivery_status, o.created_at, o.dispatched_at
  FROM order_items i JOIN orders o ON o.id = i.order_id;
