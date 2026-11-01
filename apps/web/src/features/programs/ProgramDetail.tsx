import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  newIdempotencyKey,
  unwrap,
  type CalculationSnapshotPage,
  type Job,
  type Program,
  type ProgramCreate,
  type ProgramRevision,
  type ProgramRevisionDiff,
  type PriorityResult,
  type Zone,
} from '@pg/api-client';
import { Badge, Button, Card, Dialog, Field, formatDateTime, Input, JobStatus, MoneyText, Notice, Skeleton, StateView } from '@pg/ui';
import { api, useOperationAvailable } from '../../api';
import { t, type AppKey } from '../../i18n';
import { ApiErrorView } from '../../shell/ApiErrorView';
import { OperationUnavailable } from '../../shell/OperationUnavailable';
import { useSession } from '../../shell/session';
import { ExportPanel } from '../exports/ExportPanel';
import { useJob } from '../jobs/useJob';
import { useSelected } from '../resources/details';
import { PriorityDashboard } from './PriorityDashboard';

const SOLVER_TONE = { optimal: 'positive', feasible: 'info', infeasible: 'negative', timeout: 'warning', unknown: 'neutral' } as const;
const STATUS_TONE = { draft: 'neutral', in_review: 'info', approved: 'positive', archived: 'neutral' } as const;
type Target = Program['status'];
const OFFERED: Record<Target, { target: Target; role: 'specialist' | 'admin' }[]> = {
  draft: [{ target: 'in_review', role: 'specialist' }, { target: 'archived', role: 'specialist' }],
  in_review: [{ target: 'approved', role: 'admin' }, { target: 'draft', role: 'specialist' }, { target: 'archived', role: 'specialist' }],
  approved: [{ target: 'archived', role: 'admin' }],
  archived: [],
};

const decimalOrNull = (value: string) => (value.trim() ? Number(value) : null);
const integerOrNull = (value: string) => (value.trim() ? Number.parseInt(value, 10) : null);

