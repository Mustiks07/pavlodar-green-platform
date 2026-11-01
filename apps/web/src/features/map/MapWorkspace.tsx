import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { LngLatBoundsLike, StyleSpecification } from 'maplibre-gl';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import { ApiError, type AreaGeometry, type City, type MapLayer, type Zone } from '@pg/api-client';
import { Badge, Button, DataTable, formatDateTime, Icon, Legend, Notice, SidePanel, Skeleton, StateView } from '@pg/ui';
import { useQueryClient } from '@tanstack/react-query';
import { qk, useMapFeature, useMapLayers, useOperationAvailable } from '../../api';
import { t, type AppKey } from '../../i18n';
import { ApiErrorView } from '../../shell/ApiErrorView';
import { OperationUnavailable } from '../../shell/OperationUnavailable';
import { useCityGate } from '../../shell/gates';
import { useZones, useZoneVersion } from '../zones/queries';
import { addVertex, closeRing, cycleVertex, editableRing, insertAfter, insertVertex, midpoints, moveVertex, redo, removeLast, removeVertex, selectVertex, startDraw, undo, type DrawState, type LngLat } from '../zones/draw';
import { ZoneDrawPanel } from '../zones/ZoneDrawPanel';
import { Scene3DStatus, Scene3DToggle } from '../scene3d/Scene3DPanel';
import { useScene3D } from '../scene3d/useScene3D';
import { useBasemapStyle } from './basemap';
import { maplibregl, onTileStatus } from './maplibre';
import type { SceneBuilding } from '../scene3d/types';
import { noShadowCallback, SHADOW_JOB, SHADOW_RESULT, ShadowResultById, ShadowRunner } from '../shadow/ShadowPanel';
import { useShadowArtifact, useSpatialResult } from '../shadow/queries';
import { useSession } from '../../shell/session';
import { ZoneCard } from '../zones/ZoneCard';
import { useUi } from '../../shell/ui-store';
import { FeatureCard } from './FeatureCard';
import { cityDisplayName } from '../../city';
import { isProductMapLayer, productLabel } from '../../productCopy';
import {
  classToken,
  dataClasses,
  displayMinZoom,
  extrusionFilter,
  NOT_POINT_GEOMETRY,
  POINT_GEOMETRY,
  extrusionIdOf,
  featureIdOf,
  featureTitle,
  geometryBounds,
  geometryFamily,
  isUuid,
  layerIdsOf,
  layerSpecs,
  paintOf,
  renderability,
  sourceIdOf,
  sourceSpec,
  tileHeightBasis,
  type Semantic,
} from './publishedLayers';
import { MapInsightSelector, useMapInsightModel } from './MapInsightSelector';
import {
  INSIGHT_LAYER_IDS,
  insightPick,
  insightTooltip,
  syncInsightLayers,
  type InsightCollections,
  type InsightKind,
  type InsightPick,
} from './MapInsightLayers';

function supportsWebGL2(): boolean {
  try {
    return Boolean(document.createElement('canvas').getContext('webgl2'));
  } catch {
    return false;
  }
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}

/** Display-only bbox of the server geometry for camera fitting; not a spatial calculation. */
function boundsOf(geom: AreaGeometry): LngLatBoundsLike | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  for (const poly of polys) for (const ring of poly) for (const [x, y] of ring as [number, number][]) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

function baseStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': cssVar('--pg-map-bg') } }],
  };
}

function parseView(params: URLSearchParams): { center: [number, number]; zoom: number; pitch: number; bearing: number } | null {
  const ll = params.get('ll')?.split(',').map(Number);
  const z = Number(params.get('z'));
  if (!ll || ll.length !== 2 || ll.some((n) => !Number.isFinite(n)) || !Number.isFinite(z)) return null;
  const [lon, lat] = ll as [number, number];
  if (Math.abs(lon) > 180 || Math.abs(lat) > 85) return null;
  // Tilt and rotation belong to the 3D view; absent or invalid means a flat, north-up map.
  const p = Number(params.get('p') ?? 0);
  const b = Number(params.get('b') ?? 0);
  return {
    center: [lon, lat],
    zoom: Math.min(22, Math.max(0, z)),
    pitch: Number.isFinite(p) ? Math.min(85, Math.max(0, p)) : 0,
    bearing: Number.isFinite(b) ? ((((b + 180) % 360) + 360) % 360) - 180 : 0,
  };
}

/** Matches a media query and follows its changes. */
function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const sync = () => setOn(mq.matches);
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, [query]);
  return on;
}

function countsOf(buildings: SceneBuilding[]): Record<SceneBuilding['height_basis'], number> {
  const c = { measured: 0, recorded_unverified: 0, floors_estimate: 0, visual_placeholder: 0, unknown: 0 };
  for (const b of buildings) c[b.height_basis] += 1;
  return c;
}

/** Polygon outer rings of a server geometry as 3D footprints; other geometry types have none. */
function footprintsOf(g: Geometry): [number, number][][] {
  if (g.type === 'Polygon') return g.coordinates[0] ? [g.coordinates[0] as [number, number][]] : [];
  if (g.type === 'MultiPolygon') return g.coordinates.flatMap((p) => (p[0] ? [p[0] as [number, number][]] : []));
  return [];
}


/**
 * Runs fn once the map style exists. isStyleLoaded() is false while any source is still
 * tiling and 'load' fires only once, so "isStyleLoaded ? fn : once('load')" can drop updates.
 */
const loadedMaps = new WeakSet<maplibregl.Map>();
function whenStyleReady(m: maplibregl.Map, fn: () => void) {
  if (loadedMaps.has(m)) fn();
  else m.once('style.load', fn);
}

const EMPTY_FC: FeatureCollection = { type: 'FeatureCollection', features: [] };
const HIGHLIGHT = 'feature-highlight';

/**
 * fitBounds padding that keeps the target clear of whatever overlaps the canvas from below:
 * on phones the side panel is a bottom sheet drawn over the map.
 */
function framePadding(m: maplibregl.Map) {
  const c = m.getCanvas().getBoundingClientRect();
  const panel = document.querySelector('.pg-panel:not(.is-collapsed)')?.getBoundingClientRect();
  const overlapsX = panel && panel.left < c.right - 1 && panel.right > c.left + 1;
  const sheet = overlapsX && panel.top > c.top ? Math.max(0, c.bottom - panel.top) : 0;
  const base = Math.min(80, Math.max(24, c.width / 10));
  return { top: base, left: base, right: base, bottom: Math.min(c.height * 0.7, sheet + base) };
}

/**
 * Frames [w, s, e, n] keeping the current tilt and rotation (3D). A point has no extent:
 * fitBounds with pitch cannot size zero-area bounds, so it is centred at street zoom instead.
 */
function frameBounds(m: maplibregl.Map, b: [number, number, number, number]) {
  const padding = framePadding(m);
  if (b[0] === b[2] && b[1] === b[3]) {
    m.easeTo({ center: [b[0], b[1]], zoom: 17, padding, duration: 200 });
    return;
  }
  m.fitBounds(b, { padding, maxZoom: 17, duration: 200, pitch: m.getPitch(), bearing: m.getBearing() });
}

/** Fingers need bigger handles and a wider hit area than a mouse pointer (WCAG 2.5.8). */
const coarsePointer = () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
const HANDLE = coarsePointer() ? { vertex: 9, first: 11, mid: 7, hit: 18, close: 22 } : { vertex: 5, first: 7, mid: 4, hit: 6, close: 10 };
/** A finger moving less than this is a tap, not a drag (jitter must not move a vertex). */
const TOUCH_SLOP_PX = 8;
type DragState = { kind: 'vertex' | 'mid'; index: number; pos: LngLat };

