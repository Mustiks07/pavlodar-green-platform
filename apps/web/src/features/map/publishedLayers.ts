import type { ExpressionSpecification, LayerSpecification, SourceSpecification } from 'maplibre-gl';
import type { Legend, LegendClass, MapLayer } from '@pg/api-client';

/**
 * Published map layers (listMapLayers, ADR-012) -> MapLibre sources and layers.
 * Colour carries the legend's `semantic` through design-system tokens; the client never assigns a
 * meaning of its own (no invented classes). The one exception is identity, not meaning: a
 * single-class neutral legend takes the colour of its server category (roads, green, water,
 * buildings), so families of real layers can be told apart.
 */

export type Semantic = LegendClass['semantic'];

export const SEMANTIC_TOKEN: Record<Semantic, string> = {
  positive: '--pg-positive',
  negative: '--pg-negative',
  warning: '--pg-warning',
  neutral: '--pg-neutral',
  unknown: '--pg-map-unknown',
};

/** Over the external basemap (light in both themes) a theme-independent palette keeps contrast. */
export const BASEMAP_SEMANTIC_TOKEN: Record<Semantic, string> = {
  positive: '--pg-basemap-positive',
  negative: '--pg-basemap-negative',
  warning: '--pg-basemap-warning',
  neutral: '--pg-basemap-neutral',
  unknown: '--pg-basemap-unknown',
};
export const semanticToken = (semantic: Semantic, onBasemap: boolean) => (onBasemap ? BASEMAP_SEMANTIC_TOKEN : SEMANTIC_TOKEN)[semantic];

const CATEGORY_TOKEN: Partial<Record<MapLayer['category'], string>> = {
  road: 'road',
  existing_green: 'green',
  water: 'water',
  building: 'building',
};

/** Token of one legend class of a layer (see the module note on category identity colours). */
export function classToken(layer: Pick<MapLayer, 'category' | 'legend'>, semantic: Semantic, onBasemap: boolean): string {
  const family = CATEGORY_TOKEN[layer.category];
  const single = layer.legend.mode === 'single' || !layer.legend.property;
  if (family && single && semantic === 'neutral') return `--pg-${onBasemap ? 'basemap' : 'map'}-${family}`;
  return semanticToken(semantic, onBasemap);
}

export type ColorOf = (semantic: Semantic) => string;

/** 3D extrusion of a published building layer, from the tile's height_m/height_basis (ADR-004 §6). */
export const extrusionIdOf = (layerId: string) => `${sourceIdOf(layerId)}-extrusion`;
/** Bases with a height worth a volume; unknown and visual placeholders stay flat. */
export const EXTRUDED_BASES = ['measured', 'recorded_unverified', 'floors_estimate'] as const;

/** Tile features with a finite positive height on an accepted basis; `except` is drawn elsewhere. */
export function extrusionFilter(except: string | null): ExpressionSpecification {
  return [
    'all',
    ['==', ['typeof', ['get', 'height_m']], 'number'],
    ['>', ['get', 'height_m'], 0],
    ['in', ['get', 'height_basis'], ['literal', [...EXTRUDED_BASES]]],
    ['!=', ['to-string', ['get', 'feature_id']], except ?? ''],
  ];
}

/** Height basis of a tile feature for 3D counts: anything not extruded counts as unknown/placeholder. */
export function tileHeightBasis(props: Record<string, unknown>): (typeof EXTRUDED_BASES)[number] | 'visual_placeholder' | 'unknown' {
  const basis = props.height_basis;
  if (basis === 'visual_placeholder') return 'visual_placeholder';
  const h = props.height_m;
  const ok = typeof h === 'number' && Number.isFinite(h) && h > 0;
  return ok && (EXTRUDED_BASES as readonly unknown[]).includes(basis) ? (basis as (typeof EXTRUDED_BASES)[number]) : 'unknown';
}

/**
 * Card title: the server label, unless it is only the record number of a nameless record (the
 * server falls back to source_record_id), in which case the layer name says more.
 */
