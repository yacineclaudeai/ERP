-- Stores whose accounting a non-admin account may see, as a comma list of
-- store ids. Empty means every store.
ALTER TABLE users ADD COLUMN accounting_store_ids TEXT;