/** Complete city-program workflow over the canonical server operations. */
export function ProgramDetail({ program, timeZone, onClose }: { program: Program; timeZone: string; onClose: () => void }) {
  const { user, hasRole } = useSession();
  const qc = useQueryClient();
  const [revisionId, setRevisionId] = useSelected('revision');
  const [jobId, setJobId] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [transitionTarget, setTransitionTarget] = useState<Target | null>(null);
  const [reason, setReason] = useState('');
  const [name, setName] = useState(program.name);
  const [budget, setBudget] = useState(program.capital_budget);
  const [water, setWater] = useState('');
  const [crew, setCrew] = useState('');
  const [visits, setVisits] = useState('');
  const [careBudget, setCareBudget] = useState('');
  const [baseRevisionId, setBaseRevisionId] = useState('');
  const [targetRevisionId, setTargetRevisionId] = useState('');

  const details = useQuery({
    queryKey: ['program', program.id],
    queryFn: async ({ signal }) => unwrap<Program>(api.GET('/v1/programs/{program_id}', { params: { path: { program_id: program.id } }, signal })),
  });
  const current = details.data?.data ?? program;
  const priority = useQuery({
    queryKey: ['priority-result', current.priority_result_id ?? ''],
    enabled: Boolean(current.priority_result_id),
    queryFn: async ({ signal }) => (
      await unwrap<PriorityResult>(
        api.GET('/v1/priorities/{priority_id}', {
          params: { path: { priority_id: current.priority_result_id! } },
          signal,
        }),
      )
    ).data,
  });
  const priorityZones = useQuery({
    queryKey: ['program-priority-zones', current.city_id],
    enabled: Boolean(current.priority_result_id),
    queryFn: async ({ signal }) => (
      await unwrap(api.GET('/v1/zones', { params: { query: { city_id: current.city_id, limit: 200 } }, signal }))
    ).data.items as Zone[],
  });
  const priorityZoneNames = useMemo(
    () => new Map((priorityZones.data ?? []).map((zone) => [zone.id, zone.name])),
    [priorityZones.data],
  );
  const calculationReadiness = useQueries({
    queries: current.candidate_revision_ids.map((revisionId) => ({
      queryKey: ['program-candidate-calculations', revisionId],
      queryFn: async ({ signal }: { signal: AbortSignal }) => (
        await unwrap<CalculationSnapshotPage>(
          api.GET('/v1/calculations', { params: { query: { scenario_revision_id: revisionId, limit: 200 } }, signal }),
        )
      ).data.items,
      staleTime: 60_000,
    })),
  });
  const calculationsPending = calculationReadiness.some((query) => query.isPending);
  const readyCandidates = calculationReadiness.filter((query) => query.data?.some((snapshot) => (
    snapshot.status === 'complete'
    && snapshot.cost.status === 'complete'
    && snapshot.care.length > 0
    && !snapshot.warnings.some((warning) => warning.blocking)
  ))).length;
  const optimizationReady = current.candidate_revision_ids.length > 0
    && !calculationsPending
    && readyCandidates === current.candidate_revision_ids.length;
  const revisionsAvailable = useOperationAvailable('listProgramRevisions');
  const revisions = useQuery({
    queryKey: ['program-revisions', program.id],
    enabled: revisionsAvailable !== false,
    queryFn: async ({ signal }) =>
      (await unwrap(api.GET('/v1/programs/{program_id}/revisions', { params: { path: { program_id: program.id }, query: { limit: 50 } }, signal }))).data.items as ProgramRevision[],
  });
  const items = [...(revisions.data ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const selected: ProgramRevision | null = items.find((revision) => revision.id === revisionId) ?? (revisionId ? null : (items.find((revision) => revision.id === current.current_revision_id) ?? items[0] ?? null));
  const job = useJob(jobId);
  const activeJob = job.data && ['queued', 'running', 'cancel_requested'].includes(job.data.state);

  useEffect(() => {
    if (items.length < 2 || baseRevisionId || targetRevisionId) return;
    setBaseRevisionId(items[1]!.id);
    setTargetRevisionId(items[0]!.id);
  }, [items, baseRevisionId, targetRevisionId]);
  useEffect(() => {
    if (job.data?.state !== 'succeeded') return;
    void qc.invalidateQueries({ queryKey: ['program', program.id] });
    void qc.invalidateQueries({ queryKey: ['program-revisions', program.id] });
    void qc.invalidateQueries({ queryKey: ['list', 'programs'] });
  }, [job.data?.state, program.id, qc]);

  const optimize = useMutation({
    mutationFn: async () => {
      const fresh = await unwrap<Program>(api.GET('/v1/programs/{program_id}', { params: { path: { program_id: program.id } } }));
      return (
        await unwrap<Job>(
          api.POST('/v1/programs/{program_id}/optimize', {
            params: { path: { program_id: program.id }, header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': newIdempotencyKey(), 'If-Match': fresh.etag ?? '' } },
            body: { program_id: program.id, time_limit_seconds: 60, seed: 0 },
          }),
        )
      ).data;
    },
    onSuccess: (nextJob) => {
      qc.setQueryData(['job', nextJob.id], nextJob);
      setJobId(nextJob.id);
    },
  });
  const cancel = useMutation({
    mutationFn: async () =>
      (
        await unwrap<Job>(
          api.POST('/v1/jobs/{job_id}/cancel', {
            params: { path: { job_id: jobId! }, header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': newIdempotencyKey() } },
            body: { reason: t('program.optimize.cancelReason') },
          }),
        )
      ).data,
    onSuccess: (nextJob) => qc.setQueryData(['job', nextJob.id], nextJob),
  });

  const openEditor = () => {
    const limit = current.resource_limits[0];
    setName(current.name);
    setBudget(current.capital_budget);
    setWater(limit?.water_m3 === null || limit?.water_m3 === undefined ? '' : String(limit.water_m3));
    setCrew(limit?.crew_minutes === null || limit?.crew_minutes === undefined ? '' : String(limit.crew_minutes));
    setVisits(limit?.max_visits === null || limit?.max_visits === undefined ? '' : String(limit.max_visits));
    setCareBudget(limit?.care_budget ?? '');
    setEditOpen(true);
  };
  const update = useMutation({
    mutationFn: async () => {
      const fresh = await unwrap<Program>(api.GET('/v1/programs/{program_id}', { params: { path: { program_id: program.id } } }));
      const source = fresh.data;
      const first = source.resource_limits[0] ?? { period: 'year:1', water_m3: null, crew_minutes: null, max_visits: null, care_budget: null };
      const resourceLimits = source.resource_limits.length > 0
        ? source.resource_limits.map((limit, index) => index === 0 ? { ...limit, water_m3: decimalOrNull(water), crew_minutes: integerOrNull(crew), max_visits: integerOrNull(visits), care_budget: careBudget.trim() || null } : limit)
        : [{ ...first, water_m3: decimalOrNull(water), crew_minutes: integerOrNull(crew), max_visits: integerOrNull(visits), care_budget: careBudget.trim() || null }];
      const body: ProgramCreate = {
        city_id: source.city_id,
        name: name.trim(),
        capital_budget: budget.trim(),
        resource_limits: resourceLimits,
        candidate_revision_ids: source.candidate_revision_ids,
        required_zone_ids: source.required_zone_ids,
        excluded_zone_ids: source.excluded_zone_ids,
        benefit_weights: source.benefit_weights,
        diversity_caps: source.diversity_caps,
        coverage_requirements: source.coverage_requirements,
        priority_result_id: source.priority_result_id ?? null,
      };
      return (
        await unwrap<Program>(
          api.PUT('/v1/programs/{program_id}', {
            params: { path: { program_id: program.id }, header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': newIdempotencyKey(), 'If-Match': fresh.etag ?? '' } },
            body,
          }),
        )
      ).data;
    },
    onSuccess: () => {
      setEditOpen(false);
      void qc.invalidateQueries({ queryKey: ['program', program.id] });
      void qc.invalidateQueries({ queryKey: ['list', 'programs'] });
    },
  });

  const transition = useMutation({
    mutationFn: async () => {
      const fresh = await unwrap<Program>(api.GET('/v1/programs/{program_id}', { params: { path: { program_id: program.id } } }));
      return (
        await unwrap<Program>(
          api.POST('/v1/programs/{program_id}/transitions', {
            params: { path: { program_id: program.id }, header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': newIdempotencyKey(), 'If-Match': fresh.etag ?? '' } },
            body: { target_status: transitionTarget!, reason: reason.trim(), revision_id: fresh.data.current_revision_id! },
          }),
        )
      ).data;
    },
    onSuccess: () => {
      setTransitionTarget(null);
      void qc.invalidateQueries({ queryKey: ['program', program.id] });
      void qc.invalidateQueries({ queryKey: ['list', 'programs'] });
    },
  });
  const transitions = OFFERED[current.status].filter((option) => hasRole(option.role));

  const diff = useQuery({
    queryKey: ['program-revision-diff', program.id, baseRevisionId, targetRevisionId],
    enabled: Boolean(baseRevisionId && targetRevisionId && baseRevisionId !== targetRevisionId),
    queryFn: async ({ signal }) =>
      (
        await unwrap<ProgramRevisionDiff>(
          api.GET('/v1/programs/{program_id}/revisions/{base_revision_id}/diff/{target_revision_id}', {
            params: { path: { program_id: program.id, base_revision_id: baseRevisionId, target_revision_id: targetRevisionId } },
            signal,
          }),
        )
      ).data,
  });

  return (
    <Card title={current.name} actions={<Button variant="ghost" size="sm" icon="x" iconOnly aria-label={t('program.close')} onClick={onClose} />}>
      {details.isError ? <ApiErrorView compact error={details.error} onRetry={() => void details.refetch()} /> : null}
      <div className="program-summary">
        <div className="program-summary__head">
          <span><small>Городская программа</small><strong>{current.name}</strong></span>
          <Badge tone={STATUS_TONE[current.status]}>{t(`wf.${current.status}` as AppKey)}</Badge>
        </div>
        <div className="program-summary__metrics">
          <article><small>{t('program.field.budget')}</small><strong><MoneyText value={current.capital_budget} /></strong><em>капитальные затраты</em></article>
          <article><small>{t('program.field.candidates')}</small><strong>{current.candidate_revision_ids.length}</strong><em>проектов для отбора</em></article>
          <article><small>Оптимизация</small><strong>{current.current_revision_id ? 'Готова' : optimizationReady ? 'Готова к запуску' : `${current.candidate_revision_ids.length} вариантов собрано`}</strong><em>{current.current_revision_id ? 'результат сохранён' : optimizationReady ? 'можно запускать подбор' : 'полные сметы уточняются'}</em></article>
        </div>
      </div>
      {hasRole('specialist') ? (
        <div className="scn-actions">
          {current.status === 'draft' ? <Button onClick={openEditor}>{t('program.edit')}</Button> : null}
          {current.status === 'draft' ? <Button variant="primary" busy={optimize.isPending || calculationsPending} disabled={!current.priority_result_id || (!current.current_revision_id && !optimizationReady) || Boolean(activeJob)} onClick={() => optimize.mutate()}>{current.current_revision_id ? 'Пересчитать программу' : optimizationReady ? t('program.optimize') : 'Подготовка расчётов…'}</Button> : null}
          {transitions.map((option) => <Button key={option.target} variant={option.target === 'archived' ? 'secondary' : 'primary'} disabled={!current.current_revision_id} onClick={() => { setReason(''); setTransitionTarget(option.target); }}>{t(`transition.to.${option.target}` as AppKey)}</Button>)}
        </div>
      ) : null}
      {current.status === 'draft' && !current.priority_result_id ? <Notice tone="warning" title={t('program.priority.missing')}><p>{t('program.priority.missing.desc')}</p></Notice> : null}
      {current.status === 'draft' && current.priority_result_id && !calculationsPending && !optimizationReady ? (
        <Notice tone="info" title="Программа собрана — нужны полные сметы">
          <p>В программу включены {current.candidate_revision_ids.length} вариантов. Оптимизация станет доступна, когда для каждого будут рассчитаны стоимость и уход: сейчас готово {readyCandidates}.</p>
          <Link className="pg-btn pg-btn--secondary pg-btn--sm" to={`/projects?city=${current.city_id}`}>Открыть проекты участков</Link>
        </Notice>
      ) : null}
      {current.priority_result_id ? (
        priority.isPending || priorityZones.isPending ? <Skeleton lines={4} />
          : priority.isError ? <ApiErrorView compact error={priority.error} onRetry={() => void priority.refetch()} />
            : priorityZones.isError ? <ApiErrorView compact error={priorityZones.error} onRetry={() => void priorityZones.refetch()} />
              : priority.data ? <PriorityDashboard result={priority.data} zoneNames={priorityZoneNames} cityId={current.city_id} /> : null
      ) : null}
      {optimize.isError ? <ApiErrorView compact error={optimize.error} onRetry={() => optimize.mutate()} /> : null}
      {jobId && job.isPending ? <Skeleton lines={2} /> : null}
      {jobId && job.isError ? <ApiErrorView compact error={job.error} onRetry={() => void job.refetch()} /> : null}
      {job.data ? <JobStatus job={job.data} timeZone={timeZone} onCancel={activeJob ? () => cancel.mutate() : undefined} /> : null}
      {cancel.isError ? <ApiErrorView compact error={cancel.error} /> : null}

      <details className="program-details">
      <summary>Версии и результаты оптимизации</summary>
      <h4>{t('program.revisions')}</h4>
      {revisionsAvailable === false ? <OperationUnavailable compact operationId="listProgramRevisions" /> : revisions.isPending ? <Skeleton lines={3} /> : revisions.isError ? <ApiErrorView compact error={revisions.error} onRetry={() => void revisions.refetch()} /> : items.length === 0 ? <StateView compact state="empty" title={t('program.revisions.empty')} description={t('program.revisions.empty.desc')} /> : (
        <ul className="app-versions">
          {items.map((revision) => (
            <li key={revision.id} className={revision.id === selected?.id ? 'is-current' : undefined}>
              <div className="app-versions__head">
                <Badge tone={SOLVER_TONE[revision.solver_status]}>{t(`program.solver.${revision.solver_status}` as AppKey)}</Badge>
                {revision.id === current.current_revision_id ? <Badge tone="accent">{t('program.current')}</Badge> : null}
                <span className="pg-muted">Результат от {formatDateTime(revision.created_at)}</span>
              </div>
              <dl className="pg-dl">
                <dt>{t('program.capital')}</dt><dd>{revision.capital_total ? <MoneyText value={revision.capital_total} /> : <span className="pg-unknown">{t('program.capital.unknown')}</span>}</dd>
                <dt>{t('program.selected')}</dt><dd>{t('program.selected.n', { n: revision.selected_scenario_revision_ids.length })}</dd>
                <dt>{t('program.objective')}</dt><dd>{revision.objective ?? t('program.value.unknown')}</dd>
                <dt>{t('program.gap')}</dt><dd>{revision.gap === null ? t('program.value.unknown') : `${(revision.gap * 100).toFixed(1)}%`}</dd>
                <dt>{t('program.elapsed')}</dt><dd>{revision.elapsed_seconds.toFixed(2)} {t('unit.seconds')}</dd>
                <dt>{t('col.created')}</dt><dd>{formatDateTime(revision.created_at)}</dd>
              </dl>
              {revision.constraint_violations.length > 0 ? <p className="pg-field__error">{t('program.violations', { n: revision.constraint_violations.length })}</p> : null}
              {revision.id === selected?.id ? null : <Button size="sm" variant="ghost" onClick={() => setRevisionId(revision.id)}>{t('program.pick')}</Button>}
            </li>
          ))}
        </ul>
      )}

      {items.length >= 2 ? (
        <section className="program-diff">
          <h4>{t('program.diff.title')}</h4>
          <div className="program-diff__selectors">
            <label>{t('program.diff.base')}<select className="pg-input" value={baseRevisionId} onChange={(event) => setBaseRevisionId(event.target.value)}>{items.map((revision, index) => <option key={revision.id} value={revision.id}>Результат {items.length - index} · {formatDateTime(revision.created_at)}</option>)}</select></label>
            <label>{t('program.diff.target')}<select className="pg-input" value={targetRevisionId} onChange={(event) => setTargetRevisionId(event.target.value)}>{items.map((revision, index) => <option key={revision.id} value={revision.id}>Результат {items.length - index} · {formatDateTime(revision.created_at)}</option>)}</select></label>
          </div>
          {diff.isPending ? <Skeleton lines={2} /> : null}
          {diff.isError ? <ApiErrorView compact error={diff.error} onRetry={() => void diff.refetch()} /> : null}
          {diff.data ? <dl className="pg-dl"><dt>{t('program.diff.added')}</dt><dd>{diff.data.added_scenario_revision_ids.length}</dd><dt>{t('program.diff.removed')}</dt><dd>{diff.data.removed_scenario_revision_ids.length}</dd><dt>{t('program.diff.fields')}</dt><dd>{diff.data.changed_input_fields.join(', ') || '—'}</dd><dt>{t('program.diff.capital')}</dt><dd>{diff.data.capital_delta === null ? '—' : <MoneyText value={diff.data.capital_delta} />}</dd></dl> : null}
        </section>
      ) : null}
      {selected ? <ExportPanel kind="program_revision" target={selected.id} /> : null}
      </details>

      <Dialog open={editOpen} title={t('program.edit.title')} onClose={() => setEditOpen(false)} footer={<><Button onClick={() => setEditOpen(false)}>{t('action.cancel')}</Button><Button variant="primary" busy={update.isPending} disabled={!name.trim() || !budget.trim()} onClick={() => update.mutate()}>{t('program.edit.save')}</Button></>}>
        <p className="pg-muted">{t('program.edit.desc')}</p>
        <div className="scn-form">
          <Field label={t('program.field.name')} required>{({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={name} onChange={(event) => setName(event.target.value)} />}</Field>
          <Field label={t('program.field.budget')} required>{({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} inputMode="decimal" value={budget} onChange={(event) => setBudget(event.target.value)} />}</Field>
          <Field label={t('program.field.water')}>{({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} inputMode="decimal" value={water} onChange={(event) => setWater(event.target.value)} />}</Field>
          <Field label={t('program.field.crew')}>{({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} inputMode="numeric" value={crew} onChange={(event) => setCrew(event.target.value)} />}</Field>
          <Field label={t('program.field.visits')}>{({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} inputMode="numeric" value={visits} onChange={(event) => setVisits(event.target.value)} />}</Field>
          <Field label={t('program.field.careBudget')}>{({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} inputMode="decimal" value={careBudget} onChange={(event) => setCareBudget(event.target.value)} />}</Field>
          {update.isError ? <ApiErrorView compact error={update.error} /> : null}
        </div>
      </Dialog>
      <Dialog open={transitionTarget !== null} title={transitionTarget ? t(`transition.to.${transitionTarget}` as AppKey) : ''} onClose={() => setTransitionTarget(null)} footer={<><Button onClick={() => setTransitionTarget(null)}>{t('action.cancel')}</Button><Button variant="primary" busy={transition.isPending} disabled={reason.trim().length < 3} onClick={() => transition.mutate()}>{t('transition.confirm')}</Button></>}>
        <p>{current.current_revision_id ? 'Подтвердите перевод текущего результата программы на следующий этап.' : 'Сначала выполните оптимизацию программы.'}</p>
        <Field label={t('transition.reason')} required hint={t('transition.reason.hint')}>{({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={reason} onChange={(event) => setReason(event.target.value)} />}</Field>
        {transition.isError ? <ApiErrorView compact error={transition.error} /> : null}
      </Dialog>
    </Card>
  );
}
