import type { AreaPatch, Placement, Zone } from '@pg/api-client';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { maplibregl } from '../map/maplibre';

export type ViewPreset = 'top' | 'overview' | 'human';
export type ViewTarget = { id: string; center: [number, number] };

const EARTH_METRES_PER_DEGREE = 111_320;

function geometryBounds(geometry: Zone['geometry']): [number, number, number, number] {
  const bounds: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  for (const polygon of polygons) for (const ring of polygon) for (const coordinate of ring) {
    bounds[0] = Math.min(bounds[0], coordinate[0]!);
    bounds[1] = Math.min(bounds[1], coordinate[1]!);
    bounds[2] = Math.max(bounds[2], coordinate[0]!);
    bounds[3] = Math.max(bounds[3], coordinate[1]!);
  }
  return bounds;
}

export function geometryCenter(geometry: Zone['geometry']): [number, number] {
  const [west, south, east, north] = geometryBounds(geometry);
  return [(west + east) / 2, (south + north) / 2];
}

export function viewTarget(
  zone: Zone,
  placements: Placement[],
  selectedPlacementId: string | null,
  areaPatches: AreaPatch[],
  selectedAreaPatchId: string | null,
): ViewTarget {
  const placement = placements.find((item) => item.id === selectedPlacementId);
  if (placement) return { id: placement.id, center: placement.position.coordinates as [number, number] };
  const patch = areaPatches.find((item) => item.id === selectedAreaPatchId);
  if (patch) return { id: patch.id, center: geometryCenter(patch.geometry) };
  return { id: zone.version_id, center: geometryCenter(zone.geometry) };
}

/** Camera point at a fixed ground distance from the target, looking along the chosen bearing. */
export function humanCameraPoint(target: [number, number], bearing: number, distanceMetres = 18): [number, number] {
  const radians = bearing * Math.PI / 180;
  const latScale = EARTH_METRES_PER_DEGREE;
  const lonScale = latScale * Math.cos(target[1] * Math.PI / 180);
  return [
    target[0] - Math.sin(radians) * distanceMetres / lonScale,
    target[1] - Math.cos(radians) * distanceMetres / latScale,
  ];
}

export function applyViewpoint(map: MapLibreMap, zone: Zone, preset: ViewPreset, target: ViewTarget, bearing = 25): void {
  const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 300;
  if (preset === 'top') {
    map.fitBounds(geometryBounds(zone.geometry), { padding: 48, maxZoom: 19, pitch: 0, bearing: 0, duration });
    return;
  }
  if (preset === 'overview') {
    map.fitBounds(geometryBounds(zone.geometry), { padding: 56, maxZoom: 17, pitch: 55, bearing, duration });
    return;
  }
  const from = humanCameraPoint(target.center, bearing);
  const options = map.calculateCameraOptionsFromTo(
    new maplibregl.LngLat(from[0], from[1]),
    1.7,
    new maplibregl.LngLat(target.center[0], target.center[1]),
    0,
  );
  map.easeTo({ ...options, duration });
}

