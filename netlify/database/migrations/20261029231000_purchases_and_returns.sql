-- What was bought for each product (quantity and price of each purchase), and
-- where each piece is now. A returned parcel is "on its way back" until it is
-- received: only then does its stock come back.
CREATE TABLE product_purchases (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price DOUBLE PRECISION NOT NULL CHECK (unit_price >= 0),
  bought_on DATE NOT NULL DEFAULT CURRENT_DATE,
  added_to_stock BOOLEAN NOT NULL DEFAULT TRUE,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_product_purchases_product ON product_purchases(product_id);

-- Last status text read from the delivery company (e.g. "en_livraison").
ALTER TABLE orders ADD COLUMN delivery_status TEXT;
ALTER TABLE orders ADD COLUMN return_received_at TIMESTAMPTZ;
-- Returns recorded before this change already put their stock back.
UPDATE orders SET return_received_at = COALESCE(closed_at, updated_at) WHERE status = 'returned';
