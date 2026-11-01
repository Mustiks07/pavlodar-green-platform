import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { newIdempotencyKey, unwrap, type City, type Scenario, type ScenarioRevisionInput, type Zone } from '@pg/api-client';
import {
  Badge,
  Button,
  DataGapList,
  Dialog,
  Field,
  formatDateTime,
  formatNumber,
  Input,
  MetricValue,
  Notice,
  Select,
  Skeleton,
  StateView,
  UnitText,
} from '@pg/ui';
import { api } from '../../api';
import { t, type AppKey } from '../../i18n';
import { ApiErrorView } from '../../shell/ApiErrorView';
import { OperationUnavailable } from '../../shell/OperationUnavailable';
import { useSession } from '../../shell/session';
import { useZone, useZoneContext, useZoneScenarios, useZoneVersion, zk } from './queries';
import { editableRing } from './draw';

export function metricLabel(key: string): string {
  const k = `metric.${key}` as AppKey;
  const label = t(k);
  return label === k ? key : label;
}

const WF_TONE = { draft: 'neutral', in_review: 'info', approved: 'positive', archived: 'neutral' } as const;

function ZoneContextSection({ zone }: { zone: Zone }) {
  const { available, query } = useZoneContext(zone.id);
  if (available === false) return <OperationUnavailable compact operationId="getZoneContext" />;
  if (query.isPending) return <Skeleton lines={4} />;
  if (query.isError) return <ApiErrorView compact error={query.error} onRetry={() => void query.refetch()} />;
  const ctx = query.data;
  // Only gaps that block a calculation are shown here; gaps already listed on the zone are not repeated.
  const shown = new Set(zone.data_gaps.map((g) => g.code));
  const extraGaps = ctx.data_gaps.filter((g) => g.blocking && !shown.has(g.code));
  return (
    <div className="zone-ctx">
      {ctx.zone_version_id !== zone.version_id ? (
        <Notice tone="warning" icon="clock" title={t('zone.ctx.otherVersion')} />
      ) : null}
      <h4>{t('zone.ctx.metrics')}</h4>
      {ctx.metrics.length === 0 ? (
        <StateView compact state="unavailable" title={t('zone.ctx.noMetrics')} description={t('zone.ctx.noMetrics.desc')} />
      ) : (
        <div className="zone-metrics">
          {ctx.metrics.map((m) => (
            <MetricValue key={`${m.key}:${m.horizon_year ?? 'now'}`} label={metricLabel(m.key)} metric={m} detailed={false} />
          ))}
        </div>
      )}
      <h4>{t('zone.ctx.restrictions')}</h4>
      {ctx.restrictions.length === 0 ? (
        <Notice tone="neutral" icon="inbox" title={t('zone.ctx.noRestrictions')}>
          {t('zone.ctx.noRestrictions.desc')}
        </Notice>
      ) : (
        <ul className="zone-list">
          {ctx.restrictions.map((r) => (
            <li key={r.id}>
              <code className="pg-code">{r.kind}</code>
            </li>
          ))}
        </ul>
      )}
      {extraGaps.length ? (
        <>
          <h4>{t('zone.ctx.gaps')}</h4>
          <DataGapList gaps={extraGaps} />
        </>
      ) : null}
    </div>
  );
}

