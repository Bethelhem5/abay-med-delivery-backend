import { PoolClient } from 'pg';
import { q } from '../config/db';
import { emitOrder, emitUser, emitRole } from './realtime';
import { notify, notifyAdmins } from './notify';

export const STATUS_EVENT: Record<string, string> = {
  PENDING: 'order_created', CONFIRMED: 'order_accepted', PREPARING: 'order_preparing', READY_FOR_PICKUP: 'order_ready',
  DELIVERY_ASSIGNED: 'delivery_assigned', PICKED_UP: 'delivery_picked_up', ON_THE_WAY: 'delivery_started',
  ARRIVED: 'delivery_arrived', DELIVERED: 'order_delivered', CANCELLED: 'order_cancelled', REJECTED: 'order_cancelled',
};
const CUSTOMER_MSG: Record<string, [string, string]> = {
  CONFIRMED: ['Pharmacy accepted your order', 'Your pharmacy is reviewing and will prepare it.'],
  PREPARING: ['Order is being prepared', ''], READY_FOR_PICKUP: ['Order is ready', 'We are finding a delivery person.'],
  DELIVERY_ASSIGNED: ['Delivery assigned', 'A delivery person is on the way to the pharmacy.'], PICKED_UP: ['Medicine picked up', ''],
  ON_THE_WAY: ['Delivery on the way', 'Track your delivery live in the app.'], ARRIVED: ['Delivery person has arrived', 'Share your OTP code to receive the order.'],
  DELIVERED: ['Delivered', 'Please rate your pharmacy and delivery person.'], CANCELLED: ['Order cancelled', ''], REJECTED: ['Order rejected', ''],
};
/** Updates status, writes history, notifies and broadcasts. Use inside or outside a transaction (pass client). */
export async function setOrderStatus(db: PoolClient | null, orderId: string, status: string, actorId: string | null, note: string | null = null) {
  const run = (t: string, p: any[]) => (db ? db.query(t, p) : q(t, p));
  const r = await run('UPDATE orders SET status=$2, updated_at=now() WHERE id=$1 RETURNING *', [orderId, status]);
  const order = r.rows[0];
  await run('INSERT INTO order_status_history(order_id,status,note,changed_by) VALUES($1,$2,$3,$4)', [orderId, status, note, actorId]);
  return order;
}
/** Call AFTER commit. */
export async function announce(order: any, status: string, note?: string) {
  const payload = { orderId: order.id, orderNumber: order.order_number, status };
  const ev = STATUS_EVENT[status] || 'order_status';
  emitOrder(order.id, ev, payload); emitUser(order.customer_id, ev, payload);
  const ph = await q('SELECT user_id FROM pharmacies WHERE id=$1', [order.pharmacy_id]);
  if (ph.rows[0]?.user_id) emitUser(ph.rows[0].user_id, ev, payload);
  emitRole('ADMIN', ev, payload);
  const m = CUSTOMER_MSG[status];
  if (m) await notify(order.customer_id, ev, `${m[0]} (#${order.order_number})`, note || m[1], order.id);
  if (['CANCELLED', 'DELIVERED'].includes(status) && ph.rows[0]?.user_id)
    await notify(ph.rows[0].user_id, ev, `Order #${order.order_number} ${status.toLowerCase()}`, note || '', order.id);
  if (status === 'DELIVERED') await notifyAdmins(ev, `Order #${order.order_number} delivered`, '', order.id);
}
export async function restock(db: PoolClient | null, orderId: string) {
  const run = (t: string, p: any[]) => (db ? db.query(t, p) : q(t, p));
  await run(`UPDATE medicine_inventory mi SET stock_quantity = mi.stock_quantity + oi.quantity
             FROM order_items oi WHERE oi.order_id=$1 AND oi.inventory_id = mi.id`, [orderId]);
}
export const haversineSQL = (latCol: string, lngCol: string, lat: string, lng: string) =>
  `(6371 * acos(LEAST(1, cos(radians(${lat})) * cos(radians(${latCol})) * cos(radians(${lng}) - radians(${lngCol})) + sin(radians(${lat})) * sin(radians(${latCol})))))`;
