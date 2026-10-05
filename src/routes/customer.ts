import { Router } from 'express';
import { z } from 'zod';
import fs from 'fs'; import path from 'path';
import { q, tx } from '../config/db';
import { authenticate, requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { privateUpload, publicUpload } from '../middleware/upload';
import { HttpError, wrap } from '../utils/errors';
import { announce, restock, setOrderStatus } from '../services/orders';
import { notify, notifyAdmins } from '../services/notify';
import { emitUser } from '../services/realtime';
import { extractMedicines, runOCR } from '../services/ocr';
const r = Router(); r.use(authenticate);

/* ---------- CART ---------- */
const cartId = async (uid: string) => (await q('INSERT INTO carts(customer_id) VALUES($1) ON CONFLICT(customer_id) DO UPDATE SET customer_id=EXCLUDED.customer_id RETURNING id', [uid])).rows[0].id;
r.get('/cart', requireRole('CUSTOMER'), wrap(async (req, res) => {
  const x = await q(`SELECT ci.id, ci.quantity, mi.id inventory_id, mi.price, mi.stock_quantity, m.name, m.image_url, m.prescription_required, p.id pharmacy_id, p.name pharmacy_name,
      (mi.expiry_date IS NOT NULL AND mi.expiry_date<=CURRENT_DATE) expired
    FROM carts c JOIN cart_items ci ON ci.cart_id=c.id JOIN medicine_inventory mi ON mi.id=ci.inventory_id
    JOIN medicines m ON m.id=mi.medicine_id JOIN pharmacies p ON p.id=mi.pharmacy_id WHERE c.customer_id=$1 ORDER BY p.name, m.name`, [req.user.id]);
  const groups: any = {}; let total = 0;
  for (const i of x.rows) { (groups[i.pharmacy_id] ||= { pharmacyId: i.pharmacy_id, pharmacyName: i.pharmacy_name, items: [], subtotal: 0 }); const g = groups[i.pharmacy_id];
    g.items.push(i); g.subtotal += +i.price * i.quantity; total += +i.price * i.quantity; }
  res.json({ groups: Object.values(groups), total, requiresPrescription: x.rows.some(i => i.prescription_required) });
}));
r.post('/cart/items', requireRole('CUSTOMER'), validate(z.object({ inventoryId: z.string().uuid(), quantity: z.number().int().min(1).max(99).default(1) })), wrap(async (req, res) => {
  const inv = (await q('SELECT * FROM medicine_inventory WHERE id=$1 AND is_active', [req.body.inventoryId])).rows[0];
  if (!inv) throw new HttpError(404, 'No medicine found.');
  if (inv.expiry_date && new Date(inv.expiry_date) <= new Date()) throw new HttpError(400, 'This medicine has expired and cannot be ordered.');
  const cid = await cartId(req.user.id);
  const cur = (await q('SELECT quantity FROM cart_items WHERE cart_id=$1 AND inventory_id=$2', [cid, inv.id])).rows[0]?.quantity || 0;
  if (cur + req.body.quantity > inv.stock_quantity) throw new HttpError(400, 'This medicine is currently out of stock for that quantity.');
  await q('INSERT INTO cart_items(cart_id,inventory_id,quantity) VALUES($1,$2,$3) ON CONFLICT(cart_id,inventory_id) DO UPDATE SET quantity=cart_items.quantity+EXCLUDED.quantity', [cid, inv.id, req.body.quantity]);
  res.status(201).json({ ok: true });
}));
r.put('/cart/items/:id', requireRole('CUSTOMER'), validate(z.object({ quantity: z.number().int().min(1).max(99) })), wrap(async (req, res) => {
  const x = await q(`UPDATE cart_items ci SET quantity=$3 FROM carts c, medicine_inventory mi WHERE ci.id=$1 AND c.id=ci.cart_id AND c.customer_id=$2 AND mi.id=ci.inventory_id AND mi.stock_quantity>=$3 RETURNING ci.id`, [req.params.id, req.user.id, req.body.quantity]);
  if (!x.rowCount) throw new HttpError(400, 'This medicine is currently out of stock for that quantity.'); res.json({ ok: true });
}));
r.delete('/cart/items/:id', requireRole('CUSTOMER'), wrap(async (req, res) => {
  await q('DELETE FROM cart_items USING carts c WHERE cart_items.id=$1 AND c.id=cart_items.cart_id AND c.customer_id=$2', [req.params.id, req.user.id]); res.json({ ok: true });
}));

/* ---------- PRESCRIPTIONS ---------- */
r.post('/prescriptions/scan', requireRole('CUSTOMER'), privateUpload.single('image'), wrap(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Please choose a prescription image.');
  const p = (await q("INSERT INTO prescriptions(customer_id,file_path) VALUES($1,$2) RETURNING id", [req.user.id, req.file.path])).rows[0];
  let text = ''; try { text = await runOCR(req.file.path); } catch (e) { console.error('OCR failed', e); }
  const meds = await extractMedicines(text);
  await q("UPDATE prescriptions SET raw_text=$2, status='SCANNED' WHERE id=$1", [p.id, text]);
  const saved = [];
  for (const m of meds) saved.push((await q('INSERT INTO prescription_medicines(prescription_id,name,strength,dosage,quantity,confidence) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [p.id, m.name, m.strength, m.dosage, m.quantity, m.confidence])).rows[0]);
  res.status(201).json({ prescriptionId: p.id, medicines: saved.map(m => ({ id: m.id, name: m.name, strength: m.strength, dosage: m.dosage, quantity: m.quantity, confidence: +m.confidence })),
    message: meds.length ? 'Please review the extracted medicines. Prescription medicines require pharmacy verification.' : 'Your prescription could not be read clearly. Please upload another image, or add the medicines manually.' });
}));
r.post('/prescriptions', requireRole('CUSTOMER'), privateUpload.single('image'), wrap(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Please choose a prescription image.');
  const p = await q('INSERT INTO prescriptions(customer_id,file_path) VALUES($1,$2) RETURNING id,status,created_at', [req.user.id, req.file.path]);
  res.status(201).json({ prescription: p.rows[0] });
}));
r.get('/prescriptions', requireRole('CUSTOMER'), wrap(async (req, res) => res.json({ data: (await q('SELECT id,status,created_at FROM prescriptions WHERE customer_id=$1 ORDER BY created_at DESC', [req.user.id])).rows })));
r.get('/prescriptions/:id', requireRole('CUSTOMER'), wrap(async (req, res) => {
  const p = await q('SELECT id,status,created_at FROM prescriptions WHERE id=$1 AND customer_id=$2', [req.params.id, req.user.id]);
  if (!p.rowCount) throw new HttpError(404, 'Prescription not found.');
  res.json({ prescription: p.rows[0], medicines: (await q('SELECT * FROM prescription_medicines WHERE prescription_id=$1', [req.params.id])).rows });
}));
// Customer corrections to OCR output
r.put('/prescriptions/:id/medicines', requireRole('CUSTOMER'), validate(z.object({ medicines: z.array(z.object({ name: z.string().min(1), strength: z.string().nullish(), dosage: z.string().nullish(), quantity: z.string().nullish() })) })), wrap(async (req, res) => {
  if (!(await q('SELECT 1 FROM prescriptions WHERE id=$1 AND customer_id=$2', [req.params.id, req.user.id])).rowCount) throw new HttpError(404, 'Prescription not found.');
  await tx(async c => { await c.query('DELETE FROM prescription_medicines WHERE prescription_id=$1', [req.params.id]);
    for (const m of req.body.medicines) await c.query('INSERT INTO prescription_medicines(prescription_id,name,strength,dosage,quantity,confidence,edited_by_customer) VALUES($1,$2,$3,$4,$5,1,true)', [req.params.id, m.name, m.strength, m.dosage, m.quantity]); });
  res.json({ ok: true });
}));
// Authenticated access only: owner, admin, or the pharmacy that received an order with this prescription
r.get('/prescriptions/:id/file', wrap(async (req, res) => {
  const p = (await q(`SELECT pr.* FROM prescriptions pr WHERE pr.id=$1 AND ($2='ADMIN' OR pr.customer_id=$3 OR EXISTS
     (SELECT 1 FROM orders o JOIN pharmacies ph ON ph.id=o.pharmacy_id WHERE o.prescription_id=pr.id AND ph.user_id=$3))`, [req.params.id, req.user.role, req.user.id])).rows[0];
  if (!p || !fs.existsSync(p.file_path)) throw new HttpError(404, 'Prescription not found.');
  res.sendFile(path.resolve(p.file_path));
}));
// Search stock for the (reviewed) prescription medicines
r.get('/prescriptions/:id/availability', requireRole('CUSTOMER'), wrap(async (req, res) => {
  const meds = (await q('SELECT pm.* FROM prescription_medicines pm JOIN prescriptions p ON p.id=pm.prescription_id WHERE p.id=$1 AND p.customer_id=$2', [req.params.id, req.user.id])).rows;
  const out = [];
  for (const m of meds) out.push({ prescriptionMedicine: m, offers: (await q(`SELECT mi.id inventory_id, m.name, m.strength, mi.price, mi.stock_quantity, p.id pharmacy_id, p.name pharmacy_name
    FROM medicine_inventory mi JOIN medicines m ON m.id=mi.medicine_id JOIN pharmacies p ON p.id=mi.pharmacy_id
    WHERE p.verification_status='APPROVED' AND p.is_active AND mi.is_active AND mi.stock_quantity>0 AND (mi.expiry_date IS NULL OR mi.expiry_date>CURRENT_DATE)
    AND (m.name ILIKE $1 OR m.generic_name ILIKE $1 OR m.brand_name ILIKE $1) ORDER BY mi.price LIMIT 10`, [`%${m.name}%`])).rows });
  res.json({ data: out });
}));

/* ---------- ORDERS ---------- */
const orderSchema = z.object({
  addressId: z.string().uuid().optional(),
  address: z.object({ addressLine: z.string().min(5), latitude: z.number().optional(), longitude: z.number().optional() }).optional(),
  customerName: z.string().min(2).optional(), customerPhone: z.string().regex(/^\+?[0-9 ()-]{7,16}$/, 'Enter a valid phone number').optional(),
  orderType: z.enum(['STANDARD', 'EMERGENCY']).default('STANDARD'),
  paymentMethod: z.enum(['CASH_ON_DELIVERY', 'MOBILE_PAYMENT', 'CARD']).default('CASH_ON_DELIVERY'),
  prescriptionId: z.string().uuid().optional(), instructions: z.string().max(500).optional(),
});
r.post('/orders', requireRole('CUSTOMER'), validate(orderSchema), wrap(async (req, res) => {
  const b = req.body; const uid = req.user.id;
  let addr = b.address;
  if (b.addressId) { const a = (await q('SELECT * FROM addresses WHERE id=$1 AND user_id=$2', [b.addressId, uid])).rows[0]; if (!a) throw new HttpError(400, 'Please select a valid delivery address.');
    addr = { addressLine: a.address_line, latitude: a.latitude, longitude: a.longitude }; }
  if (!addr) throw new HttpError(400, 'Please select a delivery address.');
  const me = (await q('SELECT full_name, phone FROM users WHERE id=$1', [uid])).rows[0];
  const created: any[] = await tx(async c => {
    const items = (await c.query(`SELECT ci.id cart_item_id, ci.quantity, mi.id inventory_id, mi.price, mi.stock_quantity, mi.expiry_date, mi.is_active, m.name, m.prescription_required, p.id pharmacy_id, p.name pharmacy_name, p.is_active p_active, p.verification_status, p.emergency_available,
        (p.is_24h OR localtime BETWEEN p.opening_time AND p.closing_time) is_open
      FROM carts ct JOIN cart_items ci ON ci.cart_id=ct.id JOIN medicine_inventory mi ON mi.id=ci.inventory_id JOIN medicines m ON m.id=mi.medicine_id JOIN pharmacies p ON p.id=mi.pharmacy_id
      WHERE ct.customer_id=$1 FOR UPDATE OF mi`, [uid])).rows;
    if (!items.length) throw new HttpError(400, 'Your cart is empty.');
    const needsRx = items.some(i => i.prescription_required);
    if (needsRx && !b.prescriptionId) throw new HttpError(400, 'Prescription verification is required.');
    if (b.prescriptionId && !(await c.query('SELECT 1 FROM prescriptions WHERE id=$1 AND customer_id=$2', [b.prescriptionId, uid])).rowCount) throw new HttpError(400, 'Prescription not found.');
    for (const i of items) {
      if (!i.is_active || !i.p_active || i.verification_status !== 'APPROVED') throw new HttpError(400, `${i.name} is no longer available.`);
      if (i.expiry_date && new Date(i.expiry_date) <= new Date()) throw new HttpError(400, `${i.name} has expired and cannot be ordered.`);
      if (i.stock_quantity < i.quantity) throw new HttpError(400, `${i.name} is currently out of stock for that quantity.`);
      if (!i.is_open && b.orderType !== 'EMERGENCY') throw new HttpError(400, `${i.pharmacy_name} is currently closed.`);
      if (b.orderType === 'EMERGENCY' && !i.emergency_available) throw new HttpError(400, `${i.pharmacy_name} does not offer emergency delivery.`);
    }
    const byPharm: Record<string, any[]> = {}; items.forEach(i => (byPharm[i.pharmacy_id] ||= []).push(i));   // one order per pharmacy
    const out = [];
    for (const [pid, list] of Object.entries(byPharm)) {
      const subtotal = list.reduce((s, i) => s + +i.price * i.quantity, 0), fee = b.orderType === 'EMERGENCY' ? 100 : 50;
      const rx = list.some(i => i.prescription_required);
      const num = 'AMD' + (await c.query("SELECT nextval('order_seq') n")).rows[0].n;
      const o = (await c.query(`INSERT INTO orders(order_number,customer_id,pharmacy_id,order_type,status,subtotal,delivery_fee,total,customer_name,customer_phone,delivery_address,delivery_lat,delivery_lng,delivery_instructions,prescription_id,prescription_status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
        [num, uid, pid, b.orderType, rx ? 'PHARMACY_REVIEW' : 'PENDING', subtotal, fee, subtotal + fee, b.customerName || me.full_name, b.customerPhone || me.phone, addr.addressLine, addr.latitude ?? null, addr.longitude ?? null, b.instructions ?? null, rx ? b.prescriptionId : null, rx ? 'PENDING' : 'NOT_REQUIRED'])).rows[0];
      for (const i of list) {
        await c.query('INSERT INTO order_items(order_id,inventory_id,medicine_name,quantity,unit_price,prescription_required) VALUES($1,$2,$3,$4,$5,$6)', [o.id, i.inventory_id, i.name, i.quantity, i.price, i.prescription_required]);
        await c.query('UPDATE medicine_inventory SET stock_quantity=stock_quantity-$2, updated_at=now() WHERE id=$1', [i.inventory_id, i.quantity]);   // reserve stock
      }
      await c.query('INSERT INTO payments(order_id,method,amount) VALUES($1,$2,$3)', [o.id, b.paymentMethod, o.total]);
      await c.query('INSERT INTO order_status_history(order_id,status,changed_by) VALUES($1,$2,$3)', [o.id, o.status, uid]);
      out.push(o);
    }
    await c.query('DELETE FROM cart_items USING carts WHERE carts.id=cart_items.cart_id AND carts.customer_id=$1', [uid]);
    return out;
  });
  for (const o of created) {
    const ph = (await q('SELECT user_id FROM pharmacies WHERE id=$1', [o.pharmacy_id])).rows[0];
    const emg = o.order_type === 'EMERGENCY' ? '🚨 EMERGENCY ' : '';
    await notify(ph.user_id, 'order_created', `${emg}New order #${o.order_number}`, o.prescription_status === 'PENDING' ? 'Prescription needs review' : '', o.id);
    emitUser(ph.user_id, 'order_created', { orderId: o.id, orderNumber: o.order_number, emergency: !!emg });
    await notify(uid, 'order_created', `Order #${o.order_number} placed`, 'Waiting for the pharmacy to confirm.', o.id);
    if (emg) await notifyAdmins('emergency_order', `Emergency order #${o.order_number}`, '', o.id);
    else await notifyAdmins('order_created', `New order #${o.order_number}`, '', o.id);
  }
  res.status(201).json({ orders: created });
}));
r.get('/orders', requireRole('CUSTOMER'), wrap(async (req, res) => {
  const p = Math.max(1, +req.query.page || 1), l = Math.min(50, +req.query.limit || 20);
  const x = await q(`SELECT o.id,o.order_number,o.status,o.order_type,o.total,o.created_at,o.prescription_status,ph.name pharmacy_name,pay.status payment_status,d.status delivery_status,
      (SELECT string_agg(medicine_name||' x'||quantity, ', ') FROM order_items WHERE order_id=o.id) summary
    FROM orders o JOIN pharmacies ph ON ph.id=o.pharmacy_id LEFT JOIN payments pay ON pay.order_id=o.id LEFT JOIN deliveries d ON d.order_id=o.id
    WHERE o.customer_id=$1 AND ($2::text IS NULL OR o.status=$2) ORDER BY o.created_at DESC LIMIT $3 OFFSET $4`, [req.user.id, req.query.status || null, l, (p - 1) * l]);
  res.json({ data: x.rows });
}));
r.get('/orders/:id', wrap(async (req, res) => {
  const o = (await q(`SELECT o.*, ph.name pharmacy_name, ph.address pharmacy_address, ph.latitude pharmacy_lat, ph.longitude pharmacy_lng, ph.phone pharmacy_phone,
      pay.method payment_method, pay.status payment_status, d.status delivery_status, d.otp, d.delivery_person_id, u.full_name courier_name, u.phone courier_phone, dp.current_lat courier_lat, dp.current_lng courier_lng
    FROM orders o JOIN pharmacies ph ON ph.id=o.pharmacy_id LEFT JOIN payments pay ON pay.order_id=o.id LEFT JOIN deliveries d ON d.order_id=o.id
    LEFT JOIN users u ON u.id=d.delivery_person_id LEFT JOIN delivery_persons dp ON dp.user_id=d.delivery_person_id
    WHERE o.id=$1 AND ($2='ADMIN' OR o.customer_id=$3 OR ph.user_id=$3 OR d.delivery_person_id=$3)`, [req.params.id, req.user.role, req.user.id])).rows[0];
  if (!o) throw new HttpError(404, 'Order not found.');
  if (req.user.role !== 'CUSTOMER') delete o.otp;                       // only the customer sees the delivery OTP
  if (o.status === 'DELIVERED') delete o.otp;
  const items = (await q('SELECT * FROM order_items WHERE order_id=$1', [o.id])).rows;
  const timeline = (await q('SELECT status,note,created_at FROM order_status_history WHERE order_id=$1 ORDER BY created_at, id', [o.id])).rows;
  res.json({ order: o, items, timeline });
}));
r.post('/orders/:id/cancel', requireRole('CUSTOMER'), validate(z.object({ reason: z.string().max(300).optional() })), wrap(async (req, res) => {
  const order = await tx(async c => {
    const o = (await c.query('SELECT * FROM orders WHERE id=$1 AND customer_id=$2 FOR UPDATE', [req.params.id, req.user.id])).rows[0];
    if (!o) throw new HttpError(404, 'Order not found.');
    if (!['PENDING', 'PHARMACY_REVIEW', 'CONFIRMED', 'PREPARING'].includes(o.status)) throw new HttpError(400, 'This order can no longer be cancelled.');
    await restock(c, o.id); await c.query("UPDATE payments SET status=CASE WHEN status='PAID' THEN 'REFUNDED' ELSE status END WHERE order_id=$1", [o.id]);
    return setOrderStatus(c, o.id, 'CANCELLED', req.user.id, req.body.reason || 'Cancelled by customer');
  });
  await announce(order, 'CANCELLED', req.body.reason); res.json({ order });
}));
r.post('/reviews', requireRole('CUSTOMER'), validate(z.object({ orderId: z.string().uuid(), pharmacyRating: z.number().int().min(1).max(5).optional(), pharmacyReview: z.string().max(500).optional(), deliveryRating: z.number().int().min(1).max(5).optional(), deliveryReview: z.string().max(500).optional() })), wrap(async (req, res) => {
  const b = req.body; const o = (await q("SELECT o.pharmacy_id, d.delivery_person_id FROM orders o LEFT JOIN deliveries d ON d.order_id=o.id WHERE o.id=$1 AND o.customer_id=$2 AND o.status='DELIVERED'", [b.orderId, req.user.id])).rows[0];
  if (!o) throw new HttpError(400, 'You can review an order after it has been delivered.');
  if (b.pharmacyRating) await q("INSERT INTO reviews(order_id,customer_id,pharmacy_id,target,rating,comment) VALUES($1,$2,$3,'PHARMACY',$4,$5)", [b.orderId, req.user.id, o.pharmacy_id, b.pharmacyRating, b.pharmacyReview]);
  if (b.deliveryRating && o.delivery_person_id) await q("INSERT INTO reviews(order_id,customer_id,delivery_person_id,target,rating,comment) VALUES($1,$2,$3,'DELIVERY',$4,$5)", [b.orderId, req.user.id, o.delivery_person_id, b.deliveryRating, b.deliveryReview]);
  res.status(201).json({ ok: true });
}));

/* ---------- PROFILE / ADDRESSES / REFILLS / NOTIFICATIONS ---------- */
r.get('/customer/profile', requireRole('CUSTOMER'), wrap(async (req, res) => {
  const x = await q('SELECT u.id,u.email,u.full_name,u.phone,u.photo_url,cp.date_of_birth,cp.emergency_contact_name,cp.emergency_contact_phone FROM users u LEFT JOIN customer_profiles cp ON cp.user_id=u.id WHERE u.id=$1', [req.user.id]);
  res.json({ profile: x.rows[0], addresses: (await q('SELECT * FROM addresses WHERE user_id=$1 ORDER BY is_default DESC, created_at', [req.user.id])).rows });
}));
r.put('/customer/profile', requireRole('CUSTOMER'), publicUpload.single('photo'), validate(z.object({ fullName: z.string().min(2).optional(), phone: z.string().regex(/^\+?[0-9 ()-]{7,16}$/).optional(), dateOfBirth: z.string().optional(), emergencyContactName: z.string().optional(), emergencyContactPhone: z.string().optional() })), wrap(async (req, res) => {
  const b = req.body;
  await q('UPDATE users SET full_name=COALESCE($2,full_name), phone=COALESCE($3,phone), photo_url=COALESCE($4,photo_url), updated_at=now() WHERE id=$1', [req.user.id, b.fullName, b.phone, req.file ? `/files/${req.file.filename}` : null]);
  await q('UPDATE customer_profiles SET date_of_birth=COALESCE($2,date_of_birth), emergency_contact_name=COALESCE($3,emergency_contact_name), emergency_contact_phone=COALESCE($4,emergency_contact_phone) WHERE user_id=$1', [req.user.id, b.dateOfBirth || null, b.emergencyContactName, b.emergencyContactPhone]);
  res.json({ ok: true });
}));
const addrSchema = z.object({ label: z.string().optional(), addressLine: z.string().min(5, 'Enter a valid address'), city: z.string().optional(), subCity: z.string().optional(), latitude: z.number().optional(), longitude: z.number().optional(), isDefault: z.boolean().optional() });
r.post('/addresses', requireRole('CUSTOMER'), validate(addrSchema), wrap(async (req, res) => { const b = req.body;
  if (b.isDefault) await q('UPDATE addresses SET is_default=false WHERE user_id=$1', [req.user.id]);
  res.status(201).json({ address: (await q('INSERT INTO addresses(user_id,label,address_line,city,sub_city,latitude,longitude,is_default) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [req.user.id, b.label, b.addressLine, b.city, b.subCity, b.latitude, b.longitude, !!b.isDefault])).rows[0] }); }));
r.put('/addresses/:id', requireRole('CUSTOMER'), validate(addrSchema.partial()), wrap(async (req, res) => { const b = req.body;
  const x = await q('UPDATE addresses SET label=COALESCE($3,label),address_line=COALESCE($4,address_line),city=COALESCE($5,city),sub_city=COALESCE($6,sub_city),latitude=COALESCE($7,latitude),longitude=COALESCE($8,longitude) WHERE id=$1 AND user_id=$2 RETURNING *', [req.params.id, req.user.id, b.label, b.addressLine, b.city, b.subCity, b.latitude, b.longitude]);
  if (!x.rowCount) throw new HttpError(404, 'Address not found.'); res.json({ address: x.rows[0] }); }));
r.delete('/addresses/:id', requireRole('CUSTOMER'), wrap(async (req, res) => { await q('DELETE FROM addresses WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]); res.json({ ok: true }); }));

const refillSchema = z.object({ medicineName: z.string().min(1), quantity: z.string().optional(), intervalDays: z.number().int().min(1).max(365), remindDaysBefore: z.number().int().min(0).max(30).default(3), nextRefillDate: z.string().optional() });
r.get('/refills', requireRole('CUSTOMER'), wrap(async (req, res) => res.json({ data: (await q("SELECT * FROM refill_schedules WHERE customer_id=$1 AND status<>'CANCELLED' ORDER BY next_refill_date", [req.user.id])).rows })));
r.post('/refills', requireRole('CUSTOMER'), validate(refillSchema), wrap(async (req, res) => { const b = req.body;
  res.status(201).json({ refill: (await q("INSERT INTO refill_schedules(customer_id,medicine_name,quantity,interval_days,remind_days_before,next_refill_date) VALUES($1,$2,$3,$4,$5,COALESCE($6::date, CURRENT_DATE+$4::int)) RETURNING *", [req.user.id, b.medicineName, b.quantity, b.intervalDays, b.remindDaysBefore, b.nextRefillDate || null])).rows[0] }); }));
r.put('/refills/:id', requireRole('CUSTOMER'), validate(refillSchema.partial().extend({ status: z.enum(['ACTIVE', 'PAUSED', 'CANCELLED']).optional() })), wrap(async (req, res) => { const b = req.body;
  const x = await q('UPDATE refill_schedules SET medicine_name=COALESCE($3,medicine_name),quantity=COALESCE($4,quantity),interval_days=COALESCE($5,interval_days),remind_days_before=COALESCE($6,remind_days_before),next_refill_date=COALESCE($7::date,next_refill_date),status=COALESCE($8,status) WHERE id=$1 AND customer_id=$2 RETURNING *', [req.params.id, req.user.id, b.medicineName, b.quantity, b.intervalDays, b.remindDaysBefore, b.nextRefillDate, b.status]);
  if (!x.rowCount) throw new HttpError(404, 'Refill not found.'); res.json({ refill: x.rows[0] }); }));
// "Refill done": advance next date by the interval
r.post('/refills/:id/complete', requireRole('CUSTOMER'), wrap(async (req, res) => res.json({ refill: (await q("UPDATE refill_schedules SET next_refill_date=next_refill_date+interval_days WHERE id=$1 AND customer_id=$2 RETURNING *", [req.params.id, req.user.id])).rows[0] })));

r.get('/notifications', wrap(async (req, res) => res.json({ data: (await q('SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [req.user.id])).rows, unread: +(await q('SELECT count(*) FROM notifications WHERE user_id=$1 AND NOT is_read', [req.user.id])).rows[0].count })));
r.put('/notifications/read-all', wrap(async (req, res) => { await q('UPDATE notifications SET is_read=true WHERE user_id=$1', [req.user.id]); res.json({ ok: true }); }));
r.put('/notifications/:id/read', wrap(async (req, res) => { await q('UPDATE notifications SET is_read=true WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]); res.json({ ok: true }); }));
export default r;
