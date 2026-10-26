// src/lib/projectGeometry.ts
// Procedural 3D geometry for a project: a podium on the plot plus one extruded
// twin-wing (H-shaped) block per current tower, with a generated facade pattern.
// Future-development entries are never extruded.

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

export type Project3DKind = "podium" | "tower" | "slab" | "future" | "label";

export const TOWER_INSET = 0.7;
const SLAB_THICKNESS_M = 0.4;
const SLAB_OVERHANG = 1.05; // slab outline scale vs the body (about 0.5 m on a 25 m wing)

export function facadeImageId(slug: string) {
  return `facade-${slug}`;
}

/**
 * GeoJSON features for one project: podium, one body per current tower, a thin
 * balcony slab per floor (the facade "texture" is geometry, because patterned
 * extrusions ignore emissive lighting and go black at night), future outlines
 * and a rooftop label.
 */
export function buildProject3D(p: LoadedProject): GeoJSON.Feature[] {
  const features: GeoJSON.Feature[] = [];
  const slug = p.slug;
  const projectId = p.ids?.project ?? null;
  const facade = p.facade ?? { base: "#f4f1ea", accent: "#c9743a", glass: "#8fb3c9" };
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
    const shape = (t.shape ?? "H").toUpperCase();
    const body = shape === "H" ? hFootprint(ring, 0.38, 0.6, TOWER_INSET) : ring;
    const slabRing = shape === "H" ? hFootprint(ring, 0.38, 0.6, TOWER_INSET * SLAB_OVERHANG) : ring;
    const floors = Math.max(1, Math.round(t.floors ?? towerHeightM(t) / FLOOR_HEIGHT_M));
    const top = podiumH + towerHeightM(t);
    maxTop = Math.max(maxTop, top);
    features.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [body] },
      properties: {
        kind: "tower",
        slug,
        projectId,
        name: t.name,
        phase: t.phase ?? null,
        floors: t.floors ?? null,
        height: top,
        base: podiumH,
        color: facade.glass,
      },
    });
    // One thin balcony slab per floor in the accent colour: reads as the facade's
    // horizontal banding from every angle and under every light preset.
    const floorH = (top - podiumH) / floors;
    for (let i = 1; i <= floors; i++) {
      const slabTop = podiumH + i * floorH;
      features.push({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [slabRing] },
        properties: { kind: "slab", slug, projectId, name: t.name, height: slabTop, base: slabTop - SLAB_THICKNESS_M, color: facade.accent },
      });
    }
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

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Small RGBA tile for `fill-extrusion-pattern`: a glass window band with mullions
 * over the base colour, and an accent balcony slab. Tiles across the walls.
 */
export function facadeTile(colors: { base: string; accent: string; glass: string }, size = 16): { width: number; height: number; data: Uint8Array } {
  const base = hexToRgb(colors.base);
  const accent = hexToRgb(colors.accent);
  const glass = hexToRgb(colors.glass);
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let c = base;
      const inWindow = y >= 2 && y < 9;
      const mullion = x % 4 === 0;
      const slab = y >= 11 && y < 13;
      if (inWindow && !mullion) c = glass;
      else if (slab) c = accent;
      const i = (y * size + x) * 4;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}
