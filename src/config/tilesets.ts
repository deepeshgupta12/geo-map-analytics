// src/config/tilesets.ts
export type TilesetConfig = {
  id: string;          // tileset id (mapbox username.tileset)
  sourceLayer: string; // vector layer id inside tileset
};

export const TILESETS = {
  city: {
    id: process.env.NEXT_PUBLIC_TILESET_CITY!,
    sourceLayer: "mumbai_city",
  },
  micromarkets: {
    id: process.env.NEXT_PUBLIC_TILESET_MICROMARKETS!,
    sourceLayer: "mumbai_micro_markets",
  },
  localities: {
    id: process.env.NEXT_PUBLIC_TILESET_LOCALITIES!,
    sourceLayer: "mumbai_localities",
  },
  roads: {
    id: process.env.NEXT_PUBLIC_TILESET_ROADS!,
    sourceLayer: "mumbai_roads",
  },
  projects: {
    id: process.env.NEXT_PUBLIC_TILESET_PROJECTS!,
    sourceLayer: "mumbai_projects",
  },
} satisfies Record<string, TilesetConfig>;