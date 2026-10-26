// src/lib/towerModel.ts
// Procedural glTF (GLB) towers for the Mapbox `model` layer.
//
// Why a model and not a patterned fill-extrusion: Mapbox lights a patterned
// extrusion with the scene light only (no emissive term in that shader), so a
// textured wall is black at night. The model shader keeps the glTF emissive map
// and mixes lit/unlit colour by `model-emissive-strength`, so one textured tower
// works under day, dusk and night presets.
//
// Each current tower becomes two GLBs built in the browser from project.json:
//   <slug>/t<i>:day    facade texture only
//   <slug>/t<i>:night  facade texture + emissive window map (lit windows)
// All towers of a project are anchored at the plot centroid, with the tower
// offset baked into the mesh, so one GeoJSON point per tower drives the layer.
//
// Axes: glTF is Y-up; Mapbox maps glTF +X to east, +Y to up and +Z to south.

import type { LoadedProject, LngLat, TowerSpec } from "@/lib/projects";
import { plotCentroid } from "@/lib/projects";
import { FLOOR_HEIGHT_M, PODIUM_LEVEL_M, TOWER_INSET, hFootprint, towerHeightM } from "@/lib/projectGeometry";

export type ModelVariant = "day" | "night";
export const MODEL_VARIANTS: readonly ModelVariant[] = ["day", "night"];

/** The GeoJSON `model` property for a tower; the layer appends ":day" / ":night". */
export function towerModelKey(slug: string, towerIndex: number) {
  return `${slug}/t${towerIndex}`;
}
export function towerModelId(slug: string, towerIndex: number, variant: ModelVariant) {
  return `${towerModelKey(slug, towerIndex)}:${variant}`;
}

// Facade texture: a CELLS x CELLS grid of bays, one bay = BAY_M wide x one floor tall.
const BAY_M = 3.6;
const CELLS = 4;
const TEX_PX = 512;
const CELL_PX = TEX_PX / CELLS;

type XY = [number, number];
type Facade = { base: string; accent: string; glass: string };
const DEFAULT_FACADE: Facade = { base: "#f4f1ea", accent: "#c9743a", glass: "#8fb3c9" };

function metersPerDeg(lat: number): { x: number; y: number } {
  return { x: 111320 * Math.cos((lat * Math.PI) / 180), y: 111320 };
}

/** Current (rendered) towers of a project with their index in `towers[]`. */
export function currentTowers(p: LoadedProject): Array<{ index: number; tower: TowerSpec }> {
  const out: Array<{ index: number; tower: TowerSpec }> = [];
  (p.towers ?? []).forEach((tower, index) => {
    const ring = tower.footprint?.[0];
    if (!ring || ring.length < 4 || tower.futureDevelopment) return;
    out.push({ index, tower });
  });
  return out;
}

/** The body outline actually extruded for a tower (H block inside the analysed rectangle). */
export function towerBodyRing(t: TowerSpec): LngLat[] {
  const ring = t.footprint![0]!;
  const shape = (t.shape ?? "H").toUpperCase();
  return shape === "H" ? hFootprint(ring, 0.38, 0.6, TOWER_INSET) : ring;
}

function stringHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** One GeoJSON point per current tower (all at the plot centroid; the mesh carries the offset). */
export function buildTowerPoints(p: LoadedProject): GeoJSON.Feature[] {
  const [lng, lat] = plotCentroid(p);
  const projectId = p.ids?.project ?? null;
  return currentTowers(p).map(({ index, tower }) => ({
    type: "Feature",
    id: ((stringHash(p.slug) % 0x1000000) << 4) + index, // numeric id: model layers hit-test by feature id
    geometry: { type: "Point", coordinates: [lng, lat] },
    properties: {
      kind: "tower",
      model: towerModelKey(p.slug, index),
      slug: p.slug,
      projectId,
      name: tower.name,
      phase: tower.phase ?? null,
      floors: tower.floors ?? null,
    },
  }));
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

interface MeshData {
  pos: number[];
  nrm: number[];
  uv: number[];
  idx: number[];
}

function signedArea(pts: XY[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Ear clipping for a simple polygon given counter-clockwise; returns index triples. */
function triangulate(pts: XY[]): number[] {
  const area2 = (a: XY, b: XY, c: XY) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inside = (p: XY, a: XY, b: XY, c: XY) => area2(a, b, p) > 1e-9 && area2(b, c, p) > 1e-9 && area2(c, a, p) > 1e-9;
  const idx = pts.map((_, i) => i);
  const out: number[] = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 4 * pts.length) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const i0 = idx[(i + idx.length - 1) % idx.length]!;
      const i1 = idx[i]!;
      const i2 = idx[(i + 1) % idx.length]!;
      const a = pts[i0]!;
      const b = pts[i1]!;
      const c = pts[i2]!;
      if (area2(a, b, c) <= 1e-9) continue; // reflex or degenerate corner
      if (idx.some((j) => j !== i0 && j !== i1 && j !== i2 && inside(pts[j]!, a, b, c))) continue;
      out.push(i0, i1, i2);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (idx.length === 3) out.push(idx[0]!, idx[1]!, idx[2]!);
  else if (idx.length > 3) for (let i = 1; i + 1 < idx.length; i++) out.push(idx[0]!, idx[i]!, idx[i + 1]!); // fallback fan
  return out;
}

/**
 * Walls and roof of one tower in metres relative to `anchor` (east, up, south).
 * Wall UVs tile the facade texture: u in bays, v in floors (negative so the
 * image's top is the top of each floor).
 */
function towerMesh(ring: LngLat[], anchor: LngLat, base: number, top: number, floors: number): { walls: MeshData; roof: MeshData } {
  const m = metersPerDeg(anchor[1]);
  let pts: XY[] = ring.map((p) => [(p[0] - anchor[0]) * m.x, (p[1] - anchor[1]) * m.y]);
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  if (pts.length > 1 && Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-6) pts = pts.slice(0, -1);
  if (signedArea(pts) < 0) pts = pts.slice().reverse(); // counter-clockwise, interior on the left

  const floorH = (top - base) / Math.max(1, floors);
  const v = (h: number) => -(h - base) / (floorH * CELLS);
  const walls: MeshData = { pos: [], nrm: [], uv: [], idx: [] };
  let along = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const dx = b[0] - a[0];
    const dn = b[1] - a[1];
    const len = Math.hypot(dx, dn);
    if (len < 1e-6) continue;
    const u0 = along / (BAY_M * CELLS);
    const u1 = (along + len) / (BAY_M * CELLS);
    along += len;
    const n = [dn / len, 0, dx / len]; // outward normal (right of the edge direction), glTF axes
    const quad: Array<[number, number, number, number, number]> = [
      [a[0], base, -a[1], u0, v(base)],
      [b[0], base, -b[1], u1, v(base)],
      [b[0], top, -b[1], u1, v(top)],
      [a[0], top, -a[1], u0, v(top)],
    ];
    const start = walls.pos.length / 3;
    for (const [x, y, z, u, vv] of quad) {
      walls.pos.push(x, y, z);
      walls.nrm.push(n[0]!, n[1]!, n[2]!);
      walls.uv.push(u, vv);
    }
    walls.idx.push(start, start + 1, start + 2, start, start + 2, start + 3);
  }

  const roof: MeshData = { pos: [], nrm: [], uv: [], idx: [] };
  for (const p of pts) {
    roof.pos.push(p[0], top, -p[1]);
    roof.nrm.push(0, 1, 0);
    roof.uv.push(0, 0);
  }
  roof.idx = triangulate(pts);
  return { walls, roof };
}

// ---------------------------------------------------------------------------
// Textures (canvas -> PNG bytes)
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgb(c: [number, number, number]) {
  return `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;
}
function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
const WHITE: [number, number, number] = [255, 255, 255];
const BLACK: [number, number, number] = [0, 0, 0];

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pngBytes(canvas: HTMLCanvasElement): Uint8Array {
  const b64 = canvas.toDataURL("image/png").split(",")[1] ?? "";
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Cell layout in pixels (one bay x one floor), y = 0 is the top of the floor.
const PIER = 10;
const WIN_TOP = 12;
const WIN_BOTTOM = 94;
const RAIL_BOTTOM = 106;

/** Base colour map and emissive (lit windows) map for a facade. */
function facadeTextures(facade: Facade, seed: number): { base: Uint8Array; emissive: Uint8Array } | null {
  if (typeof document === "undefined") return null;
  const base = hexToRgb(facade.base);
  const accent = hexToRgb(facade.accent);
  const glass = hexToRgb(facade.glass);
  const rand = mulberry32(seed);

  const canvas = document.createElement("canvas");
  canvas.width = TEX_PX;
  canvas.height = TEX_PX;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  // ---- base colour ----
  ctx.fillStyle = rgb(base);
  ctx.fillRect(0, 0, TEX_PX, TEX_PX);
  for (let row = 0; row < CELLS; row++) {
    for (let col = 0; col < CELLS; col++) {
      const x = col * CELL_PX;
      const y = row * CELL_PX;
      // Piers: a shaded right edge gives the bays relief; every 4th bay is an accent strip.
      ctx.fillStyle = rgb(col === CELLS - 1 ? accent : mix(base, BLACK, 0.06));
      ctx.fillRect(x, y, PIER, CELL_PX);
      ctx.fillStyle = rgb(col === CELLS - 1 ? mix(accent, BLACK, 0.2) : mix(base, BLACK, 0.14));
      ctx.fillRect(x + CELL_PX - PIER, y, PIER, CELL_PX);
      // Window band: glass with a sky-to-ground gradient, two mullions and a transom.
      const g = ctx.createLinearGradient(0, y + WIN_TOP, 0, y + WIN_BOTTOM);
      g.addColorStop(0, rgb(mix(glass, WHITE, 0.3)));
      g.addColorStop(0.55, rgb(glass));
      g.addColorStop(1, rgb(mix(glass, BLACK, 0.22)));
      ctx.fillStyle = g;
      ctx.fillRect(x + PIER, y + WIN_TOP, CELL_PX - 2 * PIER, WIN_BOTTOM - WIN_TOP);
      ctx.fillStyle = rgb(mix(glass, BLACK, 0.45));
      const paneW = (CELL_PX - 2 * PIER) / 3;
      ctx.fillRect(x + PIER + paneW - 1, y + WIN_TOP, 2, WIN_BOTTOM - WIN_TOP);
      ctx.fillRect(x + PIER + 2 * paneW - 1, y + WIN_TOP, 2, WIN_BOTTOM - WIN_TOP);
      ctx.fillRect(x + PIER, y + WIN_TOP + 28, CELL_PX - 2 * PIER, 1);
      // Balcony railing (glass balustrade) and the accent slab under it.
      ctx.fillStyle = rgb(mix(base, glass, 0.4));
      ctx.fillRect(x + PIER, y + WIN_BOTTOM, CELL_PX - 2 * PIER, RAIL_BOTTOM - WIN_BOTTOM);
      ctx.fillStyle = rgb(mix(base, BLACK, 0.3));
      for (let rx = x + PIER + 6; rx < x + CELL_PX - PIER; rx += 9) ctx.fillRect(rx, y + WIN_BOTTOM, 1, RAIL_BOTTOM - WIN_BOTTOM);
      ctx.fillStyle = rgb(accent);
      ctx.fillRect(x, y + RAIL_BOTTOM, CELL_PX, CELL_PX - RAIL_BOTTOM);
      ctx.fillStyle = rgb(mix(accent, WHITE, 0.35));
      ctx.fillRect(x, y + RAIL_BOTTOM, CELL_PX, 2);
      ctx.fillStyle = rgb(mix(accent, BLACK, 0.3));
      ctx.fillRect(x, y + CELL_PX - 3, CELL_PX, 3);
    }
  }
  const baseBytes = pngBytes(canvas);

  // ---- emissive: a random subset of windows lit in warm (and a few cool) tones ----
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, TEX_PX, TEX_PX);
  const warm: [number, number, number] = [255, 205, 140];
  const cool: [number, number, number] = [214, 228, 255];
  for (let row = 0; row < CELLS; row++) {
    for (let col = 0; col < CELLS; col++) {
      if (rand() > 0.58) continue;
      const x = col * CELL_PX;
      const y = row * CELL_PX;
      const k = 0.45 + rand() * 0.55;
      const tone = rand() < 0.2 ? cool : warm;
      ctx.fillStyle = rgb([tone[0] * k, tone[1] * k, tone[2] * k]);
      ctx.fillRect(x + PIER, y + WIN_TOP, CELL_PX - 2 * PIER, WIN_BOTTOM - WIN_TOP);
      // Mullions stay dark so lit bays still read as three panes.
      ctx.fillStyle = "#000";
      const paneW = (CELL_PX - 2 * PIER) / 3;
      ctx.fillRect(x + PIER + paneW - 1, y + WIN_TOP, 2, WIN_BOTTOM - WIN_TOP);
      ctx.fillRect(x + PIER + 2 * paneW - 1, y + WIN_TOP, 2, WIN_BOTTOM - WIN_TOP);
    }
  }
  const emissiveBytes = pngBytes(canvas);
  return { base: baseBytes, emissive: emissiveBytes };
}

// ---------------------------------------------------------------------------
// GLB packing
// ---------------------------------------------------------------------------

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

interface GltfJson {
  asset: { version: string; generator: string };
  scene: number;
  scenes: Array<{ nodes: number[] }>;
  nodes: Array<{ mesh: number; name: string }>;
  meshes: Array<{ primitives: Array<Record<string, unknown>> }>;
  materials: Array<Record<string, unknown>>;
  textures?: Array<{ sampler: number; source: number }>;
  samplers?: Array<Record<string, number>>;
  images?: Array<{ bufferView: number; mimeType: string }>;
  accessors: Array<Record<string, unknown>>;
  bufferViews: Array<{ buffer: number; byteOffset: number; byteLength: number; target?: number }>;
  buffers: Array<{ byteLength: number }>;
}

class BinBuilder {
  private parts: Uint8Array[] = [];
  private length = 0;
  readonly views: GltfJson["bufferViews"] = [];
  add(bytes: Uint8Array, target?: number): number {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) {
      this.parts.push(new Uint8Array(pad));
      this.length += pad;
    }
    const view = { buffer: 0, byteOffset: this.length, byteLength: bytes.byteLength, ...(target ? { target } : {}) };
    this.views.push(view);
    this.parts.push(bytes);
    this.length += bytes.byteLength;
    return this.views.length - 1;
  }
  bytes(): Uint8Array {
    const pad = (4 - (this.length % 4)) % 4;
    const out = new Uint8Array(this.length + pad);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.byteLength;
    }
    return out;
  }
}

function f32(a: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(a).buffer);
}
function u16(a: number[]): Uint8Array {
  return new Uint8Array(new Uint16Array(a).buffer);
}

function addMesh(json: GltfJson, bin: BinBuilder, mesh: MeshData, material: number): Record<string, unknown> {
  const posView = bin.add(f32(mesh.pos), 34962);
  const nrmView = bin.add(f32(mesh.nrm), 34962);
  const uvView = bin.add(f32(mesh.uv), 34962);
  const idxView = bin.add(u16(mesh.idx), 34963);
  const count = mesh.pos.length / 3;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, mesh.pos[i + k]!);
      max[k] = Math.max(max[k]!, mesh.pos[i + k]!);
    }
  }
  const a0 = json.accessors.length;
  json.accessors.push(
    { bufferView: posView, componentType: 5126, count, type: "VEC3", min, max },
    { bufferView: nrmView, componentType: 5126, count, type: "VEC3" },
    { bufferView: uvView, componentType: 5126, count, type: "VEC2" },
    { bufferView: idxView, componentType: 5123, count: mesh.idx.length, type: "SCALAR" },
  );
  return { attributes: { POSITION: a0, NORMAL: a0 + 1, TEXCOORD_0: a0 + 2 }, indices: a0 + 3, material, mode: 4 };
}

function packGLB(json: GltfJson, bin: Uint8Array): ArrayBuffer {
  const enc = new TextEncoder();
  const jsonBytes = enc.encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.byteLength % 4)) % 4;
  const jsonLen = jsonBytes.byteLength + jsonPad;
  const total = 12 + 8 + jsonLen + 8 + bin.byteLength;
  const out = new ArrayBuffer(total);
  const dv = new DataView(out);
  const u8 = new Uint8Array(out);
  dv.setUint32(0, 0x46546c67, true); // "glTF"
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, 0x4e4f534a, true); // JSON
  u8.set(jsonBytes, 20);
  for (let i = 0; i < jsonPad; i++) u8[20 + jsonBytes.byteLength + i] = 0x20;
  const binStart = 20 + jsonLen;
  dv.setUint32(binStart, bin.byteLength, true);
  dv.setUint32(binStart + 4, 0x004e4942, true); // BIN
  u8.set(bin, binStart + 8);
  return out;
}

/** Build one tower variant as a binary glTF. Returns null outside a browser (no canvas). */
export function buildTowerGLB(p: LoadedProject, towerIndex: number, variant: ModelVariant): ArrayBuffer | null {
  const t = p.towers?.[towerIndex];
  if (!t || !t.footprint?.[0] || t.futureDevelopment) return null;
  const facade = p.facade ?? DEFAULT_FACADE;
  const tex = facadeTextures(facade, stringHash(towerModelKey(p.slug, towerIndex)));
  if (!tex) return null;

  const podiumH = Math.max(0, (p.podiumLevels ?? 0) * PODIUM_LEVEL_M);
  const top = podiumH + towerHeightM(t);
  const floors = Math.max(1, Math.round(t.floors ?? towerHeightM(t) / FLOOR_HEIGHT_M));
  const { walls, roof } = towerMesh(towerBodyRing(t), plotCentroid(p), podiumH, top, floors);

  const bin = new BinBuilder();
  const json: GltfJson = {
    asset: { version: "2.0", generator: "geo-map-analytics towerModel" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: `${p.slug}/${t.name}` }],
    meshes: [{ primitives: [] }],
    materials: [],
    accessors: [],
    bufferViews: bin.views,
    buffers: [],
  };
  const roofColor = hexToRgb(facade.base).map((c) => srgbToLinear(c * 0.78));
  const night = variant === "night";
  const baseImg = bin.add(tex.base);
  const images: NonNullable<GltfJson["images"]> = [{ bufferView: baseImg, mimeType: "image/png" }];
  const textures: NonNullable<GltfJson["textures"]> = [{ sampler: 0, source: 0 }];
  const facadeMat: Record<string, unknown> = {
    name: "facade",
    pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.75 },
    doubleSided: false,
  };
  if (night) {
    const emissiveImg = bin.add(tex.emissive);
    images.push({ bufferView: emissiveImg, mimeType: "image/png" });
    textures.push({ sampler: 0, source: 1 });
    facadeMat.emissiveTexture = { index: 1 };
    facadeMat.emissiveFactor = [1, 1, 1];
  }
  json.materials.push(facadeMat, {
    name: "roof",
    pbrMetallicRoughness: { baseColorFactor: [...roofColor, 1], metallicFactor: 0, roughnessFactor: 0.9 },
    emissiveFactor: night ? [0.04, 0.045, 0.06] : [0, 0, 0],
  });
  json.images = images;
  json.textures = textures;
  json.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
  json.meshes[0]!.primitives.push(addMesh(json, bin, walls, 0), addMesh(json, bin, roof, 1));
  const binBytes = bin.bytes();
  json.buffers.push({ byteLength: binBytes.byteLength });
  return packGLB(json, binBytes);
}

// Blob URLs survive style reloads (the Mapbox model registry does not), so the
// GLBs are built once per page and re-registered from the cache.
const urlCache = new Map<string, string | null>();

export function towerModelUrl(p: LoadedProject, towerIndex: number, variant: ModelVariant): string | null {
  const id = towerModelId(p.slug, towerIndex, variant);
  if (urlCache.has(id)) return urlCache.get(id)!;
  let url: string | null = null;
  try {
    const glb = buildTowerGLB(p, towerIndex, variant);
    if (glb) url = URL.createObjectURL(new Blob([glb], { type: "model/gltf-binary" }));
  } catch (err) {
    console.warn("[gm] tower model build failed", id, err);
  }
  urlCache.set(id, url);
  return url;
}