/** Writes the drawing (polygon, path, rubber band, vertices, midpoints) into one source. */
function renderDraw(
  m: maplibregl.Map,
  d: DrawState | null,
  cursor: LngLat | null,
  drag: DragState | null,
) {
  if (!m.getSource('draw')) {
    if (!d) return;
    m.addSource('draw', { type: 'geojson', data: EMPTY_FC });
    m.addLayer({ id: 'draw-fill', type: 'fill', source: 'draw', filter: ['==', ['get', 'role'], 'polygon'], paint: { 'fill-color': cssVar('--pg-cat-3'), 'fill-opacity': 0.2 } });
    m.addLayer({
      id: 'draw-line',
      type: 'line',
      source: 'draw',
      filter: ['in', ['get', 'role'], ['literal', ['polygon', 'path']]],
      paint: { 'line-color': cssVar('--pg-cat-3'), 'line-width': 2.5 },
    });
    m.addLayer({
      id: 'draw-rubber',
      type: 'line',
      source: 'draw',
      filter: ['==', ['get', 'role'], 'rubber'],
      paint: { 'line-color': cssVar('--pg-cat-3'), 'line-width': 1.5, 'line-dasharray': [2, 2] },
    });
    m.addLayer({
      id: 'draw-mid',
      type: 'circle',
      source: 'draw',
      filter: ['==', ['get', 'role'], 'mid'],
      paint: { 'circle-radius': HANDLE.mid, 'circle-color': cssVar('--pg-surface'), 'circle-stroke-color': cssVar('--pg-cat-3'), 'circle-stroke-width': 1.5 },
    });
    m.addLayer({
      id: 'draw-vertices',
      type: 'circle',
      source: 'draw',
      filter: ['==', ['get', 'role'], 'vertex'],
      paint: {
        'circle-radius': ['case', ['get', 'sel'], HANDLE.first + 2, ['get', 'first'], HANDLE.first, HANDLE.vertex],
        'circle-color': cssVar('--pg-cat-3'),
        // The selected vertex is marked by size and a focus ring, not by colour alone.
        'circle-stroke-color': ['case', ['get', 'sel'], cssVar('--pg-focus'), cssVar('--pg-surface')],
        'circle-stroke-width': ['case', ['get', 'sel'], 4, 2],
      },
    });
  }
  const src = m.getSource('draw') as maplibregl.GeoJSONSource;
  if (!d) {
    src.setData(EMPTY_FC);
    return;
  }
  let v = d.vertices;
  if (drag?.kind === 'vertex') v = v.map((p, i) => (i === drag.index ? drag.pos : p));
  if (drag?.kind === 'mid') v = [...v.slice(0, drag.index + 1), drag.pos, ...v.slice(drag.index + 1)];
  const features: Feature[] = [];
  if (v.length >= 3 && d.closed) features.push({ type: 'Feature', properties: { role: 'polygon' }, geometry: { type: 'Polygon', coordinates: [[...v, v[0]!]] } });
  else if (v.length >= 2) features.push({ type: 'Feature', properties: { role: 'path' }, geometry: { type: 'LineString', coordinates: v } });
  if (!d.closed && cursor && v.length >= 1 && !drag) {
    features.push({ type: 'Feature', properties: { role: 'rubber' }, geometry: { type: 'LineString', coordinates: [v[v.length - 1]!, cursor] } });
  }
  v.forEach((p, i) => features.push({ type: 'Feature', properties: { role: 'vertex', i, first: i === 0, sel: !drag && i === d.selected }, geometry: { type: 'Point', coordinates: p } }));
  if (d.closed && !drag) midpoints(v).forEach((p, i) => features.push({ type: 'Feature', properties: { role: 'mid', i }, geometry: { type: 'Point', coordinates: p } }));
  src.setData({ type: 'FeatureCollection', features });
}

/** Platform layers stay above published data: data is inserted before the first of these. */
const PLATFORM_LAYERS = ['city-boundary-fill', 'city-boundary-line', 'zones-fill', 'zones-line', 'zones-selected', 'zone-history-line', 'draw-fill'];
const PLATFORM_SET = new Set<string>(PLATFORM_LAYERS);
const GEOMETRY_ORDER: Record<MapLayer['geometry_type'], number> = { raster: 0, polygon: 1, line: 2, point: 3 };

/**
 * Brings the map's published-layer sources in line with the manifests. A layer that left the
 * list (hidden, or replaced by a new version) loses its source, so its tiles stop loading.
 */
function syncDataLayers(m: maplibregl.Map, layers: MapLayer[], onMap: Map<string, MapLayer>, onBasemap: boolean) {
  const want = new Set(layers.map((l) => l.id));
  for (const [id, l] of onMap) {
    if (want.has(id)) continue;
    for (const lid of [...layerIdsOf(l), extrusionIdOf(id)]) if (m.getLayer(lid)) m.removeLayer(lid);
    if (m.getSource(sourceIdOf(id))) m.removeSource(sourceIdOf(id));
    onMap.delete(id);
  }
  const outline = cssVar(onBasemap ? '--pg-basemap-halo' : '--pg-surface');
  for (const l of layers) {
    const color = (s: Semantic) => cssVar(classToken(l, s, onBasemap));
    if (onMap.has(l.id) && m.getSource(sourceIdOf(l.id))) {
      for (const [lid, paint] of Object.entries(paintOf(l, color, outline))) {
        if (m.getLayer(lid)) for (const [k, v] of Object.entries(paint)) {
          type SetPaint = Parameters<maplibregl.Map['setPaintProperty']>;
          m.setPaintProperty(lid, k as SetPaint[1], v as SetPaint[2]);
        }
      }
      continue;
    }
    const r = renderability(l, window.location.origin);
    if (!r.ok) continue;
    // The lowest platform layer in the style, not the first in the list: zones may be added
    // before the city boundary, and data must stay under all of them.
    const before = m.getLayersOrder().find((id) => PLATFORM_SET.has(id));
    m.addSource(sourceIdOf(l.id), r.archive ? sourceSpec(l, r.url, true) : sourceSpec(l, r.tiles));
    for (const spec of layerSpecs(l, color, outline)) m.addLayer(spec, before);
    onMap.set(l.id, l);
  }
}

export interface FeaturePick {
  layerId: string;
  /** Stable public id (tile property feature_id); null when the tile carries none. */
  featureId: string | null;
  properties: Record<string, unknown>;
}

