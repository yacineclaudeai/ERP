import { getConnectionString } from '@netlify/database';
import { openPgDb } from '../../src/db.js';
import { syncAllSheets } from '../../src/services/sheets.js';

// Every 5 minutes, import the new rows of the Google Sheets set up on the "الشيتات" page.
export default async () => {
  const db = openPgDb(getConnectionString());
  try {
    console.log('sheets sync', await syncAllSheets(db));
  } finally {
    await db.close();
  }
};

export const config = { schedule: '*/5 * * * *' };
