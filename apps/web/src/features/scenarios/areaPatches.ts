import type { AreaPatch } from '@pg/api-client';

export type LngLat = [number, number];

export interface AreaPatchHistory {
  past: AreaPatch[][];
  future: AreaPatch[][];
}

const same = (left: AreaPatch[], right: AreaPatch[]) => JSON.stringify(left) === JSON.stringify(right);

export function commitAreaPatches(current: AreaPatch[], next: AreaPatch[], history: AreaPatchHistory) {
  if (same(current, next)) return { present: current, history };
  return {
    present: next,
    history: { past: [...history.past, current].slice(-100), future: [] } satisfies AreaPatchHistory,
  };
}

export function undoAreaPatches(current: AreaPatch[], history: AreaPatchHistory) {
  const previous = history.past.at(-1);
  if (!previous) return { present: current, history };
  return {
    present: previous,
    history: { past: history.past.slice(0, -1), future: [current, ...history.future] },
  };
}

export function redoAreaPatches(current: AreaPatch[], history: AreaPatchHistory) {
  const next = history.future[0];
  if (!next) return { present: current, history };
  return {
    present: next,
    history: { past: [...history.past, current].slice(-100), future: history.future.slice(1) },
  };
}

type AreaGeometry =
  | { type: 'Polygon'; coordinates: LngLat[][] }
  | { type: 'MultiPolygon'; coordinates: LngLat[][][] };

const areaGeometry = (patch: AreaPatch): AreaGeometry => patch.geometry as AreaGeometry;

function ringsOf(geometry: AreaGeometry): LngLat[][] {
  return geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates.flat();
}

function centerOf(geometry: AreaGeometry): LngLat {
  const points = ringsOf(geometry).flatMap((ring) => (
    ring.length > 1 && ring[0]![0] === ring.at(-1)![0] && ring[0]![1] === ring.at(-1)![1]
      ? ring.slice(0, -1)
      : ring
  ));
  if (!points.length) return [0, 0];
  return [
    points.reduce((sum, point) => sum + point[0], 0) / points.length,
    points.reduce((sum, point) => sum + point[1], 0) / points.length,
  ];
}

const metresPerDegree = (latitude: number): LngLat => [
  111_320 * Math.max(0.01, Math.cos(latitude * Math.PI / 180)),
  110_574,
];

function transformPatch(patch: AreaPatch, transform: (east: number, north: number) => [number, number]): AreaPatch {
  if (patch.locked) return patch;
  const geometry = areaGeometry(patch);
  const center = centerOf(geometry);
  const scale = metresPerDegree(center[1]);
  const mapRing = (ring: LngLat[]) => ring.map(([longitude, latitude]) => {
    const [east, north] = transform((longitude - center[0]) * scale[0], (latitude - center[1]) * scale[1]);
    return [center[0] + east / scale[0], center[1] + north / scale[1]] as LngLat;
  });
  const transformed: AreaGeometry = geometry.type === 'Polygon'
    ? { type: 'Polygon', coordinates: geometry.coordinates.map(mapRing) }
    : { type: 'MultiPolygon', coordinates: geometry.coordinates.map((polygon) => polygon.map(mapRing)) };
  return { ...patch, geometry: transformed };
}

/** Client editing transform only; the server validates geometry and computes authoritative area. */
export function translateAreaPatch(patch: AreaPatch, eastMetres: number, northMetres: number): AreaPatch {
  return transformPatch(patch, (east, north) => [east + eastMetres, north + northMetres]);
}

export function translateAreaPatchBetween(patch: AreaPatch, from: LngLat, to: LngLat): AreaPatch {
  const scale = metresPerDegree((from[1] + to[1]) / 2);
  return translateAreaPatch(patch, (to[0] - from[0]) * scale[0], (to[1] - from[1]) * scale[1]);
}

export function rotateAreaPatch(patch: AreaPatch, degrees: number): AreaPatch {
  const radians = degrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return transformPatch(patch, (east, north) => [
    east * cosine - north * sine,
    east * sine + north * cosine,
  ]);
}
