import { getConnectionString } from '@netlify/database';
import { openPgDb } from '../../src/db.js';
import { syncAllSheets } from '../../src/services/sheets.js';
import { pullAllLinks } from '../../src/services/lightfunnels.js';

// Every 5 minutes, import the new rows of the Google Sheets set up on the "الشيتات" page,
// and the latest LightFunnels orders whose webhook never came (LightFunnels doesn't send every one).
export default async () => {
  const db = openPgDb(getConnectionString());
  try {
    console.log('sheets sync', await syncAllSheets(db));
    console.log('lightfunnels catch-up', JSON.stringify(await pullAllLinks(db)));
  } finally {
    await db.close();
  }
};

export const config = { schedule: '*/5 * * * *' };
