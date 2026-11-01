import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { StyleSpecification } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { unwrap, type MapLayer, type Placement, type Plant, type Zone } from '@pg/api-client';
import { Badge, Button, DataTable, Field, Icon, Input, Notice, Select, Skeleton, StateView, StockOfferRow } from '@pg/ui';
import { api, useMapLayers, useOperationAvailable } from '../../api';
import { t, type AppKey } from '../../i18n';
import { ApiErrorView } from '../../shell/ApiErrorView';
import { OperationUnavailable } from '../../shell/OperationUnavailable';
import { useBasemapStyle } from '../map/basemap';
import { maplibregl } from '../map/maplibre';
import {
  classToken,
  extrusionFilter,
  extrusionIdOf,
  layerIdsOf,
  layerSpecs,
  renderability,
  sourceIdOf,
  sourceSpec,
  type Semantic,
} from '../map/publishedLayers';
import { useZoneVersion } from '../zones/queries';
import { plantImage } from '../plants/images';
import { Scene3DToggle } from '../scene3d/Scene3DPanel';
import { useScene3D } from '../scene3d/useScene3D';
import type { ScenePlanting } from '../scene3d/types';
import { add, insideZone, issuesOf, metersBetween, move, newPlacement, redo, remove, same, snapToCrownTangent, undo, update, type LngLat, type PlacementHistory } from './placements';

const coarse = () => window.matchMedia('(pointer: coarse)').matches;
const HIT = () => (coarse() ? 18 : 8);
const SLOP_PX = 8;
const EMPTY_IDS = new Set<string>();

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}

