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

export function formatBucketRanges(stops: number[]): Array<[number, number]> {
  if (stops.length < 2) return [];
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < stops.length - 1; i++) {
    ranges.push([stops[i]!, stops[i + 1]!]);
  }
  return ranges;
}