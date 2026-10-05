import 'dotenv/config';
import { Pool, PoolClient } from 'pg';
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const q = (text: string, params?: any[]) => pool.query(text, params);
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
}
