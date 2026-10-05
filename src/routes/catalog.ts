// Customer-facing browsing: pharmacies + medicines
import { Router } from 'express';
import { q } from '../config/db';
import { authenticate } from '../middleware/auth';
import { HttpError, wrap } from '../utils/errors';
import { haversineSQL } from '../services/orders';
const r = Router(); r.use(authenticate);
// When no lat/lng is sent, $1/$2 must still be referenced (and typed) or Postgres throws 42P18 "could not determine data type of parameter".
const NO_DISTANCE = '(CASE WHEN $1::float IS NULL AND $2::float IS NULL THEN NULL::float END)';
const page = (req: any) => { const p = Math.max(1, +req.query.page || 1), l = Math.min(50, +req.query.limit || 20); return { l, o: (p - 1) * l }; };

r.get('/pharmacies', wrap(async (req, res) => {
  const { l, o } = page(req); const lat = req.query.lat ? +req.query.lat : null, lng = req.query.lng ? +req.query.lng : null;
  const search = req.query.q ? `%${req.query.q}%` : null;
  const x = await q(`SELECT p.id,p.name,p.description,p.address,p.city,p.sub_city,p.latitude,p.longitude,p.logo_url,p.image_url,p.phone,
      p.opening_time,p.closing_time,p.is_24h,p.emergency_available,
      COALESCE((SELECT round(avg(rating),1) FROM reviews rv WHERE rv.pharmacy_id=p.id AND rv.target='PHARMACY'),0) rating,
      (SELECT count(*) FROM medicine_inventory mi WHERE mi.pharmacy_id=p.id AND mi.is_active AND mi.stock_quantity>0 AND (mi.expiry_date IS NULL OR mi.expiry_date>CURRENT_DATE)) medicine_count,
      ${lat != null ? haversineSQL('p.latitude', 'p.longitude', '$1::float', '$2::float') : NO_DISTANCE} AS distance_km,
      (p.is_24h OR localtime BETWEEN p.opening_time AND p.closing_time) AS is_open
    FROM pharmacies p WHERE p.verification_status='APPROVED' AND p.is_active
      AND ($3::text IS NULL OR p.name ILIKE $3) AND ($4::bool IS NOT TRUE OR p.emergency_available)
    ORDER BY ${lat != null ? 'distance_km' : 'p.name'} LIMIT $5 OFFSET $6`, [lat, lng, search, req.query.emergency === 'true', l, o]);
  res.json({ data: x.rows });
}));
r.get('/pharmacies/:id', wrap(async (req, res) => {
  const p = await q(`SELECT p.*, COALESCE((SELECT round(avg(rating),1) FROM reviews WHERE pharmacy_id=p.id AND target='PHARMACY'),0) rating,
     (p.is_24h OR localtime BETWEEN p.opening_time AND p.closing_time) is_open
     FROM pharmacies p WHERE p.id=$1 AND p.verification_status='APPROVED' AND p.is_active`, [req.params.id]);
  if (!p.rowCount) throw new HttpError(404, 'Pharmacy not found.');
  const { l, o } = page(req);
  const m = await q(`SELECT mi.id inventory_id, m.id medicine_id, m.name, m.generic_name, m.brand_name, m.category, m.strength, m.dosage_form, m.description, m.image_url,
      m.prescription_required, mi.price, mi.stock_quantity FROM medicine_inventory mi JOIN medicines m ON m.id=mi.medicine_id
      WHERE mi.pharmacy_id=$1 AND mi.is_active AND mi.stock_quantity>0 AND (mi.expiry_date IS NULL OR mi.expiry_date>CURRENT_DATE)
      AND ($2::text IS NULL OR m.name ILIKE $2 OR m.generic_name ILIKE $2) ORDER BY m.name LIMIT $3 OFFSET $4`,
    [req.params.id, req.query.q ? `%${req.query.q}%` : null, l, o]);
  const { user_id, tin, license_number, registration_number, ...pub } = p.rows[0];
  res.json({ pharmacy: pub, medicines: m.rows });
}));
// Cross-pharmacy medicine search with filters
const searchHandler = wrap(async (req, res) => {
  const { l, o } = page(req); const qs = req.query as any;
  const lat = qs.lat ? +qs.lat : null, lng = qs.lng ? +qs.lng : null;
  const x = await q(`SELECT mi.id inventory_id, m.id medicine_id, m.name, m.generic_name, m.brand_name, m.category, m.strength, m.dosage_form, m.image_url, m.prescription_required,
      mi.price, mi.stock_quantity, p.id pharmacy_id, p.name pharmacy_name,
      ${lat != null ? haversineSQL('p.latitude', 'p.longitude', '$1::float', '$2::float') : NO_DISTANCE} distance_km
    FROM medicine_inventory mi JOIN medicines m ON m.id=mi.medicine_id JOIN pharmacies p ON p.id=mi.pharmacy_id
    WHERE p.verification_status='APPROVED' AND p.is_active AND mi.is_active AND mi.stock_quantity>0 AND (mi.expiry_date IS NULL OR mi.expiry_date>CURRENT_DATE)
      AND ($3::text IS NULL OR m.name ILIKE $3 OR m.generic_name ILIKE $3 OR m.brand_name ILIKE $3 OR m.category ILIKE $3 OR p.name ILIKE $3)
      AND ($4::uuid IS NULL OR p.id=$4) AND ($5::text IS NULL OR m.category ILIKE $5)
      AND ($6::numeric IS NULL OR mi.price>=$6) AND ($7::numeric IS NULL OR mi.price<=$7)
      AND ($8::bool IS NULL OR m.prescription_required=$8)
    ORDER BY ${lat != null ? 'distance_km NULLS LAST,' : ''} m.name, mi.price LIMIT $9 OFFSET $10`,
    [lat, lng, qs.q ? `%${qs.q}%` : null, qs.pharmacyId || null, qs.category || null, qs.minPrice || null, qs.maxPrice || null,
     qs.prescriptionRequired === undefined ? null : qs.prescriptionRequired === 'true', l, o]);
  if (!x.rowCount && qs.q) return res.json({ data: [], message: 'No medicine found.' });
  res.json({ data: x.rows });
});
r.get('/medicines/search', searchHandler);
r.get('/medicines/categories', wrap(async (_q, res) => res.json({ data: (await q('SELECT DISTINCT category FROM medicines WHERE category IS NOT NULL ORDER BY 1')).rows.map(r => r.category) })));
r.get('/medicines', searchHandler);
r.get('/medicines/:id', wrap(async (req, res) => {
  const x = await q(`SELECT m.*, json_agg(json_build_object('inventoryId',mi.id,'pharmacyId',p.id,'pharmacy',p.name,'price',mi.price,'stock',mi.stock_quantity)) offers
    FROM medicines m LEFT JOIN medicine_inventory mi ON mi.medicine_id=m.id AND mi.is_active AND mi.stock_quantity>0 AND (mi.expiry_date IS NULL OR mi.expiry_date>CURRENT_DATE)
    LEFT JOIN pharmacies p ON p.id=mi.pharmacy_id AND p.verification_status='APPROVED' AND p.is_active
    WHERE m.id=$1 GROUP BY m.id`, [req.params.id]);
  if (!x.rowCount) throw new HttpError(404, 'No medicine found.');
  res.json({ medicine: x.rows[0] });
}));
export default r;