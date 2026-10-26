"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import mapboxgl, { MapMouseEvent } from "mapbox-gl";
import type { Map as MapboxMap, FitBoundsOptions, LngLatLike } from "mapbox-gl";
import { TILESETS } from "@/config/tilesets";
import { METRICS, getMetricDef } from "@/config/metrics";
import {
  CITY_BOUNDS,
  CHOROPLETH_OPACITY,
  DEFAULT_BEARING_3D,
  DEFAULT_CENTER,
  DEFAULT_PITCH_3D,
  DEFAULT_ZOOM,
  LYR,
  SRC,
  STATUS_GROUPS,
  UI,
  Z_LOC,
  Z_PROJ,
  Z_FADE,
  type BasemapTheme,
  type LightPreset,
  type ZoomBand,
  missingColorFor,
  paletteFor,
  zoomBand,
} from "@/config/layers";
import { computeQuantileStops, formatBucketRanges, collectDocValues } from "@/lib/quantiles";
import { addDataSources, addDataLayers, applyPresetColors, setVisibility, setFilterSafe, FILTERS } from "@/lib/mapLayers";
import { ChoroplethEngine } from "@/lib/choropleth";
import { FeatureIndex, bboxToBounds } from "@/lib/featureIndex";
import { carryForward, type FilledDoc } from "@/lib/carryForward";
import { toCsv, downloadText } from "@/lib/export";
import type { DimDoc, DimItem, Level, MetricsDoc, PinnedSelection } from "@/lib/types";
import { toNumericId, normalizeName } from "@/lib/types";

// URL state written by this version; view params from older URLs are ignored so a
// stale `light=day` left in the address bar cannot override the night default.
const URL_VERSION = "4";

function findNormalized<T>(rows: Record<string, T>, key: string): T | undefined {
  const want = normalizeName(key);
  for (const k of Object.keys(rows)) if (normalizeName(k) === want) return rows[k];
  return undefined;
}

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------
type InspectKind = "micromarkets" | "localities" | "projects" | "roads" | "city";
type InspectTarget = "auto" | InspectKind;
type LevelMode = "auto" | Level;
type ScaleMode = "fixed" | "month";
type PlaySpeed = "slow" | "normal" | "fast";

type PickInfo = {
  kind: InspectKind;
  name: string;
  featureId: number | null;
  properties: Record<string, unknown>;
  lngLat: { lng: number; lat: number };
};

type Focus = { mmId: number | null; mmName: string; locId: number | null; locName: string };
const NO_FOCUS: Focus = { mmId: null, mmName: "", locId: null, locName: "" };

type RenderedFeature = {
  id?: unknown;
  properties?: Record<string, unknown> | null;
  geometry?: unknown;
  layer?: { id?: string };
};

const FIT_MM: FitBoundsOptions = { padding: 70, duration: 1100, maxZoom: Z_LOC + 0.7, essential: true };

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------
function safeJson(v: unknown) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
function fmtMoney(v: number) {
  if (!Number.isFinite(v)) return "-";
  return v.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}
function parseMonthLabel(yyyyMm01: string) {
  const d = new Date(yyyyMm01 + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return yyyyMm01;
  return d.toLocaleString("en-US", { month: "short", year: "numeric" });
}
function getStrProp(props: Record<string, unknown> | null | undefined, key: string): string {
  const v = props?.[key];
  return typeof v === "string" ? v : "";
}
function isShiftPressed(evt: unknown): boolean {
  if (!evt || typeof evt !== "object") return false;
  const e = evt as { shiftKey?: unknown; getModifierState?: unknown };
  if (typeof e.shiftKey === "boolean") return e.shiftKey;
  if (typeof e.getModifierState === "function") return Boolean((e.getModifierState as (k: string) => boolean)("Shift"));
  return false;
}
function isEditableTarget(t: EventTarget | null): boolean {
  if (!t || !(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || t.isContentEditable;
}
function boundsFromGeometry(geometry: unknown): [[number, number], [number, number]] | null {
  const pts: Array<[number, number]> = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node) && node.length === 2 && typeof node[0] === "number" && typeof node[1] === "number") {
      pts.push(node as [number, number]);
      return;
    }
    if (Array.isArray(node)) for (const c of node) walk(c);
  };
  const g = geometry as { coordinates?: unknown } | undefined;
  walk(g?.coordinates);
  if (!pts.length) return null;
  let minLng = Infinity,
    minLat = Infinity,
    maxLng = -Infinity,
    maxLat = -Infinity;
  for (const [x, y] of pts) {
    minLng = Math.min(minLng, x);
    minLat = Math.min(minLat, y);
    maxLng = Math.max(maxLng, x);
    maxLat = Math.max(maxLat, y);
  }
  if (minLng === maxLng) {
    minLng -= 0.001;
    maxLng += 0.001;
  }
  if (minLat === maxLat) {
    minLat -= 0.001;
    maxLat += 0.001;
  }
  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
}
function formatDelta(vNow: number | null, vPrev: number | null) {
  if (vNow === null || vPrev === null) return { abs: "-", pct: "-" };
  const abs = vNow - vPrev;
  const pct = vPrev !== 0 ? (abs / vPrev) * 100 : null;
  return {
    abs: (abs >= 0 ? "+" : "") + fmtMoney(Math.round(abs)),
    pct: pct === null ? "-" : `${abs >= 0 ? "+" : ""}${pct.toFixed(1)}%`,
  };
}
function buildSparklinePath(values: number[], w: number, h: number) {
  if (values.length < 2) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = 2;
  const innerW = Math.max(1, w - pad * 2);
  const innerH = Math.max(1, h - pad * 2);
  const denom = max - min;
  const normY = (v: number) => (denom === 0 ? pad + innerH / 2 : pad + (1 - (v - min) / denom) * innerH);
  const step = innerW / (values.length - 1);
  let d = `M ${pad} ${normY(values[0]!).toFixed(2)}`;
  for (let i = 1; i < values.length; i++) d += ` L ${(pad + step * i).toFixed(2)} ${normY(values[i]!).toFixed(2)}`;
  return d;
}
function isoCompactNow() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
}

const hitLayerFor: Record<InspectKind, string> = {
  micromarkets: LYR.hitMm,
  localities: LYR.hitLoc,
  projects: LYR.hitProjects,
  roads: LYR.hitRoads,
  city: LYR.hitCity,
};

// Panel building blocks (module scope so their identity is stable across renders;
// defining them inside the component would remount inputs on every keystroke).
function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12, padding: 10, border: `1px solid ${UI.panelBorder}`, borderRadius: 8, background: "rgba(255,255,255,0.03)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ fontWeight: 600 }}>{title}</div>
        {right}
      </div>
      {children}
    </div>
  );
}
function Check({ label, checked, onChange, disabled, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; hint?: string }) {
  return (
    <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6, fontSize: 12, opacity: disabled ? 0.55 : 1 }} title={hint}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
