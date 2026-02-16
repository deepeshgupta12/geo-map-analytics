"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import mapboxgl, { Map, MapMouseEvent } from "mapbox-gl";
import { TILESETS } from "@/config/tilesets";

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

/**
 * V1 Choropleth types
 * - micromarket data is keyed by micromarket ID (we join via polygon feature.id)
 * - locality data is keyed by LocalityName (we join via polygon properties.LocalityName)
 */
type ChoroplethLevel = "micromarkets" | "localities";

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
  joinKey: string;
  displayName: string;
  featureId: unknown;
  lngLat: { lng: number; lat: number };
};

const DEFAULT_CENTER: [number, number] = [72.8777, 19.076]; // Mumbai
const DEFAULT_ZOOM = 10.5;

// Invisible “hit” layers for reliable picking
const HIT_LAYERS = {
  city: "city-hit",
  micromarkets: "micromarkets-hit",
  localities: "localities-hit",
  roads: "roads-hit",
  projects: "projects-hit",
} as const;

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

export default function MapView() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);

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

  // V0 controls
  const [lightPreset, setLightPreset] = useState<LightPreset>("day");
  const [enable3D, setEnable3D] = useState(false);

  // V1 controls
  const [enableChoropleth, setEnableChoropleth] = useState(true);
  const [choroplethLevel, setChoroplethLevel] = useState<ChoroplethLevel>("micromarkets");
  const [metricMonth, setMetricMonth] = useState<string>("");

  // V1 loaded metrics
  const [mmDoc, setMmDoc] = useState<MetricsDoc | null>(null);
  const [locDoc, setLocDoc] = useState<MetricsDoc | null>(null);

  // Legend stats
  const [legend, setLegend] = useState<{
    min: number | null;
    max: number | null;
    count: number;
    missing: number;
  }>({ min: null, max: null, count: 0, missing: 0 });

  // V2 pinned selection (only for micromarkets/localities polygons)
  const [pinned, setPinned] = useState<PinnedSelection | null>(null);

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

  // -----------------------------
  // Load metrics JSON (V1)
  // -----------------------------
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [mmRes, locRes] = await Promise.all([
          fetch("/metrics/asking_psf_micromarket.json", { cache: "no-store" }),
          fetch("/metrics/asking_psf_localityname.json", { cache: "no-store" }),
        ]);

        if (!mmRes.ok) throw new Error(`Failed micromarket metrics: ${mmRes.status}`);
        if (!locRes.ok) throw new Error(`Failed locality metrics: ${locRes.status}`);

        const mm = (await mmRes.json()) as MetricsDoc;
        const loc = (await locRes.json()) as MetricsDoc;

        if (cancelled) return;

        setMmDoc(mm);
        setLocDoc(loc);

        const mmLatest = mm.months?.[mm.months.length - 1];
        const locLatest = loc.months?.[loc.months.length - 1];

        setMetricMonth((prev) => {
          if (prev) return prev;
          return mmLatest || locLatest || "";
        });
      } catch (e) {
        console.error("Failed to load metrics JSON:", e);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

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
      config: { basemap: { lightPreset } },
    });

    mapRef.current = map;
    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "top-right");

    map.on("load", () => {
      // Sources
      map.addSource("city-src", { type: "vector", url: vectorSources.city });
      map.addSource("micromarkets-src", { type: "vector", url: vectorSources.micromarkets });
      map.addSource("localities-src", { type: "vector", url: vectorSources.localities });
      map.addSource("roads-src", { type: "vector", url: vectorSources.roads });
      map.addSource("projects-src", { type: "vector", url: vectorSources.projects });

      // Visible layers
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

      // -----------------------------
      // HIT layers (transparent, on top)
      // -----------------------------
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

      // Inspector handlers
      const onMove = (e: MapMouseEvent) => {
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

        const f = features[0];
        const props = (f.properties ?? {}) as Record<string, unknown>;
        setHoverInfo({
          layerId: f.layer.id,
          sourceLayer: (f.layer as any)["source-layer"] ?? "",
          featureId: (f as any).id ?? null,
          propertyKeys: Object.keys(props),
          properties: props,
          lngLat: { lng: e.lngLat.lng, lat: e.lngLat.lat },
        });
      };

      const onClick = (e: MapMouseEvent) => {
        const m = mapRef.current;
        if (!m) return;

        const layer = targetToLayerId(inspectTargetRef.current);
        const features = m.queryRenderedFeatures(e.point, { layers: [layer] });

        if (!features.length) {
          setClickInfo(null);
          return;
        }

        const f = features[0];
        const props = (f.properties ?? {}) as Record<string, unknown>;

        setClickInfo({
          layerId: f.layer.id,
          sourceLayer: (f.layer as any)["source-layer"] ?? "",
          featureId: (f as any).id ?? null,
          propertyKeys: Object.keys(props),
          properties: props,
          lngLat: { lng: e.lngLat.lng, lat: e.lngLat.lat },
        });

        // V2: Pinned selection only for polygon levels
        const fid = (f as any).id ?? null;

        if (layer === HIT_LAYERS.micromarkets && fid !== null) {
          const name =
            getStrProp(props, "MicroMarketName") ||
            getStrProp(props, "MicromarketName") ||
            getStrProp(props, "Micromarket") ||
            `Micromarket ${String(fid)}`;

          setPinned({
            level: "micromarkets",
            joinKey: String(fid),
            displayName: name,
            featureId: fid,
            lngLat: { lng: e.lngLat.lng, lat: e.lngLat.lat },
          });
        } else if (layer === HIT_LAYERS.localities && fid !== null) {
          const lname = getStrProp(props, "LocalityName") || "";
          if (lname) {
            setPinned({
              level: "localities",
              joinKey: lname,
              displayName: lname,
              featureId: fid,
              lngLat: { lng: e.lngLat.lng, lat: e.lngLat.lat },
            });
          }
        }
      };

      map.on("mousemove", onMove);
      map.on("click", onClick);
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, vectorSources]);

  // -----------------------------
  // Layer visibility toggles (+ keep hit layers in sync)
  // -----------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Localities
    setLayerVisibility(map, "localities-fill", showLocalities);
    setLayerVisibility(map, "localities-outline", showLocalities);
    setLayerVisibility(map, HIT_LAYERS.localities, showLocalities);

    // Micromarkets
    setLayerVisibility(map, "micromarkets-fill", showMicromarkets);
    setLayerVisibility(map, "micromarkets-outline", showMicromarkets);
    setLayerVisibility(map, HIT_LAYERS.micromarkets, showMicromarkets);

    // Projects
    setLayerVisibility(map, "projects-circle", showProjects);
    setLayerVisibility(map, HIT_LAYERS.projects, showProjects);

    // Roads
    setLayerVisibility(map, "roads-line", showRoads);
    setLayerVisibility(map, HIT_LAYERS.roads, showRoads);

    // City hit always on (city outline always on)
    setLayerVisibility(map, HIT_LAYERS.city, true);
  }, [showLocalities, showMicromarkets, showProjects, showRoads]);

  // -----------------------------
  // Light preset runtime
  // -----------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    try {
      map.setConfigProperty("basemap", "lightPreset", lightPreset);
    } catch (e) {
      console.warn("setConfigProperty failed (safe to ignore during init):", e);
    }
  }, [lightPreset]);

  // -----------------------------
  // 2D/3D toggle
  // -----------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (enable3D) {
      const demSourceId = "mapbox-dem";
      if (!map.getSource(demSourceId)) {
        map.addSource(demSourceId, {
          type: "raster-dem",
          url: "mapbox://mapbox.mapbox-terrain-dem-v1",
          tileSize: 512,
          maxzoom: 14,
        });
      }

      try {
        map.setTerrain({ source: demSourceId, exaggeration: 1.3 });
      } catch (e) {
        console.warn("setTerrain failed:", e);
      }

      map.easeTo({ pitch: 60, bearing: -20, duration: 600 });
    } else {
      try {
        map.setTerrain(null as any);
      } catch {
        // ignore
      }
      map.easeTo({ pitch: 0, bearing: 0, duration: 600 });
    }
  }, [enable3D]);

  // -----------------------------
  // V1 Choropleth: paint config
  // -----------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const isMm = choroplethLevel === "micromarkets";
    const fillLayer = isMm ? "micromarkets-fill" : "localities-fill";

    if (!map.getLayer(fillLayer)) return;

    if (!enableChoropleth) {
      map.setPaintProperty(fillLayer, "fill-color", "#888888");
      map.setPaintProperty(fillLayer, "fill-opacity", isMm ? 0.08 : 0.06);
      return;
    }

    const valueExpr: any = ["coalesce", ["feature-state", "v"], -1];

    map.setPaintProperty(fillLayer, "fill-color", [
      "case",
      ["<=", valueExpr, -1],
      "#9CA3AF",
      [
        "interpolate",
        ["linear"],
        valueExpr,
        5000,
        "#E0F2FE",
        15000,
        "#93C5FD",
        25000,
        "#60A5FA",
        35000,
        "#3B82F6",
        50000,
        "#1D4ED8",
      ],
    ]);

    map.setPaintProperty(fillLayer, "fill-opacity", [
      "case",
      ["<=", valueExpr, -1],
      0.04,
      isMm ? 0.28 : 0.24,
    ]);
  }, [enableChoropleth, choroplethLevel]);

  // -----------------------------
  // V1 Choropleth: apply feature-state for visible features
  // -----------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (!enableChoropleth) {
      setLegend({ min: null, max: null, count: 0, missing: 0 });
      return;
    }

    if (!metricMonth) return;

    const isMm = choroplethLevel === "micromarkets";
    const doc = isMm ? mmDoc : locDoc;

    if (!doc) return;

    const byMonth = doc.byMonth?.[metricMonth];
    if (!byMonth) return;

    const sourceId = isMm ? "micromarkets-src" : "localities-src";
    const sourceLayer = isMm ? TILESETS.micromarkets.sourceLayer : TILESETS.localities.sourceLayer;
    const fillLayer = isMm ? "micromarkets-fill" : "localities-fill";

    if (!map.getSource(sourceId) || !map.getLayer(fillLayer)) return;

    const computeLegendAndApply = () => {
      const features = map.queryRenderedFeatures({ layers: [fillLayer] }) as any[];

      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      let count = 0;
      let missing = 0;

      for (const f of features) {
        const fid = f?.id;
        if (fid === undefined || fid === null) continue;

        let key = "";
        if (isMm) {
          key = String(fid);
        } else {
          const lname = f?.properties?.LocalityName;
          key = typeof lname === "string" ? lname : "";
        }

        const bucket = key ? byMonth[key] : undefined;
        const v = bucket?.v;

        if (typeof v === "number" && Number.isFinite(v)) {
          count += 1;
          min = Math.min(min, v);
          max = Math.max(max, v);
          map.setFeatureState({ source: sourceId, sourceLayer, id: fid }, { v, n: bucket?.n ?? null });
        } else {
          missing += 1;
          map.setFeatureState({ source: sourceId, sourceLayer, id: fid }, { v: null, n: null });
        }
      }

      setLegend({
        min: count > 0 ? min : null,
        max: count > 0 ? max : null,
        count,
        missing,
      });
    };

    computeLegendAndApply();

    const onIdle = () => computeLegendAndApply();
    map.on("idle", onIdle);
    return () => {
      map.off("idle", onIdle);
    };
  }, [enableChoropleth, choroplethLevel, metricMonth, mmDoc, locDoc]);

  // Ensure polygon layer visible when choropleth enabled
  useEffect(() => {
    if (!enableChoropleth) return;
    if (choroplethLevel === "micromarkets") {
      if (!showMicromarkets) setShowMicromarkets(true);
    } else {
      if (!showLocalities) setShowLocalities(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enableChoropleth, choroplethLevel]);

  // Month options
  const monthOptions = useMemo(() => {
    const isMm = choroplethLevel === "micromarkets";
    const doc = isMm ? mmDoc : locDoc;
    return doc?.months ?? [];
  }, [choroplethLevel, mmDoc, locDoc]);

  useEffect(() => {
    if (!monthOptions.length) return;
    if (!metricMonth || !monthOptions.includes(metricMonth)) {
      setMetricMonth(monthOptions[monthOptions.length - 1]);
    }
  }, [monthOptions, metricMonth]);

  // -----------------------------
  // V2 pinned details computed values
  // -----------------------------
  const pinnedDoc = useMemo(() => {
    if (!pinned) return null;
    return pinned.level === "micromarkets" ? mmDoc : locDoc;
  }, [pinned, mmDoc, locDoc]);

  const pinnedCurrent = useMemo(() => {
    if (!pinned || !pinnedDoc || !metricMonth) return null;
    const monthMap = pinnedDoc.byMonth?.[metricMonth];
    if (!monthMap) return null;
    return monthMap[pinned.joinKey] ?? null;
  }, [pinned, pinnedDoc, metricMonth]);

  const pinnedSeries = useMemo(() => {
    if (!pinned || !pinnedDoc) return [];
    const months = pinnedDoc.months ?? [];
    const rows = months.map((m) => {
      const bucket = pinnedDoc.byMonth?.[m]?.[pinned.joinKey];
      return {
        month: m,
        v: typeof bucket?.v === "number" ? bucket.v : null,
        n: typeof bucket?.n === "number" ? bucket.n : null,
      };
    });
    return rows;
  }, [pinned, pinnedDoc]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 420px", height: "100vh" }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />

      <div style={{ borderLeft: "1px solid #e5e7eb", padding: 12, overflow: "auto" }}>
        <h3 style={{ margin: "0 0 8px 0" }}>Inspector</h3>

        {/* V1 Controls */}
        <div style={{ marginBottom: 12, padding: 10, border: "1px solid #e5e7eb", borderRadius: 8 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>V1 Choropleth</div>

          <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
            <input
              type="checkbox"
              checked={enableChoropleth}
              onChange={(e) => setEnableChoropleth(e.target.checked)}
            />
            Enable choropleth (asking_psf)
          </label>

          <div style={{ display: "grid", gap: 10 }}>
            <div>
              <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>Level</div>
              <select
                value={choroplethLevel}
                onChange={(e) => setChoroplethLevel(e.target.value as ChoroplethLevel)}
                style={{ width: "100%", padding: 8 }}
                disabled={!enableChoropleth}
              >
                <option value="micromarkets">Micromarkets (join via featureId)</option>
                <option value="localities">Localities (join via LocalityName)</option>
              </select>
            </div>

            <div>
              <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>Month</div>
              <select
                value={metricMonth}
                onChange={(e) => setMetricMonth(e.target.value)}
                style={{ width: "100%", padding: 8 }}
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
          </div>

          {/* Legend */}
          <div style={{ marginTop: 10, fontSize: 12, opacity: 0.9 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Legend</div>
            <div style={{ display: "grid", gap: 4 }}>
              <div>
                Month: <span style={{ fontWeight: 600 }}>{metricMonth ? parseMonthLabel(metricMonth) : "-"}</span>
              </div>
              <div>
                Range (psf):{" "}
                <span style={{ fontWeight: 600 }}>{legend.min === null ? "-" : fmtMoney(legend.min)} </span>
                to <span style={{ fontWeight: 600 }}>{legend.max === null ? "-" : fmtMoney(legend.max)}</span>
              </div>
              <div>
                Viewport: <span style={{ fontWeight: 600 }}>{legend.count}</span> colored,{" "}
                <span style={{ fontWeight: 600 }}>{legend.missing}</span> missing
              </div>
            </div>

            <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
              {[
                { label: "Missing", color: "#9CA3AF" },
                { label: "Low", color: "#E0F2FE" },
                { label: "", color: "#93C5FD" },
                { label: "", color: "#60A5FA" },
                { label: "", color: "#3B82F6" },
                { label: "High", color: "#1D4ED8" },
              ].map((x, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div
                    style={{
                      width: 18,
                      height: 10,
                      background: x.color,
                      borderRadius: 3,
                      border: "1px solid #e5e7eb",
                    }}
                  />
                  <div style={{ fontSize: 12, opacity: 0.9 }}>{x.label || "\u00A0"}</div>
                </div>
              ))}
            </div>
          </div>

          {/* V2 Pinned details */}
          <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid #e5e7eb" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <div style={{ fontWeight: 600 }}>Pinned (click a Micromarket/Locality polygon)</div>
              <button
                onClick={() => setPinned(null)}
                style={{
                  fontSize: 12,
                  padding: "6px 8px",
                  border: "1px solid #e5e7eb",
                  borderRadius: 6,
                  background: "white",
                  cursor: "pointer",
                }}
                disabled={!pinned}
                title={!pinned ? "Nothing pinned" : "Clear pinned selection"}
              >
                Clear
              </button>
            </div>

            {!pinned ? (
              <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>
                Tip: set Inspect target to Micromarkets or Localities, then click a polygon.
              </div>
            ) : (
              <div style={{ marginTop: 8, fontSize: 12, opacity: 0.92, display: "grid", gap: 6 }}>
                <div>
                  Level: <span style={{ fontWeight: 600 }}>{pinned.level}</span>
                </div>
                <div>
                  Name: <span style={{ fontWeight: 600 }}>{pinned.displayName}</span>
                </div>
                <div>
                  Join key: <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{pinned.joinKey}</span>
                </div>
                <div>
                  Month value (psf):{" "}
                  <span style={{ fontWeight: 600 }}>
                    {pinnedCurrent?.v !== undefined && typeof pinnedCurrent?.v === "number" ? fmtMoney(pinnedCurrent.v) : "-"}
                  </span>
                  {"  "}
                  <span style={{ opacity: 0.85 }}>
                    (n: {pinnedCurrent?.n !== undefined && typeof pinnedCurrent?.n === "number" ? pinnedCurrent.n : "-"})
                  </span>
                </div>

                <div style={{ marginTop: 6, fontWeight: 600 }}>Time series</div>
                <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden" }}>
                  <div style={{ maxHeight: 220, overflow: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                      <thead>
                        <tr style={{ position: "sticky", top: 0, background: "white" }}>
                          <th style={{ textAlign: "left", padding: "8px 10px", borderBottom: "1px solid #e5e7eb" }}>Month</th>
                          <th style={{ textAlign: "right", padding: "8px 10px", borderBottom: "1px solid #e5e7eb" }}>psf</th>
                          <th style={{ textAlign: "right", padding: "8px 10px", borderBottom: "1px solid #e5e7eb" }}>n</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pinnedSeries.map((r) => {
                          const isActive = r.month === metricMonth;
                          return (
                            <tr key={r.month} style={{ background: isActive ? "#F9FAFB" : "transparent" }}>
                              <td style={{ padding: "8px 10px", borderBottom: "1px solid #f3f4f6" }}>
                                {parseMonthLabel(r.month)}
                              </td>
                              <td style={{ padding: "8px 10px", textAlign: "right", borderBottom: "1px solid #f3f4f6" }}>
                                {typeof r.v === "number" ? fmtMoney(r.v) : "-"}
                              </td>
                              <td style={{ padding: "8px 10px", textAlign: "right", borderBottom: "1px solid #f3f4f6" }}>
                                {typeof r.n === "number" ? r.n : "-"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                {pinnedDoc?.notes?.length ? (
                  <div style={{ marginTop: 6, fontSize: 12, opacity: 0.85 }}>
                    Notes:
                    <ul style={{ margin: "6px 0 0 18px" }}>
                      {pinnedDoc.notes.map((n, idx) => (
                        <li key={idx}>{n}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>

        {/* V0 Controls */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Map controls</div>

          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>Light preset</div>
            <select
              value={lightPreset}
              onChange={(e) => setLightPreset(e.target.value as LightPreset)}
              style={{ width: "100%", padding: 8 }}
            >
              <option value="dawn">Dawn</option>
              <option value="day">Day</option>
              <option value="dusk">Dusk</option>
              <option value="night">Night</option>
            </select>
          </div>

          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={enable3D} onChange={(e) => setEnable3D(e.target.checked)} />
            3D view (pitch + terrain)
          </label>
        </div>

        <div style={{ marginBottom: 10 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Inspect target</div>
          <select
            value={inspectTarget}
            onChange={(e) => {
              setHoverInfo(null);
              setClickInfo(null);
              setInspectTarget(e.target.value as InspectTarget);
            }}
            style={{ width: "100%", padding: 8 }}
          >
            <option value="localities">Localities (polygons)</option>
            <option value="micromarkets">Micromarkets (polygons)</option>
            <option value="projects">Projects (points)</option>
            <option value="roads">Roads (lines)</option>
            <option value="city">City (outline)</option>
          </select>
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Layer visibility</div>

          <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
            <input type="checkbox" checked={showLocalities} onChange={(e) => setShowLocalities(e.target.checked)} />
            Localities
          </label>

          <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
            <input
              type="checkbox"
              checked={showMicromarkets}
              onChange={(e) => setShowMicromarkets(e.target.checked)}
            />
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

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600 }}>Hover</div>
          {hoverInfo ? (
            <pre style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{safeJson(hoverInfo)}</pre>
          ) : (
            <div style={{ fontSize: 12, opacity: 0.7 }}>Hover a feature on the map…</div>
          )}
        </div>

        <div>
          <div style={{ fontWeight: 600 }}>Click (Pinned)</div>
          {clickInfo ? (
            <pre style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{safeJson(clickInfo)}</pre>
          ) : (
            <div style={{ fontSize: 12, opacity: 0.7 }}>Click a feature to pin its properties…</div>
          )}
        </div>

        <hr style={{ margin: "12px 0" }} />

        <div style={{ fontSize: 12, opacity: 0.85 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Notes</div>
          <div>
            Choropleth join keys:
            <ul style={{ margin: "6px 0 0 18px" }}>
              <li>Micromarkets: join by polygon <code>featureId</code> (matches JSON keys)</li>
              <li>Localities: join by <code>properties.LocalityName</code> (matches JSON keys)</li>
              <li>Projects: (later) can support point metrics similarly</li>
            </ul>
          </div>
          <div style={{ marginTop: 8 }}>
            Inspector hit-testing uses transparent hit layers (thicker lines / larger points) so hover/click works reliably.
          </div>
        </div>
      </div>
    </div>
  );
}

function targetToLayerId(target: InspectTarget) {
  // Use HIT layers so querying is reliable
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