-- The user's 8 stores (boutiques) and the delivery account each ships with today.
-- Each store has its own account, so each gets its own company row; the API
-- tokens are pasted on the "التوصيل" page, never stored here.
-- My Ecom Delivery has no API adapter yet: 'manual' until it does.
CREATE TEMP TABLE seed_stores (store TEXT, company TEXT, provider TEXT, base_url TEXT);
INSERT INTO seed_stores VALUES
  ('YACINE', 'HHD Express', 'ecotrack', 'https://hhdexpress.ecotrack.dz'),
  ('FLAMANT ROSE', 'Packers Delivery', 'ecotrack', 'https://packers.ecotrack.dz'),
  ('BOUCHRA', 'DHD Livraison', 'ecotrack', 'https://platform.dhd-dz.com'),
  ('YARA', 'My Ecom Delivery', 'manual', 'https://ecom-dz.com/api_v2'),
  ('YALIM', 'My Ecom Delivery', 'manual', 'https://ecom-dz.com/api_v2'),
  ('DZIRIYA', 'DHD Livraison', 'ecotrack', 'https://platform.dhd-dz.com'),
  ('AZZOU', 'Packers Delivery', 'ecotrack', 'https://packers.ecotrack.dz'),
  ('YAMIR', 'My Ecom Delivery', 'manual', 'https://ecom-dz.com/api_v2');

INSERT INTO delivery_companies (name, provider, base_url)
SELECT company || ' - ' || store, provider, base_url FROM seed_stores
WHERE NOT EXISTS (SELECT 1 FROM delivery_companies c WHERE c.name = company || ' - ' || store);

INSERT INTO stores (name) SELECT store FROM seed_stores ON CONFLICT (name) DO NOTHING;

-- Only fill a store's company when none was chosen by hand.
UPDATE stores s SET company_id = c.id
FROM seed_stores x JOIN delivery_companies c ON c.name = x.company || ' - ' || x.store
WHERE s.name = x.store AND s.company_id IS NULL;

DROP TABLE seed_stores;