function MapCanvas({
  city,
  zones,
  selectedZoneId,
  focus,
  onSelectZone,
  draw,
  onDraw,
  onMapReady,
  historicZone = null,
  basemap = null,
  zonesReady = false,
  dataLayers = NO_LAYERS,
  onTileStatus: onTileStatusProp,
  onPickFeature,
  onPickInsight,
  onZoom,
  highlight = null,
  insights,
  enabledInsights,
}: {
  city: City | null;
  zones: Zone[];
  selectedZoneId: string | null;
  /** Set when the user picks a zone outside the map (list, link): frame that zone. */
  focus: { id: string; n: number } | null;
  onSelectZone: (id: string | null) => void;
  /** Active polygon drawing/editing; map clicks edit it instead of selecting zones. */
  draw: DrawState | null;
  onDraw: (update: (d: DrawState) => DrawState) => void;
  onMapReady: (m: maplibregl.Map | null) => void;
  /** Immutable earlier geometry of the selected zone (getZoneVersion), drawn dashed. */
  historicZone?: Zone | null;
  /** External basemap style (already preflighted); null = platform blank background. */
  basemap?: StyleSpecification | null;
  /** Zones request settled (loaded or unavailable); empty-but-loaded differs from not loaded. */
  zonesReady?: boolean;
  /** Visible, renderable published layers in draw order (listMapLayers). */
  dataLayers?: MapLayer[];
  onTileStatus?: (layerId: string, status: number | null) => void;
  onPickFeature?: (pick: FeaturePick | null) => void;
  onPickInsight?: (pick: InsightPick) => void;
  onZoom?: (zoom: number) => void;
  /** Server geometry of the feature in the open card (getMapFeature); frame = move the camera to it. */
  highlight?: { geometry: Geometry; frame: boolean } | null;
  /** Server-owned analytical results rendered above the ordinary city layers. */
  insights: InsightCollections;
  enabledInsights: Record<InsightKind, boolean>;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const [params, setParams] = useSearchParams();
  const paramsRef = useRef(params);
  const settled = useRef(false);
  paramsRef.current = params;
  const theme = useUi((s) => s.theme);
  const onSelectRef = useRef(onSelectZone);
  onSelectRef.current = onSelectZone;
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const onDrawRef = useRef(onDraw);
  onDrawRef.current = onDraw;
  const dragRef = useRef<DragState | null>(null);
  // Touch gesture on a handle: becomes a drag only after TOUCH_SLOP_PX, otherwise a tap.
  const touchRef = useRef<{ kind: 'vertex' | 'mid'; index: number; start: maplibregl.Point; moved: boolean } | null>(null);
  const mouseStart = useRef<maplibregl.Point | null>(null);
  // The browser follows a handled touch with a synthetic click; it must not add a vertex.
  const suppressClickUntil = useRef(0);
  // A link target (feature, zone) was framed: the later city fit must not override it.
  const targetFramed = useRef(false);
  const cursorRef = useRef<LngLat | null>(null);
  const onMapData = useRef(new Map<string, MapLayer>());
  const handlers = useRef({ onTileStatus: onTileStatusProp, onPickFeature, onPickInsight, onZoom });
  handlers.current = { onTileStatus: onTileStatusProp, onPickFeature, onPickInsight, onZoom };
  // Only tiles of layers on this map are reported (the protocol is global).
  useEffect(
    () =>
      onTileStatus(({ layerId, status }) => {
        if (onMapData.current.has(layerId)) handlers.current.onTileStatus?.(layerId, status);
      }),
    [],
  );
  // Extrusions first: in 3D a building's volume is drawn above its flat footprint.
  const dataLayerIds = () =>
    [...onMapData.current.values()].flatMap((l) => [extrusionIdOf(l.id), ...layerIdsOf(l)]).filter((id) => !id.endsWith('-raster') && map.current?.getLayer(id));
  const insightLayerIds = () => INSIGHT_LAYER_IDS.filter((id) => map.current?.getLayer(id));

  useEffect(() => {
    if (!el.current) return;
    const view = parseView(paramsRef.current);
    const m = new maplibregl.Map({
      container: el.current,
      style: basemap ?? baseStyle(),
      center: view?.center ?? [0, 0],
      zoom: view?.zoom ?? 1,
      pitch: view?.pitch ?? 0,
      bearing: view?.bearing ?? 0,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    const insightPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12 });
    // The camera is part of the deep link (TZ §03). The placeholder camera before the
    // city boundary arrives is not a user view and must not be written to the URL.
    settled.current = Boolean(view);
    m.on('moveend', (e) => {
      if (!settled.current && !e.originalEvent) return;
      settled.current = true;
      const c = m.getCenter();
      // The live URL, not the rendered params: a selection written in the same gesture may not
      // have committed yet (router navigations render in a transition) and must not be undone.
      const next = new URLSearchParams(window.location.search);
      next.set('ll', `${c.lng.toFixed(5)},${c.lat.toFixed(5)}`);
      next.set('z', m.getZoom().toFixed(2));
      const pitch = Math.round(m.getPitch());
      const bearing = Math.round(m.getBearing());
      if (pitch > 0) next.set('p', String(pitch));
      else next.delete('p');
      if (bearing !== 0) next.set('b', String(bearing));
      else next.delete('b');
      setParams(next, { replace: true });
    });
    // Platform layers need the style, not the basemap tiles: 'style.load' fires before 'load',
    // so slow external tiles never delay the boundary, zones or drawing.
    m.once('style.load', () => {
      loadedMaps.add(m);
      performance.mark('pg:map-style-ready');
    });
    m.on('error', (e) => {
      // Published-layer tile statuses reach the UI through the tile protocol (onTileStatus).
      if ((e as { sourceId?: string }).sourceId?.startsWith('pgl-')) return;
      console.error('[map]', e.error?.message ?? e.error);
    });
    m.on('zoomend', () => handlers.current.onZoom?.(m.getZoom()));
    m.once('load', () => handlers.current.onZoom?.(m.getZoom()));
    /** Nearest drawing handle within the pointer's hit radius; vertices win over midpoints. */
    const handleAt = (pt: maplibregl.Point): { kind: 'vertex' | 'mid'; index: number } | null => {
      if (!m.getLayer('draw-vertices')) return null;
      const r = HANDLE.hit;
      const box: [maplibregl.PointLike, maplibregl.PointLike] = [
        [pt.x - r, pt.y - r],
        [pt.x + r, pt.y + r],
      ];
      let best: { kind: 'vertex' | 'mid'; index: number; d: number } | null = null;
      for (const f of m.queryRenderedFeatures(box, { layers: ['draw-vertices', 'draw-mid'] })) {
        const [x, y] = (f.geometry as GeoJSON.Point).coordinates as LngLat;
        const kind = f.properties?.role === 'mid' ? 'mid' : 'vertex';
        const d = m.project([x, y]).dist(pt) + (kind === 'mid' ? r : 0);
        if (!best || d < best.d) best = { kind, index: Number(f.properties?.i), d };
      }
      return best ? { kind: best.kind, index: best.index } : null;
    };
    m.on('click', (e) => {
      const d = drawRef.current;
      if (d) {
        if (performance.now() < suppressClickUntil.current) return;
        if (d.closed) {
          // A click beside the handles clears the vertex selection.
          if (!handleAt(e.point)) onDrawRef.current((x) => selectVertex(x, null));
          return;
        }
        const pt: LngLat = [e.lngLat.lng, e.lngLat.lat];
        const first = d.vertices[0];
        const last = d.vertices[d.vertices.length - 1];
        // Clicking the first vertex closes; a repeated click on the last point (double-click) is ignored.
        if (first && d.vertices.length >= 3 && m.project(first).dist(e.point) < HANDLE.close) onDrawRef.current(closeRing);
        else if (!last || m.project(last).dist(e.point) > 3) onDrawRef.current((x) => addVertex(x, pt));
        return;
      }
      const insightIds = insightLayerIds();
      const insightFeature = insightIds.length ? m.queryRenderedFeatures(e.point, { layers: insightIds })[0] : undefined;
      const pickedInsight = insightPick(insightFeature?.properties);
      if (pickedInsight) {
        handlers.current.onPickInsight?.(pickedInsight);
        return;
      }
      const hit = m.getLayer('zones-fill') ? m.queryRenderedFeatures(e.point, { layers: ['zones-fill'] })[0] : undefined;
      // Exactly one selection callback per click: each rewrites the URL from the same params.
      if (hit) {
        onSelectRef.current(String(hit.properties?.id));
        return;
      }
      const ids = dataLayerIds();
      const f = ids.length ? m.queryRenderedFeatures(e.point, { layers: ids })[0] : undefined;
      const layerId = (f?.layer.metadata as { 'pg:layer'?: string } | undefined)?.['pg:layer'];
      handlers.current.onPickFeature?.(f && layerId ? { layerId, featureId: featureIdOf(f.properties), properties: f.properties ?? {} } : null);
    });
    m.on('dblclick', (e) => {
      if (!drawRef.current) return;
      e.preventDefault();
      onDrawRef.current(closeRing);
    });
    const startDrag = (kind: 'vertex' | 'mid') => (e: maplibregl.MapLayerMouseEvent) => {
      if (!drawRef.current || !e.features?.[0]) return;
      if (kind === 'mid' && !drawRef.current.closed) return;
      // Both handle layers get the same mousedown when they overlap; a vertex always wins.
      if (kind === 'mid' && m.queryRenderedFeatures(e.point, { layers: ['draw-vertices'] }).length) return;
      e.preventDefault();
      dragRef.current = { kind, index: Number(e.features[0].properties?.i), pos: [e.lngLat.lng, e.lngLat.lat] };
      mouseStart.current = e.point;
      m.dragPan.disable();
    };
    m.on('mousedown', 'draw-vertices', startDrag('vertex'));
    m.on('mousedown', 'draw-mid', startDrag('mid'));
    m.on('contextmenu', 'draw-vertices', (e) => {
      const f = e.features?.[0];
      if (!drawRef.current || !f) return;
      e.preventDefault();
      onDrawRef.current((x) => removeVertex(x, Number(f.properties?.i)));
    });
    const endDrag = (drag: DragState, moved: boolean) => {
      if (!moved) {
        // A press without movement selects the vertex (same as a tap); it is not an edit.
        if (drag.kind === 'vertex') onDrawRef.current((x) => selectVertex(x, drag.index));
        return;
      }
      onDrawRef.current((x) =>
        drag.kind === 'vertex' ? selectVertex(moveVertex(x, drag.index, drag.pos), drag.index) : selectVertex(insertVertex(x, drag.index, drag.pos), drag.index + 1),
      );
    };
    m.on('mouseup', (e) => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      m.dragPan.enable();
      const moved = !mouseStart.current || mouseStart.current.dist(e.point) >= 3;
      mouseStart.current = null;
      endDrag(drag, moved);
      renderDraw(m, drawRef.current, cursorRef.current, null);
    });

    // Touch: a finger that starts on a handle edits it and never pans the map; anywhere else
    // the map pans and zooms as usual. Two fingers always mean pan/zoom and cancel an edit.
    const cancelTouch = () => {
      if (!touchRef.current) return;
      touchRef.current = null;
      dragRef.current = null;
      m.dragPan.enable();
      renderDraw(m, drawRef.current, cursorRef.current, null);
    };
    m.on('touchstart', (e) => {
      const d = drawRef.current;
      if (!d) return;
      if (e.originalEvent.touches.length > 1) return cancelTouch();
      const h = handleAt(e.point);
      if (!h || (h.kind === 'mid' && !d.closed)) return;
      e.preventDefault();
      touchRef.current = { ...h, start: e.point, moved: false };
      m.dragPan.disable();
    });
    m.on('touchmove', (e) => {
      const tr = touchRef.current;
      if (!tr) return;
      if (e.originalEvent.touches.length > 1) return cancelTouch();
      if (!tr.moved && e.point.dist(tr.start) < TOUCH_SLOP_PX) return;
      tr.moved = true;
      e.preventDefault();
      dragRef.current = { kind: tr.kind, index: tr.index, pos: [e.lngLat.lng, e.lngLat.lat] };
      renderDraw(m, drawRef.current, null, dragRef.current);
    });
    m.on('touchend', () => {
      const tr = touchRef.current;
      if (!tr) return;
      const drag = dragRef.current;
      touchRef.current = null;
      dragRef.current = null;
      m.dragPan.enable();
      suppressClickUntil.current = performance.now() + 600;
      const d = drawRef.current;
      if (tr.moved && drag) endDrag(drag, true);
      else if (tr.kind === 'mid') onDrawRef.current((x) => insertAfter(x, tr.index));
      else if (d && !d.closed && tr.index === 0 && d.vertices.length >= 3) onDrawRef.current(closeRing);
      else endDrag({ kind: 'vertex', index: tr.index, pos: [0, 0] }, false);
      renderDraw(m, drawRef.current, null, null);
    });
    m.on('touchcancel', cancelTouch);
    m.on('mousemove', (e) => {
      if (drawRef.current) {
        insightPopup.remove();
        const pos: LngLat = [e.lngLat.lng, e.lngLat.lat];
        cursorRef.current = pos;
        if (dragRef.current) dragRef.current.pos = pos;
        renderDraw(m, drawRef.current, cursorRef.current, dragRef.current);
        const overHandle = m.getLayer('draw-vertices') && m.queryRenderedFeatures(e.point, { layers: ['draw-vertices', 'draw-mid'] }).length > 0;
        m.getCanvas().style.cursor = dragRef.current ? 'grabbing' : overHandle ? 'grab' : 'crosshair';
        return;
      }
      const insightIds = insightLayerIds();
      const insightFeature = insightIds.length ? m.queryRenderedFeatures(e.point, { layers: insightIds })[0] : undefined;
      const tooltip = insightTooltip(insightFeature?.properties);
      if (tooltip) {
        const body = document.createElement('div');
        body.className = 'map-insight-tooltip';
        const title = document.createElement('strong');
        title.textContent = tooltip.title;
        const detail = document.createElement('span');
        detail.textContent = tooltip.detail;
        body.append(title, detail);
        insightPopup.setLngLat(e.lngLat).setDOMContent(body).addTo(m);
      } else insightPopup.remove();
      const ids = [...insightIds, ...(m.getLayer('zones-fill') ? ['zones-fill'] : []), ...dataLayerIds()];
      m.getCanvas().style.cursor = ids.length && m.queryRenderedFeatures(e.point, { layers: ids }).length ? 'pointer' : '';
    });
    map.current = m;
    onMapReady(m);
    if (import.meta.env.DEV) (window as unknown as { __pgMap?: maplibregl.Map }).__pgMap = m;
    return () => {
      onMapReady(null);
      m.remove();
      map.current = null;
      onMapData.current.clear();
      insightPopup.remove();
    };
    // The map is created once; URL updates flow through paramsRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const apply = () => {
      // The basemap keeps its own colours; only the platform's blank background follows the theme.
      if (!basemap && m.getLayer('background')) m.setPaintProperty('background', 'background-color', cssVar('--pg-map-bg'));
      if (m.getLayer('city-boundary-line')) m.setPaintProperty('city-boundary-line', 'line-color', cssVar('--pg-map-boundary'));
      if (m.getLayer('zones-selected')) m.setPaintProperty('zones-selected', 'line-color', cssVar('--pg-focus'));
    };
    whenStyleReady(m, apply);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);

  useEffect(() => {
    const m = map.current;
    if (!m || !city) return;
    const draw = () => {
      const data: Feature = { type: 'Feature', properties: {}, geometry: city.boundary as Geometry };
      const src = m.getSource('city-boundary') as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData(data);
      else {
        m.addSource('city-boundary', { type: 'geojson', data });
        m.addLayer({ id: 'city-boundary-fill', type: 'fill', source: 'city-boundary', paint: { 'fill-color': cssVar('--pg-accent'), 'fill-opacity': 0.05 } });
        m.addLayer({
          id: 'city-boundary-line',
          type: 'line',
          source: 'city-boundary',
          paint: {
            'line-color': cssVar('--pg-map-boundary'),
            'line-width': 2,
            // A working (unconfirmed) boundary is drawn dashed, not only in another color.
            ...(city.boundary_status === 'working' ? { 'line-dasharray': [3, 2] } : {}),
          },
        });
      }
      if (!parseView(paramsRef.current) && !targetFramed.current) {
        const b = boundsOf(city.boundary);
        if (b) {
          settled.current = true;
          m.fitBounds(b, { padding: 48, animate: false });
        }
      }
    };
    whenStyleReady(m, draw);
  }, [city]);


  // Zones from the API as one GeoJSON source; selection is a filter, not a second copy.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const draw = () => {
      const data: FeatureCollection = {
        type: 'FeatureCollection',
        features: zones.map((z) => ({ type: 'Feature', id: z.id, properties: { id: z.id, name: z.name, purpose: z.purpose }, geometry: z.geometry as Geometry })),
      };
      const src = m.getSource('zones') as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData(data);
      else {
        m.addSource('zones', { type: 'geojson', data });
        m.addLayer({ id: 'zones-fill', type: 'fill', source: 'zones', paint: { 'fill-color': cssVar('--pg-cat-2'), 'fill-opacity': 0.18 } });
        m.addLayer({ id: 'zones-line', type: 'line', source: 'zones', paint: { 'line-color': cssVar('--pg-cat-2'), 'line-width': 1.5 } });
        m.addLayer({
          id: 'zones-selected',
          type: 'line',
          source: 'zones',
          filter: ['==', ['get', 'id'], ''],
          paint: { 'line-color': cssVar('--pg-focus'), 'line-width': 4 },
        });
      }
    };
    whenStyleReady(m, draw);
  }, [zones]);

  // AI/result overlays use only canonical problem, priority, scenario and zone responses.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    whenStyleReady(m, () => syncInsightLayers(m, insights, enabledInsights));
  }, [insights, enabledInsights]);

  // Published layers: theme changes re-resolve the semantic tokens of existing layers.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const apply = () => syncDataLayers(m, dataLayers, onMapData.current, Boolean(basemap));
    whenStyleReady(m, apply);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [dataLayers, theme]);

  // The open feature card's server geometry, above the published layers.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const apply = () => {
      const data: FeatureCollection = highlight
        ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: highlight.geometry }] }
        : EMPTY_FC;
      const src = m.getSource(HIGHLIGHT) as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData(data);
      else {
        m.addSource(HIGHLIGHT, { type: 'geojson', data });
        m.addLayer({ id: `${HIGHLIGHT}-halo`, type: 'line', source: HIGHLIGHT, filter: NOT_POINT_GEOMETRY, paint: { 'line-width': 7 } });
        m.addLayer({ id: `${HIGHLIGHT}-line`, type: 'line', source: HIGHLIGHT, filter: NOT_POINT_GEOMETRY, paint: { 'line-width': 3 } });
        m.addLayer({
          id: `${HIGHLIGHT}-point`,
          type: 'circle',
          source: HIGHLIGHT,
          filter: POINT_GEOMETRY,
          paint: { 'circle-radius': 9, 'circle-opacity': 0, 'circle-stroke-width': 3 },
        });
      }
      m.setPaintProperty(`${HIGHLIGHT}-halo`, 'line-color', cssVar('--pg-basemap-halo'));
      m.setPaintProperty(`${HIGHLIGHT}-line`, 'line-color', cssVar('--pg-focus'));
      m.setPaintProperty(`${HIGHLIGHT}-point`, 'circle-stroke-color', cssVar('--pg-focus'));
      const b = highlight?.frame ? geometryBounds(highlight.geometry) : null;
      if (b) {
        targetFramed.current = true;
        // A deliberate camera: from here on moves are written to the URL.
        settled.current = true;
        frameBounds(m, b);
      }
    };
    whenStyleReady(m, apply);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [highlight, theme]);

  // P-01 readiness: city boundary and zones from the API drawn and the map idle (includes
  // basemap tiles). Measured by scripts/p01-bench.mjs; also usable as production telemetry.
  const readyMarked = useRef(false);
  useEffect(() => {
    const m = map.current;
    if (!m || !city || !zonesReady || readyMarked.current) return;
    whenStyleReady(m, () => {
      m.once('idle', () => {
        if (readyMarked.current) return;
        readyMarked.current = true;
        performance.mark('pg:map-ready', { detail: { zones: zones.length } });
      });
      m.triggerRepaint();
    });
    // zones.length is reporting detail only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [city, zonesReady]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const apply = () => {
      if (!m.getLayer('zones-selected')) return;
      m.setFilter('zones-selected', ['==', ['get', 'id'], selectedZoneId ?? '']);
    };
    if (m.getLayer('zones-selected')) apply();
    else m.once('idle', apply);
  }, [selectedZoneId, zones]);

  // List/link -> map: frame the chosen zone. A click on the map does not move the camera.
  useEffect(() => {
    const m = map.current;
    if (!m || !focus) return;
    const z = zones.find((x) => x.id === focus.id);
    const b = z ? boundsOf(z.geometry) : null;
    if (b) {
      targetFramed.current = true;
      settled.current = true;
      frameBounds(m, b as [number, number, number, number]);
    }
    // Only a new focus request should move the camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);


  useEffect(() => {
    const m = map.current;
    if (!m) return;
    whenStyleReady(m, () => {
      const data: FeatureCollection = historicZone
        ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { version: historicZone.version_id }, geometry: historicZone.geometry as Geometry }] }
        : EMPTY_FC;
      const src = m.getSource('zone-history') as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData(data);
      else {
        m.addSource('zone-history', { type: 'geojson', data });
        m.addLayer({
          id: 'zone-history-line',
          type: 'line',
          source: 'zone-history',
          paint: { 'line-color': cssVar('--pg-cat-4'), 'line-width': 2.5, 'line-dasharray': [2, 1.5] },
        });
      }
    });
  }, [historicZone]);

  // Drawing overlay: re-rendered on every state change; double-click zoom is off while drawing.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const apply = () => {
      if (draw) m.doubleClickZoom.disable();
      else {
        m.doubleClickZoom.enable();
        m.getCanvas().style.cursor = '';
      }
      if (draw?.selected != null) m.keyboard.disable();
      else m.keyboard.enable();
      renderDraw(m, draw, cursorRef.current, dragRef.current);
    };
    whenStyleReady(m, apply);
  }, [draw]);

  return (
    <>
      <div
        ref={el}
        className="map-canvas"
        role="region"
        aria-label={t('map.region')}
        tabIndex={0}
        onKeyDown={(e) => {
          const m = map.current;
          if (!draw || !m) return;
          const sel = draw.selected ?? null;
          const arrow = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
          let handled = true;
          if (e.key === '[' || e.key === ']') onDraw((x) => cycleVertex(x, e.key === ']' ? 1 : -1));
          else if (e.key === 'Escape' && sel !== null) onDraw((x) => selectVertex(x, null));
          else if (arrow && sel !== null) {
            // Screen-space nudge: 5 px per press, 1 px with Shift; each press is one undo step.
            const step = e.shiftKey ? 1 : 5;
            const p = m.project(draw.vertices[sel]!);
            const ll = m.unproject([p.x + arrow[0]! * step, p.y + arrow[1]! * step]);
            onDraw((x) => moveVertex(x, sel, [ll.lng, ll.lat]));
          } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel !== null) onDraw((x) => removeVertex(x, sel));
          else if ((e.key === 'i' || e.key === 'I' || e.key === 'Insert') && sel !== null) onDraw((x) => insertAfter(x, sel));
          else if (e.key === 'Enter' && !draw.closed) {
            const c = m.getCenter();
            onDraw((x) => addVertex(x, [c.lng, c.lat]));
          } else if (e.key === 'Backspace') onDraw(removeLast);
          else handled = false;
          if (handled) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
      />
      {draw && !draw.closed && draw.selected == null ? <div className="map-crosshair" aria-hidden title={t('draw.crosshair')} /> : null}
      {draw && draw.selected != null ? (
        <div className="draw-vertex-bar" role="toolbar" aria-label={t('draw.vertex.toolbar')}>
          <span className="draw-vertex-bar__label">{t('draw.vertex.selected', { n: draw.selected + 1, total: draw.vertices.length })}</span>
          <Button size="sm" icon="x" onClick={() => onDraw((x) => removeVertex(x, x.selected ?? -1))}>
            {t('draw.vertex.delete')}
          </Button>
          {draw.closed || draw.selected < draw.vertices.length - 1 ? (
            <Button size="sm" icon="plus" title={t('draw.vertex.insert.title')} onClick={() => onDraw((x) => insertAfter(x, x.selected ?? -1))}>
              {t('draw.vertex.insert')}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => onDraw((x) => selectVertex(x, null))}>
            {t('draw.vertex.done')}
          </Button>
        </div>
      ) : null}
    </>
  );
}

type LayersQuery = ReturnType<typeof useMapLayers>;

function LayerItem({
  layer: l,
  hidden,
  onToggle,
  tileError,
  zoom,
  onBasemap,
}: {
  layer: MapLayer;
  hidden: boolean;
  onToggle: () => void;
  tileError: number | null | undefined;
  zoom: number | null;
  /** Swatches use the same palette as the map: the basemap one when the basemap is shown. */
  onBasemap: boolean;
}) {
  const r = renderability(l, window.location.origin);
  const unknown = l.legend.unknown_class_key ? l.legend.classes.find((c) => c.key === l.legend.unknown_class_key) : undefined;
  const tileMsg =
    tileError === undefined ? null : tileError === 401 || tileError === 403 || tileError === 404 ? t(`map.layer.tiles.${tileError}` as AppKey) : tileError === null ? t('map.layer.tiles.network') : t('map.layer.tiles.other', { status: tileError });
  return (
    <div className={hidden ? 'map-layer is-hidden' : 'map-layer'} data-layer-id={l.id}>
      <div className="map-layer__head">
        <label className="map-layer__toggle">
          <input type="checkbox" checked={!hidden && r.ok} disabled={!r.ok} onChange={onToggle} aria-label={t('map.layer.show', { name: productLabel(l.name) })} />
          <strong>{productLabel(l.name)}</strong>
        </label>
        {l.access_level === 'restricted' ? <Badge tone="warning" icon="lock">по доступу</Badge> : null}
      </div>
      <p className="pg-muted">
        {t(`map.layer.category.${l.category}` as AppKey)} · {t(`map.layer.geometry.${l.geometry_type}` as AppKey)}
      </p>
      {l.is_stale ? (
        <Badge tone="warning" icon="clock">
          {t('map.layer.stale')}
        </Badge>
      ) : null}
      {!r.ok ? <Notice tone="warning" title={t(`map.layer.unrenderable.${r.reason}` as AppKey, { format: l.source_type })} /> : null}
      {tileMsg && !hidden ? <Notice tone={tileError === 404 ? 'info' : 'negative'} title={tileMsg} /> : null}
      {r.ok && !hidden && zoom !== null && zoom < displayMinZoom(l) ? <p className="pg-muted">{t('map.layer.zoomIn', { zoom: displayMinZoom(l) })}</p> : null}
      <Legend
        title={t('map.layer.legend')}
        classes={dataClasses(l.legend).map((c) => ({ key: c.key, label: c.label, swatch: `var(${classToken(l, c.semantic, onBasemap)})`, pattern: c.semantic === 'unknown' ? 'hatched' : 'solid' }))}
        unit={l.legend.unit}
        period={l.legend.period}
        stale={l.is_stale}
        unknownLabel={unknown ? unknown.label : null}
      />
      <details className="map-layer__more">
        <summary>{t('map.layer.more')}</summary>
        <dl className="pg-dl">
          <dt>{t('map.layer.version')}</dt>
          <dd>
            <code className="pg-code" title={l.dataset_version_id}>
              {l.dataset_version_id.slice(0, 8)}
            </code>
          </dd>
          <dt>{t('map.layer.observedAt')}</dt>
          <dd>{l.observed_at ? formatDateTime(l.observed_at) : t('map.layer.observed.none')}</dd>
          <dt>{t('map.layer.zoom')}</dt>
          <dd>
            z{l.min_zoom}–{l.max_zoom} · {l.source_type}
          </dd>
        </dl>
      </details>
    </div>
  );
}

function LayerList({
  available,
  layers,
  hidden,
  onToggle,
  tileErrors,
  zoom,
  onBasemap,
}: {
  available: boolean | null;
  layers: LayersQuery;
  hidden: ReadonlySet<string>;
  onToggle: (id: string) => void;
  tileErrors: Record<string, number | null>;
  zoom: number | null;
  onBasemap: boolean;
}) {
  if (available === false) return <OperationUnavailable compact operationId="listMapLayers" />;
  if (layers.isPending) return <Skeleton lines={4} />;
  if (layers.isError) return <ApiErrorView compact error={layers.error} onRetry={() => void layers.refetch()} />;
  const items = layers.data.items.filter(isProductMapLayer);
  if (items.length === 0) return <StateView compact state="empty" title={t('map.layers.empty')} description={t('map.layers.empty.desc')} />;
  return (
    <div className="map-layers">
      <p className="pg-muted">
        {layers.data.truncated ? t('map.layers.truncated', { count: items.length }) : t('map.layers.count', { count: items.length })}. {t('map.layers.note')}
      </p>
      {items.map((l) => (
        <LayerItem key={l.id} layer={l} hidden={hidden.has(l.id)} onToggle={() => onToggle(l.id)} tileError={tileErrors[l.id]} zoom={zoom} onBasemap={onBasemap} />
      ))}
    </div>
  );
}

/** Hidden layer ids per city: a per-viewer convenience kept in localStorage. */
function useHiddenLayers(cityId: string | null, layers: MapLayer[]) {
  const key = cityId ? `pg.map.hidden.${cityId}` : null;
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!key || layers.length === 0) return;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw !== null) {
        setHidden(new Set(JSON.parse(raw) as string[]));
        return;
      }
      // Roads duplicate the basemap and dense social points obscure the city at the opening
      // zoom. They remain one click away in the layer list and a viewer's choice is persisted.
      const defaults = new Set(
        layers.filter((layer) => layer.category === 'road' || layer.category === 'social_facility').map((layer) => layer.id),
      );
      setHidden(defaults);
      window.localStorage.setItem(key, JSON.stringify([...defaults]));
    } catch {
      setHidden(new Set());
    }
  }, [key, layers]);
  const toggle = useCallback(
    (id: string) =>
      setHidden((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        if (key) {
          try {
            window.localStorage.setItem(key, JSON.stringify([...next]));
          } catch {
            /* per-viewer convenience only */
          }
        }
        return next;
      }),
    [key],
  );
  return [hidden, toggle] as const;
}

