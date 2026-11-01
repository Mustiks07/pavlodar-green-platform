import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, newIdempotencyKey, unwrap, type CalculationRequest, type CalculationSnapshotPage, type Job } from '@pg/api-client';
import { Button, JobStatus, Notice, Skeleton } from '@pg/ui';
import { api, useOperationAvailable } from '../../api';
import { t } from '../../i18n';
import { ApiErrorView } from '../../shell/ApiErrorView';
import { OperationUnavailable } from '../../shell/OperationUnavailable';
import { useSession } from '../../shell/session';
import { useJob } from '../jobs/useJob';
import { SnapshotById, useCalculation } from './SnapshotView';

/** URL keys: the running job, then its canonical snapshot; reload resumes either. */
export const CALC_JOB = 'calcJob';
export const CALC_RESULT = 'calc';

type Module = 'cost' | 'survival' | 'care' | 'ecosystem';
/** Modules a full run can request here; shadows run as their own jobs. */
const MODULES: Module[] = ['cost', 'survival', 'care', 'ecosystem'] satisfies CalculationRequest['include_modules'];

/**
 * Durable full calculation (startCalculation, ADR-026): tracked through the shared useJob (SSE with
 * polling fallback), cancellable, resumed from the URL after reload. A succeeded job is not the
 * result: the canonical CalculationSnapshot is loaded by result_ref_id and shown as the server
 * returned it, partial results included.
 */
export function FullCalculation({ revisionId, timeZone }: { revisionId: string; timeZone: string }) {
  const { user, hasRole } = useSession();
  const startOk = useOperationAvailable('startCalculation');
  const [params, setParams] = useSearchParams();
  const jobId = params.get(CALC_JOB);
  const resultId = params.get(CALC_RESULT);
  const job = useJob(jobId);
  const explicit = useCalculation(resultId);
  const explicitMatches = explicit.query.data?.scenario_revision_id === revisionId;
  const discoverSaved = !resultId || explicit.query.isError || (explicit.query.data !== undefined && !explicitMatches);
  const listOk = useOperationAvailable('listCalculations');
  const qc = useQueryClient();
  const [modules, setModules] = useState<Module[]>(MODULES);
  const saved = useQuery({
    queryKey: ['calculation-snapshots', revisionId],
    enabled: discoverSaved && listOk !== false,
    staleTime: 30_000,
    queryFn: async ({ signal }) => (
      await unwrap<CalculationSnapshotPage>(
        api.GET('/v1/calculations', { params: { query: { scenario_revision_id: revisionId, limit: 50 } }, signal }),
      )
    ).data.items,
    select: (items) => [...items].sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null,
  });
  const setUrl = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };
  const start = useMutation({
    mutationFn: async () =>
      (
        await unwrap<Job>(
          api.POST('/v1/calculations', {
            params: { header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': newIdempotencyKey() } },
            body: { scenario_revision_id: revisionId, mode: 'full', include_modules: modules, seed: 0 },
          }),
        )
      ).data,
    onSuccess: (j) => {
      qc.setQueryData(['job', j.id], j);
      setUrl({ [CALC_JOB]: j.id });
    },
  });
  const cancel = useMutation({
    mutationFn: async () =>
      (
        await unwrap<Job>(
          api.POST('/v1/jobs/{job_id}/cancel', {
            params: { path: { job_id: jobId! }, header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': newIdempotencyKey() } },
            body: { reason: t('calc.cancel.reason') },
          }),
        )
      ).data,
    onSuccess: (j) => qc.setQueryData(['job', j.id], j),
  });
  // The terminal job hands over to its snapshot; the snapshot itself is loaded below.
  const done = job.data?.state === 'succeeded' && job.data.result_ref_id ? job.data.result_ref_id : null;
  useEffect(() => {
    // setUrl reads the live URL, so only the handover itself is a dependency.
    if (done) setUrl({ [CALC_JOB]: null, [CALC_RESULT]: done });
  }, [done]); // eslint-disable-line react-hooks/exhaustive-deps

  const active = job.data && ['queued', 'running', 'cancel_requested'].includes(job.data.state);
  const canRun = hasRole('specialist') && startOk !== false;
  const shownResultId = explicitMatches ? resultId : saved.data?.id ?? null;
  return (
    <div className="calc-full" data-job-transport={jobId ? job.transport : undefined}>
      <p className="pg-muted">{t('calc.full.desc')}</p>
      {resultId && explicit.query.isPending ? <Skeleton lines={3} /> : null}
      {resultId && explicit.query.data && !explicitMatches ? <Notice tone="warning" title="Расчёт относится к другой версии проекта">Показан последний расчёт выбранной версии.</Notice> : null}
      {discoverSaved && saved.isPending ? <Skeleton lines={3} /> : null}
      {discoverSaved && saved.isError ? <ApiErrorView compact error={saved.error} onRetry={() => void saved.refetch()} /> : null}
      {shownResultId ? <SnapshotById id={shownResultId} timeZone={timeZone} compact /> : null}
      {discoverSaved && saved.data ? <p className="pg-muted">Показан последний сохранённый расчёт этой версии проекта.</p> : null}
      {jobId && job.isPending ? <Skeleton lines={2} /> : null}
      {jobId && job.isError ? (
        job.error instanceof ApiError && job.error.category === 'not_found' ? (
          <Notice tone="warning" title={t('calc.job.gone')} actions={<Button size="sm" onClick={() => setUrl({ [CALC_JOB]: null })}>{t('shadow.job.forget')}</Button>} />
        ) : (
          <ApiErrorView compact error={job.error} onRetry={() => void job.refetch()} />
        )
      ) : null}
      {job.data ? <JobStatus job={job.data} timeZone={timeZone} onCancel={active && canRun ? () => cancel.mutate() : undefined} /> : null}
      {cancel.isError ? <ApiErrorView compact error={cancel.error} /> : null}
      {job.data?.state === 'succeeded' && !job.data.result_ref_id ? <Notice tone="negative" title={t('calc.job.noResult')} /> : null}
      {job.data?.state === 'failed' ? <p className="pg-muted">{t('calc.job.failed')}</p> : null}
      {job.data?.state === 'cancelled' ? <p className="pg-muted">{t('calc.job.cancelled')}</p> : null}
      {startOk === false ? (
        <OperationUnavailable compact operationId="startCalculation" />
      ) : !hasRole('specialist') ? (
        <p className="pg-muted">{t('calc.full.role')}</p>
      ) : active ? null : (
        <fieldset className="calc-full__form">
          <legend>{t('calc.modules')}</legend>
          {MODULES.map((m) => (
            <label key={m} className="scn-check">
              <input
                type="checkbox"
                checked={modules.includes(m)}
                onChange={(e) => setModules((cur) => (e.target.checked ? [...cur, m] : cur.filter((x) => x !== m)))}
              />
              <span>{t(`calc.module.${m}`)}</span>
            </label>
          ))}
          <Button variant="primary" icon="refresh" busy={start.isPending} disabled={modules.length === 0} onClick={() => start.mutate()}>
            {t('calc.full.run')}
          </Button>
        </fieldset>
      )}
      {start.isError ? <ApiErrorView compact error={start.error} onRetry={() => start.mutate()} /> : null}
    </div>
  );
}
