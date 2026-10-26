// src/lib/projects.ts
// Per-project inputs for 3D renderings and project cards. One folder per project
// under public/projects/<slug>/ holding project.json plus the developer attachments
// (master plan image, GLB model, exterior photos). public/projects/index.json lists
// the slugs the app should load.

export type LngLat = [number, number];

export type TowerSpec = {
  name: string;
  phase?: string | null;
  rera?: string | null;
  wings?: string[];
  floors: number | null;
  heightM: number | null;
  /** Polygon ring(s) in [lng, lat] if the tower footprint is known. */
  footprint: LngLat[][] | null;
  /** Rotation of the tower's front from north, clockwise, in degrees. */
  headingDeg: number | null;
  /** "H" renders a twin-wing block from the footprint rectangle; anything else uses the ring as-is. */
  shape?: string | null;
  /** Future phases are never extruded (dashed ground outline only). */
  futureDevelopment?: boolean;
};

export type FutureDevelopmentSpec = {
  name: string;
  footprint?: LngLat[][] | null;
  render?: boolean;
  source?: string;
  note?: string;
};

export type ProjectSpec = {
  slug: string;
  name: string;
  developer?: string | null;
  status?: string | null;
  possession?: string | null;
  ids: { project: number | null; locality: number | null; micromarket: number | null };
  locality?: string | null;
  micromarket?: string | null;
  location: { lng: number; lat: number };
  plot: { type: "Polygon"; coordinates: LngLat[][]; placeholder?: boolean };
  areaAcres?: number | null;
  towerCount: number | null;
  floors: number | null;
  units: number | null;
  podiumLevels?: number | null;
  towers: TowerSpec[];
  futureDevelopment?: FutureDevelopmentSpec[];
  facade?: { base: string; accent: string; glass: string };
  masterPlan: { image: string; attached?: boolean; analysis?: string };
  model: {
    file: string | null;
    attached?: boolean;
    procedural?: boolean;
    units?: "metres";
    scale?: number;
    headingDeg?: number;
    anchor?: "location" | "plotCentroid";
    elevationM?: number;
  };
  card: {
    image: string;
    images?: string[];
    priceRange: string | null;
    pricePsf: number | null;
    configurations: string[];
    sizeRange?: string | null;
    units?: number | null;
    totalArea?: string | null;
    rera?: string | string[] | null;
    reraUrl?: string | null;
    url?: string | null;
  };
};

export type LoadedProject = ProjectSpec & {
  /** Base URL of the project folder, e.g. "/projects/godrej-horizon-wadala". */
  baseUrl: string;
};

export async function loadProjects(): Promise<LoadedProject[]> {
  const res = await fetch("/projects/index.json", { cache: "no-store" });
  if (!res.ok) return [];
  const slugs = (await res.json()) as string[];
  const out: LoadedProject[] = [];
  for (const slug of slugs) {
    try {
      const r = await fetch(`/projects/${slug}/project.json`, { cache: "no-store" });
      if (!r.ok) continue;
      const spec = (await r.json()) as ProjectSpec;
      out.push({ ...spec, baseUrl: `/projects/${slug}` });
    } catch (e) {
      console.warn(`project ${slug} failed to load`, e);
    }
  }
  return out;
}

/** Approximate centroid of the plot ring (plain average of the vertices). */
export function plotCentroid(p: ProjectSpec): LngLat {
  const ring = p.plot?.coordinates?.[0];
  if (!ring || ring.length < 3) return [p.location.lng, p.location.lat];
  let x = 0;
  let y = 0;
  const n = ring.length - 1; // closing vertex repeats the first
  for (let i = 0; i < n; i++) {
    x += ring[i]![0];
    y += ring[i]![1];
  }
  return [x / n, y / n];
}
