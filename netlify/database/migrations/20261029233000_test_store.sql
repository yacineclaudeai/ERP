-- Products being tested (a new campaign) go to the "TEST" store and its "TEST"
-- delivery company until the user moves them to a real store.
INSERT INTO delivery_companies (name, provider)
SELECT 'TEST', 'manual' WHERE NOT EXISTS (SELECT 1 FROM delivery_companies WHERE name = 'TEST');

INSERT INTO stores (name, company_id)
SELECT 'TEST', (SELECT id FROM delivery_companies WHERE name = 'TEST' ORDER BY id LIMIT 1)
ON CONFLICT (name) DO NOTHING;

INSERT INTO settings (key, value)
SELECT 'new_product_store_id', id::text FROM stores WHERE name = 'TEST'
ON CONFLICT (key) DO NOTHING;
