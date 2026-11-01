import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  newIdempotencyKey,
  unwrap,
  type CalculationSnapshot,
  type CalculationSnapshotPage,
  type CompareResult,
  type Job,
  type Metric,
} from '@pg/api-client';
import { Badge, Button, formatNumber, JobStatus, MoneyText, Notice, Skeleton, UnitText } from '@pg/ui';
import { api, useOperationAvailable } from '../../api';
import { ApiErrorView } from '../../shell/ApiErrorView';
import { OperationUnavailable } from '../../shell/OperationUnavailable';
import { useSession } from '../../shell/session';
import { useJob } from '../jobs/useJob';
import { metricLabel } from '../zones/ZoneCard';
import { CALC_RESULT } from '../calculations/FullCalculation';

const MODULES = ['cost', 'survival', 'care', 'ecosystem'] as const;

function useLatestCalculation(revisionId: string) {
  const available = useOperationAvailable('listCalculations');
  return {
    available,
    query: useQuery({
      queryKey: ['assistant-proposal-calculations', revisionId],
      enabled: available !== false,
      queryFn: async ({ signal }) => (
        await unwrap<CalculationSnapshotPage>(
          api.GET('/v1/calculations', { params: { query: { scenario_revision_id: revisionId, limit: 50 } }, signal }),
        )
      ).data.items,
      select: (items) => [...items].sort((left, right) => right.created_at.localeCompare(left.created_at))[0] ?? null,
    }),
  };
}

function survivalAfterYear(snapshot: CalculationSnapshot) {
  const values = snapshot.survival
    .map((item) => item.points.find((point) => point.year === 1)?.probability)
    .filter((value): value is number => value !== null && value !== undefined);
  if (!values.length) return null;
  const low = Math.min(...values) * 100;
  const high = Math.max(...values) * 100;
  return low === high ? `${formatNumber(low, 0)}%` : `${formatNumber(low, 0)}–${formatNumber(high, 0)}%`;
}

function snapshotCost(snapshot: CalculationSnapshot) {
  return snapshot.cost.status === 'complete' && snapshot.cost.total
    ? snapshot.cost.total
    : snapshot.cost.known_subtotal;
}

function commonMetric(before: CalculationSnapshot, after: CalculationSnapshot): { before: Metric; after: Metric } | null {
  for (const first of before.ecosystem) {
    if (first.value === null || first.status === 'unavailable') continue;
    const second = after.ecosystem.find((item) => (
      item.key === first.key
      && item.horizon_year === first.horizon_year
      && item.value !== null
      && item.status !== 'unavailable'
      && item.unit === first.unit
    ));
    if (second) return { before: first, after: second };
  }
  return null;
}

function SnapshotOutcome({ title, snapshot, metric }: { title: string; snapshot: CalculationSnapshot; metric: Metric | null }) {
  const cost = snapshotCost(snapshot);
  const survival = survivalAfterYear(snapshot);
  return (
    <article className="asst-outcome__card">
      <small>{title}</small>
      <strong><MoneyText value={cost} /></strong>
      <span>{snapshot.cost.status === 'complete' ? 'полная стоимость' : 'известная стоимость'}</span>
      <dl>
        {survival ? <><dt>Приживаемость через год</dt><dd>{survival}</dd></> : null}
        {metric ? <><dt>{metricLabel(metric.key)}{metric.horizon_year ? ` · ${metric.horizon_year} лет` : ''}</dt><dd>{formatNumber(metric.value, 2)} <UnitText unit={metric.unit} /></dd></> : null}
      </dl>
    </article>
  );
}

