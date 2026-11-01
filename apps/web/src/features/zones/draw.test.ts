import { describe, expect, it } from 'vitest';
import {
  addVertex,
  closeRing,
  cycleVertex,
  insertAfter,
  removeVertex,
  selectVertex,
  editableRing,
  insertVertex,
  moveVertex,
  previewIssues,
  redo,
  removeLast,
  ringSelfIntersects,
  startDraw,
  toPolygon,
  undo,
  type LngLat,
} from './draw';

const sq: LngLat[] = [
  [76.9, 52.2],
  [77.0, 52.2],
  [77.0, 52.3],
  [76.9, 52.3],
];

describe('drawing state', () => {
  it('adds vertices, closes only with 3+, and undo/redo restore exact states', () => {
    let s = startDraw('create');
    s = addVertex(s, sq[0]!);
    s = addVertex(s, sq[1]!);
    expect(closeRing(s).closed).toBe(false);
    s = addVertex(s, sq[2]!);
    s = closeRing(s);
    expect(s.closed).toBe(true);
    expect(addVertex(s, sq[3]!).vertices).toHaveLength(3); // closed ring ignores clicks
    s = undo(s);
    expect(s.closed).toBe(false);
    s = redo(s);
    expect(s.closed).toBe(true);
  });
  it('move/insert keep closure; removeLast reopens a closed ring first', () => {
    let s = startDraw('edit', 'z', sq);
    s = moveVertex(s, 0, [76.8, 52.2]);
    expect(s.vertices[0]).toEqual([76.8, 52.2]);
    s = insertVertex(s, 0, [76.85, 52.15]);
    expect(s.vertices).toHaveLength(5);
    s = removeLast(s);
    expect(s.closed).toBe(false);
    expect(s.vertices).toHaveLength(5);
  });
});

describe('preview checks (server stays authoritative)', () => {
  it('detects a bow-tie self-intersection and accepts a square', () => {
    expect(ringSelfIntersects(sq)).toBe(false);
    const bowtie: LngLat[] = [sq[0]!, sq[2]!, sq[1]!, sq[3]!];
    expect(ringSelfIntersects(bowtie)).toBe(true);
    expect(previewIssues({ ...startDraw('create', null, bowtie) })).toContain('self_intersection');
  });
  it('reports too few vertices, open ring and duplicates', () => {
    expect(previewIssues(startDraw('create', null, sq.slice(0, 2)))).toContain('too_few_vertices');
    expect(previewIssues({ ...startDraw('create', null, sq), closed: false })).toContain('not_closed');
    expect(previewIssues(startDraw('create', null, [...sq, sq[0]!]))).toContain('duplicate_vertex');
  });
  it('serialises as a closed RFC 7946 ring and round-trips through editableRing', () => {
    const poly = toPolygon(sq);
    expect(poly.coordinates[0]).toHaveLength(5);
    expect(poly.coordinates[0]![4]).toEqual(sq[0]);
    expect(editableRing(poly)).toEqual(sq);
    expect(editableRing({ type: 'Polygon', coordinates: [poly.coordinates[0], poly.coordinates[0]] })).toBeNull();
    expect(editableRing({ type: 'MultiPolygon', coordinates: [] })).toBeNull();
  });
});

describe('vertex selection for touch and keyboard editing', () => {
  const ring = () => startDraw('edit', 'z', [...sq]);
  it('selection wraps, is not undo history and survives a move', () => {
    const s = cycleVertex(ring(), -1);
    expect(s.selected).toBe(3);
    expect(cycleVertex(s, 1).selected).toBe(0);
    expect(s.past).toHaveLength(0);
    expect(moveVertex(s, 3, [76.95, 52.35]).selected).toBe(3);
    expect(selectVertex(s, null).selected).toBeNull();
  });
  it('deleting the selected vertex selects its neighbour and reopens below three', () => {
    let s = selectVertex(ring(), 3);
    s = removeVertex(s, 3);
    expect(s.selected).toBe(2);
    expect(s.closed).toBe(true);
    s = removeVertex(s, 2);
    expect(s.vertices).toHaveLength(2);
    expect(s.closed).toBe(false);
    expect(removeVertex(selectVertex(ring(), 1), 0).selected).toBe(0);
  });
  it('insertAfter puts the midpoint after the vertex (closed ring wraps) and selects it', () => {
    const s = insertAfter(ring(), 3);
    expect(s.vertices).toHaveLength(5);
    expect(s.vertices[4]).toEqual([76.9, 52.25]);
    expect(s.selected).toBe(4);
    const open = startDraw('create', null, sq.slice(0, 2));
    expect(insertAfter({ ...open, closed: false }, 1)).toEqual({ ...open, closed: false });
  });
  it('undo drops a selection that no longer exists', () => {
    const s = selectVertex(insertAfter(ring(), 0), 4);
    expect(undo(s).selected).toBeNull();
  });
});
