-- What each non-admin account may see and do, as a comma list of keys
-- (dashboard, stats, confirm, tracking, products, accounting, stores, sheets, delivery, ads).
-- Admins can do everything whatever this says.
ALTER TABLE users ADD COLUMN permissions TEXT;
-- Existing agents keep what they had: dashboard, statistics and both order pages.
UPDATE users SET permissions = 'dashboard,stats,confirm,tracking' WHERE role = 'agent' AND permissions IS NULL;
