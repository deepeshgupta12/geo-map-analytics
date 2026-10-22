export function quantile(sortedAsc: number[], q: number): number {
  if (!sortedAsc.length) return NaN;
  const n = sortedAsc.length;
  if (n === 1) return sortedAsc[0];

  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const h = pos - lo;

  const a = sortedAsc[lo]!;
  const b = sortedAsc[hi]!;
  return a + (b - a) * h;
}

export function computeQuantileStops(values: number[], bucketCount: number): number[] {
  const xs = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (!xs.length) return [];

  const stops: number[] = [];
  for (let i = 0; i <= bucketCount; i++) {
    const q = i / bucketCount;
    stops.push(quantile(xs, q));
  }

  // De-duplicate / ensure non-decreasing
  for (let i = 1; i < stops.length; i++) {
    if (stops[i]! < stops[i - 1]!) stops[i] = stops[i - 1]!;
  }
  return stops;
}

/**
 * Collect finite metric values from a metrics document, either for a single
 * month or across every month (used for a scale that stays fixed during playback).
 */
export function collectDocValues(
  byMonth: Record<string, Record<string, { v?: number | null }>> | undefined,
  months: string[]
): { values: number[]; missing: number } {
  const values: number[] = [];
  let missing = 0;
  if (!byMonth) return { values, missing };
  for (const m of months) {
    const rows = byMonth[m];
    if (!rows) continue;
    for (const k of Object.keys(rows)) {
      const v = rows[k]?.v;
      if (typeof v === "number" && Number.isFinite(v)) values.push(v);
      else missing += 1;
    }
  }
  return { values, missing };
}

export function formatBucketRanges(stops: number[]): Array<[number, number]> {
  if (stops.length < 2) return [];
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < stops.length - 1; i++) {
    ranges.push([stops[i]!, stops[i + 1]!]);
  }
  return ranges;
}