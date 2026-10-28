import pg from 'pg';

// The schema lives in netlify/database/migrations: Netlify applies it on deploy,
// and the local/test database applies the same files itself (see db-local.js).

// Return counts and sums as numbers, and DATE columns as 'YYYY-MM-DD' strings.
export const PARSERS = { 20: Number, 1700: Number, 1082: (v) => v };
for (const [oid, fn] of Object.entries(PARSERS)) pg.types.setTypeParser(Number(oid), fn);

// SQL is written with `?` placeholders; Postgres wants $1, $2...
const toPg = (sql) => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};

// Small async query API shared by the Postgres pool (production) and PGlite (local, tests).
export function wrap(query, transaction) {
  const db = {
    query: (sql, params = []) => query(toPg(sql), params),
    async all(sql, ...params) {
      return (await db.query(sql, params)).rows;
    },
    async get(sql, ...params) {
      return (await db.query(sql, params)).rows[0];
    },
    async run(sql, ...params) {
      const r = await db.query(sql, params);
      return { changes: r.rowCount ?? r.affectedRows ?? 0, rows: r.rows };
    },
    // Runs fn(db) in a transaction; nested calls reuse the outer one.
    tx: transaction || ((fn) => fn(db)),
  };
  return db;
}

export function openPgDb(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 3 });
  const db = wrap((text, params) => pool.query(text, params), async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(wrap((text, params) => client.query(text, params)));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
  db.close = () => pool.end();
  return db;
}

export async function getSetting(db, key) {
  return (await db.get('SELECT value FROM settings WHERE key = ?', key))?.value ?? null;
}

export async function setSetting(db, key, value) {
  await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    key, value == null ? null : String(value));
}
