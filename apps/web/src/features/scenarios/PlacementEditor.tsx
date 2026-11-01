import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { StyleSpecification } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { unwrap, type Placement, type Plant, type Zone } from '@pg/api-client';
import { Badge, Button, DataTable, Field, Icon, Input, Notice, Select, Skeleton, StateView, StockOfferRow } from '@pg/ui';
import { api, useOperationAvailable } from '../../api';
import { t, type AppKey } from '../../i18n';
import { ApiErrorView } from '../../shell/ApiErrorView';
import { OperationUnavailable } from '../../shell/OperationUnavailable';
import { useBasemapStyle } from '../map/basemap';
import { maplibregl } from '../map/maplibre';
import { useZoneVersion } from '../zones/queries';
import { plantImage } from '../plants/images';
import { add, insideZone, issuesOf, move, newPlacement, redo, remove, same, undo, update, type LngLat, type PlacementHistory } from './placements';

const coarse = () => window.matchMedia('(pointer: coarse)').matches;
const HIT = () => (coarse() ? 18 : 8);
const SLOP_PX = 8;

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
function PlacementMap({
  zone,
  placements,
  selectedId,
  adding,
  disabled,
  onSelect,
  onAdd,
  onMove,
  onDelete,
}: {
  zone: Zone;
  placements: Placement[];
  selectedId: string | null;
  adding: boolean;
  disabled: boolean;
  onSelect: (id: string | null) => void;
  onAdd: (at: LngLat) => void;
  onMove: (id: string, at: LngLat) => void;
  onDelete: (id: string) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const basemap = useBasemapStyle();
  const [ready, setReady] = useState(false);
  const live = useRef({ placements, selectedId, adding, disabled, onSelect, onAdd, onMove });
  live.current = { placements, selectedId, adding, disabled, onSelect, onAdd, onMove };
  const drag = useRef<{ id: string; start: maplibregl.Point; pos: LngLat | null; touch: boolean } | null>(null);
  const suppressClick = useRef(0);

  const data = (list: Placement[], dragged: { id: string; pos: LngLat } | null): FeatureCollection => ({
    type: 'FeatureCollection',
    features: list.map((p, i) => ({
      type: 'Feature',
      properties: { id: p.id, n: i + 1, sel: p.id === live.current.selectedId, locked: p.locked },
      geometry: { type: 'Point', coordinates: dragged && dragged.id === p.id ? dragged.pos : p.position.coordinates },
    })),
  });

  useEffect(() => {
    if (!el.current || basemap.status === 'loading') return;
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
          'circle-color': cssVar('--pg-positive'),
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
    const start = (id: string, pt: maplibregl.Point, touch: boolean) => {
      const p = live.current.placements.find((x) => x.id === id);
      live.current.onSelect(id);
      if (!p || p.locked || live.current.disabled) return false;
      drag.current = { id, start: pt, pos: null, touch };
      m.dragPan.disable();
      return true;
    };
    const moveTo = (pt: maplibregl.Point, ll: maplibregl.LngLat) => {
      const d = drag.current;
      if (!d) return;
      if (!d.pos && pt.dist(d.start) < SLOP_PX) return;
      d.pos = [ll.lng, ll.lat];
      (m.getSource('pl') as maplibregl.GeoJSONSource | undefined)?.setData(data(live.current.placements, { id: d.id, pos: d.pos }));
    };
    const end = () => {
      const d = drag.current;
      if (!d) return;
      drag.current = null;
      m.dragPan.enable();
      if (d.touch) suppressClick.current = performance.now() + 600;
      if (d.pos) {
        suppressClick.current = performance.now() + 300;
        live.current.onMove(d.id, d.pos);
      }
    };
    m.on('mousedown', (e) => {
      const id = hitAt(e.point);
      if (id && start(id, e.point, false)) e.preventDefault();
    });
    m.on('mousemove', (e) => {
      moveTo(e.point, e.lngLat);
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
      if (id && start(id, e.point, true)) e.preventDefault();
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
      if (id) return live.current.onSelect(id);
      if (live.current.adding && !live.current.disabled) live.current.onAdd([e.lngLat.lng, e.lngLat.lat]);
      else live.current.onSelect(null);
    });
    map.current = m;
    if (import.meta.env.DEV) (window as unknown as { __pgPlacementMap?: maplibregl.Map }).__pgPlacementMap = m;
    return () => {
      m.remove();
      map.current = null;
      setReady(false);
    };
    // The map is created once per zone version and basemap state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zone.version_id, basemap.status]);

  useEffect(() => {
    if (!ready) return;
    (map.current?.getSource('pl') as maplibregl.GeoJSONSource | undefined)?.setData(data(placements, null));
    // data() reads the selection from live.current
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placements, selectedId, ready]);

  return (
    <div className="pl-map-wrap">
      <div
        ref={el}
        className={adding ? 'pl-map is-adding' : 'pl-map'}
        role="region"
        aria-label={t('placement.map')}
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
          } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel && !disabled) onDelete(sel.id);
          else if (e.key === 'Escape') onSelect(null);
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      />
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
      <Button size="sm" icon="x" onClick={onDelete}>
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
}) {
  const zone = useZoneVersion(zoneVersionId);
  const [hist, setHist] = useState<Omit<PlacementHistory, 'present'>>({ past: [], future: [] });
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
    setSelectedId(p.id);
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
        <span className="pg-muted" role="status" aria-live="polite">
          {t('placement.count', { n: value.length })}
        </span>
      </div>

      {zone.available === false ? (
        <OperationUnavailable compact operationId="getZoneVersion" />
      ) : zone.query.isPending ? (
        <Skeleton lines={4} block />
      ) : zone.query.isError ? (
        <ApiErrorView compact error={zone.query.error} onRetry={() => void zone.query.refetch()} />
      ) : (
        <PlacementMap
          zone={zone.query.data}
          placements={value}
          selectedId={selectedId}
          adding={adding && canAdd}
          disabled={disabled}
          onSelect={setSelectedId}
          onAdd={addAt}
          onMove={(id, at) => commitChange(move(value, id, at))}
          onDelete={(id) => {
            commitChange(remove(value, id));
            setSelectedId(null);
          }}
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
          onSelect={(p) => setSelectedId(p.id)}
          maxHeight="18rem"
          columns={[
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
      {selected ? (
        <SelectedForm
          p={selected}
          disabled={disabled}
          onPatch={(patch) => commitChange(update(value, selected.id, patch))}
          onDelete={() => {
            commitChange(remove(value, selected.id));
            setSelectedId(null);
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
