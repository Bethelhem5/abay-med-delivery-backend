import { Server } from 'socket.io';
import http from 'http';
import { verifyToken } from '../middleware/auth';
import { q } from '../config/db';
import { setIO } from '../services/realtime';
export function initSockets(server: http.Server) {
  const io = new Server(server, { cors: { origin: process.env.FRONTEND_URL?.split(',') || '*' } });
  setIO(io);
  io.use((s, next) => { try { const p = verifyToken(s.handshake.auth?.token); (s.data as any) = { id: p.sub, role: p.role }; next(); } catch { next(new Error('unauthorized')); } });
  io.on('connection', socket => {
    const { id, role } = socket.data as any;
    socket.join(`user:${id}`); socket.join(`role:${role}`);
    // Join a live-tracking room only if the user is a party to the order
    socket.on('join_order', async (orderId: string, ack?: Function) => {
      const r = await q(`SELECT 1 FROM orders o LEFT JOIN deliveries d ON d.order_id=o.id LEFT JOIN pharmacies p ON p.id=o.pharmacy_id
        WHERE o.id=$1 AND ($2='ADMIN' OR o.customer_id=$3 OR p.user_id=$3 OR d.delivery_person_id=$3)`, [orderId, role, id]);
      if (r.rowCount) { socket.join(`order:${orderId}`); ack?.({ ok: true }); } else ack?.({ ok: false });
    });
  });
  return io;
}
