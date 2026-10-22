// scripts/build_project_counts.mjs
// Counts projects per locality / micromarket / status by decoding the projects
// vector tiles at their max zoom, and writes public/dim/project_counts_city13.json.
// Usage: node scripts/build_project_counts.mjs
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import dotenv from "dotenv";
import Pbf from "pbf";
import { VectorTile } from "@mapbox/vector-tile";

dotenv.config({ path: ".env.local" });

const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || process.env.MAPBOX_TOKEN;
const tileset = process.env.NEXT_PUBLIC_TILESET_PROJECTS;
if (!token || !tileset) {
  console.error("Need NEXT_PUBLIC_MAPBOX_TOKEN and NEXT_PUBLIC_TILESET_PROJECTS in .env.local");
  process.exit(1);
}

const CITY_ID = 13;
const SOURCE_LAYER = "mumbai_projects";
// Mumbai extent (from the city tileset) with a little margin.
const BBOX = { west: 72.70, south: 18.85, east: 73.05, north: 19.33 };

function lon2tile(lon, z) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}
function lat2tile(lat, z) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

async function main() {
  const meta = await (await fetch(`https://api.mapbox.com/v4/${tileset}.json?secure=true&access_token=${token}`)).json();
  const z = meta.maxzoom ?? 11;
  const x0 = lon2tile(BBOX.west, z);
  const x1 = lon2tile(BBOX.east, z);
  const y0 = lat2tile(BBOX.north, z);
  const y1 = lat2tile(BBOX.south, z);
  console.log(`tileset ${tileset} maxzoom ${z}; tiles x ${x0}..${x1}, y ${y0}..${y1}`);

  const byLocality = {};
  const byMicromarket = {};
  const byStatus = {};
  const byLocalityStatus = {};
  const seen = new Set();
  let total = 0;

  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const url = `https://api.mapbox.com/v4/${tileset}/${z}/${x}/${y}.vector.pbf?access_token=${token}`;
      const res = await fetch(url);
      if (res.status === 404 || res.status === 204) continue;
      if (!res.ok) throw new Error(`tile ${z}/${x}/${y}: ${res.status}`);
      let buf = Buffer.from(await res.arrayBuffer());
      if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
      const layer = new VectorTile(new Pbf(buf)).layers[SOURCE_LAYER];
      if (!layer) continue;
      let n = 0;
      for (let i = 0; i < layer.length; i++) {
        const f = layer.feature(i);
        if (f.id !== undefined && seen.has(f.id)) continue; // tile buffers duplicate edge points
        if (f.id !== undefined) seen.add(f.id);
        const p = f.properties;
        if (p.CityID !== undefined && p.CityID !== CITY_ID) continue;
        const loc = p.LocalityID;
        const mm = p.MicroMarketID;
        const status = p.Status || "Unknown";
        total++;
        n++;
        if (loc !== undefined) {
          byLocality[loc] = (byLocality[loc] || 0) + 1;
          byLocalityStatus[loc] = byLocalityStatus[loc] || {};
          byLocalityStatus[loc][status] = (byLocalityStatus[loc][status] || 0) + 1;
        }
        if (mm !== undefined) byMicromarket[mm] = (byMicromarket[mm] || 0) + 1;
        byStatus[status] = (byStatus[status] || 0) + 1;
      }
      console.log(`  ${z}/${x}/${y}: ${layer.length} features, ${n} new`);
    }
  }

  const out = {
    cityId: CITY_ID,
    generatedAt: new Date().toISOString(),
    zoom: z,
    total,
    byStatus,
    byMicromarket,
    byLocality,
    byLocalityStatus,
  };
  const dest = path.join("public", "dim", `project_counts_city${CITY_ID}.json`);
  fs.writeFileSync(dest, JSON.stringify(out));
  console.log(`wrote ${dest}: ${total} projects, ${Object.keys(byLocality).length} localities, ${Object.keys(byMicromarket).length} micromarkets`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
