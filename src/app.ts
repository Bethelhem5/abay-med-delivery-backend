import 'dotenv/config';
import express from 'express'; import http from 'http'; import cors from 'cors'; import helmet from 'helmet'; import morgan from 'morgan'; import rateLimit from 'express-rate-limit'; import path from 'path';
import auth from './routes/auth'; import catalog from './routes/catalog'; import customer from './routes/customer'; import pharmacy from './routes/pharmacy'; import delivery from './routes/delivery'; import admin from './routes/admin';
import { errorHandler } from './utils/errors'; import { initSockets } from './sockets'; import { startRefillJob } from './services/refills'; import { uploadRoot } from './middleware/upload';

if (!process.env.JWT_SECRET || !process.env.DATABASE_URL) { console.error('Missing JWT_SECRET or DATABASE_URL in .env'); process.exit(1); }
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
// FRONTEND_URL can hold a comma-separated list of allowed browser origins. If it is missing or empty, any origin is allowed.
const allowedOrigins = (process.env.FRONTEND_URL || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : true }));
app.use(express.json({ limit: '1mb' })); app.use(express.urlencoded({ extended: true }));
app.use(morgan('combined'));
app.use('/api', rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false }));
app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60_000, max: 20, message: { error: 'Too many attempts. Please try again later.' } }));
app.use('/files', express.static(path.join(uploadRoot, 'public')));      // public images only – /private is never served statically
app.get('/health', (_r, res) => res.json({ ok: true }));
app.use('/api/auth', auth);
app.use('/api/admin', admin);
app.use('/api/pharmacy', pharmacy);
app.use('/api/delivery', delivery);
app.use('/api', catalog);     // /pharmacies, /medicines
app.use('/api', customer);    // /cart, /orders, /prescriptions, /customer, /addresses, /refills, /reviews, /notifications
app.use((_r, res) => res.status(404).json({ error: 'Not found.' }));
app.use(errorHandler);
const server = http.createServer(app); initSockets(server); startRefillJob();
server.listen(+(process.env.PORT || 4000), () => console.log(`Abay Med API on :${process.env.PORT || 4000}`));