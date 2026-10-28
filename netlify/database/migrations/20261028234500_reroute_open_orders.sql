-- Orders taken before products had their own delivery company kept their
-- store's main company. Unsent orders now follow their product's company
-- (or the store's when the product has none).
UPDATE orders o SET company_id = x.company_id, updated_at = now()
FROM (
  SELECT p.id AS product_id, COALESCE(p.company_id, s.company_id) AS company_id
  FROM products p LEFT JOIN stores s ON s.id = p.store_id
) x
WHERE o.product_id = x.product_id AND x.company_id IS NOT NULL
  AND o.status IN ('new', 'no_answer', 'postponed', 'confirmed')
  AND o.company_id IS DISTINCT FROM x.company_id;
