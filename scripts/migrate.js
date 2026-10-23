require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined });
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const dir = path.join(__dirname, '..', 'db');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
    for (const filename of files) {
      const { rowCount } = await pool.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [filename]);
      if (rowCount) { console.log(`skip ${filename}`); continue; }
      const sql = fs.readFileSync(path.join(dir, filename), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(filename) VALUES ($1)', [filename]);
        await client.query('COMMIT');
        console.log(`applied ${filename}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally { client.release(); }
    }
  } finally { await pool.end(); }
}
main().catch(e => { console.error(e); process.exit(1); });
