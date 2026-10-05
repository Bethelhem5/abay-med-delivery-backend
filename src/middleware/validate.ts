import { ZodSchema } from 'zod';
const strip = (v: any): any => typeof v === 'string' ? v.replace(/[<>]/g, '').trim() : Array.isArray(v) ? v.map(strip) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, strip(x)])) : v;
export const validate = (schema: ZodSchema, where: 'body' | 'query' = 'body') => (req: any, _res: any, next: any) => {
  try { req[where] = schema.parse(strip(req[where])); next(); } catch (e) { next(e); }
};
