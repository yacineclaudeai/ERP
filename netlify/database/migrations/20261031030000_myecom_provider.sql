-- My Ecom Delivery (ecom-dz.com) gets its own API adapter instead of "manual".
ALTER TABLE delivery_companies DROP CONSTRAINT IF EXISTS delivery_companies_provider_check;
ALTER TABLE delivery_companies ADD CONSTRAINT delivery_companies_provider_check
  CHECK (provider IN ('ecotrack', 'myecom', 'sandbox', 'manual'));
UPDATE delivery_companies SET provider = 'myecom', base_url = 'https://ecom-dz.com/api_v2'
WHERE provider = 'manual' AND (base_url LIKE '%ecom-dz.com%' OR name = 'My Ecom Delivery');
