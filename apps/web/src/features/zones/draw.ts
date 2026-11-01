/**
 * Polygon drawing state and preview checks. These are editing aids only: validity,
 * area and topology are decided by the server (F-MAP-03, F-DATA-03). Coordinates are
 * EPSG:4326 [longitude, latitude]; nothing here measures metres.
 */
export type LngLat = [number, number];

export interface DrawState {
  mode: 'create' | 'edit';
  /** Zone being edited (edit mode). */
  zoneId: string | null;
  /** Open ring without the closing duplicate vertex. */
  vertices: LngLat[];
  closed: boolean;
  past: { vertices: LngLat[]; closed: boolean }[];
  future: { vertices: LngLat[]; closed: boolean }[];
  /** Vertex chosen for touch/keyboard editing. A view state: not part of undo history or drafts. */
  selected?: number | null;
}

export function startDraw(mode: 'create' | 'edit', zoneId: string | null = null, vertices: LngLat[] = []): DrawState {
  return { mode, zoneId, vertices, closed: vertices.length >= 3, past: [], future: [] };
}

const validSelection = (sel: number | null | undefined, n: number) => (sel != null && sel >= 0 && sel < n ? sel : null);

function commit(s: DrawState, vertices: LngLat[], closed: boolean): DrawState {
  return {
    ...s,
    vertices,
    closed,
    selected: validSelection(s.selected, vertices.length),
    past: [...s.past, { vertices: s.vertices, closed: s.closed }].slice(-100),
    future: [],
  };
}

export const addVertex = (s: DrawState, p: LngLat): DrawState => (s.closed ? s : { ...commit(s, [...s.vertices, p], false), selected: null });
export const closeRing = (s: DrawState): DrawState => (s.vertices.length >= 3 && !s.closed ? commit(s, s.vertices, true) : s);
export const moveVertex = (s: DrawState, i: number, p: LngLat): DrawState =>
  commit(s, s.vertices.map((v, k) => (k === i ? p : v)), s.closed);
export const insertVertex = (s: DrawState, afterIndex: number, p: LngLat): DrawState => {
  const v = [...s.vertices];
  v.splice(afterIndex + 1, 0, p);
  const sel = s.selected != null && s.selected > afterIndex ? s.selected + 1 : s.selected;
  return { ...commit(s, v, s.closed), selected: validSelection(sel, v.length) };
};
export const removeVertex = (s: DrawState, i: number): DrawState => {
  if (i < 0 || i >= s.vertices.length) return s;
  const v = s.vertices.filter((_, k) => k !== i);
  // Deleting the selected vertex selects its neighbour, so repeated deletes need no re-aiming.
  const sel = s.selected == null ? null : s.selected === i ? Math.min(i, v.length - 1) : s.selected > i ? s.selected - 1 : s.selected;
  return { ...commit(s, v, s.closed && v.length >= 3), selected: v.length ? sel : null };
};

/** Selects vertex i (wrapping), or clears the selection with null. */
export function selectVertex(s: DrawState, i: number | null): DrawState {
  const n = s.vertices.length;
  return { ...s, selected: i === null || n === 0 ? null : ((i % n) + n) % n };
}

export const cycleVertex = (s: DrawState, step: 1 | -1): DrawState =>
  selectVertex(s, s.selected == null ? (step > 0 ? 0 : s.vertices.length - 1) : s.selected + step);

/** Inserts a vertex halfway to the next one (closed ring wraps) and selects it. */
export function insertAfter(s: DrawState, i: number): DrawState {
  const n = s.vertices.length;
  if (i < 0 || i >= n || (!s.closed && i === n - 1) || n < 2) return s;
  const a = s.vertices[i]!;
  const b = s.vertices[(i + 1) % n]!;
  return { ...insertVertex(s, i, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]), selected: i + 1 };
}
export const removeLast = (s: DrawState): DrawState =>
  s.closed ? commit(s, s.vertices, false) : s.vertices.length ? commit(s, s.vertices.slice(0, -1), false) : s;

