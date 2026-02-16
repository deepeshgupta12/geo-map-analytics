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

const DEFAULT_CENTER: [number, number] = [72.8777, 19.0760]; // Mumbai
const DEFAULT_ZOOM = 10.5;

function safeJson(v: unknown) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
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

  useEffect(() => {
    if (!containerRef.current) return;
    if (!token) {
      console.error("Missing NEXT_PUBLIC_MAPBOX_TOKEN in .env.local");
      return;
    }
    if (mapRef.current) return;

    mapboxgl.accessToken = token;

    // Use Standard style + config so the initial light preset is applied at creation.
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
  }, [token, vectorSources]); // do not include lightPreset here; we update it via effect below

  // Apply layer visibility when toggles change
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

  // Apply light preset at runtime (Standard style config)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    try {
      map.setConfigProperty("basemap", "lightPreset", lightPreset);
    } catch (e) {
      // If style isn't ready yet, this can throw; it's safe to ignore.
      // The initial config passed at map creation already set the preset.
      console.warn("setConfigProperty failed (safe to ignore during init):", e);
    }
  }, [lightPreset]);

  // Apply 2D/3D toggle (pitch + optional terrain)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (enable3D) {
      // Add DEM source once (Mapbox terrain DEM)
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

      map.easeTo({
        pitch: 60,
        bearing: -20,
        duration: 600,
      });
    } else {
      try {
        map.setTerrain(null as any);
      } catch {
        // ignore if terrain isn't supported/active
      }
      map.easeTo({
        pitch: 0,
        bearing: 0,
        duration: 600,
      });
    }
  }, [enable3D]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 420px", height: "100vh" }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />

      <div style={{ borderLeft: "1px solid #e5e7eb", padding: 12, overflow: "auto" }}>
        <h3 style={{ margin: "0 0 8px 0" }}>Inspector</h3>

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
          <div style={{ fontWeight: 600, marginBottom: 6 }}>V0 goal right now</div>
          <div>
            Confirm join keys by inspecting properties:
            <ul style={{ margin: "6px 0 0 18px" }}>
              <li>Micromarkets: join via polygon featureId (works)</li>
              <li>Localities: needs lookup via (CityID + LocalityName) or tileset rebuild</li>
              <li>Projects: IDs present (works)</li>
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