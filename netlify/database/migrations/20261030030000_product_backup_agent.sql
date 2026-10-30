-- The second and third confirmation agents of a product, chosen by the admin:
-- a failed order of this product goes to the second, then to the third.
ALTER TABLE products ADD COLUMN backup_agent_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE products ADD COLUMN third_agent_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
