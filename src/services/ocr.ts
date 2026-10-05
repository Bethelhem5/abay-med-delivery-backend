import fs from 'fs';
import { q } from '../config/db';
export interface ExtractedMedicine { name: string; strength: string | null; dosage: string | null; quantity: string | null; instructions: string | null; confidence: number; }

/** OCR provider: OCR.space when OCR_API_KEY is set. Replace with Google Vision / Tesseract as needed. */
export async function runOCR(filePath: string): Promise<string> {
  const key = process.env.OCR_API_KEY;
  if (!key) return '';
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('base64Image', `data:image/jpeg;base64,${buf.toString('base64')}`);
  form.append('OCREngine', '2');
  const res = await fetch('https://api.ocr.space/parse/image', { method: 'POST', headers: { apikey: key }, body: form as any });
  const j: any = await res.json();
  return (j?.ParsedResults || []).map((p: any) => p.ParsedText).join('\n');
}
const STRENGTH = /(\d+(?:\.\d+)?\s?(?:mg|mcg|µg|g|ml|iu|%))/i;
const DOSAGE = /((?:\d+|one|two|three)\s*(?:tab(?:let)?s?|cap(?:sule)?s?|ml|drops?)?\s*(?:od|bd|tds|qds|daily|once|twice|(?:\d)\s*x\s*\d|every\s+\d+\s*hours?|(?:\d-){1,3}\d)[^\n]*)/i;
const QTY = /(?:qty|quantity|x|#)\s*[:.]?\s*(\d+)|(\d+)\s*(?:tabs?|tablets?|caps?|capsules?)\b/i;

/** Heuristic extraction: matches lines against the medicine catalogue; every result needs human review. */
export async function extractMedicines(text: string): Promise<ExtractedMedicine[]> {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 2);
  if (!lines.length) return [];
  const cat = (await q('SELECT DISTINCT lower(name) n FROM medicines UNION SELECT DISTINCT lower(generic_name) FROM medicines WHERE generic_name IS NOT NULL UNION SELECT DISTINCT lower(brand_name) FROM medicines WHERE brand_name IS NOT NULL')).rows.map(r => r.n);
  const out: ExtractedMedicine[] = [];
  for (const line of lines) {
    const low = line.toLowerCase();
    const hit = cat.find(n => n && low.includes(n));
    const looksLikeRx = /^(rx|tab|cap|syp|syr|inj|tablet|capsule)\b/i.test(line) || STRENGTH.test(line);
    if (!hit && !looksLikeRx) continue;
    const name = hit ? hit : line.replace(/^(rx|tab\.?|cap\.?|syp\.?|syr\.?|inj\.?)\s*/i, '').replace(STRENGTH, '').split(/\s{2,}|,|-/)[0].trim();
    if (!name) continue;
    const s = line.match(STRENGTH), d = line.match(DOSAGE), qn = line.match(QTY);
    out.push({ name: name.replace(/\b\w/g, c => c.toUpperCase()), strength: s ? s[1].replace(/\s/g, '') : null, dosage: d ? d[1].trim() : null,
      quantity: qn ? (qn[1] || qn[2]) : null, instructions: null,
      confidence: Math.min(0.95, 0.35 + (hit ? 0.35 : 0) + (s ? 0.15 : 0) + (d ? 0.1 : 0)) });
  }
  return out;
}
