// Old parcels of each store account, read from the delivery company once, so the customer check
// (delivered / returned per phone) also counts what was shipped before the ERP. Read-only on their side.
import { getProvider } from '../delivery/index.js';
import { HttpError, companyAccount } from './orders.js';
import { sheetPhone } from './sheets.js';

const DAYS = 365;

// Every store account whose company's parcels can be read.
export async function historyAccounts(db) {
  const rows = await db.all(`SELECT a.store_id, a.company_id, s.name AS store_name, c.name AS company_name, c.provider
    FROM store_accounts a JOIN stores s ON s.id = a.store_id JOIN delivery_companies c ON c.id = a.company_id
    WHERE a.api_token IS NOT NULL AND a.api_token <> '' ORDER BY s.name, c.name`);
  return rows.filter((r) => getProvider(r.provider)?.listParcels)
    .map(({ provider, ...r }) => r);
}

// One page of one account: keeps the delivered and returned parcels. One page per request
// keeps each call under the function time limit.
export async function importHistoryPage(db, storeId, companyId, page = 1) {
  const company = await companyAccount(db, companyId, storeId);
  if (!company) throw new HttpError(404, 'الشركة غير موجودة');
  const provider = getProvider(company.provider);
  if (!provider?.listParcels) throw new HttpError(400, `ما نقدرش نقرا طرود ${company.name}`);
  const end = new Date();
  const start = new Date(end.getTime() - DAYS * 86400_000);
  const { parcels, last_page } = await provider.listParcels(company, start, end, page);
  let kept = 0;
  for (const p of parcels) {
    const phone = sheetPhone(p.phone);
    if (!p.tracking || !phone || !p.outcome) continue;
    // A parcel the ERP sent itself is already counted from its order.
    if (await db.get('SELECT 1 AS x FROM orders WHERE tracking = ?', String(p.tracking))) continue;
    await db.run(`INSERT INTO customer_history (company_id, tracking, phone, outcome) VALUES (?, ?, ?, ?)
      ON CONFLICT (company_id, tracking) DO UPDATE SET outcome = EXCLUDED.outcome, phone = EXCLUDED.phone`,
    companyId, String(p.tracking), phone, p.outcome);
    kept++;
  }
  return { page, last_page, read: parcels.length, kept };
}
