import { describe, expect, it } from 'vitest';
import type { AreaPatch } from '@pg/api-client';
import { commitAreaPatches, redoAreaPatches, rotateAreaPatch, translateAreaPatch, undoAreaPatches } from './areaPatches';

const patch: AreaPatch = {
  id: '00000000-0000-4000-8000-000000000001',
  plant_id: '00000000-0000-4000-8000-000000000002',
  geometry: { type: 'Polygon', coordinates: [[[76.9, 52.2], [76.901, 52.2], [76.9004, 52.2005], [76.9, 52.2]]] },
  planting_date: '2027-04-15',
  locked: false,
  density_plants_per_m2: 2,
};

describe('area patch transforms', () => {
  it('moves and rotates geometry without changing stable properties or ring closure', () => {
    const moved = translateAreaPatch(patch, 5, -3);
    const rotated = rotateAreaPatch(moved, 90);
    expect(rotated).toMatchObject({ id: patch.id, plant_id: patch.plant_id, planting_date: patch.planting_date, density_plants_per_m2: 2 });
    const ring = rotated.geometry.type === 'Polygon' ? rotated.geometry.coordinates[0]! : [];
    expect(ring[0]).toEqual(ring.at(-1));
    expect(rotated.geometry).not.toEqual(patch.geometry);
  });

  it('refuses locked transforms and moves a multi-part patch as one object', () => {
    expect(translateAreaPatch({ ...patch, locked: true }, 10, 0).geometry).toEqual(patch.geometry);
    const multi = { ...patch, geometry: { type: 'MultiPolygon' as const, coordinates: [patch.geometry.type === 'Polygon' ? patch.geometry.coordinates : []] } } as AreaPatch;
    expect(rotateAreaPatch(multi, 15).geometry).not.toEqual(multi.geometry);
  });

  it('undo and redo restore the exact arrays including lock and delete', () => {
    const initial = [patch];
    const locked = [{ ...patch, locked: true }];
    let result = commitAreaPatches(initial, locked, { past: [], future: [] });
    result = undoAreaPatches(result.present, result.history);
    expect(result.present).toEqual(initial);
    result = redoAreaPatches(result.present, result.history);
    expect(result.present).toEqual(locked);
  });
});
