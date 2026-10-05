import { Server } from 'socket.io';
let io: Server | null = null;
export const setIO = (s: Server) => { io = s; };
export const emitUser = (userId: string, event: string, data: any) => io?.to(`user:${userId}`).emit(event, data);
export const emitRole = (role: string, event: string, data: any) => io?.to(`role:${role}`).emit(event, data);
export const emitOrder = (orderId: string, event: string, data: any) => io?.to(`order:${orderId}`).emit(event, data);
