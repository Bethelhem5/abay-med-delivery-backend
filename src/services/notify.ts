import { q } from '../config/db';
import { emitUser } from './realtime';
export async function notify(userId: string | null | undefined, type: string, title: string, body = '', orderId: string | null = null) {
  if (!userId) return;
  const r = await q('INSERT INTO notifications(user_id,type,title,body,order_id) VALUES($1,$2,$3,$4,$5) RETURNING *', [userId, type, title, body, orderId]);
  emitUser(userId, 'notification_created', r.rows[0]);
}
export async function notifyAdmins(type: string, title: string, body = '', orderId: string | null = null) {
  const a = await q("SELECT id FROM users WHERE role='ADMIN' AND is_active"); for (const u of a.rows) await notify(u.id, type, title, body, orderId);
}
export async function audit(userId: string | null, action: string, entity: string, entityId: string, details: any = {}) {
  await q('INSERT INTO audit_logs(user_id,action,entity,entity_id,details) VALUES($1,$2,$3,$4,$5)', [userId, action, entity, entityId, details]);
}
