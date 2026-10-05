import { Router } from 'express';
import { z } from 'zod';
import { q, tx } from '../config/db';
import { authenticate, requireRole, withPharmacy } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { publicUpload } from '../middleware/upload';
import { HttpError, wrap } from '../utils/errors';
import { announce, restock, setOrderStatus } from '../services/orders';
import { audit, notify } from '../services/notify';
import { emitRole } from '../services/realtime';
const r = Router(); r.use(authenticate, requireRole('PHARMACY'));

/* Profile works even before approval so the owner can see status */
r.get('/profile', wrap(async (req, res) => { const x = await q(`SELECT p.* FROM pharmacies p WHERE p.user_id=$1 OR p.id IN (SELECT pharmacy_id FROM pharmacy_staff WHERE user_id=$1) LIMIT 1`, [req.user.id]); if (!x.rowCount) throw new HttpError(404, 'No pharmacy is linked to this account.'); res.json({ pharmacy: x.rows[0] }); }));
r.use(withPharmacy);
r.put('/profile', publicUpload.fields([{ name: 'logo', maxCount: 1 }, { name: 'image', maxCount: 1 }]), validate(z.object({
  name: z.string().min(2).optional(), phone: z.string().regex(/^\+?[0-9 ()-]{7,16}$/).optional(), email: z.string().email().optional(), address: z.string().min(5).optional(),
  city: z.string().optional(), subCity: z.string().optional(), description: z.string().optional(), services: z.string().optional(),
  openingTime: z.string().optional(), closingTime: z.string().optional(), is24h: z.coerce.boolean().optional(), emergencyAvailable: z.coerce.boolean().optional(),
  latitude: z.coerce.number().optional(), longitude: z.coerce.number().optional() })), wrap(async (req, res) => {
  const b = req.body, f: any = req.files || {};
  const x = await q(`UPDATE pharmacies SET name=COALESCE($2,name),phone=COALESCE($3,phone),email=COALESCE($4,email),address=COALESCE($5,address),city=COALESCE($6,city),sub_city=COALESCE($7,sub_city),
    description=COALESCE($8,description),services=COALESCE($9,services),opening_time=COALESCE($10,opening_time),closing_time=COALESCE($11,closing_time),is_24h=COALESCE($12,is_24h),emergency_available=COALESCE($13,emergency_available),
    latitude=COALESCE($14,latitude),longitude=COALESCE($15,longitude),logo_url=COALESCE($16,logo_url),image_url=COALESCE($17,image_url),updated_at=now() WHERE id=$1 RETURNING *`,
    [req.pharmacy.id, b.name, b.phone, b.email, b.address, b.city, b.subCity, b.description, b.services, b.openingTime, b.closingTime, b.is24h, b.emergencyAvailable, b.latitude, b.longitude, f.logo?.[0] ? `/files/${f.logo[0].filename}` : null, f.image?.[0] ? `/files/${f.image[0].filename}` : null]);
  res.json({ pharmacy: x.rows[0] });
}));

r.get('/dashboard', wrap(async (req, res) => {
  const id = req.pharmacy.id;
  const inv = (await q(`SELECT count(*) total,
      count(*) FILTER (WHERE is_active AND stock_quantity>0 AND (expiry_date IS NULL OR expiry_date>CURRENT_DATE)) available,
      count(*) FILTER (WHERE stock_quantity>0 AND stock_quantity<=min_stock_level) low_stock,
      count(*) FILTER (WHERE expiry_date<=CURRENT_DATE) expired,
      count(*) FILTER (WHERE expiry_date>CURRENT_DATE AND expiry_date<=CURRENT_DATE+30) expiring_soon FROM medicine_inventory WHERE pharmacy_id=$1`, [id])).rows[0];
  const o = (await q(`SELECT count(*) FILTER (WHERE status IN ('PENDING','PHARMACY_REVIEW')) pending, count(*) FILTER (WHERE status IN ('CONFIRMED','PREPARING')) preparing,
      count(*) FILTER (WHERE status='READY_FOR_PICKUP') ready, count(*) FILTER (WHERE status='DELIVERED') completed,
      COALESCE(sum(subtotal) FILTER (WHERE status='DELIVERED' AND created_at::date=CURRENT_DATE),0) todays_sales,
      count(*) FILTER (WHERE order_type='EMERGENCY' AND status IN ('PENDING','PHARMACY_REVIEW')) emergency_pending FROM orders WHERE pharmacy_id=$1`, [id])).rows[0];
  res.json({ inventory: inv, orders: o });
}));

