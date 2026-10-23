// pack_format numbers and the Minecraft releases that use them. Only used to suggest game versions on
// the upload form; authors always have the final say. Newer formats are added as Mojang ships them.
import { compareGameVersions } from './gameversions';

type Range = [string, string];

const RESOURCE: Record<number, Range> = {
  1: ['1.6.1', '1.8.9'],
  2: ['1.9', '1.10.2'],
  3: ['1.11', '1.12.2'],
  4: ['1.13', '1.14.4'],
  5: ['1.15', '1.16.1'],
  6: ['1.16.2', '1.16.5'],
  7: ['1.17', '1.17.1'],
  8: ['1.18', '1.18.2'],
  9: ['1.19', '1.19.2'],
  12: ['1.19.3', '1.19.3'],
  13: ['1.19.4', '1.19.4'],
  15: ['1.20', '1.20.1'],
  18: ['1.20.2', '1.20.2'],
  22: ['1.20.3', '1.20.4'],
  32: ['1.20.5', '1.20.6'],
  34: ['1.21', '1.21.1'],
  42: ['1.21.2', '1.21.3'],
  46: ['1.21.4', '1.21.4'],
  55: ['1.21.5', '1.21.5'],
  63: ['1.21.6', '1.21.6'],
  64: ['1.21.7', '1.21.8'],
};

const DATA: Record<number, Range> = {
  4: ['1.13', '1.14.4'],
  5: ['1.15', '1.16.1'],
  6: ['1.16.2', '1.16.5'],
  7: ['1.17', '1.17.1'],
  8: ['1.18', '1.18.1'],
  9: ['1.18.2', '1.18.2'],
  10: ['1.19', '1.19.3'],
  12: ['1.19.4', '1.19.4'],
  15: ['1.20', '1.20.1'],
  18: ['1.20.2', '1.20.2'],
  26: ['1.20.3', '1.20.4'],
  41: ['1.20.5', '1.20.6'],
  48: ['1.21', '1.21.1'],
  57: ['1.21.2', '1.21.3'],
  61: ['1.21.4', '1.21.4'],
  71: ['1.21.5', '1.21.5'],
  80: ['1.21.6', '1.21.6'],
  81: ['1.21.7', '1.21.8'],
};

export interface PackFormatInfo {
  format: number;
  min?: number;
  max?: number;
}

// Release versions (from the known list) that a pack_format, or a min/max format range, covers.
export function versionsForPack(kind: 'resource' | 'data', info: PackFormatInfo, known: string[]): string[] {
  const table = kind === 'resource' ? RESOURCE : DATA;
  const lo = Math.floor(info.min ?? info.format);
  const hi = Math.floor(info.max ?? info.format);
  const ranges = Object.entries(table)
    .filter(([f]) => Number(f) >= lo && Number(f) <= hi)
    .map(([, r]) => r);
  if (!ranges.length) return [];
  return known.filter((v) => /^\d+\.\d+(\.\d+)?$/.test(v) && ranges.some(([a, b]) => compareGameVersions(v, a) >= 0 && compareGameVersions(v, b) <= 0));
}
