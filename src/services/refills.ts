import { q } from '../config/db';
import { notify } from './notify';
export function startRefillJob() {
  const run = async () => {
    const r = await q(`SELECT * FROM refill_schedules WHERE status='ACTIVE'
      AND next_refill_date - remind_days_before <= CURRENT_DATE AND (last_reminded_for IS DISTINCT FROM next_refill_date)`);
    for (const s of r.rows) {
      await notify(s.customer_id, 'refill_reminder', `Refill due: ${s.medicine_name}`, `Your refill is due on ${new Date(s.next_refill_date).toDateString()}.`);
      await q('UPDATE refill_schedules SET last_reminded_for=next_refill_date WHERE id=$1', [s.id]);
    }
  };
  run().catch(console.error); setInterval(() => run().catch(console.error), 60 * 60 * 1000);
}