function blankStyle(): StyleSpecification {
  return { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': cssVar('--pg-map-bg') } }] };
}

function boundsOf(g: Zone['geometry']): [number, number, number, number] | null {
  const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  const rings = g.type === 'Polygon' ? g.coordinates : g.coordinates.flat();
  for (const ring of rings) for (const [x, y] of ring as LngLat[]) {
    b[0] = Math.min(b[0], x);
    b[1] = Math.min(b[1], y);
    b[2] = Math.max(b[2], x);
    b[3] = Math.max(b[3], y);
  }
  return Number.isFinite(b[0]) ? b : null;
}

/** Plan of the zone version with the placements: select, add, drag (mouse, finger), keyboard nudge. */
export function PlacementMap({
  zone,
  datasetVersionIds,
  placements,
  selectedId,
  selectedIds = EMPTY_IDS,
  snapping = false,
  adding,
  disabled,
  onSelect,
  onAdd,
  onMove,
  onDelete,
  conflictIds,
  auto3d = false,
  onMapReady,
  compareLabel,
}: {
  zone: Zone;
  /** Frozen scenario inputs; displayed buildings must match the versions used by server validation. */
  datasetVersionIds: string[];
  placements: Placement[];
  selectedId: string | null;
  selectedIds?: Set<string>;
  snapping?: boolean;
  adding: boolean;
  disabled: boolean;
  onSelect: (id: string | null, additive?: boolean) => void;
  onAdd: (at: LngLat) => void;
  onMove: (id: string, at: LngLat) => void;
  onDelete: (id: string) => void;
  conflictIds: Set<string>;
  /** Opens the existing Three layer as soon as the map is ready (used by immutable revision compare). */
  auto3d?: boolean;
  onMapReady?: (map: maplibregl.Map | null) => void;
  compareLabel?: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const basemap = useBasemapStyle();
  const cityLayers = useMapLayers(zone.city_id);
  const frozenVersions = useMemo(() => new Set(datasetVersionIds), [datasetVersionIds]);
  const buildingLayers = useMemo(() => (cityLayers.data?.items ?? []).filter(
    (layer) => layer.category === 'building' && layer.geometry_type === 'polygon' && frozenVersions.has(layer.dataset_version_id),
  ), [cityLayers.data?.items, frozenVersions]);
  const mountedBuildingLayers = useRef(new Map<string, MapLayer>());
  const [ready, setReady] = useState(false);
  const scenePlantings = useMemo<ScenePlanting[]>(() => placements.map((placement) => ({
    id: placement.id,
    position: placement.position.coordinates as LngLat,
    quantity: placement.quantity,
    height_m: placement.initial_height_m,
    crown_radius_m: placement.initial_crown_radius_m,
    selected: selectedIds.has(placement.id),
    locked: placement.locked,
    conflict: conflictIds.has(placement.id),
  })), [placements, selectedIds, conflictIds]);
  const scene3d = useScene3D(() => map.current, [], scenePlantings);
  const auto3dStarted = useRef(false);
  if (import.meta.env.DEV && !compareLabel) (window as unknown as { __pgPlacementScene?: typeof scene3d }).__pgPlacementScene = scene3d;
  const live = useRef({ placements, selectedId, selectedIds, snapping, adding, disabled, onSelect, onAdd, onMove });
  live.current = { placements, selectedId, selectedIds, snapping, adding, disabled, onSelect, onAdd, onMove };
  const drag = useRef<{
    id: string;
    start: maplibregl.Point;
    pos: LngLat | null;
    touch: boolean;
    restoreRotate: boolean;
    camera: { center: maplibregl.LngLat; zoom: number; pitch: number; bearing: number };
    scroll: [number, number];
    client: [number, number];
  } | null>(null);
  const suppressClick = useRef(0);

  const data = (list: Placement[], dragged: { id: string; pos: LngLat } | null): FeatureCollection => ({
    type: 'FeatureCollection',
    features: list.map((p, i) => ({
      type: 'Feature',
      properties: { id: p.id, n: i + 1, sel: live.current.selectedIds.has(p.id), locked: p.locked, conflict: conflictIds.has(p.id) },
      geometry: { type: 'Point', coordinates: dragged && dragged.id === p.id ? dragged.pos : p.position.coordinates },
    })),
  });

  useEffect(() => {
    if (!el.current || basemap.status === 'loading') return;
    auto3dStarted.current = false;
    const m = new maplibregl.Map({
      container: el.current,
      style: basemap.status === 'ready' ? basemap.style : blankStyle(),
      bounds: boundsOf(zone.geometry) ?? undefined,
      fitBoundsOptions: { padding: 32, maxZoom: 19 },
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    m.once('style.load', () => {
      m.addSource('zone', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: zone.geometry } });
      m.addLayer({ id: 'zone-fill', type: 'fill', source: 'zone', paint: { 'fill-color': cssVar('--pg-cat-2'), 'fill-opacity': 0.12 } });
      m.addLayer({ id: 'zone-line', type: 'line', source: 'zone', paint: { 'line-color': cssVar('--pg-cat-2'), 'line-width': 2 } });
      m.addSource('pl', { type: 'geojson', data: data(live.current.placements, null) });
      const r = coarse() ? 9 : 6;
      m.addLayer({
        id: 'pl-circle',
        type: 'circle',
        source: 'pl',
        paint: {
          'circle-radius': ['case', ['get', 'sel'], r + 3, r],
          'circle-color': ['case', ['get', 'conflict'], cssVar('--pg-negative'), cssVar('--pg-positive')],
          // Locked = thick dark ring; selected = focus ring. Shape cues, not colour alone.
          'circle-stroke-color': ['case', ['get', 'sel'], cssVar('--pg-focus'), ['get', 'locked'], cssVar('--pg-text'), cssVar('--pg-surface')],
          'circle-stroke-width': ['case', ['get', 'sel'], 4, ['get', 'locked'], 3, 1.5],
        },
      });
      setReady(true);
    });
    const hitAt = (pt: maplibregl.Point): string | null => {
      if (!m.getLayer('pl-circle')) return null;
      const h = HIT();
      const fs = m.queryRenderedFeatures(
        [
          [pt.x - h, pt.y - h],
          [pt.x + h, pt.y + h],
        ],
        { layers: ['pl-circle'] },
      );
      let best: { id: string; d: number } | null = null;
      for (const f of fs) {
        const d = m.project((f.geometry as GeoJSON.Point).coordinates as LngLat).dist(pt);
        if (!best || d < best.d) best = { id: String(f.properties?.id), d };
      }
      return best?.id ?? null;
    };
    const start = (id: string, pt: maplibregl.Point, touch: boolean, client: [number, number]) => {
      const p = live.current.placements.find((x) => x.id === id);
      live.current.onSelect(id, false);
      if (!p || p.locked || live.current.disabled) return false;
      const restoreRotate = m.dragRotate.isEnabled();
      drag.current = {
        id,
        start: pt,
        pos: null,
        touch,
        restoreRotate,
        camera: { center: m.getCenter(), zoom: m.getZoom(), pitch: m.getPitch(), bearing: m.getBearing() },
        scroll: [window.scrollX, window.scrollY],
        client,
      };
      if (import.meta.env.DEV) (window as unknown as { __pgPlacementDrag?: unknown }).__pgPlacementDrag = { phase: 'started', id };
      m.dragPan.disable();
      m.dragRotate.disable();
      return true;
    };
    const moveTo = (pt: maplibregl.Point, ll: maplibregl.LngLat) => {
      const d = drag.current;
      if (!d) return;
      if (!d.pos && pt.dist(d.start) < SLOP_PX) return;
      let next: LngLat = [ll.lng, ll.lat];
      if (live.current.snapping) {
        const pointer = m.project(next);
        const edge = m.unproject([pointer.x + 12, pointer.y]);
        const crownSnap = snapToCrownTangent(live.current.placements, d.id, next, metersBetween(next, [edge.lng, edge.lat]));
        if (crownSnap) next = crownSnap;
        else {
          let snapX: { distance: number; value: number } | null = null;
          let snapY: { distance: number; value: number } | null = null;
          for (const placement of live.current.placements) {
            if (placement.id === d.id) continue;
            const point = m.project(placement.position.coordinates as LngLat);
            const dx = Math.abs(point.x - pointer.x);
            const dy = Math.abs(point.y - pointer.y);
            if (dx <= 8 && (!snapX || dx < snapX.distance)) snapX = { distance: dx, value: point.x };
            if (dy <= 8 && (!snapY || dy < snapY.distance)) snapY = { distance: dy, value: point.y };
          }
          if (snapX || snapY) {
            const snapped = m.unproject([snapX?.value ?? pointer.x, snapY?.value ?? pointer.y]);
            next = [snapped.lng, snapped.lat];
          }
        }
      }
      d.pos = next;
      if (import.meta.env.DEV) (window as unknown as { __pgPlacementDrag?: unknown }).__pgPlacementDrag = { phase: 'moving', id: d.id, pos: d.pos };
      (m.getSource('pl') as maplibregl.GeoJSONSource | undefined)?.setData(data(live.current.placements, { id: d.id, pos: d.pos }));
    };
    const end = () => {
      const d = drag.current;
      if (!d) return;
      drag.current = null;
      m.dragPan.enable();
      if (d.restoreRotate) m.dragRotate.enable();
      if (d.touch) suppressClick.current = performance.now() + 600;
      if (d.pos) {
        suppressClick.current = performance.now() + 300;
        live.current.onMove(d.id, d.pos);
      }
      if (import.meta.env.DEV) (window as unknown as { __pgPlacementDrag?: unknown }).__pgPlacementDrag = { phase: 'ended', id: d.id, pos: d.pos };
    };
    // MapLibre's rotate handler can consume map-level mousemove events in a pitched scene.
    // Track an active mouse drag at window level as well, so the same editor remains draggable
    // in both plan and 3D modes and keeps working if the pointer briefly leaves the canvas.
    const moveWindow = (event: MouseEvent) => {
      if (!drag.current || drag.current.touch) return;
      event.preventDefault();
      window.scrollTo(...drag.current.scroll);
      const camera = drag.current.camera;
      m.stop();
      m.jumpTo(camera);
      const canvas = m.getCanvas();
      const rect = canvas.getBoundingClientRect();
      const point = new maplibregl.Point(
        drag.current.start.x + event.clientX - drag.current.client[0],
        drag.current.start.y + event.clientY - drag.current.client[1],
      );
      moveTo(point, m.unproject(point));
      if (import.meta.env.DEV) (window as unknown as { __pgPlacementPointer?: unknown }).__pgPlacementPointer = {
        point: [point.x, point.y], client: [event.clientX, event.clientY], rect: [rect.left, rect.top], targetCanvas: event.target === canvas,
      };
    };
    const endWindow = () => {
      if (drag.current && !drag.current.touch) end();
    };
    window.addEventListener('mousemove', moveWindow, true);
    window.addEventListener('mouseup', endWindow, true);
    m.on('mousedown', (e) => {
      const id = hitAt(e.point);
      if (id && (e.originalEvent.shiftKey || e.originalEvent.ctrlKey || e.originalEvent.metaKey)) return;
      if (id && start(id, e.point, false, [e.originalEvent.clientX, e.originalEvent.clientY])) e.preventDefault();
    });
    m.on('mousemove', (e) => {
      m.getCanvas().style.cursor = drag.current?.pos ? 'grabbing' : live.current.adding ? 'crosshair' : hitAt(e.point) ? 'pointer' : '';
    });
    m.on('mouseup', end);
    m.on('touchstart', (e) => {
      if (e.originalEvent.touches.length > 1) {
        drag.current = null;
        m.dragPan.enable();
        return;
      }
      const id = hitAt(e.point);
      const touch = e.originalEvent.touches[0];
      if (id && start(id, e.point, true, [touch?.clientX ?? e.point.x, touch?.clientY ?? e.point.y])) e.preventDefault();
      else if (id) suppressClick.current = performance.now() + 600;
    });
    m.on('touchmove', (e) => {
      if (e.originalEvent.touches.length > 1) {
        drag.current = null;
        m.dragPan.enable();
        (m.getSource('pl') as maplibregl.GeoJSONSource | undefined)?.setData(data(live.current.placements, null));
        return;
      }
      if (drag.current) e.preventDefault();
      moveTo(e.point, e.lngLat);
    });
    m.on('touchend', end);
    m.on('click', (e) => {
      if (performance.now() < suppressClick.current) return;
      const id = hitAt(e.point);
      if (id) return live.current.onSelect(id, e.originalEvent.shiftKey || e.originalEvent.ctrlKey || e.originalEvent.metaKey);
      if (live.current.adding && !live.current.disabled) live.current.onAdd([e.lngLat.lng, e.lngLat.lat]);
      else live.current.onSelect(null, false);
    });
    map.current = m;
    if (import.meta.env.DEV && !compareLabel) (window as unknown as { __pgPlacementMap?: maplibregl.Map }).__pgPlacementMap = m;
    return () => {
      window.removeEventListener('mousemove', moveWindow, true);
      window.removeEventListener('mouseup', endWindow, true);
      m.remove();
      map.current = null;
      setReady(false);
    };
    // The map is created once per zone version and basemap state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zone.version_id, basemap.status]);

  useEffect(() => {
    if (!ready) return;
    onMapReady?.(map.current);
    return () => onMapReady?.(null);
  }, [ready, onMapReady]);

  useEffect(() => {
    if (!ready || !auto3d || auto3dStarted.current) return;
    auto3dStarted.current = true;
    void scene3d.enable().then(() => {
      const bounds = boundsOf(zone.geometry);
      if (bounds && map.current) map.current.fitBounds(bounds, { padding: 56, maxZoom: 17, duration: 0 });
    });
    // The scene controller is intentionally invoked once per map instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, auto3d, zone.version_id]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const wanted = new Set(buildingLayers.map((layer) => layer.id));
    const apply = () => {
      for (const [id, oldLayer] of mountedBuildingLayers.current) {
        if (wanted.has(id)) continue;
        if (m.getLayer(extrusionIdOf(id))) m.removeLayer(extrusionIdOf(id));
        for (const layerId of layerIdsOf(oldLayer)) if (m.getLayer(layerId)) m.removeLayer(layerId);
        const sourceId = sourceIdOf(id);
        if (m.getSource(sourceId)) m.removeSource(sourceId);
        mountedBuildingLayers.current.delete(id);
      }
      for (const layer of buildingLayers) {
        const sourceId = sourceIdOf(layer.id);
        const extrusionId = extrusionIdOf(layer.id);
        if (!wanted.has(layer.id)) continue;
        const source = renderability(layer, window.location.origin);
        if (!source.ok) continue;
        if (!m.getSource(sourceId)) {
          m.addSource(sourceId, source.archive ? sourceSpec(layer, source.url, true) : sourceSpec(layer, source.tiles));
        }
        const onBasemap = basemap.status === 'ready';
        const color = (semantic: Semantic) => cssVar(classToken(layer, semantic, onBasemap));
        const outline = cssVar(onBasemap ? '--pg-basemap-halo' : '--pg-surface');
        for (const spec of layerSpecs(layer, color, outline)) {
          if (!m.getLayer(spec.id)) m.addLayer(spec, m.getLayer('zone-fill') ? 'zone-fill' : undefined);
        }
        if (scene3d.state !== 'on') {
          if (m.getLayer(extrusionId)) m.removeLayer(extrusionId);
        } else if (!m.getLayer(extrusionId)) {
          m.addLayer({
            id: extrusionId,
            type: 'fill-extrusion',
            metadata: { 'pg:layer': layer.id },
            source: sourceId,
            'source-layer': layer.source_layer ?? '',
            minzoom: Math.max(layer.min_zoom, 13),
            filter: extrusionFilter(null),
            paint: {
              'fill-extrusion-color': [
                'match',
                ['get', 'height_basis'],
                'measured', cssVar('--pg-prov-measured'),
                cssVar('--pg-prov-estimated'),
              ],
              'fill-extrusion-height': ['get', 'height_m'],
              'fill-extrusion-base': 0,
              'fill-extrusion-opacity': 0.78,
            },
          }, m.getLayer('pl-circle') ? 'pl-circle' : undefined);
        }
        mountedBuildingLayers.current.set(layer.id, layer);
      }
    };
    // `ready` is set by style.load after the editor's own sources are added. Do not wait for
    // isStyleLoaded(): that also waits for every external tile and can stay false while the camera
    // is moving, which made the exact frozen building layer appear only intermittently.
    apply();
  }, [ready, scene3d.state, buildingLayers, basemap.status]);

  useEffect(() => {
    if (!ready) return;
    (map.current?.getSource('pl') as maplibregl.GeoJSONSource | undefined)?.setData(data(placements, null));
    // data() reads the selection from live.current
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placements, selectedId, selectedIds, conflictIds, ready]);

  return (
    <div className="pl-map-wrap">
      <div
        ref={el}
        className={adding ? 'pl-map is-adding' : 'pl-map'}
        role="region"
        aria-label={compareLabel ?? t('placement.map')}
        tabIndex={0}
        onKeyDown={(e) => {
          const m = map.current;
          const sel = placements.find((p) => p.id === selectedId);
          if (!m) return;
          const arrow = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
          if (e.key === 'Enter' && adding && !disabled) {
            const c = m.getCenter();
            onAdd([c.lng, c.lat]);
          } else if (arrow && sel && !sel.locked && !disabled) {
            const step = e.shiftKey ? 1 : 5;
            const p = m.project(sel.position.coordinates as LngLat);
            const ll = m.unproject([p.x + arrow[0]! * step, p.y + arrow[1]! * step]);
            onMove(sel.id, [ll.lng, ll.lat]);
          } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel && !sel.locked && !disabled) onDelete(sel.id);
          else if (e.key === 'Escape') onSelect(null, false);
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      />
      {ready ? (
        <div className="pl-map__3d">
          <Scene3DToggle
            state={scene3d.state}
            onEnable={() => void scene3d.enable().then(() => {
              const bounds = boundsOf(zone.geometry);
              if (bounds && map.current) map.current.fitBounds(bounds, { padding: 72, maxZoom: 17, duration: 250 });
            })}
            onDisable={scene3d.disable}
          />
          {scene3d.state === 'on' ? (
            <span>
              {disabled
                ? 'Объёмное сравнение проектных посадок'
                : cityLayers.isPending
                  ? 'Загружаем здания замороженной версии…'
                  : buildingLayers.length > 0
                    ? 'Перетаскивайте посадки: здания с записанной высотой показаны объёмно'
                    : 'Объёмные здания этой версии недоступны; проверку выполняет сервер'}
            </span>
          ) : null}
        </div>
      ) : null}
      {adding ? <div className="map-crosshair" aria-hidden /> : null}
      {basemap.status === 'failed' ? <p className="pg-muted pl-map__note">{t('basemap.failed')}</p> : null}
    </div>
  );
}

function PlantPicker({ value, onChange }: { value: string; onChange: (id: string, plant: Plant | null) => void }) {
  const ok = useOperationAvailable('listPlants');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(q.trim()), 300);
    return () => window.clearTimeout(id);
  }, [q]);
  const plants = useQuery({
    queryKey: ['placement-plants', debounced],
    enabled: ok !== false,
    staleTime: 60_000,
    queryFn: async ({ signal }) => (await unwrap(api.GET('/v1/plants', { params: { query: { limit: 50, q: debounced || undefined } }, signal }))).data.items,
  });
  if (ok === false) return <OperationUnavailable compact operationId="listPlants" />;
  const selectedPlant = plants.data?.find((item) => item.id === value) ?? null;
  return (
    <div className="pl-picker">
      <Field label={t('placement.plant.search')}>
        {({ id }) => <Input id={id} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('placement.plant.search.ph')} />}
      </Field>
      {plants.isPending ? (
        <Skeleton lines={1} />
      ) : plants.isError ? (
        <ApiErrorView compact error={plants.error} onRetry={() => void plants.refetch()} />
      ) : plants.data.length === 0 ? (
        <StateView compact state="empty" title={t('placement.plant.none')} />
      ) : (
        <Field label={t('placement.plant')} required>
          {({ id }) => (
            <Select
              id={id}
              value={value}
              onChange={(e) => onChange(e.target.value, plants.data.find((p) => p.id === e.target.value) ?? null)}
            >
              <option value="">{t('placement.plant.choose')}</option>
              {plants.data.map((p) => (
                <option key={p.id} value={p.id} disabled={p.sensitive_site_status === 'excluded'}>
                  {p.russian_name} ({p.latin_name}) · {t(`stratum.${p.stratum}` as AppKey)}
                  {p.sensitive_site_status === 'excluded' ? ` · ${t('placement.plant.excluded')}` : ''}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      {selectedPlant ? (
        <div className="pl-picker__preview">
          <span className="pl-picker__image" aria-hidden="true">
            {plantImage(selectedPlant.latin_name) ? <img src={plantImage(selectedPlant.latin_name)!} alt="" /> : <Icon name="sprout" size={24} />}
          </span>
          <span>
            <strong>{selectedPlant.russian_name}</strong>
            <i>{selectedPlant.latin_name}</i>
            <small>{t(`stratum.${selectedPlant.stratum}` as AppKey)}</small>
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** Names of the plants referenced by placements (getPlant, cached per id). */
function usePlantNames(ids: string[]): Map<string, string> {
  const ok = useOperationAvailable('getPlant');
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: ['plant', id],
      enabled: ok !== false,
      staleTime: 5 * 60_000,
      queryFn: async ({ signal }: { signal: AbortSignal }) => (await unwrap<Plant>(api.GET('/v1/plants/{plant_id}', { params: { path: { plant_id: id } }, signal }))).data,
    })),
  });
  return useMemo(() => {
    const m = new Map<string, string>();
    results.forEach((r, i) => {
      if (r.data) m.set(ids[i]!, r.data.russian_name);
    });
    return m;
    // results identity changes every render; the data values are what matter
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join(','), results.map((r) => r.dataUpdatedAt).join(',')]);
}

const DIMENSION_BASES: Placement['dimension_basis'][] = ['unknown', 'measured', 'catalog', 'estimated'];

function SelectedForm({ p, disabled, onPatch, onDelete }: { p: Placement; disabled: boolean; onPatch: (patch: Partial<Placement>) => void; onDelete: () => void }) {
  const num = (v: string) => (v.trim() === '' ? null : Number(v.replace(',', '.')));
  return (
    <fieldset className="pl-form" disabled={disabled}>
      <legend>{t('placement.selected')}</legend>
      <Field label={t('placement.quantity')} required>
        {({ id }) => <Input id={id} type="number" min={1} step={1} inputMode="numeric" value={String(p.quantity)} onChange={(e) => onPatch({ quantity: Math.floor(Number(e.target.value)) })} />}
      </Field>
      <Field label={t('placement.date')} required>
        {({ id }) => <Input id={id} type="date" value={p.planting_date} onChange={(e) => onPatch({ planting_date: e.target.value })} />}
      </Field>
      <label className="scn-check">
        <input type="checkbox" checked={p.locked} onChange={(e) => onPatch({ locked: e.target.checked })} />
        <span>{t('placement.locked')}</span>
      </label>
      <Field label={t('placement.height')} hint={t('placement.dimension.hint')}>
        {({ id, describedBy }) => (
          <Input id={id} aria-describedby={describedBy} inputMode="decimal" value={p.initial_height_m ?? ''} onChange={(e) => onPatch({ initial_height_m: num(e.target.value) })} />
        )}
      </Field>
      <Field label={t('placement.crown')}>
        {({ id }) => <Input id={id} inputMode="decimal" value={p.initial_crown_radius_m ?? ''} onChange={(e) => onPatch({ initial_crown_radius_m: num(e.target.value) })} />}
      </Field>
      <Field label={t('placement.basis')}>
        {({ id }) => (
          <Select id={id} value={p.dimension_basis} onChange={(e) => onPatch({ dimension_basis: e.target.value as Placement['dimension_basis'] })}>
            {DIMENSION_BASES.map((b) => (
              <option key={b} value={b}>
                {t(`placement.basis.${b}` as AppKey)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <details className="pl-tech">
        <summary>Точные параметры размещения</summary>
        <p className="pg-muted">
          {t('placement.coords')}: <code className="pg-code">{(p.position.coordinates as LngLat).map((c) => c.toFixed(6)).join(', ')}</code>
        </p>
      </details>
      <Button size="sm" icon="x" onClick={onDelete} disabled={p.locked} title={p.locked ? t('placement.delete.unlock') : undefined}>
        {t('placement.delete')}
      </Button>
      <PlantStock plantId={p.plant_id} />
    </fieldset>
  );
}

const STOCK_SHOWN = 5;

/** Supplier offers of the placement's plant (listStock): read-only; null stock is not zero. */
function PlantStock({ plantId }: { plantId: string }) {
  const available = useOperationAvailable('listStock');
  const stock = useQuery({
    queryKey: ['stock', plantId],
    enabled: available !== false,
    staleTime: 60_000,
    queryFn: async ({ signal }) => (await unwrap(api.GET('/v1/stock', { params: { query: { plant_id: plantId, limit: 50 } }, signal }))).data,
  });
  return (
    <section className="pl-stock" aria-label={t('placement.stock')}>
      <h4>{t('placement.stock')}</h4>
      {available === false ? (
        <OperationUnavailable compact operationId="listStock" />
      ) : stock.isPending ? (
        <Skeleton lines={2} />
      ) : stock.isError ? (
        <ApiErrorView compact error={stock.error} onRetry={() => void stock.refetch()} />
      ) : stock.data.items.length === 0 ? (
        <p className="pg-muted">{t('placement.stock.empty')}</p>
      ) : (
        <>
          {stock.data.items.slice(0, STOCK_SHOWN).map((item) => (
            <StockOfferRow key={item.id} item={item} compact />
          ))}
          {stock.data.items.length > STOCK_SHOWN || stock.data.next_cursor ? (
            <p className="pg-muted">{t('placement.stock.more', { n: STOCK_SHOWN })}</p>
          ) : null}
        </>
      )}
    </section>
  );
}

/**
 * Point placements of the next revision. Controlled: `value` is the draft's placements and every
 * change goes through `onChange`; undo/redo history lives here and restarts with a new base.
 * Shows no cost, survival or other outcome: those come from the server's calculation.
 */
export function PlacementEditor({
  value,
  onChange,
  zoneVersionId,
  disabled,
  catalogVersionId,
  onCatalogVersion,
  preferredPlant,
  conflictIds = EMPTY_IDS,
  datasetVersionIds,
}: {
  value: Placement[];
  onChange: (next: Placement[]) => void;
  zoneVersionId: string;
  disabled: boolean;
  /** Catalog snapshot of the revision; adding a plant from another snapshot switches it, visibly. */
  catalogVersionId: string | null;
  onCatalogVersion: (id: string) => void;
  /** Plant selected in the recommendation result; it becomes the active map-placement tool. */
  preferredPlant?: Plant | null;
  /** Server-rejected positions stay in the local draft and are highlighted. */
  conflictIds?: Set<string>;
  /** Exact dataset versions frozen in the draft revision. */
  datasetVersionIds: string[];
}) {
  const zone = useZoneVersion(zoneVersionId);
  const [hist, setHist] = useState<Omit<PlacementHistory, 'present'>>({ past: [], future: [] });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [snapping, setSnapping] = useState(true);
  const [adding, setAdding] = useState(false);
  const [plantId, setPlantId] = useState('');
  const [plant, setPlant] = useState<Plant | null>(null);
  const [date, setDate] = useState('');
  useEffect(() => {
    if (!preferredPlant) return;
    setPlantId(preferredPlant.id);
    setPlant(preferredPlant);
    setAdding(false);
  }, [preferredPlant?.id]);
  const names = usePlantNames(useMemo(() => [...new Set(value.map((p) => p.plant_id))], [value]));
  const issues = useMemo(() => issuesOf(value), [value]);
  const geometry = zone.query.data?.geometry ?? null;
  const outside = useMemo(
    () => new Set(geometry ? value.filter((p) => !insideZone(p.position.coordinates as LngLat, geometry)).map((p) => p.id) : []),
    [value, geometry],
  );

  const commitChange = (next: Placement[]) => {
    if (same(next, value)) return;
    setHist((h) => ({ past: [...h.past, value].slice(-100), future: [] }));
    onChange(next);
  };
  const selectPlacement = (id: string | null, additive = false) => {
    if (!id) {
      setSelectedIds(new Set());
      setSelectedId(null);
      return;
    }
    if (!additive) {
      setSelectedIds(new Set([id]));
      setSelectedId(id);
      return;
    }
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSelectedId(next.has(id) ? id : (next.values().next().value ?? null));
      return next;
    });
  };
  const doUndo = () => {
    const r = undo({ present: value, ...hist });
    if (r.present === value) return;
    setHist({ past: r.past, future: r.future });
    onChange(r.present);
  };
  const doRedo = () => {
    const r = redo({ present: value, ...hist });
    if (r.present === value) return;
    setHist({ past: r.past, future: r.future });
    onChange(r.present);
  };
  const addAt = (at: LngLat) => {
    if (!plantId || !date) return;
    // Plants of the catalog list belong to its current snapshot (plant.version_id).
    if (plant && plant.version_id !== catalogVersionId) onCatalogVersion(plant.version_id);
    const p = newPlacement(plantId, at, date);
    commitChange(add(value, p));
    selectPlacement(p.id);
  };
  const selected = value.find((p) => p.id === selectedId) ?? null;
  const canAdd = !disabled && Boolean(plantId) && /^\d{4}-\d{2}-\d{2}$/.test(date);

  return (
    <section
      className="pl-editor"
      aria-label={t('placement.title')}
      onKeyDown={(e) => {
        const tag = (e.target as HTMLElement).tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || disabled) return;
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
          doUndo();
          e.preventDefault();
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
          doRedo();
          e.preventDefault();
        }
      }}
    >
      <h3>{t('placement.title')}</h3>
      <p className="pg-muted">{t('placement.desc')}</p>
      <details className="pl-tech">
        <summary>Версия каталога растений</summary>
        <p className="pg-muted">
          {catalogVersionId ? <code className="pg-code" title={catalogVersionId}>{catalogVersionId.slice(0, 8)}</code> : <span className="pg-unknown">{t('placement.catalog.none')}</span>}
          {plant && catalogVersionId && plant.version_id !== catalogVersionId ? <> · {t('placement.catalog.switch', { to: plant.version_id.slice(0, 8) })}</> : null}
        </p>
      </details>
      <div className="pl-add">
        <PlantPicker
          value={plantId}
          onChange={(id, p) => {
            setPlantId(id);
            setPlant(p);
          }}
        />
        <Field label={t('placement.date')} required>
          {({ id }) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
        </Field>
        <div className="pl-add__actions">
          <Button size="sm" variant={adding ? 'primary' : 'secondary'} icon="plus" aria-pressed={adding} disabled={!canAdd} onClick={() => setAdding(!adding)}>
            {adding ? t('placement.add.stop') : t('placement.add')}
          </Button>
        </div>
      </div>
      {adding ? <p className="pg-muted" role="status">{t('placement.add.hint')}</p> : null}
      <div className="draw-tools" role="toolbar" aria-label={t('placement.toolbar')}>
        <Button size="sm" icon="chevronLeft" onClick={doUndo} disabled={disabled || hist.past.length === 0} title="Ctrl+Z">
          {t('draw.undo')}
        </Button>
        <Button size="sm" icon="chevronRight" onClick={doRedo} disabled={disabled || hist.future.length === 0} title="Ctrl+Y">
          {t('draw.redo')}
        </Button>
        <Button size="sm" variant={snapping ? 'primary' : 'secondary'} aria-pressed={snapping} onClick={() => setSnapping((current) => !current)}>
          {snapping ? t('placement.snap.on') : t('placement.snap.off')}
        </Button>
        <Button size="sm" variant="secondary" disabled={value.length === 0} onClick={() => {
          setSelectedIds(new Set(value.map((placement) => placement.id)));
          setSelectedId(value[0]?.id ?? null);
        }}>
          {t('placement.select.all')}
        </Button>
        {selectedIds.size ? <Button size="sm" variant="ghost" onClick={() => selectPlacement(null)}>{t('placement.select.none')}</Button> : null}
        <span className="pg-muted" role="status" aria-live="polite">
          {t('placement.count', { n: value.length })} · {t('placement.selected.count', { n: selectedIds.size })}
        </span>
      </div>

      {selectedIds.size > 1 ? (
        <div className="pl-bulk" role="group" aria-label={t('placement.bulk')}>
          <strong>{t('placement.bulk', { n: selectedIds.size })}</strong>
          <span className="pg-muted">{t('placement.bulk.hint')}</span>
          <div className="pg-actions">
            <Button size="sm" icon="lock" onClick={() => commitChange(value.map((placement) => selectedIds.has(placement.id) ? { ...placement, locked: true } : placement))}>
              {t('placement.bulk.lock')}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => commitChange(value.map((placement) => selectedIds.has(placement.id) ? { ...placement, locked: false } : placement))}>
              {t('placement.bulk.unlock')}
            </Button>
            <Button size="sm" variant="danger" disabled={[...selectedIds].some((id) => value.find((placement) => placement.id === id)?.locked)} onClick={() => {
              commitChange(value.filter((placement) => !selectedIds.has(placement.id)));
              selectPlacement(null);
            }}>
              {t('placement.bulk.delete')}
            </Button>
          </div>
        </div>
      ) : null}

      {zone.available === false ? (
        <OperationUnavailable compact operationId="getZoneVersion" />
      ) : zone.query.isPending ? (
        <Skeleton lines={4} block />
      ) : zone.query.isError ? (
        <ApiErrorView compact error={zone.query.error} onRetry={() => void zone.query.refetch()} />
      ) : (
        <PlacementMap
          zone={zone.query.data}
          datasetVersionIds={datasetVersionIds}
          placements={value}
          selectedId={selectedId}
          selectedIds={selectedIds}
          snapping={snapping}
          adding={adding && canAdd}
          disabled={disabled}
          onSelect={selectPlacement}
          onAdd={addAt}
          onMove={(id, at) => commitChange(move(value, id, at))}
          onDelete={(id) => {
            if (value.find((placement) => placement.id === id)?.locked) return;
            commitChange(remove(value, id));
            selectPlacement(null);
          }}
          conflictIds={conflictIds}
        />
      )}
      <p className="pg-muted">{t('placement.keys')}</p>

      {outside.size > 0 ? <Notice tone="warning" icon="alert" title={t('placement.outside', { n: outside.size })} /> : null}
      {issues.size > 0 ? <Notice tone="negative" icon="error" title={t('placement.issues', { n: issues.size })} /> : null}

      {value.length === 0 ? (
        <StateView compact state="empty" title={t('placement.empty')} description={t('placement.empty.desc')} />
      ) : (
        <DataTable
          caption={t('placement.table')}
          rows={value}
          getRowId={(p) => p.id}
          selectedId={selectedId ?? undefined}
          onSelect={(p) => selectPlacement(p.id)}
          maxHeight="18rem"
          columns={[
            {
              key: 'selected',
              header: '✓',
              render: (p: Placement) => (
                <input
                  type="checkbox"
                  checked={selectedIds.has(p.id)}
                  aria-label={t('placement.select.one')}
                  onClick={(event) => event.stopPropagation()}
                  onChange={() => selectPlacement(p.id, true)}
                />
              ),
            },
            { key: 'n', header: '№', render: (p: Placement) => value.indexOf(p) + 1 },
            { key: 'plant', header: t('placement.plant'), render: (p: Placement) => names.get(p.plant_id) ?? <code className="pg-code">{p.plant_id.slice(0, 8)}</code> },
            { key: 'q', header: t('placement.quantity'), render: (p: Placement) => p.quantity },
            { key: 'd', header: t('placement.date'), render: (p: Placement) => p.planting_date || '—' },
            {
              key: 's',
              header: t('placement.state'),
              render: (p: Placement) => (
                <span className="pl-state">
                  {p.locked ? (
                    <Badge tone="neutral" icon="lock">
                      {t('placement.locked.short')}
                    </Badge>
                  ) : null}
                  {outside.has(p.id) ? (
                    <Badge tone="warning" icon="alert">
                      {t('placement.outside.short')}
                    </Badge>
                  ) : null}
                  {issues.get(p.id)?.map((i) => (
                    <Badge key={i} tone="negative" icon="error">
                      {t(`placement.issue.${i}` as AppKey)}
                    </Badge>
                  ))}
                </span>
              ),
            },
          ]}
        />
      )}
      {selected && selectedIds.size === 1 ? (
        <SelectedForm
          p={selected}
          disabled={disabled}
          onPatch={(patch) => commitChange(update(value, selected.id, patch))}
          onDelete={() => {
            if (selected.locked) return;
            commitChange(remove(value, selected.id));
            selectPlacement(null);
          }}
        />
      ) : value.length ? (
        <p className="pg-muted">
          <Icon name="info" size={14} /> {t('placement.select.hint')}
        </p>
      ) : null}
    </section>
  );
}
