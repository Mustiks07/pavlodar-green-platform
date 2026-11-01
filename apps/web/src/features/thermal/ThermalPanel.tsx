import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import {
  newIdempotencyKey,
  unwrap,
  type Coefficient,
  type Dataset,
  type Job,
  type ScenarioRevision,
  type SpatialResult,
  type ThermalRequest,
} from '@pg/api-client';
import { Badge, Button, DataGapList, Field, Input, JobStatus, MetricValue, Select, Skeleton, StateView } from '@pg/ui';
import { api, useOperationAvailable } from '../../api';
import { ApiErrorView } from '../../shell/ApiErrorView';
import { OperationUnavailable } from '../../shell/OperationUnavailable';
import { useSession } from '../../shell/session';
import { useJob } from '../jobs/useJob';
import { useSpatialResult } from '../shadow/queries';
import { metricLabel } from '../zones/ZoneCard';
import { productLabel } from '../../productCopy';

const THERMAL_JOB = 'thermalJob';
const THERMAL_RESULT = 'thermal';

function ThermalResult({ id }: { id: string }) {
  const result = useSpatialResult(id);
  if (result.available === false) return <OperationUnavailable compact operationId="getSpatialResult" />;
  if (result.query.isPending) return <Skeleton lines={3} />;
  if (result.query.isError) return <ApiErrorView compact error={result.query.error} onRetry={() => void result.query.refetch()} />;
  const value: SpatialResult = result.query.data;
  return (
    <div className="shd-result">
      <Badge tone={value.status === 'complete' ? 'positive' : value.status === 'partial' ? 'warning' : 'neutral'}>
        {value.status === 'complete' ? 'Рассчитано' : value.status === 'partial' ? 'Частичный результат' : 'Нужны дополнительные входы'}
      </Badge>
      <div className="shd-metrics">
        {value.metrics.map((metric) => <MetricValue key={metric.key} label={metricLabel(metric.key)} metric={metric} detailed={false} />)}
      </div>
      {value.data_gaps.length ? <DataGapList gaps={value.data_gaps} /> : null}
    </div>
  );
}

