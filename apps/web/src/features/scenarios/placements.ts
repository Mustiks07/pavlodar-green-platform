/**
 * Placement editing state for a scenario revision draft. Placements are keyed by their stable
 * `id` (UUID made once on the client and kept by every later revision); nothing here computes
 * cost, survival or any other outcome — the server owns those numbers.
 */
import type { Placement } from '@pg/api-client';

export type LngLat = [number, number];

export interface PlacementHistory {
  present: Placement[];
  past: Placement[][];
  future: Placement[][];
}

export const historyOf = (present: Placement[]): PlacementHistory => ({ present, past: [], future: [] });

export function commit(h: PlacementHistory, next: Placement[]): PlacementHistory {
  if (same(h.present, next)) return h;
  return { present: next, past: [...h.past, h.present].slice(-100), future: [] };
}

export function undo(h: PlacementHistory): PlacementHistory {
  const prev = h.past[h.past.length - 1];
  return prev ? { present: prev, past: h.past.slice(0, -1), future: [h.present, ...h.future] } : h;
}

export function redo(h: PlacementHistory): PlacementHistory {
  const next = h.future[0];
  return next ? { present: next, past: [...h.past, h.present], future: h.future.slice(1) } : h;
}

export function newPlacement(plantId: string, at: LngLat, plantingDate: string, id: string = crypto.randomUUID()): Placement {
  return {
    id,
    plant_id: plantId,
    stock_item_id: null,
    position: { type: 'Point', coordinates: at },
    quantity: 1,
    planting_date: plantingDate,
    locked: false,
    // No dimensions are invented: unknown until the user enters a value with its basis.
    initial_height_m: null,
    initial_crown_radius_m: null,
    dimension_basis: 'unknown',
  };
}

export const add = (list: Placement[], p: Placement): Placement[] => [...list, p];
export const remove = (list: Placement[], id: string): Placement[] => list.filter((p) => p.id !== id);
export const update = (list: Placement[], id: string, patch: Partial<Omit<Placement, 'id'>>): Placement[] =>
  list.map((p) => (p.id === id ? { ...p, ...patch } : p));
/** Moving a locked placement is refused: locked means "keep exactly here". */
export const move = (list: Placement[], id: string, at: LngLat): Placement[] =>
  list.map((p) => (p.id === id && !p.locked ? { ...p, position: { type: 'Point', coordinates: at } } : p));

const key = (p: Placement) => JSON.stringify(p);
export function same(a: Placement[], b: Placement[]): boolean {
  return a.length === b.length && a.every((p, i) => key(p) === key(b[i]!));
}

/** Local problems the user can fix before sending; the server stays the authority. */
export type PlacementIssue = 'no_date' | 'bad_quantity' | 'dimension_without_basis' | 'duplicate_id';
export function issuesOf(list: Placement[]): Map<string, PlacementIssue[]> {
  const out = new Map<string, PlacementIssue[]>();
  const seen = new Set<string>();
  for (const p of list) {
    const issues: PlacementIssue[] = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.planting_date)) issues.push('no_date');
    if (!Number.isInteger(p.quantity) || p.quantity < 1) issues.push('bad_quantity');
    if ((p.initial_height_m !== null || p.initial_crown_radius_m !== null) && p.dimension_basis === 'unknown') issues.push('dimension_without_basis');
    if (seen.has(p.id)) issues.push('duplicate_id');
    seen.add(p.id);
    if (issues.length) out.set(p.id, [...(out.get(p.id) ?? []), ...issues]);
  }
  return out;
}

export interface MergeResult {
  placements: Placement[];
  /** Placement ids where my change and the server's change touched the same placement. */
  conflicts: { id: string; kind: 'both_changed' | 'changed_deleted' | 'deleted_changed' }[];
}

/**
 * Three-way merge after 412: `original` is the revision my draft started from, `mine` my draft,
 * `theirs` the server's new current revision. My additions, edits and deletions are replayed on
 * theirs by id; a placement both sides changed keeps my version, and each such case is reported.
 */
export function mergePlacements(original: Placement[], mine: Placement[], theirs: Placement[]): MergeResult {
  const o = new Map(original.map((p) => [p.id, p]));
  const m = new Map(mine.map((p) => [p.id, p]));
  const result = new Map(theirs.map((p) => [p.id, p]));
  const conflicts: MergeResult['conflicts'] = [];
  for (const [id, mp] of m) {
    const op = o.get(id);
    if (!op) {
      result.set(id, mp);
      continue;
    }
    if (key(mp) === key(op)) continue;
    const tp = result.get(id);
    if (!tp) conflicts.push({ id, kind: 'changed_deleted' });
    else if (key(tp) !== key(op)) conflicts.push({ id, kind: 'both_changed' });
    result.set(id, mp);
  }
  for (const [id, op] of o) {
    if (m.has(id)) continue;
    const tp = result.get(id);
    if (tp && key(tp) !== key(op)) {
      // They edited what I deleted: keep their edit, the user decides again.
      conflicts.push({ id, kind: 'deleted_changed' });
      continue;
    }
    result.delete(id);
  }
  // Their order first, my additions after: stable for the reviewer.
  const order = [...theirs.map((p) => p.id), ...mine.map((p) => p.id)];
  const placements = [...new Set(order)].filter((id) => result.has(id)).map((id) => result.get(id)!);
  return { placements, conflicts };
}

function inRing(pt: LngLat, ring: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Preview only: is the point inside the zone polygon (holes excluded)? The server decides
 * placement validity; this lets the editor warn before sending.
 */
export function insideZone(pt: LngLat, geometry: { type: string; coordinates: unknown }): boolean {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates as LngLat[][]] : geometry.type === 'MultiPolygon' ? (geometry.coordinates as LngLat[][][]) : [];
  return polys.some(([outer, ...holes]) => Boolean(outer) && inRing(pt, outer!) && !holes.some((h) => inRing(pt, h)));
}
