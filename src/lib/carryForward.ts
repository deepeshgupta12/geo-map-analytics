// src/lib/carryForward.ts
// Locality metrics are sparse (a locality may have a value only in some months).
// This derives a "filled" document where a month without a value for a key reuses
// the latest earlier month that had one, tagged with `asOf` so the UI can say so.

import type { MetricBucket, MetricsDoc } from "@/lib/types";

export type FilledBucket = MetricBucket & { asOf?: string };

export type FilledDoc = Omit<MetricsDoc, "byMonth"> & {
  byMonth: Record<string, Record<string, FilledBucket>>;
  /** per month: how many keys were carried forward from an earlier month */
  carried: Record<string, number>;
};

export function carryForward(doc: MetricsDoc): FilledDoc {
  const months = doc.months ?? [];
  const byMonth: Record<string, Record<string, FilledBucket>> = {};
  const carried: Record<string, number> = {};
  const lastSeen = new Map<string, { bucket: MetricBucket; month: string }>();

  for (const m of months) {
    const rows = doc.byMonth?.[m] ?? {};
    const filled: Record<string, FilledBucket> = {};
    for (const k of Object.keys(rows)) {
      const b = rows[k]!;
      if (typeof b.v === "number" && Number.isFinite(b.v)) {
        lastSeen.set(k, { bucket: b, month: m });
        filled[k] = { v: b.v, n: b.n ?? null };
      }
    }
    let count = 0;
    for (const [k, seen] of lastSeen) {
      if (!filled[k]) {
        filled[k] = { v: seen.bucket.v, n: seen.bucket.n ?? null, asOf: seen.month };
        count++;
      }
    }
    byMonth[m] = filled;
    carried[m] = count;
  }

  return { ...doc, byMonth, carried };
}