function CityContext({ city }: { city: City }) {
  const suffix = `?city=${encodeURIComponent(city.id)}`;
  const setAssistantOpen = useUi((state) => state.setAssistantOpen);
  const { hasRole } = useSession();
  return (
    <div className="map-ctx">
      <div className="map-start">
        <p className="map-start__eyebrow">{t('map.start.eyebrow')}</p>
        <h3>{t('map.start.title')}</h3>
        <ol>
          <li>{t('map.start.step1')}</li>
          <li>{t('map.start.step2')}</li>
          <li>{t('map.start.step3')}</li>
        </ol>
        <p className="map-start__coverage">{t('map.start.coverage')}</p>
        <div className="map-start__actions">
          <Link className="pg-btn pg-btn--primary pg-btn--sm" to={`/projects${suffix}`}>{t('map.start.projects')}</Link>
          <Link className="pg-btn pg-btn--secondary pg-btn--sm" to={`/catalog${suffix}`}>{t('map.start.catalog')}</Link>
        </div>
      </div>
      {hasRole('specialist') ? (
        <div className="map-ai-callout">
          <span className="map-ai-callout__icon"><Icon name="chat" size={19} /></span>
          <div><strong>ИИ помогает подготовить решение</strong><p>Спросите о проблемах участка, подходящих растениях, стоимости и уходе. Изменения применяются только после вашего подтверждения.</p></div>
          <Button size="sm" variant="secondary" onClick={() => setAssistantOpen(true)}>Спросить ИИ</Button>
        </div>
      ) : null}
      <details className="map-layer__more">
        <summary>{t('map.ctx.city')}</summary>
        <dl className="pg-dl">
          <dt>{t('map.ctx.city')}</dt>
          <dd>{cityDisplayName(city.name)}</dd>
          <dt>{t('map.ctx.timezone')}</dt>
          <dd>{city.timezone}</dd>
          <dt>{t('map.ctx.crs')}</dt>
          <dd><code className="pg-code">{city.metric_crs}</code></dd>
        </dl>
      </details>
    </div>
  );
}

