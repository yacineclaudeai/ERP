import { getConnectionString } from '@netlify/database';
import { openPgDb } from '../../src/db.js';
import { syncTracking } from '../../src/services/orders.js';

// Every 30 minutes, pull delivered/returned statuses from the delivery companies.
export default async () => {
  const db = openPgDb(getConnectionString());
  try {
    console.log('tracking sync', await syncTracking(db));
  } finally {
    await db.close();
  }
};

export const config = { schedule: '*/30 * * * *' };
