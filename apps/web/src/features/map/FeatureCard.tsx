import type { UseQueryResult } from '@tanstack/react-query';
import { ApiError, type MapFeature, type MapLayer } from '@pg/api-client';
import { Badge, Button, formatNumber, MetricValue, Notice, Skeleton } from '@pg/ui';
import { t, type AppKey } from '../../i18n';
import { ApiErrorView } from '../../shell/ApiErrorView';
import { OperationUnavailable } from '../../shell/OperationUnavailable';
import { metricLabel } from '../zones/ZoneCard';
import { featureTitle, geometryFamily, inspectProperties, sourceAttributes } from './publishedLayers';
import { productLabel } from '../../productCopy';

const MAX_ATTRS = 30;

/** Raw tile attributes: what the publisher delivered, shown as text and never interpreted. */
function TileAttributes({ properties, open }: { properties: Record<string, unknown>; open: boolean }) {
  const attrs = sourceAttributes(properties);
  const rows = inspectProperties(attrs, MAX_ATTRS);
  const total = Object.keys(attrs).length;
  return (
    <details className="map-inspect__raw" open={open}>
      <summary>{t('map.inspect.rawTitle', { count: total })}</summary>
      <p className="pg-muted">{t('map.inspect.raw')}</p>
      {rows.length ? (
        <dl className="pg-dl">
          {rows.map((r) => (
            <div key={r.key} style={{ display: 'contents' }}>
              <dt>{r.key}</dt>
              <dd>{r.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="pg-muted">{t('map.inspect.none')}</p>
      )}
      {total > MAX_ATTRS ? <p className="pg-muted">{t('map.inspect.more', { count: MAX_ATTRS })}</p> : null}
    </details>
  );
}

function Height({ f }: { f: MapFeature }) {
  if (f.height_m === null) return <>{t('map.feature.height.none', { basis: t(`map.feature.basis.${f.height_basis}` as AppKey) })}</>;
  return (
    <>
      {formatNumber(f.height_m, 1)} {t('map.feature.m')} · {t(`map.feature.basis.${f.height_basis}` as AppKey)}
      {f.floors !== null ? ` · ${t('map.feature.floors', { count: f.floors })}` : ''}
    </>
  );
}

function ServerCard({ f, layer }: { f: MapFeature; layer: MapLayer | null }) {
  const family = geometryFamily(f.geometry.type);
  return (
    <div className="map-inspect__server">
      <dl className="pg-dl">
        <dt>{t('map.feature.geometry')}</dt>
        <dd>{family ? t(`map.layer.geometry.${family}` as AppKey) : f.geometry.type}</dd>
        {/* An unknown height only means something for buildings; roads, trees and other objects skip it. */}
        {f.height_m !== null || (family === 'polygon' && (layer === null || layer.category === 'building')) ? (
          <>
            <dt>{t('map.feature.height')}</dt>
            <dd>
              <Height f={f} />
            </dd>
          </>
        ) : null}
      </dl>
      <h4 className="map-inspect__sub">{t('map.feature.metrics')}</h4>
      {f.metrics.length ? (
        <div className="map-inspect__metrics">
          {f.metrics.map((m) => (
            <MetricValue key={`${m.key}:${m.horizon_year ?? 'now'}`} label={metricLabel(m.key)} metric={m} detailed={false} />
          ))}
        </div>
      ) : (
        <p className="pg-muted">{t('map.feature.noMetrics')}</p>
      )}
      <details className="map-layer__more">
        <summary>Техническая информация</summary>
        <dl className="pg-dl">
          <dt>{t('map.layer.version')}</dt><dd><code className="pg-code" title={f.dataset_version_id}>{f.dataset_version_id.slice(0, 8)}</code></dd>
          {layer ? <><dt>{t('map.layer.access')}</dt><dd>{t(`map.layer.access.${layer.access_level}` as AppKey)}</dd></> : null}
        </dl>
      </details>
    </div>
  );
}

/**
 * Card of a picked published feature. The server card (getMapFeature: current version, grant,
 * lineage) is the authority; the tile's raw attributes stay available as plain text.
 */
export function FeatureCard({
  featureId,
  available,
  query,
  layer,
  properties,
  docked = false,
  onClose,
}: {
  /** Stable id from the tile (feature_id) or the URL; null when the tile carries none. */
  featureId: string | null;
  available: boolean | null;
  query: UseQueryResult<MapFeature>;
  layer: MapLayer | null;
  /** Tile attributes of the clicked feature; null after a reload (URL only). */
  properties: Record<string, unknown> | null;
  /** Inside the phone bottom sheet instead of floating over the map. */
  docked?: boolean;
  onClose: () => void;
}) {
  const f = featureId ? query.data : undefined;
  const notFound = query.error instanceof ApiError && query.error.category === 'not_found';
  const layerName = layer ? productLabel(layer.name) : null;
  const title = featureTitle(f, layerName) ?? t('map.inspect.title');
  return (
    <section className={docked ? 'map-inspect map-inspect--docked' : 'map-inspect'} aria-label={t('map.inspect.title')} data-feature-id={featureId ?? undefined}>
      <div className="map-inspect__head">
        <div>
          <h3>{title}</h3>
          {layerName && f && title !== layerName ? <p className="pg-muted map-inspect__layer">{layerName}</p> : null}
        </div>
        <Button size="sm" variant="ghost" icon="x" iconOnly aria-label={t('map.inspect.close')} onClick={onClose} />
      </div>
      {layer?.access_level === 'restricted' ? (
        <div>
          <Badge tone="warning" icon="lock">
            {t('map.layer.access.restricted')}
          </Badge>
        </div>
      ) : null}
      {!featureId ? (
        <Notice tone="neutral" title={t('map.feature.noId')} />
      ) : available === false ? (
        <OperationUnavailable compact operationId="getMapFeature" />
      ) : f ? (
        <ServerCard f={f} layer={layer} />
      ) : notFound ? (
        <Notice tone="warning" title={t('map.feature.404')}>
          {t('map.feature.404.desc')}
        </Notice>
      ) : query.isError ? (
        <ApiErrorView compact error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <div role="status" aria-label={t('map.feature.loading')}>
          <Skeleton lines={4} />
        </div>
      )}
      {properties ? <TileAttributes properties={properties} open={!featureId || notFound} /> : null}
    </section>
  );
}