/** Human-confirmed proposal -> exact full calculation -> server comparison of base and result. */
export function ProposalOutcome({ scenarioId, baseRevisionId, appliedRevisionId }: { scenarioId: string; baseRevisionId: string; appliedRevisionId: string }) {
  const { user, cityId } = useSession();
  const qc = useQueryClient();
  const startOk = useOperationAvailable('startCalculation');
  const compareOk = useOperationAvailable('compareScenarios');
  const base = useLatestCalculation(baseRevisionId);
  const applied = useLatestCalculation(appliedRevisionId);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob(jobId);
  const start = useMutation({
    mutationFn: async () => (
      await unwrap<Job>(
        api.POST('/v1/calculations', {
          params: { header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': newIdempotencyKey() } },
          body: { scenario_revision_id: appliedRevisionId, mode: 'full', include_modules: [...MODULES], seed: 0 },
        }),
      )
    ).data,
    onSuccess: (value) => {
      qc.setQueryData(['job', value.id], value);
      setJobId(value.id);
    },
  });
  const completedResult = job.data?.state === 'succeeded' ? job.data.result_ref_id : null;
  useEffect(() => {
    if (!completedResult) return;
    void qc.invalidateQueries({ queryKey: ['assistant-proposal-calculations', appliedRevisionId] });
  }, [appliedRevisionId, completedResult, qc]);

  const baseSnapshot = base.query.data ?? null;
  const appliedSnapshot = applied.query.data ?? null;
  const comparison = useQuery({
    queryKey: ['assistant-proposal-comparison', baseRevisionId, appliedRevisionId, baseSnapshot?.id, appliedSnapshot?.id],
    enabled: Boolean(baseSnapshot && appliedSnapshot) && compareOk !== false,
    queryFn: async () => (
      await unwrap<CompareResult>(
        api.POST('/v1/comparisons', {
          params: { header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': newIdempotencyKey() } },
          body: { scenario_revision_ids: [baseRevisionId, appliedRevisionId] },
        }),
      )
    ).data,
  });
  const compared = comparison.data?.snapshots ?? [];
  const before = compared.find((snapshot) => snapshot.scenario_revision_id === baseRevisionId) ?? baseSnapshot;
  const after = compared.find((snapshot) => snapshot.scenario_revision_id === appliedRevisionId) ?? appliedSnapshot;
  const metric = useMemo(() => before && after ? commonMetric(before, after) : null, [before, after]);
  const active = job.data && ['queued', 'running', 'cancel_requested'].includes(job.data.state);
  const comparedReady = Boolean(before && after);
  const costDelta = before && after ? Number(snapshotCost(after)) - Number(snapshotCost(before)) : null;

  return (
    <section className="asst-outcome" data-proposal-outcome={appliedRevisionId}>
      <header>
        <span><small>Проверяемый результат</small><strong>Последствия подтверждённого изменения</strong></span>
        <Badge tone={comparedReady ? 'positive' : active ? 'info' : 'neutral'}>{comparedReady ? 'сравнено' : after ? 'нужен исходный' : active ? 'считается' : 'нужен расчёт'}</Badge>
      </header>
      {!appliedSnapshot && !active ? (
        <>
          <p>Изменение сохранено новой версией проекта. Запустите серверный расчёт, чтобы сравнить стоимость, приживаемость и доступный эффект до и после.</p>
          {startOk === false ? <OperationUnavailable compact operationId="startCalculation" /> : (
            <Button size="sm" variant="primary" icon="refresh" busy={start.isPending} onClick={() => start.mutate()}>Рассчитать последствия</Button>
          )}
        </>
      ) : null}
      {start.isError ? <ApiErrorView compact error={start.error} onRetry={() => start.mutate()} /> : null}
      {jobId && job.isPending ? <Skeleton lines={2} /> : null}
      {job.isError ? <ApiErrorView compact error={job.error} onRetry={() => void job.refetch()} /> : null}
      {job.data && (active || job.data.state !== 'succeeded') ? <JobStatus job={job.data} /> : null}
      {job.data?.state === 'failed' ? <Notice tone="warning" title="Расчёт не завершён">Изменение сохранено; расчёт можно запустить повторно.</Notice> : null}
      {base.query.isPending || applied.query.isPending || (baseSnapshot && appliedSnapshot && comparison.isPending) ? <Skeleton lines={3} /> : null}
      {base.query.isError ? <ApiErrorView compact error={base.query.error} onRetry={() => void base.query.refetch()} /> : null}
      {applied.query.isError ? <ApiErrorView compact error={applied.query.error} onRetry={() => void applied.query.refetch()} /> : null}
      {comparison.isError ? <ApiErrorView compact error={comparison.error} onRetry={() => void comparison.refetch()} /> : null}
      {before && after ? (
        <>
          {costDelta !== null ? (
            <p className="asst-outcome__delta">
              {costDelta === 0 ? 'Стоимость не изменилась' : <>Стоимость {costDelta > 0 ? 'вырастет на ' : 'снизится на '}<MoneyText value={Math.abs(costDelta).toFixed(2)} /></>}
            </p>
          ) : null}
          <div className="asst-outcome__grid">
            <SnapshotOutcome title="До" snapshot={before} metric={metric?.before ?? null} />
            <SnapshotOutcome title="После" snapshot={after} metric={metric?.after ?? null} />
          </div>
          <p className="asst-outcome__note">Обе колонки — сохранённые серверные расчёты точных версий проекта. Изменение применил специалист.</p>
          <Link className="pg-btn pg-btn--secondary pg-btn--sm" to={`/projects/${scenarioId}?${new URLSearchParams({ ...(cityId ? { city: cityId } : {}), revision: appliedRevisionId, [CALC_RESULT]: after.id })}`}>Открыть новый результат целиком</Link>
        </>
      ) : base.query.data === null && !base.query.isPending ? (
        <Notice tone="warning" title="Нет исходного расчёта">Сначала рассчитайте исходную версию проекта, чтобы получить сравнение до и после.</Notice>
      ) : null}
    </section>
  );
}
