import { Router } from 'express';
import bcrypt from 'bcryptjs'; import { z } from 'zod';
import { q, tx } from '../config/db';
import { authenticate, requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { publicUpload } from '../middleware/upload';
import { HttpError, wrap } from '../utils/errors';
import { audit, notify } from '../services/notify';
import { assign } from './delivery';
const r = Router(); r.use(authenticate, requireRole('ADMIN'));
const pg = (req: any) => { const p = Math.max(1, +req.query.page || 1), l = Math.min(100, +req.query.limit || 20); return [l, (p - 1) * l]; };
const range = (req: any) => {  // date filters: today | week | month | custom(from,to)
  const k = req.query.range; if (k === 'today') return ['CURRENT_DATE', "CURRENT_DATE+1"]; if (k === 'week') return ["date_trunc('week',now())", "now()+interval '1 day'"];
  if (k === 'month') return ["date_trunc('month',now())", "now()+interval '1 day'"]; return ['$1::date', '$2::date+1'];
};
// Accepts real booleans (JSON) and "true"/"false" strings (multipart forms). z.coerce.boolean() would turn "false" into true.
const bool = z.union([z.boolean(), z.enum(['true', 'false']).transform(v => v === 'true')]).optional();

r.get('/dashboard', wrap(async (_req, res) => {
  const c = (await q(`SELECT (SELECT count(*) FROM users WHERE role='CUSTOMER') customers, (SELECT count(*) FROM pharmacies) pharmacies, (SELECT count(*) FROM users WHERE role='DELIVERY') delivery_persons,
     (SELECT count(*) FROM medicines) medicines, (SELECT count(*) FROM orders WHERE status IN ('PENDING','PHARMACY_REVIEW')) pending_orders,
     (SELECT count(*) FROM deliveries WHERE status NOT IN ('DELIVERED','CANCELLED')) active_deliveries, (SELECT count(*) FROM orders WHERE status='DELIVERED') completed_orders,
     (SELECT count(*) FROM orders WHERE status='CANCELLED') cancelled_orders, (SELECT count(*) FROM orders WHERE order_type='EMERGENCY' AND status NOT IN ('DELIVERED','CANCELLED','REJECTED')) emergency_orders,
     (SELECT COALESCE(sum(total),0) FROM orders WHERE status='DELIVERED') revenue, (SELECT count(*) FROM pharmacies WHERE verification_status='PENDING') pending_pharmacies`)).rows[0];
  res.json({ stats: c,
    recentOrders: (await q('SELECT o.id,o.order_number,o.status,o.order_type,o.total,o.created_at,o.customer_name,p.name pharmacy_name FROM orders o JOIN pharmacies p ON p.id=o.pharmacy_id ORDER BY o.created_at DESC LIMIT 8')).rows,
    recentPharmacies: (await q('SELECT id,name,verification_status,created_at FROM pharmacies ORDER BY created_at DESC LIMIT 5')).rows,
    recentDelivery: (await q("SELECT u.id,u.full_name,dp.is_approved,u.created_at FROM users u JOIN delivery_persons dp ON dp.user_id=u.id ORDER BY u.created_at DESC LIMIT 5")).rows,
        ordersByDay: (await q(`SELECT created_at::date AS "day", count(*) AS orders, COALESCE(sum(total) FILTER (WHERE status = 'DELIVERED'), 0) AS revenue FROM orders WHERE created_at > now() - interval '14 days' GROUP BY 1 ORDER BY 1`)).rows });}));

/* ---------- PHARMACIES ---------- */
const phSchema = z.object({ name: z.string().min(2), licenseNumber: z.string().min(2, 'License number is required'), registrationNumber: z.string().optional(), tin: z.string().optional(),
  phone: z.string().regex(/^\+?[0-9 ()-]{7,16}$/, 'Enter a valid phone number'), email: z.string().email(), address: z.string().min(5, 'Address is required'), city: z.string().optional(), subCity: z.string().optional(),
  latitude: z.coerce.number().optional(), longitude: z.coerce.number().optional(), openingTime: z.string().optional(), closingTime: z.string().optional(), emergencyAvailable: bool, description: z.string().optional(),
  ownerPassword: z.string().min(8).optional(), ownerName: z.string().optional() });
r.get('/pharmacies', wrap(async (req, res) => { const [l, o] = pg(req); const s = req.query.q ? `%${req.query.q}%` : null;
  res.json({ data: (await q(`SELECT p.*, (SELECT count(*) FROM medicine_inventory WHERE pharmacy_id=p.id) medicine_count, (SELECT count(*) FROM orders WHERE pharmacy_id=p.id) order_count FROM pharmacies p
    WHERE ($1::text IS NULL OR p.name ILIKE $1 OR p.license_number ILIKE $1) AND ($2::text IS NULL OR p.verification_status=$2) ORDER BY p.created_at DESC LIMIT $3 OFFSET $4`, [s, req.query.status || null, l, o])).rows }); }));
r.post('/pharmacies', publicUpload.fields([{ name: 'logo', maxCount: 1 }, { name: 'image', maxCount: 1 }]), validate(phSchema), wrap(async (req, res) => {
  const b = req.body, f: any = req.files || {};
  const ph = await tx(async c => {
    const u = (await c.query("INSERT INTO users(email,password_hash,role,full_name,phone) VALUES(lower($1),$2,'PHARMACY',$3,$4) RETURNING id", [b.email, await bcrypt.hash(b.ownerPassword || 'ChangeMe123!', 12), b.ownerName || b.name, b.phone])).rows[0];
    return (await c.query(`INSERT INTO pharmacies(user_id,name,license_number,registration_number,tin,phone,email,address,city,sub_city,latitude,longitude,opening_time,closing_time,emergency_available,description,logo_url,image_url,verification_status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE(NULLIF($13,'')::time,'08:00'::time),COALESCE(NULLIF($14,'')::time,'21:00'::time),COALESCE($15::boolean,false),$16,$17,$18,'APPROVED') RETURNING *`,
      [u.id, b.name, b.licenseNumber, b.registrationNumber, b.tin, b.phone, b.email, b.address, b.city, b.subCity, b.latitude, b.longitude, b.openingTime, b.closingTime, b.emergencyAvailable, b.description, f.logo?.[0] ? `/files/${f.logo[0].filename}` : null, f.image?.[0] ? `/files/${f.image[0].filename}` : null])).rows[0];
  });
  await audit(req.user.id, 'PHARMACY_CREATE', 'pharmacies', ph.id); res.status(201).json({ pharmacy: ph });
}));
r.get('/pharmacies/:id', wrap(async (req, res) => { const p = (await q('SELECT * FROM pharmacies WHERE id=$1', [req.params.id])).rows[0]; if (!p) throw new HttpError(404, 'Pharmacy not found.');
  res.json({ pharmacy: p, medicines: (await q('SELECT m.name,mi.price,mi.stock_quantity,mi.expiry_date FROM medicine_inventory mi JOIN medicines m ON m.id=mi.medicine_id WHERE mi.pharmacy_id=$1 ORDER BY m.name LIMIT 200', [p.id])).rows,
    orders: (await q('SELECT id,order_number,status,total,created_at FROM orders WHERE pharmacy_id=$1 ORDER BY created_at DESC LIMIT 50', [p.id])).rows }); }));
r.put('/pharmacies/:id', validate(phSchema.partial().extend({ verificationStatus: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(), isActive: bool })), wrap(async (req, res) => {
  const b = req.body;
  const x = await q(`UPDATE pharmacies SET name=COALESCE($2,name),license_number=COALESCE($3,license_number),phone=COALESCE($4,phone),email=COALESCE($5,email),address=COALESCE($6,address),city=COALESCE($7,city),sub_city=COALESCE($8,sub_city),
    latitude=COALESCE($9,latitude),longitude=COALESCE($10,longitude),emergency_available=COALESCE($11,emergency_available),description=COALESCE($12,description),verification_status=COALESCE($13,verification_status),is_active=COALESCE($14,is_active),
    opening_time=COALESCE(NULLIF($15,'')::time,opening_time),closing_time=COALESCE(NULLIF($16,'')::time,closing_time),updated_at=now() WHERE id=$1 RETURNING *`,
    [req.params.id, b.name, b.licenseNumber, b.phone, b.email, b.address, b.city, b.subCity, b.latitude, b.longitude, b.emergencyAvailable, b.description, b.verificationStatus, b.isActive, b.openingTime, b.closingTime]);
  if (!x.rowCount) throw new HttpError(404, 'Pharmacy not found.');
  if (b.verificationStatus) await notify(x.rows[0].user_id, 'pharmacy_status', `Your pharmacy was ${b.verificationStatus.toLowerCase()}`);
  await audit(req.user.id, 'PHARMACY_UPDATE', 'pharmacies', req.params.id, b); res.json({ pharmacy: x.rows[0] });
}));
r.delete('/pharmacies/:id', wrap(async (req, res) => {
  if ((await q("SELECT 1 FROM orders WHERE pharmacy_id=$1 AND status NOT IN ('DELIVERED','CANCELLED','REJECTED')", [req.params.id])).rowCount) throw new HttpError(400, 'This pharmacy has open orders. Deactivate it instead.');
  const x = await q('DELETE FROM pharmacies WHERE id=$1 RETURNING user_id', [req.params.id]).catch(() => { throw new HttpError(400, 'This pharmacy has order history and cannot be deleted. Deactivate it instead.'); });
  if (!x.rowCount) throw new HttpError(404, 'Pharmacy not found.'); await q("UPDATE users SET is_active=false WHERE id=$1", [x.rows[0].user_id]); await audit(req.user.id, 'PHARMACY_DELETE', 'pharmacies', req.params.id); res.json({ ok: true });
}));

/* ---------- DELIVERY PERSONS ---------- */
const dpSchema = z.object({ fullName: z.string().min(2), email: z.string().email(), phone: z.string().regex(/^\+?[0-9 ()-]{7,16}$/), password: z.string().min(8).optional(), idNumber: z.string().optional(), vehicleType: z.string().optional(), vehiclePlate: z.string().optional(), licenseInfo: z.string().optional(), address: z.string().optional(), emergencyContact: z.string().optional() });
r.get('/delivery-persons', wrap(async (req, res) => { const [l, o] = pg(req);
  res.json({ data: (await q(`SELECT u.id,u.full_name,u.email,u.phone,u.is_active,dp.* FROM users u JOIN delivery_persons dp ON dp.user_id=u.id WHERE ($1::text IS NULL OR u.full_name ILIKE $1 OR u.phone ILIKE $1) AND ($2::text IS NULL OR dp.availability=$2) ORDER BY u.created_at DESC LIMIT $3 OFFSET $4`, [req.query.q ? `%${req.query.q}%` : null, req.query.availability || null, l, o])).rows }); }));
r.post('/delivery-persons', validate(dpSchema), wrap(async (req, res) => { const b = req.body;
  const id = await tx(async c => { const u = (await c.query("INSERT INTO users(email,password_hash,role,full_name,phone) VALUES(lower($1),$2,'DELIVERY',$3,$4) RETURNING id", [b.email, await bcrypt.hash(b.password || 'ChangeMe123!', 12), b.fullName, b.phone])).rows[0];
    await c.query('INSERT INTO delivery_persons(user_id,id_number,vehicle_type,vehicle_plate,license_info,address,emergency_contact,is_approved,availability) VALUES($1,$2,$3,$4,$5,$6,$7,true,\'OFFLINE\')', [u.id, b.idNumber, b.vehicleType, b.vehiclePlate, b.licenseInfo, b.address, b.emergencyContact]); return u.id; });
  res.status(201).json({ id }); }));
r.get('/delivery-persons/:id', wrap(async (req, res) => { const x = (await q('SELECT u.id,u.full_name,u.email,u.phone,u.is_active,dp.* FROM users u JOIN delivery_persons dp ON dp.user_id=u.id WHERE u.id=$1', [req.params.id])).rows[0]; if (!x) throw new HttpError(404, 'Delivery person not found.');
  res.json({ person: x, deliveries: (await q('SELECT d.status,d.assigned_at,d.delivered_at,o.order_number FROM deliveries d JOIN orders o ON o.id=d.order_id WHERE d.delivery_person_id=$1 ORDER BY d.assigned_at DESC LIMIT 50', [req.params.id])).rows }); }));
r.put('/delivery-persons/:id', validate(dpSchema.partial().extend({ isApproved: z.boolean().optional(), isActive: z.boolean().optional(), availability: z.enum(['AVAILABLE', 'BUSY', 'OFFLINE', 'SUSPENDED']).optional() })), wrap(async (req, res) => { const b = req.body;
  await q('UPDATE users SET full_name=COALESCE($2,full_name),phone=COALESCE($3,phone),is_active=COALESCE($4,is_active) WHERE id=$1', [req.params.id, b.fullName, b.phone, b.isActive]);
  await q('UPDATE delivery_persons SET id_number=COALESCE($2,id_number),vehicle_type=COALESCE($3,vehicle_type),vehicle_plate=COALESCE($4,vehicle_plate),license_info=COALESCE($5,license_info),address=COALESCE($6,address),emergency_contact=COALESCE($7,emergency_contact),is_approved=COALESCE($8,is_approved),availability=COALESCE($9,availability) WHERE user_id=$1',
    [req.params.id, b.idNumber, b.vehicleType, b.vehiclePlate, b.licenseInfo, b.address, b.emergencyContact, b.isApproved, b.availability]); await audit(req.user.id, 'DELIVERY_UPDATE', 'delivery_persons', req.params.id, b); res.json({ ok: true }); }));
r.delete('/delivery-persons/:id', wrap(async (req, res) => { await q("UPDATE users SET is_active=false WHERE id=$1 AND role='DELIVERY'", [req.params.id]); await q("UPDATE delivery_persons SET availability='SUSPENDED' WHERE user_id=$1", [req.params.id]); res.json({ ok: true }); }));

/* ---------- CUSTOMERS / ORDERS / DELIVERIES / MEDICINES ---------- */
r.get('/customers', wrap(async (req, res) => { const [l, o] = pg(req); res.json({ data: (await q("SELECT id,full_name,email,phone,is_active,created_at,(SELECT count(*) FROM orders WHERE customer_id=users.id) order_count FROM users WHERE role='CUSTOMER' AND ($1::text IS NULL OR full_name ILIKE $1 OR email ILIKE $1) ORDER BY created_at DESC LIMIT $2 OFFSET $3", [req.query.q ? `%${req.query.q}%` : null, l, o])).rows }); }));
r.put('/customers/:id', validate(z.object({ isActive: z.boolean() })), wrap(async (req, res) => { await q("UPDATE users SET is_active=$2 WHERE id=$1 AND role='CUSTOMER'", [req.params.id, req.body.isActive]); res.json({ ok: true }); }));
r.get('/orders', wrap(async (req, res) => { const [l, o] = pg(req); const s = req.query.q ? `%${req.query.q}%` : null; const f: any = req.query.filter;
  res.json({ data: (await q(`SELECT o.id,o.order_number,o.customer_name,p.name pharmacy_name,du.full_name delivery_person,o.total,o.order_type,o.status,pay.status payment_status,o.created_at
    FROM orders o JOIN pharmacies p ON p.id=o.pharmacy_id LEFT JOIN payments pay ON pay.order_id=o.id LEFT JOIN deliveries d ON d.order_id=o.id LEFT JOIN users du ON du.id=d.delivery_person_id
    WHERE ($1::text IS NULL OR o.order_number ILIKE $1 OR o.customer_name ILIKE $1 OR p.name ILIKE $1 OR du.full_name ILIKE $1) AND ($2::text IS NULL OR o.status=$2)
      AND ($3::text IS NULL OR ($3='emergency' AND o.order_type='EMERGENCY') OR ($3='active' AND o.status IN ('DELIVERY_ASSIGNED','PICKED_UP','ON_THE_WAY','ARRIVED')))
    ORDER BY (o.order_type='EMERGENCY' AND o.status NOT IN ('DELIVERED','CANCELLED','REJECTED')) DESC, o.created_at DESC LIMIT $4 OFFSET $5`, [s, req.query.status || null, f || null, l, o])).rows }); }));
r.post('/orders/:id/assign', validate(z.object({ deliveryPersonId: z.string().uuid() })), wrap(async (req, res) => res.json({ order: await assign(req.params.id, req.body.deliveryPersonId, req.user.id) })));
r.get('/deliveries', wrap(async (req, res) => res.json({ data: (await q(`SELECT d.id,d.status,d.assigned_at,d.delivered_at,o.order_number,u.full_name delivery_person FROM deliveries d JOIN orders o ON o.id=d.order_id JOIN users u ON u.id=d.delivery_person_id
  WHERE ($1::text IS NULL OR ($1='active' AND d.status NOT IN ('DELIVERED','CANCELLED')) OR ($1='completed' AND d.status='DELIVERED')) ORDER BY d.assigned_at DESC LIMIT 100`, [req.query.filter || null])).rows })));
r.get('/medicines', wrap(async (req, res) => { const [l, o] = pg(req); res.json({ data: (await q("SELECT m.*, (SELECT count(*) FROM medicine_inventory WHERE medicine_id=m.id) pharmacies FROM medicines m WHERE ($1::text IS NULL OR name ILIKE $1 OR barcode=$2) ORDER BY name LIMIT $3 OFFSET $4", [req.query.q ? `%${req.query.q}%` : null, req.query.q || null, l, o])).rows }); }));

/* ---------- REPORTS ---------- */
r.get('/reports', wrap(async (req, res) => {
  const [a, b] = range(req); const p = a.includes('$') ? [req.query.from || '1970-01-01', req.query.to || '2999-01-01'] : [];
  const W = `created_at>=${a} AND created_at<${b}`;
  const summary = (await q(`SELECT count(*) total_orders, count(*) FILTER (WHERE status='DELIVERED') completed, count(*) FILTER (WHERE status='CANCELLED') cancelled, count(*) FILTER (WHERE status='REJECTED') rejected,
    count(*) FILTER (WHERE order_type='EMERGENCY') emergency, COALESCE(sum(total) FILTER (WHERE status='DELIVERED'),0) revenue FROM orders WHERE ${W}`, p)).rows[0];
  const pharm = (await q(`SELECT p.name, count(*) orders, count(*) FILTER (WHERE o.status='DELIVERED') completed, COALESCE(sum(o.subtotal) FILTER (WHERE o.status='DELIVERED'),0) sales FROM orders o JOIN pharmacies p ON p.id=o.pharmacy_id WHERE ${W.replace(/created_at/g, 'o.created_at')} GROUP BY p.name ORDER BY sales DESC LIMIT 20`, p)).rows;
  const del = (await q(`SELECT u.full_name, count(*) deliveries, round(avg(EXTRACT(EPOCH FROM (d.delivered_at-d.assigned_at))/60)) avg_minutes FROM deliveries d JOIN users u ON u.id=d.delivery_person_id WHERE d.status='DELIVERED' AND d.assigned_at>=${a} AND d.assigned_at<${b} GROUP BY u.full_name ORDER BY deliveries DESC LIMIT 20`, p)).rows;
  const meds = (await q(`SELECT oi.medicine_name, sum(oi.quantity) units, sum(oi.quantity*oi.unit_price) sales FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.status='DELIVERED' AND o.created_at>=${a} AND o.created_at<${b} GROUP BY oi.medicine_name ORDER BY units DESC LIMIT 20`, p)).rows;
  const reg = (await q(`SELECT role, count(*) FROM users WHERE ${W} GROUP BY role`, p)).rows;
  res.json({ summary, pharmacyPerformance: pharm, deliveryPerformance: del, medicineSales: meds, registrations: reg });
}));
export default r;