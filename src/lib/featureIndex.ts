// src/lib/featureIndex.ts
// Builds an in-memory index of polygon features (id -> name, centroid, bbox) from the
// vector tiles currently loaded in the map. Tile pieces of the same feature are merged
// with area-weighted centroids, so labels land inside the shape and search can
// fit the camera to the full extent.

import type { Map as MapboxMap } from "mapbox-gl";
import type { Level } from "@/lib/types";
import { toNumericId } from "@/lib/types";

export type BBox = [number, number, number, number]; // minLng, minLat, maxLng, maxLat

export type IndexEntry = {
  level: Level;
  id: number;
  name: string;
  mmId: number | null;
  bbox: BBox;
  area: number; // sum of piece areas (planar, lng/lat units) – larger = more complete
  cx: number; // area-weighted centroid
  cy: number;
};

type Ring = Array<[number, number]>;

function ringAreaCentroid(ring: Ring): { a: number; cx: number; cy: number } {
  let a = 0;
  let cx = 0;
  let cy = 0;
  const n = ring.length;
  if (n < 3) return { a: 0, cx: 0, cy: 0 };
  for (let i = 0; i < n; i++) {
    const [x0, y0] = ring[i]!;
    const [x1, y1] = ring[(i + 1) % n]!;
    const cross = x0 * y1 - x1 * y0;
    a += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-14) return { a: 0, cx: 0, cy: 0 };
  return { a: Math.abs(a), cx: cx / (6 * a), cy: cy / (6 * a) };
}

function polygonStats(polygon: Ring[]): { a: number; sx: number; sy: number } {
  // outer ring adds, holes subtract
  let a = 0;
  let sx = 0;
  let sy = 0;
  polygon.forEach((ring, idx) => {
    const r = ringAreaCentroid(ring);
    if (r.a === 0) return;
    const sign = idx === 0 ? 1 : -1;
    a += sign * r.a;
    sx += sign * r.a * r.cx;
    sy += sign * r.a * r.cy;
  });
  return { a, sx, sy };
}

function pointInRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function extendBBox(b: BBox, ring: Ring) {
  for (const [x, y] of ring) {
    if (x < b[0]) b[0] = x;
    if (y < b[1]) b[1] = y;
    if (x > b[2]) b[2] = x;
    if (y > b[3]) b[3] = y;
  }
}

const emptyBBox = (): BBox => [Infinity, Infinity, -Infinity, -Infinity];

export class FeatureIndex {
  private entries = new Map<string, IndexEntry>();
  private version = 0;
  // Outer rings of every micromarket piece seen (tile-clipped), for point-in-polygon.
  private mmRings = new Map<number, Ring[]>();

  /** Micromarket whose polygon contains the point, if its geometry has been indexed. */
  mmIdForPoint(lng: number, lat: number): number | null {
    for (const [id, rings] of this.mmRings) {
      for (const ring of rings) if (pointInRing(lng, lat, ring)) return id;
    }
    return null;
  }

  hasMicromarketGeometry(): boolean {
    return this.mmRings.size > 0;
  }

  /**
   * Decide which micromarket each locality belongs to: spatially (its centroid inside
   * the micromarket polygon) when geometry is known, otherwise via `fallback`.
   * Returns true if any assignment changed.
   */
  assignMicromarkets(fallback: (id: number) => number | null): boolean {
    let changed = false;
    for (const e of this.entries.values()) {
      if (e.level !== "localities") continue;
      const spatial = this.mmRings.size ? this.mmIdForPoint(e.cx, e.cy) : null;
      const mmId = spatial ?? fallback(e.id) ?? e.mmId;
      if (mmId !== e.mmId) {
        e.mmId = mmId;
        changed = true;
      }
    }
    if (changed) this.version++;
    return changed;
  }

  /** locality id -> micromarket id for every indexed locality with a known micromarket. */
  localityMicromarkets(): Map<number, number> {
    const m = new Map<number, number>();
    for (const e of this.entries.values()) {
      if (e.level === "localities" && e.mmId !== null) m.set(e.id, e.mmId);
    }
    return m;
  }

  static key(level: Level, id: number) {
    return `${level}:${id}`;
  }

  get(level: Level, id: number): IndexEntry | undefined {
    return this.entries.get(FeatureIndex.key(level, id));
  }

