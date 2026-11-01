import { Button, formatNumber, HeightBasisLegend, Notice, StateView, tUi, type HeightBasis } from '@pg/ui';
import { t, type AppKey } from '../../i18n';
import type { Scene3DState } from './useScene3D';

/** Map overlay: 3D toggle plus every state of the 3D mode, each with a next step. */
export function Scene3DToggle({ state, onEnable, onDisable }: { state: Scene3DState; onEnable: () => void; onDisable: () => void }) {
  const on = state === 'on' || state === 'loading';
  return (
    <div className="scene3d-toggle">
      <Button
        size="sm"
        variant={on ? 'primary' : 'secondary'}
        icon="layers"
        busy={state === 'loading'}
        aria-pressed={on}
        onClick={on ? onDisable : onEnable}
      >
        {on ? t('scene3d.exit') : t('scene3d.enter')}
      </Button>
    </div>
  );
}

export function Scene3DStatus({
  state,
  counts,
  selected = null,
  serverShadow = false,
  onRetry,
  onDisable,
}: {
  state: Scene3DState;
  counts: Record<HeightBasis, number> | null;
  /** The selected published object (getMapFeature); area = it has a footprint to show. */
  selected?: { label: string; basis: HeightBasis; height: number | null; area: boolean } | null;
  /** A server shadow result is drawn on the ground (the scene lighting still is not the sun). */
  serverShadow?: boolean;
  onRetry: () => void;
  onDisable: () => void;
}) {
  if (state === 'off' || state === 'loading') return null;
  if (state === 'no_webgl') {
    return <StateView compact state="unavailable" title={t('scene3d.noWebgl')} description={t('scene3d.noWebgl.desc')} />;
  }
  if (state === 'load_failed') {
    return (
      <StateView
        compact
        state="error"
        title={t('scene3d.loadFailed')}
        description={t('scene3d.loadFailed.desc')}
        actions={
          <Button size="sm" icon="refresh" onClick={onRetry}>
            {tUi('action.retry')}
          </Button>
        }
      />
    );
  }
  if (state === 'context_lost') {
    return (
      <Notice tone="warning" icon="alert" title={t('scene3d.contextLost')} actions={<Button size="sm" onClick={onDisable}>{t('scene3d.exit')}</Button>}>
        {t('scene3d.contextLost.desc')}
      </Notice>
    );
  }
  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;
  const known = selected && selected.basis !== 'unknown' && selected.height !== null;
  return (
    <div className="scene3d-status">
      {selected ? (
        <Notice tone={known ? 'info' : 'neutral'} icon="info" title={selected.label}>
          {!selected.area
            ? t('scene3d.selected.notArea')
            : known
              ? t('scene3d.selected.height', { height: formatNumber(selected.height, 1) ?? '', basis: t(`map.feature.basis.${selected.basis}` as AppKey) })
              : t('scene3d.selected.flat')}
        </Notice>
      ) : total === 0 ? (
        <Notice tone="neutral" icon="info" title={t('scene3d.noBuildings')}>
          {t('scene3d.noBuildings.desc')}
        </Notice>
      ) : null}
      <h3>{t('scene3d.legend')}</h3>
      <HeightBasisLegend counts={counts ?? undefined} />
      <p className="pg-muted">{t(serverShadow ? 'scene3d.disclaimer.shadow' : 'scene3d.disclaimer')}</p>
      <p className="pg-muted">{t('scene3d.basemapFlat')}</p>
    </div>
  );
}
