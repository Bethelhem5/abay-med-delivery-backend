import multer from 'multer'; import path from 'path'; import fs from 'fs'; import crypto from 'crypto';
const root = path.resolve(process.env.UPLOAD_DIR || './uploads');
const make = (sub: string) => { const dir = path.join(root, sub); fs.mkdirSync(dir, { recursive: true });
  return multer({
    storage: multer.diskStorage({ destination: dir, filename: (_r, f, cb) => cb(null, crypto.randomUUID() + path.extname(f.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '')) }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_r, f, cb) => /^image\/(jpeg|png|webp)$/.test(f.mimetype) ? cb(null, true) : cb(new Error('Unsupported file type. Please upload a JPG, PNG or WEBP image.')),
  }); };
export const publicUpload = make('public');
export const privateUpload = make('private'); // prescriptions & delivery proofs – never statically served
export const uploadRoot = root;