function ZoneList({ zones, truncated, selectedId, onSelect }: { zones: Zone[]; truncated: boolean; selectedId: string | null; onSelect: (id: string) => void }) {
  if (zones.length === 0) return <StateView compact state="empty" title={t('zones.empty')} description={t('zones.empty.desc')} />;
  return (
    <>
      <p className="pg-muted">{truncated ? t('zones.truncated', { count: zones.length }) : t('zones.count', { count: zones.length })}</p>
      <DataTable
        caption={t('zones.list')}
        columns={[
          { key: 'name', header: t('col.name'), render: (z: Zone) => z.name },
          { key: 'purpose', header: t('col.kind'), render: (z: Zone) => t(`purpose.${z.purpose}` as AppKey) },
          {
            key: 'gaps',
            header: t('zone.ctx.gaps'),
            // Only gaps that block a calculation are counted on the map (presentation policy).
            render: (z: Zone) =>
              z.data_gaps.some((g) => g.blocking) ? (
                <Badge tone="warning" icon="alert">
                  {z.data_gaps.filter((g) => g.blocking).length}
                </Badge>
              ) : (
                '—'
              ),
            align: 'end',
          },
        ]}
        rows={zones}
        getRowId={(z) => z.id}
        selectedId={selectedId}
        onSelect={(z) => onSelect(z.id)}
        maxHeight="16rem"
      />
    </>
  );
}