/* ---------- MEDICINES ---------- */
const medSchema = z.object({
  name: z.string().min(1, 'Medicine name is required'), genericName: z.string().optional(), brandName: z.string().optional(), category: z.string().optional(), description: z.string().optional(),
  barcode: z.string().optional(), qrCode: z.string().optional(), strength: z.string().optional(), dosageForm: z.string().optional(), manufacturer: z.string().optional(), storageRequirement: z.string().optional(),
  prescriptionRequired: z.coerce.boolean().default(false),
  price: z.coerce.number().min(0, 'Price is required'), stockQuantity: z.coerce.number().int().min(0, 'Stock is required'), minStockLevel: z.coerce.number().int().min(0).default(10),
  batchNumber: z.string().min(1, 'Batch number is required'), expiryDate: z.string().refine(d => !isNaN(Date.parse(d)), 'Enter a valid expiry date'), isActive: z.coerce.boolean().default(true),
});
const statusCase = `CASE WHEN mi.expiry_date<=CURRENT_DATE THEN 'EXPIRED' WHEN NOT mi.is_active THEN 'INACTIVE' WHEN mi.stock_quantity=0 THEN 'OUT_OF_STOCK' WHEN mi.stock_quantity<=mi.min_stock_level THEN 'LOW_STOCK' ELSE 'AVAILABLE' END`;
const invSelect = `SELECT mi.id, mi.price, mi.stock_quantity, mi.min_stock_level, mi.batch_number, mi.expiry_date, mi.is_active, ${statusCase} AS status, m.* , m.id medicine_id, mi.id id FROM medicine_inventory mi JOIN medicines m ON m.id=mi.medicine_id`;
r.get('/medicines', wrap(async (req, res) => {
  const p = Math.max(1, +req.query.page || 1), l = Math.min(100, +req.query.limit || 20); const f = req.query.filter;
  const x = await q(`SELECT * FROM (${invSelect} WHERE mi.pharmacy_id=$1 AND ($2::text IS NULL OR m.name ILIKE $2 OR m.generic_name ILIKE $2 OR m.barcode=$3)) t
     WHERE ($4::text IS NULL OR status=$4) ORDER BY name LIMIT $5 OFFSET $6`, [req.pharmacy.id, req.query.q ? `%${req.query.q}%` : null, req.query.q || null, f === 'low' ? 'LOW_STOCK' : f === 'expired' ? 'EXPIRED' : req.query.status || null, l, (p - 1) * l]);
  res.json({ data: x.rows });
}));
r.get('/medicines/:id', wrap(async (req, res) => { const x = await q(`${invSelect} WHERE mi.id=$1 AND mi.pharmacy_id=$2`, [req.params.id, req.pharmacy.id]); if (!x.rowCount) throw new HttpError(404, 'No medicine found.'); res.json({ medicine: x.rows[0] }); }));
// Barcode/QR lookup: found → prefilled data; not found → client shows "create new" form
r.post('/medicines/scan', validate(z.object({ code: z.string().min(3) })), wrap(async (req, res) => {
  const m = (await q('SELECT * FROM medicines WHERE barcode=$1 OR qr_code=$1', [req.body.code])).rows[0];
  if (!m) return res.json({ found: false, code: req.body.code, message: 'New medicine. Please enter the details and confirm.' });
  const mine = (await q('SELECT * FROM medicine_inventory WHERE pharmacy_id=$1 AND medicine_id=$2', [req.pharmacy.id, m.id])).rows[0];
  res.json({ found: true, medicine: m, inventory: mine || null });
}));
r.post('/medicines', publicUpload.single('image'), validate(medSchema), wrap(async (req, res) => {
  const b = req.body; if (new Date(b.expiryDate) <= new Date()) throw new HttpError(400, 'Expired medicines cannot be added for sale.');
  const out = await tx(async c => {
    let m = b.barcode ? (await c.query('SELECT * FROM medicines WHERE barcode=$1', [b.barcode])).rows[0] : null;
    if (!m) m = (await c.query(`INSERT INTO medicines(name,generic_name,brand_name,category,description,barcode,qr_code,strength,dosage_form,manufacturer,image_url,prescription_required,storage_requirement)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`, [b.name, b.genericName, b.brandName, b.category, b.description, b.barcode || null, b.qrCode, b.strength, b.dosageForm, b.manufacturer, req.file ? `/files/${req.file.filename}` : null, b.prescriptionRequired, b.storageRequirement])).rows[0];
    const inv = (await c.query(`INSERT INTO medicine_inventory(pharmacy_id,medicine_id,price,stock_quantity,min_stock_level,batch_number,expiry_date,is_active) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT(pharmacy_id,medicine_id) DO UPDATE SET price=EXCLUDED.price, stock_quantity=medicine_inventory.stock_quantity+EXCLUDED.stock_quantity, batch_number=EXCLUDED.batch_number, expiry_date=EXCLUDED.expiry_date, updated_at=now() RETURNING *`,
      [req.pharmacy.id, m.id, b.price, b.stockQuantity, b.minStockLevel, b.batchNumber, b.expiryDate, b.isActive])).rows[0];
    await c.query('INSERT INTO medicine_batches(inventory_id,batch_number,expiry_date,quantity) VALUES($1,$2,$3,$4)', [inv.id, b.batchNumber, b.expiryDate, b.stockQuantity]);
    return { medicine: m, inventory: inv };
  });
  await audit(req.user.id, 'MEDICINE_ADD', 'medicine_inventory', out.inventory.id, { name: b.name, price: b.price, stock: b.stockQuantity });
  res.status(201).json(out);
}));
r.put('/medicines/:id', publicUpload.single('image'), validate(medSchema.partial()), wrap(async (req, res) => {
  const b = req.body; const cur = (await q('SELECT * FROM medicine_inventory WHERE id=$1 AND pharmacy_id=$2', [req.params.id, req.pharmacy.id])).rows[0];
  if (!cur) throw new HttpError(404, 'No medicine found.');
  if (b.expiryDate && new Date(b.expiryDate) <= new Date() && b.isActive !== false) throw new HttpError(400, 'Expired medicines cannot be sold.');
  await tx(async c => {
    await c.query('UPDATE medicine_inventory SET price=COALESCE($2,price),stock_quantity=COALESCE($3,stock_quantity),min_stock_level=COALESCE($4,min_stock_level),batch_number=COALESCE($5,batch_number),expiry_date=COALESCE($6,expiry_date),is_active=COALESCE($7,is_active),updated_at=now() WHERE id=$1',
      [cur.id, b.price, b.stockQuantity, b.minStockLevel, b.batchNumber, b.expiryDate, b.isActive]);
    await c.query(`UPDATE medicines SET name=COALESCE($2,name),generic_name=COALESCE($3,generic_name),brand_name=COALESCE($4,brand_name),category=COALESCE($5,category),description=COALESCE($6,description),strength=COALESCE($7,strength),dosage_form=COALESCE($8,dosage_form),manufacturer=COALESCE($9,manufacturer),prescription_required=COALESCE($10,prescription_required),storage_requirement=COALESCE($11,storage_requirement),image_url=COALESCE($12,image_url) WHERE id=$1`,
      [cur.medicine_id, b.name, b.genericName, b.brandName, b.category, b.description, b.strength, b.dosageForm, b.manufacturer, b.prescriptionRequired, b.storageRequirement, req.file ? `/files/${req.file.filename}` : null]);
  });
  await audit(req.user.id, 'MEDICINE_UPDATE', 'medicine_inventory', cur.id, { before: { price: cur.price, stock: cur.stock_quantity }, after: b });
  res.json({ ok: true });
}));
r.delete('/medicines/:id', wrap(async (req, res) => {
  const x = await q('DELETE FROM medicine_inventory WHERE id=$1 AND pharmacy_id=$2 RETURNING id', [req.params.id, req.pharmacy.id]); if (!x.rowCount) throw new HttpError(404, 'No medicine found.');
  await audit(req.user.id, 'MEDICINE_DELETE', 'medicine_inventory', req.params.id); res.json({ ok: true });
}));

