/**
 * Dev-only compatibility harness for MapLibre 6.16 + Three 0.180 (WP-06 foundation).
 * SYNTHETIC test buildings near 0°/0° — deliberately far from Pavlodar so they cannot be
 * mistaken for city data. Exposes window.__pg3d for the automated browser checks.
 */
import { useEffect, useRef, useState } from 'react';
import { maplibregl } from '../features/map/maplibre';
import { Button, Card, HeightBasisLegend, PageHeader, SyntheticBanner } from '@pg/ui';
import type { BasisStyle, SceneBuilding, SceneHandle, SceneStats } from '../features/scene3d/types';

const ORIGIN: [number, number] = [0.0015, 0.0008];

function box(cx: number, cy: number, w: number, h: number): [number, number][] {
  const dx = w / 2;
  const dy = h / 2;
  return [
    [cx - dx, cy - dy],
    [cx + dx, cy - dy],
    [cx + dx, cy + dy],
    [cx - dx, cy + dy],
    [cx - dx, cy - dy],
  ];
}

// One building per basis plus a reference twin drawn by MapLibre itself.
const BUILDINGS: SceneBuilding[] = [
  { id: 'syn-measured', footprint: box(0.0006, 0.0008, 0.0003, 0.0002), height_m: 30, height_basis: 'measured' },
  { id: 'syn-recorded', footprint: box(0.0012, 0.0008, 0.0003, 0.0002), height_m: 20, height_basis: 'recorded_unverified' },
  { id: 'syn-floors', footprint: box(0.0018, 0.0008, 0.0003, 0.0002), height_m: 15, height_basis: 'floors_estimate' },
  { id: 'syn-placeholder', footprint: box(0.0024, 0.0008, 0.0003, 0.0002), height_m: 6, height_basis: 'visual_placeholder' },
  { id: 'syn-unknown', footprint: box(0.0015, 0.0003, 0.0003, 0.0002), height_m: null, height_basis: 'unknown' },
];
// Native MapLibre fill-extrusion of the same size/height as the "measured" box, next to it:
// equal tops show that Three and MapLibre use the same vertical metric.
const REFERENCE = { footprint: box(0.0006, 0.0013, 0.0003, 0.0002), height_m: 30 };

declare global {
  interface Window {
    __pg3d?: {
      map: maplibregl.Map;
      mount: () => Promise<void>;
      unmount: () => void;
      stats: () => SceneStats | null;
      lastStats: () => SceneStats | null;
      describe: () => BasisStyle[];
      alignment: (p: [number, number]) => number | null;
      loseContext: () => boolean;
      restoreContext: () => boolean;
      buildings: SceneBuilding[];
    };
  }
}

export default function Scene3DHarness() {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const handleRef = useRef<SceneHandle | null>(null);
  const lastHandle = useRef<SceneHandle | null>(null);
  const loseExt = useRef<WEBGL_lose_context | null>(null);
  const [stats, setStats] = useState<SceneStats | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const note = (s: string) => setLog((l) => [s, ...l].slice(0, 8));

  useEffect(() => {
    if (!el.current) return;
    const m = new maplibregl.Map({
      container: el.current,
      style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#e8ece9' } }] },
      center: [0.0015, 0.0009],
      zoom: 17.6,
      pitch: 55,
      bearing: -25,
      canvasContextAttributes: { antialias: true },
    });
    mapRef.current = m;
    const mount = async () => {
      if (handleRef.current) return;
      const mod = await import('../features/scene3d/threeLayer');
      handleRef.current = mod.createThreeLayer(m, { id: 'scene3d', origin: ORIGIN, onContextLost: () => note('webglcontextlost') });
      handleRef.current.setBuildings(BUILDINGS);
    };
    const unmount = () => {
      handleRef.current?.remove();
      lastHandle.current = handleRef.current;
      handleRef.current = null;
    };
    m.on('load', () => {
      m.addSource('ref', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [REFERENCE.footprint] } } });
      m.addLayer({
        id: 'ref-extrusion',
        type: 'fill-extrusion',
        source: 'ref',
        paint: { 'fill-extrusion-color': '#d1495b', 'fill-extrusion-height': REFERENCE.height_m, 'fill-extrusion-opacity': 0.55 },
      });
      void mount().then(() => note('mounted'));
      loseExt.current = (m.getCanvas().getContext('webgl2') as WebGL2RenderingContext | null)?.getExtension('WEBGL_lose_context') ?? null;
    });
    // MapLibre restores its style snapshot but not custom layers: recreate after it is idle.
    m.on('webglcontextrestored', () => {
      note('webglcontextrestored: recreate layer');
      handleRef.current = null;
      m.once('idle', () => void mount().then(() => note('mounted')));
    });
    window.__pg3d = {
      map: m,
      mount,
      unmount,
      stats: () => handleRef.current?.stats() ?? null,
      lastStats: () => lastHandle.current?.stats() ?? null,
      describe: () => handleRef.current?.describe() ?? [],
      alignment: (p) => handleRef.current?.alignmentErrorPx(p) ?? null,
      loseContext: () => {
        if (!loseExt.current) return false;
        loseExt.current.loseContext();
        return true;
      },
      restoreContext: () => {
        if (!loseExt.current) return false;
        loseExt.current.restoreContext();
        return true;
      },
      buildings: BUILDINGS,
    };
    const timer = window.setInterval(() => setStats(handleRef.current?.stats() ?? null), 500);
    return () => {
      window.clearInterval(timer);
      handleRef.current?.remove();
      handleRef.current = null;
      delete window.__pg3d;
      m.remove();
    };
  }, []);

  return (
    <div className="app-page">
      <SyntheticBanner />
      <PageHeader
        title="3D: совместимость MapLibre 6.16 + Three 0.180"
        description="Синтетические здания у 0°/0°, не Павлодар. Красный блок — эталон fill-extrusion MapLibre высотой 30 м; синий блок Three «измеренная высота» тех же размеров и высоты рядом — их верх должен быть на одном уровне."
      />
      <div className="h3d-grid">
        <div ref={el} className="h3d-map" role="region" aria-label="Тестовая 3D-сцена" />
        <div className="h3d-side">
          <Card title="Управление">
            <div className="gal-row">
              <Button size="sm" onClick={() => void window.__pg3d?.mount().then(() => note('mounted'))}>
                Смонтировать слой
              </Button>
              <Button size="sm" onClick={() => { window.__pg3d?.unmount(); note('removed'); }}>
                Удалить слой
              </Button>
              <Button size="sm" onClick={() => note(window.__pg3d?.loseContext() ? 'lose_context requested' : 'no WEBGL_lose_context')}>
                Потерять контекст
              </Button>
              <Button size="sm" onClick={() => note(window.__pg3d?.restoreContext() ? 'restore requested' : 'no extension')}>
                Восстановить
              </Button>
            </div>
            <div className="gal-log" role="log">{log.map((l, i) => <div key={i}>{l}</div>)}</div>
          </Card>
          <Card title="Ресурсы WebGL (renderer.info)">
            <pre className="h3d-stats">{stats ? JSON.stringify({ ...stats, buildingsByBasis: undefined }, null, 1) : 'слой не смонтирован'}</pre>
          </Card>
          <Card title="Основание высот">
            <HeightBasisLegend counts={stats?.buildingsByBasis} />
          </Card>
        </div>
      </div>
    </div>
  );
}