function CreateScenarioDialog({ city, zone, open, onClose }: { city: City; zone: Zone; open: boolean; onClose: () => void }) {
  const { user } = useSession();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [horizon, setHorizon] = useState<1 | 2 | 3>(3);
  const [strategy, setStrategy] = useState<ScenarioRevisionInput['care_strategy']>('standard');
  const [comment, setComment] = useState('');
  const [key, setKey] = useState(newIdempotencyKey);
  const create = useMutation({
    mutationFn: async () => {
      // An empty draft: no placements and no catalog/rate/model versions. The server keeps it
      // and reports blockers when a calculation is requested (SEMANTICS «Создание сценария»).
      const initial: ScenarioRevisionInput & { parent_revision_id: null } = {
        zone_version_id: zone.version_id,
        parent_revision_id: null,
        dataset_version_ids: [],
        catalog_version_id: null,
        rate_version_id: null,
        coefficient_version_id: null,
        rule_version_id: null,
        model_version_id: null,
        placements: [],
        area_patches: [],
        capital_budget: null,
        care_horizon_years: horizon,
        resource_limits: [],
        excluded_plant_ids: [],
        diversity_caps: [],
        care_strategy: strategy,
        custom_care_operations: [],
        comment: comment.trim() || t('scenario.create.defaultComment'),
      };
      return unwrap<Scenario>(
        api.POST('/v1/scenarios', {
          params: { header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': key } },
          body: { city_id: city.id, zone_id: zone.id, name: name.trim(), base_revision_id: null, initial_state: initial },
        }),
      );
    },
    onSuccess: ({ data }) => {
      void qc.invalidateQueries({ queryKey: zk.zoneScenarios(city.id, zone.id) });
      void qc.invalidateQueries({ queryKey: ['list', 'scenarios'] });
      onClose();
      navigate(`/projects/${data.id}?city=${city.id}`);
    },
  });
  return (
    <Dialog
      open={open}
      title={t('scenario.create.title')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('action.cancel')}</Button>
          <Button
            variant="primary"
            busy={create.isPending}
            disabled={name.trim().length === 0}
            onClick={() => {
              if (create.isError) setKey(newIdempotencyKey());
              create.mutate();
            }}
          >
            {t('scenario.create.submit')}
          </Button>
        </>
      }
    >
      <p className="pg-muted">{t('scenario.create.desc', { zone: zone.name })}</p>
      <Field label={t('scenario.field.name')} required>
        {({ id }) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}
      </Field>
      <Field label={t('scenario.field.horizon')} hint={t('scenario.field.horizon.hint')}>
        {({ id, describedBy }) => (
          <Select id={id} aria-describedby={describedBy} value={horizon} onChange={(e) => setHorizon(Number(e.target.value) as 1 | 2 | 3)}>
            {[1, 2, 3].map((y) => (
              <option key={y} value={y}>
                {t('scenario.years', { n: y })}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('scenario.field.strategy')}>
        {({ id }) => (
          <Select id={id} value={strategy} onChange={(e) => setStrategy(e.target.value as ScenarioRevisionInput['care_strategy'])}>
            {(['standard', 'water_saving', 'intensive', 'custom'] as const).map((s) => (
              <option key={s} value={s}>
                {t(`care.${s}` as AppKey)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('scenario.field.comment')}>
        {({ id }) => <Input id={id} value={comment} onChange={(e) => setComment(e.target.value)} />}
      </Field>
      {create.isError ? <ApiErrorView compact error={create.error} /> : null}
    </Dialog>
  );
}

function ZoneScenarios({ city, zone }: { city: City; zone: Zone }) {
  const q = useZoneScenarios(city.id, zone.id);
  if (q.isPending) return <Skeleton lines={2} />;
  if (q.isError) return <ApiErrorView compact error={q.error} onRetry={() => void q.refetch()} />;
  if (q.data.items.length === 0) return <p className="pg-muted">{t('zone.scenarios.empty')}</p>;
  return (
    <ul className="zone-list">
      {q.data.items.map((s) => (
        <li key={s.id}>
          <Link to={`/projects/${s.id}?city=${city.id}`}>{s.name}</Link>{' '}
          <Badge tone={WF_TONE[s.status]}>{t(`wf.${s.status}` as AppKey)}</Badge>
          <span className="pg-muted"> · {formatDateTime(s.updated_at, city.timezone)}</span>
        </li>
      ))}
    </ul>
  );
}

function ZoneHistoryNote({ zone, timeZone }: { zone: Zone; timeZone: string }) {
  const [params, setParams] = useSearchParams();
  const versionId = params.get('zoneVersion');
  const { available, query } = useZoneVersion(versionId && versionId !== zone.version_id ? versionId : null);
  if (!versionId || versionId === zone.version_id) return null;
  const hide = (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => {
        const next = new URLSearchParams(params);
        next.delete('zoneVersion');
        setParams(next, { replace: true });
      }}
    >
      {t('zone.history.hide')}
    </Button>
  );
  if (available === false) return <OperationUnavailable compact operationId="getZoneVersion" />;
  if (query.isPending) return <Skeleton lines={2} />;
  if (query.isError) return <ApiErrorView compact error={query.error} onRetry={() => void query.refetch()} />;
  const v = query.data;
  if (v.id !== zone.id) return <Notice tone="warning" title={t('zone.history.other', { version: versionId.slice(0, 8) })} actions={hide} />;
  return (
    <Notice tone="info" icon="clock" title={t('zone.history.title', { version: versionId.slice(0, 8) })} actions={hide}>
      {t('zone.history.desc', { date: formatDateTime(v.updated_at, timeZone) ?? '—', area: formatNumber(v.area_m2, 0) ?? '—' })}
    </Notice>
  );
}

export function ZoneCard({ city, zoneId, onEditGeometry }: { city: City; zoneId: string; onEditGeometry?: (zone: Zone) => void }) {
  const zone = useZone(zoneId);
  const { hasRole } = useSession();
  const [creating, setCreating] = useState(false);
  const [params, setParams] = useSearchParams();
  const close = () => {
    const next = new URLSearchParams(params);
    next.delete('zone');
    setParams(next, { replace: true });
  };

  if (zone.isPending) return <Skeleton lines={6} block />;
  if (zone.isError) return <ApiErrorView compact error={zone.error} onRetry={() => void zone.refetch()} />;
  const z = zone.data.data;
  return (
    <div className="zone-card">
      <div className="zone-card__head">
        <div>
          <h3>{z.name}</h3>
          <p className="pg-muted">{t(`purpose.${z.purpose}` as AppKey)}</p>
        </div>
        <Button variant="ghost" size="sm" icon="x" iconOnly aria-label={t('zone.close')} onClick={close} />
      </div>
      <dl className="pg-dl">
        <dt>{t('zone.area')}</dt>
        <dd>
          {formatNumber(z.area_m2, 0)} <UnitText unit="m2" /> <span className="pg-muted">{t('zone.area.server')}</span>
        </dd>
        <dt>{t('zone.version')}</dt>
        <dd>
          <code className="pg-code">{z.version_id.slice(0, 8)}</code>
        </dd>
        <dt>{t('col.updated')}</dt>
        <dd>{formatDateTime(z.updated_at, city.timezone)}</dd>
      </dl>
      {z.data_gaps.some((g) => g.blocking) ? <DataGapList gaps={z.data_gaps.filter((g) => g.blocking)} /> : null}
      <ZoneHistoryNote zone={z} timeZone={city.timezone} />
      {onEditGeometry ? (
        editableRing(z.geometry) ? (
          <Button icon="map" onClick={() => onEditGeometry(z)}>
            {t('draw.edit.start')}
          </Button>
        ) : (
          <p className="pg-muted">{t('draw.edit.unsupported')}</p>
        )
      ) : null}
      <ZoneContextSection zone={z} />
      <h4>{t('zone.scenarios')}</h4>
      <ZoneScenarios city={city} zone={z} />
      {hasRole('specialist') ? (
        <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
          {t('scenario.create.open')}
        </Button>
      ) : (
        <p className="pg-muted">{t('scenario.create.roleHint')}</p>
      )}
      {creating ? <CreateScenarioDialog city={city} zone={z} open={creating} onClose={() => setCreating(false)} /> : null}
    </div>
  );
}
