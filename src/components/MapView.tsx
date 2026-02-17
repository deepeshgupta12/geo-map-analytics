"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import mapboxgl, { AnyLayer, Map, MapMouseEvent, MapboxGeoJSONFeature } from "mapbox-gl";
import type { ExpressionSpecification, FitBoundsOptions, LngLatLike, FilterSpecification } from "mapbox-gl";
import { TILESETS } from "@/config/tilesets";
import { METRICS, getMetricDef, ChoroplethLevel as ChoroplethLevelCfg } from "@/config/metrics";
import { computeQuantileStops, formatBucketRanges } from "@/lib/quantiles";

type PickInfo = {
  layerId: string;
  sourceLayer: string;
  featureId: unknown;
  propertyKeys: string[];
  properties: Record<string, unknown>;
  lngLat: { lng: number; lat: number };
};

type InspectTarget = "localities" | "micromarkets" | "projects" | "roads" | "city";
type LightPreset = "dawn" | "day" | "dusk" | "night";

type MetricBucket = { v: number; n?: number };
type MetricsDoc = {
  cityId: number;
  metric: string;
  level: string;
  months: string[];
  byMonth: Record<string, Record<string, MetricBucket>>;
  notes?: string[];
};

type PinnedSelection = {
  level: ChoroplethLevel;
  joinKey: string; // for micromarkets = featureId string; for localities = LocalityName
  displayName: string;
  featureId: string | number | null;
};

type ChoroplethLevel = "micromarkets" | "localities";

const DEFAULT_CENTER: [number, number] = [72.8777, 19.076]; // Mumbai
const DEFAULT_ZOOM = 10.5;

const FIT_BOUNDS_OPTS: FitBoundsOptions = {
  padding: 48,
  duration: 650,
  maxZoom: 13.75,
};

// UI tokens (exported for reuse/testing)
export const UI = {
  panelBg: "#0B0F19",
  panelText: "#E5E7EB",
  panelBorder: "rgba(255,255,255,0.12)",

  controlBg: "#FFFFFF",
  controlText: "#111827",
  controlBorder: "#E5E7EB",

  mutedText: "rgba(229,231,235,0.72)",

  primaryBg: "#2563EB",
  primaryText: "#FFFFFF",

  // pin A / pin B
  pinA: "#F59E0B",
  pinB: "#A855F7",

  // choropleth palette (5 buckets)
  palette: ["#E0F2FE", "#93C5FD", "#60A5FA", "#3B82F6", "#1D4ED8"],
  missing: "#9CA3AF",
};

// Invisible “hit” layers
const HIT_LAYERS = {
  city: "city-hit",
  micromarkets: "micromarkets-hit",
  localities: "localities-hit",
  roads: "roads-hit",
  projects: "projects-hit",
} as const;

// Pinned outline layers
const PIN_LAYERS = {
  mmA: "pinned-mm-outline-a",
  mmB: "pinned-mm-outline-b",
  locA: "pinned-loc-outline-a",
  locB: "pinned-loc-outline-b",
} as const;

// ---- Typed helpers ----
type LayerWithSourceLayer = AnyLayer & { "source-layer"?: string };
type FeatureId = string | number;

function getLayerId(f: MapboxGeoJSONFeature): string {
  return f.layer?.id ?? "";
}
function getSourceLayer(f: MapboxGeoJSONFeature): string {
  const layer = f.layer as LayerWithSourceLayer | undefined;
  return layer?.["source-layer"] ?? "";
}
function toFeatureId(v: unknown): FeatureId | null {
  return typeof v === "string" || typeof v === "number" ? v : null;
}
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

// Robust Shift detection across MouseEvent/PointerEvent/KeyboardEvent + getModifierState
function isShiftPressed(evt: unknown): boolean {
  if (!evt || typeof evt !== "object") return false;

  const maybeShift = evt as { shiftKey?: unknown; getModifierState?: unknown };

  if (typeof maybeShift.shiftKey === "boolean") return maybeShift.shiftKey;

  if (typeof maybeShift.getModifierState === "function") {
    return Boolean((maybeShift.getModifierState as (key: string) => boolean)("Shift"));
  }

  return false;
}

