import { describe, expect, it } from 'vitest';
import { buildFieldMapping, coordinateLikeColumns, formatFromName, parseCsvRows, PARSER_SUPPORTED, previewCsv, previewGeoJson } from './preview';

describe('import preview (display only)', () => {
  it('detects format by extension and marks KML/SHP as not supported by the parser', () => {
    expect(formatFromName('a.GeoJSON')).toBe('geojson');
    expect(formatFromName('b.csv')).toBe('csv');
    expect(formatFromName('c.kml')).toBe('kml');
    expect(formatFromName('d.zip')).toBe('shp_zip');
    expect(formatFromName('e.xlsx')).toBeNull();
    expect(PARSER_SUPPORTED).toEqual({ geojson: true, csv: true, kml: false, shp_zip: false });
  });
  it('summarises a FeatureCollection and flags non-WGS84 CRS and metre coordinates', () => {
    const fc = {
      type: 'FeatureCollection',
      crs: { type: 'name', properties: { name: 'EPSG:32643' } },
      features: [
        { type: 'Feature', properties: { name: 'a', h: 1 }, geometry: { type: 'Point', coordinates: [512000, 5795000] } },
        { type: 'Feature', properties: { name: 'b' }, geometry: null },
      ],
    };
    const p = previewGeoJson(JSON.stringify(fc));
    expect(p.featureCount).toBe(2);
    expect(p.fields).toEqual(['h', 'name']);
    expect(p.geometryTypes).toEqual({ Point: 1, 'нет геометрии': 1 });
    expect(p.problems.join(' ')).toMatch(/EPSG:32643/);
    expect(p.problems.join(' ')).toMatch(/без геометрии/);
    expect(p.problems.join(' ')).toMatch(/диапазон/);
    expect(p.fatal).toBe(true); // declared non-WGS84 CRS: the server would reject the file
  });
  it('rejects non-FeatureCollection roots in the preview', () => {
    expect(previewGeoJson('{"type":"Feature"}').problems[0]).toMatch(/FeatureCollection/);
    expect(previewGeoJson('{"type":"Feature"}').fatal).toBe(true);
    expect(previewGeoJson('{"type":"FeatureCollection","features":[]}').fatal).toBe(false);
    expect(previewGeoJson('not json').problems[0]).toMatch(/JSON/);
  });
  it('reads quoted CSV with CRLF and BOM, and flags ; delimiters and duplicates', () => {
    const { rows } = parseCsvRows('﻿name,note\r\n"A, B","say ""hi"""\r\nC,D\r\n', 10);
    expect(rows).toEqual([['name', 'note'], ['A, B', 'say "hi"'], ['C', 'D']]);
    expect(previewCsv('a;b;c\n1;2;3\n', false).problems.join(' ')).toMatch(/точка с запятой/);
    expect(previewCsv('a,a\n1,2\n', false).problems.join(' ')).toMatch(/Повторяющиеся/);
    expect(coordinateLikeColumns(['name', 'lon', 'Latitude', 'x1'])).toEqual(['lon', 'Latitude']);
  });
  it('keeps all fields with an empty mapping and builds explicit pairs otherwise', () => {
    const f = ['name', 'height'];
    expect(buildFieldMapping(f, { name: true, height: true }, {})).toEqual([]);
    expect(buildFieldMapping(f, { name: true, height: false }, {})).toEqual([{ source_field: 'name', target_field: 'name' }]);
    expect(buildFieldMapping(f, { name: true, height: true }, { height: 'height_m' })).toEqual([
      { source_field: 'name', target_field: 'name' },
      { source_field: 'height', target_field: 'height_m' },
    ]);
  });
});
