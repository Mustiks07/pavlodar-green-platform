import { describe, expect, it } from 'vitest';
import type { Legend, MapLayer } from '@pg/api-client';
import { SEMANTIC_TOKEN, archiveLayerId, archiveProtocolToHttp, classToken, colorExpression, extrusionFilter, featureTitle, tileHeightBasis, escapeHtml, featureIdOf, displayMinZoom, geometryBounds, geometryFamily, inspectProperties, NOT_POINT_GEOMETRY, POINT_GEOMETRY, layerIdsOf, layerSpecs, renderability, sourceAttributes, sourceSpec, tileLayerId, tileProtocolToHttp } from './publishedLayers';

const color = (s: keyof typeof SEMANTIC_TOKEN) => `var(${SEMANTIC_TOKEN[s]})`;
const single: Legend = {
  mode: 'single',
  property: null,
  unit: null,
  period: null,
  classes: [{ key: 'feature', label: 'Объекты', value: null, min: null, max: null, semantic: 'neutral' }],
  unknown_class_key: null,
};
const layer = (over: Partial<MapLayer> = {}): MapLayer => ({
  id: '11111111-1111-4111-8111-111111111111',
  city_id: '22222222-2222-4222-8222-222222222222',
  dataset_id: '44444444-4444-4444-8444-444444444444',
  name: 'SYNTHETIC test',
  kind: 'zones',
  source_type: 'mvt',
  source_url: '/v1/map/tiles/11111111-1111-4111-8111-111111111111/{z}/{x}/{y}.mvt',
  dataset_version_id: '33333333-3333-4333-8333-333333333333',
  min_zoom: 5,
  max_zoom: 22,
  attribution: 'Команда · CC0',
  access_level: 'internal',
  observed_at: null,
  category: 'zone',
  source_layer: 'features',
  geometry_type: 'polygon',
  is_stale: false,
  legend: single,
  ...over,
});

describe('renderability', () => {
  const origin = 'http://localhost:5173';
  it('resolves a relative template against the page origin, keeping the braces, via the tile protocol', () => {
    const r = renderability(layer(), origin);
    expect(r).toEqual({ ok: true, tiles: 'pgtile://localhost:5173/v1/map/tiles/11111111-1111-4111-8111-111111111111/{z}/{x}/{y}.mvt' });
    const http = tileProtocolToHttp(r.ok && !r.archive ? r.tiles.replace('{z}/{x}/{y}', '12/1/2') : '', 'http:');
    expect(http).toBe('http://localhost:5173/v1/map/tiles/11111111-1111-4111-8111-111111111111/12/1/2.mvt');
    expect(tileLayerId(http)).toBe('11111111-1111-4111-8111-111111111111');
  });
  it('refuses cross-origin tiles (the session cookie must not leave the origin)', () => {
    expect(renderability(layer({ source_url: 'https://evil.example/{z}/{x}/{y}.mvt' }), origin)).toEqual({ ok: false, reason: 'cross_origin' });
    expect(renderability(layer({ source_url: '//evil.example/{z}/{x}/{y}.mvt' }), origin)).toEqual({ ok: false, reason: 'cross_origin' });
  });
  it('refuses templates without z/x/y', () => {
    expect(renderability(layer({ source_url: '/v1/map/tiles/a.mvt' }), origin)).toEqual({ ok: false, reason: 'url' });
  });
  it('reads a same-origin PMTiles archive through the archive protocol (1.5.0 getMapArchive)', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const r = renderability(layer({ source_type: 'pmtiles', source_url: `/v1/map/archives/${id}.pmtiles` }), origin);
    expect(r).toEqual({ ok: true, archive: true, url: `pgpmtiles://localhost:5173/v1/map/archives/${id}.pmtiles` });
    expect(archiveLayerId(archiveProtocolToHttp(`pgpmtiles://localhost:5173/v1/map/archives/${id}.pmtiles/12/1/2`, 'http:'))).toBe(id);
    expect(renderability(layer({ source_type: 'pmtiles', source_url: `https://evil.example/v1/map/archives/${id}.pmtiles` }), origin)).toEqual({ ok: false, reason: 'cross_origin' });
    expect(renderability(layer({ source_type: 'pmtiles', source_url: '/v1/map/tiles/{z}/{x}/{y}.mvt' }), origin)).toEqual({ ok: false, reason: 'url' });
    expect(sourceSpec(layer({ source_type: 'pmtiles' }), 'pgpmtiles://x/v1/map/archives/a.pmtiles', true)).toMatchObject({ type: 'vector', url: 'pgpmtiles://x/v1/map/archives/a.pmtiles' });
  });
});

