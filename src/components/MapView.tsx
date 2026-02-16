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

const DEFAULT_CENTER: [number, number] = [72.8777, 19.076]; // Mumbai
const DEFAULT_ZOOM = 10.5;

function safeJson(v: unknown) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function fmtMoney(v: number) {
  // price psf; keep simple
  if (!Number.isFinite(v)) return "-";
  return v.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

function parseMonthLabel(yyyyMm01: string) {
  // "2024-07-01" -> "Jul 2024"
  const d = new Date(yyyyMm01 + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return yyyyMm01;
  return d.toLocaleString("en-US", { month: "short", year: "numeric" });
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(Math.max(n, lo), hi);
}

export default function MapView() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);

  const [hoverInfo, setHoverInfo] = useState<PickInfo | null>(null);
  const [clickInfo, setClickInfo] = useState<PickInfo | null>(null);

  const [inspectTarget, setInspectTarget] = useState<InspectTarget>("localities");
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

  // Legend stats (computed per month + level)
  const [legend, setLegend] = useState<{
    min: number | null;
    max: number | null;
    count: number;
    missing: number;
  }>({ min: null, max: null, count: 0, missing: 0 });

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

        // Default month: latest available intersection (prefer micromarket months)
        const mmLatest = mm.months?.[mm.months.length - 1];
        const locLatest = loc.months?.[loc.months.length - 1];

        // If already selected, keep it
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
  // Map init (unchanged)
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
      config: {
        basemap: {
          lightPreset,
        },
      },
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

      // Layers
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
        paint: {
          "fill-opacity": 0.08,
        },
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
        paint: {
          "fill-opacity": 0.06,
        },
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

      // Inspector handlers
      const onMove = (e: MapMouseEvent) => {
        const m = mapRef.current;
        if (!m) return;

        const layer = targetToLayerId(inspectTarget);
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

        const layer = targetToLayerId(inspectTarget);
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
      };

      map.on("mousemove", onMove);
      map.on("click", onClick);
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, vectorSources]); // keep init stable

  // -----------------------------
  // Layer visibility toggles
  // -----------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    setLayerVisibility(map, "localities-fill", showLocalities);
    setLayerVisibility(map, "localities-outline", showLocalities);

    setLayerVisibility(map, "micromarkets-fill", showMicromarkets);
    setLayerVisibility(map, "micromarkets-outline", showMicromarkets);

    setLayerVisibility(map, "projects-circle", showProjects);
    setLayerVisibility(map, "roads-line", showRoads);
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
  // V1 Choropleth: paint config (once per relevant change)
  // -----------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const isMm = choroplethLevel === "micromarkets";
    const fillLayer = isMm ? "micromarkets-fill" : "localities-fill";

    if (!map.getLayer(fillLayer)) return;

    // If choropleth disabled, revert to subtle base
    if (!enableChoropleth) {
      map.setPaintProperty(fillLayer, "fill-color", "#888888");
      map.setPaintProperty(fillLayer, "fill-opacity", isMm ? 0.08 : 0.06);
      return;
    }

    // Use feature-state "v" for value. Missing => -1
    // Color ramp: simple interpolate. (Mapbox default colors are fine for V1.)
    const valueExpr: any = ["coalesce", ["feature-state", "v"], -1];

    map.setPaintProperty(fillLayer, "fill-color", [
      "case",
      ["<=", valueExpr, -1],
      "#9CA3AF", // missing data gray
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
  // - We apply on: month change, level change, enable/disable, and map idle.
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

    // Track legend stats only for current viewport features
    const computeLegendAndApply = () => {
      // Query visible features from fill layer
      const features = map.queryRenderedFeatures({ layers: [fillLayer] }) as any[];

      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      let count = 0;
      let missing = 0;

      // Optional: reduce work if huge.
      // Still fine for Mumbai-level polygons.
      for (const f of features) {
        const fid = f?.id;
        if (fid === undefined || fid === null) continue;

        // Join key
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

    // Apply immediately + on idle to refresh after panning/zooming
    computeLegendAndApply();

    const onIdle = () => {
      // During continuous interactions, "idle" is lower frequency and stable.
      computeLegendAndApply();
    };

    map.on("idle", onIdle);
    return () => {
      map.off("idle", onIdle);
    };
  }, [enableChoropleth, choroplethLevel, metricMonth, mmDoc, locDoc]);

  // -----------------------------
  // When level toggles, ensure that corresponding polygon layers are visible
  // (helps avoid confusion when choropleth enabled)
  // -----------------------------
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
  // Month options: prefer whichever level is selected
  // -----------------------------
  const monthOptions = useMemo(() => {
    const isMm = choroplethLevel === "micromarkets";
    const doc = isMm ? mmDoc : locDoc;
    return doc?.months ?? [];
  }, [choroplethLevel, mmDoc, locDoc]);

  // If month not in options (e.g., switching level), choose latest available
  useEffect(() => {
    if (!monthOptions.length) return;
    if (!metricMonth || !monthOptions.includes(metricMonth)) {
      setMetricMonth(monthOptions[monthOptions.length - 1]);
    }
  }, [monthOptions, metricMonth]);

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
                <span style={{ fontWeight: 600 }}>
                  {legend.min === null ? "-" : fmtMoney(legend.min)}{" "}
                </span>
                to{" "}
                <span style={{ fontWeight: 600 }}>
                  {legend.max === null ? "-" : fmtMoney(legend.max)}
                </span>
              </div>
              <div>
                Viewport:{" "}
                <span style={{ fontWeight: 600 }}>{legend.count}</span> colored,{" "}
                <span style={{ fontWeight: 600 }}>{legend.missing}</span> missing
              </div>
            </div>

            <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
              {/* tiny swatches */}
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
            <input
              type="checkbox"
              checked={showLocalities}
              onChange={(e) => setShowLocalities(e.target.checked)}
            />
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
            <input
              type="checkbox"
              checked={showProjects}
              onChange={(e) => setShowProjects(e.target.checked)}
            />
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
          <div style={{ fontWeight: 600, marginBottom: 6 }}>V1 goal right now</div>
          <div>
            Choropleth join keys:
            <ul style={{ margin: "6px 0 0 18px" }}>
              <li>Micromarkets: join by polygon <code>featureId</code> (matches JSON keys)</li>
              <li>Localities: join by <code>properties.LocalityName</code> (matches JSON keys)</li>
              <li>Projects: (later) can support point metrics similarly</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

function targetToLayerId(target: InspectTarget) {
  switch (target) {
    case "localities":
      return "localities-fill";
    case "micromarkets":
      return "micromarkets-fill";
    case "projects":
      return "projects-circle";
    case "roads":
      return "roads-line";
    case "city":
      return "city-outline";
  }
}

function setLayerVisibility(map: Map, layerId: string, visible: boolean) {
  if (!map.getLayer(layerId)) return;
  map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
}