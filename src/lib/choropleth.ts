// src/lib/choropleth.ts
// Drives the choropleth fills: writes metric values into feature-state and
// cross-fades between two fill layers ("slots") so month changes animate
// smoothly on the GPU instead of snapping.

import type { Map as MapboxMap, ExpressionSpecification } from "mapbox-gl";
import { TILESETS } from "@/config/tilesets";
import { LYR, SRC, CHOROPLETH_OPACITY } from "@/config/layers";
import type { Level, MetricsDoc } from "@/lib/types";
import { toNumericId } from "@/lib/types";

type Slot = "a" | "b";
type Expr = ExpressionSpecification;
const expr = (e: unknown) => e as Expr;

const other = (s: Slot): Slot => (s === "a" ? "b" : "a");

const LAYERS: Record<Level, Record<Slot, string>> = {
  micromarkets: { a: LYR.mmFillA, b: LYR.mmFillB },
  localities: { a: LYR.locFillA, b: LYR.locFillB },
};
const EXTRUDE: Record<Level, string> = { micromarkets: LYR.mmExtrude, localities: LYR.locExtrude };
const SOURCE: Record<Level, { source: string; sourceLayer: string }> = {
  micromarkets: { source: SRC.micromarkets, sourceLayer: TILESETS.micromarkets.sourceLayer },
  localities: { source: SRC.localities, sourceLayer: TILESETS.localities.sourceLayer },
};

export type PaintSpec = {
  stops: number[]; // bucketCount + 1 ascending values
  palette: string[]; // bucketCount colours, low -> high
  missing: string;
};

function strictlyIncreasing(stops: number[]): number[] {
  const out = stops.slice();
  for (let i = 1; i < out.length; i++) {
    if (!(out[i]! > out[i - 1]!)) out[i] = out[i - 1]! + Math.max(1e-6, Math.abs(out[i - 1]!) * 1e-9);
  }
  return out;
}

function valueExpr(stateKey: string): unknown {
  return ["coalesce", ["feature-state", stateKey], -1];
}

export function bucketColorExpr(stateKey: string, spec: PaintSpec): Expr {
  const v = valueExpr(stateKey);
  const stops = strictlyIncreasing(spec.stops);
  const palette = spec.palette.slice(0, Math.max(1, stops.length - 1));
  const step: unknown[] = ["step", v, palette[0] ?? spec.missing];
  for (let i = 1; i < palette.length; i++) step.push(stops[i], palette[i]);
  return expr(["case", ["<", v, 0], spec.missing, step]);
}

export class ChoroplethEngine {
  private active: Slot = "a";
  private shownLevel: Level | null = null;
  private lastMonth: string | null = null;
  private lastDocKey: string | null = null;
  private joinKeyById: Record<Level, Map<number, string>> = { micromarkets: new Map(), localities: new Map() };
  private stated: Record<Level, Set<number>> = { micromarkets: new Set(), localities: new Set() };
  private opacity = CHOROPLETH_OPACITY;
  private extrudeLevel: Level | null = null;

  constructor(private map: MapboxMap) {}

  // ---------------------------------------------------------------
  // Discovery of feature ids (and join keys) from loaded tiles
  // ---------------------------------------------------------------
  discover(level: Level, doc?: MetricsDoc | null): number {
    const map = this.map;
    const { source, sourceLayer } = SOURCE[level];
    const known = this.joinKeyById[level];
    let added = 0;

    if (level === "micromarkets" && doc) {
      // Micromarket join key IS the feature id, so we can seed from the metrics doc
      // before tiles are even loaded.
      for (const m of Object.keys(doc.byMonth ?? {})) {
        for (const k of Object.keys(doc.byMonth[m] ?? {})) {
          const id = toNumericId(k);
          if (id !== null && !known.has(id)) {
            known.set(id, k);
            added++;
          }
        }
      }
    }

    if (!map.getSource(source)) return added;
    let feats: Array<{ id?: unknown; properties?: unknown }> = [];
    try {
      feats = map.querySourceFeatures(source, { sourceLayer }) as unknown as typeof feats;
    } catch {
      return added;
    }
    for (const f of feats) {
      const id = toNumericId(f.id);
      if (id === null || known.has(id)) continue;
      const props = (f.properties ?? {}) as Record<string, unknown>;
      const joinKey = level === "micromarkets" ? String(id) : typeof props.LocalityName === "string" ? props.LocalityName : "";
      if (!joinKey) continue;
      known.set(id, joinKey);
      added++;
    }
    return added;
  }

  private writeState(level: Level, ids: Iterable<number>, byMonth: Record<string, { v?: number | null; n?: number | null }>, slots: Slot[]) {
    const map = this.map;
    const { source, sourceLayer } = SOURCE[level];
    const keys = this.joinKeyById[level];
    for (const id of ids) {
      const joinKey = keys.get(id) ?? "";
      const bucket = joinKey ? byMonth[joinKey] : undefined;
      const v = typeof bucket?.v === "number" && Number.isFinite(bucket.v) ? bucket.v : null;
      const n = typeof bucket?.n === "number" ? bucket.n : null;
      const state: Record<string, unknown> = { v, n };
      for (const s of slots) state[s] = v;
      map.setFeatureState({ source, sourceLayer, id }, state);
    }
  }

  // ---------------------------------------------------------------
  // Opacity / transitions
  // ---------------------------------------------------------------
  private setOpacity(layerId: string, value: number, durationMs: number) {
    const map = this.map;
    if (!map.getLayer(layerId)) return;
    map.setPaintProperty(layerId, "fill-opacity-transition", { duration: Math.max(0, Math.round(durationMs)), delay: 0 });
    map.setPaintProperty(layerId, "fill-opacity", value);
  }

