/**
 * Local, display-only preview of a file before upload (TZ F-DATA-01: preview and column
 * choice). Nothing here validates for publication: the server parses, checks geometry and
 * writes the QualityReport. The preview only helps the user pick format, fields and CRS.
 */
import type { ImportRequest } from '@pg/api-client';

export type ImportFormat = ImportRequest['format'];

/** Formats the connected parser handles (ADR-010). KML and SHP ZIP end as rejected reports. */
export const PARSER_SUPPORTED: Record<ImportFormat, boolean> = { geojson: true, csv: true, kml: false, shp_zip: false };

/** Content types accepted by PUT /v1/uploads/{id} (contract 1.1.0). */
export const CONTENT_TYPE: Record<ImportFormat, string> = {
  geojson: 'application/geo+json',
  csv: 'text/csv',
  kml: 'application/vnd.google-earth.kml+xml',
  shp_zip: 'application/zip',
};

export function formatFromName(name: string): ImportFormat | null {
  const n = name.toLowerCase();
  if (n.endsWith('.geojson') || n.endsWith('.json')) return 'geojson';
  if (n.endsWith('.csv')) return 'csv';
  if (n.endsWith('.kml')) return 'kml';
  if (n.endsWith('.zip')) return 'shp_zip';
  return null;
}

export interface GeoJsonPreview {
  kind: 'geojson';
  featureCount: number;
  geometryTypes: Record<string, number>;
  fields: string[];
  /** Non-standard "crs" member found in the file (RFC 7946 removed it); null if absent. */
  declaredCrs: string | null;
  bbox: [number, number, number, number] | null;
  problems: string[];
  /** The whole file would be rejected by the server parser (not just some records). */
  fatal: boolean;
}

export interface CsvPreview {
  kind: 'csv';
  header: string[];
  rows: string[][];
  /** Rows counted in the previewed part only; not the total. */
  previewedRows: number;
  truncated: boolean;
  problems: string[];
  fatal: boolean;
}

export type FilePreview = GeoJsonPreview | CsvPreview;

function walkCoords(c: unknown, acc: [number, number, number, number]) {
  if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') {
    const [x, y] = c as [number, number];
    acc[0] = Math.min(acc[0], x);
    acc[1] = Math.min(acc[1], y);
    acc[2] = Math.max(acc[2], x);
    acc[3] = Math.max(acc[3], y);
  } else if (Array.isArray(c)) for (const x of c) walkCoords(x, acc);
}

export function previewGeoJson(text: string): GeoJsonPreview {
  const problems: string[] = [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { kind: 'geojson', featureCount: 0, geometryTypes: {}, fields: [], declaredCrs: null, bbox: null, problems: [`Файл не является корректным JSON: ${(e as Error).message}`], fatal: true };
  }
  const root = value as { type?: unknown; features?: unknown; crs?: { properties?: { name?: unknown } } };
  const notCollection = root?.type !== 'FeatureCollection' || !Array.isArray(root.features);
  if (notCollection) {
    problems.push('Корень GeoJSON должен быть FeatureCollection с массивом features — сервер отклонит файл.');
  }
  const features = Array.isArray(root?.features) ? (root.features as { geometry?: { type?: string; coordinates?: unknown } | null; properties?: Record<string, unknown> | null }[]) : [];
  const geometryTypes: Record<string, number> = {};
  const fields = new Set<string>();
  const acc: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  let missingGeometry = 0;
  for (const f of features) {
    const t = f?.geometry?.type ?? 'нет геометрии';
    geometryTypes[t] = (geometryTypes[t] ?? 0) + 1;
    if (!f?.geometry) missingGeometry += 1;
    else walkCoords(f.geometry.coordinates, acc);
    if (f?.properties && typeof f.properties === 'object') for (const k of Object.keys(f.properties)) fields.add(k);
  }
  if (missingGeometry) problems.push(`${missingGeometry} объект(ов) без геометрии — сервер отметит их ошибками.`);
  const declared = root?.crs?.properties?.name;
  const declaredCrs = typeof declared === 'string' ? declared : null;
  if (declaredCrs && !/CRS84|4326/i.test(declaredCrs)) {
    problems.push(`В файле указана система координат ${declaredCrs}. Сервер пока принимает только WGS84 (EPSG:4326) и не пересчитывает координаты.`);
  }
  const bbox = Number.isFinite(acc[0]) ? acc : null;
  if (bbox && (Math.abs(bbox[0]) > 180 || Math.abs(bbox[2]) > 180 || Math.abs(bbox[1]) > 90 || Math.abs(bbox[3]) > 90)) {
    problems.push('Координаты выходят за диапазон долготы/широты — похоже на проекцию в метрах; сервер отклонит такие объекты.');
  }
  const nonWgs = Boolean(declaredCrs && !/CRS84|4326/i.test(declaredCrs));
  return { kind: 'geojson', featureCount: features.length, geometryTypes, fields: [...fields].sort(), declaredCrs, bbox, problems, fatal: notCollection || nonWgs };
}

/** Minimal RFC 4180 reader for the preview (comma, quotes, CRLF); the server re-parses everything. */
export function parseCsvRows(text: string, maxRows: number): { rows: string[][]; complete: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      if (rows.length >= maxRows) return { rows, complete: false };
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return { rows, complete: true };
}

export function previewCsv(text: string, truncatedInput: boolean): CsvPreview {
  const problems: string[] = [];
  const { rows, complete } = parseCsvRows(text, 21);
  const header = rows[0] ?? [];
  const body = rows.slice(1, 21);
  if (header.length === 0 || header.every((h) => h.trim() === '')) problems.push('Нет строки заголовка — сервер отклонит файл.');
  const dup = header.filter((h, i) => header.indexOf(h) !== i);
  if (dup.length) problems.push(`Повторяющиеся названия колонок: ${[...new Set(dup)].join(', ')}.`);
  if (header.length === 1 && /;|\t/.test(header[0] ?? '')) problems.push('Похоже, разделитель — точка с запятой или табуляция; сервер пока читает только запятую.');
  const ragged = body.filter((r) => r.length > header.length).length;
  if (ragged) problems.push(`${ragged} строк(и) с лишними значениями в просмотре — сервер отметит их.`);
  const noHeader = header.length === 0 || header.every((h) => h.trim() === '');
  return { kind: 'csv', header, rows: body, previewedRows: body.length, truncated: truncatedInput || !complete, problems, fatal: noHeader || dup.length > 0 };
}

/** Columns that look like coordinates; the current server does not build geometry from them. */
export function coordinateLikeColumns(header: string[]): string[] {
  return header.filter((h) => /^(lon|lng|long|longitude|x|долгота|lat|latitude|y|широта)$/i.test(h.trim()));
}

export function buildFieldMapping(fields: string[], include: Record<string, boolean>, rename: Record<string, string>): ImportRequest['field_mapping'] {
  const chosen = fields.filter((f) => include[f]);
  // Empty mapping = keep every field unchanged (server semantics).
  if (chosen.length === fields.length && chosen.every((f) => !rename[f] || rename[f] === f)) return [];
  return chosen.map((f) => ({ source_field: f, target_field: (rename[f] ?? f).trim() || f }));
}
