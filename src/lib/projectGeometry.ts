// src/lib/projectGeometry.ts
// Procedural ground geometry for a project: the podium on the plot, dashed
// outlines for future development and the rooftop label point. The towers
// themselves are textured glTF models (see lib/towerModel.ts) that share the
// twin-wing (H-shaped) footprint helper below. Future-development entries are
// never extruded.

import type { LoadedProject, LngLat, TowerSpec } from "@/lib/projects";
import { plotCentroid } from "@/lib/projects";

export const FLOOR_HEIGHT_M = 3.1;
export const PODIUM_LEVEL_M = 3.6;
const DEFAULT_FLOORS = 40;

type XY = [number, number];

function metersPerDeg(lat: number): { x: number; y: number } {
  return { x: 111320 * Math.cos((lat * Math.PI) / 180), y: 111320 };
}

/**
 * Twin-wing "H" footprint inside a (rotated) rectangle ring of 4+ corners.
 * `inset` scales the rectangle about its centre first so neighbouring towers,
 * whose analysed blocks often touch, keep a visible gap.
 */
export function hFootprint(rect: LngLat[], wing = 0.38, core = 0.6, inset = 0.78): LngLat[] {
  if (rect.length < 4) return rect;
  const origin = rect[0]!;
  const m = metersPerDeg(origin[1]);
  const xy = (p: LngLat): XY => [(p[0] - origin[0]) * m.x, (p[1] - origin[1]) * m.y];
  const back = (q: XY): LngLat => [+(origin[0] + q[0] / m.x).toFixed(7), +(origin[1] + q[1] / m.y).toFixed(7)];

  const a0 = xy(rect[0]!);
  const b = xy(rect[1]!);
  const d = xy(rect[3]!);
  const e1: XY = [b[0] - a0[0], b[1] - a0[1]];
  const e2: XY = [d[0] - a0[0], d[1] - a0[1]];
  const len = (v: XY) => Math.hypot(v[0], v[1]);
  const [U0, V0] = len(e1) >= len(e2) ? [e1, e2] : [e2, e1]; // long axis, short axis
  const U: XY = [U0[0] * inset, U0[1] * inset];
  const V: XY = [V0[0] * inset, V0[1] * inset];
  const a: XY = [a0[0] + ((U0[0] + V0[0]) * (1 - inset)) / 2, a0[1] + ((U0[1] + V0[1]) * (1 - inset)) / 2];
  const pt = (u: number, v: number): LngLat => back([a[0] + U[0] * u + V[0] * v, a[1] + U[1] * u + V[1] * v]);

  const c0 = (1 - core) / 2;
  const c1 = (1 + core) / 2;
  return [
    pt(0, 0),
    pt(wing, 0),
    pt(wing, c0),
    pt(1 - wing, c0),
    pt(1 - wing, 0),
    pt(1, 0),
    pt(1, 1),
    pt(1 - wing, 1),
    pt(1 - wing, c1),
    pt(wing, c1),
    pt(wing, 1),
    pt(0, 1),
    pt(0, 0),
  ];
}

export function towerHeightM(t: TowerSpec): number {
  if (typeof t.heightM === "number" && t.heightM > 0) return t.heightM;
  return (t.floors ?? DEFAULT_FLOORS) * FLOOR_HEIGHT_M;
}

export type Project3DKind = "podium" | "future" | "label";

export const TOWER_INSET = 0.7;

/**
 * GeoJSON features for one project: the podium, dashed future-development
 * outlines and a rooftop label point carrying the tallest tower's top (metres)
 * for `symbol-z-offset`. Tower bodies come from lib/towerModel.ts.
 */
export function buildProject3D(p: LoadedProject): GeoJSON.Feature[] {
  const features: GeoJSON.Feature[] = [];
  const slug = p.slug;
  const projectId = p.ids?.project ?? null;
  const podiumH = Math.max(0, (p.podiumLevels ?? 0) * PODIUM_LEVEL_M);

  const plotRing = p.plot?.coordinates?.[0];
  if (plotRing && plotRing.length >= 4) {
    features.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [plotRing] },
      properties: { kind: "podium", slug, projectId, name: p.name, height: podiumH, base: 0, color: "#d8d2c4" },
    });
  }

  let maxTop = podiumH;
  for (const t of p.towers ?? []) {
    const ring = t.footprint?.[0];
    if (!ring || ring.length < 4) continue;
    if (t.futureDevelopment) {
      features.push({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [ring] },
        properties: { kind: "future", slug, projectId, name: t.name },
      });
      continue;
    }
    maxTop = Math.max(maxTop, podiumH + towerHeightM(t));
  }

  for (const f of p.futureDevelopment ?? []) {
    const ring = f.footprint?.[0];
    if (!ring || ring.length < 4) continue;
    features.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [ring] },
      properties: { kind: "future", slug, projectId, name: f.name },
    });
  }

  const [lng, lat] = plotCentroid(p);
  features.push({
    type: "Feature",
    geometry: { type: "Point", coordinates: [lng, lat] },
    properties: { kind: "label", slug, projectId, name: p.name, top: maxTop },
  });
  return features;
}
