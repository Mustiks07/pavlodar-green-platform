import { describe, expect, it } from 'vitest';
import { add, commit, historyOf, insideZone, issuesOf, mergePlacements, metersBetween, move, newPlacement, redo, remove, snapToCrownTangent, undo, update } from './placements';

const P = (id: string, x = 77, plant = 'p1') => newPlacement(plant, [x, 52.3], '2027-04-15', id);

describe('placement history', () => {
  it('commit/undo/redo; a no-op change adds no history', () => {
    let h = historyOf([P('a')]);
    h = commit(h, add(h.present, P('b')));
    expect(h.present.map((p) => p.id)).toEqual(['a', 'b']);
    expect(commit(h, [...h.present])).toBe(h);
    h = undo(h);
    expect(h.present.map((p) => p.id)).toEqual(['a']);
    h = redo(h);
    expect(h.present.map((p) => p.id)).toEqual(['a', 'b']);
  });
  it('ids are stable through edits and moves; locked placements do not move', () => {
    const list = [P('a'), { ...P('b'), locked: true }];
    const moved = move(list, 'b', [78, 53]);
    expect(moved[1]!.position.coordinates).toEqual([77, 52.3]);
    const m2 = move(list, 'a', [78, 53]);
    expect(m2[0]!.id).toBe('a');
    expect(m2[0]!.position.coordinates).toEqual([78, 53]);
    expect(update(list, 'a', { quantity: 3 })[0]).toMatchObject({ id: 'a', quantity: 3 });
    const stocked = { ...P('stocked'), stock_item_id: '00000000-0000-4000-8000-000000000001' };
    expect(update([stocked], 'stocked', { plant_id: 'p2', stock_item_id: null })[0]).toMatchObject({ id: 'stocked', plant_id: 'p2', stock_item_id: null });
    expect(remove(list, 'a').map((p) => p.id)).toEqual(['b']);
  });
  it('new placements carry no invented dimensions', () => {
    const p = newPlacement('plant', [77, 52], '2027-05-01');
    expect(p).toMatchObject({ initial_height_m: null, initial_crown_radius_m: null, dimension_basis: 'unknown', quantity: 1, locked: false });
    expect(p.id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('local issues: date, quantity, dimension without basis, duplicate id', () => {
    const bad = [{ ...P('a'), planting_date: '' }, { ...P('b'), quantity: 0 }, { ...P('c'), initial_height_m: 2 }, P('c')];
    const issues = issuesOf(bad);
    expect(issues.get('a')).toEqual(['no_date']);
    expect(issues.get('b')).toEqual(['bad_quantity']);
    expect(issues.get('c')).toEqual(['dimension_without_basis', 'duplicate_id']);
  });
  it('previews known crown overlap but does not invent an unknown footprint', () => {
    const known = (id: string, x: number) => ({ ...P(id, x), initial_crown_radius_m: 2, dimension_basis: 'measured' as const });
    const issues = issuesOf([known('a', 77), known('b', 77.00001), P('unknown', 77)]);
    expect(issues.get('a')).toContain('crown_overlap');
    expect(issues.get('b')).toContain('crown_overlap');
    expect(issues.get('unknown')).toBeUndefined();
  });
  it('snaps a known crown to exact tangency without moving unknown dimensions', () => {
    const known = (id: string, x: number, radius: number | null, basis: 'measured' | 'unknown' = 'measured') => ({ ...P(id, x), initial_crown_radius_m: radius, dimension_basis: basis });
    const list = [known('moving', 77, 2), known('fixed', 77.00005, 3), known('unknown', 77.0001, null, 'unknown')];
    const snapped = snapToCrownTangent(list, 'moving', [77.000045, 52.3], 10);
    expect(snapped).not.toBeNull();
    expect(metersBetween(snapped!, list[1]!.position.coordinates as [number, number])).toBeCloseTo(5, 3);
    expect(snapToCrownTangent(list, 'unknown', [77.00005, 52.3], 10)).toBeNull();
  });
});

describe('three-way merge after 412', () => {
  const original = [P('a'), P('b'), P('c')];
  it('replays my add/edit/delete on their revision and keeps their unrelated changes', () => {
    const mine = [{ ...P('a'), quantity: 5 }, P('c'), P('m')]; // edit a, delete b, add m
    const theirs = [P('a'), P('b'), { ...P('c'), locked: true }, P('t')]; // edit c, add t
    const r = mergePlacements(original, mine, theirs);
    expect(r.placements.map((p) => p.id)).toEqual(['a', 'c', 't', 'm']);
    expect(r.placements.find((p) => p.id === 'a')!.quantity).toBe(5);
    expect(r.placements.find((p) => p.id === 'c')!.locked).toBe(true);
    expect(r.conflicts).toEqual([]);
  });
  it('reports collisions: both changed (mine wins), I changed what they deleted, I deleted what they changed', () => {
    const mine = [{ ...P('a'), quantity: 2 }, { ...P('b'), quantity: 3 }]; // edit a, edit b, delete c
    const theirs = [{ ...P('a'), quantity: 9 }, { ...P('c'), quantity: 4 }]; // edit a, delete b, edit c
    const r = mergePlacements(original, mine, theirs);
    expect(r.conflicts).toEqual([
      { id: 'a', kind: 'both_changed' },
      { id: 'b', kind: 'changed_deleted' },
      { id: 'c', kind: 'deleted_changed' },
    ]);
    expect(r.placements.find((p) => p.id === 'a')!.quantity).toBe(2);
    expect(r.placements.find((p) => p.id === 'b')!.quantity).toBe(3);
    expect(r.placements.find((p) => p.id === 'c')!.quantity).toBe(4);
  });
});

describe('zone preview check', () => {
  const square = { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]] };
  it('inside the outer ring, outside holes and other polygons', () => {
    expect(insideZone([1, 1], square)).toBe(true);
    expect(insideZone([5, 5], square)).toBe(false);
    expect(insideZone([11, 1], square)).toBe(false);
    expect(insideZone([21, 1], { type: 'MultiPolygon', coordinates: [square.coordinates, [[[20, 0], [22, 0], [22, 2], [20, 2], [20, 0]]]] })).toBe(true);
  });
});
