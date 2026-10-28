import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { PARSERS, wrap } from './db.js';

const MIGRATIONS_DIR = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'netlify/database/migrations');

// Embedded Postgres (PGlite) for local runs and tests: dataDir undefined = in memory.
export async function openLocalDb(dataDir) {
  if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
  const lite = new PGlite(dataDir, { parsers: PARSERS });
  await lite.exec('CREATE TABLE IF NOT EXISTS _local_migrations (name TEXT PRIMARY KEY)');
  const done = new Set((await lite.query('SELECT name FROM _local_migrations')).rows.map((r) => r.name));
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    await lite.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
    await lite.query('INSERT INTO _local_migrations (name) VALUES ($1)', [file]);
  }
  const db = wrap((text, params) => lite.query(text, params), (fn) =>
    lite.transaction((t) => fn(wrap((text, params) => t.query(text, params)))));
  db.close = () => lite.close();
  return db;
}

