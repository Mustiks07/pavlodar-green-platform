import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ScenarioRevision, Zone } from '@pg/api-client';
import { Badge, Icon } from '@pg/ui';
import { maplibregl } from '../map/maplibre';
import { PlacementMap } from './PlacementEditor';

const EMPTY_IDS = new Set<string>();
const noop = () => undefined;

function changedPlacementIds(before: ScenarioRevision, after: ScenarioRevision): string[] {
  const oldById = new Map(before.placements.map((item) => [item.id, item]));
  const newById = new Map(after.placements.map((item) => [item.id, item]));
  return [...new Set([...oldById.keys(), ...newById.keys()])].filter((id) => {
    const oldItem = oldById.get(id);
    const newItem = newById.get(id);
    if (!oldItem || !newItem) return true;
    return oldItem.quantity !== newItem.quantity
      || oldItem.position.coordinates[0] !== newItem.position.coordinates[0]
      || oldItem.position.coordinates[1] !== newItem.position.coordinates[1];
  });
}

function cameraOf(map: maplibregl.Map) {
  return {
    center: map.getCenter(),
    zoom: map.getZoom(),
    pitch: map.getPitch(),
    bearing: map.getBearing(),
  };
}

/**
 * Two immutable project revisions rendered by the same 3D placement layer. Camera movement is
 * mirrored in both directions, so the visual delta cannot be manufactured by changing viewpoint.
 */
export function Revision3DCompare({ before, after, zone }: { before: ScenarioRevision; after: ScenarioRevision; zone: Zone }) {
  const changed = useMemo(() => changedPlacementIds(before, after), [before, after]);
  const [selectedId, setSelectedId] = useState<string | null>(changed[0] ?? null);
  const [left, setLeft] = useState<maplibregl.Map | null>(null);
  const [right, setRight] = useState<maplibregl.Map | null>(null);
  const leftReady = useCallback((map: maplibregl.Map | null) => setLeft(map), []);
  const rightReady = useCallback((map: maplibregl.Map | null) => setRight(map), []);

  useEffect(() => {
    if (!left || !right) return;
    let syncing = false;
    const mirror = (source: maplibregl.Map, target: maplibregl.Map) => {
      if (syncing) return;
      syncing = true;
      target.jumpTo(cameraOf(source));
      queueMicrotask(() => { syncing = false; });
    };
    const fromLeft = () => mirror(left, right);
    const fromRight = () => mirror(right, left);
    mirror(left, right);
    left.on('move', fromLeft);
    right.on('move', fromRight);
    if (import.meta.env.DEV) {
      (window as unknown as { __pgRevisionCompare?: { left: maplibregl.Map; right: maplibregl.Map } }).__pgRevisionCompare = { left, right };
    }
    return () => {
      left.off('move', fromLeft);
      right.off('move', fromRight);
      if (import.meta.env.DEV) delete (window as unknown as { __pgRevisionCompare?: unknown }).__pgRevisionCompare;
    };
  }, [left, right]);

  if (changed.length === 0) return null;
  return (
    <section className="revision-3d-compare" aria-labelledby="revision-3d-title">
      <header className="revision-3d-compare__head">
        <div>
          <span className="revision-3d-compare__eyebrow"><Icon name="compare" size={15} /> Результат изменения</span>
          <h3 id="revision-3d-title">Проект до и после — с одной камерой</h3>
          <p>Изменённые посадки выделены. Поворот, масштаб и наклон синхронизированы между версиями.</p>
        </div>
        <Badge tone="positive"><Icon name="check" size={13} /> Камера синхронизирована</Badge>
      </header>
      <div className="revision-3d-compare__grid">
        <article>
          <div className="revision-3d-compare__label"><strong>До изменения</strong><span>версия {before.id.slice(0, 8)}</span></div>
          <PlacementMap
            zone={zone}
            datasetVersionIds={before.dataset_version_ids}
            placements={before.placements}
            selectedId={selectedId}
            adding={false}
            disabled
            onSelect={setSelectedId}
            onAdd={noop}
            onMove={noop}
            onDelete={noop}
            conflictIds={EMPTY_IDS}
            auto3d
            onMapReady={leftReady}
            compareLabel="Проект до изменения"
          />
        </article>
        <article>
          <div className="revision-3d-compare__label"><strong>После изменения</strong><span>версия {after.id.slice(0, 8)}</span></div>
          <PlacementMap
            zone={zone}
            datasetVersionIds={after.dataset_version_ids}
            placements={after.placements}
            selectedId={selectedId}
            adding={false}
            disabled
            onSelect={setSelectedId}
            onAdd={noop}
            onMove={noop}
            onDelete={noop}
            conflictIds={EMPTY_IDS}
            auto3d
            onMapReady={rightReady}
            compareLabel="Проект после изменения"
          />
        </article>
      </div>
      <footer>
        <strong>{changed.length}</strong> изменённ{changed.length === 1 ? 'ая группа посадок' : 'ые группы посадок'}
        <span>Одна объёмная модель обозначает одну группу; количество хранится в серверной ревизии.</span>
      </footer>
    </section>
  );
}
