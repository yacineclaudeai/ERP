-- Delivery companies under their real names. A store's own account at a
-- company (its token) now lives in store_accounts, so two stores can ship
-- through the same company with different tokens.
CREATE TABLE store_accounts (
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES delivery_companies(id) ON DELETE CASCADE,
  api_token TEXT,
  api_key TEXT,
  PRIMARY KEY (store_id, company_id)
);

-- A product can ship through another company than its store's main one.
ALTER TABLE products ADD COLUMN company_id INTEGER REFERENCES delivery_companies(id) ON DELETE SET NULL;

CREATE TEMP TABLE real_companies (name TEXT, provider TEXT, base_url TEXT, old_name TEXT);
INSERT INTO real_companies VALUES
  ('HHD Express', 'ecotrack', 'https://hhdexpress.ecotrack.dz', 'HHD Express'),
  ('Packers Delivery', 'ecotrack', 'https://packers.ecotrack.dz', 'Packers Delivery'),
  ('DHD Delivery', 'ecotrack', 'https://platform.dhd-dz.com', 'DHD Livraison'),
  ('My Ecom Delivery', 'manual', 'https://ecom-dz.com/api_v2', 'My Ecom Delivery');
INSERT INTO delivery_companies (name, provider, base_url)
SELECT name, provider, base_url FROM real_companies r
WHERE NOT EXISTS (SELECT 1 FROM delivery_companies c WHERE c.name = r.name);

-- The per-store rows added earlier ("Packers Delivery - AZZOU"...) fold into
-- the real company; a token already pasted there moves to the store's account.
CREATE TEMP TABLE folded AS
SELECT old.id AS old_id, new.id AS new_id, s.id AS store_id, old.api_token
FROM real_companies r
JOIN delivery_companies new ON new.name = r.name
JOIN stores s ON true
JOIN delivery_companies old ON old.name = r.old_name || ' - ' || s.name;

INSERT INTO store_accounts (store_id, company_id, api_token)
SELECT store_id, new_id, api_token FROM folded WHERE api_token IS NOT NULL
ON CONFLICT (store_id, company_id) DO NOTHING;
UPDATE orders o SET company_id = f.new_id FROM folded f WHERE o.company_id = f.old_id;
UPDATE stores s SET company_id = f.new_id FROM folded f WHERE s.company_id = f.old_id;
UPDATE store_routes x SET company_id = f.new_id FROM folded f WHERE x.company_id = f.old_id;
UPDATE delivery_routes x SET company_id = f.new_id FROM folded f WHERE x.company_id = f.old_id;
UPDATE settings x SET value = f.new_id::text FROM folded f WHERE x.key = 'default_company_id' AND x.value = f.old_id::text;
DELETE FROM delivery_companies WHERE id IN (SELECT old_id FROM folded);

