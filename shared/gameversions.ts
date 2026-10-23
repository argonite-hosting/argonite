function parts(v: string): number[] {
  return (v.match(/\d+/g) ?? []).map(Number);
}

export function compareGameVersions(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? -1) - (pb[i] ?? -1);
    if (d) return d;
  }
  return a.localeCompare(b);
}

export function sortGameVersionsDesc(list: string[]): string[] {
  return [...list].sort((a, b) => compareGameVersions(b, a));
}

// "1.21.4, 1.21.3, 1.21.1" reads better as "1.21.1-1.21.4" on cards.
export function summarizeGameVersions(list: string[], max = 3): string {
  if (!list.length) return '';
  const sorted = sortGameVersionsDesc(list);
  if (sorted.length <= max) return sorted.join(', ');
  return `${sorted[sorted.length - 1]}–${sorted[0]}`;
}
