/**
 * Input model of the 3D layer. It is a rendering view model, not an API DTO: once contract
 * 1.1.0 adds building height_m/height_basis (ADR-004 §6), an adapter maps the generated type
 * onto it. Nothing here supplies heights: a missing height is rendered as a flat footprint.
 */
import type { MapFeature } from '@pg/api-client';

export type HeightBasis = MapFeature['height_basis'];

export interface SceneBuilding {
  id: string;
  /** Outer ring, EPSG:4326 [lng, lat], closed or open. */
  footprint: [number, number][];
  /** Height in metres exactly as delivered by the server; null = unknown. */
  height_m: number | null;
  height_basis: HeightBasis;
}

/** A server placement shown in the project editor. Unknown dimensions stay schematic. */
export interface ScenePlanting {
  id: string;
  position: [number, number];
  quantity: number;
  height_m: number | null;
  crown_radius_m: number | null;
  selected: boolean;
  locked: boolean;
  conflict: boolean;
}

export interface SceneStats {
  buildingsByBasis: Record<HeightBasis, number>;
  plantings: number;
  geometries: number;
  textures: number;
  programs: number;
  drawCalls: number;
  triangles: number;
  disposed: boolean;
  /** renderer.info.memory.geometries right after releasing content, before renderer.dispose(). */
  geometriesAfterRelease: number | null;
}

/** How each basis is drawn; used by tests to prove the visual distinction. */
export interface BasisStyle {
  basis: HeightBasis;
  extruded: boolean;
  fillOpacity: number | null;
  dashedEdges: boolean;
}

export interface SceneHandle {
  setBuildings(buildings: SceneBuilding[]): void;
  setPlantings(plantings: ScenePlanting[]): void;
  stats(): SceneStats;
  /** Ground-level alignment of Three vs MapLibre for one vertex, in CSS pixels. */
  alignmentErrorPx(lngLat: [number, number]): number | null;
  describe(): BasisStyle[];
  remove(): void;
}