function Label({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, opacity: 0.9, marginBottom: 4 }}>{children}</div>;
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------
export default function MapView() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  const engineRef = useRef<ChoroplethEngine | null>(null);
  const indexRef = useRef<FeatureIndex>(new FeatureIndex());
  const popupRef = useRef<mapboxgl.Popup | null>(null);
  const hoverStateRef = useRef<{ level: Level; id: number } | null>(null);
  // Last cursor position over the canvas (null when the pointer left it).
  const hoverPointRef = useRef<{ x: number; y: number } | null>(null);
  // Focus to apply at the end of a click-driven camera move (beats the centre probe).
  const focusHintRef = useRef<Focus | null>(null);
  // Camera helper defined inside the map init (needs map + index); exposed for search.
  const zoomToAreaRef = useRef<((level: Level, id: number, name: string) => boolean) | null>(null);
  // Re-evaluates the hover card (e.g. after the month changes during playback).
  const rehoverRef = useRef<(() => void) | null>(null);
  // Project counts per locality / micromarket (public/dim/project_counts_city13.json).
  const countsRef = useRef<{ byLocality: Record<string, number>; byMicromarket: Record<string, number>; total: number } | null>(null);
  const rebuildCountsRef = useRef<(() => void) | null>(null);
  // Stops the slow orbit around a selected project (Esc, panel button, user move).
  const stopOrbitRef = useRef<(() => void) | null>(null);

  const [mapReady, setMapReady] = useState(false);
  const [hoverInfo, setHoverInfo] = useState<PickInfo | null>(null);
  const [clickInfo, setClickInfo] = useState<PickInfo | null>(null);

  // Drill-down state (driven by the camera)
  const [band, setBand] = useState<ZoomBand>("micromarkets");
  const [zoomDisplay, setZoomDisplay] = useState(DEFAULT_ZOOM);
  const [focus, setFocus] = useState<Focus>(NO_FOCUS);
  const [projectsInView, setProjectsInView] = useState(0);
  const [orbiting, setOrbiting] = useState(false);
  // Bumped whenever the style (re)loads so every map-touching effect re-applies itself.
  const [styleEpoch, setStyleEpoch] = useState(0);
  // Bumped when the engine's join rules change and the choropleth must re-render.
  const [renderNonce, setRenderNonce] = useState(0);
  const [restrictLoc, setRestrictLoc] = useState(true);
  const [restrictProj, setRestrictProj] = useState(true);

  // Layers
  const [showHeat, setShowHeat] = useState(false);
  const [showProjects, setShowProjects] = useState(true);
  const [showRoads, setShowRoads] = useState(false);
  const [showLabels, setShowLabels] = useState(true);
  const [showCounts, setShowCounts] = useState(true);
  const [extrude, setExtrude] = useState(false);
  const [inspectTarget, setInspectTarget] = useState<InspectTarget>("auto");

  // Basemap
  const [lightPreset, setLightPreset] = useState<LightPreset>("night");
  const [theme, setTheme] = useState<BasemapTheme>("default");
  const [enable3D, setEnable3D] = useState(true);
  const [terrain, setTerrain] = useState(false);
  const [showPlaceLabels, setShowPlaceLabels] = useState(true);
  const [showRoadLabels, setShowRoadLabels] = useState(false);
  const [showPoiLabels, setShowPoiLabels] = useState(false);
  // Performance mode: no 3D buildings/landmarks, no terrain.
  const [perfMode, setPerfMode] = useState(false);

  // Choropleth
  const [enableChoropleth, setEnableChoropleth] = useState(true);
  const [metricKey, setMetricKey] = useState<string>("asking_psf");
  const [levelMode, setLevelMode] = useState<LevelMode>("auto");
  const [scaleMode, setScaleMode] = useState<ScaleMode>("fixed");
  // Locality metrics are sparse: paint a month without a value with the latest earlier value.
  const [carryFwd, setCarryFwd] = useState(true);
  const [metricMonth, setMetricMonth] = useState<string>("");

  const docsRef = useRef<Record<string, Partial<Record<Level, MetricsDoc>>>>({});
  const filledRef = useRef<Record<string, Partial<Record<Level, FilledDoc>>>>({});
  const [active, setActive] = useState<{ level: Level; doc: MetricsDoc } | null>(null);

  const [legend, setLegend] = useState<{ stops: number[]; count: number; missing: number; carried: number; min: number | null; max: number | null }>({
    stops: [],
    count: 0,
    missing: 0,
    carried: 0,
    min: null,
    max: null,
  });

  // Compare pins
  const [pinA, setPinA] = useState<PinnedSelection | null>(null);
  const [pinB, setPinB] = useState<PinnedSelection | null>(null);

  // Playback
  const [isPlaying, setIsPlaying] = useState(false);
  const isPlayingRef = useRef(false);
  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);
  const [loopPlay, setLoopPlay] = useState(true);
  const [playSpeed, setPlaySpeed] = useState<PlaySpeed>("normal");
  const playStepMs = useMemo(() => (playSpeed === "slow" ? 1600 : playSpeed === "fast" ? 650 : 1000), [playSpeed]);

  // Search
  const [dimLocalities, setDimLocalities] = useState<DimItem[]>([]);
  const [dimMicromarkets, setDimMicromarkets] = useState<DimItem[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchScope, setSearchScope] = useState<Level>("localities");
  const [indexVersion, setIndexVersion] = useState(0);

  const shiftDownRef = useRef(false);
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------
  const effectiveLevel: Level = useMemo(() => {
    if (levelMode !== "auto") return levelMode;
    return band === "micromarkets" ? "micromarkets" : "localities";
  }, [levelMode, band]);

  const effectiveInspect: InspectKind = useMemo(() => {
    if (inspectTarget !== "auto") return inspectTarget;
    if (band === "projects" && showProjects) return "projects";
    if (band === "micromarkets") return "micromarkets";
    return "localities";
  }, [inspectTarget, band, showProjects]);

  const locById = useMemo(() => {
    const m = new Map<number, DimItem>();
    for (const d of dimLocalities) m.set(d.id, d);
    return m;
  }, [dimLocalities]);
  const mmById = useMemo(() => {
    const m = new Map<number, DimItem>();
    for (const d of dimMicromarkets) m.set(d.id, d);
    return m;
  }, [dimMicromarkets]);
  // Locality -> micromarket. Spatial (centroid inside the micromarket polygon) from the
  // feature index once tiles are indexed, with the dimension table as fallback.
  const locMmById = useMemo(() => {
    const m = indexRef.current.localityMicromarkets();
    for (const d of dimLocalities) {
      if (!m.has(d.id) && d.micromarketId !== null && d.micromarketId !== undefined) m.set(d.id, d.micromarketId);
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dimLocalities, indexVersion]);
  const locIdsByMm = useMemo(() => {
    const m = new Map<number, number[]>();
    for (const [id, mm] of locMmById) {
      if (!m.has(mm)) m.set(mm, []);
      m.get(mm)!.push(id);
    }
    return m;
  }, [locMmById]);

  const activeDoc: MetricsDoc | null = useMemo(() => {
    if (!active || active.level !== effectiveLevel) return null;
    if (carryFwd) return filledRef.current[metricKey]?.[effectiveLevel] ?? active.doc;
    return active.doc;
  }, [active, effectiveLevel, carryFwd, metricKey]);
  const monthOptions = useMemo(() => active?.doc.months ?? [], [active]);
  const def = useMemo(() => getMetricDef(metricKey), [metricKey]);
  const palette = useMemo(() => paletteFor(lightPreset, def.bucketCount), [lightPreset, def.bucketCount]);
  const bucketRanges = useMemo(() => formatBucketRanges(legend.stops), [legend.stops]);

  // Latest-state ref for map event handlers (avoids stale closures).
  const latest = useRef({
    effectiveLevel,
    effectiveInspect,
    activeDoc,
    metricMonth,
    focus,
    restrictLoc,
    restrictProj,
    locById,
    mmById,
    enableChoropleth,
    enable3D,
    def,
    playStepMs,
    lightPreset,
    metricKey,
    inspectAuto: inspectTarget === "auto",
    locMmById,
    carryFwd,
  });
  useEffect(() => {
    latest.current = {
      effectiveLevel,
      effectiveInspect,
      activeDoc,
      metricMonth,
      focus,
      restrictLoc,
      restrictProj,
      locById,
      mmById,
      enableChoropleth,
      enable3D,
      def,
      playStepMs,
      lightPreset,
      metricKey,
      inspectAuto: inspectTarget === "auto",
      locMmById,
      carryFwd,
    };
  });

  const stopPlayback = () => {
    if (isPlayingRef.current) setIsPlaying(false);
  };

  // ---------------------------------------------------------------------------
  // URL state
  // ---------------------------------------------------------------------------
  const initialCamRef = useRef<{ lng: number; lat: number; zoom: number; pitch?: number; bearing?: number } | null>(null);
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const cam = sp.get("cam");
    if (cam) {
      const p = cam.split(",").map(Number);
      if (p.length >= 3 && p.slice(0, 3).every((x) => Number.isFinite(x))) {
        initialCamRef.current = {
          lng: p[0]!,
          lat: p[1]!,
          zoom: p[2]!,
          pitch: Number.isFinite(p[3]) ? p[3] : undefined,
          bearing: Number.isFinite(p[4]) ? p[4] : undefined,
        };
      }
    }
    const m = sp.get("metric");
    const lvl = sp.get("level");
    const month = sp.get("month");
    const lp = sp.get("light");
    const th = sp.get("theme");
    const d3 = sp.get("d3");
    const ch = sp.get("ch");
    const heat = sp.get("heat");
    const scale = sp.get("scale");
    const ex = sp.get("ex");

    if (m && METRICS.some((x) => x.key === m)) setMetricKey(m);
    if (lvl === "auto" || lvl === "micromarkets" || lvl === "localities") setLevelMode(lvl);
    if (month) setMetricMonth(month);

    // View params only from URLs this version wrote (older ones carried day/2D defaults).
    if (sp.get("v") === URL_VERSION) {
      if (lp === "dawn" || lp === "day" || lp === "dusk" || lp === "night") setLightPreset(lp);
      if (th === "default" || th === "faded" || th === "monochrome") setTheme(th);
      if (d3 === "1") setEnable3D(true);
      if (d3 === "0") setEnable3D(false);
      if (ch === "0") setEnableChoropleth(false);
      if (heat === "1") setShowHeat(true);
      if (scale === "fixed" || scale === "month") setScaleMode(scale);
      if (ex === "1") setExtrude(true);
      if (sp.get("cf") === "0") setCarryFwd(false);
      if (sp.get("pm") === "1") setPerfMode(true);
    }

    const parsePin = (s: string | null): PinnedSelection | null => {
      if (!s) return null;
      const parts = s.split(":");
      const level = parts[0] as Level;
      const joinKey = decodeURIComponent(parts[1] ?? "");
      const displayName = decodeURIComponent(parts.slice(2).join(":") || joinKey);
      if (level !== "micromarkets" && level !== "localities") return null;
      return { level, joinKey, displayName, featureId: level === "micromarkets" ? toNumericId(joinKey) : null };
    };
    setPinA(parsePin(sp.get("pinA")));
    setPinB(parsePin(sp.get("pinB")));
  }, []);

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    // Only non-default values are written, so a fresh session keeps the defaults.
    const put = (k: string, v: string, def: string) => {
      if (v === def) sp.delete(k);
      else sp.set(k, v);
    };
    sp.set("v", URL_VERSION);
    put("metric", metricKey, "asking_psf");
    put("level", levelMode, "auto");
    if (metricMonth) sp.set("month", metricMonth);
    put("light", lightPreset, "night");
    put("theme", theme, "default");
    put("d3", enable3D ? "1" : "0", "1");
    put("ch", enableChoropleth ? "1" : "0", "1");
    put("heat", showHeat ? "1" : "0", "0");
    put("scale", scaleMode, "fixed");
    put("ex", extrude ? "1" : "0", "0");
    put("cf", carryFwd ? "1" : "0", "1");
    put("pm", perfMode ? "1" : "0", "0");
    const encPin = (p: PinnedSelection | null) =>
      p ? `${p.level}:${encodeURIComponent(p.joinKey)}:${encodeURIComponent(p.displayName)}` : null;
    const a = encPin(pinA);
    const b = encPin(pinB);
    if (a) sp.set("pinA", a);
    else sp.delete("pinA");
    if (b) sp.set("pinB", b);
    else sp.delete("pinB");
    window.history.replaceState({}, "", `${window.location.pathname}?${sp.toString()}`);
  }, [metricKey, levelMode, metricMonth, lightPreset, theme, enable3D, enableChoropleth, showHeat, scaleMode, extrude, carryFwd, perfMode, pinA, pinB]);

  // ---------------------------------------------------------------------------
  // Dims (search + drill-down joins)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [locRes, mmRes] = await Promise.all([
          fetch("/dim/localities_city13.json", { cache: "no-store" }),
          fetch("/dim/micromarkets_city13.json", { cache: "no-store" }),
        ]);
        if (!locRes.ok || !mmRes.ok) throw new Error(`dims: ${locRes.status}/${mmRes.status}`);
        const loc = (await locRes.json()) as DimDoc;
        const mm = (await mmRes.json()) as DimDoc;
        if (cancelled) return;
        setDimLocalities(loc.items ?? []);
        setDimMicromarkets(mm.items ?? []);
      } catch (e) {
        console.warn("Dim docs not found (run scripts/build_dims_public.py):", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Project counts (precomputed by scripts/build_project_counts.mjs)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/dim/project_counts_city13.json", { cache: "no-store" });
        if (!res.ok) throw new Error(`counts ${res.status}`);
        const doc = (await res.json()) as { byLocality: Record<string, number>; byMicromarket: Record<string, number>; total: number };
        if (cancelled) return;
        countsRef.current = doc;
        rebuildCountsRef.current?.();
      } catch (e) {
        console.warn("Project counts not found (run scripts/build_project_counts.mjs):", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Metrics docs: fetch both levels for the metric (so zooming across the
  // level threshold and pinned series never wait), then pick the active one.
  // ---------------------------------------------------------------------------
  const [docsVersion, setDocsVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const d = getMetricDef(metricKey);
    const levels: Level[] = ["micromarkets", "localities"];
    const missing = levels.filter((l) => !docsRef.current[metricKey]?.[l] && d.files[l]);
    if (!missing.length) return;
    (async () => {
      const results = await Promise.allSettled(
        missing.map(async (l) => {
          const res = await fetch(d.files[l], { cache: "no-store" });
          if (!res.ok) throw new Error(`metrics ${res.status} (${d.files[l]})`);
          return [l, (await res.json()) as MetricsDoc] as const;
        })
      );
      if (cancelled) return;
      docsRef.current[metricKey] = docsRef.current[metricKey] || {};
      filledRef.current[metricKey] = filledRef.current[metricKey] || {};
      let any = false;
      for (const r of results) {
        if (r.status === "fulfilled") {
          docsRef.current[metricKey]![r.value[0]] = r.value[1];
          filledRef.current[metricKey]![r.value[0]] = carryForward(r.value[1]);
          any = true;
        } else console.error("Failed to load metrics JSON:", r.reason);
      }
      if (any) setDocsVersion((v) => v + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [metricKey]);

  useEffect(() => {
    const doc = docsRef.current[metricKey]?.[effectiveLevel];
    if (!doc) return;
    setActive({ level: effectiveLevel, doc });
    setMetricMonth((prev) => prev || (doc.months?.[doc.months.length - 1] ?? ""));
  }, [metricKey, effectiveLevel, docsVersion]);

  useEffect(() => {
    if (!monthOptions.length) return;
    if (!metricMonth || !monthOptions.includes(metricMonth)) setMetricMonth(monthOptions[monthOptions.length - 1]!);
  }, [monthOptions, metricMonth]);

  const metricMonthIndex = useMemo(() => {
    if (!monthOptions.length) return 0;
    const idx = monthOptions.indexOf(metricMonth);
    return idx >= 0 ? idx : monthOptions.length - 1;
  }, [monthOptions, metricMonth]);

  // Playback loop
  useEffect(() => {
    if (!isPlaying) return;
    if (!enableChoropleth || monthOptions.length < 2) {
      setIsPlaying(false);
      return;
    }
    const id = window.setInterval(() => {
      setMetricMonth((prev) => {
        const cur = monthOptions.indexOf(prev);
        let next = (cur >= 0 ? cur : 0) + 1;
        if (next >= monthOptions.length) {
          if (!loopPlay) {
            window.clearInterval(id);
            setIsPlaying(false);
            return monthOptions[monthOptions.length - 1]!;
          }
          next = 0;
        }
        return monthOptions[next]!;
      });
    }, playStepMs);
    return () => window.clearInterval(id);
  }, [isPlaying, enableChoropleth, monthOptions, loopPlay, playStepMs]);

  // ---------------------------------------------------------------------------
  // Map init
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!containerRef.current) return;
    if (!token) {
      console.error("Missing NEXT_PUBLIC_MAPBOX_TOKEN in .env.local");
      return;
    }
    if (mapRef.current) return;

    mapboxgl.accessToken = token;
    const init = latest.current;
    const cam = initialCamRef.current;

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/standard",
      center: cam ? [cam.lng, cam.lat] : DEFAULT_CENTER,
      zoom: cam ? cam.zoom : DEFAULT_ZOOM,
      pitch: cam?.pitch !== undefined ? cam.pitch : init.enable3D ? DEFAULT_PITCH_3D : 0,
      bearing: cam?.bearing !== undefined ? cam.bearing : init.enable3D ? DEFAULT_BEARING_3D : 0,
      antialias: false, // MSAA is costly on high-DPI screens and the data layers do not need it
      preserveDrawingBuffer: false, // PNG export reads the canvas inside a render callback instead
      fadeDuration: 150,
      maxPitch: 65,
      refreshExpiredTiles: false,
      config: {
        basemap: {
          lightPreset: init.lightPreset,
          theme: "default",
          show3dObjects: init.enable3D,
          showPlaceLabels: true,
          showRoadLabels: false,
          showPointOfInterestLabels: false,
          showTransitLabels: false,
        },
      },
    });

    try {
      map.boxZoom.disable(); // Shift+drag is reserved for pin-B selection
    } catch {
      // ignore
    }

    mapRef.current = map;
    // Expose for debugging / automated checks (e.g. window.__gmMap.getZoom()).
    (window as unknown as { __gmMap?: MapboxMap }).__gmMap = map;
    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "top-right");
    map.addControl(new mapboxgl.FullscreenControl(), "top-right");
    map.addControl(new mapboxgl.ScaleControl({ unit: "metric", maxWidth: 120 }), "bottom-left");

    const popup = new mapboxgl.Popup({ closeButton: false, closeOnClick: false, offset: 12, maxWidth: "280px", className: "gm-popup" });
    popupRef.current = popup;

    map.on("load", () => {
      addDataSources(map);
      addDataLayers(map, latest.current.lightPreset);
      applyPresetColors(map, latest.current.lightPreset);
      engineRef.current = new ChoroplethEngine(map);
      setMapReady(true);

      // ---- camera-driven state ----
      let lastBand: ZoomBand = zoomBand(map.getZoom());
      setBand(lastBand);
      setZoomDisplay(Math.round(map.getZoom() * 10) / 10);
      const onZoom = () => {
        const z = map.getZoom();
        const b = zoomBand(z);
        if (b !== lastBand) {
          lastBand = b;
          setBand(b);
        }
        setZoomDisplay(Math.round(z * 10) / 10);
      };
      map.on("zoom", onZoom);

      const updateFocus = () => {
        // Mid-flight the zoom is meaningless (and tile loads trigger refreshes during
        // it); moveend re-runs this once the camera has arrived.
        if (map.isMoving()) return;
        const z = map.getZoom();
        // A focus set by a click sticks through the camera flight and the refreshes
        // after it, until the user moves the map themselves or leaves its zoom band.
        let hint = focusHintRef.current;
        if (hint && z < (hint.locId !== null ? Z_PROJ - Z_FADE : Z_LOC - Z_FADE)) {
          focusHintRef.current = null;
          hint = null;
        }
        // Probe where the user is looking: the cursor when it is over the map (wheel
        // zoom anchors there), otherwise the screen centre.
        const probePt = hoverPointRef.current;
        const probe: mapboxgl.PointLike = probePt ? [probePt.x, probePt.y] : map.project(map.getCenter());
        setFocus((prev) => {
          if (hint) {
            const same = prev.mmId === hint.mmId && prev.locId === hint.locId && prev.mmName === hint.mmName && prev.locName === hint.locName;
            return same ? prev : hint;
          }
          let mmId = prev.mmId;
          let mmName = prev.mmName;
          let locId = prev.locId;
          let locName = prev.locName;

          if (z >= Z_LOC - Z_FADE) {
            const f = map.queryRenderedFeatures(probe, { layers: [LYR.hitMm] })[0] as RenderedFeature | undefined;
            const id = toNumericId(f?.id);
            if (f && id !== null) {
              mmId = id;
              mmName = getStrProp(f.properties, "MicroMarketName") || `Micromarket ${id}`;
            }
          } else {
            mmId = null;
            mmName = "";
          }

          if (z >= Z_PROJ - Z_FADE) {
            const f = map.queryRenderedFeatures(probe, { layers: [LYR.hitLoc] })[0] as RenderedFeature | undefined;
            const id = toNumericId(f?.id);
            if (f && id !== null) {
              locId = id;
              locName = getStrProp(f.properties, "LocalityName") || `Locality ${id}`;
            }
          } else {
            locId = null;
            locName = "";
          }

          if (mmId === prev.mmId && locId === prev.locId && mmName === prev.mmName && locName === prev.locName) return prev;
          return { mmId, mmName, locId, locName };
        });
      };
      map.on("moveend", updateFocus);

      // Camera -> URL (shareable view)
      const writeCam = () => {
        const c = map.getCenter();
        const sp = new URLSearchParams(window.location.search);
        sp.set(
          "cam",
          [c.lng.toFixed(5), c.lat.toFixed(5), map.getZoom().toFixed(2), map.getPitch().toFixed(0), map.getBearing().toFixed(0)].join(",")
        );
        window.history.replaceState({}, "", `${window.location.pathname}?${sp.toString()}`);
      };
      map.on("moveend", writeCam);

      // ---- idle: index polygons for labels/search + feature-state for new tiles ----
      let lastScanKey = "";
      let scanRetries = 0;
      const dbg = { refreshes: 0, lastError: "" as string, index: indexRef.current };
      (window as unknown as { __gmDebug?: typeof dbg }).__gmDebug = dbg;
      const refresh = () => {
        dbg.refreshes++;
        try {
          refreshInner();
        } catch (e) {
          dbg.lastError = String(e);
          console.error("map refresh failed:", e);
        }
      };
      const refreshInner = () => {
        const idx = indexRef.current;
        const { locById } = latest.current;
        // Re-index only when the camera (or the dims) changed; idle also fires after every cross-fade.
        const c = map.getCenter();
        // Key the scan on the camera, the dims and how many polygon features the loaded
        // tiles currently hold: more tiles landing changes the key and triggers a rescan,
        // and an early refresh that sees no tiles yet keeps retrying (bounded).
        const countFeats = (src: string, sourceLayer: string) => {
          try {
            return map.querySourceFeatures(src, { sourceLayer }).length;
          } catch {
            return 0;
          }
        };
        const mmFeats = countFeats(SRC.micromarkets, TILESETS.micromarkets.sourceLayer);
        const locFeats = countFeats(SRC.localities, TILESETS.localities.sourceLayer);
        const scanKey = `${c.lng.toFixed(4)},${c.lat.toFixed(4)},${map.getZoom().toFixed(2)},${locById.size},${mmFeats},${locFeats}`;
        const tilesReady = mmFeats > 0 && locFeats > 0;
        if (!tilesReady && scanKey !== lastScanKey && scanRetries < 60) {
          // Tiles for this camera are still loading: try again shortly (bounded).
          scanRetries++;
          window.setTimeout(scheduleRefresh, 750);
        }
        if (tilesReady && scanKey !== lastScanKey) {
          lastScanKey = scanKey;
          scanRetries = 0;
          const c1 = idx.scan(map, "micromarkets", SRC.micromarkets, TILESETS.micromarkets.sourceLayer, "MicroMarketName");
          const c2 = idx.scan(map, "localities", SRC.localities, TILESETS.localities.sourceLayer, "LocalityName", (id) => {
            const d = locById.get(id);
            return d?.micromarketId ?? null;
          });
          // Spatial membership (centroid inside the micromarket polygon) beats the dimension table.
          const c3 = idx.assignMicromarkets((id) => locById.get(id)?.micromarketId ?? null);
          if (c1 || c2 || c3) {
            const src = map.getSource(SRC.labels) as mapboxgl.GeoJSONSource | undefined;
            src?.setData(idx.toLabelGeoJSON());
            rebuildCounts();
            setIndexVersion(idx.getVersion());
          }
        }
        const eng = engineRef.current;
        const { activeDoc, metricMonth, effectiveLevel, enableChoropleth } = latest.current;
        if (eng && enableChoropleth && activeDoc && metricMonth) eng.syncNewIds(effectiveLevel, activeDoc, metricMonth);
        updateFocus();

        let n = 0;
        if (map.getZoom() >= Z_PROJ - Z_FADE && map.getLayer(LYR.projectsCircle)) {
          try {
            n = map.queryRenderedFeatures({ layers: [LYR.projectsCircle] }).length;
          } catch {
            n = 0;
          }
        }
        setProjectsInView(n);
      };

      // Standard-style reloads (e.g. a theme change) can drop or reset our layers.
      // Re-add what is missing and bump the epoch so React effects re-apply state.
      const ensureLayers = () => {
        if (!map.isStyleLoaded()) return;
        if (map.getLayer(LYR.mmFillA)) return;
        try {
          addDataSources(map);
          addDataLayers(map, latest.current.lightPreset);
          applyPresetColors(map, latest.current.lightPreset);
          engineRef.current = new ChoroplethEngine(map);
          lastScanKey = "";
          setStyleEpoch((v) => v + 1);
        } catch (e) {
          console.warn("Re-adding data layers failed:", e);
        }
      };
      const onStyleLoad = () => {
        ensureLayers();
        engineRef.current?.reset();
        lastScanKey = "";
        setStyleEpoch((v) => v + 1);
        scheduleRefresh();
      };
      map.on("style.load", onStyleLoad);
      map.on("styledata", ensureLayers);
      // `idle` can be withheld for a long time by the Standard basemap (3D models,
      // transitions), so also refresh after camera moves and when our tiles land.
      let refreshTimer: number | null = null;
      const scheduleRefresh = () => {
        if (refreshTimer !== null) window.clearTimeout(refreshTimer);
        refreshTimer = window.setTimeout(() => {
          refreshTimer = null;
          refresh();
        }, 250);
      };
      // Any tile activity on our polygon/point sources schedules a (debounced) refresh;
      // refresh itself checks whether the sources are fully loaded before indexing.
      const onSourceData = (e: { sourceId?: string }) => {
        if (e.sourceId === SRC.localities || e.sourceId === SRC.micromarkets || e.sourceId === SRC.projects) scheduleRefresh();
      };
      map.on("idle", refresh);
      map.on("moveend", scheduleRefresh);
      map.on("sourcedata", onSourceData);
      // Startup safety net in case neither idle nor a source event arrives promptly.
      const startupTimers = [800, 2500, 6000].map((ms) => window.setTimeout(scheduleRefresh, ms));

      // Playback keeps running through pans and zooms; the level follows the zoom.
      const onMouseDown = (e: MapMouseEvent) => {
        shiftDownRef.current = isShiftPressed(e.originalEvent) || isShiftPressed(e);
      };
      map.on("mousedown", onMouseDown);

      // ---- hover ----
      const setHover = (level: Level | null, id: number | null) => {
        const prev = hoverStateRef.current;
        if (prev && (prev.level !== level || prev.id !== id)) {
          const s = prev.level === "micromarkets" ? SRC.micromarkets : SRC.localities;
          const sl = prev.level === "micromarkets" ? TILESETS.micromarkets.sourceLayer : TILESETS.localities.sourceLayer;
          map.setFeatureState({ source: s, sourceLayer: sl, id: prev.id }, { hover: false });
          hoverStateRef.current = null;
        }
        if (level && id !== null && (!prev || prev.level !== level || prev.id !== id)) {
          const s = level === "micromarkets" ? SRC.micromarkets : SRC.localities;
          const sl = level === "micromarkets" ? TILESETS.micromarkets.sourceLayer : TILESETS.localities.sourceLayer;
          map.setFeatureState({ source: s, sourceLayer: sl, id }, { hover: true });
          hoverStateRef.current = { level, id };
        }
      };

      const passesRestriction = (kind: InspectKind, props: Record<string, unknown>, id: number | null): boolean => {
        const { focus, restrictLoc, restrictProj, locMmById } = latest.current;
        if (kind === "localities" && restrictLoc && focus.mmId !== null && id !== null) {
          const mm = locMmById.get(id) ?? null;
          if (mm !== null && mm !== focus.mmId) return false;
        }
        if (kind === "projects" && restrictProj && focus.locId !== null) {
          const lid = toNumericId(props.LocalityID);
          if (lid !== null && lid !== focus.locId) return false;
        }
        return true;
      };

      const describe = (kind: InspectKind, props: Record<string, unknown>, id: number | null): { name: string; html: string } => {
        const { activeDoc, metricMonth, def, locById, mmById } = latest.current;
        if (kind === "projects") {
          const name = getStrProp(props, "ProjectName") || "Project";
          const status = getStrProp(props, "Status");
          const loc = locById.get(toNumericId(props.LocalityID) ?? -1)?.name ?? "";
          const mm = mmById.get(toNumericId(props.MicroMarketID) ?? -1)?.name ?? "";
          const g = STATUS_GROUPS.find((s) => s.match.includes(status));
          const dot = `<span style="display:inline-block;width:8px;height:8px;border-radius:99px;background:${g?.color ?? "#9ca3af"};margin-right:6px"></span>`;
          return {
            name,
            html: `<div class="gm-pop-title">${escapeHtml(name)}</div><div>${dot}${escapeHtml(status || "-")}</div><div class="gm-pop-muted">${escapeHtml(
              [loc, mm].filter(Boolean).join(" · ")
            )}</div>`,
          };
        }
        if (kind === "micromarkets" || kind === "localities") {
          const name = kind === "micromarkets" ? getStrProp(props, "MicroMarketName") || `Micromarket ${id}` : getStrProp(props, "LocalityName") || `Locality ${id}`;
          const canonical = kind === "localities" && id !== null ? (locById.get(id)?.name ?? name) : name;
          const joinKey = kind === "micromarkets" ? String(id) : canonical;
          const docs = latest.current.carryFwd ? filledRef.current : docsRef.current;
          const doc = docs[latest.current.metricKey]?.[kind] ?? (activeDoc && latest.current.effectiveLevel === kind ? activeDoc : null);
          const rows = doc?.byMonth?.[metricMonth] as Record<string, { v?: number | null; n?: number | null; asOf?: string }> | undefined;
          const row = rows ? (rows[joinKey] ?? findNormalized(rows, joinKey)) : undefined;
          const v = typeof row?.v === "number" ? fmtMoney(row.v) : "no data";
          const n = typeof row?.n === "number" ? ` · n=${row.n}` : "";
          const asOf = row?.asOf ? `<div class="gm-pop-muted">last available value, from ${escapeHtml(parseMonthLabel(row.asOf))}</div>` : "";
          return {
            name,
            html: `<div class="gm-pop-title">${escapeHtml(name)}</div><div>${escapeHtml(def.label)}: <b>${escapeHtml(v)}</b><span class="gm-pop-muted">${escapeHtml(
              n
            )}</span></div><div class="gm-pop-muted">${escapeHtml(metricMonth ? parseMonthLabel(metricMonth) : "")}</div>${asOf}`,
          };
        }
        if (kind === "roads") {
          const name = getStrProp(props, "RoadName") || "Road";
          return { name, html: `<div class="gm-pop-title">${escapeHtml(name)}</div>` };
        }
        const name = getStrProp(props, "CityName") || "City";
        return { name, html: `<div class="gm-pop-title">${escapeHtml(name)}</div>` };
      };

      // Pick the topmost feature for the active inspect target; in auto mode at
      // project zoom, fall back to the locality under the cursor.
      const pickAt = (point: mapboxgl.PointLike): { kind: InspectKind; f: RenderedFeature } | null => {
        const primary = latest.current.effectiveInspect;
        const kinds: InspectKind[] = primary === "projects" && latest.current.inspectAuto ? ["projects", "localities"] : [primary];
        for (const kind of kinds) {
          let feats: RenderedFeature[] = [];
          try {
            feats = map.queryRenderedFeatures(point, { layers: [hitLayerFor[kind]] }) as unknown as RenderedFeature[];
          } catch {
            feats = [];
          }
          const f = feats.find((x) => passesRestriction(kind, (x.properties ?? {}) as Record<string, unknown>, toNumericId(x.id)));
          if (f) return { kind, f };
        }
        return null;
      };

      // ---- project count bubbles (GeoJSON at polygon centroids) ----
      const rebuildCounts = () => {
        const counts = countsRef.current;
        const src = map.getSource(SRC.counts) as mapboxgl.GeoJSONSource | undefined;
        if (!counts || !src) return;
        // Localities with a single project get no bubble (the dot itself shows at project zoom).
        src.setData(
          indexRef.current.toCountGeoJSON((level, id) => {
            if (level === "micromarkets") return counts.byMicromarket[String(id)] ?? 0;
            const n = counts.byLocality[String(id)] ?? 0;
            return n >= 2 ? n : 0;
          })
        );
      };
      rebuildCountsRef.current = rebuildCounts;
      const pickBubble = (point: mapboxgl.PointLike): { level: Level; id: number; name: string; count: number } | null => {
        if (!map.getLayer(LYR.countMm)) return null;
        let feats: RenderedFeature[] = [];
        try {
          feats = map.queryRenderedFeatures(point, { layers: [LYR.countMm, LYR.countLoc] }) as unknown as RenderedFeature[];
        } catch {
          return null;
        }
        const f = feats[0];
        if (!f) return null;
        const p = (f.properties ?? {}) as Record<string, unknown>;
        const id = toNumericId(p.id);
        if (id === null) return null;
        return {
          level: p.level === "micromarkets" ? "micromarkets" : "localities",
          id,
          name: typeof p.name === "string" ? p.name : "",
          count: typeof p.count === "number" ? p.count : Number(p.count) || 0,
        };
      };

      // ---- orbit: one revolution per minute around a project, until the user moves the map ----
      const orbit = { active: false };
      const orbitStep = () => {
        if (!orbit.active) return;
        // 120° per 20 s, linear; chained from moveend so a full turn is three steps.
        map.rotateTo(map.getBearing() + 120, { duration: 20000, easing: (t: number) => t, essential: true });
      };
      const onOrbitMoveEnd = () => {
        if (orbit.active) orbitStep();
      };
      const startOrbit = (center: [number, number]) => {
        orbit.active = true;
        setOrbiting(true);
        map.easeTo({ center, duration: 700, essential: true }); // its moveend starts the first step
      };
      const stopOrbit = () => {
        if (!orbit.active) return;
        orbit.active = false;
        setOrbiting(false);
        map.stop();
      };
      stopOrbitRef.current = stopOrbit;
      map.on("moveend", onOrbitMoveEnd);
      // Scroll-zoom's movestart carries no originalEvent, so listen to the raw
      // interaction events: any of them ends the orbit and releases a click-set focus.
      const onUserInteract = () => {
        focusHintRef.current = null;
        stopOrbit();
      };
      map.on("wheel", onUserInteract);
      map.on("mousedown", onUserInteract);
      map.on("touchstart", onUserInteract);
      map.on("dragstart", onUserInteract);

      let rafId: number | null = null;
      const clearHover = () => {
        map.getCanvas().style.cursor = "";
        setHover(null, null);
        popup.remove();
        setHoverInfo(null);
      };
      // Re-evaluates what is under the last known cursor position. Also used after
      // camera moves, since the map slides under a stationary cursor during wheel zoom.
      const handleMove = () => {
        rafId = null;
        const pt = hoverPointRef.current;
        if (!pt) return;
        const bubble = pickBubble([pt.x, pt.y]);
        if (bubble) {
          map.getCanvas().style.cursor = "pointer";
          setHover(null, null);
          setHoverInfo(null);
          popup
            .setLngLat(map.unproject([pt.x, pt.y]))
            .setHTML(
              `<div class="gm-pop-title">${escapeHtml(bubble.name)}</div><div>${bubble.count.toLocaleString("en-IN")} projects</div><div class="gm-pop-muted">click to zoom in</div>`
            )
            .addTo(map);
          return;
        }
        const picked = pickAt([pt.x, pt.y]);
        if (!picked) {
          clearHover();
          return;
        }
        const { kind, f } = picked;
        const props = (f.properties ?? {}) as Record<string, unknown>;
        const id = toNumericId(f.id);
        map.getCanvas().style.cursor = "pointer";
        setHover(kind === "micromarkets" || kind === "localities" ? kind : null, id);
        const d = describe(kind, props, id);
        const lngLat = map.unproject([pt.x, pt.y]);
        popup.setLngLat(lngLat).setHTML(d.html).addTo(map);
        setHoverInfo({ kind, name: d.name, featureId: id, properties: props, lngLat: { lng: lngLat.lng, lat: lngLat.lat } });
      };
      const scheduleHover = () => {
        if (rafId === null) rafId = window.requestAnimationFrame(handleMove);
      };
      rehoverRef.current = scheduleHover;
      const onMove = (e: MapMouseEvent) => {
        hoverPointRef.current = { x: e.point.x, y: e.point.y };
        scheduleHover();
      };
      const onLeave = () => {
        hoverPointRef.current = null;
        clearHover();
      };
      // Hover must not survive a camera move on a feature that is no longer under the cursor.
      const onMoveStartHover = (e: { originalEvent?: unknown }) => {
        setHover(null, null);
        popup.remove();
        // A user-driven move (wheel, drag, control button) releases a click-set focus
        // and stops the orbit.
        if (e.originalEvent) {
          focusHintRef.current = null;
          stopOrbit();
        }
      };
      const onMoveEndHover = () => {
        if (hoverPointRef.current) scheduleHover();
      };
      map.on("mousemove", onMove);
      map.on("mouseout", onLeave);
      map.on("movestart", onMoveStartHover);
      map.on("moveend", onMoveEndHover);

      // Zoom into a polygon so the next drill-down level is actually reached: a
      // micromarket lands in the localities band, a locality in the projects band.
      // Centre on the polygon's centroid (inside the shape, unlike a bbox centre) and
      // set the focus from the click itself rather than from whatever ends up under
      // the screen centre.
      const zoomToArea = (level: Level, id: number, name: string, fallbackBounds: [[number, number], [number, number]] | null): boolean => {
        const entry = indexRef.current.get(level, id);
        const bounds = entry ? bboxToBounds(entry.bbox) : fallbackBounds;
        if (!bounds) return false;
        const minZoom = level === "micromarkets" ? Z_LOC + 0.3 : Z_PROJ + 0.2;
        const maxZoom = level === "micromarkets" ? Z_LOC + 0.9 : Z_PROJ + 1.3;
        const cam = map.cameraForBounds(bounds, { padding: 70, maxZoom, bearing: map.getBearing(), pitch: map.getPitch() }) as
          | { zoom?: number; center?: LngLatLike }
          | undefined;
        const zoom = Math.max(cam?.zoom ?? minZoom, minZoom);
        const center: LngLatLike = entry ? [entry.cx, entry.cy] : (cam?.center ?? map.getCenter());
        const { focus, locMmById, mmById } = latest.current;
        if (level === "micromarkets") {
          focusHintRef.current = { mmId: id, mmName: name, locId: null, locName: "" };
        } else {
          const mmId = locMmById.get(id) ?? focus.mmId;
          const mmName = mmId !== null ? (mmById.get(mmId)?.name ?? focus.mmName) : focus.mmName;
          focusHintRef.current = { mmId, mmName, locId: id, locName: name };
        }
        hoverPointRef.current = null;
        setHover(null, null);
        popup.remove();
        map.flyTo({ center, zoom, pitch: map.getPitch(), bearing: map.getBearing(), duration: 1100, essential: true });
        return true;
      };
      zoomToAreaRef.current = (level, id, name) => zoomToArea(level, id, name, null);

      // ---- click: pin + drill ----
      const onClick = (e: MapMouseEvent) => {
        const bubble = pickBubble(e.point);
        if (bubble) {
          zoomToArea(bubble.level, bubble.id, bubble.name, null);
          return;
        }
        const picked = pickAt(e.point);
        if (!picked) {
          setClickInfo(null);
          return;
        }
        const { kind, f } = picked;
        const props = (f.properties ?? {}) as Record<string, unknown>;
        const id = toNumericId(f.id);
        const d = describe(kind, props, id);
        setClickInfo({ kind, name: d.name, featureId: id, properties: props, lngLat: { lng: e.lngLat.lng, lat: e.lngLat.lat } });

        // Clicking a project starts the slow orbit around it (the 3D rendering will
        // use the same entry point).
        if (kind === "projects") {
          const g = f.geometry as { type?: string; coordinates?: unknown } | undefined;
          const c = g?.type === "Point" && Array.isArray(g.coordinates) ? (g.coordinates as [number, number]) : [e.lngLat.lng, e.lngLat.lat];
          startOrbit([c[0], c[1]]);
          return;
        }

        const assignToB = isShiftPressed(e.originalEvent) || shiftDownRef.current === true;
        shiftDownRef.current = false;

        if ((kind === "micromarkets" || kind === "localities") && id !== null) {
          const next: PinnedSelection = {
            level: kind,
            joinKey: kind === "micromarkets" ? String(id) : d.name,
            displayName: d.name,
            featureId: id,
          };
          if (assignToB) setPinB(next);
          else setPinA(next);

          zoomToArea(kind, id, d.name, boundsFromGeometry(f.geometry));
        }
      };
      map.on("click", onClick);

      map.once("remove", () => {
        map.off("zoom", onZoom);
        map.off("moveend", updateFocus);
        map.off("moveend", writeCam);
        map.off("style.load", onStyleLoad);
        map.off("styledata", ensureLayers);
        map.off("idle", refresh);
        map.off("moveend", scheduleRefresh);
        map.off("sourcedata", onSourceData);
        if (refreshTimer !== null) window.clearTimeout(refreshTimer);
        for (const t of startupTimers) window.clearTimeout(t);
        map.off("mousedown", onMouseDown);
        map.off("mousemove", onMove);
        map.off("mouseout", onLeave);
        map.off("movestart", onMoveStartHover);
        map.off("moveend", onMoveEndHover);
        map.off("moveend", onOrbitMoveEnd);
        map.off("wheel", onUserInteract);
        map.off("mousedown", onUserInteract);
        map.off("touchstart", onUserInteract);
        map.off("dragstart", onUserInteract);
        map.off("click", onClick);
        if (rafId !== null) window.cancelAnimationFrame(rafId);
      });
    });

    return () => {
      popupRef.current?.remove();
      map.remove();
      mapRef.current = null;
      engineRef.current = null;
      setMapReady(false);
    };
  }, [token]);

  // ---------------------------------------------------------------------------
  // Keyboard shortcuts (never while typing in a field)
  // ---------------------------------------------------------------------------
  const handlersRef = useRef<{ reset: () => void; png: () => void; json: () => void; csv: () => void; play: () => void }>({
    reset: () => {},
    png: () => {},
    json: () => {},
    csv: () => {},
    play: () => {},
  });
  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (isEditableTarget(ev.target) || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const k = ev.key.toLowerCase();
      if (ev.key === "Escape") {
        stopPlayback();
        stopOrbitRef.current?.();
        setPinA(null);
        setPinB(null);
        setClickInfo(null);
      } else if (k === "r") handlersRef.current.reset();
      else if (k === "p") handlersRef.current.png();
      else if (k === "j") handlersRef.current.json();
      else if (k === "c") handlersRef.current.csv();
      else if (k === " ") {
        ev.preventDefault();
        handlersRef.current.play();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // ---------------------------------------------------------------------------
  // Basemap config effects
  // ---------------------------------------------------------------------------
  const setConfig = (name: string, value: unknown) => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    try {
      map.setConfigProperty("basemap", name, value);
    } catch (e) {
      console.warn(`setConfigProperty(${name}) failed:`, e);
    }
  };

  useEffect(() => {
    setConfig("lightPreset", lightPreset);
    const map = mapRef.current;
    if (map && mapReady) applyPresetColors(map, lightPreset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lightPreset, mapReady, styleEpoch]);

  useEffect(() => {
    setConfig("theme", theme);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, mapReady, styleEpoch]);

  useEffect(() => {
    setConfig("showPlaceLabels", showPlaceLabels);
    setConfig("showRoadLabels", showRoadLabels);
    setConfig("showPointOfInterestLabels", showPoiLabels);
    setConfig("showTransitLabels", false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPlaceLabels, showRoadLabels, showPoiLabels, mapReady, styleEpoch]);

  // 3D: pitch/bearing + Standard 3D buildings
  const applied3DRef = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    setConfig("show3dObjects", enable3D && !perfMode);
    // First run: keep a camera that came from the URL; otherwise snap to the 2D/3D default.
    if (!applied3DRef.current) {
      applied3DRef.current = true;
      if (initialCamRef.current) return;
      map.jumpTo({ pitch: enable3D ? DEFAULT_PITCH_3D : 0, bearing: enable3D ? DEFAULT_BEARING_3D : 0 });
      return;
    }
    map.easeTo({ pitch: enable3D ? DEFAULT_PITCH_3D : 0, bearing: enable3D ? DEFAULT_BEARING_3D : 0, duration: 700 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enable3D, perfMode, mapReady, styleEpoch]);

  // Terrain (optional)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    let cancelled = false;
    const apply = () => {
      if (cancelled) return;
      if (!map.isStyleLoaded()) {
        map.once("idle", apply);
        return;
      }
      if (terrain && !perfMode) {
        if (!map.getSource(SRC.dem)) {
          try {
            map.addSource(SRC.dem, { type: "raster-dem", url: "mapbox://mapbox.mapbox-terrain-dem-v1", tileSize: 512, maxzoom: 14 });
          } catch (e) {
            console.warn("DEM addSource failed:", e);
            return;
          }
        }
        try {
          map.setTerrain({ source: SRC.dem, exaggeration: 1.2 });
        } catch (e) {
          console.warn("setTerrain failed:", e);
        }
      } else {
        try {
          map.setTerrain(null);
        } catch {
          // ignore
        }
      }
    };
    apply();
    return () => {
      cancelled = true;
    };
  }, [terrain, perfMode, mapReady, styleEpoch]);

  // ---------------------------------------------------------------------------
  // Layer toggles
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    setVisibility(map, LYR.projectsHeat, showHeat);
    setVisibility(map, LYR.projectsCircle, showProjects);
    setVisibility(map, LYR.hitProjects, showProjects);
    setVisibility(map, LYR.roads, showRoads);
    setVisibility(map, LYR.hitRoads, showRoads);
    setVisibility(map, LYR.mmLabels, showLabels);
    setVisibility(map, LYR.locLabels, showLabels);
    setVisibility(map, LYR.countMm, showCounts);
    setVisibility(map, LYR.countMmText, showCounts);
    setVisibility(map, LYR.countLoc, showCounts);
    setVisibility(map, LYR.countLocText, showCounts);
    // Layers that were hidden skipped preset recolouring; apply it now that they are visible.
    applyPresetColors(map, lightPreset);
    engineRef.current?.setOpacityLevel(showHeat ? 0.45 : CHOROPLETH_OPACITY);
  }, [showHeat, showProjects, showRoads, showLabels, showCounts, lightPreset, mapReady, styleEpoch]);

  // ---------------------------------------------------------------------------
  // Drill-down filters (focused micromarket -> its localities; focused locality -> its projects)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const locLayers = [LYR.locFillA, LYR.locFillB, LYR.locOutline, LYR.locHover, LYR.locExtrude];
    const mmFocused = restrictLoc && focus.mmId !== null && locIdsByMm.size > 0;

    if (mmFocused) {
      const ids = locIdsByMm.get(focus.mmId!) ?? [];
      const filter = FILTERS.idIn(ids);
      for (const id of locLayers) setFilterSafe(map, id, filter);
      setFilterSafe(map, LYR.locLabels, FILTERS.labelsLevelInMm("localities", focus.mmId!));
      setFilterSafe(map, LYR.countLoc, FILTERS.labelsLevelInMm("localities", focus.mmId!));
      setFilterSafe(map, LYR.countLocText, FILTERS.labelsLevelInMm("localities", focus.mmId!));
      setFilterSafe(map, LYR.mmMask, FILTERS.notId(focus.mmId!));
    } else {
      for (const id of locLayers) setFilterSafe(map, id, null);
      setFilterSafe(map, LYR.locLabels, FILTERS.labelsLevel("localities"));
      setFilterSafe(map, LYR.countLoc, FILTERS.labelsLevel("localities"));
      setFilterSafe(map, LYR.countLocText, FILTERS.labelsLevel("localities"));
      setFilterSafe(map, LYR.mmMask, FILTERS.noFeature);
    }

    const projFocused = restrictProj && focus.locId !== null;
    setFilterSafe(map, LYR.projectsCircle, projFocused ? FILTERS.projectsInLocality(focus.locId!) : null);
  }, [focus, restrictLoc, restrictProj, locIdsByMm, mapReady, styleEpoch]);

  // ---------------------------------------------------------------------------
  // Pins
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    setFilterSafe(map, LYR.pinMmA, FILTERS.noFeature);
    setFilterSafe(map, LYR.pinMmB, FILTERS.noFeature);
    setFilterSafe(map, LYR.pinLocA, FILTERS.noName);
    setFilterSafe(map, LYR.pinLocB, FILTERS.noName);
    const apply = (p: PinnedSelection | null, which: "A" | "B") => {
      if (!p) return;
      if (p.level === "micromarkets") {
        const id = toNumericId(p.featureId ?? p.joinKey);
        if (id !== null) setFilterSafe(map, which === "A" ? LYR.pinMmA : LYR.pinMmB, FILTERS.byId(id));
      } else {
        setFilterSafe(map, which === "A" ? LYR.pinLocA : LYR.pinLocB, FILTERS.byName(p.joinKey || "__nope__"));
      }
    };
    apply(pinA, "A");
    apply(pinB, "B");
  }, [pinA, pinB, mapReady, styleEpoch]);

  // ---------------------------------------------------------------------------
  // Choropleth: legend/stops
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!enableChoropleth || !activeDoc || !metricMonth) {
      setLegend({ stops: [], count: 0, missing: 0, carried: 0, min: null, max: null });
      return;
    }
    const months = scaleMode === "fixed" ? activeDoc.months ?? [] : [metricMonth];
    const { values } = collectDocValues(activeDoc.byMonth, months);
    const cur = collectDocValues(activeDoc.byMonth, [metricMonth]);
    values.sort((a, b) => a - b);
    const carried = "carried" in activeDoc ? ((activeDoc as FilledDoc).carried?.[metricMonth] ?? 0) : 0;
    setLegend({
      stops: computeQuantileStops(values, def.bucketCount),
      count: cur.values.length,
      missing: cur.missing,
      carried,
      min: values.length ? values[0]! : null,
      max: values.length ? values[values.length - 1]! : null,
    });
  }, [enableChoropleth, activeDoc, metricMonth, def.bucketCount, scaleMode]);

  // Paint (colour scale)
  useEffect(() => {
    const eng = engineRef.current;
    if (!eng || !mapReady) return;
    if (legend.stops.length < 2) return;
    eng.setPaint({ stops: legend.stops, palette, missing: missingColorFor(lightPreset) }, null);
  }, [legend.stops, palette, lightPreset, mapReady, styleEpoch]);

  // Join localities by their canonical dimension name: tile names sometimes differ
  // from the metric keys (extra spaces, punctuation), which left polygons grey.
  useEffect(() => {
    const eng = engineRef.current;
    if (!eng || !mapReady || !locById.size) return;
    eng.setJoinKeyResolver("localities", (id, tileName) => locById.get(id)?.name ?? tileName);
    setRenderNonce((n) => n + 1);
  }, [locById, mapReady, styleEpoch]);

  // Render (values -> feature-state, cross-fade on month change)
  useEffect(() => {
    const eng = engineRef.current;
    if (!eng || !mapReady) return;
    if (!enableChoropleth) {
      eng.hideAll();
      return;
    }
    if (!activeDoc || !metricMonth) return; // keep current fills while this level's data loads
    const durationMs = isPlayingRef.current ? Math.round(playStepMs * 0.8) : 350;
    eng.render({ level: effectiveLevel, doc: activeDoc, month: metricMonth, durationMs });
    rehoverRef.current?.(); // keep an open hover card on the current month
  }, [enableChoropleth, activeDoc, metricMonth, effectiveLevel, mapReady, playStepMs, styleEpoch, renderNonce]);

  // 3D bars
  useEffect(() => {
    const eng = engineRef.current;
    if (!eng || !mapReady) return;
    eng.setExtrusion(extrude && enableChoropleth ? effectiveLevel : null);
  }, [extrude, enableChoropleth, effectiveLevel, mapReady, styleEpoch]);

  // ---------------------------------------------------------------------------
  // Series / compare
  // ---------------------------------------------------------------------------
  const seriesFor = (pin: PinnedSelection | null) => {
    if (!pin || !active) return [];
    const doc = docsRef.current[metricKey]?.[pin.level] ?? (active.level === pin.level ? active.doc : null);
    if (!doc) return [];
    return (doc.months ?? []).map((m) => {
      const b = doc.byMonth?.[m]?.[pin.joinKey];
      return { month: m, v: typeof b?.v === "number" ? b.v : null, n: typeof b?.n === "number" ? b.n : null };
    });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const seriesA = useMemo(() => seriesFor(pinA), [pinA, active, metricKey, docsVersion]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const seriesB = useMemo(() => seriesFor(pinB), [pinB, active, metricKey, docsVersion]);

  const currentOf = (series: ReturnType<typeof seriesFor>) => series.find((r) => r.month === metricMonth) ?? null;
  const currentA = currentOf(seriesA);
  const currentB = currentOf(seriesB);
  const deltaOf = (series: ReturnType<typeof seriesFor>) => {
    const idx = series.findIndex((r) => r.month === metricMonth);
    if (idx <= 0) return { abs: "-", pct: "-" };
    return formatDelta(series[idx]?.v ?? null, series[idx - 1]?.v ?? null);
  };
  const deltaA = deltaOf(seriesA);
  const deltaB = deltaOf(seriesB);
  const sparkOf = (series: ReturnType<typeof seriesFor>) => {
    const values = series.map((r) => r.v).filter((v): v is number => typeof v === "number");
    const d = buildSparklinePath(values, 160, 44);
    return { w: 160, h: 44, d, has: d.length > 0 };
  };
  const sparkA = sparkOf(seriesA);
  const sparkB = sparkOf(seriesB);

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------
  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    const list = searchScope === "localities" ? dimLocalities : dimMicromarkets;
    return list.filter((x) => x.name.toLowerCase().includes(q)).slice(0, 12);
  }, [searchQuery, searchScope, dimLocalities, dimMicromarkets]);

  const jumpTo = (level: Level, item: DimItem) => {
    stopPlayback();
    const map = mapRef.current;
    if (!map) return;

    const pin: PinnedSelection = {
      level,
      joinKey: level === "micromarkets" ? String(item.id) : item.name,
      displayName: item.name,
      featureId: item.id,
    };
    setPinA(pin);

    const tryFit = (): boolean => {
      const entry = indexRef.current.get(level, item.id) ?? indexRef.current.findByName(level, item.name);
      if (!entry) return false;
      return zoomToAreaRef.current?.(level, entry.id, entry.name || item.name) ?? false;
    };
    if (tryFit()) return;

    // Not indexed yet: zoom out to the city so every polygon tile loads, then retry.
    map.fitBounds(CITY_BOUNDS, { padding: 40, duration: 600, maxZoom: 11 });
    map.once("idle", () => {
      indexRef.current.scan(map, "localities", SRC.localities, TILESETS.localities.sourceLayer, "LocalityName", (id) => locById.get(id)?.micromarketId ?? null);
      indexRef.current.scan(map, "micromarkets", SRC.micromarkets, TILESETS.micromarkets.sourceLayer, "MicroMarketName");
      if (!tryFit()) console.warn("Could not locate polygon for", level, item.name);
    });
  };

  // ---------------------------------------------------------------------------
  // Camera / exports
  // ---------------------------------------------------------------------------
  const resetView = () => {
    stopPlayback();
    const map = mapRef.current;
    if (!map) return;
    map.flyTo({
      center: DEFAULT_CENTER as unknown as LngLatLike,
      zoom: DEFAULT_ZOOM,
      pitch: enable3D ? DEFAULT_PITCH_3D : 0,
      bearing: enable3D ? DEFAULT_BEARING_3D : 0,
      duration: 1200,
      essential: true,
    });
  };
  const zoomOutToMicromarket = () => {
    const map = mapRef.current;
    if (!map || focus.mmId === null) return;
    const entry = indexRef.current.get("micromarkets", focus.mmId);
    if (entry) map.fitBounds(bboxToBounds(entry.bbox), FIT_MM);
    else resetView();
  };

  const exportBaseName = () => `map_${metricKey}_${effectiveLevel}_${metricMonth ? metricMonth.replaceAll("-", "") : "nomonth"}_${isoCompactNow()}`;

  const handleExportPng = () => {
    const map = mapRef.current;
    if (!map) return;
    try {
      // Without preserveDrawingBuffer the canvas is only readable inside a render
      // callback, so request a repaint and read it there.
      const name = `${exportBaseName()}.png`;
      map.once("render", () => {
        try {
          const a = document.createElement("a");
          a.href = map.getCanvas().toDataURL("image/png");
          a.download = name;
          document.body.appendChild(a);
          a.click();
          a.remove();
        } catch (err) {
          console.error("PNG export failed:", err);
          alert("PNG export failed. See console.");
        }
      });
      map.triggerRepaint();
    } catch (e) {
      console.error("PNG export failed:", e);
      alert("PNG export failed (tainted canvas?). See console.");
    }
  };
  const handleExportStateJson = () => {
    const map = mapRef.current;
    const state = {
      metricKey,
      levelMode,
      effectiveLevel,
      metricMonth,
      scaleMode,
      lightPreset,
      theme,
      enable3D,
      terrain,
      enableChoropleth,
      showHeat,
      showProjects,
      showRoads,
      showLabels,
      extrude,
      restrictLoc,
      restrictProj,
      focus,
      pinA,
      pinB,
      camera: map ? { center: map.getCenter().toArray(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() } : null,
      exportedAt: new Date().toISOString(),
    };
    downloadText(JSON.stringify(state, null, 2), `${exportBaseName()}_state.json`, "application/json");
  };
  const handleExportCsv = () => {
    if (!pinA && !pinB) return;
    const rows: Array<Record<string, unknown>> = [];
    const push = (label: string, pin: PinnedSelection | null, series: ReturnType<typeof seriesFor>) => {
      if (!pin) return;
      for (const r of series) rows.push({ pin: label, level: pin.level, name: pin.displayName, metric: metricKey, month: r.month, value: r.v, n: r.n });
    };
    push("A", pinA, seriesA);
    push("B", pinB, seriesB);
    downloadText(toCsv(rows, ["pin", "level", "name", "metric", "month", "value", "n"]), `${exportBaseName()}_pinned.csv`, "text/csv;charset=utf-8");
  };
  const togglePlay = () => {
    if (!enableChoropleth || monthOptions.length < 2) return;
    setIsPlaying((p) => !p);
  };
  useEffect(() => {
    handlersRef.current = { reset: resetView, png: handleExportPng, json: handleExportStateJson, csv: handleExportCsv, play: togglePlay };
  });

  const copyShareUrl = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
    } catch {
      // ignore
    }
  };

  // ---------------------------------------------------------------------------
  // UI bits
  // ---------------------------------------------------------------------------
  const selectStyle: React.CSSProperties = {
    width: "100%",
    padding: 8,
    borderRadius: 8,
    border: `1px solid ${UI.controlBorder}`,
    background: UI.controlBg,
    color: UI.controlText,
    fontSize: 12,
  };
  const btnStyle = (primary = false, disabled = false): React.CSSProperties => ({
    fontSize: 12,
    padding: "8px 10px",
    border: primary ? "1px solid transparent" : `1px solid ${UI.controlBorder}`,
    borderRadius: 8,
    background: primary ? UI.primaryBg : UI.controlBg,
    color: primary ? UI.primaryText : UI.controlText,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.55 : 1,
  });
  const bandLabel = band === "micromarkets" ? "Micromarkets" : band === "localities" ? "Localities" : "Projects";
  const playDisabled = !enableChoropleth || monthOptions.length < 2;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 420px", height: "100vh" }}>
      <div style={{ position: "relative" }}>
        <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />

        {/* Breadcrumb overlay */}
        <div
          style={{
            position: "absolute",
            top: 10,
            left: 10,
            display: "flex",
            gap: 6,
            alignItems: "center",
            padding: "6px 10px",
            borderRadius: 8,
            background: "rgba(11,15,25,0.82)",
            color: UI.panelText,
            fontSize: 12,
            border: `1px solid ${UI.panelBorder}`,
            pointerEvents: "auto",
          }}
        >
          <button onClick={resetView} style={{ ...btnStyle(false), padding: "3px 8px" }} title="Back to city (R)">
            Mumbai
          </button>
          {focus.mmId !== null ? (
            <>
              <span style={{ color: UI.mutedText }}>›</span>
              <button onClick={zoomOutToMicromarket} style={{ ...btnStyle(false), padding: "3px 8px" }} title="Fit this micromarket">
                {focus.mmName}
              </button>
            </>
          ) : null}
          {focus.locId !== null ? (
            <>
              <span style={{ color: UI.mutedText }}>›</span>
              <span style={{ fontWeight: 600 }}>{focus.locName}</span>
            </>
          ) : null}
          <span style={{ marginLeft: 8, color: UI.mutedText }}>
            z{zoomDisplay.toFixed(1)} · {bandLabel}
          </span>
        </div>

        {/* Floating legend */}
        {enableChoropleth && bucketRanges.length ? (
          <div
            style={{
              position: "absolute",
              bottom: 28,
              right: 10,
              padding: "8px 10px",
              borderRadius: 8,
              background: "rgba(11,15,25,0.82)",
              color: UI.panelText,
              fontSize: 11,
              border: `1px solid ${UI.panelBorder}`,
              minWidth: 150,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              {def.label} · {effectiveLevel === "micromarkets" ? "Micromarkets" : "Localities"}
            </div>
            <div style={{ color: UI.mutedText, marginBottom: 6 }}>{metricMonth ? parseMonthLabel(metricMonth) : "-"}</div>
            {bucketRanges.map((r, i) => {
              const lo = Math.round(r[0]);
              const hi = Math.round(r[1]);
              const label = i === bucketRanges.length - 1 ? `${fmtMoney(lo)}+` : `${fmtMoney(lo)} – ${fmtMoney(hi)}`;
              return (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                  <div style={{ width: 18, height: 10, background: palette[i] ?? palette[palette.length - 1], borderRadius: 3 }} />
                  <div>{label}</div>
                </div>
              );
            })}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
              <div style={{ width: 18, height: 10, background: missingColorFor(lightPreset), borderRadius: 3, border: `1px solid ${UI.panelBorder}` }} />
              <div style={{ color: UI.mutedText }}>No data</div>
            </div>
            {showProjects && band === "projects" ? (
              <div style={{ marginTop: 8, paddingTop: 6, borderTop: `1px solid ${UI.panelBorder}` }}>
                {STATUS_GROUPS.map((s) => (
                  <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                    <div style={{ width: 9, height: 9, borderRadius: 99, background: s.color }} />
                    <div>{s.label}</div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Right panel                                                          */}
      {/* ------------------------------------------------------------------ */}
      <div style={{ borderLeft: `1px solid ${UI.panelBorder}`, padding: 12, overflow: "auto", background: UI.panelBg, color: UI.panelText }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Mumbai map analytics</h3>
          <span style={{ fontSize: 11, color: UI.mutedText }}>{mapReady ? "map ready" : "loading…"}</span>
        </div>

        {/* Drill-down */}
        <Section title="Drill-down">
          <div style={{ fontSize: 12, color: UI.mutedText, marginBottom: 8, lineHeight: 1.5 }}>
            Zoom drives the level: <b style={{ color: UI.panelText }}>micromarkets</b> below z{Z_LOC}, <b style={{ color: UI.panelText }}>localities</b> from z{Z_LOC}, <b style={{ color: UI.panelText }}>project dots</b> from z{Z_PROJ}. Click a polygon to zoom into it.
          </div>
          <Check label="Only show localities of the focused micromarket" checked={restrictLoc} onChange={setRestrictLoc} />
          <Check label="Only show projects of the focused locality" checked={restrictProj} onChange={setRestrictProj} />
          <div style={{ fontSize: 12, marginTop: 6 }}>
            Focus: <b>{focus.mmName || "—"}</b>
            {focus.locName ? (
              <>
                {" "}
                › <b>{focus.locName}</b>
                <span style={{ color: UI.mutedText }}> · {projectsInView} projects in view</span>
              </>
            ) : null}
          </div>
          {orbiting ? (
            <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
              <span style={{ color: UI.mutedText }}>Orbiting the selected project (one turn per minute)</span>
              <button onClick={() => stopOrbitRef.current?.()} style={{ ...btnStyle(false), padding: "4px 8px" }} title="Esc also stops it">
                Stop orbit
              </button>
            </div>
          ) : null}
        </Section>

        {/* Layers */}
        <Section title="Layers">
          <Check label="Choropleth (metric fills)" checked={enableChoropleth} onChange={(v) => { stopPlayback(); setEnableChoropleth(v); }} />
          <Check label="Heatmap: project concentration" checked={showHeat} onChange={setShowHeat} hint="Kernel-density heat of all project points" />
          <Check label={`Project dots (from z${Z_PROJ})`} checked={showProjects} onChange={setShowProjects} />
          <Check label="3D bars (extrude polygons by value)" checked={extrude} onChange={setExtrude} disabled={!enableChoropleth} />
          <Check label="Area name labels" checked={showLabels} onChange={setShowLabels} />
          <Check label="Project count bubbles (per micromarket, then per locality)" checked={showCounts} onChange={setShowCounts} hint="Click a bubble to zoom into that area" />
          <Check label="Roads tileset" checked={showRoads} onChange={setShowRoads} />
        </Section>

        {/* Metric + timeline */}
        <Section title="Metric & timeline">
          <div style={{ display: "grid", gap: 10 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div>
                <Label>Metric</Label>
                <select value={metricKey} onChange={(e) => { stopPlayback(); setMetricKey(e.target.value); }} style={selectStyle} disabled={!enableChoropleth}>
                  {METRICS.map((m) => (
                    <option key={m.key} value={m.key}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label>Level</Label>
                <select value={levelMode} onChange={(e) => { stopPlayback(); setLevelMode(e.target.value as LevelMode); }} style={selectStyle} disabled={!enableChoropleth}>
                  <option value="auto">Auto (by zoom) · {effectiveLevel}</option>
                  <option value="micromarkets">Micromarkets</option>
                  <option value="localities">Localities</option>
                </select>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div>
                <Label>Month</Label>
                <select value={metricMonth} onChange={(e) => { stopPlayback(); setMetricMonth(e.target.value); }} style={selectStyle} disabled={!enableChoropleth || monthOptions.length === 0}>
                  {monthOptions.length === 0 ? (
                    <option value="">Loading…</option>
                  ) : (
                    monthOptions.map((m) => (
                      <option key={m} value={m}>
                        {parseMonthLabel(m)}
                      </option>
                    ))
                  )}
                </select>
              </div>
              <div>
                <Label>Colour scale</Label>
                <select value={scaleMode} onChange={(e) => setScaleMode(e.target.value as ScaleMode)} style={selectStyle} disabled={!enableChoropleth} title="Fixed keeps the same colour ↔ value mapping across months so playback is comparable">
                  <option value="fixed">Fixed across months</option>
                  <option value="month">Re-bucket each month</option>
                </select>
              </div>
            </div>

            <Check
              label="Carry forward the last available month (locality data is sparse)"
              checked={carryFwd}
              onChange={(v) => {
                stopPlayback();
                setCarryFwd(v);
              }}
              disabled={!enableChoropleth}
              hint="A locality without a value this month is painted with its latest earlier value; the hover card says which month it came from"
            />

            <div style={{ padding: 10, border: `1px solid ${UI.panelBorder}`, borderRadius: 8, background: "rgba(255,255,255,0.03)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ fontSize: 12, opacity: 0.9 }}>Timeline</div>
                <div style={{ fontSize: 12, fontWeight: 600 }}>{metricMonth ? parseMonthLabel(metricMonth) : "-"}</div>
              </div>
              <input
                type="range"
                min={0}
                max={Math.max(0, monthOptions.length - 1)}
                step={1}
                value={metricMonthIndex}
                onChange={(e) => {
                  stopPlayback();
                  const next = monthOptions[Number(e.target.value)];
                  if (next) setMetricMonth(next);
                }}
                disabled={!enableChoropleth || monthOptions.length === 0}
                style={{ width: "100%", marginTop: 8 }}
              />
              <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                <button onClick={togglePlay} disabled={playDisabled} style={btnStyle(true, playDisabled)} title="Space">
                  {isPlaying ? "Pause" : "Play"}
                </button>
                <select value={playSpeed} onChange={(e) => setPlaySpeed(e.target.value as PlaySpeed)} disabled={playDisabled} style={selectStyle}>
                  <option value="slow">Slow</option>
                  <option value="normal">Normal</option>
                  <option value="fast">Fast</option>
                </select>
                <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
                  <input type="checkbox" checked={loopPlay} onChange={(e) => setLoopPlay(e.target.checked)} disabled={playDisabled} />
                  Loop
                </label>
              </div>
              <div style={{ marginTop: 8, fontSize: 11, color: UI.mutedText }}>
                Months cross-fade on the GPU. Playback keeps running while you zoom; the level follows the zoom.
              </div>
            </div>

            <div style={{ fontSize: 12, color: UI.mutedText }}>
              Range {legend.min === null ? "-" : fmtMoney(legend.min)} – {legend.max === null ? "-" : fmtMoney(legend.max)} · {legend.count} areas with data{legend.carried ? ` (${legend.carried} carried forward from earlier months)` : ""}, {legend.missing} without ({scaleMode === "fixed" ? "scale over all months" : "scale for this month"})
            </div>
          </div>
        </Section>

        {/* Search */}
        <Section title="Search & jump">
          <div style={{ display: "grid", gridTemplateColumns: "130px 1fr", gap: 8, marginBottom: 8 }}>
            <select value={searchScope} onChange={(e) => setSearchScope(e.target.value as Level)} style={selectStyle}>
              <option value="localities">Localities</option>
              <option value="micromarkets">Micromarkets</option>
            </select>
            <input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Andheri, Powai, Chembur…" style={selectStyle} />
          </div>
          {searchResults.length ? (
            <div style={{ border: `1px solid ${UI.panelBorder}`, borderRadius: 8, overflow: "hidden" }}>
              {searchResults.map((r) => (
                <button
                  key={`${searchScope}-${r.id}`}
                  onClick={() => jumpTo(searchScope, r)}
                  style={{ width: "100%", textAlign: "left", padding: "8px 10px", border: "none", borderBottom: `1px solid ${UI.panelBorder}`, background: "rgba(255,255,255,0.03)", color: UI.panelText, cursor: "pointer", fontSize: 12 }}
                  title="Zoom to this area and pin it as A"
                >
                  {r.name}
                  {searchScope === "localities" && r.micromarketId ? <span style={{ marginLeft: 8, color: UI.mutedText }}>{mmById.get(r.micromarketId)?.name ?? ""}</span> : null}
                </button>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: UI.mutedText }}>
              {dimLocalities.length ? `${dimLocalities.length} localities · ${dimMicromarkets.length} micromarkets · ${indexVersion ? "polygons indexed" : "indexing polygons…"}` : "Run scripts/build_dims_public.py to enable search."}
            </div>
          )}
          <div style={{ marginTop: 8, fontSize: 12, color: UI.mutedText }}>
            Click pins A. <b style={{ color: UI.panelText }}>Shift+Click</b> pins B. Esc clears.
          </div>
        </Section>

        {/* Compare */}
        <Section
          title="Pinned compare"
          right={
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={handleExportCsv} disabled={!pinA && !pinB} style={{ ...btnStyle(false, !pinA && !pinB), padding: "5px 8px" }} title="Export pinned series as CSV (C)">
                CSV
              </button>
              <button onClick={() => { stopPlayback(); setPinA(null); setPinB(null); }} disabled={!pinA && !pinB} style={{ ...btnStyle(false, !pinA && !pinB), padding: "5px 8px" }}>
                Clear
              </button>
            </div>
          }
        >
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {[
              { label: "A", pin: pinA, cur: currentA, delta: deltaA, spark: sparkA, color: UI.pinA, empty: "Click an area to pin A." },
              { label: "B", pin: pinB, cur: currentB, delta: deltaB, spark: sparkB, color: UI.pinB, empty: "Shift+Click to pin B." },
            ].map((p) => (
              <div key={p.label} style={{ border: `1px solid ${UI.panelBorder}`, borderRadius: 8, padding: 10, background: "rgba(255,255,255,0.03)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 10, height: 10, borderRadius: 999, background: p.color }} />
                  <div style={{ fontWeight: 600, fontSize: 12 }}>{p.label}</div>
                </div>
                {!p.pin ? (
                  <div style={{ marginTop: 8, fontSize: 12, color: UI.mutedText }}>{p.empty}</div>
                ) : (
                  <div style={{ marginTop: 8, fontSize: 12, display: "grid", gap: 6 }}>
                    <div style={{ fontWeight: 600 }}>{p.pin.displayName}</div>
                    <div style={{ color: UI.mutedText }}>{p.pin.level}</div>
                    <div>
                      Value: <b>{typeof p.cur?.v === "number" ? fmtMoney(p.cur.v) : "-"}</b> <span style={{ color: UI.mutedText }}>(n: {typeof p.cur?.n === "number" ? p.cur.n : "-"})</span>
                    </div>
                    <div>
                      Δ vs prev: <b>{p.delta.abs}</b> <span style={{ color: UI.mutedText }}>({p.delta.pct})</span>
                    </div>
                    <div style={{ width: p.spark.w, height: p.spark.h, border: `1px solid ${UI.controlBorder}`, borderRadius: 8, background: UI.controlBg, overflow: "hidden" }}>
                      <svg width={p.spark.w} height={p.spark.h}>
                        <line x1="2" y1={p.spark.h - 6} x2={p.spark.w - 2} y2={p.spark.h - 6} stroke={UI.controlBorder} strokeWidth={1} />
                        {p.spark.has ? (
                          <path d={p.spark.d} fill="none" stroke={p.color} strokeWidth={2} />
                        ) : (
                          <text x="10" y="26" fontSize="12" fill={UI.controlText} opacity={0.6}>
                            Not enough data
                          </text>
                        )}
                      </svg>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div style={{ marginTop: 10, fontSize: 12, color: UI.mutedText }}>
            {pinA && pinB && typeof currentA?.v === "number" && typeof currentB?.v === "number" ? (
              <div>
                A − B ({metricMonth ? parseMonthLabel(metricMonth) : "-"}): <b style={{ color: UI.panelText }}>{fmtMoney(Math.round(currentA.v - currentB.v))}</b>
              </div>
            ) : (
              <div>Pin both A and B to see the A − B delta.</div>
            )}
          </div>
        </Section>

        {/* Basemap */}
        <Section title="Basemap">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
            <div>
              <Label>Light</Label>
              <select value={lightPreset} onChange={(e) => setLightPreset(e.target.value as LightPreset)} style={selectStyle}>
                <option value="dawn">Dawn</option>
                <option value="day">Day</option>
                <option value="dusk">Dusk</option>
                <option value="night">Night</option>
              </select>
            </div>
            <div>
              <Label>Theme</Label>
              <select value={theme} onChange={(e) => setTheme(e.target.value as BasemapTheme)} style={selectStyle} title="Mapbox Standard theme; faded/monochrome make data layers stand out">
                <option value="default">Default</option>
                <option value="faded">Faded</option>
                <option value="monochrome">Monochrome</option>
              </select>
            </div>
          </div>
          <Check label="3D view (pitch + 3D buildings)" checked={enable3D} onChange={setEnable3D} />
          <Check label="Terrain (DEM, mostly flat here)" checked={terrain} onChange={setTerrain} />
          <Check label="Performance mode (no 3D buildings, landmarks or terrain)" checked={perfMode} onChange={setPerfMode} hint="Lighter basemap for slower machines" />
          <Check label="Basemap place labels" checked={showPlaceLabels} onChange={setShowPlaceLabels} />
          <Check label="Basemap road labels" checked={showRoadLabels} onChange={setShowRoadLabels} />
          <Check label="Basemap POI labels" checked={showPoiLabels} onChange={setShowPoiLabels} />
          <button onClick={resetView} style={{ ...btnStyle(false), width: "100%", marginTop: 4 }} title="Reset view (R)">
            Reset view (R)
          </button>
        </Section>

        {/* Inspect */}
        <Section title="Inspect">
          <Label>Hover / click target</Label>
          <select value={inspectTarget} onChange={(e) => { setHoverInfo(null); setClickInfo(null); setInspectTarget(e.target.value as InspectTarget); }} style={{ ...selectStyle, marginBottom: 8 }}>
            <option value="auto">Auto (follows zoom) · {effectiveInspect}</option>
            <option value="micromarkets">Micromarkets</option>
            <option value="localities">Localities</option>
            <option value="projects">Projects</option>
            <option value="roads">Roads</option>
            <option value="city">City outline</option>
          </select>

          {[
            { title: "Hover", info: hoverInfo, empty: "Hover a feature on the map…" },
            { title: "Clicked", info: clickInfo, empty: "Click a feature to pin its details…" },
          ].map((s) => (
            <div key={s.title} style={{ marginBottom: 8 }}>
              <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 4 }}>{s.title}</div>
              {s.info ? (
                <div style={{ fontSize: 12 }}>
                  <div>
                    <b>{s.info.name}</b> <span style={{ color: UI.mutedText }}>({s.info.kind}{s.info.featureId !== null ? ` #${s.info.featureId}` : ""})</span>
                  </div>
                  <details style={{ marginTop: 4 }}>
                    <summary style={{ cursor: "pointer", color: UI.mutedText }}>properties</summary>
                    <pre style={{ fontSize: 11, whiteSpace: "pre-wrap", marginTop: 4 }}>{safeJson(s.info.properties)}</pre>
                  </details>
                </div>
              ) : (
                <div style={{ fontSize: 12, color: UI.mutedText }}>{s.empty}</div>
              )}
            </div>
          ))}
        </Section>

        {/* Exports */}
        <Section title="Exports & share">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            <button onClick={handleExportPng} disabled={!mapReady} style={btnStyle(false, !mapReady)} title="Export map canvas as PNG (P)">
              PNG (P)
            </button>
            <button onClick={handleExportStateJson} style={btnStyle(false)} title="Export inspector state as JSON (J)">
              State (J)
            </button>
            <button onClick={copyShareUrl} style={btnStyle(false)} title="Copy a shareable URL with the current state">
              Copy URL
            </button>
          </div>
          <div style={{ marginTop: 8, fontSize: 11, color: UI.mutedText }}>
            Shortcuts: R reset · Space play/pause · P png · J state · C pinned CSV · Esc clear pins. Shortcuts are ignored while typing.
          </div>
        </Section>
      </div>
    </div>
  );
}
