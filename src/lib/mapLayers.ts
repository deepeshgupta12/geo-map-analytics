// src/lib/mapLayers.ts
// Adds all data sources + layers to a Mapbox Standard map and holds the
// preset-dependent colour updates. Pure map side-effects; no React here.

import type { Map as MapboxMap, ExpressionSpecification, FilterSpecification } from "mapbox-gl";

type Map = MapboxMap;
type PaintProp = Parameters<MapboxMap["setPaintProperty"]>[1];
type PaintValue = Parameters<MapboxMap["setPaintProperty"]>[2];
import { TILESETS } from "@/config/tilesets";
import {
  SRC,
  LYR,
  SLOT,
  UI,
  Z_LOC,
  Z_PROJ,
  Z_FADE,
  type LightPreset,
  outlineColorsFor,
  heatRampFor,
  STATUS_GROUPS,
  STATUS_OTHER_COLOR,
  BUBBLE,
  isDarkPreset,
} from "@/config/layers";
import { BUBBLE_IMAGE_ID, bubbleImageOptions, bubbleSprite } from "@/lib/bubbleSprite";

type Expr = ExpressionSpecification;
const expr = (e: unknown) => e as Expr;

const NO_FEATURE_FILTER: FilterSpecification = ["==", ["id"], -999999] as unknown as FilterSpecification;
const NO_NAME_FILTER: FilterSpecification = ["==", ["get", "LocalityName"], "__nope__"] as unknown as FilterSpecification;

export function statusColorExpr(): Expr {
  const m: unknown[] = ["match", ["get", "Status"]];
  for (const g of STATUS_GROUPS) m.push(g.match, g.color);
  m.push(STATUS_OTHER_COLOR);
  return expr(m);
}

export function heatColorExpr(preset: LightPreset): Expr {
  const e: unknown[] = ["interpolate", ["linear"], ["heatmap-density"]];
  for (const [t, c] of heatRampFor(preset)) e.push(t, c);
  return expr(e);
}

