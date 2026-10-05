import { Router } from 'express';
import bcrypt from 'bcryptjs'; import crypto from 'crypto'; import { z } from 'zod';
import { q, tx } from '../config/db';
import { authenticate, signToken, revoked } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { HttpError, wrap } from '../utils/errors';
import { notifyAdmins } from '../services/notify';
const r = Router();
const phone = z.string().regex(/^\+?[0-9 ()-]{7,16}$/, 'Enter a valid phone number');
const pwd = z.string().min(8, 'Password must be at least 8 characters').regex(/[A-Za-z]/, 'Include a letter').regex(/[0-9]/, 'Include a number');
export const publicUser = (u: any) => ({ id: u.id, email: u.email, role: u.role, fullName: u.full_name, phone: u.phone, photoUrl: u.photo_url });

r.post('/register', validate(z.object({ email: z.string().email(), password: pwd, fullName: z.string().min(2), phone })), wrap(async (req, res) => {
  const { email, password, fullName, phone } = req.body;   // public sign-up is CUSTOMER only; other roles are created by Admin
  const hash = await bcrypt.hash(password, 12);
  const u = await tx(async c => {
    const x = await c.query("INSERT INTO users(email,password_hash,role,full_name,phone) VALUES(lower($1),$2,'CUSTOMER',$3,$4) RETURNING *", [email, hash, fullName, phone]);
    await c.query('INSERT INTO customer_profiles(user_id) VALUES($1)', [x.rows[0].id]);
    await c.query('INSERT INTO carts(customer_id) VALUES($1)', [x.rows[0].id]);
    return x.rows[0];
  });
  await notifyAdmins('new_customer', 'New customer registered', fullName);
  res.status(201).json({ token: signToken(u), user: publicUser(u) });
}));
r.post('/login', validate(z.object({ email: z.string().email(), password: z.string().min(1) })), wrap(async (req, res) => {
  const x = await q('SELECT * FROM users WHERE email=lower($1)', [req.body.email]);
  const u = x.rows[0];
  if (!u || !(await bcrypt.compare(req.body.password, u.password_hash))) throw new HttpError(401, 'Incorrect email or password.');
  if (!u.is_active) throw new HttpError(403, 'This account has been deactivated.');
  res.json({ token: signToken(u), user: publicUser(u) });
}));
r.get('/me', authenticate, wrap(async (req, res) => { const x = await q('SELECT * FROM users WHERE id=$1', [req.user.id]); res.json({ user: publicUser(x.rows[0]) }); }));
r.post('/logout', authenticate, (req: any, res) => { revoked.add(req.token); res.json({ ok: true }); });
r.post('/forgot-password', validate(z.object({ email: z.string().email() })), wrap(async (req, res) => {
  const token = crypto.randomBytes(24).toString('hex');
  const x = await q("UPDATE users SET reset_token_hash=$2, reset_expires=now()+interval '30 minutes' WHERE email=lower($1) RETURNING id",
    [req.body.email, crypto.createHash('sha256').update(token).digest('hex')]);
  if (x.rowCount) console.log(`[DEV] password reset token for ${req.body.email}: ${token}`); // TODO: send by email/SMS provider
  res.json({ message: 'If that email exists, a reset code has been sent.' });
}));
r.post('/reset-password', validate(z.object({ token: z.string(), password: pwd })), wrap(async (req, res) => {
  const h = crypto.createHash('sha256').update(req.body.token).digest('hex');
  const x = await q('UPDATE users SET password_hash=$2, reset_token_hash=NULL, reset_expires=NULL WHERE reset_token_hash=$1 AND reset_expires>now() RETURNING id', [h, await bcrypt.hash(req.body.password, 12)]);
  if (!x.rowCount) throw new HttpError(400, 'This reset code is invalid or has expired.');
  res.json({ ok: true });
}));
r.put('/change-password', authenticate, validate(z.object({ currentPassword: z.string(), newPassword: pwd })), wrap(async (req, res) => {
  const u = (await q('SELECT password_hash FROM users WHERE id=$1', [req.user.id])).rows[0];
  if (!(await bcrypt.compare(req.body.currentPassword, u.password_hash))) throw new HttpError(400, 'Current password is incorrect.');
  await q('UPDATE users SET password_hash=$2 WHERE id=$1', [req.user.id, await bcrypt.hash(req.body.newPassword, 12)]);
  res.json({ ok: true });
}));
export default r;