export function undo(s: DrawState): DrawState {
  const prev = s.past[s.past.length - 1];
  if (!prev) return s;
  return { ...s, ...prev, selected: validSelection(s.selected, prev.vertices.length), past: s.past.slice(0, -1), future: [{ vertices: s.vertices, closed: s.closed }, ...s.future] };
}

export function redo(s: DrawState): DrawState {
  const next = s.future[0];
  if (!next) return s;
  return { ...s, ...next, selected: validSelection(s.selected, next.vertices.length), past: [...s.past, { vertices: s.vertices, closed: s.closed }], future: s.future.slice(1) };
}

/** Midpoints of each closed-ring edge, used as "insert vertex" handles. */
export function midpoints(v: LngLat[]): LngLat[] {
  return v.map((a, i) => {
    const b = v[(i + 1) % v.length]!;
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  });
}

function orient(a: LngLat, b: LngLat, c: LngLat): number {
  const d = (b[1] - a[1]) * (c[0] - b[0]) - (b[0] - a[0]) * (c[1] - b[1]);
  return Math.abs(d) < 1e-15 ? 0 : d > 0 ? 1 : 2;
}

function onSegment(a: LngLat, b: LngLat, c: LngLat): boolean {
  return Math.min(a[0], c[0]) <= b[0] && b[0] <= Math.max(a[0], c[0]) && Math.min(a[1], c[1]) <= b[1] && b[1] <= Math.max(a[1], c[1]);
}

function segmentsIntersect(p1: LngLat, q1: LngLat, p2: LngLat, q2: LngLat): boolean {
  const o1 = orient(p1, q1, p2);
  const o2 = orient(p1, q1, q2);
  const o3 = orient(p2, q2, p1);
  const o4 = orient(p2, q2, q1);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(p1, p2, q1)) return true;
  if (o2 === 0 && onSegment(p1, q2, q1)) return true;
  if (o3 === 0 && onSegment(p2, p1, q2)) return true;
  if (o4 === 0 && onSegment(p2, q1, q2)) return true;
  return false;
}

/** True if any two non-adjacent edges of the closed ring cross or touch. */
export function ringSelfIntersects(v: LngLat[]): boolean {
  const n = v.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a1 = v[i]!;
    const a2 = v[(i + 1) % n]!;
    for (let j = i + 1; j < n; j++) {
      if (j === i || (j + 1) % n === i || j === (i + 1) % n) continue;
      if (segmentsIntersect(a1, a2, v[j]!, v[(j + 1) % n]!)) return true;
    }
  }
  return false;
}

export type DrawIssue = 'too_few_vertices' | 'not_closed' | 'self_intersection' | 'duplicate_vertex' | 'out_of_range';

export function previewIssues(s: DrawState): DrawIssue[] {
  const issues: DrawIssue[] = [];
  if (s.vertices.length < 3) issues.push('too_few_vertices');
  else if (!s.closed) issues.push('not_closed');
  if (s.vertices.some(([x, y]) => Math.abs(x) > 180 || Math.abs(y) > 90)) issues.push('out_of_range');
  const keys = new Set(s.vertices.map(([x, y]) => `${x.toFixed(9)},${y.toFixed(9)}`));
  if (keys.size !== s.vertices.length) issues.push('duplicate_vertex');
  if (s.closed && ringSelfIntersects(s.vertices)) issues.push('self_intersection');
  return issues;
}

/** RFC 7946 Polygon with the closing vertex appended. */
export function toPolygon(v: LngLat[]): { type: 'Polygon'; coordinates: LngLat[][] } {
  return { type: 'Polygon', coordinates: [[...v, v[0]!]] };
}

/** Editable only for a single outer ring; holes and multipolygons are not edited here. */
export function editableRing(geom: { type: string; coordinates: unknown }): LngLat[] | null {
  if (geom.type !== 'Polygon') return null;
  const rings = geom.coordinates as LngLat[][];
  if (rings.length !== 1) return null;
  const ring = rings[0]!;
  const first = ring[0];
  const last = ring[ring.length - 1];
  const open = first && last && first[0] === last[0] && first[1] === last[1] ? ring.slice(0, -1) : ring;
  return open.map(([x, y]) => [x, y] as LngLat);
}
