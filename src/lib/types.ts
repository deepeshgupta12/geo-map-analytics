// src/lib/types.ts
export type Level = "micromarkets" | "localities";

export type MetricBucket = { v: number | null; n?: number | null };

export type MetricsDoc = {
  cityId: number;
  metric: string;
  level: string;
  months: string[];
  byMonth: Record<string, Record<string, MetricBucket>>;
  notes?: string[];
};

export type DimItem = { id: number; name: string; micromarketId?: number | null; pincode?: string | null };
export type DimDoc = { cityId: number; items: DimItem[] };

export type PinnedSelection = {
  level: Level;
  joinKey: string; // micromarkets = featureId as string; localities = LocalityName
  displayName: string;
  featureId: number | null;
};

export type FeatureId = string | number;

export function toFeatureId(v: unknown): FeatureId | null {
  return typeof v === "string" || typeof v === "number" ? v : null;
}

/** Loose key for name joins: case-insensitive, whitespace collapsed, punctuation dropped. */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function toNumericId(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}
