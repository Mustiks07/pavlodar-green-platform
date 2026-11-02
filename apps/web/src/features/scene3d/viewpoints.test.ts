import { describe, expect, it } from 'vitest';
import type { AreaPatch, Placement, Zone } from '@pg/api-client';
import { geometryCenter, humanCameraPoint, viewTarget } from './viewpoints';

const zone = {
  id: 'zone', version_id: 'zone-version', city_id: 'city', name: 'Двор', purpose: 'courtyard', area_m2: 1,
  geometry: { type: 'Polygon', coordinates: [[[76.9, 52.2], [76.902, 52.2], [76.902, 52.202], [76.9, 52.202], [76.9, 52.2]]] },
  data_gaps: [], updated_at: '2026-11-02T00:00:00Z',
} as Zone;
const placement = { id: 'point', position: { type: 'Point', coordinates: [76.901, 52.201] } } as Placement;
const patch = { id: 'area', geometry: { type: 'Polygon', coordinates: [[[76.9, 52.2], [76.901, 52.2], [76.901, 52.201], [76.9, 52.2]]] } } as AreaPatch;

describe('fixed 3D viewpoints', () => {
  it('targets a selected point, then an area, then the zone', () => {
    expect(viewTarget(zone, [placement], 'point', [patch], null)).toEqual({ id: 'point', center: [76.901, 52.201] });
    expect(viewTarget(zone, [placement], null, [patch], 'area').center[0]).toBeCloseTo(76.9005, 8);
    expect(viewTarget(zone, [placement], null, [patch], 'area').center[1]).toBeCloseTo(52.2005, 8);
    expect(viewTarget(zone, [], null, [], null).id).toBe('zone-version');
  });

  it('places the eye point at a deterministic distance and direction', () => {
    const north = humanCameraPoint([76.9, 52.2], 0, 18);
    expect(north[0]).toBeCloseTo(76.9, 8);
    expect(north[1]).toBeLessThan(52.2);
    expect(geometryCenter(zone.geometry)[0]).toBeCloseTo(76.901, 8);
    expect(geometryCenter(zone.geometry)[1]).toBeCloseTo(52.201, 8);
  });
});
