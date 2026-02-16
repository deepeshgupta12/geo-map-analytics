// scripts/tileset_layers.mjs
const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || process.env.MAPBOX_TOKEN;

if (!token) {
  console.error("Missing token. Set NEXT_PUBLIC_MAPBOX_TOKEN in .env.local or MAPBOX_TOKEN in env.");
  process.exit(1);
}

const tilesets = [
  ["city", process.env.NEXT_PUBLIC_TILESET_CITY],
  ["micromarkets", process.env.NEXT_PUBLIC_TILESET_MICROMARKETS],
  ["localities", process.env.NEXT_PUBLIC_TILESET_LOCALITIES],
  ["roads", process.env.NEXT_PUBLIC_TILESET_ROADS],
  ["projects", process.env.NEXT_PUBLIC_TILESET_PROJECTS],
].filter(([, id]) => !!id);

async function fetchMeta(tilesetId) {
  // v4 tileset metadata returns vector_layers with "id" (this is the source-layer)
  const url = `https://api.mapbox.com/v4/${tilesetId}.json?secure=true&access_token=${token}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed ${tilesetId}: ${res.status} ${text}`);
  }
  return res.json();
}

(async () => {
  for (const [label, tilesetId] of tilesets) {
    const meta = await fetchMeta(tilesetId);
    const vectorLayers = meta.vector_layers || [];
    const layerIds = vectorLayers.map((v) => v.id);

    console.log(`\n${label}`);
    console.log(`tileset: ${tilesetId}`);
    console.log(`vector layer ids (use as source-layer):`);
    for (const id of layerIds) console.log(`- ${id}`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});