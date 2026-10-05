import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool } from '../src/config/db';
const PASS = 'Password123!';
const meds: [string, string, string, string, string, boolean, number][] = [
  ['Paracetamol 500mg','Paracetamol','Panadol','Pain relief','Tablet',false,25],['Ibuprofen 400mg','Ibuprofen','Brufen','Pain relief','Tablet',false,40],['Aspirin 100mg','Acetylsalicylic acid','Aspirin','Pain relief','Tablet',false,30],
  ['Amoxicillin 500mg','Amoxicillin','Amoxil','Antibiotics','Capsule',true,120],['Azithromycin 500mg','Azithromycin','Zithromax','Antibiotics','Tablet',true,180],['Ciprofloxacin 500mg','Ciprofloxacin','Cipro','Antibiotics','Tablet',true,150],
  ['Metformin 500mg','Metformin','Glucophage','Diabetes','Tablet',true,60],['Glibenclamide 5mg','Glibenclamide','Daonil','Diabetes','Tablet',true,45],['Insulin Glargine','Insulin glargine','Lantus','Diabetes','Injection',true,950],
  ['Amlodipine 5mg','Amlodipine','Norvasc','Cardiovascular','Tablet',true,55],['Atenolol 50mg','Atenolol','Tenormin','Cardiovascular','Tablet',true,50],['Enalapril 10mg','Enalapril','Renitec','Cardiovascular','Tablet',true,65],
  ['Omeprazole 20mg','Omeprazole','Losec','Digestive','Capsule',false,70],['Oral Rehydration Salts','ORS','ORS','Digestive','Sachet',false,15],['Loperamide 2mg','Loperamide','Imodium','Digestive','Capsule',false,35],
  ['Cetirizine 10mg','Cetirizine','Zyrtec','Allergy','Tablet',false,45],['Loratadine 10mg','Loratadine','Claritin','Allergy','Tablet',false,50],['Salbutamol Inhaler','Salbutamol','Ventolin','Respiratory','Inhaler',true,210],
  ['Cough Syrup 100ml','Dextromethorphan','Benylin','Respiratory','Syrup',false,85],['Vitamin C 1000mg','Ascorbic acid','Celin','Vitamins','Tablet',false,90],['Multivitamin','Multivitamin','Centrum','Vitamins','Tablet',false,320],
  ['Ferrous Sulfate 200mg','Iron','Fefol','Vitamins','Tablet',false,40],['Folic Acid 5mg','Folic acid','Folic Acid','Vitamins','Tablet',false,20],['Artemether/Lumefantrine','Coartem','Coartem','Antimalarial','Tablet',true,160],
  ['Hydrocortisone Cream 1%','Hydrocortisone','Cortizone','Skin care','Cream',false,75],['Clotrimazole Cream','Clotrimazole','Canesten','Skin care','Cream',false,80],['Povidone Iodine 100ml','Povidone iodine','Betadine','First aid','Solution',false,95],
  ['Adhesive Bandages (20)','Bandage','Band-Aid','First aid','Pack',false,60],['Digital Thermometer','Thermometer','Omron','Devices','Device',false,250],['Diazepam 5mg','Diazepam','Valium','Neurological','Tablet',true,110],
];
const pharmacies = [['Abay Central Pharmacy','Bole','Addis Ababa',9.0107,38.7613,true],['Selam Pharmacy','Piassa','Addis Ababa',9.0360,38.7520,true],['Tana Health Pharmacy','Kazanchis','Addis Ababa',9.0192,38.7690,false],['Nile Care Pharmacy','Megenagna','Addis Ababa',9.0200,38.8010,true],['Lalibela Pharmacy','CMC','Addis Ababa',9.0300,38.8200,false]] as const;
(async () => {
  const hash = await bcrypt.hash(PASS, 12);
  await pool.query('TRUNCATE users, medicines, audit_logs RESTART IDENTITY CASCADE'); await pool.query('ALTER SEQUENCE order_seq RESTART WITH 1000');
  const user = async (email: string, role: string, name: string, phone: string) => (await pool.query('INSERT INTO users(email,password_hash,role,full_name,phone) VALUES($1,$2,$3,$4,$5) RETURNING id', [email, hash, role, name, phone])).rows[0].id;
  await user('admin@abaymed.com', 'ADMIN', 'Abay Admin', '+251911000000');
  const cust: string[] = [];
  for (const [i, n] of ['Hana Tesfaye', 'Dawit Bekele'].entries()) {
    const id = await user(`customer${i + 1}@abaymed.com`, 'CUSTOMER', n, `+2519110000${i + 1}0`); cust.push(id);
    await pool.query('INSERT INTO customer_profiles(user_id) VALUES($1)', [id]); await pool.query('INSERT INTO carts(customer_id) VALUES($1)', [id]);
    await pool.query('INSERT INTO addresses(user_id,label,address_line,city,sub_city,latitude,longitude,is_default) VALUES($1,$2,$3,$4,$5,$6,$7,true)', [id, 'Home', `House ${10 + i}, Bole Road`, 'Addis Ababa', 'Bole', 9.005 + i * 0.01, 38.77 + i * 0.01]);
  }
  const mids: string[] = [];
  for (const [i, m] of meds.entries()) mids.push((await pool.query(`INSERT INTO medicines(name,generic_name,brand_name,category,dosage_form,prescription_required,barcode,description,strength) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [m[0], m[1], m[2], m[3], m[4], m[5], `6000000${String(i).padStart(5, '0')}`, `${m[0]} - ${m[3]}`, (m[0].match(/\d+(\.\d+)?\s?(mg|ml|%|g)/i) || [null])[0]])).rows[0].id);
  const phIds: string[] = [];
  for (const [i, p] of pharmacies.entries()) {
    const uid = await user(`pharmacy${i + 1}@abaymed.com`, 'PHARMACY', `${p[0]} Manager`, `+25191120000${i}`);
    const ph = (await pool.query(`INSERT INTO pharmacies(user_id,name,license_number,registration_number,tin,phone,email,address,city,sub_city,latitude,longitude,emergency_available,is_24h,description,verification_status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14,'APPROVED') RETURNING id`, [uid, p[0], `LIC-00${i + 1}`, `REG-00${i + 1}`, `TIN${1000 + i}`, `+25191120000${i}`, `pharmacy${i + 1}@abaymed.com`, `${p[1]} Main Street`, p[2], p[1], p[3], p[4], p[5], 'Licensed pharmacy serving the community.'])).rows[0].id;
    phIds.push(ph);
    for (const [j, m] of meds.entries()) if ((i + j) % 4 !== 3) {   // each pharmacy stocks ~75%
      const stock = j % 9 === 0 ? 4 : 20 + ((i * 7 + j * 3) % 80);   // some low-stock
      const exp = j === 13 && i === 2 ? "CURRENT_DATE-10" : `CURRENT_DATE+${90 + j * 12}`;
      await pool.query(`INSERT INTO medicine_inventory(pharmacy_id,medicine_id,price,stock_quantity,min_stock_level,batch_number,expiry_date) VALUES($1,$2,$3,$4,10,$5,${exp})`, [ph, mids[j], Math.round(m[6] * (0.95 + i * 0.03)), stock, `B${2026}-${i}${j}`]);
    }
  }
  const dps: string[] = [];
  for (let i = 0; i < 5; i++) { const id = await user(`delivery${i + 1}@abaymed.com`, 'DELIVERY', ['Abel Girma', 'Meron Alemu', 'Yonas Kebede', 'Selam Haile', 'Biruk Assefa'][i], `+25191130000${i}`); dps.push(id);
    await pool.query('INSERT INTO delivery_persons(user_id,id_number,vehicle_type,vehicle_plate,current_lat,current_lng,availability,is_approved) VALUES($1,$2,$3,$4,$5,$6,$7,true)', [id, `ID${5000 + i}`, i % 2 ? 'Motorbike' : 'Bicycle', `AA-${1000 + i}`, 9.01 + i * 0.005, 38.76 + i * 0.005, i < 3 ? 'AVAILABLE' : 'OFFLINE']); }
  // demo orders: delivered, in-flight, and one waiting for pharmacy
  const mk = async (cust: string, ph: string, status: string, type: string, items: number[], dp?: string, dstatus?: string) => {
    const inv = (await pool.query(`SELECT mi.id, mi.price, m.name FROM medicine_inventory mi JOIN medicines m ON m.id=mi.medicine_id WHERE mi.pharmacy_id=$1 AND m.id = ANY($2) AND NOT m.prescription_required`, [ph, items.map(i => mids[i])])).rows;
    const sub = inv.reduce((s, i) => s + +i.price * 2, 0), fee = type === 'EMERGENCY' ? 100 : 50;
    const n = 'AMD' + (await pool.query("SELECT nextval('order_seq') n")).rows[0].n;
    const o = (await pool.query(`INSERT INTO orders(order_number,customer_id,pharmacy_id,order_type,status,subtotal,delivery_fee,total,customer_name,customer_phone,delivery_address,delivery_lat,delivery_lng) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'Demo Customer','+251911000010','House 10, Bole Road',9.005,38.77) RETURNING id`, [n, cust, ph, type, status, sub, fee, sub + fee])).rows[0].id;
    for (const i of inv) await pool.query('INSERT INTO order_items(order_id,inventory_id,medicine_name,quantity,unit_price) VALUES($1,$2,$3,2,$4)', [o, i.id, i.name, i.price]);
    await pool.query("INSERT INTO payments(order_id,method,status,amount) VALUES($1,'CASH_ON_DELIVERY',$2,$3)", [o, status === 'DELIVERED' ? 'PAID' : 'PENDING', sub + fee]);
    await pool.query('INSERT INTO order_status_history(order_id,status) VALUES($1,$2)', [o, status]);
    if (dp) await pool.query('INSERT INTO deliveries(order_id,delivery_person_id,status,otp,fee,delivered_at) VALUES($1,$2,$3,$4,$5,CASE WHEN $3=\'DELIVERED\' THEN now() END)', [o, dp, dstatus, '123456', fee]);
  };
  await mk(cust[0], phIds[0], 'DELIVERED', 'STANDARD', [0, 1, 12], dps[0], 'DELIVERED');
  await mk(cust[0], phIds[1], 'PENDING', 'EMERGENCY', [0, 15]);
  await mk(cust[1], phIds[0], 'READY_FOR_PICKUP', 'STANDARD', [13, 14, 19]);
  await mk(cust[1], phIds[3], 'PREPARING', 'STANDARD', [1, 20]);
  await pool.query("INSERT INTO refill_schedules(customer_id,medicine_name,quantity,interval_days,remind_days_before,next_refill_date) VALUES($1,'Metformin 500mg','30 tablets',30,3,CURRENT_DATE+2)", [cust[0]]);
  console.log(`Seed complete. All demo accounts use password: ${PASS}`); await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