/* ---------- ORDERS ---------- */
r.get('/orders', wrap(async (req, res) => {
  const p = Math.max(1, +req.query.page || 1), l = Math.min(50, +req.query.limit || 20); const s = req.query.q ? `%${req.query.q}%` : null;
  const x = await q(`SELECT o.id,o.order_number,o.status,o.order_type,o.total,o.created_at,o.customer_name,o.customer_phone,o.delivery_address,o.prescription_status,o.prescription_id,pay.status payment_status,
      (SELECT json_agg(json_build_object('name',medicine_name,'quantity',quantity,'rx',prescription_required)) FROM order_items WHERE order_id=o.id) items
    FROM orders o LEFT JOIN payments pay ON pay.order_id=o.id WHERE o.pharmacy_id=$1 AND ($2::text IS NULL OR o.status=$2)
      AND ($3::text IS NULL OR o.order_number ILIKE $3 OR o.customer_name ILIKE $3)
    ORDER BY (o.order_type='EMERGENCY' AND o.status IN ('PENDING','PHARMACY_REVIEW')) DESC, o.created_at DESC LIMIT $4 OFFSET $5`, [req.pharmacy.id, req.query.status || null, s, l, (p - 1) * l]);
  res.json({ data: x.rows });
}));
r.get('/orders/:id', wrap(async (req, res) => {
  const o = (await q('SELECT o.*, pay.status payment_status, pay.method payment_method FROM orders o LEFT JOIN payments pay ON pay.order_id=o.id WHERE o.id=$1 AND o.pharmacy_id=$2', [req.params.id, req.pharmacy.id])).rows[0];
  if (!o) throw new HttpError(404, 'Order not found.');
  res.json({ order: o, items: (await q('SELECT * FROM order_items WHERE order_id=$1', [o.id])).rows,
    prescriptionMedicines: o.prescription_id ? (await q('SELECT * FROM prescription_medicines WHERE prescription_id=$1', [o.prescription_id])).rows : [], timeline: (await q('SELECT status,note,created_at FROM order_status_history WHERE order_id=$1 ORDER BY created_at,id', [o.id])).rows });
}));
async function transition(req: any, res: any, from: string[], to: string, opts: { note?: string; needRxApproved?: boolean } = {}) {
  const order = await tx(async c => {
    const o = (await c.query('SELECT * FROM orders WHERE id=$1 AND pharmacy_id=$2 FOR UPDATE', [req.params.id, req.pharmacy.id])).rows[0];
    if (!o) throw new HttpError(404, 'Order not found.');
    if (!from.includes(o.status)) throw new HttpError(400, `This order is ${o.status.replace(/_/g, ' ').toLowerCase()} and cannot be changed this way.`);
    if (opts.needRxApproved && o.prescription_status === 'PENDING') throw new HttpError(400, 'Prescription verification is required.');
    if (['REJECTED', 'CANCELLED'].includes(to)) { await restock(c, o.id); await c.query("UPDATE payments SET status=CASE WHEN status='PAID' THEN 'REFUNDED' ELSE status END WHERE order_id=$1", [o.id]); await c.query('UPDATE orders SET rejection_reason=$2 WHERE id=$1', [o.id, opts.note]); }
    return setOrderStatus(c, o.id, to, req.user.id, opts.note || null);
  });
  await announce(order, to, opts.note);
  if (to === 'READY_FOR_PICKUP') {
    const payload = { orderId: order.id, orderNumber: order.order_number, emergency: order.order_type === 'EMERGENCY' };
    emitRole('DELIVERY', 'order_ready', payload);
    const dps = (await q("SELECT user_id FROM delivery_persons WHERE is_approved AND availability='AVAILABLE'")).rows;
    for (const d of dps) await notify(d.user_id, 'new_delivery_request', `${payload.emergency ? '🚨 EMERGENCY ' : ''}New delivery request #${order.order_number}`, '', order.id);
  }
  res.json({ order });
}
r.put('/orders/:id/accept', (req, res, n) => transition(req, res, ['PENDING', 'PHARMACY_REVIEW'], 'CONFIRMED', { needRxApproved: true }).catch(n));
r.put('/orders/:id/reject', validate(z.object({ reason: z.string().min(3, 'A rejection reason is required') })), (req, res, n) => transition(req, res, ['PENDING', 'PHARMACY_REVIEW', 'CONFIRMED'], 'REJECTED', { note: req.body.reason }).catch(n));
r.put('/orders/:id/prepare', (req, res, n) => transition(req, res, ['CONFIRMED'], 'PREPARING').catch(n));
r.put('/orders/:id/ready', (req, res, n) => transition(req, res, ['PREPARING', 'CONFIRMED'], 'READY_FOR_PICKUP').catch(n));
// Pharmacist prescription decision
r.put('/orders/:id/prescription', validate(z.object({ approved: z.boolean(), reason: z.string().optional() })), wrap(async (req, res) => {
  const { approved, reason } = req.body; if (!approved && !reason) throw new HttpError(400, 'A rejection reason is required.');
  const order = await tx(async c => {
    const o = (await c.query("SELECT * FROM orders WHERE id=$1 AND pharmacy_id=$2 AND prescription_status='PENDING' FOR UPDATE", [req.params.id, req.pharmacy.id])).rows[0];
    if (!o) throw new HttpError(400, 'There is no prescription waiting for review on this order.');
    await c.query('UPDATE orders SET prescription_status=$2 WHERE id=$1', [o.id, approved ? 'APPROVED' : 'REJECTED']);
    await c.query('UPDATE prescriptions SET status=$2 WHERE id=$1', [o.prescription_id, approved ? 'APPROVED' : 'REJECTED']);
    if (approved) return { ...(await setOrderStatus(c, o.id, o.status, req.user.id, 'Prescription verified')) };
    await restock(c, o.id); await c.query('UPDATE orders SET rejection_reason=$2 WHERE id=$1', [o.id, reason]);
    return setOrderStatus(c, o.id, 'REJECTED', req.user.id, `Prescription rejected: ${reason}`);
  });
  await notify(order.customer_id, approved ? 'prescription_verified' : 'prescription_rejected', approved ? `Prescription verified (#${order.order_number})` : `Prescription rejected (#${order.order_number})`, approved ? 'Your pharmacy will confirm your order shortly.' : reason, order.id);
  if (!approved) await announce(order, 'REJECTED', reason);
  res.json({ order });
}));
export default r;
