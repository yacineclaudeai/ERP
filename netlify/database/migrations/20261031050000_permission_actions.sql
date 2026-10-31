-- Permissions per action (Ecotrack-style employee roles). Accounts keep what they could do before:
-- each page they had gets all its actions, except the ones that were for the admin only
-- (see all agents' orders, delete, assign, take back a parcel already at the delivery company).
UPDATE users SET permissions = permissions || ',confirm.add,confirm.edit,confirm.price,confirm.delivery_price,confirm.company,confirm.confirm,confirm.fail,confirm.cancel'
WHERE role <> 'admin' AND ',' || COALESCE(permissions, '') || ',' LIKE '%,confirm,%' AND permissions NOT LIKE '%confirm.%';

UPDATE users SET permissions = permissions || ',tracking.edit,tracking.dispatch,tracking.back,tracking.cancel,tracking.delivered,tracking.returned,tracking.sync'
WHERE role <> 'admin' AND ',' || COALESCE(permissions, '') || ',' LIKE '%,tracking,%' AND permissions NOT LIKE '%tracking.%';

UPDATE users SET permissions = permissions || ',products.edit,products.stock,products.delete'
WHERE role <> 'admin' AND ',' || COALESCE(permissions, '') || ',' LIKE '%,products,%' AND permissions NOT LIKE '%products.%';
