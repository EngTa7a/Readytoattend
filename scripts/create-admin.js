require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');

async function main() {
  const rl = readline.createInterface({ input, output });
  const username = (await rl.question('Admin username: ')).trim();
  const fullName = (await rl.question('Admin full name: ')).trim();
  const password = await rl.question('Admin password (12+ characters): ');
  rl.close();
  if (!username || !fullName || password.length < 12) throw new Error('Username/name required; password must be at least 12 characters');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined });
  try {
    const hash = await bcrypt.hash(password, 12);
    await pool.query(
      `INSERT INTO users(username,password_hash,full_name,role) VALUES($1,$2,$3,'admin')
       ON CONFLICT(username) DO NOTHING`,
      [username, hash, fullName]
    );
    console.log('Admin created if the username was new. If it already existed, no changes were made.');
  } finally { await pool.end(); }
}
main().catch(e => { console.error(e.message); process.exit(1); });