describe('colorExpression', () => {
  it('single legend: the class semantic, nothing else', () => {
    expect(colorExpression(single, color)).toBe('var(--pg-neutral)');
  });
  it('categorical: match on value, unknown class for anything else', () => {
    const legend: Legend = {
      ...single,
      mode: 'categorical',
      property: 'state',
      classes: [
        { key: 'ok', label: 'ok', value: 'good', min: null, max: null, semantic: 'positive' },
        { key: 'bad', label: 'bad', value: 'poor', min: null, max: null, semantic: 'negative' },
        { key: 'na', label: 'нет данных', value: null, min: null, max: null, semantic: 'unknown' },
      ],
      unknown_class_key: 'na',
    };
    expect(colorExpression(legend, color)).toEqual(['match', ['to-string', ['get', 'state']], 'good', 'var(--pg-positive)', 'poor', 'var(--pg-negative)', 'var(--pg-map-unknown)']);
  });
  it('sequential: [min, max) ranges, last closed, non-numbers are unknown', () => {
    const legend: Legend = {
      ...single,
      mode: 'sequential',
      property: 'v',
      classes: [
        { key: 'a', label: 'a', value: null, min: 0, max: 10, semantic: 'positive' },
        { key: 'b', label: 'b', value: null, min: 10, max: 20, semantic: 'warning' },
      ],
    };
    const expr = colorExpression(legend, color) as unknown[];
    expect(expr[0]).toBe('case');
    expect(JSON.stringify(expr[1])).toContain('"<",["to-number",["get","v"]],10');
    expect(JSON.stringify(expr[3])).toContain('"<=",["to-number",["get","v"]],20');
    expect(expr.at(-1)).toBe('var(--pg-map-unknown)');
  });
});

describe('layer specs', () => {
  it('draws polygon as fill+outline, line as line, point as circle, from source_layer', () => {
    expect(layerIdsOf(layer())).toHaveLength(2);
    const specs = layerSpecs(layer({ geometry_type: 'point' }), color, '#fff');
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ type: 'circle', 'source-layer': 'features', minzoom: 5 });
    expect(layerSpecs(layer({ geometry_type: 'line' }), color, '#fff')[0]).toMatchObject({ type: 'line' });
  });
  it('escapes server attribution before MapLibre renders it as HTML', () => {
    expect(escapeHtml('<img src=x onerror=1>')).toBe('&lt;img src=x onerror=1&gt;');
    expect(sourceSpec(layer({ attribution: 'A & <b>B</b>' }), 'x')).toMatchObject({ type: 'vector', attribution: 'A &amp; &lt;b&gt;B&lt;/b&gt;', minzoom: 5, maxzoom: 22 });
  });
  it('inspector shows bounded text', () => {
    const rows = inspectProperties({ a: 1, b: { c: 2 }, d: 'x'.repeat(300) });
    expect(rows[1]).toEqual({ key: 'b', value: '{"c":2}' });
    expect(rows[2]!.value.length).toBe(201);
  });
});

