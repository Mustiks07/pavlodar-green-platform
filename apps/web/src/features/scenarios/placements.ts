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
export type PlacementIssue = 'no_date' | 'bad_quantity' | 'dimension_without_basis' | 'duplicate_id' | 'crown_overlap';
export const metersBetween = (a: LngLat, b: LngLat): number => {
  const lat = ((a[1] + b[1]) / 2) * Math.PI / 180;
  const dx = (a[0] - b[0]) * 111_320 * Math.cos(lat);
  const dy = (a[1] - b[1]) * 110_540;
  return Math.hypot(dx, dy);
};

/** Preview snap to the nearest recorded crown tangent. The server remains authoritative. */
export function snapToCrownTangent(list: Placement[], movingId: string, at: LngLat, maxDistanceM: number): LngLat | null {
  const moving = list.find((placement) => placement.id === movingId);
  const movingRadius = moving?.dimension_basis === 'unknown' ? null : moving?.initial_crown_radius_m;
  if (!movingRadius || movingRadius <= 0) return null;
  let best: { gap: number; point: LngLat } | null = null;
  for (const placement of list) {
    const radius = placement.dimension_basis === 'unknown' ? null : placement.initial_crown_radius_m;
    if (placement.id === movingId || !radius || radius <= 0) continue;
    const center = placement.position.coordinates as LngLat;
    const latScale = 110_540;
    const lonScale = 111_320 * Math.cos(((at[1] + center[1]) / 2) * Math.PI / 180);
    const dx = (at[0] - center[0]) * lonScale;
    const dy = (at[1] - center[1]) * latScale;
    const distance = Math.hypot(dx, dy);
    const target = movingRadius + radius;
    const gap = Math.abs(distance - target);
    if (distance < 1e-6 || gap > maxDistanceM || (best && gap >= best.gap)) continue;
    best = {
      gap,
      point: [center[0] + (dx / distance * target) / lonScale, center[1] + (dy / distance * target) / latScale],
    };
  }
  return best?.point ?? null;
}
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
  const known = list.filter((placement) => placement.dimension_basis !== 'unknown' && (placement.initial_crown_radius_m ?? 0) > 0);
  for (let left = 0; left < known.length; left += 1) {
    for (let right = left + 1; right < known.length; right += 1) {
      const a = known[left]!;
      const b = known[right]!;
      if (metersBetween(a.position.coordinates as LngLat, b.position.coordinates as LngLat) + 1e-6 >= a.initial_crown_radius_m! + b.initial_crown_radius_m!) continue;
      for (const placement of [a, b]) out.set(placement.id, [...new Set([...(out.get(placement.id) ?? []), 'crown_overlap' as const])]);
    }
  }
  return out;
}

export interface MergeResult {
  placements: Placement[];
  /** Placement ids where my change and the server's change touched the same placement. */
  conflicts: { id: string; kind: 'both_changed' | 'changed_deleted' | 'deleted_changed' }[];
}

export interface StableMergeResult<T extends { id: string }> {
  items: T[];
  conflicts: MergeResult['conflicts'];
}

/** Three-way merge for any immutable-revision child keyed by a stable id. */
export function mergeStableItems<T extends { id: string }>(original: T[], mine: T[], theirs: T[]): StableMergeResult<T> {
  const serialized = (item: T) => JSON.stringify(item);
  const o = new Map(original.map((item) => [item.id, item]));
  const m = new Map(mine.map((item) => [item.id, item]));
  const result = new Map(theirs.map((item) => [item.id, item]));
  const conflicts: MergeResult['conflicts'] = [];
  for (const [id, mineItem] of m) {
    const originalItem = o.get(id);
    if (!originalItem) {
      result.set(id, mineItem);
      continue;
    }
    if (serialized(mineItem) === serialized(originalItem)) continue;
    const theirItem = result.get(id);
    if (!theirItem) conflicts.push({ id, kind: 'changed_deleted' });
    else if (serialized(theirItem) !== serialized(originalItem)) conflicts.push({ id, kind: 'both_changed' });
    result.set(id, mineItem);
  }
  for (const [id, originalItem] of o) {
    if (m.has(id)) continue;
    const theirItem = result.get(id);
    if (theirItem && serialized(theirItem) !== serialized(originalItem)) {
      conflicts.push({ id, kind: 'deleted_changed' });
      continue;
    }
    result.delete(id);
  }
  const order = [...theirs.map((item) => item.id), ...mine.map((item) => item.id)];
  const items = [...new Set(order)].filter((id) => result.has(id)).map((id) => result.get(id)!);
  return { items, conflicts };
}

/**
 * Three-way merge after 412: `original` is the revision my draft started from, `mine` my draft,
 * `theirs` the server's new current revision. My additions, edits and deletions are replayed on
 * theirs by id; a placement both sides changed keeps my version, and each such case is reported.
 */
export function mergePlacements(original: Placement[], mine: Placement[], theirs: Placement[]): MergeResult {
  const merged = mergeStableItems(original, mine, theirs);
  return { placements: merged.items, conflicts: merged.conflicts };
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
