"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import mapboxgl, { Map, MapMouseEvent } from "mapbox-gl";
import { TILESETS } from "@/config/tilesets";

type PickInfo = {
  layerId: string;
  sourceLayer: string;
  properties: Record<string, unknown>;
  lngLat: { lng: number; lat: number };
};

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

  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

  const vectorSources = useMemo(() => {
    // Mapbox vector tileset URL format
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

    // Prevent double init in dev hot-reload
    if (mapRef.current) return;

    mapboxgl.accessToken = token;

    const map = new mapboxgl.Map({
      container: containerRef.current,
      // Mapbox Standard style (latest direction)
      style: "mapbox://styles/mapbox/standard",
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      pitch: 0,
      bearing: 0,
      antialias: true,
    });

    mapRef.current = map;

    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "top-right");

    map.on("load", () => {
      // --- Sources ---
      map.addSource("city-src", { type: "vector", url: vectorSources.city });
      map.addSource("micromarkets-src", { type: "vector", url: vectorSources.micromarkets });
      map.addSource("localities-src", { type: "vector", url: vectorSources.localities });
      map.addSource("roads-src", { type: "vector", url: vectorSources.roads });
      map.addSource("projects-src", { type: "vector", url: vectorSources.projects });

      // --- Layers (start with simple outlines/fills so we can inspect features) ---

      // City outline
      map.addLayer({
        id: "city-outline",
        type: "line",
        source: "city-src",
        "source-layer": TILESETS.city.sourceLayer,
        paint: { "line-width": 2 },
      });

      // Micromarkets fill (light) + outline
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

      // Localities fill (lighter) + outline
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

      // Roads
      map.addLayer({
        id: "roads-line",
        type: "line",
        source: "roads-src",
        "source-layer": TILESETS.roads.sourceLayer,
        paint: { "line-width": 1.2 },
      });

      // Projects
      map.addLayer({
        id: "projects-circle",
        type: "circle",
        source: "projects-src",
        "source-layer": TILESETS.projects.sourceLayer,
        paint: {
          "circle-radius": 3,
          "circle-opacity": 0.75,
        },
      });

      // --- Hover and Click inspection ---
      const inspectLayerIds = [
        "localities-fill",
        "micromarkets-fill",
        "projects-circle",
        "roads-line",
        "city-outline",
      ];

      const onMove = (e: MapMouseEvent) => {
        const features = map.queryRenderedFeatures(e.point, { layers: inspectLayerIds });
        if (!features.length) {
          map.getCanvas().style.cursor = "";
          setHoverInfo(null);
          return;
        }
        map.getCanvas().style.cursor = "pointer";

        const f = features[0];
        setHoverInfo({
          layerId: f.layer.id,
          sourceLayer: (f.layer as any)["source-layer"] ?? "",
          properties: (f.properties ?? {}) as Record<string, unknown>,
          lngLat: { lng: e.lngLat.lng, lat: e.lngLat.lat },
        });
      };

      const onClick = (e: MapMouseEvent) => {
        const features = map.queryRenderedFeatures(e.point, { layers: inspectLayerIds });
        if (!features.length) {
          setClickInfo(null);
          return;
        }
        const f = features[0];
        setClickInfo({
          layerId: f.layer.id,
          sourceLayer: (f.layer as any)["source-layer"] ?? "",
          properties: (f.properties ?? {}) as Record<string, unknown>,
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
  }, [token, vectorSources]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 420px", height: "100vh" }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />

      <div style={{ borderLeft: "1px solid #e5e7eb", padding: 12, overflow: "auto" }}>
        <h3 style={{ margin: "0 0 8px 0" }}>Inspector</h3>

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600 }}>Hover</div>
          {hoverInfo ? (
            <pre style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>
              {safeJson(hoverInfo)}
            </pre>
          ) : (
            <div style={{ fontSize: 12, opacity: 0.7 }}>Hover a feature on the map…</div>
          )}
        </div>

        <div>
          <div style={{ fontWeight: 600 }}>Click (Pinned)</div>
          {clickInfo ? (
            <pre style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>
              {safeJson(clickInfo)}
            </pre>
          ) : (
            <div style={{ fontSize: 12, opacity: 0.7 }}>Click a feature to pin its properties…</div>
          )}
        </div>

        <hr style={{ margin: "12px 0" }} />

        <div style={{ fontSize: 12, opacity: 0.85 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>V0 Goal right now</div>
          <div>
            Confirm join keys by inspecting polygon properties:
            <ul style={{ margin: "6px 0 0 18px" }}>
              <li>Localities: look for something like <code>sublocationid</code></li>
              <li>Micromarkets: look for something like <code>locationid</code></li>
              <li>City: <code>cityid</code></li>
              <li>Projects: <code>projectid</code> + locality/micromarket ids</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}