describe('feature card helpers', () => {
  const id = '6F1C2B9E-3A4D-4E5F-8A7B-1C2D3E4F5A6B';
  it('takes only a uuid feature_id from tile properties, never the numeric MVT id', () => {
    expect(featureIdOf({ feature_id: id })).toBe(id.toLowerCase());
    expect(featureIdOf({ feature_id: 17 })).toBeNull();
    expect(featureIdOf({ feature_id: 'row-17' })).toBeNull();
    expect(featureIdOf({})).toBeNull();
    expect(featureIdOf(null)).toBeNull();
  });
  it('raw attributes exclude the platform id', () => {
    expect(sourceAttributes({ feature_id: id, name: 'A' })).toEqual({ name: 'A' });
  });
  it('maps GeoJSON types to layer geometry families', () => {
    expect(geometryFamily('MultiPoint')).toBe('point');
    expect(geometryFamily('LineString')).toBe('line');
    expect(geometryFamily('MultiPolygon')).toBe('polygon');
    expect(geometryFamily('GeometryCollection')).toBeNull();
  });
  it('draws buildings only from street zoom; other layers keep the server min_zoom', () => {
    expect(displayMinZoom({ min_zoom: 5, category: 'building' })).toBe(13);
    expect(displayMinZoom({ min_zoom: 15, category: 'building' })).toBe(15);
    expect(displayMinZoom({ min_zoom: 5, category: 'road' })).toBe(5);
  });
  it('highlights multi-part points as points and multi-part lines as outlines', () => {
    expect(POINT_GEOMETRY).toEqual(['in', ['geometry-type'], ['literal', ['Point', 'MultiPoint']]]);
    expect(NOT_POINT_GEOMETRY).toEqual(['!', POINT_GEOMETRY]);
    expect(geometryFamily('MultiLineString')).toBe('line');
  });
  it('bounds any geometry, a point included', () => {
    expect(geometryBounds({ type: 'Point', coordinates: [76.9, 52.3] })).toEqual([76.9, 52.3, 76.9, 52.3]);
    expect(
      geometryBounds({ type: 'MultiLineString', coordinates: [[[1, 2], [3, 0]], [[-1, 5], [2, 2]]] }),
    ).toEqual([-1, 0, 3, 5]);
    expect(geometryBounds({ type: 'Polygon', coordinates: [] })).toBeNull();
  });
});

describe('classToken', () => {
  const neutral: Legend = { ...single, classes: [{ ...single.classes![0]!, semantic: 'neutral' }] };
  it('gives single-class neutral layers the identity colour of their server category', () => {
    expect(classToken(layer({ category: 'road', legend: neutral }), 'neutral', true)).toBe('--pg-basemap-road');
    expect(classToken(layer({ category: 'water', legend: neutral }), 'neutral', false)).toBe('--pg-map-water');
    expect(classToken(layer({ category: 'existing_green', legend: neutral }), 'neutral', true)).toBe('--pg-basemap-green');
  });
  it('keeps meaningful semantics and unknown categories on the legend tokens', () => {
    expect(classToken(layer({ category: 'road', legend: neutral }), 'negative', true)).toBe('--pg-basemap-negative');
    expect(classToken(layer({ category: 'zone', legend: neutral }), 'neutral', false)).toBe(SEMANTIC_TOKEN.neutral);
  });
});

describe('3D from building tiles', () => {
  it('extrudes only finite positive heights on accepted bases and skips the selected feature', () => {
    const f = extrusionFilter('abc');
    expect(f[0]).toBe('all');
    expect(JSON.stringify(f)).toContain('"literal",["measured","recorded_unverified","floors_estimate"]');
    expect(f.at(-1)).toEqual(['!=', ['to-string', ['get', 'feature_id']], 'abc']);
  });
  it('counts a tile feature by basis without inventing heights', () => {
    expect(tileHeightBasis({ height_m: 10, height_basis: 'recorded_unverified' })).toBe('recorded_unverified');
    expect(tileHeightBasis({ height_m: 0, height_basis: 'measured' })).toBe('unknown');
    expect(tileHeightBasis({ height_m: '10', height_basis: 'measured' })).toBe('unknown');
    expect(tileHeightBasis({ height_m: 6, height_basis: 'visual_placeholder' })).toBe('visual_placeholder');
    expect(tileHeightBasis({})).toBe('unknown');
  });
});

describe('featureTitle', () => {
  const refs = [{ source_record_id: '0' }];
  it('replaces a bare record number with the layer name', () => {
    expect(featureTitle({ label: '0', source_refs: refs }, 'Здания')).toBe('Здания');
    expect(featureTitle({ label: 'Школа №5', source_refs: refs }, 'Здания')).toBe('Школа №5');
    expect(featureTitle(undefined, 'Здания')).toBe('Здания');
  });
});