// Geometry -> bounds
function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function isLngLatPair(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && isNumber(v[0]) && isNumber(v[1]);
}
function collectLngLatPairs(node: unknown, out: Array<[number, number]>) {
  if (isLngLatPair(node)) {
    out.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectLngLatPairs(child, out);
  }
}
function boundsFromGeometry(geometry: unknown): [[number, number], [number, number]] | null {
  if (!geometry || typeof geometry !== "object") return null;
  const g = geometry as { type?: unknown; coordinates?: unknown };
  if (typeof g.type !== "string") return null;

  const pts: Array<[number, number]> = [];
  collectLngLatPairs(g.coordinates, pts);
  if (pts.length === 0) return null;

  let minLng = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;

  for (const [lng, lat] of pts) {
    minLng = Math.min(minLng, lng);
    minLat = Math.min(minLat, lat);
    maxLng = Math.max(maxLng, lng);
    maxLat = Math.max(maxLat, lat);
  }

  if (!Number.isFinite(minLng) || !Number.isFinite(minLat) || !Number.isFinite(maxLng) || !Number.isFinite(maxLat)) {
    return null;
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
function fitToFeature(map: Map, feature: MapboxGeoJSONFeature) {
  const b = boundsFromGeometry((feature as unknown as { geometry?: unknown }).geometry);
  if (b) {
    map.fitBounds(b, FIT_BOUNDS_OPTS);
    return;
  }
}

// Deltas + sparklines
function formatDelta(vNow: number | null, vPrev: number | null) {
  if (vNow === null || vPrev === null) return { abs: "-", pct: "-" };
  const abs = vNow - vPrev;
  const pct = vPrev !== 0 ? (abs / vPrev) * 100 : null;
  const absStr = (abs >= 0 ? "+" : "") + fmtMoney(Math.round(abs));
  const pctStr = pct === null ? "-" : `${abs >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
  return { abs: absStr, pct: pctStr };
}
function buildSparklinePath(values: number[], w: number, h: number) {
  if (values.length < 2) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);

  const pad = 2;
  const innerW = Math.max(1, w - pad * 2);
  const innerH = Math.max(1, h - pad * 2);

  const denom = max - min;
  const normY = (v: number) => {
    if (denom === 0) return pad + innerH / 2;
    const t = (v - min) / denom;
    return pad + (1 - t) * innerH;
  };

  const step = innerW / (values.length - 1);
  let d = `M ${pad} ${normY(values[0]).toFixed(2)}`;
  for (let i = 1; i < values.length; i++) {
    const x = pad + step * i;
    const y = normY(values[i]);
    d += ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  return d;
}

type DimItem = { id: number; name: string; micromarketId?: number | null; pincode?: string | null };
type DimDoc = { cityId: number; items: DimItem[] };

// -----------------------------
// Export helpers (exported)
// -----------------------------
export function isoCompactNow() {
  const d = new Date();
  const pad2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

export function downloadTextFile(filename: string, content: string, mime = "application/json") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function downloadDataUrl(filename: string, dataUrl: string) {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function exportMapPng(map: Map, filename: string) {
  const canvas = map.getCanvas();
  const dataUrl = canvas.toDataURL("image/png");
  downloadDataUrl(filename, dataUrl);
}

export default function MapView() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);

  const [mapReady, setMapReady] = useState(false);

  const [hoverInfo, setHoverInfo] = useState<PickInfo | null>(null);
  const [clickInfo, setClickInfo] = useState<PickInfo | null>(null);

  const [inspectTarget, setInspectTarget] = useState<InspectTarget>("localities");
  const inspectTargetRef = useRef<InspectTarget>(inspectTarget);
  useEffect(() => {
    inspectTargetRef.current = inspectTarget;
  }, [inspectTarget]);

  const [showLocalities, setShowLocalities] = useState(true);
  const [showMicromarkets, setShowMicromarkets] = useState(true);
  const [showProjects, setShowProjects] = useState(true);
  const [showRoads, setShowRoads] = useState(true);

  // Basemap controls
  const [lightPreset, setLightPreset] = useState<LightPreset>("day");
  const [enable3D, setEnable3D] = useState(false);

  // Choropleth controls (v2.3)
  const [enableChoropleth, setEnableChoropleth] = useState(true);
  const [metricKey, setMetricKey] = useState<string>("asking_psf");
  const [choroplethLevel, setChoroplethLevel] = useState<ChoroplethLevel>("micromarkets");
  const [metricMonth, setMetricMonth] = useState<string>("");

  // Documents cache: metricKey -> level -> doc
  const docsRef = useRef<Record<string, Partial<Record<ChoroplethLevel, MetricsDoc>>>>({});
  const [activeDoc, setActiveDoc] = useState<MetricsDoc | null>(null);

  // Legend info (data-wide, not just viewport)
  const [legend, setLegend] = useState<{
    stops: number[];
    count: number;
    missing: number;
    min: number | null;
    max: number | null;
  }>({ stops: [], count: 0, missing: 0, min: null, max: null });

  // Pin A / B (compare)
  const [pinA, setPinA] = useState<PinnedSelection | null>(null);
  const [pinB, setPinB] = useState<PinnedSelection | null>(null);

  // Timeline play
  const [isPlaying, setIsPlaying] = useState(false);
  const isPlayingRef = useRef(false);
  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  const [loopPlay, setLoopPlay] = useState(true);
  type PlaySpeed = "slow" | "normal" | "fast";
  const [playSpeed, setPlaySpeed] = useState<PlaySpeed>("normal");
  const playSpeedMs = useMemo(() => (playSpeed === "slow" ? 1200 : playSpeed === "fast" ? 450 : 800), [playSpeed]);

  // Search
  const [dimLocalities, setDimLocalities] = useState<DimItem[]>([]);
  const [dimMicromarkets, setDimMicromarkets] = useState<DimItem[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchScope, setSearchScope] = useState<ChoroplethLevel>("localities");

  // SHIFT state cache (fixes cases where click event loses modifier state)
  const shiftDownRef = useRef(false);

  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

  const vectorSources = useMemo(() => {
    return {
      city: `mapbox://${TILESETS.city.id}`,
      micromarkets: `mapbox://${TILESETS.micromarkets.id}`,
      localities: `mapbox://${TILESETS.localities.id}`,
      roads: `mapbox://${TILESETS.roads.id}`,
      projects: `mapbox://${TILESETS.projects.id}`,
    };
  }, []);

  const stopPlayback = () => {
    if (isPlayingRef.current) setIsPlaying(false);
  };

  const resetView = () => {
    stopPlayback();
    const map = mapRef.current;
    if (!map) return;
    map.easeTo({
      center: DEFAULT_CENTER as unknown as LngLatLike,
      zoom: DEFAULT_ZOOM,
      bearing: enable3D ? -20 : 0,
      pitch: enable3D ? 60 : 0,
      duration: 650,
    });
  };

  // -----------------------------
  // Export handlers (UI + keyboard)
  // -----------------------------
  const buildExportBaseName = () => {
    const monthLabel = metricMonth ? metricMonth.replaceAll("-", "") : "nomonth";
    return `map_${metricKey}_${choroplethLevel}_${monthLabel}_${isoCompactNow()}`;
  };

  const handleExportPng = () => {
    const map = mapRef.current;
    if (!map) return;

    try {
      const name = `${buildExportBaseName()}.png`;
      exportMapPng(map, name);
    } catch (e) {
      console.error("PNG export failed:", e);
      alert(
        "PNG export failed. If you're using external images/icons without CORS, the canvas can become tainted. Check console for details."
      );
    }
  };

  const handleExportStateJson = () => {
    const state = {
      metricKey,
      choroplethLevel,
      metricMonth,
      lightPreset,
      enable3D,
      enableChoropleth,
      pinA,
      pinB,
      exportedAt: new Date().toISOString(),
    };
    const name = `${buildExportBaseName()}_state.json`;
    downloadTextFile(name, JSON.stringify(state, null, 2), "application/json");
  };

  // -----------------------------
  // URL state: read once at mount (shareable state)
  // -----------------------------
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);

    const m = sp.get("metric");
    const lvl = sp.get("level");
    const month = sp.get("month");
    const lp = sp.get("light");
    const d3 = sp.get("d3");
    const ch = sp.get("ch");

    if (m) setMetricKey(m);
    if (lvl === "micromarkets" || lvl === "localities") setChoroplethLevel(lvl);
    if (month) setMetricMonth(month);

    if (lp === "dawn" || lp === "day" || lp === "dusk" || lp === "night") setLightPreset(lp);
    if (d3 === "1") setEnable3D(true);
    if (ch === "0") setEnableChoropleth(false);

    const parsePin = (s: string | null): PinnedSelection | null => {
      if (!s) return null;
      // format: "<level>:<joinKey>:<displayName?>"
      const parts = s.split(":");
      const level = parts[0] as ChoroplethLevel;
      const joinKey = decodeURIComponent(parts[1] ?? "");
      const displayName = decodeURIComponent(parts.slice(2).join(":") || joinKey);
      if (level !== "micromarkets" && level !== "localities") return null;
      return { level, joinKey, displayName, featureId: null };
    };

    setPinA(parsePin(sp.get("pinA")));
    setPinB(parsePin(sp.get("pinB")));
  }, []);

  // Write URL state (replaceState)
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);

    sp.set("metric", metricKey);
    sp.set("level", choroplethLevel);
    if (metricMonth) sp.set("month", metricMonth);
    sp.set("light", lightPreset);
    sp.set("d3", enable3D ? "1" : "0");
    sp.set("ch", enableChoropleth ? "1" : "0");

    const encPin = (p: PinnedSelection | null) => {
      if (!p) return null;
      return `${p.level}:${encodeURIComponent(p.joinKey)}:${encodeURIComponent(p.displayName)}`;
    };

    const a = encPin(pinA);
    const b = encPin(pinB);
    if (a) sp.set("pinA", a);
    else sp.delete("pinA");
    if (b) sp.set("pinB", b);
    else sp.delete("pinB");

    const next = `${window.location.pathname}?${sp.toString()}`;
    window.history.replaceState({}, "", next);
  }, [metricKey, choroplethLevel, metricMonth, lightPreset, enable3D, enableChoropleth, pinA, pinB]);

  // -----------------------------
  // Load dims for search (public/dim/*.json)
  // -----------------------------
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [locRes, mmRes] = await Promise.all([
          fetch("/dim/localities_city13.json", { cache: "no-store" }),
          fetch("/dim/micromarkets_city13.json", { cache: "no-store" }),
        ]);
        if (!locRes.ok) throw new Error(`Failed localities dim: ${locRes.status}`);
        if (!mmRes.ok) throw new Error(`Failed micromarkets dim: ${mmRes.status}`);

        const loc = (await locRes.json()) as DimDoc;
        const mm = (await mmRes.json()) as DimDoc;
        if (cancelled) return;

        setDimLocalities(loc.items ?? []);
        setDimMicromarkets(mm.items ?? []);
      } catch (e) {
        console.warn("Dim search docs not found yet (run build_dims_public.py):", e);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  // -----------------------------
  // Load active metrics doc (metricKey + choroplethLevel)
  // -----------------------------
  useEffect(() => {
    let cancelled = false;

    async function loadDoc() {
      const def = getMetricDef(metricKey);
      const url = def.files[choroplethLevel];
      if (!url) return;

      const cached = docsRef.current[metricKey]?.[choroplethLevel];
      if (cached) {
        setActiveDoc(cached);
        return;
      }

      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`Failed metrics doc: ${res.status} (${url})`);
        const doc = (await res.json()) as MetricsDoc;

        if (cancelled) return;

        docsRef.current[metricKey] = docsRef.current[metricKey] || {};
        docsRef.current[metricKey]![choroplethLevel] = doc;
        setActiveDoc(doc);

        // default month -> latest
        const latest = doc.months?.[doc.months.length - 1] ?? "";
        setMetricMonth((prev) => (prev ? prev : latest));
      } catch (e) {
        console.error("Failed to load metrics JSON:", e);
      }
    }

    loadDoc();
    return () => {
      cancelled = true;
    };
  }, [metricKey, choroplethLevel]);

  const monthOptions = useMemo(() => activeDoc?.months ?? [], [activeDoc]);

  // Keep metricMonth valid
  useEffect(() => {
    if (!monthOptions.length) return;
    if (!metricMonth || !monthOptions.includes(metricMonth)) {
      setMetricMonth(monthOptions[monthOptions.length - 1]);
    }
  }, [monthOptions, metricMonth]);

  // Slider index
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
        const curIdx = monthOptions.indexOf(prev);
        const safeIdx = curIdx >= 0 ? curIdx : 0;
        let nextIdx = safeIdx + 1;

        if (nextIdx >= monthOptions.length) {
          if (!loopPlay) {
            window.clearInterval(id);
            setIsPlaying(false);
            return monthOptions[monthOptions.length - 1];
          }
          nextIdx = 0;
        }
        return monthOptions[nextIdx];
      });
    }, playSpeedMs);

    return () => window.clearInterval(id);
  }, [isPlaying, enableChoropleth, monthOptions, loopPlay, playSpeedMs]);

  // -----------------------------
  // Map init
  // -----------------------------
  useEffect(() => {
    if (!containerRef.current) return;
    if (!token) {
      console.error("Missing NEXT_PUBLIC_MAPBOX_TOKEN in .env.local");
      return;
    }
    if (mapRef.current) return;

    mapboxgl.accessToken = token;

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/standard",
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      pitch: 0,
      bearing: 0,
      antialias: true,
      preserveDrawingBuffer: true, // ✅ required for PNG export
      config: { basemap: { lightPreset } },
    });

    // IMPORTANT: Shift is used for Pin-B selection. Disable Mapbox BoxZoom (Shift+drag).
    try {
      map.boxZoom.disable();
    } catch {
      // ignore
    }

    mapRef.current = map;
    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "top-right");

    map.on("load", () => {
      setMapReady(true);

      map.addSource("city-src", { type: "vector", url: vectorSources.city });
      map.addSource("micromarkets-src", { type: "vector", url: vectorSources.micromarkets });
      map.addSource("localities-src", { type: "vector", url: vectorSources.localities });
      map.addSource("roads-src", { type: "vector", url: vectorSources.roads });
      map.addSource("projects-src", { type: "vector", url: vectorSources.projects });

      map.addLayer({
        id: "city-outline",
        type: "line",
        source: "city-src",
        "source-layer": TILESETS.city.sourceLayer,
        paint: { "line-width": 2 },
      });

      map.addLayer({
        id: "micromarkets-fill",
        type: "fill",
        source: "micromarkets-src",
        "source-layer": TILESETS.micromarkets.sourceLayer,
        paint: { "fill-opacity": 0.08 },
      });
      map.addLayer({
        id: "micromarkets-outline",
        type: "line",
        source: "micromarkets-src",
        "source-layer": TILESETS.micromarkets.sourceLayer,
        paint: { "line-width": 1 },
      });

      map.addLayer({
        id: "localities-fill",
        type: "fill",
        source: "localities-src",
        "source-layer": TILESETS.localities.sourceLayer,
        paint: { "fill-opacity": 0.06 },
      });
      map.addLayer({
        id: "localities-outline",
        type: "line",
        source: "localities-src",
        "source-layer": TILESETS.localities.sourceLayer,
        paint: { "line-width": 0.7 },
      });

      map.addLayer({
        id: "roads-line",
        type: "line",
        source: "roads-src",
        "source-layer": TILESETS.roads.sourceLayer,
        paint: { "line-width": 1.2 },
      });

      map.addLayer({
        id: "projects-circle",
        type: "circle",
        source: "projects-src",
        "source-layer": TILESETS.projects.sourceLayer,
        paint: { "circle-radius": 3, "circle-opacity": 0.75 },
      });

      // HIT layers
      map.addLayer({
        id: HIT_LAYERS.city,
        type: "line",
        source: "city-src",
        "source-layer": TILESETS.city.sourceLayer,
        paint: { "line-width": 12, "line-opacity": 0 },
      });

      map.addLayer({
        id: HIT_LAYERS.micromarkets,
        type: "fill",
        source: "micromarkets-src",
        "source-layer": TILESETS.micromarkets.sourceLayer,
        paint: { "fill-color": "#000000", "fill-opacity": 0 },
      });

      map.addLayer({
        id: HIT_LAYERS.localities,
        type: "fill",
        source: "localities-src",
        "source-layer": TILESETS.localities.sourceLayer,
        paint: { "fill-color": "#000000", "fill-opacity": 0 },
      });

      map.addLayer({
        id: HIT_LAYERS.roads,
        type: "line",
        source: "roads-src",
        "source-layer": TILESETS.roads.sourceLayer,
        paint: { "line-width": 12, "line-opacity": 0 },
      });

      map.addLayer({
        id: HIT_LAYERS.projects,
        type: "circle",
        source: "projects-src",
        "source-layer": TILESETS.projects.sourceLayer,
        paint: { "circle-radius": 10, "circle-opacity": 0 },
      });

      // Pin outline layers (A/B) — micromarkets by feature id, localities by LocalityName
      map.addLayer({
        id: PIN_LAYERS.mmA,
        type: "line",
        source: "micromarkets-src",
        "source-layer": TILESETS.micromarkets.sourceLayer,
        filter: ["==", ["id"], -999999],
        paint: { "line-color": UI.pinA, "line-width": 3 },
      });
      map.addLayer({
        id: PIN_LAYERS.mmB,
        type: "line",
        source: "micromarkets-src",
        "source-layer": TILESETS.micromarkets.sourceLayer,
        filter: ["==", ["id"], -999999],
        paint: { "line-color": UI.pinB, "line-width": 3 },
      });
      map.addLayer({
        id: PIN_LAYERS.locA,
        type: "line",
        source: "localities-src",
        "source-layer": TILESETS.localities.sourceLayer,
        filter: ["==", ["get", "LocalityName"], "__nope__"],
        paint: { "line-color": UI.pinA, "line-width": 3 },
      });
      map.addLayer({
        id: PIN_LAYERS.locB,
        type: "line",
        source: "localities-src",
        "source-layer": TILESETS.localities.sourceLayer,
        filter: ["==", ["get", "LocalityName"], "__nope__"],
        paint: { "line-color": UI.pinB, "line-width": 3 },
      });

      // Stop playback on map interactions
      const stop = () => stopPlayback();
      map.on("dragstart", stop);
      map.on("zoomstart", stop);
      map.on("rotatestart", stop);
      map.on("pitchstart", stop);
      map.on("movestart", stop);
      map.on("mousedown", stop);
      map.on("touchstart", stop);

      // Track shift on mousedown (fixes shift losing state on click in some cases)
      const onMouseDown = (e: MapMouseEvent) => {
        const oe = e.originalEvent;
        shiftDownRef.current = isShiftPressed(oe) || isShiftPressed(e);
      };
      const onTouchStart = () => {
        shiftDownRef.current = false;
      };
      map.on("mousedown", onMouseDown);
      map.on("touchstart", onTouchStart);

      // Pointer move RAF (performance)
      let rafId: number | null = null;
      let lastMoveEvt: MapMouseEvent | null = null;

      const handleMove = () => {
        rafId = null;
        const e = lastMoveEvt;
        if (!e) return;

        const m = mapRef.current;
        if (!m) return;

        const layer = targetToLayerId(inspectTargetRef.current);
        const features = m.queryRenderedFeatures(e.point, { layers: [layer] });

        if (!features.length) {
          m.getCanvas().style.cursor = "";
          setHoverInfo(null);
          return;
        }

        m.getCanvas().style.cursor = "pointer";
        const f = features[0]!;
        const props = (f.properties ?? {}) as Record<string, unknown>;

        setHoverInfo({
          layerId: getLayerId(f),
          sourceLayer: getSourceLayer(f),
          featureId: f.id ?? null,
          propertyKeys: Object.keys(props),
          properties: props,
          lngLat: { lng: e.lngLat.lng, lat: e.lngLat.lat },
        });
      };

      const onMove = (e: MapMouseEvent) => {
        lastMoveEvt = e;
        if (rafId !== null) return;
        rafId = window.requestAnimationFrame(handleMove);
      };

      // Click: pin A (normal click), pin B (Shift+Click)
      const onClick = (e: MapMouseEvent) => {
        stopPlayback();

        const m = mapRef.current;
        if (!m) return;

        const layer = targetToLayerId(inspectTargetRef.current);
        const features = m.queryRenderedFeatures(e.point, { layers: [layer] });

        if (!features.length) {
          setClickInfo(null);
          return;
        }

        const f = features[0]!;
        const props = (f.properties ?? {}) as Record<string, unknown>;

        setClickInfo({
          layerId: getLayerId(f),
          sourceLayer: getSourceLayer(f),
          featureId: f.id ?? null,
          propertyKeys: Object.keys(props),
          properties: props,
          lngLat: { lng: e.lngLat.lng, lat: e.lngLat.lat },
        });

        const fid = toFeatureId(f.id);

        // Robust: use originalEvent shiftKey OR cached shift from mousedown
        const oe = e.originalEvent;
        const assignToB = isShiftPressed(oe) || shiftDownRef.current === true;

        // Reset cached shift after processing one click
        shiftDownRef.current = false;

        if (layer === HIT_LAYERS.micromarkets && fid !== null) {
          const name =
            getStrProp(props, "MicroMarketName") ||
            getStrProp(props, "MicromarketName") ||
            getStrProp(props, "Micromarket") ||
            `Micromarket ${String(fid)}`;

          const next: PinnedSelection = {
            level: "micromarkets",
            joinKey: String(fid),
            displayName: name,
            featureId: fid,
          };

          if (assignToB) setPinB(next);
          else setPinA(next);

          fitToFeature(m, f);
        } else if (layer === HIT_LAYERS.localities && fid !== null) {
          const lname = getStrProp(props, "LocalityName") || "";
          if (lname) {
            const next: PinnedSelection = {
              level: "localities",
              joinKey: lname,
              displayName: lname,
              featureId: fid,
            };
            if (assignToB) setPinB(next);
            else setPinA(next);

            fitToFeature(m, f);
          }
        }
      };

      map.on("mousemove", onMove);
      map.on("click", onClick);

      const onKeyDown = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") {
          stopPlayback();
          setPinA(null);
          setPinB(null);
        }
        if (ev.key === "r" || ev.key === "R") resetView();

        // Export shortcuts
        if (ev.key === "p" || ev.key === "P") handleExportPng();
        if (ev.key === "j" || ev.key === "J") handleExportStateJson();
      };
      window.addEventListener("keydown", onKeyDown);

      map.once("remove", () => {
        window.removeEventListener("keydown", onKeyDown);
        map.off("dragstart", stop);
        map.off("zoomstart", stop);
        map.off("rotatestart", stop);
        map.off("pitchstart", stop);
        map.off("movestart", stop);
        map.off("mousedown", stop);
        map.off("touchstart", stop);

        map.off("mousedown", onMouseDown);
        map.off("touchstart", onTouchStart);

        map.off("mousemove", onMove);
        map.off("click", onClick);
        if (rafId !== null) window.cancelAnimationFrame(rafId);
      });
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, vectorSources]);

  // -----------------------------
  // Pin highlight filters sync (A/B)
  // -----------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const setEmpty = () => {
      map.setFilter(PIN_LAYERS.mmA, ["==", ["id"], -999999]);
      map.setFilter(PIN_LAYERS.mmB, ["==", ["id"], -999999]);
      map.setFilter(PIN_LAYERS.locA, ["==", ["get", "LocalityName"], "__nope__"]);
      map.setFilter(PIN_LAYERS.locB, ["==", ["get", "LocalityName"], "__nope__"]);
    };

    if (!map.getLayer(PIN_LAYERS.mmA)) return;

    setEmpty();

    const applyOne = (p: PinnedSelection | null, which: "A" | "B") => {
      if (!p) return;
      if (p.level === "micromarkets") {
        const fidNum = Number(p.featureId ?? p.joinKey);
        map.setFilter(which === "A" ? PIN_LAYERS.mmA : PIN_LAYERS.mmB, ["==", ["id"], Number.isFinite(fidNum) ? fidNum : -999999]);
      } else {
        map.setFilter(which === "A" ? PIN_LAYERS.locA : PIN_LAYERS.locB, ["==", ["get", "LocalityName"], p.joinKey || "__nope__"]);
      }
    };

    applyOne(pinA, "A");
    applyOne(pinB, "B");
  }, [pinA, pinB]);

  // -----------------------------
  // Layer visibility toggles
  // -----------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    setLayerVisibility(map, "localities-fill", showLocalities);
    setLayerVisibility(map, "localities-outline", showLocalities);
    setLayerVisibility(map, HIT_LAYERS.localities, showLocalities);
    setLayerVisibility(map, PIN_LAYERS.locA, showLocalities);
    setLayerVisibility(map, PIN_LAYERS.locB, showLocalities);

    setLayerVisibility(map, "micromarkets-fill", showMicromarkets);
    setLayerVisibility(map, "micromarkets-outline", showMicromarkets);
    setLayerVisibility(map, HIT_LAYERS.micromarkets, showMicromarkets);
    setLayerVisibility(map, PIN_LAYERS.mmA, showMicromarkets);
    setLayerVisibility(map, PIN_LAYERS.mmB, showMicromarkets);

    setLayerVisibility(map, "projects-circle", showProjects);
    setLayerVisibility(map, HIT_LAYERS.projects, showProjects);

    setLayerVisibility(map, "roads-line", showRoads);
    setLayerVisibility(map, HIT_LAYERS.roads, showRoads);

    setLayerVisibility(map, HIT_LAYERS.city, true);
  }, [showLocalities, showMicromarkets, showProjects, showRoads]);

  // Light preset runtime
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    try {
      map.setConfigProperty("basemap", "lightPreset", lightPreset);
    } catch (e) {
      console.warn("setConfigProperty failed (safe to ignore during init):", e);
    }
  }, [lightPreset]);

  // 2D/3D toggle (safe terrain)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    let cancelled = false;

    const apply = () => {
      if (cancelled) return;
      if (!map.isStyleLoaded()) {
        map.once("idle", apply);
        return;
      }

      if (enable3D) {
        const demSourceId = "mapbox-dem";
        if (!map.getSource(demSourceId)) {
          try {
            map.addSource(demSourceId, {
              type: "raster-dem",
              url: "mapbox://mapbox.mapbox-terrain-dem-v1",
              tileSize: 512,
              maxzoom: 14,
            });
          } catch (e) {
            console.warn("DEM addSource failed:", e);
            map.once("idle", apply);
            return;
          }
        }

        try {
          map.setTerrain({ source: demSourceId, exaggeration: 1.3 });
        } catch (e) {
          console.warn("setTerrain failed:", e);
        }

        map.easeTo({ pitch: 60, bearing: -20, duration: 600 });
      } else {
        try {
          map.setTerrain(null);
        } catch {
          // ignore
        }
        map.easeTo({ pitch: 0, bearing: 0, duration: 600 });
      }
    };

    apply();
    return () => {
      cancelled = true;
    };
  }, [enable3D]);

  // Ensure correct polygon layer visible when choropleth enabled
  useEffect(() => {
    if (!enableChoropleth) return;
    if (choroplethLevel === "micromarkets") {
      if (!showMicromarkets) setShowMicromarkets(true);
    } else {
      if (!showLocalities) setShowLocalities(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enableChoropleth, choroplethLevel]);

  // -----------------------------
  // Choropleth: compute legend + stops from data distribution for the selected month
  // -----------------------------
  const bucketRanges = useMemo(() => formatBucketRanges(legend.stops), [legend.stops]);

  useEffect(() => {
    if (!enableChoropleth || !activeDoc || !metricMonth) {
      setLegend({ stops: [], count: 0, missing: 0, min: null, max: null });
      return;
    }

    const byMonth = activeDoc.byMonth?.[metricMonth];
    if (!byMonth) {
      setLegend({ stops: [], count: 0, missing: 0, min: null, max: null });
      return;
    }

    const values: number[] = [];
    let missing = 0;

    for (const k of Object.keys(byMonth)) {
      const v = byMonth[k]?.v;
      if (typeof v === "number" && Number.isFinite(v)) values.push(v);
      else missing += 1;
    }

    values.sort((a, b) => a - b);
    const min = values.length ? values[0]! : null;
    const max = values.length ? values[values.length - 1]! : null;

    const def = getMetricDef(metricKey);
    const stops = computeQuantileStops(values, def.bucketCount);

    setLegend({
      stops,
      count: values.length,
      missing,
      min,
      max,
    });
  }, [enableChoropleth, activeDoc, metricMonth, metricKey]);

  // -----------------------------
  // Choropleth: paint expression (data-driven stops)
  // -----------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const isMm = choroplethLevel === "micromarkets";
    const fillLayer = isMm ? "micromarkets-fill" : "localities-fill";
    if (!map.getLayer(fillLayer)) return;

    if (!enableChoropleth || legend.stops.length < 2) {
      map.setPaintProperty(fillLayer, "fill-color", "#888888");
      map.setPaintProperty(fillLayer, "fill-opacity", isMm ? 0.08 : 0.06);
      return;
    }

    const valueExpr: ExpressionSpecification = ["coalesce", ["feature-state", "v"], -1];

    const stops = legend.stops.slice();
    const palette = UI.palette.slice(0, Math.max(1, stops.length - 1));

    const stepExpr: ExpressionSpecification = ["step", valueExpr, palette[0]];
    for (let i = 1; i < palette.length; i++) {
      (stepExpr as unknown as unknown[]).push(stops[i], palette[i]);
    }

    map.setPaintProperty(fillLayer, "fill-color", ["case", ["<=", valueExpr, -1], UI.missing, stepExpr]);

    map.setPaintProperty(fillLayer, "fill-opacity", ["case", ["<=", valueExpr, -1], 0.04, isMm ? 0.28 : 0.24]);
  }, [enableChoropleth, choroplethLevel, legend.stops]);

  // -----------------------------
  // Choropleth: visible-only feature-state + cache (level, month, metric)
  // -----------------------------
  const stateCacheRef = useRef<Record<string, Set<string | number>>>({});
  const lastApplyRef = useRef<{ cacheKey: string; lastZoom: number; lastCenter: string } | null>(null);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!enableChoropleth || !activeDoc || !metricMonth) return;

    const isMm = choroplethLevel === "micromarkets";
    const sourceId = isMm ? "micromarkets-src" : "localities-src";
    const sourceLayer = isMm ? TILESETS.micromarkets.sourceLayer : TILESETS.localities.sourceLayer;
    const fillLayer = isMm ? "micromarkets-fill" : "localities-fill";

    if (!map.getSource(sourceId) || !map.getLayer(fillLayer)) return;

    const byMonth = activeDoc.byMonth?.[metricMonth];
    if (!byMonth) return;

    const cacheKey = `${metricKey}|${choroplethLevel}|${metricMonth}`;
    stateCacheRef.current[cacheKey] = stateCacheRef.current[cacheKey] || new Set<string | number>();
    const applied = stateCacheRef.current[cacheKey]!;

    const applyVisible = () => {
      const center = map.getCenter();
      const centerKey = `${center.lng.toFixed(5)},${center.lat.toFixed(5)}`;
      const z = map.getZoom();

      const last = lastApplyRef.current;
      if (last && last.cacheKey === cacheKey && last.lastZoom === z && last.lastCenter === centerKey) {
        return;
      }
      lastApplyRef.current = { cacheKey, lastZoom: z, lastCenter: centerKey };

      const features = map.queryRenderedFeatures({ layers: [fillLayer] });
      for (const f of features) {
        const fid = toFeatureId(f.id);
        if (fid === null) continue;
        if (applied.has(fid)) continue;

        let joinKey = "";
        if (isMm) {
          joinKey = String(fid);
        } else {
          const lname = (f.properties as Record<string, unknown> | undefined)?.LocalityName;
          joinKey = typeof lname === "string" ? lname : "";
        }

        const bucket = joinKey ? byMonth[joinKey] : undefined;
        const v = bucket?.v;

        if (typeof v === "number" && Number.isFinite(v)) {
          map.setFeatureState({ source: sourceId, sourceLayer, id: fid }, { v, n: bucket?.n ?? null });
        } else {
          map.setFeatureState({ source: sourceId, sourceLayer, id: fid }, { v: null, n: null });
        }

        applied.add(fid);
      }
    };

    applyVisible();

    const onMoveEnd = () => applyVisible();
    const onZoomEnd = () => applyVisible();

    map.on("moveend", onMoveEnd);
    map.on("zoomend", onZoomEnd);

    return () => {
      map.off("moveend", onMoveEnd);
      map.off("zoomend", onZoomEnd);
    };
  }, [enableChoropleth, activeDoc, metricMonth, choroplethLevel, metricKey]);

  // -----------------------------
  // Pinned series (A/B) from activeDoc
  // -----------------------------
  const seriesA = useMemo(() => {
    if (!pinA || !activeDoc) return [];
    const months = activeDoc.months ?? [];
    return months.map((m) => {
      const bucket = activeDoc.byMonth?.[m]?.[pinA.joinKey];
      return {
        month: m,
        v: typeof bucket?.v === "number" ? bucket.v : null,
        n: typeof bucket?.n === "number" ? bucket.n : null,
      };
    });
  }, [pinA, activeDoc]);

  const seriesB = useMemo(() => {
    if (!pinB || !activeDoc) return [];
    const months = activeDoc.months ?? [];
    return months.map((m) => {
      const bucket = activeDoc.byMonth?.[m]?.[pinB.joinKey];
      return {
        month: m,
        v: typeof bucket?.v === "number" ? bucket.v : null,
        n: typeof bucket?.n === "number" ? bucket.n : null,
      };
    });
  }, [pinB, activeDoc]);

  const currentA = useMemo(() => {
    if (!pinA || !activeDoc || !metricMonth) return null;
    return activeDoc.byMonth?.[metricMonth]?.[pinA.joinKey] ?? null;
  }, [pinA, activeDoc, metricMonth]);

  const currentB = useMemo(() => {
    if (!pinB || !activeDoc || !metricMonth) return null;
    return activeDoc.byMonth?.[metricMonth]?.[pinB.joinKey] ?? null;
  }, [pinB, activeDoc, metricMonth]);

  const deltaA = useMemo(() => {
    if (!pinA || !metricMonth) return { abs: "-", pct: "-" };
    const idx = seriesA.findIndex((r) => r.month === metricMonth);
    if (idx <= 0) return { abs: "-", pct: "-" };
    return formatDelta(seriesA[idx]?.v ?? null, seriesA[idx - 1]?.v ?? null);
  }, [pinA, metricMonth, seriesA]);

  const deltaB = useMemo(() => {
    if (!pinB || !metricMonth) return { abs: "-", pct: "-" };
    const idx = seriesB.findIndex((r) => r.month === metricMonth);
    if (idx <= 0) return { abs: "-", pct: "-" };
    return formatDelta(seriesB[idx]?.v ?? null, seriesB[idx - 1]?.v ?? null);
  }, [pinB, metricMonth, seriesB]);

  const sparkA = useMemo(() => {
    const values = seriesA.map((r) => r.v).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const w = 160;
    const h = 44;
    const d = buildSparklinePath(values, w, h);
    return { w, h, d, has: d.length > 0 };
  }, [seriesA]);

  const sparkB = useMemo(() => {
    const values = seriesB.map((r) => r.v).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const w = 160;
    const h = 44;
    const d = buildSparklinePath(values, w, h);
    return { w, h, d, has: d.length > 0 };
  }, [seriesB]);

  // -----------------------------
  // Search results
  // -----------------------------
  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    const list = searchScope === "localities" ? dimLocalities : dimMicromarkets;
    return list.filter((x) => x.name.toLowerCase().includes(q)).slice(0, 12);
  }, [searchQuery, searchScope, dimLocalities, dimMicromarkets]);

  async function jumpToByName(level: ChoroplethLevel, name: string) {
    stopPlayback();

    const map = mapRef.current;
    if (!map) return;

    if (level === "micromarkets") setShowMicromarkets(true);
    else setShowLocalities(true);

    setInspectTarget(level === "micromarkets" ? "micromarkets" : "localities");
    setChoroplethLevel(level);

    const srcId = level === "micromarkets" ? "micromarkets-src" : "localities-src";
    const srcLayer = level === "micromarkets" ? TILESETS.micromarkets.sourceLayer : TILESETS.localities.sourceLayer;

    const tryFind = () => {
      const nameProps = level === "micromarkets" ? ["MicroMarketName", "MicromarketName", "Micromarket"] : ["LocalityName"];
      for (const prop of nameProps) {
        try {
          const feats = map.querySourceFeatures(srcId, {
            sourceLayer: srcLayer,
            filter: ["==", ["get", prop], name] as FilterSpecification,
          });

          if (feats && feats.length) {
            const f = feats[0] as unknown as MapboxGeoJSONFeature;
            const fid = toFeatureId(f.id);
            const props = (f.properties ?? {}) as Record<string, unknown>;

            if (level === "micromarkets" && fid !== null) {
              const display =
                getStrProp(props, "MicroMarketName") ||
                getStrProp(props, "MicromarketName") ||
                getStrProp(props, "Micromarket") ||
                name;

              setPinA({ level: "micromarkets", joinKey: String(fid), displayName: display, featureId: fid });
              fitToFeature(map, f);
              return true;
            }

            if (level === "localities") {
              setPinA({ level: "localities", joinKey: name, displayName: name, featureId: fid ?? null });
              fitToFeature(map, f);
              return true;
            }
          }
        } catch {
          // ignore
        }
      }
      return false;
    };

    if (tryFind()) return;

    map.easeTo({ center: DEFAULT_CENTER as unknown as LngLatLike, zoom: Math.max(map.getZoom(), 11.5), duration: 450 });
    map.once("idle", () => {
      tryFind();
    });
  }

  const def = useMemo(() => getMetricDef(metricKey), [metricKey]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 420px", height: "100vh" }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />

      <div
        style={{
          borderLeft: `1px solid ${UI.panelBorder}`,
          padding: 12,
          overflow: "auto",
          background: UI.panelBg,
          color: UI.panelText,
        }}
      >
        <h3 style={{ margin: "0 0 8px 0" }}>Inspector</h3>

        {/* Export controls */}
        <div
          style={{
            marginBottom: 12,
            padding: 10,
            border: `1px solid ${UI.panelBorder}`,
            borderRadius: 8,
            background: "rgba(255,255,255,0.03)",
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Exports</div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <button
              onClick={handleExportPng}
              disabled={!mapReady}
              style={{
                fontSize: 12,
                padding: "10px 10px",
                border: `1px solid ${UI.controlBorder}`,
                borderRadius: 8,
                background: UI.controlBg,
                color: UI.controlText,
                cursor: mapReady ? "pointer" : "not-allowed",
                opacity: mapReady ? 1 : 0.55,
              }}
              title={mapReady ? "Export current map canvas as PNG (P)" : "Map not ready yet"}
            >
              Export PNG (P)
            </button>

            <button
              onClick={handleExportStateJson}
              style={{
                fontSize: 12,
                padding: "10px 10px",
                border: `1px solid ${UI.controlBorder}`,
                borderRadius: 8,
                background: UI.controlBg,
                color: UI.controlText,
                cursor: "pointer",
              }}
              title="Export current inspector state as JSON (J)"
            >
              Export State JSON (J)
            </button>
          </div>

          <div style={{ marginTop: 8, fontSize: 12, color: UI.mutedText }}>
            Notes: PNG export requires <code>preserveDrawingBuffer</code>. If you later add external images/icons without CORS, export may fail due to a tainted canvas.
          </div>
        </div>

        {/* v2.3 Controls */}
        <div
          style={{
            marginBottom: 12,
            padding: 10,
            border: `1px solid ${UI.panelBorder}`,
            borderRadius: 8,
            background: "rgba(255,255,255,0.03)",
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 8 }}>v2.3 Dynamic Metrics</div>

          <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
            <input
              type="checkbox"
              checked={enableChoropleth}
              onChange={(e) => {
                stopPlayback();
                setEnableChoropleth(e.target.checked);
              }}
            />
            Enable choropleth
          </label>

          <div style={{ display: "grid", gap: 10 }}>
            <div>
              <div style={{ fontSize: 12, opacity: 0.9, marginBottom: 4 }}>Metric</div>
              <select
                value={metricKey}
                onChange={(e) => {
                  stopPlayback();
                  setMetricKey(e.target.value);
                }}
                style={{
                  width: "100%",
                  padding: 8,
                  borderRadius: 8,
                  border: `1px solid ${UI.controlBorder}`,
                  background: UI.controlBg,
                  color: UI.controlText,
                }}
                disabled={!enableChoropleth}
              >
                {METRICS.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <div style={{ fontSize: 12, opacity: 0.9, marginBottom: 4 }}>Level</div>
              <select
                value={choroplethLevel}
                onChange={(e) => {
                  stopPlayback();
                  const lvl = e.target.value as ChoroplethLevelCfg;
                  setChoroplethLevel(lvl);
                }}
                style={{
                  width: "100%",
                  padding: 8,
                  borderRadius: 8,
                  border: `1px solid ${UI.controlBorder}`,
                  background: UI.controlBg,
                  color: UI.controlText,
                }}
                disabled={!enableChoropleth}
              >
                <option value="micromarkets">Micromarkets (join via featureId)</option>
                <option value="localities">Localities (join via LocalityName)</option>
              </select>
            </div>

            <div>
              <div style={{ fontSize: 12, opacity: 0.9, marginBottom: 4 }}>Month</div>
              <select
                value={metricMonth}
                onChange={(e) => {
                  stopPlayback();
                  setMetricMonth(e.target.value);
                }}
                style={{
                  width: "100%",
                  padding: 8,
                  borderRadius: 8,
                  border: `1px solid ${UI.controlBorder}`,
                  background: UI.controlBg,
                  color: UI.controlText,
                }}
                disabled={!enableChoropleth || monthOptions.length === 0}
              >
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

            {/* Timeline slider + Play */}
            <div
              style={{
                padding: 10,
                border: `1px solid ${UI.panelBorder}`,
                borderRadius: 8,
                background: "rgba(255,255,255,0.03)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                <div style={{ fontSize: 12, opacity: 0.9 }}>Timeline</div>
                <div style={{ fontSize: 12, fontWeight: 600 }}>{metricMonth ? parseMonthLabel(metricMonth) : "-"}</div>
              </div>

              <div style={{ marginTop: 8 }}>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, monthOptions.length - 1)}
                  step={1}
                  value={metricMonthIndex}
                  onChange={(e) => {
                    stopPlayback();
                    const idx = Number(e.target.value);
                    const next = monthOptions[idx];
                    if (next) setMetricMonth(next);
                  }}
                  disabled={!enableChoropleth || monthOptions.length === 0}
                  style={{ width: "100%" }}
                />
              </div>

              <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <button
                  onClick={() => {
                    if (!enableChoropleth) return;
                    if (!monthOptions.length) return;
                    setIsPlaying((p) => !p);
                  }}
                  disabled={!enableChoropleth || monthOptions.length < 2}
                  style={{
                    fontSize: 12,
                    padding: "8px 10px",
                    border: "1px solid transparent",
                    borderRadius: 8,
                    background: UI.primaryBg,
                    color: UI.primaryText,
                    cursor: !enableChoropleth || monthOptions.length < 2 ? "not-allowed" : "pointer",
                    opacity: !enableChoropleth || monthOptions.length < 2 ? 0.55 : 1,
                  }}
                  title={monthOptions.length < 2 ? "Not enough months to play" : isPlaying ? "Pause" : "Play"}
                >
                  {isPlaying ? "Pause" : "Play"}
                </button>

                <select
                  value={playSpeed}
                  onChange={(e) => {
                    stopPlayback();
                    setPlaySpeed(e.target.value as PlaySpeed);
                  }}
                  disabled={!enableChoropleth || monthOptions.length < 2}
                  style={{
                    width: "100%",
                    padding: 8,
                    fontSize: 12,
                    borderRadius: 8,
                    border: `1px solid ${UI.controlBorder}`,
                    background: UI.controlBg,
                    color: UI.controlText,
                  }}
                  title="Playback speed"
                >
                  <option value="slow">Speed: Slow</option>
                  <option value="normal">Speed: Normal</option>
                  <option value="fast">Speed: Fast</option>
                </select>
              </div>

              <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, fontSize: 12 }}>
                <input type="checkbox" checked={loopPlay} onChange={(e) => setLoopPlay(e.target.checked)} disabled={!enableChoropleth || monthOptions.length < 2} />
                Loop playback
              </label>

              <div style={{ marginTop: 8, fontSize: 12, color: UI.mutedText }}>
                Playback stops on map interaction (drag/zoom/click) or manual month change.
              </div>
            </div>

            {/* Legend */}
            <div style={{ marginTop: 2, fontSize: 12, opacity: 0.95 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Legend (quantiles)</div>

              <div style={{ display: "grid", gap: 4 }}>
                <div>
                  Metric: <span style={{ fontWeight: 600 }}>{def.label}</span>
                </div>
                <div>
                  Month: <span style={{ fontWeight: 600 }}>{metricMonth ? parseMonthLabel(metricMonth) : "-"}</span>
                </div>
                <div>
                  Range: <span style={{ fontWeight: 600 }}>{legend.min === null ? "-" : fmtMoney(legend.min)}</span> to{" "}
                  <span style={{ fontWeight: 600 }}>{legend.max === null ? "-" : fmtMoney(legend.max)}</span>
                </div>
                <div>
                  Data: <span style={{ fontWeight: 600 }}>{legend.count}</span> points, <span style={{ fontWeight: 600 }}>{legend.missing}</span> missing
                </div>
              </div>

              <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div
                    style={{
                      width: 18,
                      height: 10,
                      background: UI.missing,
                      borderRadius: 3,
                      border: "1px solid rgba(255,255,255,0.12)",
                    }}
                  />
                  <div style={{ fontSize: 12, opacity: 0.95 }}>Missing</div>
                </div>

                {bucketRanges.length ? (
                  bucketRanges.map((r, i) => {
                    const color = UI.palette[i] ?? UI.palette[UI.palette.length - 1];
                    const lo = Math.round(r[0]);
                    const hi = Math.round(r[1]);
                    const label = i === bucketRanges.length - 1 ? `${fmtMoney(lo)}+` : `${fmtMoney(lo)} – ${fmtMoney(hi)}`;
                    return (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div
                          style={{
                            width: 18,
                            height: 10,
                            background: color,
                            borderRadius: 3,
                            border: "1px solid rgba(255,255,255,0.12)",
                          }}
                        />
                        <div style={{ fontSize: 12, opacity: 0.95 }}>{label}</div>
                      </div>
                    );
                  })
                ) : (
                  <div style={{ fontSize: 12, color: UI.mutedText }}>Legend will appear once data is loaded.</div>
                )}
              </div>
            </div>

            {/* Search & jump */}
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${UI.panelBorder}` }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Search & jump</div>

              <div style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: 8, marginBottom: 8 }}>
                <select
                  value={searchScope}
                  onChange={(e) => setSearchScope(e.target.value as ChoroplethLevel)}
                  style={{
                    width: "100%",
                    padding: 8,
                    borderRadius: 8,
                    border: `1px solid ${UI.controlBorder}`,
                    background: UI.controlBg,
                    color: UI.controlText,
                    fontSize: 12,
                  }}
                  title="Search scope"
                >
                  <option value="localities">Localities</option>
                  <option value="micromarkets">Micromarkets</option>
                </select>

                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Type a name (e.g., Andheri, Powai, …)"
                  style={{
                    width: "100%",
                    padding: 8,
                    borderRadius: 8,
                    border: `1px solid ${UI.controlBorder}`,
                    background: UI.controlBg,
                    color: UI.controlText,
                    fontSize: 12,
                  }}
                />
              </div>

              {searchResults.length ? (
                <div style={{ border: `1px solid ${UI.panelBorder}`, borderRadius: 8, overflow: "hidden" }}>
                  {searchResults.map((r) => (
                    <button
                      key={`${searchScope}-${r.id}`}
                      onClick={() => jumpToByName(searchScope, r.name)}
                      style={{
                        width: "100%",
                        textAlign: "left",
                        padding: "8px 10px",
                        border: "none",
                        borderBottom: `1px solid ${UI.panelBorder}`,
                        background: "rgba(255,255,255,0.03)",
                        color: UI.panelText,
                        cursor: "pointer",
                        fontSize: 12,
                      }}
                      title="Jump to this geometry (pins A)"
                    >
                      {r.name}
                      {r.pincode ? <span style={{ marginLeft: 8, color: UI.mutedText }}>({r.pincode})</span> : null}
                    </button>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: UI.mutedText }}>
                  Tip: run <code>scripts/build_dims_public.py</code> if search list is empty.
                </div>
              )}

              <div style={{ marginTop: 8, fontSize: 12, color: UI.mutedText }}>
                Click pins A. <span style={{ fontWeight: 600, color: UI.panelText }}>Shift+Click</span> pins B (compare).
              </div>
            </div>

            {/* Compare: A/B */}
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${UI.panelBorder}` }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ fontWeight: 600 }}>Pinned compare</div>
                <button
                  onClick={() => {
                    stopPlayback();
                    setPinA(null);
                    setPinB(null);
                  }}
                  style={{
                    fontSize: 12,
                    padding: "6px 8px",
                    border: `1px solid ${UI.controlBorder}`,
                    borderRadius: 6,
                    background: UI.controlBg,
                    color: UI.controlText,
                    cursor: pinA || pinB ? "pointer" : "not-allowed",
                    opacity: pinA || pinB ? 1 : 0.55,
                  }}
                  disabled={!pinA && !pinB}
                  title="Clear pins"
                >
                  Clear
                </button>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
                {/* A */}
                <div style={{ border: `1px solid ${UI.panelBorder}`, borderRadius: 8, padding: 10, background: "rgba(255,255,255,0.03)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ width: 10, height: 10, borderRadius: 999, background: UI.pinA }} />
                    <div style={{ fontWeight: 600, fontSize: 12 }}>A</div>
                  </div>

                  {!pinA ? (
                    <div style={{ marginTop: 8, fontSize: 12, color: UI.mutedText }}>Click a micromarket/locality to pin A.</div>
                  ) : (
                    <div style={{ marginTop: 8, fontSize: 12, display: "grid", gap: 6 }}>
                      <div style={{ fontWeight: 600 }}>{pinA.displayName}</div>
                      <div>
                        Value: <span style={{ fontWeight: 600 }}>{typeof currentA?.v === "number" ? fmtMoney(currentA.v) : "-"}</span>{" "}
                        <span style={{ color: UI.mutedText }}>(n: {typeof currentA?.n === "number" ? currentA.n : "-"})</span>
                      </div>
                      <div>
                        Δ vs prev: <span style={{ fontWeight: 600 }}>{deltaA.abs}</span> <span style={{ color: UI.mutedText }}>({deltaA.pct})</span>
                      </div>

                      <div
                        style={{
                          width: sparkA.w,
                          height: sparkA.h,
                          border: `1px solid ${UI.controlBorder}`,
                          borderRadius: 8,
                          background: UI.controlBg,
                          overflow: "hidden",
                        }}
                        title="A time-series sparkline"
                      >
                        <svg width={sparkA.w} height={sparkA.h}>
                          <line x1="2" y1={sparkA.h - 6} x2={sparkA.w - 2} y2={sparkA.h - 6} stroke={UI.controlBorder} strokeWidth={1} />
                          {sparkA.has ? (
                            <path d={sparkA.d} fill="none" stroke={UI.pinA} strokeWidth={2} />
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

                {/* B */}
                <div style={{ border: `1px solid ${UI.panelBorder}`, borderRadius: 8, padding: 10, background: "rgba(255,255,255,0.03)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ width: 10, height: 10, borderRadius: 999, background: UI.pinB }} />
                    <div style={{ fontWeight: 600, fontSize: 12 }}>B</div>
                  </div>

                  {!pinB ? (
                    <div style={{ marginTop: 8, fontSize: 12, color: UI.mutedText }}>Shift+Click to pin B.</div>
                  ) : (
                    <div style={{ marginTop: 8, fontSize: 12, display: "grid", gap: 6 }}>
                      <div style={{ fontWeight: 600 }}>{pinB.displayName}</div>
                      <div>
                        Value: <span style={{ fontWeight: 600 }}>{typeof currentB?.v === "number" ? fmtMoney(currentB.v) : "-"}</span>{" "}
                        <span style={{ color: UI.mutedText }}>(n: {typeof currentB?.n === "number" ? currentB.n : "-"})</span>
                      </div>
                      <div>
                        Δ vs prev: <span style={{ fontWeight: 600 }}>{deltaB.abs}</span> <span style={{ color: UI.mutedText }}>({deltaB.pct})</span>
                      </div>

                      <div
                        style={{
                          width: sparkB.w,
                          height: sparkB.h,
                          border: `1px solid ${UI.controlBorder}`,
                          borderRadius: 8,
                          background: UI.controlBg,
                          overflow: "hidden",
                        }}
                        title="B time-series sparkline"
                      >
                        <svg width={sparkB.w} height={sparkB.h}>
                          <line x1="2" y1={sparkB.h - 6} x2={sparkB.w - 2} y2={sparkB.h - 6} stroke={UI.controlBorder} strokeWidth={1} />
                          {sparkB.has ? (
                            <path d={sparkB.d} fill="none" stroke={UI.pinB} strokeWidth={2} />
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
              </div>

              {/* A vs B delta */}
              <div style={{ marginTop: 10, fontSize: 12, color: UI.mutedText }}>
                {pinA && pinB && typeof currentA?.v === "number" && typeof currentB?.v === "number" ? (
                  <div>
                    A − B (current month): <span style={{ fontWeight: 600, color: UI.panelText }}>{fmtMoney(Math.round(currentA.v - currentB.v))}</span>
                  </div>
                ) : (
                  <div>Pin both A and B to see A − B delta.</div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Map controls */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Map controls</div>

          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 12, opacity: 0.9, marginBottom: 4 }}>Light preset</div>
            <select
              value={lightPreset}
              onChange={(e) => setLightPreset(e.target.value as LightPreset)}
              style={{
                width: "100%",
                padding: 8,
                borderRadius: 8,
                border: `1px solid ${UI.controlBorder}`,
                background: UI.controlBg,
                color: UI.controlText,
              }}
            >
              <option value="dawn">Dawn</option>
              <option value="day">Day</option>
              <option value="dusk">Dusk</option>
              <option value="night">Night</option>
            </select>
          </div>

          <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
            <input type="checkbox" checked={enable3D} onChange={(e) => setEnable3D(e.target.checked)} />
            3D view (pitch + terrain)
          </label>

          <button
            onClick={resetView}
            style={{
              width: "100%",
              fontSize: 12,
              padding: "10px 12px",
              border: `1px solid ${UI.controlBorder}`,
              borderRadius: 8,
              background: UI.controlBg,
              color: UI.controlText,
              cursor: "pointer",
            }}
            title="Reset view (R)"
          >
            Reset view (R)
          </button>
        </div>

        {/* Inspect target */}
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Inspect target</div>
          <select
            value={inspectTarget}
            onChange={(e) => {
              stopPlayback();
              setHoverInfo(null);
              setClickInfo(null);
              setInspectTarget(e.target.value as InspectTarget);
            }}
            style={{
              width: "100%",
              padding: 8,
              borderRadius: 8,
              border: `1px solid ${UI.controlBorder}`,
              background: UI.controlBg,
              color: UI.controlText,
            }}
          >
            <option value="localities">Localities (polygons)</option>
            <option value="micromarkets">Micromarkets (polygons)</option>
            <option value="projects">Projects (points)</option>
            <option value="roads">Roads (lines)</option>
            <option value="city">City (outline)</option>
          </select>
        </div>

        {/* Layer visibility */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Layer visibility</div>

          <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
            <input type="checkbox" checked={showLocalities} onChange={(e) => setShowLocalities(e.target.checked)} />
            Localities
          </label>

          <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
            <input type="checkbox" checked={showMicromarkets} onChange={(e) => setShowMicromarkets(e.target.checked)} />
            Micromarkets
          </label>

          <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
            <input type="checkbox" checked={showProjects} onChange={(e) => setShowProjects(e.target.checked)} />
            Projects
          </label>

          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={showRoads} onChange={(e) => setShowRoads(e.target.checked)} />
            Roads
          </label>
        </div>

        {/* Hover / Click debug */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600 }}>Hover</div>
          {hoverInfo ? <pre style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{safeJson(hoverInfo)}</pre> : <div style={{ fontSize: 12, color: UI.mutedText }}>Hover a feature on the map…</div>}
        </div>

        <div>
          <div style={{ fontWeight: 600 }}>Click (Pinned)</div>
          {clickInfo ? <pre style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{safeJson(clickInfo)}</pre> : <div style={{ fontSize: 12, color: UI.mutedText }}>Click a feature to pin its properties…</div>}
        </div>

        <hr style={{ margin: "12px 0", borderColor: UI.panelBorder }} />

        <div style={{ fontSize: 12, color: UI.mutedText }}>
          <div style={{ fontWeight: 600, marginBottom: 6, color: UI.panelText }}>Notes</div>
          <ul style={{ margin: "6px 0 0 18px" }}>
            <li>Quantile legend is computed from the full month distribution (not only viewport).</li>
            <li>Feature-state is applied only to visible polygons and cached per (metric, level, month).</li>
            <li>Shift+Click pins B for compare.</li>
            <li>URL is shareable: metric/level/month/pins/light/3D are encoded in query params.</li>
            <li>Exports: Press P for PNG, J for State JSON.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

function targetToLayerId(target: InspectTarget) {
  switch (target) {
    case "localities":
      return HIT_LAYERS.localities;
    case "micromarkets":
      return HIT_LAYERS.micromarkets;
    case "projects":
      return HIT_LAYERS.projects;
    case "roads":
      return HIT_LAYERS.roads;
    case "city":
      return HIT_LAYERS.city;
  }
}

function setLayerVisibility(map: Map, layerId: string, visible: boolean) {
  if (!map.getLayer(layerId)) return;
  map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
}