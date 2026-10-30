-- Products of the newest 50 in the LightFunnels store that the ERP did not have
-- (compared by name). Existing products are left untouched.
CREATE TEMP TABLE lf_new (name TEXT, price DOUBLE PRECISION);
INSERT INTO lf_new VALUES
  ('بيجامة قطيفة léo ستراس', 2400),
  ('بيجامة قطيفة نمري', 2400),
  ('لباس اطفال روعة مستورد من 8 إلى 16 سنة', 2900),
  ('Ensemble filles importation', 2900),
  ('بيجامات روعة 3200 دج فقط 3', 3200),
  ('Pack 2 pyjama 2200 seulement', 2200),
  ('Pyjama 3 pièces petit cœur', 1900),
  ('Robe coeur importation premier choix', 2900),
  ('peignoir femme importation avec brodé', 2500);

INSERT INTO products (name, price, public_key)
SELECT x.name, x.price, 'lf-' || md5(x.name || random()::text)
FROM lf_new x
WHERE NOT EXISTS (SELECT 1 FROM products p WHERE lower(trim(p.name)) = lower(trim(x.name)));

DROP TABLE lf_new;
