import { Request, Response, NextFunction, RequestHandler } from 'express';
import { ZodError } from 'zod';
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export const wrap = (fn: (req: any, res: Response, next: NextFunction) => Promise<any>): RequestHandler =>
  (req, res, next) => fn(req, res, next).catch(next);
export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err instanceof ZodError) return res.status(400).json({ error: 'Please check the highlighted fields.', details: err.issues.map(i => ({ field: i.path.join('.'), message: i.message })) });
  if (err?.code === '23505') return res.status(409).json({ error: 'This record already exists.' });
  if (err?.code === '23503') return res.status(400).json({ error: 'A related record was not found.' });
  if (err?.name === 'MulterError' || err?.message?.startsWith('Unsupported file')) return res.status(400).json({ error: err.message });
  console.error(err); // raw errors are logged, never returned
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
}
