# Geo Map Analytics (Mapbox + Vector Tiles + Dynamic Choropleth)

> A lightweight, developer-friendly geospatial analytics UI that renders **city → micromarket → locality → roads → projects** layers from **Mapbox vector tiles**, overlays **monthly metrics** as a **dynamic choropleth**, and supports **A/B pinned comparisons** + **exports (PNG + CSV) + shareable URLs**.

---

## 🚩 Problem statement

Real-estate and city intelligence teams need a fast way to:
- **Visually explore** polygon layers (micromarkets/localities) and point/line layers (projects/roads)
- **Overlay time-series metrics** (e.g., asking price psf) over geographies
- **Compare two areas** side-by-side (A vs B)
- **Share** the exact view/state with stakeholders
- **Export** snapshots and data for quick reporting

Traditional dashboards are slow for geospatial exploration, and GIS tools are overkill for most PM/ops/sales workflows.

---

## ✅ Solution (what this repo delivers)

This product provides:
- **Map-first analytics UI** built on Mapbox GL
- **Dynamic choropleth** using **quantile buckets** (computed from full-month distribution)
- **Month timeline slider + autoplay** (with loop + speed controls)
- **Pinned compare A/B**
  - normal click = **Pin A**
  - Shift+Click = **Pin B**
  - deltas vs prev month + sparklines
- **Shareable URL state**
  - metric / level / month / pins / basemap / 3D / choropleth encoded as query params
- **Exports (V3.1)**
  - **PNG snapshot** of the current map view
  - **CSV export** of pinned A/B time-series
  - **Copy share URL** to clipboard

---

## 👥 Who is this product viable for?

### Primary audiences
- **Sales / Pre-sales**: quickly compare “where to pitch” and show evidence-backed pricing dynamics.
- **Ops / Supply teams**: track locality/micromarket movement and anomalies.
- **Research / Analytics**: validate hypotheses visually before deeper statistical work.
- **Product & Growth**: spot demand/price clusters and guide personalization widgets.
- **Leadership / Stakeholders**: quick view + export for decks and weekly reviews.

### Environments
- Internal analytics tool
- “City intelligence” cockpit for large real-estate marketplaces
- Embedded module inside CRM (future direction)

---

## 🧱 What we have built (capabilities)

### 1) Map + layers
- City outline
- Micromarkets polygons
- Localities polygons
- Roads lines
- Projects points
- Invisible “hit layers” for precise hover/click picking

### 2) Inspector panel
- Layer toggles
- Inspect target dropdown (localities / micromarkets / projects / roads / city)
- Hover + Click debug panels (safe JSON)

### 3) Choropleth (v2.3)
- Metric selection
- Level selection (micromarkets join via feature id; localities join via LocalityName)
- Month selection + timeline slider + autoplay
- Legend shows distribution, missing counts, min/max and bucket ranges
- Feature-state applied **only to visible polygons** and cached

### 4) Compare (pins)
- Pin A + Pin B
- Current values, n counts (if present), deltas vs previous month
- Sparklines for quick trend sense
- A − B current-month delta

### 5) Share + export (v3.1)
- Copy share URL
- Export PNG (map snapshot)
- Export CSV for pinned series

---

## 🛠 Tech stack

- **Next.js 16** (App Router)
- **React 18**
- **TypeScript**
- **Mapbox GL JS**
- **Mapbox Vector Tilesets**
- **Static JSON** metrics docs (public assets)
- **ESLint** for quality gates

---

## 📁 Repo structure (high-level)

- `src/components/MapView.tsx`  
  Main UI: map init, layer config, choropleth logic, pins compare, inspector controls, URL state.
- `src/lib/quantiles.ts`  
  Quantile stop computation + bucket formatting helpers.
- `src/config/metrics.ts`  
  Metric definitions, labels, file paths for per-level metrics docs.
- `src/config/tilesets.ts`  
  Tileset IDs + source-layers for Mapbox vector sources.
- `src/lib/export.ts`  
  Export utilities (PNG snapshot, CSV generation, clipboard helpers).
- `public/dim/*.json`  
  Search dimensions (localities/micromarkets) for jump-to.

---

## 🧪 How to run locally

1) Install deps
```bash
npm i
```

2) Add Mapbox token
Create `.env.local`:
```bash
NEXT_PUBLIC_MAPBOX_TOKEN=YOUR_MAPBOX_TOKEN
```

3) Start dev server
```bash
npm run dev
```

4) Lint + build
```bash
npm run lint
npm run build
```

---

## 🧩 Data model (metrics doc)

Metrics are loaded from JSON files (one per `metricKey` x `level`) in `public/`.

Shape (simplified):
```ts
type MetricsDoc = {
  cityId: number;
  metric: string;
  level: "micromarkets" | "localities";
  months: string[]; // e.g. ["2025-01-01", ...]
  byMonth: Record<string, Record<string, { v: number; n?: number }>>;
};
```

Join keys:
- **micromarkets**: join via **feature id** (Mapbox feature id)
- **localities**: join via feature property **LocalityName**

---

## 🔎 Key implementation highlights (with snippets)