export function addDataSources(map: Map) {
  const add = (id: string, url: string) => {
    if (!map.getSource(id)) map.addSource(id, { type: "vector", url });
  };
  add(SRC.city, `mapbox://${TILESETS.city.id}`);
  add(SRC.micromarkets, `mapbox://${TILESETS.micromarkets.id}`);
  add(SRC.localities, `mapbox://${TILESETS.localities.id}`);
  add(SRC.roads, `mapbox://${TILESETS.roads.id}`);
  add(SRC.projects, `mapbox://${TILESETS.projects.id}`);

  if (!map.getSource(SRC.labels)) {
    map.addSource(SRC.labels, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }
  if (!map.getSource(SRC.counts)) {
    map.addSource(SRC.counts, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }
  if (!map.getSource(SRC.projects3d)) {
    map.addSource(SRC.projects3d, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }
}

export function addDataLayers(map: Map, preset: LightPreset) {
  const c = outlineColorsFor(preset);
  const mmSL = TILESETS.micromarkets.sourceLayer;
  const locSL = TILESETS.localities.sourceLayer;

  // ---- Choropleth fills (two slots per level, cross-faded on month change) ----
  const fillSpec = (id: string, source: string, sourceLayer: string) =>
    map.addLayer({
      id,
      type: "fill",
      source,
      "source-layer": sourceLayer,
      slot: SLOT.fills,
      paint: {
        "fill-color": "rgba(0,0,0,0)",
        "fill-opacity": 0,
        "fill-opacity-transition": { duration: 300, delay: 0 },
        "fill-emissive-strength": 1,
        "fill-antialias": true,
      },
    });

  fillSpec(LYR.mmFillA, SRC.micromarkets, mmSL);
  fillSpec(LYR.mmFillB, SRC.micromarkets, mmSL);
  fillSpec(LYR.locFillA, SRC.localities, locSL);
  fillSpec(LYR.locFillB, SRC.localities, locSL);

  // ---- Heatmap of project density ----
  map.addLayer({
    id: LYR.projectsHeat,
    type: "heatmap",
    source: SRC.projects,
    "source-layer": TILESETS.projects.sourceLayer,
    slot: SLOT.heat,
    layout: { visibility: "none" },
    paint: {
      // ~27k project points in the city: keep intensity low at city zoom so the
      // ramp differentiates dense cores instead of saturating everywhere.
      "heatmap-weight": 0.6,
      "heatmap-intensity": expr(["interpolate", ["linear"], ["zoom"], 10, 0.12, 12, 0.25, 14, 0.6, 16, 1.4]),
      "heatmap-radius": expr(["interpolate", ["linear"], ["zoom"], 10, 4, 12, 7, 14, 14, 16, 26]),
      "heatmap-color": heatColorExpr(preset),
      "heatmap-opacity": expr(["interpolate", ["linear"], ["zoom"], 12.5, 0.9, 15.5, 0.45]),
      "heatmap-opacity-transition": { duration: 300, delay: 0 },
    },
  });

  // ---- Dim mask over non-focused micromarkets ----
  map.addLayer({
    id: LYR.mmMask,
    type: "fill",
    source: SRC.micromarkets,
    "source-layer": mmSL,
    slot: SLOT.fills,
    filter: NO_FEATURE_FILTER,
    paint: {
      "fill-color": c.mask,
      "fill-opacity": 1,
      "fill-opacity-transition": { duration: 300, delay: 0 },
      "fill-emissive-strength": 1,
    },
  });

  // ---- 3D bars (fill-extrusion by value) – hidden until toggled ----
  const extrudeSpec = (id: string, source: string, sourceLayer: string) =>
    map.addLayer({
      id,
      type: "fill-extrusion",
      source,
      "source-layer": sourceLayer,
      slot: SLOT.lines,
      layout: { visibility: "none" },
      paint: {
        "fill-extrusion-color": "rgba(0,0,0,0)",
        "fill-extrusion-height": 0,
        "fill-extrusion-base": 0,
        "fill-extrusion-opacity": 0.85,
        // No transitions: paint set while the layer is hidden would otherwise leave a
        // never-finishing transition that keeps the map repainting and blocks `idle`.
        "fill-extrusion-color-transition": { duration: 0, delay: 0 },
        "fill-extrusion-height-transition": { duration: 0, delay: 0 },
        "fill-extrusion-opacity-transition": { duration: 0, delay: 0 },
        "fill-extrusion-emissive-strength": 0.75,
        "fill-extrusion-vertical-gradient": true,
      },
    });
  extrudeSpec(LYR.mmExtrude, SRC.micromarkets, mmSL);
  extrudeSpec(LYR.locExtrude, SRC.localities, locSL);

  // ---- Outlines ----
  map.addLayer({
    id: LYR.cityOutline,
    type: "line",
    source: SRC.city,
    "source-layer": TILESETS.city.sourceLayer,
    slot: SLOT.lines,
    paint: { "line-color": c.city, "line-width": 2.4, "line-emissive-strength": 1, "line-opacity": 0.9 },
  });

  map.addLayer({
    id: LYR.mmOutline,
    type: "line",
    source: SRC.micromarkets,
    "source-layer": mmSL,
    slot: SLOT.lines,
    paint: {
      "line-color": c.mm,
      "line-width": expr(["interpolate", ["linear"], ["zoom"], 9, 2.2, 12, 3.4, 15, 4.2]),
      "line-emissive-strength": 1,
    },
  });

  map.addLayer({
    id: LYR.locOutline,
    type: "line",
    source: SRC.localities,
    "source-layer": locSL,
    slot: SLOT.lines,
    minzoom: Z_LOC - Z_FADE,
    paint: {
      "line-color": c.loc,
      "line-width": expr(["interpolate", ["linear"], ["zoom"], 12, 1.5, 15, 2.6]),
      "line-opacity": expr(["interpolate", ["linear"], ["zoom"], Z_LOC - Z_FADE, 0, Z_LOC, 1]),
      "line-emissive-strength": 1,
    },
  });

  // ---- Hover outlines (feature-state "hover") ----
  const hoverSpec = (id: string, source: string, sourceLayer: string) =>
    map.addLayer({
      id,
      type: "line",
      source,
      "source-layer": sourceLayer,
      slot: SLOT.lines,
      paint: {
        "line-color": c.hover,
        "line-width": expr(["case", ["boolean", ["feature-state", "hover"], false], 4.5, 0]),
        "line-emissive-strength": 1,
      },
    });
  hoverSpec(LYR.mmHover, SRC.micromarkets, mmSL);
  hoverSpec(LYR.locHover, SRC.localities, locSL);

  // Hover fill brighten (above the choropleth and the focus mask).
  const hoverFillSpec = (id: string, source: string, sourceLayer: string) =>
    map.addLayer({
      id,
      type: "fill",
      source,
      "source-layer": sourceLayer,
      slot: SLOT.fills,
      paint: {
        "fill-color": c.hoverFill,
        "fill-opacity": expr(["case", ["boolean", ["feature-state", "hover"], false], 1, 0]),
        "fill-emissive-strength": 1,
      },
    });
  hoverFillSpec(LYR.mmHoverFill, SRC.micromarkets, mmSL);
  hoverFillSpec(LYR.locHoverFill, SRC.localities, locSL);

  // ---- Roads ----
  map.addLayer({
    id: LYR.roads,
    type: "line",
    source: SRC.roads,
    "source-layer": TILESETS.roads.sourceLayer,
    slot: SLOT.lines,
    layout: { visibility: "none" },
    paint: {
      "line-color": c.roads,
      "line-width": expr(["interpolate", ["linear"], ["zoom"], 10, 0.6, 14, 1.6]),
      "line-emissive-strength": 1,
    },
  });

  // ---- Projects (dots) – only once zoomed into a locality ----
  map.addLayer({
    id: LYR.projectsCircle,
    type: "circle",
    source: SRC.projects,
    "source-layer": TILESETS.projects.sourceLayer,
    slot: SLOT.points,
    minzoom: Z_PROJ - Z_FADE,
    paint: {
      "circle-radius": expr(["interpolate", ["linear"], ["zoom"], 13.5, 2.5, 15, 4.5, 17, 7]),
      "circle-color": statusColorExpr(),
      "circle-opacity": expr(["interpolate", ["linear"], ["zoom"], Z_PROJ - Z_FADE, 0, Z_PROJ, 0.95]),
      "circle-stroke-width": 0.9,
      "circle-stroke-color": c.circleStroke,
      "circle-stroke-opacity": expr(["interpolate", ["linear"], ["zoom"], Z_PROJ - Z_FADE, 0, Z_PROJ, 0.9]),
      "circle-emissive-strength": 1,
    },
  });

  // ---- Labels (computed centroids, GeoJSON) ----
  map.addLayer({
    id: LYR.mmLabels,
    type: "symbol",
    source: SRC.labels,
    slot: SLOT.labels,
    filter: ["==", ["get", "level"], "micromarkets"],
    maxzoom: Z_LOC + 0.6,
    layout: {
      "text-field": ["get", "name"],
      "text-font": ["DIN Pro Bold", "Arial Unicode MS Bold"],
      "text-size": expr(["interpolate", ["linear"], ["zoom"], 9, 12, 12, 16]),
      "text-transform": "uppercase",
      "text-letter-spacing": 0.08,
      "text-max-width": 8,
      "text-padding": 6,
      // Only four of these; never let basemap place labels knock them out.
      "text-allow-overlap": true,
      "symbol-sort-key": 0,
    },
    paint: {
      "text-color": c.labelText,
      "text-halo-color": c.labelHalo,
      "text-halo-width": 1.6,
      "text-opacity": expr(["interpolate", ["linear"], ["zoom"], Z_LOC - 0.3, 1, Z_LOC + 0.6, 0]),
    },
  });

  map.addLayer({
    id: LYR.locLabels,
    type: "symbol",
    source: SRC.labels,
    slot: SLOT.labels,
    filter: ["==", ["get", "level"], "localities"],
    minzoom: Z_LOC - 0.3,
    layout: {
      "text-field": ["get", "name"],
      "text-font": ["DIN Pro Medium", "Arial Unicode MS Regular"],
      "text-size": expr(["interpolate", ["linear"], ["zoom"], 12, 11, 15, 14]),
      "text-max-width": 7,
      "text-padding": 4,
    },
    paint: {
      "text-color": c.labelText,
      "text-halo-color": c.labelHalo,
      "text-halo-width": 1.4,
      "text-opacity": expr(["interpolate", ["linear"], ["zoom"], Z_LOC - 0.3, 0, Z_LOC + 0.3, 1]),
    },
  });

  // ---- Project count bubbles ----
  // Micromarket totals at city zoom, locality totals in the localities band; both
  // sit just below the area name label and dissolve as the next band takes over.
  const bubbleFont = ["DIN Pro Bold", "Arial Unicode MS Bold"];
  // Micromarket bubbles live strictly below Z_LOC, locality bubbles strictly from Z_LOC
  // (and only inside the focused micromarket, see the filter effect); each dissolves
  // where the next drill-down level takes over.
  const mmFade = expr(["interpolate", ["linear"], ["zoom"], Z_LOC - 0.3, 0.95, Z_LOC, 0]);
  const locFade = expr(["interpolate", ["linear"], ["zoom"], Z_LOC, 0.95, Z_PROJ - 0.4, 0.95, Z_PROJ + 0.3, 0]);

  // One symbol per bubble: a nine-slice disc icon fitted around the number
  // (`icon-text-fit`), so the disc and the count can never drift apart under pitch.
  if (!map.hasImage(BUBBLE_IMAGE_ID)) map.addImage(BUBBLE_IMAGE_ID, bubbleSprite(BUBBLE.fill, BUBBLE.stroke), bubbleImageOptions());
  const bubbleLayout = (textSize: Expr, offsetEm: number) => ({
    "icon-image": BUBBLE_IMAGE_ID,
    "icon-text-fit": "both" as const,
    "icon-text-fit-padding": [5, 9, 4, 9] as [number, number, number, number],
    "icon-allow-overlap": true,
    "icon-ignore-placement": true,
    "text-field": ["to-string", ["get", "count"]] as unknown as Expr,
    "text-font": bubbleFont,
    "text-size": textSize,
    "text-justify": "center" as const,
    // below the area name label (two lines for micromarkets, one for localities)
    "text-offset": [0, offsetEm] as [number, number],
    "text-allow-overlap": true,
    "text-ignore-placement": true,
  });

  map.addLayer({
    id: LYR.countMm,
    type: "symbol",
    source: SRC.counts,
    slot: SLOT.labels,
    filter: ["==", ["get", "level"], "micromarkets"],
    maxzoom: Z_LOC,
    layout: bubbleLayout(expr(["interpolate", ["linear"], ["sqrt", ["get", "count"]], 1, 12, 140, 15]), 2.7),
    paint: { "text-color": BUBBLE.text, "text-opacity": mmFade, "icon-opacity": mmFade },
  });
  map.addLayer({
    id: LYR.countLoc,
    type: "symbol",
    source: SRC.counts,
    slot: SLOT.labels,
    filter: ["==", ["get", "level"], "localities"],
    minzoom: Z_LOC,
    maxzoom: Z_PROJ + 0.3,
    layout: bubbleLayout(expr(["interpolate", ["linear"], ["sqrt", ["get", "count"]], 1, 10, 40, 13]), 1.7),
    paint: { "text-color": BUBBLE.text, "text-opacity": locFade, "icon-opacity": locFade },
  });

  // ---- Procedural 3D project renderings (podium + twin-wing towers) ----
  // Visible from just below the projects band; paint is data-driven from the
  // GeoJSON built by lib/projectGeometry (height/base in metres, facade pattern).
  const noTransition = { duration: 0, delay: 0 };
  map.addLayer({
    id: LYR.projectPodium,
    type: "fill-extrusion",
    source: SRC.projects3d,
    slot: SLOT.lines,
    filter: ["==", ["get", "kind"], "podium"],
    minzoom: Z_PROJ - 1,
    paint: {
      "fill-extrusion-color": ["get", "color"],
      "fill-extrusion-height": ["get", "height"],
      "fill-extrusion-base": 0,
      "fill-extrusion-opacity": 0.95,
      "fill-extrusion-emissive-strength": isDarkPreset(preset) ? 0.7 : 0.2,
      "fill-extrusion-vertical-gradient": true,
      "fill-extrusion-ambient-occlusion-intensity": 0.35,
      "fill-extrusion-color-transition": noTransition,
      "fill-extrusion-height-transition": noTransition,
      "fill-extrusion-opacity-transition": noTransition,
    },
  });
  map.addLayer({
    id: LYR.projectTowers,
    type: "fill-extrusion",
    source: SRC.projects3d,
    slot: SLOT.lines,
    filter: ["==", ["get", "kind"], "tower"],
    minzoom: Z_PROJ - 1,
    paint: {
      "fill-extrusion-color": ["get", "color"],
      "fill-extrusion-height": ["get", "height"],
      "fill-extrusion-base": ["get", "base"],
      "fill-extrusion-opacity": 1,
      "fill-extrusion-emissive-strength": isDarkPreset(preset) ? 0.9 : 0.25,
      "fill-extrusion-vertical-gradient": false,
      "fill-extrusion-ambient-occlusion-intensity": 0.3,
      "fill-extrusion-color-transition": noTransition,
      "fill-extrusion-height-transition": noTransition,
      "fill-extrusion-opacity-transition": noTransition,
    },
  });
  // Balcony slabs: one thin ring per floor in the accent colour (the facade banding).
  map.addLayer({
    id: LYR.projectSlabs,
    type: "fill-extrusion",
    source: SRC.projects3d,
    slot: SLOT.lines,
    filter: ["==", ["get", "kind"], "slab"],
    minzoom: Z_PROJ - 0.5,
    paint: {
      "fill-extrusion-color": ["get", "color"],
      "fill-extrusion-height": ["get", "height"],
      "fill-extrusion-base": ["get", "base"],
      "fill-extrusion-opacity": 1,
      "fill-extrusion-emissive-strength": isDarkPreset(preset) ? 1 : 0.3,
      "fill-extrusion-vertical-gradient": false,
      "fill-extrusion-color-transition": noTransition,
      "fill-extrusion-height-transition": noTransition,
      "fill-extrusion-opacity-transition": noTransition,
    },
  });
  map.addLayer({
    id: LYR.projectFuture,
    type: "line",
    source: SRC.projects3d,
    slot: SLOT.lines,
    filter: ["==", ["get", "kind"], "future"],
    minzoom: Z_PROJ - 1,
    paint: { "line-color": "#f59e0b", "line-width": 2, "line-dasharray": [2, 2], "line-emissive-strength": 1 },
  });
  map.addLayer({
    id: LYR.projectLabel,
    type: "symbol",
    source: SRC.projects3d,
    slot: SLOT.labels,
    filter: ["==", ["get", "kind"], "label"],
    minzoom: Z_PROJ - 1,
    layout: {
      "text-field": ["get", "name"],
      "text-font": ["DIN Pro Bold", "Arial Unicode MS Bold"],
      "text-size": 13,
      "text-transform": "uppercase",
      "text-letter-spacing": 0.06,
      "text-allow-overlap": true,
      "text-anchor": "bottom",
      "text-offset": [0, -0.8],
      "symbol-z-elevate": true, // sits on the rendered rooftops
      "symbol-z-order": "source",
    },
    paint: { "text-color": "#ffffff", "text-halo-color": "rgba(2,6,23,0.9)", "text-halo-width": 1.5 },
  });

  // ---- Invisible hit layers ----
  map.addLayer({
    id: LYR.hitCity,
    type: "line",
    source: SRC.city,
    "source-layer": TILESETS.city.sourceLayer,
    slot: SLOT.lines,
    paint: { "line-width": 12, "line-opacity": 0 },
  });
  map.addLayer({
    id: LYR.hitMm,
    type: "fill",
    source: SRC.micromarkets,
    "source-layer": mmSL,
    slot: SLOT.lines,
    paint: { "fill-color": "#000000", "fill-opacity": 0 },
  });
  map.addLayer({
    id: LYR.hitLoc,
    type: "fill",
    source: SRC.localities,
    "source-layer": locSL,
    slot: SLOT.lines,
    paint: { "fill-color": "#000000", "fill-opacity": 0 },
  });
  map.addLayer({
    id: LYR.hitRoads,
    type: "line",
    source: SRC.roads,
    "source-layer": TILESETS.roads.sourceLayer,
    slot: SLOT.lines,
    layout: { visibility: "none" },
    paint: { "line-width": 12, "line-opacity": 0 },
  });
  map.addLayer({
    id: LYR.hitProjects,
    type: "circle",
    source: SRC.projects,
    "source-layer": TILESETS.projects.sourceLayer,
    slot: SLOT.points,
    minzoom: Z_PROJ - Z_FADE,
    paint: { "circle-radius": 10, "circle-opacity": 0 },
  });

  // ---- Pinned outlines (compare A / B) ----
  const pinSpec = (id: string, source: string, sourceLayer: string, filter: FilterSpecification, color: string) =>
    map.addLayer({
      id,
      type: "line",
      source,
      "source-layer": sourceLayer,
      slot: SLOT.lines,
      filter,
      paint: { "line-color": color, "line-width": 4.5, "line-emissive-strength": 1 },
    });
  pinSpec(LYR.pinMmA, SRC.micromarkets, mmSL, NO_FEATURE_FILTER, UI.pinA);
  pinSpec(LYR.pinMmB, SRC.micromarkets, mmSL, NO_FEATURE_FILTER, UI.pinB);
  pinSpec(LYR.pinLocA, SRC.localities, locSL, NO_NAME_FILTER, UI.pinA);
  pinSpec(LYR.pinLocB, SRC.localities, locSL, NO_NAME_FILTER, UI.pinB);
}

/** Re-colour preset-dependent layers (outlines, labels, mask, heat ramp). */
export function applyPresetColors(map: Map, preset: LightPreset) {
  const c = outlineColorsFor(preset);
  const set = (id: string, prop: PaintProp, value: PaintValue) => {
    if (!map.getLayer(id)) return;
    // Mapbox does not recalculate hidden layers, so a paint change on one leaves a
    // transition pending forever and the map never idles. Hidden layers are
    // re-coloured by the caller when they become visible.
    if (map.getLayoutProperty(id, "visibility") === "none") return;
    map.setPaintProperty(id, prop, value);
  };
  set(LYR.cityOutline, "line-color", c.city);
  set(LYR.mmOutline, "line-color", c.mm);
  set(LYR.locOutline, "line-color", c.loc);
  set(LYR.roads, "line-color", c.roads);
  set(LYR.mmHover, "line-color", c.hover);
  set(LYR.locHover, "line-color", c.hover);
  set(LYR.mmHoverFill, "fill-color", c.hoverFill);
  set(LYR.locHoverFill, "fill-color", c.hoverFill);
  set(LYR.mmMask, "fill-color", c.mask);
  set(LYR.projectsCircle, "circle-stroke-color", c.circleStroke);
  set(LYR.mmLabels, "text-color", c.labelText);
  set(LYR.mmLabels, "text-halo-color", c.labelHalo);
  set(LYR.locLabels, "text-color", c.labelText);
  set(LYR.locLabels, "text-halo-color", c.labelHalo);
  set(LYR.projectsHeat, "heatmap-color", heatColorExpr(preset));
  // 3D project renderings: lit by the sun in day/dawn, self-lit under dusk/night.
  const dark = isDarkPreset(preset);
  set(LYR.projectPodium, "fill-extrusion-emissive-strength", dark ? 0.7 : 0.2);
  set(LYR.projectTowers, "fill-extrusion-emissive-strength", dark ? 0.9 : 0.25);
  set(LYR.projectSlabs, "fill-extrusion-emissive-strength", dark ? 1 : 0.3);
}

export function setVisibility(map: Map, layerId: string, visible: boolean) {
  if (!map.getLayer(layerId)) return;
  const cur = map.getLayoutProperty(layerId, "visibility") ?? "visible";
  const next = visible ? "visible" : "none";
  if (cur !== next) map.setLayoutProperty(layerId, "visibility", next);
}

export function setFilterSafe(map: Map, layerId: string, filter: FilterSpecification | null | undefined) {
  if (!map.getLayer(layerId)) return;
  map.setFilter(layerId, filter ?? null);
}

export const FILTERS = {
  noFeature: NO_FEATURE_FILTER,
  noName: NO_NAME_FILTER,
  byId: (id: number): FilterSpecification => ["==", ["id"], id] as unknown as FilterSpecification,
  notId: (id: number): FilterSpecification => ["!=", ["id"], id] as unknown as FilterSpecification,
  idIn: (ids: number[]): FilterSpecification => ["in", ["id"], ["literal", ids]] as unknown as FilterSpecification,
  byName: (name: string): FilterSpecification => ["==", ["get", "LocalityName"], name] as unknown as FilterSpecification,
  projectsInLocality: (localityId: number): FilterSpecification =>
    ["==", ["get", "LocalityID"], localityId] as unknown as FilterSpecification,
  labelsLevel: (level: string): FilterSpecification => ["==", ["get", "level"], level] as unknown as FilterSpecification,
  labelsLevelInMm: (level: string, mmId: number): FilterSpecification =>
    ["all", ["==", ["get", "level"], level], ["==", ["get", "mmId"], mmId]] as unknown as FilterSpecification,
};
