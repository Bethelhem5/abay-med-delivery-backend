import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import { q } from '../config/db';
import { HttpError, wrap } from '../utils/errors';
export const revoked = new Set<string>(); // swap for Redis in production
export const signToken = (u: { id: string; role: string }) =>
  jwt.sign({ sub: u.id, role: u.role }, process.env.JWT_SECRET!, { expiresIn: '7d' });
export const verifyToken = (t: string): any => {
  if (revoked.has(t)) throw new HttpError(401, 'Session expired. Please sign in again.');
  return jwt.verify(t, process.env.JWT_SECRET!);
};
export const authenticate = wrap(async (req: any, _res, next) => {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.query.token as string);
  if (!token) throw new HttpError(401, 'Please sign in to continue.');
  let p: any; try { p = verifyToken(token); } catch (e) { throw e instanceof HttpError ? e : new HttpError(401, 'Session expired. Please sign in again.'); }
  const r = await q('SELECT id, role, full_name, email, is_active FROM users WHERE id=$1', [p.sub]);
  if (!r.rowCount || !r.rows[0].is_active) throw new HttpError(403, 'This account is not active.');
  req.user = r.rows[0]; req.token = token; next();
});
export const requireRole = (...roles: string[]) => (req: any, _res: Response, next: NextFunction) =>
  roles.includes(req.user?.role) ? next() : next(new HttpError(403, 'You do not have access to this area.'));
// Resolves the pharmacy for owner or staff
export const withPharmacy = wrap(async (req: any, _res, next) => {
  const r = await q(`SELECT p.* FROM pharmacies p WHERE p.user_id=$1
    UNION SELECT p.* FROM pharmacies p JOIN pharmacy_staff s ON s.pharmacy_id=p.id WHERE s.user_id=$1 LIMIT 1`, [req.user.id]);
  if (!r.rowCount) throw new HttpError(404, 'No pharmacy is linked to this account.');
  if (r.rows[0].verification_status !== 'APPROVED' || !r.rows[0].is_active) throw new HttpError(403, 'Your pharmacy is awaiting approval or is inactive.');
  req.pharmacy = r.rows[0]; next();
});
