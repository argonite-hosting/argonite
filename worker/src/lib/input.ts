import { badRequest } from './http';

type Body = Record<string, unknown>;

export function str(body: Body, key: string, opts: { required?: boolean; max?: number } = {}): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) {
    if (opts.required) throw badRequest(`Missing ${key}.`, { [key]: 'Required.' });
    return undefined;
  }
  if (typeof v !== 'string') throw badRequest(`${key} must be text.`, { [key]: 'Must be text.' });
  if (opts.max !== undefined && v.length > opts.max) throw badRequest(`${key} is too long.`, { [key]: `Max ${opts.max} characters.` });
  return v;
}

export function optionalStr(body: Body, key: string, max: number): string | null | undefined {
  if (body[key] === null) return null;
  const v = str(body, key, { max });
  if (v === undefined) return undefined;
  return v.trim() === '' ? null : v.trim();
}

export function strArray(body: Body, key: string, opts: { max: number; itemMax: number; required?: boolean }): string[] | undefined {
  const v = body[key];
  if (v === undefined || v === null) {
    if (opts.required) throw badRequest(`Missing ${key}.`, { [key]: 'Required.' });
    return undefined;
  }
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.length > opts.itemMax)) throw badRequest(`${key} must be a list of text values.`);
  if (v.length > opts.max) throw badRequest(`Too many ${key}.`, { [key]: `Max ${opts.max}.` });
  return [...new Set(v as string[])];
}

export function int(body: Body, key: string, opts: { min: number; max: number; required?: boolean }): number | undefined {
  const v = body[key];
  if (v === undefined || v === null) {
    if (opts.required) throw badRequest(`Missing ${key}.`);
    return undefined;
  }
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < opts.min || v > opts.max) throw badRequest(`${key} is out of range.`);
  return v;
}

export function oneOf<T extends string>(body: Body, key: string, allowed: readonly T[], required = false): T | undefined {
  const v = str(body, key, { required, max: 64 });
  if (v === undefined) return undefined;
  if (!allowed.includes(v as T)) throw badRequest(`Invalid ${key}.`, { [key]: 'Invalid choice.' });
  return v as T;
}

export function check(err: string | null, field: string): void {
  if (err) throw badRequest(err, { [field]: err });
}

export function pageParams(url: URL, maxSize = 50, defaultSize = 20): { page: number; size: number; offset: number } {
  const page = Math.max(1, Math.min(500, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1));
  const size = Math.max(1, Math.min(maxSize, Number.parseInt(url.searchParams.get('limit') ?? String(defaultSize), 10) || defaultSize));
  return { page, size, offset: (page - 1) * size };
}

export function listParam(url: URL, key: string, max = 20): string[] {
  const raw = url.searchParams.get(key);
  if (!raw) return [];
  return [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => s && s.length <= 40))].slice(0, max);
}

const IMAGE_TYPES: { type: string; ext: string; test: (b: Uint8Array) => boolean }[] = [
  { type: 'image/png', ext: 'png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a },
  { type: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/gif', ext: 'gif', test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  {
    type: 'image/webp',
    ext: 'webp',
    test: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
];

// SVG is deliberately absent: it is a script-capable document, not an image.
export function sniffImage(bytes: Uint8Array): { type: string; ext: string } | null {
  if (bytes.length < 12) return null;
  const hit = IMAGE_TYPES.find((t) => t.test(bytes));
  return hit ? { type: hit.type, ext: hit.ext } : null;
}
