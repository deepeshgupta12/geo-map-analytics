# Godrej Horizon Wadala — project inputs

Drop the developer attachments into this folder; `project.json` already carries the
location (from the projects tileset), the ids and a **placeholder** plot polygon.

| File | What | Notes |
|---|---|---|
| `masterplan.jpg` (or `.png`) | Developer master plan image | Used to place towers and read floors / heights. |
| `model.glb` | 3D model of the project | glTF binary, metres as units, Y up. Set `model.headingDeg` in `project.json` if the model's front should face a direction other than north. |
| `images/exterior-1.jpg` … | Exterior photos | First one is the card image; list the rest in `card.images`. |

Then fill in `project.json`:

- `plot.coordinates`: the real plot boundary as a GeoJSON Polygon ring in `[lng, lat]`, and set `plot.placeholder` to `false`.
- `towerCount`, `floors`, `units`, and one `towers[]` entry per tower (floors or `heightM`, optional `footprint` polygon and `headingDeg`).
- `card`: `priceRange` (e.g. "₹2.1 Cr – ₹5.4 Cr") or `pricePsf`, `configurations` (e.g. `["2 BHK", "3 BHK"]`), `rera`, `url`.
- Set `masterPlan.attached` and `model.attached` to `true` once the files are in place.

The app loads `public/projects/index.json` to find project folders.