  findByName(level: Level, name: string): IndexEntry | undefined {
    const q = name.trim().toLowerCase();
    for (const e of this.entries.values()) {
      if (e.level === level && e.name.trim().toLowerCase() === q) return e;
    }
    return undefined;
  }

  count(level?: Level): number {
    if (!level) return this.entries.size;
    let n = 0;
    for (const e of this.entries.values()) if (e.level === level) n++;
    return n;
  }

  /**
   * Scan the currently loaded tiles of a source and merge into the index.
   * Returns true if any entry was added or replaced with a more complete one.
   */
  scan(
    map: MapboxMap,
    level: Level,
    sourceId: string,
    sourceLayer: string,
    nameProp: string,
    mmIdOf?: (id: number, name: string) => number | null
  ): boolean {
    if (!map.getSource(sourceId)) return false;

    let feats: Array<{ id?: unknown; properties?: unknown; geometry?: unknown }>;
    try {
      feats = map.querySourceFeatures(sourceId, { sourceLayer }) as unknown as typeof feats;
    } catch {
      return false;
    }
    if (!feats.length) return false;

    // Accumulate per feature id for this scan only.
    const acc = new Map<number, { name: string; a: number; sx: number; sy: number; bbox: BBox; rings: Ring[] }>();

    for (const f of feats) {
      const id = toNumericId(f.id);
      if (id === null) continue;
      const props = (f.properties ?? {}) as Record<string, unknown>;
      const name = typeof props[nameProp] === "string" ? (props[nameProp] as string) : "";
      const g = f.geometry as { type?: string; coordinates?: unknown } | undefined;
      if (!g || !g.coordinates) continue;

      const polys: Ring[][] =
        g.type === "Polygon" ? [g.coordinates as Ring[]] : g.type === "MultiPolygon" ? (g.coordinates as Ring[][]) : [];
      if (!polys.length) continue;

      let cur = acc.get(id);
      if (!cur) {
        cur = { name, a: 0, sx: 0, sy: 0, bbox: emptyBBox(), rings: [] };
        acc.set(id, cur);
      }
      for (const poly of polys) {
        const s = polygonStats(poly);
        cur.a += s.a;
        cur.sx += s.sx;
        cur.sy += s.sy;
        for (const ring of poly) extendBBox(cur.bbox, ring);
        if (level === "micromarkets" && poly[0]) cur.rings.push(poly[0]);
      }
    }

    let changed = false;
    for (const [id, s] of acc) {
      if (s.a <= 0 || !Number.isFinite(s.bbox[0])) continue;
      const key = FeatureIndex.key(level, id);
      const prev = this.entries.get(key);
      const mmId = (mmIdOf ? mmIdOf(id, s.name) : null) ?? prev?.mmId ?? null;
      // Keep the most complete piece set we have seen (largest area), but still
      // pick up a micromarket id that only became known later (dims loaded).
      if (prev && prev.area >= s.a * 0.999) {
        if (prev.mmId === null && mmId !== null) {
          prev.mmId = mmId;
          changed = true;
        }
        continue;
      }
      this.entries.set(key, {
        level,
        id,
        name: s.name || prev?.name || "",
        mmId,
        bbox: s.bbox,
        area: s.a,
        cx: s.sx / s.a,
        cy: s.sy / s.a,
      });
      if (level === "micromarkets") this.mmRings.set(id, s.rings);
      changed = true;
    }
    if (changed) this.version++;
    return changed;
  }

  getVersion() {
    return this.version;
  }

  toLabelGeoJSON(): GeoJSON.FeatureCollection<GeoJSON.Point> {
    const features: GeoJSON.Feature<GeoJSON.Point>[] = [];
    for (const e of this.entries.values()) {
      if (!e.name) continue;
      features.push({
        type: "Feature",
        id: e.id,
        geometry: { type: "Point", coordinates: [e.cx, e.cy] },
        properties: { level: e.level, name: e.name, id: e.id, mmId: e.mmId },
      });
    }
    return { type: "FeatureCollection", features };
  }
}

export function bboxToBounds(b: BBox): [[number, number], [number, number]] {
  return [
    [b[0], b[1]],
    [b[2], b[3]],
  ];
}
