-- A product with orders can't be deleted: it can be hidden (archived) from the products page and the pickers instead.
ALTER TABLE products ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false;