-- The user's product list: each product with the store and company it ships with.
CREATE TEMP TABLE seed_products (name TEXT, store TEXT, company TEXT);
INSERT INTO seed_products VALUES
  ('Robe N & R', 'AZZOU', 'Packers Delivery'),
  ('ROBE FEMME TENDANCE 2026', 'YACINE', 'Packers Delivery'),
  ('pack 3 robes de nuit', 'YACINE', 'Packers Delivery'),
  ('Robe de chambre très classe', 'YACINE', 'Packers Delivery'),
  ('pyjama namri importation', 'YAMIR', 'Packers Delivery'),
  ('Pyjama a rieurs Importation motif cœur ♥️', 'FLAMANT ROSE', 'Packers Delivery'),
  ('Sport Az importation', 'AZZOU', 'Packers Delivery'),
  ('2pyjamas3pcs2200', 'AZZOU', 'Packers Delivery'),
  ('robe chabka importation N&R', 'YACINE', 'Packers Delivery'),
  ('ROBE SOIRéé', 'YARA', 'Packers Delivery'),
  ('Robe chic pour une femme élégante ✨', 'BOUCHRA', 'DHD Delivery'),
  ('بيجاما باربوري الجديدة 2027', 'FLAMANT ROSE', 'Packers Delivery'),
  ('روب الدخول الاجتماعي', 'YACINE', 'Packers Delivery'),
  ('Pyjama 3 pcs love ❤ coeur', 'DZIRIYA', 'DHD Delivery'),
  ('بيجامة نمري الجديدة 2026', 'AZZOU', 'Packers Delivery'),
  ('Pyjama léopard classe ✨🐆', 'BOUCHRA', 'DHD Delivery'),
  ('Ensemble chiyaka🔥', 'BOUCHRA', 'DHD Delivery'),
  ('Pack 2 pyjamas stitch ( 6 pieces)', 'YARA', 'Packers Delivery'),
  ('Robe leopard corset dentelle', 'BOUCHRA', 'DHD Delivery'),
  ('sport croisé', 'BOUCHRA', 'DHD Delivery'),
  ('Pyjama husste 2026', 'YAMIR', 'Packers Delivery'),
  ('بيجامة نمري الجمال + الدفئ🥰', 'BOUCHRA', 'DHD Delivery'),
  ('Votre Nouveau Look Sportif', 'YACINE', 'Packers Delivery'),
  ('HELLOKITY 3 Pièces', 'YARA', 'Packers Delivery'),
  ('Pyjama vers🔥', 'BOUCHRA', 'DHD Delivery'),
  ('جبة اندلسية  5', 'BOUCHRA', 'DHD Delivery'),
  ('قطيفة بالحزام ✨', 'DZIRIYA', 'DHD Delivery'),
  ('2بيجامات خريفية دج2200', 'YALIM', 'My Ecom Delivery'),
  ('Pyjama lapin importation', 'YARA', 'My Ecom Delivery'),
  ('Robe nemri tendance 🐆', 'YAMIR', 'My Ecom Delivery'),
  ('بيجامة 4 بياس حمراء', 'DZIRIYA', 'DHD Delivery'),
  ('بيجامة 3 بياس هبال', 'YARA', 'Packers Delivery'),
  ('بيجامة ليكات الخريفية', 'YAMIR', 'Packers Delivery'),
  ('Pack de 3 robes', 'YARA', 'Packers Delivery'),
  ('جبة اندلسية 7', 'BOUCHRA', 'DHD Delivery'),
  ('Tenue de sport flash', 'YAMIR', 'Packers Delivery'),
  ('جبة قطيفة روعة', 'BOUCHRA', 'DHD Delivery'),
  ('بجامة قطيفة 5 قطع🐆', 'YALIM', 'My Ecom Delivery'),
  ('بيجامة ثري دي 2026', 'BOUCHRA', 'DHD Delivery'),
  ('Pack pyjama 3 pieces + robe nemri +robe a fleures', 'YARA', 'Packers Delivery'),
  ('باك 2 جبات اندلسية  6', 'BOUCHRA', 'DHD Delivery'),
  ('روب ديكولتي فضفاضة', 'YALIM', 'Packers Delivery'),
  ('Fond de robe sport', 'BOUCHRA', 'DHD Delivery'),
  ('Pyjama katifa la haute qualité', 'DZIRIYA', 'DHD Delivery'),
  ('style namri NV 2026', 'YALIM', 'Packers Delivery'),
  ('ensemble scarf', 'YAMIR', 'Packers Delivery'),
  ('ENSEMBLE POUR ENFANT', 'YACINE', 'Packers Delivery'),
  ('Robe importation nouveau style', 'YACINE', 'Packers Delivery'),
  ('robe plisseé chic 2026', 'YAMIR', 'Packers Delivery'),
  ('Pyjama 4 pièces busteir Namri ✨', 'AZZOU', 'Packers Delivery'),
  ('Pyjama katifa tigrée de haute qualité 🔥', 'YAMIR', 'Packers Delivery'),
  ('بيجامة قطيفة ✨', 'DZIRIYA', 'DHD Delivery'),
  ('انسومبل شتوي importation', 'FLAMANT ROSE', 'Packers Delivery'),
  ('زوج بيجامات demi saison  بـ2200 دج', 'YALIM', 'Packers Delivery'),
  ('بيجامة باربوري étoile 2027', 'YACINE', 'HHD Express'),
  ('Mocassins chic', 'YACINE', 'Packers Delivery'),
  ('بيجامة خريف كيوت 3 بياس', 'AZZOU', 'Packers Delivery'),
  ('Le ✨ choix intelligent', 'DZIRIYA', 'DHD Delivery'),
  ('Pyjama katifa namri 3 couleurs', 'FLAMANT ROSE', 'Packers Delivery'),
  ('باك بيجامة قلب و بيجامة نمر', 'YAMIR', 'Packers Delivery'),
  ('Pyjama 4 pièces ceinture', 'YARA', 'Packers Delivery'),
  ('Pyjama Luxe 4 Pièces', 'YARA', 'Packers Delivery'),
  ('لباس اطفال َAmiriََ', 'YAMIR', 'Packers Delivery'),
  ('Pack 3 بيجامات بـ 3200 دج فقط 😍', 'YAMIR', 'Packers Delivery'),
  ('جبة الاندلسية 3', 'BOUCHRA', 'DHD Delivery'),
  ('Ensemble sport 🤼‍♀️🤸 3 pièces', 'BOUCHRA', 'DHD Delivery'),
  ('Babies orthopédiques perforées', 'YACINE', 'Packers Delivery'),
  ('Pyjama 3 pcs 1400', 'BOUCHRA', 'DHD Delivery'),
  ('sport importation 12', 'YARA', 'Packers Delivery'),
  ('جبة قطيفة tida importation', 'BOUCHRA', 'DHD Delivery'),
  ('اندلسية 4', 'BOUCHRA', 'DHD Delivery'),
  ('Short Bustier Importation', 'YAMIR', 'Packers Delivery'),
  ('robe léopard tendance 2026', 'AZZOU', 'Packers Delivery'),
  ('burkini 3 pieces b chbka', 'YACINE', 'Packers Delivery'),
  ('Pyjama 3 pièces 💕', 'YALIM', 'Packers Delivery'),
  ('Pack 4 vêtements chic', 'YACINE', 'Packers Delivery'),
  ('💕Pack fleurs 🌸 & cœur', 'YACINE', 'Packers Delivery'),
  ('جبة أندلسية offre', 'BOUCHRA', 'DHD Delivery'),
  ('DEUX FONDS de  ROBE 2600 DZ', 'BOUCHRA', 'DHD Delivery'),
  ('Pack 2 pyjamas 3pieces', 'AZZOU', 'Packers Delivery'),
  ('✨ Pack L’Affaire✨', 'YAMIR', 'Packers Delivery'),
  ('بجامة قطيفة luxe la haute qualité', 'YAMIR', 'Packers Delivery'),
  ('Pyjama stitch cute', 'YACINE', 'Packers Delivery'),
  ('Ensemble latitude importation', 'BOUCHRA', 'DHD Delivery'),
  ('روبة قطيفة Gucci لاكلاس', NULL, NULL),
  ('✨ باك متكامل ومتنوع للبيجامات ✨', 'YAMIR', 'Packers Delivery'),
  ('بجامة برومو 5', 'DZIRIYA', 'DHD Delivery'),
  ('Fond de robe  Sport  Nike', NULL, NULL),
  ('Robe soirée katifa nemri', 'YACINE', 'Packers Delivery'),
  ('جوكينغ بنات كيوت💕', NULL, NULL),
  ('Pyjama nemri importation 🐆🖤1900', 'YAMIR', 'Packers Delivery'),
  ('Pyjama a fleurs', 'YACINE', 'Packers Delivery'),
  ('Ensemble Turquie original 🇹🇷 miu miu', NULL, NULL),
  ('بيجامة الصيف 5 بياس', 'YACINE', 'Packers Delivery'),
  ('Joking femme tendance importation', NULL, NULL),
  ('Collection D''été Femme robe LV', 'YAMIR', 'Packers Delivery'),
  ('حجاب  عصري 2027', NULL, NULL),
  ('ENSEMBLE LATITUDE 2027❤️', 'BOUCHRA', 'DHD Delivery'),
  ('Pyjama satin espagnol top qualité 😍', NULL, NULL),
  ('أندلسية 8', 'BOUCHRA', 'DHD Delivery'),
  ('Robe soiree papillon', NULL, NULL),
  ('Robe très classe ✨', NULL, NULL),
  ('بيجامة love ❤️😍', 'YACINE', 'Packers Delivery'),
  ('Robe de nuit nemri tendance', NULL, NULL),
  ('Robe de nuit importation noir ❤️‍🔥', NULL, NULL),
  ('باك الهبال😍 2 سراول قطيفة 1900 دج / 3 ب 2400 دج', NULL, NULL),
  ('Basket Active 2026', NULL, NULL),
  ('Ensemble sport  tendance importation', NULL, NULL),
  ('robe hijab tendance 2026', NULL, NULL),
  ('لباس سبور kitt', NULL, NULL),
  ('Tenue de sport importation 3 pièces manches', NULL, NULL),
  ('pyjama cherry 🍒', NULL, NULL),
  ('Robe de nuit léopard', NULL, NULL),
  ('بيجامة 4 بياس بيستي+ شورت +سروال + فوندغوب', NULL, NULL),
  ('Ensemble garçon 3 pièces importation', NULL, NULL),
  ('Ensemble femme', NULL, NULL),
  ('Robe soirée importation', NULL, NULL),
  ('Pyjama élégante et très classe', NULL, NULL),
  ('Tenues garçons  gucci/LV', NULL, NULL),
  ('لباس سبور قلب/فراز', NULL, NULL);

UPDATE products p SET store_id = s.id, company_id = c.id
FROM seed_products x
LEFT JOIN stores s ON s.name = x.store
LEFT JOIN delivery_companies c ON c.name = x.company
WHERE lower(trim(p.name)) = lower(trim(x.name)) AND x.store IS NOT NULL;

INSERT INTO products (name, public_key, store_id, company_id)
SELECT x.name, 'list-' || md5(x.name || random()::text), s.id, c.id
FROM seed_products x
LEFT JOIN stores s ON s.name = x.store
LEFT JOIN delivery_companies c ON c.name = x.company
WHERE NOT EXISTS (SELECT 1 FROM products p WHERE lower(trim(p.name)) = lower(trim(x.name)));

DROP TABLE seed_products;
DROP TABLE folded;
DROP TABLE real_companies;
