# Features and how each one is integrated

One line per feature: what the user sees, and which Mapbox / Next.js / data integration makes it work. Screenshots are in [`docs/screenshots/`](screenshots/) and were captured from the app by the headless driver at 1500×920.

| # | Feature | What you see | Integration (one line) | Screenshot |
|---|---|---|---|---|
| 1 | City overview | Four micromarkets painted by asking price, night light, 3D buildings, orange count bubbles | Mapbox Standard style (`lightPreset: night`, `show3dObjects`) + micromarket vector tileset painted through `feature-state` in the `middle` slot | [01](screenshots/01-city-overview.jpg) |
| 2 | Hover highlight + metric card | Cyan outline and tint on the micromarket under the cursor, card with value, n and month | Invisible hit layers queried with `queryRenderedFeatures`; `feature-state: hover` drives line/fill paint; Mapbox `Popup` for the card | [02](screenshots/02-hover-micromarket.jpg) |
| 3 | Project heatmap | Kernel-density heat of ~31k project points, choropleth dimmed underneath | Mapbox `heatmap` layer on the projects tileset with a single-hue purple ramp (validated against the dark basemap) | [03](screenshots/03-heatmap.jpg) |
| 4 | 3D bars | Polygons extruded by the metric value | `fill-extrusion` layers whose height reads the same `feature-state` value as the choropleth | [04](screenshots/04-3d-bars.jpg) |
| 5 | Zoom-driven drill-down | From z12 only the localities of the focused micromarket are painted, others dimmed; count bubble per locality | Layer filters by feature id (`setFilter`) with opacity ramps around z12/z14; focus taken from the polygon under the cursor (or screen centre); dimension table decides locality → micromarket membership | [05](screenshots/05-localities-bubbles.jpg) |
| 6 | Timeline playback | Months cross-fade instead of snapping; playback keeps running while you pan, zoom and change level | Two fill layers per level (`a`/`b`); each month writes `feature-state` into the hidden slot and animates `fill-opacity` on both (GPU blend) | [06](screenshots/06-timeline-playback.jpg) |
| 7 | Carry-forward hover | Hover card on a sparse locality shows the value and the month it was carried from | `carryForward()` fills missing months from the latest earlier value and tags `asOf` into feature-state | [07](screenshots/07-hover-locality-carry-forward.jpg) |
| 8 | Project dots by status | From z14 the projects of the focused locality, coloured ready / under construction / new launch | `circle` layer on the projects tileset, data-driven `circle-color` by `Status`, filtered by `LocalityID` | [08](screenshots/08-project-dots.jpg) |
| 9 | 3D project rendering (night) | Podium on the plot and three textured twin-wing towers with lit windows | Mapbox `model` layer: a binary glTF per tower is built in the browser (`lib/towerModel.ts`: H footprint mesh, canvas facade texture, emissive window map) from `project.json`; podium is a `fill-extrusion` | [09](screenshots/09-3d-project-night.jpg) |
| 10 | 3D project rendering (day) | Same towers sunlit, casting shadows on the basemap | Day variant of the glTF (no emissive map), `model-emissive-strength` 0, `model-cast-shadows` under the Standard day light | [10](screenshots/10-3d-project-day.jpg) |
| 11 | Dusk close-up | Facade texture (piers, glass, terracotta balcony bands) and partially lit windows | Night glTF variant with `model-emissive-strength` 0.3; textures are mip-mapped so they read at every zoom | [11](screenshots/11-3d-project-dusk-close.jpg) |
| 12 | Project card + orbit | Clicking a tower opens the card (photo, price, ₹/sqft, configurations, units, towers, RERA) and the camera orbits at one turn per minute | `queryRenderedFeatures` on the model layer (hit-tested on the model bounds); React card from `project.json`; orbit = `map.rotateTo` chained on `moveend`, stopped by any user input | [12](screenshots/12-project-card-orbit.jpg) |
| 13 | Compare pins A / B | Two pinned areas with current value, n, delta vs previous month, sparkline and A − B | Pins encoded in the URL (`pinA`, `pinB`), series read from the static metrics JSON, inline SVG sparklines | [13](screenshots/13-compare-pins.jpg) |
| 14 | Light presets and themes | Day light with the faded theme; palette flips so the darkest step is the highest value | Standard style config (`lightPreset`, `theme`, label toggles) with per-preset emissive paint and ramp direction on every data layer | [14](screenshots/14-day-faded-theme.jpg) |
| 15 | Search and jump | Type a locality or micromarket name, pick it, the map flies there and pins it | Client-side index built from the dimension JSON and merged tile polygons (area-weighted centroids, bboxes) → `fitBounds` | [15](screenshots/15-search.jpg) |
| 16 | Share URL and exports | Every view is a URL (metric, month, light, theme, pins, camera); PNG, CSV and state JSON downloads | Versioned URL state (`v=4`, non-defaults only, `cam=lng,lat,zoom,pitch,bearing`); PNG read from the canvas inside a `render` callback | — |
| 17 | Master plan analysis | Towers, footprints, podium and orientation in `project.json` come from the developer plan | `scripts/analyze_master_plan.py`: Green Open Area Intelligence engine (preprocessing, OpenCV masks) + Claude vision (`claude-opus-5-5`), Gemini/OpenCV fallbacks | — |
| 18 | Performance mode | Lighter basemap for slower machines | Standard config toggles (`show3dObjects`, landmarks, terrain), `antialias: false`, no preserved drawing buffer | — |
| 19 | Verification | Every round checked on screenshots and layer counts | Headless Chrome over the DevTools protocol; `window.__gmMap` / `window.__gmDebug` exposed for the driver | — |

## Data integrations

| Data | Where it lives | Join |
|---|---|---|
| City, micromarkets, localities, roads, projects | Mapbox vector tilesets (ids in `.env.local`) | locality tile id = dimension id = project `LocalityID`; micromarket tile id = metrics key |
| Dimensions and project counts | `public/dim/*.json` | locality → micromarket from the dimension table (polygon containment only as a fallback) |
| Monthly metrics | `public/metrics/<metric>_<level>.json` | by id (micromarkets) / canonical name (localities), carry-forward for sparse months |
| Project inputs | `public/projects/<slug>/project.json` + master plan + photos | `ids.project` matches the project tile feature id; the plain dot is hidden while the 3D rendering exists |
