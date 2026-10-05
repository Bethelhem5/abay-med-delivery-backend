import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { q, tx } from '../config/db';
import { authenticate, requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { privateUpload, publicUpload } from '../middleware/upload';
import { HttpError, wrap } from '../utils/errors';
import { announce, haversineSQL, setOrderStatus } from '../services/orders';
import { emitOrder, emitRole } from '../services/realtime';
import { notify } from '../services/notify';
const r = Router(); r.use(authenticate, requireRole('DELIVERY'));
const me = async (uid: string) => { const d = (await q('SELECT * FROM delivery_persons WHERE user_id=$1', [uid])).rows[0]; if (!d) throw new HttpError(404, 'Delivery profile not found.'); return d; };

// delivery sub-status → order status + allowed predecessor
const FLOW: Record<string, { from: string; order: string | null }> = {
  GOING_TO_PHARMACY: { from: 'DELIVERY_ASSIGNED', order: null }, ARRIVED_AT_PHARMACY: { from: 'GOING_TO_PHARMACY', order: null },
  PICKED_UP: { from: 'ARRIVED_AT_PHARMACY', order: 'PICKED_UP' }, ON_THE_WAY: { from: 'PICKED_UP', order: 'ON_THE_WAY' },
  ARRIVED_AT_CUSTOMER: { from: 'ON_THE_WAY', order: 'ARRIVED' }, DELIVERED: { from: 'ARRIVED_AT_CUSTOMER', order: 'DELIVERED' },
};
const ACTIVE = "('DELIVERY_ASSIGNED','GOING_TO_PHARMACY','ARRIVED_AT_PHARMACY','PICKED_UP','ON_THE_WAY','ARRIVED_AT_CUSTOMER')";
const card = (lat: any, lng: any) => `o.id, o.order_number, o.order_type, o.total, o.delivery_fee, o.delivery_address, o.delivery_lat, o.delivery_lng, ph.name pharmacy_name, ph.address pharmacy_address, ph.latitude pharmacy_lat, ph.longitude pharmacy_lng,
  (SELECT string_agg(medicine_name||' x'||quantity, ', ') FROM order_items WHERE order_id=o.id) summary,
  ${haversineSQL('ph.latitude', 'ph.longitude', 'o.delivery_lat', 'o.delivery_lng')} trip_km`;

r.get('/dashboard', wrap(async (req, res) => {
  const d = await me(req.user.id);
  const s = (await q(`SELECT count(*) FILTER (WHERE status='DELIVERED' AND delivered_at::date=CURRENT_DATE) today, COALESCE(sum(fee) FILTER (WHERE status='DELIVERED' AND delivered_at::date=CURRENT_DATE),0) earnings_today,
      count(*) FILTER (WHERE status='DELIVERED') completed, count(*) FILTER (WHERE status IN ${ACTIVE}) active FROM deliveries WHERE delivery_person_id=$1`, [req.user.id])).rows[0];
  const active = (await q(`SELECT d.id delivery_id, d.status delivery_status, ${card(0, 0)} FROM deliveries d JOIN orders o ON o.id=d.order_id JOIN pharmacies ph ON ph.id=o.pharmacy_id WHERE d.delivery_person_id=$1 AND d.status IN ${ACTIVE} LIMIT 1`, [req.user.id])).rows[0] || null;
  res.json({ availability: d.availability, isApproved: d.is_approved, stats: s, active });
}));
r.put('/availability', validate(z.object({ availability: z.enum(['AVAILABLE', 'OFFLINE']) })), wrap(async (req, res) => {
  const d = await me(req.user.id); if (!d.is_approved || d.availability === 'SUSPENDED') throw new HttpError(403, 'Your account is not approved for deliveries yet.');
  if (d.availability === 'BUSY') throw new HttpError(400, 'Finish your active delivery first.');
  await q('UPDATE delivery_persons SET availability=$2 WHERE user_id=$1', [req.user.id, req.body.availability]); res.json({ availability: req.body.availability });
}));
r.get('/available-orders', wrap(async (req, res) => {
  const d = await me(req.user.id); if (!d.is_approved) return res.json({ data: [] });
  const x = await q(`SELECT ${card(0, 0)} FROM orders o JOIN pharmacies ph ON ph.id=o.pharmacy_id WHERE o.status='READY_FOR_PICKUP' AND NOT EXISTS (SELECT 1 FROM deliveries WHERE order_id=o.id)
     AND NOT EXISTS (SELECT 1 FROM delivery_declines WHERE order_id=o.id AND delivery_person_id=$1) ORDER BY (o.order_type='EMERGENCY') DESC, o.created_at`, [req.user.id]);
  res.json({ data: x.rows });
}));
r.get('/orders', wrap(async (req, res) => {
  const x = await q(`SELECT d.id delivery_id, d.status delivery_status, d.fee, d.delivered_at, ${card(0, 0)} FROM deliveries d JOIN orders o ON o.id=d.order_id JOIN pharmacies ph ON ph.id=o.pharmacy_id
    WHERE d.delivery_person_id=$1 AND ($2::text IS NULL OR d.status=$2) AND ($3::text IS NULL OR o.order_number ILIKE $3) ORDER BY d.assigned_at DESC LIMIT 100`, [req.user.id, req.query.status || null, req.query.q ? `%${req.query.q}%` : null]);
  res.json({ data: x.rows });
}));
r.get('/orders/:id', wrap(async (req, res) => {
  const x = (await q(`SELECT d.id delivery_id, d.status delivery_status, o.customer_name, o.customer_phone, o.delivery_instructions, ${card(0, 0)} FROM deliveries d JOIN orders o ON o.id=d.order_id JOIN pharmacies ph ON ph.id=o.pharmacy_id WHERE o.id=$1 AND d.delivery_person_id=$2`, [req.params.id, req.user.id])).rows[0];
  if (!x) throw new HttpError(404, 'Delivery not found.'); res.json({ delivery: x });
}));
async function assign(orderId: string, deliveryUserId: string, actor: string) {
  const order = await tx(async c => {
    const o = (await c.query("SELECT * FROM orders WHERE id=$1 AND status='READY_FOR_PICKUP' FOR UPDATE", [orderId])).rows[0];
    if (!o) throw new HttpError(409, 'This delivery is no longer available.');
    const dp = (await c.query('SELECT * FROM delivery_persons WHERE user_id=$1 FOR UPDATE', [deliveryUserId])).rows[0];
    if (!dp || !dp.is_approved || ['SUSPENDED', 'OFFLINE'].includes(dp.availability)) throw new HttpError(400, 'Delivery person is not available.');
    if (dp.availability === 'BUSY') throw new HttpError(400, 'Delivery person is not available.');
    const otp = String(crypto.randomInt(100000, 999999));
    await c.query('INSERT INTO deliveries(order_id,delivery_person_id,otp,fee) VALUES($1,$2,$3,$4)', [orderId, deliveryUserId, otp, o.delivery_fee]);
    await c.query("UPDATE delivery_persons SET availability='BUSY' WHERE user_id=$1", [deliveryUserId]);
    return setOrderStatus(c, orderId, 'DELIVERY_ASSIGNED', actor, 'Delivery person assigned');
  });
  await announce(order, 'DELIVERY_ASSIGNED');
  const ph = (await q('SELECT user_id FROM pharmacies WHERE id=$1', [order.pharmacy_id])).rows[0];
  await notify(ph.user_id, 'delivery_assigned', `Delivery assigned for #${order.order_number}`, '', order.id);
  await notify(deliveryUserId, 'new_assignment', `New assignment #${order.order_number}`, '', order.id);
  emitRole('DELIVERY', 'delivery_accepted', { orderId }); // hide from others' lists
  return order;
}
export { assign };
r.post('/orders/:id/accept', wrap(async (req, res) => res.json({ order: await assign(req.params.id, req.user.id, req.user.id) })));
r.post('/orders/:id/decline', wrap(async (req, res) => { await q('INSERT INTO delivery_declines(order_id,delivery_person_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [req.params.id, req.user.id]); res.json({ ok: true }); }));

r.put('/orders/:id/status', privateUpload.single('photo'), validate(z.object({ status: z.enum(['GOING_TO_PHARMACY', 'ARRIVED_AT_PHARMACY', 'PICKED_UP', 'ON_THE_WAY', 'ARRIVED_AT_CUSTOMER', 'DELIVERED']), otp: z.string().optional(), notes: z.string().max(500).optional() })), wrap(async (req, res) => {
  const { status, otp, notes } = req.body; const flow = FLOW[status];
  const order = await tx(async c => {
    const d = (await c.query('SELECT * FROM deliveries WHERE order_id=$1 AND delivery_person_id=$2 FOR UPDATE', [req.params.id, req.user.id])).rows[0];
    if (!d) throw new HttpError(404, 'Delivery not found.');
    if (d.status !== flow.from) throw new HttpError(400, 'That step is not available yet. Please follow the delivery steps in order.');
    if (status === 'DELIVERED') { if (!otp || otp !== d.otp) throw new HttpError(400, 'The confirmation code is incorrect. Ask the customer for their 6-digit code.'); }
    await c.query('UPDATE deliveries SET status=$2, notes=COALESCE($3,notes), confirmation_photo=COALESCE($4,confirmation_photo), delivered_at=CASE WHEN $2=\'DELIVERED\' THEN now() ELSE delivered_at END WHERE id=$1', [d.id, status, notes, req.file?.path || null]);
    let o;
    if (flow.order) o = await setOrderStatus(c, req.params.id, flow.order, req.user.id, notes || null);
    else { await c.query('INSERT INTO order_status_history(order_id,status,note,changed_by) VALUES($1,$2,$3,$4)', [req.params.id, status, notes, req.user.id]); o = (await c.query('SELECT * FROM orders WHERE id=$1', [req.params.id])).rows[0]; }
    if (status === 'DELIVERED') { await c.query("UPDATE delivery_persons SET availability='AVAILABLE' WHERE user_id=$1", [req.user.id]); await c.query("UPDATE payments SET status='PAID' WHERE order_id=$1 AND method='CASH_ON_DELIVERY'", [req.params.id]); }
    return { o, flowOrder: flow.order };
  });
  if (order.flowOrder) await announce(order.o, order.flowOrder, notes);
  else emitOrder(req.params.id, 'delivery_status', { orderId: req.params.id, status });
  res.json({ order: order.o, deliveryStatus: status });
}));

// GPS: only stored/broadcast while an active delivery exists
r.put('/location', validate(z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) })), wrap(async (req, res) => {
  const { latitude, longitude } = req.body; const d = await me(req.user.id);
  if (d.availability === 'OFFLINE' || d.availability === 'SUSPENDED') return res.status(204).end();
  await q('UPDATE delivery_persons SET current_lat=$2,current_lng=$3,location_updated_at=now() WHERE user_id=$1', [req.user.id, latitude, longitude]);
  const a = (await q(`SELECT id, order_id FROM deliveries WHERE delivery_person_id=$1 AND status IN ${ACTIVE}`, [req.user.id])).rows[0];
  if (a) { await q('INSERT INTO delivery_locations(delivery_id,latitude,longitude) VALUES($1,$2,$3)', [a.id, latitude, longitude]); emitOrder(a.order_id, 'delivery_location_updated', { orderId: a.order_id, latitude, longitude, at: new Date().toISOString() }); }
  res.json({ ok: true, tracking: !!a });
}));
r.get('/profile', wrap(async (req, res) => res.json({ profile: (await q('SELECT u.id,u.email,u.full_name,u.phone,u.photo_url,dp.* FROM users u JOIN delivery_persons dp ON dp.user_id=u.id WHERE u.id=$1', [req.user.id])).rows[0] })));
r.put('/profile', publicUpload.single('photo'), validate(z.object({ fullName: z.string().min(2).optional(), phone: z.string().regex(/^\+?[0-9 ()-]{7,16}$/).optional(), vehicleType: z.string().optional(), vehiclePlate: z.string().optional(), address: z.string().optional(), emergencyContact: z.string().optional() })), wrap(async (req, res) => {
  const b = req.body;
  await q('UPDATE users SET full_name=COALESCE($2,full_name),phone=COALESCE($3,phone),photo_url=COALESCE($4,photo_url) WHERE id=$1', [req.user.id, b.fullName, b.phone, req.file ? `/files/${req.file.filename}` : null]);
  await q('UPDATE delivery_persons SET vehicle_type=COALESCE($2,vehicle_type),vehicle_plate=COALESCE($3,vehicle_plate),address=COALESCE($4,address),emergency_contact=COALESCE($5,emergency_contact) WHERE user_id=$1', [req.user.id, b.vehicleType, b.vehiclePlate, b.address, b.emergencyContact]);
  res.json({ ok: true });
}));
export default r;
