import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, newIdempotencyKey, unwrap, type Job, type ShadowRequest, type SpatialResult } from '@pg/api-client';
import { Badge, Button, DataGapList, Field, formatDateTime, formatNumber, Input, JobStatus, MetricValue, Notice, Select, Skeleton, StateView } from '@pg/ui';
import { api, useOperationAvailable } from '../../api';
import { t } from '../../i18n';
import { ApiErrorView } from '../../shell/ApiErrorView';
import { OperationUnavailable } from '../../shell/OperationUnavailable';
import { useSession } from '../../shell/session';
import { useJob } from '../jobs/useJob';
import { metricLabel } from '../zones/ZoneCard';
import { todayIn, useShadowArtifact, useSpatialResult, zonedIso } from './queries';

/** URL keys: the running job and the shown result survive reload and can be shared. */
export const SHADOW_JOB = 'shadowJob';
export const SHADOW_RESULT = 'shadow';

const RESOLUTIONS = [0.5, 1, 2, 5];

/** Stable no-op for callers that only need the URL hand-over. */
export const noShadowCallback = () => undefined;

/** Date, time, mode and grid of a run. Times are wall-clock in the city's time zone. */
interface FormState {
  date: string;
  time: string;
  mode: ShadowRequest['geometry_mode'];
  resolution: number;
}