### A) Shareable URL state
The app reads query params at mount and writes state back via `replaceState`.
```ts
useEffect(() => {
  const sp = new URLSearchParams(window.location.search);
  // metric / level / month / light / 3D / ch / pins
  // ...
}, []);

useEffect(() => {
  const sp = new URLSearchParams(window.location.search);
  sp.set("metric", metricKey);
  sp.set("level", choroplethLevel);
  // ...
  window.history.replaceState({}, "", `${window.location.pathname}?${sp.toString()}`);
}, [metricKey, choroplethLevel, metricMonth, lightPreset, enable3D, enableChoropleth, pinA, pinB]);
```

### B) Pin A vs Pin B (Shift+Click)
We use robust Shift detection and cache modifier state on mousedown to avoid browser inconsistencies.
```ts
const onMouseDown = (e: MapMouseEvent) => {
  const oe = e.originalEvent;
  shiftDownRef.current = isShiftPressed(oe) || isShiftPressed(e);
};

const onClick = (e: MapMouseEvent) => {
  const assignToB = isShiftPressed(e.originalEvent) || shiftDownRef.current === true;
  shiftDownRef.current = false;

  if (assignToB) setPinB(next);
  else setPinA(next);
};
```

### C) Choropleth via feature-state (visible-only)
We compute quantile stops once per month distribution, and apply feature-state only to rendered polygons.
```ts
const features = map.queryRenderedFeatures({ layers: [fillLayer] });
for (const f of features) {
  const fid = toFeatureId(f.id);
  if (fid === null) continue;

  const joinKey = isMm ? String(fid) : String((f.properties as any)?.LocalityName ?? "");
  const bucket = byMonth[joinKey];

  map.setFeatureState(
    { source: sourceId, sourceLayer, id: fid },
    { v: Number.isFinite(bucket?.v) ? bucket.v : null, n: bucket?.n ?? null }
  );
}
```

---

## 🖼️ Image snapshots

You mentioned you shared snapshots earlier. To include them in the README:
1) Create a folder: `docs/images/`
2) Add your images (e.g. `choropleth.png`, `pins-compare.png`, `export.png`)
3) Reference them here:

```md
![Choropleth + Legend](docs/images/choropleth.png)
![Pinned A/B Compare](docs/images/pins-compare.png)
![Export Actions](docs/images/export.png)
```

> Note: I can’t embed those images here unless they exist in the repo path.

---

## 🧠 Problems we faced (and how we solved them)

### 1) Shift+Drag box zoom conflict 🧩
**Problem:** Mapbox default box-zoom uses Shift+Drag, conflicting with **Shift+Click Pin B**.  
✅ **Fix:** disable `map.boxZoom`.
```ts
map.boxZoom.disable();
```

### 2) Modifier key inconsistencies across click events 🧠
**Problem:** Some click events lose `shiftKey` state depending on browser + canvas focus.  
✅ **Fix:** cache shift state on `mousedown` and reuse on `click`.

### 3) Performance: choropleth state over all polygons 🐢
**Problem:** applying feature-state to all polygons at once is expensive.  
✅ **Fix:** apply only to **visible polygons** via `queryRenderedFeatures` + cache per (metric|level|month).

### 4) Stable legend buckets 🧮
**Problem:** legend should represent full distribution, not viewport-only.  
✅ **Fix:** compute quantiles from the full month dataset and keep legend in sync with month changes.

### 5) Exporting map snapshot 🖼️
**Problem:** Canvas export needs correct buffer settings and timing with Mapbox render cycle.  
✅ **Fix:** use Mapbox canvas + correct map initialization configuration in `MapView` and export helper logic in `src/lib/export.ts`.

---

## 🧾 Version-wise implementations (milestones)

### V1 — Basemap + layers
- Mapbox map init
- Vector sources + baseline fill/line/circle layers
- Hover/click inspector

### V2 — Interaction & UX upgrades
- Inspect target switching
- Layer visibility toggles
- Reset view + 3D toggle (terrain)

### V2.3 — Dynamic choropleth + compare
- Metric/Level/Month controls
- Quantile legend computed from month distribution
- Visible-only feature-state caching
- Pin A/B + deltas + sparklines
- URL state encode/decode

### V3.1 — Share + Export
- Copy share URL
- Export **PNG snapshot**
- Export **CSV** for pinned time-series
- Export helpers centralized in `src/lib/export.ts`

---

## ✅ What “done” looks like for V3.1

- Lint ✅
- Build ✅
- Dev runtime ✅
- Exports working ✅
- No console errors / crashes ✅

---

## 🗺️ Roadmap (suggested next steps)

### V3.2 — Export & reporting polish
- Export PNG with **legend + title + timestamp overlay**
- Export CSV including:
  - metric label, level, month label
  - A/B names + join keys
  - deltas and pct change columns

### V3.3 — Multi-city support
- City switcher
- Dynamic tileset selection per city
- Per-city dim docs and metrics docs

### V4 — “Analytics cockpit”
- Side panel: top risers/fallers (month-over-month)
- Outlier detection
- Filters (BHK, asset type, price bands)
- Save views (bookmarks)

---

## 📜 License
Internal / private (adjust as needed).