  private showLevelSlot(level: Level | null, slot: Slot, durationMs: number) {
    for (const lvl of ["micromarkets", "localities"] as Level[]) {
      for (const s of ["a", "b"] as Slot[]) {
        const on = lvl === level && s === slot;
        this.setOpacity(LAYERS[lvl][s], on ? this.opacity : 0, durationMs);
      }
    }
  }

  hideAll(durationMs = 250) {
    this.showLevelSlot(null, "a", durationMs);
    this.shownLevel = null;
  }

  setOpacityLevel(opacity: number) {
    this.opacity = opacity;
    if (this.shownLevel) this.showLevelSlot(this.shownLevel, this.active, 200);
  }

  // ---------------------------------------------------------------
  // Main entry
  // ---------------------------------------------------------------
  /**
   * Make sure (level, doc, month) is what the map shows. A month change on the
   * same level cross-fades between slots over `durationMs`; a level/doc change
   * switches immediately (with a short fade in).
   */
  render(opts: { level: Level; doc: MetricsDoc; month: string; durationMs: number }) {
    const { level, doc, month, durationMs } = opts;
    const docKey = `${doc.metric}|${level}`;
    const byMonth = doc.byMonth?.[month] ?? {};

    this.discover(level, doc);
    const ids = Array.from(this.joinKeyById[level].keys());

    const levelChanged = level !== this.shownLevel;
    const docChanged = docKey !== this.lastDocKey;

    if (levelChanged || docChanged || this.lastMonth === null) {
      // Hard set: both slots get the same values so no stale colours can leak.
      this.writeState(level, ids, byMonth, ["a", "b"]);
      this.stated[level] = new Set(ids);
      this.showLevelSlot(level, this.active, levelChanged ? 350 : 150);
    } else if (month !== this.lastMonth) {
      const target = other(this.active);
      this.writeState(level, ids, byMonth, [target]);
      this.stated[level] = new Set(ids);
      this.showLevelSlot(level, target, durationMs);
      this.active = target;
    }

    this.shownLevel = level;
    this.lastMonth = month;
    this.lastDocKey = docKey;
  }

  /** Call after new tiles load so features seen for the first time get a value. */
  syncNewIds(level: Level, doc: MetricsDoc, month: string): number {
    if (this.shownLevel !== level) return 0;
    this.discover(level, doc);
    const byMonth = doc.byMonth?.[month] ?? {};
    const fresh: number[] = [];
    for (const id of this.joinKeyById[level].keys()) {
      if (!this.stated[level].has(id)) fresh.push(id);
    }
    if (!fresh.length) return 0;
    this.writeState(level, fresh, byMonth, ["a", "b"]);
    for (const id of fresh) this.stated[level].add(id);
    return fresh.length;
  }

  /** Current value for a feature as last written (for hover cards). */
  joinKeyFor(level: Level, id: number): string | undefined {
    return this.joinKeyById[level].get(id);
  }

  // ---------------------------------------------------------------
  // Paint
  // ---------------------------------------------------------------
  private lastPaint: PaintSpec | null = null;

  setPaint(spec: PaintSpec, extrude: { maxHeight: number } | null) {
    const map = this.map;
    this.lastPaint = spec;
    for (const lvl of ["micromarkets", "localities"] as Level[]) {
      for (const s of ["a", "b"] as Slot[]) {
        const id = LAYERS[lvl][s];
        if (map.getLayer(id)) map.setPaintProperty(id, "fill-color", bucketColorExpr(s, spec));
      }
      // Only paint the extrusion layer that is actually visible. Mapbox never
      // recalculates hidden layers, so a paint change on one would leave a transition
      // pending forever and keep the map repainting (it never reaches `idle`).
      if (this.extrudeLevel === lvl) this.applyExtrudePaint(lvl, spec, extrude?.maxHeight);
    }
  }

  private applyExtrudePaint(lvl: Level, spec: PaintSpec, maxHeight?: number) {
    const map = this.map;
    const ex = EXTRUDE[lvl];
    if (!map.getLayer(ex)) return;
    map.setPaintProperty(ex, "fill-extrusion-color", bucketColorExpr("v", spec));
    const v = valueExpr("v");
    const lo = spec.stops[0] ?? 0;
    const hi = spec.stops[spec.stops.length - 1] ?? lo + 1;
    const H = maxHeight ?? (lvl === "micromarkets" ? 3000 : 1200);
    map.setPaintProperty(
      ex,
      "fill-extrusion-height",
      expr(["case", ["<", v, 0], 0, ["interpolate", ["linear"], v, lo, H * 0.08, hi > lo ? hi : lo + 1, H]])
    );
  }

  setExtrusion(level: Level | null) {
    const map = this.map;
    this.extrudeLevel = level;
    for (const lvl of ["micromarkets", "localities"] as Level[]) {
      const id = EXTRUDE[lvl];
      if (!map.getLayer(id)) continue;
      const show = lvl === level;
      map.setLayoutProperty(id, "visibility", show ? "visible" : "none");
      if (show && this.lastPaint) this.applyExtrudePaint(lvl, this.lastPaint);
    }
  }

  getExtrusion() {
    return this.extrudeLevel;
  }

  getShownLevel() {
    return this.shownLevel;
  }

  /** Forget what is on screen (after a style reload) so the next render re-applies everything. */
  reset() {
    this.active = "a";
    this.shownLevel = null;
    this.lastMonth = null;
    this.lastDocKey = null;
    this.stated = { micromarkets: new Set(), localities: new Set() };
  }
}
