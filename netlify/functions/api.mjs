import { getConnectionString } from '@netlify/database';
import { openPgDb } from '../../src/db.js';
import { createApp } from '../../src/app.js';

let app;

export default async (req, context) => {
  if (!process.env.SESSION_SECRET) {
    return Response.json({ error: 'SESSION_SECRET is not set in the Netlify environment variables' }, { status: 500 });
  }
  app ||= createApp(openPgDb(getConnectionString()));
  return app.fetch(req, { ip: context.ip });
};

export const config = { path: '/api/*' };
