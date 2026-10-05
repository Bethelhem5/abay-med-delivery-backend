import fs from 'fs'; import path from 'path'; import { pool } from '../config/db';
(async () => {
  await pool.query('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())');
  const dir = path.join(__dirname, '../../migrations');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    const done = await pool.query('SELECT 1 FROM _migrations WHERE name=$1', [f]);
    if (done.rowCount) continue;
    await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
    await pool.query('INSERT INTO _migrations(name) VALUES($1)', [f]);
    console.log('applied', f);
  }
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