export function featureTitle(
  f: { label: string; source_refs: { source_record_id: string | null }[] } | undefined,
  layerName: string | null,
): string | null {
  if (!f) return layerName;
  const recordIds = new Set(f.source_refs.map((r) => r.source_record_id).filter(Boolean));
  return recordIds.has(f.label) ? (layerName ?? f.label) : f.label;
}

export const sourceIdOf = (layerId: string) => `pgl-${layerId}`;
export const layerIdsOf = (layer: Pick<MapLayer, 'id' | 'geometry_type'>): string[] => {
  const s = sourceIdOf(layer.id);
  switch (layer.geometry_type) {
    case 'polygon':
      return [`${s}-fill`, `${s}-line`];
    case 'line':
      return [`${s}-line`];
    case 'point':
      return [`${s}-circle`];
    case 'raster':
      return [`${s}-raster`];
  }
};

/** Custom MapLibre protocol for published-layer tiles (registered in ./maplibre). */
export const TILE_PROTOCOL = 'pgtile';
const toProtocol = (httpUrl: string) => httpUrl.replace(/^https?:\/\//, `${TILE_PROTOCOL}://`);
export const tileProtocolToHttp = (url: string, pageProtocol: string) => url.replace(`${TILE_PROTOCOL}://`, `${pageProtocol}//`);
/** Layer id from a tile URL of the canonical shape /v1/map/tiles/{layer_id}/{z}/{x}/{y}.mvt. */
export const tileLayerId = (url: string) => /\/v1\/map\/tiles\/([0-9a-f-]{36})\//i.exec(url)?.[1] ?? null;

/** Custom protocol for published PMTiles archives (getMapArchive, ADR-031; see ./maplibre). */
export const ARCHIVE_PROTOCOL = 'pgpmtiles';
export const archiveProtocolToHttp = (url: string, pageProtocol: string) => url.replace(`${ARCHIVE_PROTOCOL}://`, `${pageProtocol}//`);
/** Layer id from an archive URL /v1/map/archives/{layer_id}.pmtiles (with or without /{z}/{x}/{y}). */
export const archiveLayerId = (url: string) => /\/v1\/map\/archives\/([0-9a-f-]{36})\.pmtiles/i.exec(url)?.[1] ?? null;

export type Renderability =
  | { ok: true; tiles: string; archive?: false }
  | { ok: true; archive: true; url: string }
  | { ok: false; reason: 'source_type' | 'cross_origin' | 'url' };

/**
 * Tiles are authorized by the session cookie on every request (ADR-012), so only same-origin
 * URLs are used: a foreign host would either fail without the cookie or receive it. The URL
 * template keeps its literal {z}/{x}/{y} (URL() would percent-encode the braces) and is routed
 * through TILE_PROTOCOL so the client sees every tile status.
 */
export function renderability(layer: Pick<MapLayer, 'source_type' | 'source_url'>, origin: string): Renderability {
  const url = layer.source_url;
  if (layer.source_type === 'pmtiles') {
    // One same-origin archive read with Range requests; the session cookie authorizes each one.
    if (!archiveLayerId(url)) return { ok: false, reason: 'url' };
    const abs = url.startsWith('/') && !url.startsWith('//') ? origin + url : url;
    try {
      if (new URL(abs).origin !== origin) return { ok: false, reason: 'cross_origin' };
    } catch {
      return { ok: false, reason: 'url' };
    }
    return { ok: true, archive: true, url: abs.replace(/^https?:\/\//, `${ARCHIVE_PROTOCOL}://`) };
  }
  if (!/\{z\}/.test(url) || !/\{x\}/.test(url) || !/\{y\}/.test(url)) return { ok: false, reason: 'url' };
  if (url.startsWith('/') && !url.startsWith('//')) return { ok: true, tiles: toProtocol(origin + url) };
  try {
    const parsed = new URL(url.replace(/[{}]/g, ''), origin);
    if (parsed.origin !== origin) return { ok: false, reason: 'cross_origin' };
    return { ok: true, tiles: toProtocol(url) };
  } catch {
    return { ok: false, reason: 'url' };
  }
}

/** MapLibre renders source attribution as HTML; server strings are text and are escaped. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function unknownClass(legend: Legend): LegendClass | null {
  return legend.unknown_class_key ? legend.classes.find((c) => c.key === legend.unknown_class_key) ?? null : null;
}

/** Classes shown as data classes (the unknown class is listed separately). */
export function dataClasses(legend: Legend): LegendClass[] {
  return legend.classes.filter((c) => c.key !== legend.unknown_class_key);
}

/**
 * Colour expression from the legend. 'single' (or no property) -> the first class's semantic.
 * 'categorical' matches `value`; 'sequential'/'diverging' use [min, max) ranges (last class
 * closed). Missing or non-matching values get the unknown class, never a data class.
 */
export function colorExpression(legend: Legend, color: ColorOf): string | ExpressionSpecification {
  const unknown = color(unknownClass(legend)?.semantic ?? 'unknown');
  const classes = dataClasses(legend);
  const prop = legend.property;
  if (legend.mode === 'single' || !prop) return color(classes[0]?.semantic ?? 'neutral');
  const get: ExpressionSpecification = ['get', prop];
  if (legend.mode === 'categorical') {
    const valued = classes.filter((c): c is LegendClass & { value: string } => c.value !== null);
    if (valued.length === 0) return unknown;
    const pairs = valued.flatMap((c) => [c.value, color(c.semantic)]);
    return ['match', ['to-string', get], ...pairs, unknown] as unknown as ExpressionSpecification;
  }
  const ranged = classes.filter((c) => c.min !== null || c.max !== null);
  if (ranged.length === 0) return unknown;
  const num: ExpressionSpecification = ['to-number', get];
  const branches = ranged.flatMap((c, i) => {
    const conds: ExpressionSpecification[] = [['==', ['typeof', get], 'number']];
    if (c.min !== null) conds.push(['>=', num, c.min]);
    if (c.max !== null) conds.push([i === ranged.length - 1 ? '<=' : '<', num, c.max]);
    return [['all', ...conds], color(c.semantic)];
  });
  return ['case', ...branches, unknown] as unknown as ExpressionSpecification;
}

export function sourceSpec(layer: MapLayer, tiles: string, archive = false): SourceSpecification {
  // Archive: MapLibre reads the zoom range from the archive header via TileJSON (overzoom past it).
  if (archive) return { type: 'vector', url: tiles, attribution: escapeHtml(layer.attribution) };
  const common = {
    tiles: [tiles],
    minzoom: layer.min_zoom,
    maxzoom: layer.max_zoom,
    attribution: escapeHtml(layer.attribution),
  };
  return layer.geometry_type === 'raster' ? { type: 'raster', tileSize: 256, ...common } : { type: 'vector', ...common };
}

/** Paint per sub-layer; re-applied on theme change. */
export function paintOf(layer: MapLayer, color: ColorOf, outline: string): Record<string, Record<string, unknown>> {
  const [first, second] = layerIdsOf(layer);
  const c = colorExpression(layer.legend, color);
  switch (layer.geometry_type) {
    case 'polygon':
      return { [first!]: { 'fill-color': c, 'fill-opacity': 0.28 }, [second!]: { 'line-color': c, 'line-width': 1.25 } };
    case 'line':
      // Thin at city scale so dense networks (thousands of roads) do not merge into a mass.
      return { [first!]: { 'line-color': c, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 13, 1.2, 16, 3] } };
    case 'point':
      return {
        [first!]: {
          'circle-color': c,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 3, 16, 6],
          'circle-stroke-color': outline,
          'circle-stroke-width': 1,
        },
      };
    case 'raster':
      return { [first!]: { 'raster-opacity': 0.8 } };
  }
}

/**
 * Display floor by category (level of detail, F-MAP-04): single buildings are sub-pixel at city
 * zoom and their tiles dominated cold load (5.9 of 7.2 MB at z10 with OSM v2). Tile availability
 * still follows the server's min_zoom; below the floor the layer is simply not drawn or fetched.
 */
const DISPLAY_MIN_ZOOM: Partial<Record<MapLayer['category'], number>> = { building: 13 };
export const displayMinZoom = (layer: Pick<MapLayer, 'min_zoom' | 'category'>): number => Math.max(layer.min_zoom, DISPLAY_MIN_ZOOM[layer.category] ?? 0);

export function layerSpecs(layer: MapLayer, color: ColorOf, outline: string): LayerSpecification[] {
  const source = sourceIdOf(layer.id);
  const paint = paintOf(layer, color, outline);
  const base = { source, minzoom: displayMinZoom(layer), metadata: { 'pg:layer': layer.id } };
  const vector = { ...base, 'source-layer': layer.source_layer ?? '' };
  return layerIdsOf(layer).map((id) => {
    const type = id.endsWith('-fill') ? 'fill' : id.endsWith('-line') ? 'line' : id.endsWith('-circle') ? 'circle' : 'raster';
    const spec = type === 'raster' ? { ...base, id, type, paint: paint[id] } : { ...vector, id, type, paint: paint[id] };
    if (type === 'line' && layer.geometry_type === 'line') Object.assign(spec, { layout: { 'line-cap': 'round', 'line-join': 'round' } });
    return spec as LayerSpecification;
  });
}

/** Raw tile properties for the inspector: text only, bounded, never interpreted. */
export function inspectProperties(props: Record<string, unknown> | null | undefined, max = 30): { key: string; value: string }[] {
  if (!props) return [];
  return Object.entries(props)
    .slice(0, max)
    .map(([key, v]) => {
      const s = v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);
      return { key, value: s.length > 200 ? `${s.slice(0, 200)}…` : s };
    });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s);