export function MapWorkspace() {
  const gate = useCityGate();
  const navigate = useNavigate();
  const [webgl] = useState(supportsWebGL2);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [params, setParams] = useSearchParams();
  const q = params.get('city') ? `?city=${params.get('city')}` : '';
  const selectedZoneId = params.get('zone');
  const zonesOk = useOperationAvailable('listZones');
  const zones = useZones(gate.city?.id ?? null);
  const zoneItems = zones.data?.items ?? EMPTY_ZONES;
  const { hasRole } = useSession();
  const createOk = useOperationAvailable('createZone');
  const updateOk = useOperationAvailable('updateZone');
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [mapReady, setMapReady] = useState(false);
  // Phones: the feature card lives in the bottom sheet instead of floating over the map.
  const narrow = useMedia('(max-width: 767px)');
  const basemapState = useBasemapStyle();
  const qc = useQueryClient();
  const layersOk = useOperationAvailable('listMapLayers');
  const cityId = gate.city?.id ?? null;
  const insightModel = useMapInsightModel({ cityId, zones: zoneItems, selectedZoneId });
  const layers = useMapLayers(layersOk === false ? null : cityId);
  const [tileErrors, setTileErrors] = useState<Record<string, number | null>>({});
  const [zoom, setZoom] = useState<number | null>(null);
  const [pick, setPick] = useState<FeaturePick | null>(null);
  const rawLayerItems = layers.data?.items ?? NO_LAYERS;
  const layerItems = useMemo(() => rawLayerItems.filter(isProductMapLayer), [rawLayerItems]);
  const [hiddenLayers, toggleLayer] = useHiddenLayers(cityId, layerItems);
  const visibleLayers = useMemo(
    () =>
      layerItems
        .filter((l) => !hiddenLayers.has(l.id) && renderability(l, window.location.origin).ok)
        .sort((a, b) => GEOMETRY_ORDER[a.geometry_type] - GEOMETRY_ORDER[b.geometry_type]),
    [layerItems, hiddenLayers],
  );
  const refetched404 = useRef(new Set<string>());
  // Every tile reports a status; React state is touched only when a layer's error changes.
  // A setState per good tile is a stream of urgent updates that keeps interrupting router
  // navigations (they render in a transition), e.g. the zone card never replaced the context.
  const tileErrorsRef = useRef(tileErrors);
  tileErrorsRef.current = tileErrors;
  const onTileStatus = useCallback(
    (layerId: string, status: number | null) => {
      const known = tileErrorsRef.current;
      if (status !== null && status < 400) {
        // A good tile clears the layer's error.
        if (!(layerId in known)) return;
        const next = { ...known };
        delete next[layerId];
        tileErrorsRef.current = next;
        setTileErrors(next);
        return;
      }
      if (known[layerId] !== status || !(layerId in known)) {
        const next = { ...known, [layerId]: status };
        tileErrorsRef.current = next;
        setTileErrors(next);
      }
      // The manifest no longer points at the current version: fetch the new list once.
      if (status === 404 && cityId && !refetched404.current.has(layerId)) {
        refetched404.current.add(layerId);
        void qc.invalidateQueries({ queryKey: qk.layers(cityId) });
      }
    },
    [cityId, qc],
  );
  // The open feature lives in the URL (?feature=) and survives reload; the tile attributes of
  // the clicked feature are kept in memory only. Zone and feature selection are exclusive.
  const featureParam = params.get('feature');
  const featureId = isUuid(featureParam) ? featureParam.toLowerCase() : null;
  const pickNow = pick && (pick.featureId ? pick.featureId === featureId : !featureId) ? pick : null;
  const feature = useMapFeature(featureId);
  const featureData = feature.query.data?.id === featureId ? feature.query.data : undefined;
  const pickedLayer = useMemo(() => {
    if (pickNow) return layerItems.find((l) => l.id === pickNow.layerId) ?? null;
    if (!featureData) return null;
    const family = geometryFamily(featureData.geometry.type);
    const same = layerItems.filter((l) => l.dataset_version_id === featureData.dataset_version_id);
    return same.find((l) => l.geometry_type === family) ?? same[0] ?? null;
  }, [pickNow, featureData, layerItems]);
  // 404: the version is no longer current (or no grant); the manifests are refetched once.
  const refetchedFeature404 = useRef(new Set<string>());
  const featureNotFound = feature.query.error instanceof ApiError && feature.query.error.category === 'not_found';
  useEffect(() => {
    if (!featureNotFound || !featureId || !cityId || refetchedFeature404.current.has(featureId)) return;
    refetchedFeature404.current.add(featureId);
    void qc.invalidateQueries({ queryKey: qk.layers(cityId) });
  }, [featureNotFound, featureId, cityId, qc]);
  // A shared link without a saved camera frames the feature once; a map click never moves it.
  // Decided at arrival: the city fit writes ll into the URL before the card's data comes back.
  const featureLinkHasCamera = useRef(Boolean(params.get('ll')));
  const framedFeature = useRef<string | null>(null);
  const highlight = useMemo(() => {
    if (!featureData) return null;
    const frame = !pickNow && !featureLinkHasCamera.current && framedFeature.current === null;
    if (frame) framedFeature.current = featureData.id;
    return { geometry: featureData.geometry as Geometry, frame };
  }, [featureData, pickNow]);
  // No operation lists buildings with height_basis yet (ADR-004 §6): the 3D scene holds the
  // selected published object, with the server geometry and the server height only. Unknown
  // height stays a flat footprint; nothing here derives metres from floors or anything else.
  const buildings = useMemo<SceneBuilding[]>(() => {
    if (!featureData) return NO_BUILDINGS;
    return footprintsOf(featureData.geometry as Geometry).map((footprint, i) => ({
      id: `${featureData.id}:${i}`,
      footprint,
      height_m: featureData.height_basis === 'unknown' ? null : featureData.height_m,
      height_basis: featureData.height_basis,
    }));
  }, [featureData]);
  const scene3d = useScene3D(() => mapRef.current, buildings);
  if (import.meta.env.DEV) (window as unknown as { __pgScene?: typeof scene3d }).__pgScene = scene3d;
  // Published building layers in 3D straight from their tiles (height_m/height_basis, ADR-004 §6):
  // only accepted numeric heights get a volume. The selected feature is drawn by the scene from
  // its server card, so the tile copy is filtered out. Counts describe what is in the frame.
  // Server shadow of a finished run (?shadow=<result id>): geometry only from the artifact.
  const shadowId = isUuid(params.get(SHADOW_RESULT)) ? params.get(SHADOW_RESULT)!.toLowerCase() : null;
  const shadowResult = useSpatialResult(shadowId);
  const shadowArtifact = useShadowArtifact(shadowResult.query.data);
  const shadowGeometry = shadowArtifact.query.data?.features[0]?.geometry ?? null;
  const shadowFramed = useRef<string | null>(null);
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !mapReady) return;
    const apply = () => {
      if (!shadowGeometry) {
        if (m.getLayer('shadow-fill')) m.removeLayer('shadow-fill');
        if (m.getSource('shadow')) m.removeSource('shadow');
        return;
      }
      const data = { type: 'Feature' as const, properties: {}, geometry: shadowGeometry };
      const src = m.getSource('shadow') as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData(data);
      else m.addSource('shadow', { type: 'geojson', data });
      if (!m.getLayer('shadow-fill')) {
        const before = m.getLayersOrder().find((id) => PLATFORM_SET.has(id));
        m.addLayer({ id: 'shadow-fill', type: 'fill', source: 'shadow', paint: { 'fill-color': cssVar('--pg-map-shadow'), 'fill-opacity': 0.45 } }, before);
      }
      // A link without a camera opens on the shadow once.
      const b = geometryBounds(shadowGeometry);
      if (b && shadowFramed.current !== shadowId && !new URLSearchParams(window.location.search).get('ll')) frameBounds(m, b);
      shadowFramed.current = shadowId;
    };
    if (m.isStyleLoaded()) apply();
    else m.once('idle', apply);
  }, [mapReady, shadowGeometry, shadowId]);
  const closeShadow = () => {
    const next = new URLSearchParams(window.location.search);
    next.delete(SHADOW_RESULT);
    next.delete(SHADOW_JOB);
    setParams(next, { replace: true });
  };
  const [frameCounts, setFrameCounts] = useState<Record<SceneBuilding['height_basis'], number> | null>(null);
  useEffect(() => {
    const m = mapRef.current;
    // While the context is lost (MapLibre snapshots the style to restore it) or 3D is loading,
    // the style is left alone.
    if (!m || !mapReady || scene3d.state === 'context_lost' || scene3d.state === 'loading') return;
    const on = scene3d.state === 'on';
    const own = visibleLayers.filter((l) => l.category === 'building' && l.geometry_type === 'polygon');
    const wanted = new Set(on ? own.map((l) => extrusionIdOf(l.id)) : []);
    for (const id of m.getLayersOrder()) if (id.endsWith('-extrusion') && !wanted.has(id)) m.removeLayer(id);
    if (!on) {
      setFrameCounts(null);
      return;
    }
    const estimated = cssVar('--pg-prov-estimated');
    for (const l of own) {
      const id = extrusionIdOf(l.id);
      if (!m.getSource(sourceIdOf(l.id))) continue;
      if (m.getLayer(id)) {
        m.setFilter(id, extrusionFilter(featureId));
        continue;
      }
      m.addLayer({
        id,
        type: 'fill-extrusion',
        metadata: { 'pg:layer': l.id },
        source: sourceIdOf(l.id),
        'source-layer': l.source_layer ?? '',
        filter: extrusionFilter(featureId),
        paint: {
          'fill-extrusion-color': ['match', ['get', 'height_basis'], 'measured', cssVar('--pg-prov-measured'), estimated],
          'fill-extrusion-height': ['get', 'height_m'],
          'fill-extrusion-base': 0,
          'fill-extrusion-opacity': 0.85,
        },
      });
    }
    const count = () => {
      const fills = own.map((l) => layerIdsOf(l)[0]!).filter((id) => m.getLayer(id));
      const seen = new Map<string, SceneBuilding['height_basis']>();
      for (const f of fills.length ? m.queryRenderedFeatures({ layers: fills }) : []) {
        const props = (f.properties ?? {}) as Record<string, unknown>;
        const key = String(props.feature_id ?? f.id ?? '');
        if (key && !seen.has(key)) seen.set(key, tileHeightBasis(props));
      }
      // The selected feature counts once, with its server basis.
      if (featureData) seen.set(featureData.id, featureData.height_basis);
      const c = { measured: 0, recorded_unverified: 0, floors_estimate: 0, visual_placeholder: 0, unknown: 0 };
      for (const basis of seen.values()) c[basis] += 1;
      setFrameCounts(c);
    };
    count();
    m.on('idle', count);
    return () => {
      m.off('idle', count);
    };
  }, [mapReady, scene3d.state, visibleLayers, featureId, featureData]);
  // 3D is part of the link (?scene=3d with p/b): entering writes it, leaving clears tilt and rotation.
  const enter3d = async () => {
    await scene3d.enable();
    const next = new URLSearchParams(window.location.search);
    next.set('scene', '3d');
    setParams(next, { replace: true });
  };
  const exit3d = () => {
    scene3d.disable();
    const next = new URLSearchParams(window.location.search);
    for (const k of ['scene', 'p', 'b']) next.delete(k);
    setParams(next, { replace: true });
  };
  const autoScene = useRef(params.get('scene') === '3d');
  useEffect(() => {
    const m = mapRef.current;
    if (!mapReady || !m || !autoScene.current || scene3d.state !== 'off') return;
    autoScene.current = false;
    if (m.loaded()) void scene3d.enable();
    else m.once('load', () => void scene3d.enable());
  }, [mapReady, scene3d]);

  const pickFeature = (p: FeaturePick | null) => {
    setPick(p);
    if (p && narrow) setPanelCollapsed(false);
    // From the live URL: a camera write of the same gesture may not have rendered yet.
    const live = new URLSearchParams(window.location.search);
    const next = new URLSearchParams(live);
    next.delete('zone');
    if (p?.featureId) next.set('feature', p.featureId);
    else next.delete('feature');
    if (next.toString() !== live.toString()) setParams(next, { replace: true });
  };
  const showFeature = Boolean(featureId || (pickNow && pickedLayer));
  const historicId = params.get('zoneVersion');
  const historic = useZoneVersion(selectedZoneId && historicId ? historicId : null);
  // Only an earlier version of the selected zone is drawn; anything else is explained in the card.
  const historicZone = historic.query.data && historic.query.data.id === selectedZoneId ? historic.query.data : null;
  const cityKey = gate.city ? `pg.zone-draw.${gate.city.id}` : null;
  const [draw, setDrawState] = useState<DrawState | null>(null);
  const [restoredDraw, setRestoredDraw] = useState(false);

  // An unsaved contour survives reload per viewer; it is labelled as local.
  useEffect(() => {
    if (!cityKey) return;
    try {
      const raw = window.localStorage.getItem(cityKey);
      if (!raw) return;
      const saved = JSON.parse(raw) as Pick<DrawState, 'mode' | 'zoneId' | 'vertices' | 'closed'>;
      setDrawState({ ...saved, past: [], future: [] });
      setRestoredDraw(true);
    } catch {
      /* ignore unreadable draft */
    }
  }, [cityKey]);

  const setDraw = (next: DrawState | null) => {
    setDrawState(next);
    if (!cityKey) return;
    try {
      if (next) window.localStorage.setItem(cityKey, JSON.stringify({ mode: next.mode, zoneId: next.zoneId, vertices: next.vertices, closed: next.closed }));
      else window.localStorage.removeItem(cityKey);
    } catch {
      /* storage blocked: the contour lives in memory only */
    }
  };
  const updateDraw = (fn: (d: DrawState) => DrawState) => setDrawState((d) => {
    if (!d) return d;
    const next = fn(d);
    if (cityKey) {
      try {
        window.localStorage.setItem(cityKey, JSON.stringify({ mode: next.mode, zoneId: next.zoneId, vertices: next.vertices, closed: next.closed }));
      } catch {
        /* per-viewer convenience only */
      }
    }
    return next;
  });

  // Ctrl+Z / Ctrl+Y while drawing, unless typing in a field.
  useEffect(() => {
    if (!draw) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        updateDraw(undo);
        e.preventDefault();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        updateDraw(redo);
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const startEdit = (zone: Zone) => {
    const ring = editableRing(zone.geometry);
    if (!ring) return;
    setRestoredDraw(false);
    setDraw(startDraw('edit', zone.id, ring));
    setPanelCollapsed(false);
    // Vertex handles need room: frame the zone being edited.
    setFocus((f) => ({ id: zone.id, n: (f?.n ?? 0) + 1 }));
  };
  const finishDraw = (zoneId: string | null) => {
    setDraw(null);
    setRestoredDraw(false);
    if (zoneId) selectZone(zoneId, true);
  };

  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null);
  const selectZone = (id: string | null, frame = false) => {
    const next = new URLSearchParams(params);
    if (id) next.set('zone', id);
    else next.delete('zone');
    next.delete('feature');
    setPick(null);
    setParams(next, { replace: true });
    if (id) setPanelCollapsed(false);
    if (id && frame) setFocus((f) => ({ id, n: (f?.n ?? 0) + 1 }));
  };
  const selectInsight = (insight: InsightPick) => {
    if (insight.kind === 'placements' && insight.scenarioId) {
      navigate(`/scenarios/${encodeURIComponent(insight.scenarioId)}${cityId ? `?city=${encodeURIComponent(cityId)}` : ''}`);
      return;
    }
    if (insight.zoneId) selectZone(insight.zoneId, true);
  };
  // A deep link with ?zone= but without a saved camera frames the zone once it is loaded.
  const framedFromLink = useRef(false);
  // Decided from the URL at arrival: the city fit writes ll later and must not cancel this.
  const arrivedWithCamera = useRef(Boolean(params.get('ll')));
  useEffect(() => {
    if (framedFromLink.current || !selectedZoneId || arrivedWithCamera.current || zoneItems.length === 0) return;
    framedFromLink.current = true;
    setFocus({ id: selectedZoneId, n: 1 });
  }, [selectedZoneId, zoneItems, params]);

  const docked = webgl && showFeature && !draw && narrow;
  const featureCard = (
    <FeatureCard
      featureId={featureId}
      available={feature.available}
      query={feature.query}
      layer={pickedLayer}
      properties={pickNow?.properties ?? null}
      docked={narrow}
      onClose={() => pickFeature(null)}
    />
  );

  return (
    <div className={draw ? 'map-page map-page--drawing' : 'map-page'}>
      <header className="map-page__head">
        <div className="map-page__title">
          <p className="app-eyebrow">{t('map.workspace.eyebrow')}</p>
          <h1>{t('map.workspace.title')}</h1>
          <p>{t('map.workspace.desc')}</p>
        </div>
        <div className="map-page__actions">
          {gate.city && createOk !== false && hasRole('specialist') ? (
            <Button
              variant="primary"
              icon="plus"
              onClick={() => {
                setRestoredDraw(false);
                setDraw(startDraw('create'));
                setPanelCollapsed(false);
              }}
            >
              {t('map.workspace.pickZone')}
            </Button>
          ) : null}
          <Link className="pg-btn pg-btn--secondary pg-btn--md" to={`/imports${q}`}>
            {t('map.workspace.import')}
          </Link>
        </div>
      </header>
      <div className="map-page__body">
      <div className="map-stage">
        {!webgl && gate.view ? (
          // Without WebGL the sign-in/city state comes first; the 2D fallback follows once it is resolved.
          <div className="map-overlay__card map-overlay__card--static">{gate.view}</div>
        ) : webgl && basemapState.status === 'loading' ? (
          <div className="map-basemap-loading" role="status">
            {t('basemap.loading')}
          </div>
        ) : webgl ? (
          <MapCanvas
            basemap={basemapState.status === 'ready' ? basemapState.style : null}
            city={gate.city}
            zones={zoneItems}
            selectedZoneId={selectedZoneId}
            focus={focus}
            onSelectZone={selectZone}
            draw={draw}
            onDraw={updateDraw}
            onMapReady={(m) => {
              mapRef.current = m;
              setMapReady(Boolean(m));
            }}
            historicZone={historicZone}
            zonesReady={zonesOk === false || zones.isSuccess || zones.isError}
            dataLayers={visibleLayers}
            onTileStatus={onTileStatus}
            onPickFeature={pickFeature}
            onPickInsight={selectInsight}
            onZoom={setZoom}
            highlight={draw ? null : highlight}
            insights={insightModel.collections}
            enabledInsights={insightModel.enabled}
          />
        ) : (
          <StateView
            state="unavailable"
            title={t('map.noWebgl')}
            description={t('map.noWebgl.desc')}
            actions={
              <Link className="pg-btn pg-btn--primary pg-btn--md" to={`/problems${q}`}>
                {t('map.openProblems')}
              </Link>
            }
          />
        )}
        {webgl && basemapState.status === 'failed' ? (
          <div className="map-basemap-note" role="status">
            <strong>{t('basemap.failed')}</strong> {t('basemap.failed.desc', { reason: basemapState.reason })}
          </div>
        ) : null}
        {webgl && basemapState.status === 'disabled' ? (
          <div className="map-basemap-note" role="status">
            {t('basemap.disabled')}
          </div>
        ) : null}
        {webgl && showFeature && !draw && !narrow ? featureCard : null}
        {webgl && gate.city && !draw && mapReady ? <MapInsightSelector model={insightModel} /> : null}
        {webgl && gate.city && !draw && mapReady ? (
          <Scene3DToggle state={scene3d.state} onEnable={() => void enter3d()} onDisable={exit3d} />
        ) : null}
        {webgl && gate.view ? <div className="map-overlay">{<div className="map-overlay__card">{gate.view}</div>}</div> : null}
      </div>
      {gate.city ? (
        <SidePanel
          id="map-context"
          title={
            draw
              ? draw.mode === 'create'
                ? t('draw.panel.create')
                : t('draw.panel.edit')
              : docked
                ? t('map.inspect.title')
                : selectedZoneId
                  ? t('map.panel.zone')
                  : t('map.panel.context')
          }
          collapsed={panelCollapsed}
          onCollapsedChange={setPanelCollapsed}
        >
          {docked ? featureCard : null}
          {shadowId ? (
            <section className="shd-section map-shadow" aria-labelledby="map-shadow-h">
              <div className="map-shadow__head">
                <h3 id="map-shadow-h">{t('shadow.map.title')}</h3>
                <Button size="sm" variant="ghost" icon="x" onClick={closeShadow}>
                  {t('shadow.map.close')}
                </Button>
              </div>
              <p className="shd-legend">
                <span className="shd-legend__swatch" aria-hidden /> {t('shadow.map.legend')}
              </p>
              <ShadowResultById id={shadowId} timeZone={gate.city.timezone} />
              {shadowResult.query.data ? (
                <details className="map-layer__more">
                  <summary>{t('shadow.map.rerun')}</summary>
                  <ShadowRunner revisionId={shadowResult.query.data.scenario_revision_id} timeZone={gate.city.timezone} onResult={noShadowCallback} />
                </details>
              ) : null}
            </section>
          ) : null}
          {scene3d.state !== 'off' && !draw ? (
            <Scene3DStatus
              state={scene3d.state}
              counts={scene3d.state === 'on' ? (frameCounts ?? countsOf(buildings)) : null}
              selected={featureData ? { label: featureTitle(featureData, pickedLayer?.name ?? null) ?? featureData.label, basis: featureData.height_basis, height: featureData.height_m, area: buildings.length > 0 } : null}
              serverShadow={Boolean(shadowGeometry)}
              onRetry={() => void scene3d.enable()}
              onDisable={exit3d}
            />
          ) : null}
          {draw ? (
            <ZoneDrawPanel
              city={gate.city}
              draw={draw}
              setDraw={(d) => setDraw(d)}
              restored={restoredDraw}
              onAddCenter={() => {
                const c = mapRef.current?.getCenter();
                if (c) updateDraw((x) => addVertex(x, [c.lng, c.lat]));
              }}
              onDone={finishDraw}
            />
          ) : selectedZoneId ? (
            <ZoneCard
              city={gate.city}
              zoneId={selectedZoneId}
              onEditGeometry={updateOk === false || !hasRole('specialist') ? undefined : startEdit}
            />
          ) : (
            <>
              <CityContext city={gate.city} />
              {createOk === false ? null : hasRole('specialist') ? (
                <Button
                  variant="primary"
                  icon="plus"
                  onClick={() => {
                    setRestoredDraw(false);
                    setDraw(startDraw('create'));
                    setPanelCollapsed(false);
                  }}
                >
                  {t('draw.start')}
                </Button>
              ) : (
                <p className="pg-muted">{t('draw.start.role')}</p>
              )}
              <h3>{t('zones.layer')}</h3>
              {zonesOk === false ? (
                <OperationUnavailable compact operationId="listZones" />
              ) : zones.isPending ? (
                <Skeleton lines={3} />
              ) : zones.isError ? (
                <ApiErrorView compact error={zones.error} onRetry={() => void zones.refetch()} />
              ) : (
                <ZoneList zones={zoneItems} truncated={zones.data.truncated} selectedId={selectedZoneId} onSelect={(id) => selectZone(id, true)} />
              )}
              <h3>{t('map.panel.layers')}</h3>
              <LayerList available={layersOk} layers={layers} hidden={hiddenLayers} onToggle={toggleLayer} tileErrors={tileErrors} zoom={zoom} onBasemap={basemapState.status === 'ready'} />
            </>
          )}
        </SidePanel>
      ) : null}
      </div>
    </div>
  );
}

const EMPTY_ZONES: Zone[] = [];
const NO_LAYERS: MapLayer[] = [];
const NO_BUILDINGS: SceneBuilding[] = [];