function ShadowForm({ value, onChange, timeZone, busy, onStart }: { value: FormState; onChange: (v: FormState) => void; timeZone: string; busy: boolean; onStart: (body: Omit<ShadowRequest, 'scenario_revision_id'>) => void }) {
  const { date, time, mode, resolution } = value;
  const setDate = (d: string) => onChange({ ...value, date: d });
  const setTime = (v: string) => onChange({ ...value, time: v });
  const setMode = (m: ShadowRequest['geometry_mode']) => onChange({ ...value, mode: m });
  const setResolution = (r: number) => onChange({ ...value, resolution: r });
  return (
    <form
      className="shd-form"
      onSubmit={(e) => {
        e.preventDefault();
        onStart({ datetime: zonedIso(date, time, timeZone), grid_resolution_m: resolution, geometry_mode: mode, include_neighbor_buffer: true });
      }}
    >
      <Field label={t('shadow.date')} required>
        {({ id }) => <Input id={id} type="date" required value={date} onChange={(e) => setDate(e.target.value)} />}
      </Field>
      <Field label={t('shadow.time')} hint={t('shadow.time.hint', { tz: timeZone })} required>
        {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} type="time" required step={60} value={time} onChange={(e) => setTime(e.target.value)} />}
      </Field>
      <Field label={t('shadow.mode')} hint={t(`shadow.mode.${mode}.hint`)}>
        {({ id, describedBy }) => (
          <Select id={id} aria-describedby={describedBy} value={mode} onChange={(e) => setMode(e.target.value as ShadowRequest['geometry_mode'])}>
            <option value="estimated_preview">{t('shadow.mode.estimated_preview')}</option>
            <option value="analytical_verified">{t('shadow.mode.analytical_verified')}</option>
          </Select>
        )}
      </Field>
      <Field label={t('shadow.grid')}>
        {({ id }) => (
          <Select id={id} value={String(resolution)} onChange={(e) => setResolution(Number(e.target.value))}>
            {RESOLUTIONS.map((r) => (
              <option key={r} value={r}>
                {t('shadow.grid.value', { m: formatNumber(r, r < 1 ? 2 : 0) ?? String(r) })}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Button type="submit" variant="primary" icon="sun" busy={busy} disabled={!date || !time}>
        {t('shadow.run')}
      </Button>
    </form>
  );
}

/**
 * Starts a shadow run for a saved revision (startShadowRun -> Job kind shadow), tracks the job by
 * polling getJob, and hands the finished result id to the URL. Specialists only (server rule).
 */
export function ShadowRunner({ revisionId, timeZone, onResult }: { revisionId: string; timeZone: string; onResult: (id: string) => void }) {
  const { user, hasRole } = useSession();
  const startOk = useOperationAvailable('startShadowRun');
  const [params, setParams] = useSearchParams();
  const jobId = params.get(SHADOW_JOB);
  const job = useJob(jobId);
  // Kept here so the inputs survive the form being hidden while a job runs.
  const [form, setForm] = useState<FormState>(() => ({ date: todayIn(timeZone), time: '13:00', mode: 'estimated_preview', resolution: 1 }));
  const qc = useQueryClient();
  const setJob = (id: string | null) => {
    const next = new URLSearchParams(window.location.search);
    if (id) next.set(SHADOW_JOB, id);
    else next.delete(SHADOW_JOB);
    setParams(next, { replace: true });
  };
  const start = useMutation({
    mutationFn: async (body: Omit<ShadowRequest, 'scenario_revision_id'>) =>
      (
        await unwrap<Job>(
          api.POST('/v1/shadow-runs', {
            params: { header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': newIdempotencyKey() } },
            body: { ...body, scenario_revision_id: revisionId },
          }),
        )
      ).data,
    onSuccess: (j) => {
      qc.setQueryData(['job', j.id], j);
      setJob(j.id);
    },
  });
  const cancel = useMutation({
    mutationFn: async () =>
      (
        await unwrap<Job>(
          api.POST('/v1/jobs/{job_id}/cancel', {
            params: { path: { job_id: jobId! }, header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': newIdempotencyKey() } },
            body: { reason: t('shadow.cancel.reason') },
          }),
        )
      ).data,
    onSuccess: (j) => qc.setQueryData(['job', j.id], j),
  });
  const done = job.data?.state === 'succeeded' && job.data.result_ref_id ? job.data.result_ref_id : null;
  useEffect(() => {
    if (!done) return;
    // The finished result replaces the job in the URL (reload and sharing keep the result).
    const next = new URLSearchParams(window.location.search);
    next.delete(SHADOW_JOB);
    next.set(SHADOW_RESULT, done);
    setParams(next, { replace: true });
    onResult(done);
  }, [done, setParams, onResult]);

  if (!hasRole('specialist')) return <p className="pg-muted">{t('shadow.run.role')}</p>;
  if (startOk === false) return <OperationUnavailable compact operationId="startShadowRun" />;
  const active = job.data && (job.data.state === 'queued' || job.data.state === 'running' || job.data.state === 'cancel_requested');
  return (
    <div className="shd-runner" data-job-transport={jobId ? job.transport : undefined}>
      {jobId && job.isPending ? <Skeleton lines={2} /> : null}
      {jobId && job.isError ? (
        job.error instanceof ApiError && job.error.category === 'not_found' ? (
          <Notice tone="warning" title={t('shadow.job.gone')} actions={<Button size="sm" onClick={() => setJob(null)}>{t('shadow.job.forget')}</Button>} />
        ) : (
          <ApiErrorView compact error={job.error} onRetry={() => void job.refetch()} />
        )
      ) : null}
      {job.data ? <JobStatus job={job.data} timeZone={timeZone} onCancel={active ? () => cancel.mutate() : undefined} /> : null}
      {cancel.isError ? <ApiErrorView compact error={cancel.error} /> : null}
      {job.data?.state === 'failed' || job.data?.state === 'cancelled' ? (
        <p className="pg-muted">{job.data.state === 'failed' ? t('shadow.job.failed') : t('shadow.job.cancelled')}</p>
      ) : null}
      {active ? null : <ShadowForm value={form} onChange={setForm} timeZone={timeZone} busy={start.isPending} onStart={(body) => start.mutate(body)} />}
      {start.isError ? <ApiErrorView compact error={start.error} onRetry={() => start.reset()} /> : null}
    </div>
  );
}

const STATUS_TONE = { complete: 'positive', partial: 'warning', unavailable: 'neutral' } as const;

/** Server result of a shadow run: status, shaded area, the moment and sun from the artifact. */
export function ShadowResultView({ result, timeZone, mapLink }: { result: SpatialResult; timeZone: string; mapLink?: string }) {
  const artifact = useShadowArtifact(result);
  const meta = artifact.query.data?.metadata;
  // Reasons already explained inside a metric are not listed twice.
  const explained = new Set(result.metrics.map((m) => m.missing_reason?.code).filter(Boolean));
  const blocking = result.data_gaps.filter((g) => g.blocking && !explained.has(g.code));
  return (
    <div className="shd-result" data-spatial-result-id={result.id} data-status={result.status}>
      <span className="pg-flags">
        <Badge tone={STATUS_TONE[result.status]}>{t(`shadow.status.${result.status}`)}</Badge>
        {meta ? <Badge tone="neutral">{t(`shadow.mode.${meta.geometry_mode}`)}</Badge> : null}
      </span>
      {meta ? (
        <dl className="pg-dl">
          <dt>{t('shadow.moment')}</dt>
          <dd>{formatDateTime(meta.datetime, timeZone)}</dd>
          <dt>{t('shadow.sun')}</dt>
          <dd>{t('shadow.sun.value', { elevation: formatNumber(meta.sun.elevation_deg, 1) ?? '—', azimuth: formatNumber(meta.sun.azimuth_deg, 0) ?? '—' })}</dd>
          <dt>{t('shadow.used')}</dt>
          <dd>{t('shadow.used.value', { buildings: meta.used_buildings, trees: meta.used_trees })}</dd>
        </dl>
      ) : null}
      <div className="shd-metrics">
        {result.metrics.map((m) => (
          <MetricValue key={m.key} label={metricLabel(m.key)} metric={m} detailed={false} />
        ))}
      </div>
      {blocking.length ? <DataGapList gaps={blocking} /> : null}
      {result.artifact_url ? (
        artifact.available === false ? (
          <OperationUnavailable compact operationId="getSpatialResultArtifact" />
        ) : artifact.query.isPending ? (
          <Skeleton lines={1} />
        ) : artifact.query.isError ? (
          <ApiErrorView compact error={artifact.query.error} onRetry={() => void artifact.query.refetch()} />
        ) : null
      ) : null}
      {mapLink && result.artifact_url ? (
        <Link className="pg-btn pg-btn--secondary pg-btn--sm" to={mapLink}>
          {t('shadow.open3d')}
        </Link>
      ) : null}
    </div>
  );
}

/** Result by id with its typed states (404 covers both "no such result" and "not yours"). */
export function ShadowResultById({ id, timeZone, mapLink }: { id: string; timeZone: string; mapLink?: string }) {
  const { available, query } = useSpatialResult(id);
  if (available === false) return <OperationUnavailable compact operationId="getSpatialResult" />;
  if (query.isPending) return <Skeleton lines={3} />;
  if (query.isError) {
    if (query.error instanceof ApiError && query.error.category === 'not_found') {
      return <StateView compact state="not_found" title={t('shadow.notFound')} description={t('shadow.notFound.desc')} />;
    }
    return <ApiErrorView compact error={query.error} onRetry={() => void query.refetch()} />;
  }
  return <ShadowResultView result={query.data} timeZone={timeZone} mapLink={mapLink} />;
}

/** Scenario screen section: run for the revision, then show the result and a link to 3D. */
export function ShadowSection({ revisionId, cityId, zoneId, timeZone }: { revisionId: string; cityId: string; zoneId: string; timeZone: string }) {
  const [params] = useSearchParams();
  const resultId = params.get(SHADOW_RESULT);
  const mapLink = (id: string) => `/?city=${cityId}&zone=${zoneId}&scene=3d&${SHADOW_RESULT}=${id}`;
  return (
    <section className="shd-section" aria-labelledby="shd-h">
      <h3 id="shd-h">{t('shadow.title')}</h3>
      <p className="pg-muted">{t('shadow.desc')}</p>
      {resultId ? <ShadowResultById id={resultId} timeZone={timeZone} mapLink={mapLink(resultId)} /> : null}
      <ShadowRunner revisionId={revisionId} timeZone={timeZone} onResult={noShadowCallback} />
    </section>
  );
}