/**
 * Tile property naming the stable public id of a feature (ADR-013 P3). The numeric MVT id is the
 * internal row_index and is never sent to the API.
 */
export const FEATURE_ID_PROPERTY = 'feature_id';
export function featureIdOf(props: Record<string, unknown> | null | undefined): string | null {
  const v = props?.[FEATURE_ID_PROPERTY];
  return isUuid(v) ? v.toLowerCase() : null;
}

/** Source attributes of a tile feature without the platform's own id property. */
export function sourceAttributes(props: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!props) return {};
  const { [FEATURE_ID_PROPERTY]: _id, ...rest } = props;
  return rest;
}

/**
 * Highlight split for a selected object: points (single or multi-part, contract 1.13.0) get a ring,
 * everything else an outline. MapLibre reports multi-part features as MultiPoint/MultiLineString.
 */
export const POINT_GEOMETRY: ExpressionSpecification = ['in', ['geometry-type'], ['literal', ['Point', 'MultiPoint']]];
export const NOT_POINT_GEOMETRY: ExpressionSpecification = ['!', POINT_GEOMETRY];

export function geometryFamily(type: string): MapLayer['geometry_type'] | null {
  if (type === 'Point' || type === 'MultiPoint') return 'point';
  if (type === 'LineString' || type === 'MultiLineString') return 'line';
  if (type === 'Polygon' || type === 'MultiPolygon') return 'polygon';
  return null;
}

/** [west, south, east, north] of any GeoJSON geometry; null when it has no finite position. */
export function geometryBounds(geom: unknown): [number, number, number, number] | null {
  const b = [Infinity, Infinity, -Infinity, -Infinity] as [number, number, number, number];
  const walk = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number' && typeof c[1] === 'number') {
      if (!Number.isFinite(c[0]) || !Number.isFinite(c[1])) return;
      b[0] = Math.min(b[0], c[0]);
      b[1] = Math.min(b[1], c[1]);
      b[2] = Math.max(b[2], c[0]);
      b[3] = Math.max(b[3], c[1]);
      return;
    }
    for (const x of c) walk(x);
  };
  walk((geom as { coordinates?: unknown } | null | undefined)?.coordinates);
  return Number.isFinite(b[0]) ? b : null;
}