export function ThermalSection({ revisionId, cityId, timeZone }: { revisionId: string; cityId: string; timeZone: string }) {
  const { user, hasRole } = useSession();
  const available = useOperationAvailable('startThermalRun');
  const [params, setParams] = useSearchParams();
  const [model, setModel] = useState<ThermalRequest['model']>('invest_air');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [weatherId, setWeatherId] = useState('');
  const [parameterId, setParameterId] = useState('');
  const jobId = params.get(THERMAL_JOB);
  const resultId = params.get(THERMAL_RESULT);
  const job = useJob(jobId);
  const qc = useQueryClient();
  const revision = useQuery({
    queryKey: ['thermal-revision', revisionId],
    queryFn: async ({ signal }) => (await unwrap<ScenarioRevision>(api.GET('/v1/scenario-revisions/{revision_id}', { params: { path: { revision_id: revisionId } }, signal }))).data,
  });

  const datasets = useQuery({
    queryKey: ['thermal-weather', cityId],
    queryFn: async ({ signal }) => {
      const page = await unwrap(api.GET('/v1/datasets', { params: { query: { city_id: cityId, limit: 200 } }, signal }));
      return page.data.items.filter((item: Dataset) => item.kind === 'weather' && item.current_version_id && revision.data?.dataset_version_ids.includes(item.current_version_id)) as Dataset[];
    },
    enabled: Boolean(revision.data),
  });
  const coefficients = useQuery({
    queryKey: ['thermal-parameters', cityId],
    queryFn: async ({ signal }) => {
      const page = await unwrap(api.GET('/v1/coefficients', { params: { query: { limit: 200 } }, signal }));
      return page.data.items.filter((item: Coefficient) => item.expert_status === 'approved' && item.version_id === revision.data?.coefficient_version_id) as Coefficient[];
    },
    enabled: Boolean(revision.data),
  });

  useEffect(() => {
    if (!weatherId && datasets.data?.[0]?.current_version_id) setWeatherId(datasets.data[0].current_version_id);
    if (!parameterId && coefficients.data?.[0]) setParameterId(coefficients.data[0].version_id);
  }, [datasets.data, coefficients.data, weatherId, parameterId]);

  const start = useMutation({
    mutationFn: async () => (
      await unwrap<Job>(
        api.POST('/v1/thermal-runs', {
          params: { header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': newIdempotencyKey() } },
          body: { scenario_revision_id: revisionId, model, weather_dataset_version_id: weatherId, parameter_version_id: parameterId, date },
        }),
      )
    ).data,
    onSuccess: (created) => {
      qc.setQueryData(['job', created.id], created);
      const next = new URLSearchParams(window.location.search);
      next.delete(THERMAL_RESULT);
      next.set(THERMAL_JOB, created.id);
      setParams(next, { replace: true });
    },
  });
  const done = job.data?.state === 'succeeded' ? job.data.result_ref_id : null;
  useEffect(() => {
    if (!done) return;
    const next = new URLSearchParams(window.location.search);
    next.delete(THERMAL_JOB);
    next.set(THERMAL_RESULT, done);
    setParams(next, { replace: true });
  }, [done, setParams]);

  if (!hasRole('specialist')) return <p className="pg-muted">Запуск доступен специалисту.</p>;
  if (available === false) return <OperationUnavailable compact operationId="startThermalRun" />;
  const active = job.data && ['queued', 'running', 'cancel_requested'].includes(job.data.state);
  const inputError = revision.error ?? datasets.error ?? coefficients.error;
  return (
    <section className="shd-section" aria-labelledby="thermal-heading">
      <h3 id="thermal-heading">Тепловой эффект</h3>
      <p className="pg-muted">Расчёт температуры воздуха или радиационного комфорта на закреплённых погодных данных и параметрах.</p>
      {resultId ? <ThermalResult id={resultId} /> : null}
      {inputError ? <ApiErrorView compact error={inputError} /> : null}
      {jobId && job.isPending ? <Skeleton lines={2} /> : null}
      {jobId && job.isError ? <ApiErrorView compact error={job.error} onRetry={() => void job.refetch()} /> : null}
      {job.data ? <JobStatus job={job.data} timeZone={timeZone} /> : null}
      {job.data?.state === 'failed' ? <StateView compact state="error" title="Тепловой расчёт не завершён" description="Проверьте выбранные входы и повторите запуск." /> : null}
      {!active ? (
        <div className="shd-form">
          <Field label="Модель">
            {({ id }) => <Select id={id} value={model} onChange={(event) => setModel(event.target.value as ThermalRequest['model'])}><option value="invest_air">InVEST Urban Cooling · температура воздуха</option><option value="solweig_tmrt">SOLWEIG · средняя радиационная температура</option></Select>}
          </Field>
          <Field label="Дата" required>{({ id }) => <Input id={id} type="date" value={date} onChange={(event) => setDate(event.target.value)} />}</Field>
          <Field label="Погодный набор" required>
            {({ id }) => <Select id={id} value={weatherId} onChange={(event) => setWeatherId(event.target.value)}><option value="">Выберите набор</option>{(datasets.data ?? []).map((item) => <option key={item.id} value={item.current_version_id ?? ''}>{productLabel(item.name)}</option>)}</Select>}
          </Field>
          <Field label="Версия параметров" required>
            {({ id }) => <Select id={id} value={parameterId} onChange={(event) => setParameterId(event.target.value)}><option value="">Выберите параметры</option>{(coefficients.data ?? []).map((item) => <option key={item.version_id} value={item.version_id}>{item.key} · {item.applicability}</option>)}</Select>}
          </Field>
          <Button variant="primary" icon="sun" busy={start.isPending} disabled={!date || !weatherId || !parameterId} onClick={() => start.mutate()}>Запустить тепловой расчёт</Button>
        </div>
      ) : null}
      {start.isError ? <ApiErrorView compact error={start.error} onRetry={() => start.mutate()} /> : null}
    </section>
  );
}
