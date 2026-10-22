// src/config/layers.ts
// Shared constants for the map: zoom bands, source/layer ids, palettes.

export type LightPreset = "dawn" | "day" | "dusk" | "night";
export type BasemapTheme = "default" | "faded" | "monochrome";
export type ZoomBand = "micromarkets" | "localities" | "projects";

// Zoom bands for the drill-down:
//   < Z_LOC            -> micromarket polygons (choropleth at micromarket level)
//   Z_LOC .. Z_PROJ    -> locality polygons of the focused micromarket
//   >= Z_PROJ          -> project dots of the focused locality
export const Z_LOC = 12;
export const Z_PROJ = 14;
// Fade width (in zoom units) used for opacity ramps around each threshold.
export const Z_FADE = 0.6;

export function zoomBand(z: number): ZoomBand {
  if (z >= Z_PROJ) return "projects";
  if (z >= Z_LOC) return "localities";
  return "micromarkets";
}

export const DEFAULT_CENTER: [number, number] = [72.8777, 19.076]; // Mumbai
export const DEFAULT_ZOOM = 10.6;
export const DEFAULT_PITCH_3D = 55;
export const DEFAULT_BEARING_3D = -17;

// Mumbai city extent (from the city tileset metadata). Used to "zoom out to the city".
export const CITY_BOUNDS: [[number, number], [number, number]] = [
  [72.776333, 18.893956],
  [72.980645, 19.270177],
];

export const SRC = {
  city: "city-src",
  micromarkets: "micromarkets-src",
  localities: "localities-src",
  roads: "roads-src",
  projects: "projects-src",
  labels: "labels-src", // GeoJSON (computed centroids)
  dem: "mapbox-dem",
} as const;

export const LYR = {
  cityOutline: "city-outline",

  // Choropleth fills: two slots per level so month changes can cross-fade.
  mmFillA: "mm-fill-a",
  mmFillB: "mm-fill-b",
  locFillA: "loc-fill-a",
  locFillB: "loc-fill-b",

  // Dimming mask over non-focused micromarkets while drilled in.
  mmMask: "mm-mask",

  mmOutline: "mm-outline",
  locOutline: "loc-outline",

  mmHover: "mm-hover",
  locHover: "loc-hover",
  mmHoverFill: "mm-hover-fill",
  locHoverFill: "loc-hover-fill",

  // Optional 3D bars (fill-extrusion by metric value).
  mmExtrude: "mm-extrude",
  locExtrude: "loc-extrude",

  roads: "roads-line",

  projectsHeat: "projects-heat",
  projectsCircle: "projects-circle",

  mmLabels: "mm-labels",
  locLabels: "loc-labels",

  // Invisible hit layers for hover / click.
  hitCity: "city-hit",
  hitMm: "mm-hit",
  hitLoc: "loc-hit",
  hitRoads: "roads-hit",
  hitProjects: "projects-hit",

  // Pinned outlines (compare A / B).
  pinMmA: "pinned-mm-outline-a",
  pinMmB: "pinned-mm-outline-b",
  pinLocA: "pinned-loc-outline-a",
  pinLocB: "pinned-loc-outline-b",
} as const;

// Mapbox Standard style slots: "bottom" (above land/water), "middle" (above roads,
// below 3D buildings and labels), "top" (above buildings, below place labels).
export const SLOT = {
  fills: "middle",
  heat: "middle",
  lines: "top",
  points: "top",
  labels: "top",
} as const;

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

  pinA: "#F59E0B",
  pinB: "#A855F7",
};

// Sequential (one hue) amber ramp, validated against a dark basemap surface.
// Index 0 is the lightest step. See paletteFor() for the light/dark anchor flip.
export const AMBER_RAMP = ["#fff1c2", "#fcd56b", "#f5b32b", "#e08e0b", "#b56a07"] as const;

export function isDarkPreset(p: LightPreset): boolean {
  return p === "night" || p === "dusk";
}

/**
 * Bucket colours ordered low -> high.
 * On a dark basemap the brightest step is the highest value (it pops against the
 * dark surface); on a light basemap the darkest step is the highest value.
 */
export function paletteFor(preset: LightPreset, bucketCount: number): string[] {
  const ramp = AMBER_RAMP.slice();
  const ordered = isDarkPreset(preset) ? ramp.reverse() : ramp;
  if (bucketCount >= ordered.length) return ordered;
  // Fewer buckets: pick evenly spaced steps.
  const out: string[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const idx = Math.round((i * (ordered.length - 1)) / Math.max(1, bucketCount - 1));
    out.push(ordered[idx]!);
  }
  return out;
}

export function missingColorFor(preset: LightPreset): string {
  return isDarkPreset(preset) ? "rgba(148,163,184,0.22)" : "rgba(100,116,139,0.22)";
}

export const CHOROPLETH_OPACITY = 0.72;

// Heatmap (project density): single purple hue, transparent -> bright.
export function heatRampFor(preset: LightPreset): Array<[number, string]> {
  if (isDarkPreset(preset)) {
    return [
      [0, "rgba(76,29,149,0)"],
      [0.15, "rgba(76,29,149,0.55)"],
      [0.4, "#6d28d9"],
      [0.7, "#a78bfa"],
      [1, "#ede9fe"],
    ];
  }
  return [
    [0, "rgba(237,233,254,0)"],
    [0.15, "rgba(221,214,254,0.6)"],
    [0.4, "#a78bfa"],
    [0.7, "#6d28d9"],
    [1, "#3b0764"],
  ];
}

// Project status -> colour (categorical, fixed order, validated dark slots 1..3).
// "Partially Ready To Move" is folded into "Ready to Move".
export const STATUS_GROUPS: Array<{ key: string; label: string; color: string; match: string[] }> = [
  { key: "ready", label: "Ready to move", color: "#3987e5", match: ["Ready to Move", "Partially Ready To Move"] },
  { key: "construction", label: "Under construction", color: "#d95926", match: ["Under Construction"] },
  { key: "launch", label: "New launch", color: "#199e70", match: ["New Launch"] },
];
export const STATUS_OTHER_COLOR = "#9ca3af";

export function outlineColorsFor(preset: LightPreset) {
  const dark = isDarkPreset(preset);
  return {
    city: dark ? "rgba(255,255,255,0.65)" : "rgba(15,23,42,0.75)",
    mm: dark ? "rgba(255,255,255,0.9)" : "rgba(15,23,42,0.85)",
    loc: dark ? "rgba(255,255,255,0.6)" : "rgba(15,23,42,0.55)",
    roads: dark ? "rgba(251,191,36,0.55)" : "rgba(180,83,9,0.6)",
    // Distinct from the white/dark outlines so a hovered polygon reads as highlighted.
    hover: dark ? "#22d3ee" : "#0369a1",
    hoverFill: dark ? "rgba(34,211,238,0.28)" : "rgba(3,105,161,0.22)",
    mask: dark ? "rgba(2,6,23,0.55)" : "rgba(255,255,255,0.55)",
    labelText: dark ? "#f8fafc" : "#0f172a",
    labelHalo: dark ? "rgba(2,6,23,0.9)" : "rgba(255,255,255,0.9)",
    circleStroke: dark ? "rgba(2,6,23,0.9)" : "rgba(255,255,255,0.95)",
  };
}
