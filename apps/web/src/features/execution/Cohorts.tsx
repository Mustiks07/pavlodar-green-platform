import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { newIdempotencyKey, unwrap, type CalculationSnapshot, type CalculationSnapshotPage, type City, type Cohort, type ForecastObservedResult, type Inspection, type ScenarioRevision, type WorkOrder } from '@pg/api-client';
import { Badge, Button, Card, DataGapList, Field, formatDate, formatDateTime, formatNumber, formatProbability, Input, Select, Skeleton, StateView } from '@pg/ui';
import { api, useOperationAvailable } from '../../api';
import { t } from '../../i18n';
import { ApiErrorView } from '../../shell/ApiErrorView';
import { OperationUnavailable } from '../../shell/OperationUnavailable';
import { useSession } from '../../shell/session';
import { isUuid } from '../map/publishedLayers';
import { todayIn, zonedIso } from '../shadow/queries';

const inspectionsKey = (cohortId: string) => ['inspections', cohortId] as const;

function useInspections(cohort: Cohort) {
  return useQuery({
    queryKey: inspectionsKey(cohort.id),
    queryFn: async ({ signal }) =>
      (await unwrap(api.GET('/v1/inspections', { params: { query: { city_id: cohort.city_id, cohort_id: cohort.id, limit: 200 } }, signal }))).data.items.sort((a: Inspection, b: Inspection) =>
        b.observed_at.localeCompare(a.observed_at),
      ),
  });
}

function InspectionForm({ cohort, timeZone }: { cohort: Cohort; timeZone: string }) {
  const { user } = useSession();
  const qc = useQueryClient();
  const [f, setF] = useState({ date: todayIn(timeZone), time: '10:00', alive: '', dead: '0', unknown: '0', method: '', note: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const int = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v) : null);
  const create = useMutation({
    mutationFn: async () =>
      unwrap<Inspection>(
        api.POST('/v1/inspections', {
          params: { header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': newIdempotencyKey() } },
          body: {
            city_id: cohort.city_id,
            zone_id: cohort.zone_id,
            cohort_id: cohort.id,
            observed_at: zonedIso(f.date, f.time, timeZone),
            alive_count: int(f.alive)!,
            dead_count: int(f.dead)!,
            unknown_count: int(f.unknown)!,
            method: f.method.trim(),
            note: f.note.trim(),
            source_refs: [],
          },
        }),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: inspectionsKey(cohort.id) });
      void qc.invalidateQueries({ queryKey: ['list', 'cohorts'] });
    },
  });
  const valid = [f.alive, f.dead, f.unknown].every((v) => int(v) !== null) && f.method.trim() && f.note.trim();
  return (
    <form
      className="exec-form"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <h4>{t('exec.inspection.add')}</h4>
      <p className="pg-muted">{t('exec.inspection.add.desc', { n: cohort.initial_quantity })}</p>
      <Field label={t('shadow.date')} required>
        {({ id }) => <Input id={id} type="date" value={f.date} onChange={set('date')} />}
      </Field>
      <Field label={t('shadow.time')} required>
        {({ id }) => <Input id={id} type="time" value={f.time} onChange={set('time')} />}
      </Field>
      <Field label={t('exec.inspection.alive')} required>
        {({ id }) => <Input id={id} inputMode="numeric" value={f.alive} onChange={set('alive')} />}
      </Field>
      <Field label={t('exec.inspection.dead')} required>
        {({ id }) => <Input id={id} inputMode="numeric" value={f.dead} onChange={set('dead')} />}
      </Field>
      <Field label={t('exec.inspection.unknown')} required>
        {({ id }) => <Input id={id} inputMode="numeric" value={f.unknown} onChange={set('unknown')} />}
      </Field>
      <Field label={t('exec.inspection.method')} required>
        {({ id }) => <Input id={id} value={f.method} onChange={set('method')} />}
      </Field>
      <Field label={t('exec.completion.note')} required>
        {({ id }) => <Input id={id} value={f.note} onChange={set('note')} />}
      </Field>
      <Button type="submit" variant="primary" busy={create.isPending} disabled={!valid}>
        {t('exec.inspection.save')}
      </Button>
      {create.isError ? <ApiErrorView compact error={create.error} /> : null}
    </form>
  );
}

function ReplacementForm({ cohort, timeZone }: { cohort: Cohort; timeZone: string }) {
  const { user } = useSession();
  const qc = useQueryClient();
  const orders = useQuery({
    queryKey: ['replacement-orders', cohort.zone_id],
    queryFn: async ({ signal }) =>
      (await unwrap(api.GET('/v1/work-orders', { params: { query: { city_id: cohort.city_id, zone_id: cohort.zone_id, status: 'completed', limit: 200 } }, signal }))).data.items.filter(
        (o: WorkOrder) => o.unit === 'piece' && o.id !== cohort.source_work_order_id,
      ),
  });
  // The replacement resolves to one placement of the source revision (its plant and quantity).
  const placements = useQuery({
    queryKey: ['cohort-revision-placements', cohort.source_work_order_id],
    queryFn: async ({ signal }) => {
      const order = (await unwrap<WorkOrder>(api.GET('/v1/work-orders/{work_order_id}', { params: { path: { work_order_id: cohort.source_work_order_id } }, signal }))).data;
      return (await unwrap<ScenarioRevision>(api.GET('/v1/scenario-revisions/{revision_id}', { params: { path: { revision_id: order.scenario_revision_id } }, signal }))).data.placements;
    },
  });
  const [f, setF] = useState({ order: '', placement: '', quantity: '', date: todayIn(timeZone), reason: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const chosen = placements.data?.find((p) => p.id === f.placement) ?? null;
  const create = useMutation({
    mutationFn: async () =>
      unwrap<Cohort>(
        api.POST('/v1/replacements', {
          params: { header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': newIdempotencyKey() } },
          body: { original_cohort_id: cohort.id, plant_id: chosen!.plant_id, quantity: Number(f.quantity), planting_date: f.date, reason: f.reason.trim(), work_order_id: f.order },
        }),
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['list', 'cohorts'] }),
  });
  return (
    <form
      className="exec-form"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <h4>{t('exec.replacement.add')}</h4>
      <p className="pg-muted">{t('exec.replacement.desc')}</p>
      {orders.isError ? <ApiErrorView compact error={orders.error} onRetry={() => void orders.refetch()} /> : null}
      <Field label={t('exec.replacement.order')} required>
        {({ id }) => (
          <Select id={id} value={f.order} onChange={set('order')} disabled={orders.isPending}>
            <option value="">{t('exec.replacement.order.choose')}</option>
            {(orders.data ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.operation} · {formatNumber(o.completed_quantity, 0)} {o.unit} · {o.id.slice(0, 8)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('exec.replacement.placement')} hint={t('exec.replacement.placement.hint')} required>
        {({ id, describedBy }) => (
          <Select
            id={id}
            aria-describedby={describedBy}
            value={f.placement}
            disabled={placements.isPending}
            onChange={(e) => {
              const p = placements.data?.find((x) => x.id === e.target.value);
              setF({ ...f, placement: e.target.value, quantity: p ? String(p.quantity) : f.quantity });
            }}
          >
            <option value="">{t('exec.cohort.placement.choose')}</option>
            {(placements.data ?? [])
              .filter((p) => p.id !== cohort.placement_id)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {t('exec.cohort.placement.option', { id: p.id.slice(0, 8), qty: p.quantity, date: formatDate(p.planting_date) ?? p.planting_date })}
                </option>
              ))}
          </Select>
        )}
      </Field>
      {placements.isError ? <ApiErrorView compact error={placements.error} onRetry={() => void placements.refetch()} /> : null}
      <Field label={t('exec.replacement.quantity')} required>
        {({ id }) => <Input id={id} inputMode="numeric" value={f.quantity} onChange={set('quantity')} />}
      </Field>
      <Field label={t('exec.cohort.planted')} required>
        {({ id }) => <Input id={id} type="date" value={f.date} onChange={set('date')} />}
      </Field>
      <Field label={t('grants.field.reason')} required>
        {({ id }) => <Input id={id} value={f.reason} onChange={set('reason')} />}
      </Field>
      <Button type="submit" busy={create.isPending} disabled={!f.order || !chosen || !/^\d+$/.test(f.quantity) || !f.reason.trim()}>
        {t('exec.replacement.save')}
      </Button>
      {create.isSuccess ? <p role="status" className="pg-muted">{t('exec.replacement.saved')}</p> : null}
      {create.isError ? <ApiErrorView compact error={create.error} /> : null}
    </form>
  );
}

/**
 * Calculation snapshots of exactly the revision the cohort was planted from (listCalculations,
 * contract 1.12.0): the cohort's source work order names that revision. Newest first.
 */
function useCohortSnapshots(cohort: Cohort) {
  const order = useQuery({
    queryKey: ['work-order', cohort.source_work_order_id],
    queryFn: async ({ signal }) => unwrap<WorkOrder>(api.GET('/v1/work-orders/{work_order_id}', { params: { path: { work_order_id: cohort.source_work_order_id } }, signal })),
  });
  const revisionId = order.data?.data.scenario_revision_id ?? null;
  const snapshots = useQuery({
    queryKey: ['calculations', revisionId],
    enabled: Boolean(revisionId),
    queryFn: async ({ signal }) => {
      const items: CalculationSnapshot[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const res = (
          await unwrap<CalculationSnapshotPage>(
            api.GET('/v1/calculations', { params: { query: { scenario_revision_id: revisionId!, limit: 200, ...(cursor ? { cursor } : {}) } }, signal }),
          )
        ).data;
        items.push(...res.items);
        if (!res.next_cursor) break;
        cursor = res.next_cursor;
      }
      return items.sort((a, b) => b.created_at.localeCompare(a.created_at));
    },
  });
  return { order, revisionId, snapshots };
}

/** Forecast of a calculation snapshot against an inspection: every number comes from the server. */
function ForecastObserved({ cohort, inspections }: { cohort: Cohort; inspections: Inspection[] }) {
  const { user } = useSession();
  const ok = useOperationAvailable('compareForecastObserved');
  const listOk = useOperationAvailable('listCalculations');
  const { order, revisionId, snapshots } = useCohortSnapshots(cohort);
  const [f, setF] = useState({ inspection: cohort.latest_inspection_id ?? '', calculation: '', horizon: '1' });
  // Until the user picks one, the newest snapshot of the revision is preselected (not run).
  const calculation = f.calculation || snapshots.data?.[0]?.id || '';
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const run = useMutation({
    mutationFn: async () =>
      (
        await unwrap<ForecastObservedResult>(
          api.POST('/v1/forecast-observed', {
            params: { header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': newIdempotencyKey() } },
            body: { cohort_id: cohort.id, calculation_id: calculation, inspection_id: f.inspection, horizon_year: Number(f.horizon) },
          }),
        )
      ).data,
  });
  if (ok === false) return <OperationUnavailable compact operationId="compareForecastObserved" />;
  const r = run.data;
  const blocking = r ? r.data_gaps.filter((g) => g.blocking) : [];
  return (
    <div className="exec-form">
      <h4>{t('exec.fo.title')}</h4>
      <p className="pg-muted">{t('exec.fo.desc')}</p>
      <Field label={t('exec.fo.inspection')} required>
        {({ id }) => (
          <Select id={id} value={f.inspection} onChange={set('inspection')}>
            <option value="">{t('exec.fo.inspection.choose')}</option>
            {inspections.map((i) => (
              <option key={i.id} value={i.id}>
                {formatDateTime(i.observed_at)} · {t('exec.inspection.counts', { alive: i.alive_count, dead: i.dead_count, unknown: i.unknown_count })}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {listOk === false ? (
        <OperationUnavailable compact operationId="listCalculations" />
      ) : order.isError || snapshots.isError ? (
        <ApiErrorView compact error={order.error ?? snapshots.error} onRetry={() => void (order.isError ? order.refetch() : snapshots.refetch())} />
      ) : order.isPending || (revisionId && snapshots.isPending) ? (
        <Skeleton lines={1} />
      ) : snapshots.data?.length ? (
        <Field label={t('exec.fo.calculation')} hint={t('exec.fo.calculation.hint', { revision: (revisionId ?? '').slice(0, 8) })} required>
          {({ id, describedBy }) => (
            <Select id={id} aria-describedby={describedBy} value={calculation} onChange={set('calculation')} data-revision-id={revisionId ?? ''}>
              {snapshots.data.map((s) => (
                <option key={s.id} value={s.id}>
                  {t('exec.fo.snapshot', { date: formatDateTime(s.created_at) ?? s.created_at, status: t(`exec.fo.snapshot.${s.status}`), id: s.id.slice(0, 8) })}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : (
        <StateView compact state="empty" title={t('exec.fo.noSnapshots')} description={t('exec.fo.noSnapshots.desc', { revision: (revisionId ?? '').slice(0, 8) })} />
      )}
      <Field label={t('exec.fo.horizon')} required>
        {({ id }) => (
          <Select id={id} value={f.horizon} onChange={set('horizon')}>
            {[1, 2, 3].map((y) => (
              <option key={y} value={y}>
                {t('exec.fo.year', { n: y })}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Button busy={run.isPending} disabled={!f.inspection || !isUuid(calculation)} onClick={() => run.mutate()}>
        {t('exec.fo.run')}
      </Button>
      {run.isError ? <ApiErrorView compact error={run.error} /> : null}
      {r ? (
        <div className="exec-fo" data-comparable={String(r.comparable)}>
          <Badge tone={r.comparable ? 'positive' : 'warning'}>{t(r.comparable ? 'exec.fo.comparable' : 'exec.fo.notComparable')}</Badge>
          <dl className="pg-dl">
            <dt>{t('exec.fo.forecast')}</dt>
            <dd>{r.forecast_probability === null ? <span className="pg-unknown">{t('compare.noData')}</span> : formatProbability(r.forecast_probability)}</dd>
            <dt>{t('exec.fo.expectedAlive')}</dt>
            <dd>{r.forecast_expected_alive === null ? <span className="pg-unknown">{t('compare.noData')}</span> : formatNumber(r.forecast_expected_alive, 2)}</dd>
            <dt>{t('exec.fo.observed')}</dt>
            <dd>{r.observed_survival_probability === null ? <span className="pg-unknown">{t('compare.noData')}</span> : formatProbability(r.observed_survival_probability)}</dd>
            <dt>{t('exec.fo.counts')}</dt>
            <dd>{t('exec.inspection.counts', { alive: r.observed_alive, dead: r.observed_dead, unknown: r.observed_unknown })}</dd>
            <dt>{t('exec.fo.coverage')}</dt>
            <dd>{formatProbability(r.observation_coverage)}</dd>
            <dt>{t('exec.fo.delta')}</dt>
            <dd>{r.probability_delta === null ? <span className="pg-unknown">{t('exec.fo.delta.none')}</span> : formatNumber(r.probability_delta, 3)}</dd>
            <dt>{t('exec.fo.offset')}</dt>
            <dd>{t('exec.fo.offset.value', { n: r.date_offset_days })}</dd>
            <dt>{t('exec.fo.method')}</dt>
            <dd>
              <code className="pg-code">{r.method_version}</code>
            </dd>
          </dl>
          {blocking.length ? <DataGapList gaps={blocking} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function CohortDetail({ cohort, timeZone, onClose }: { cohort: Cohort; timeZone: string; onClose: () => void }) {
  const { hasRole } = useSession();
  const inspections = useInspections(cohort);
  return (
    <Card title={t('exec.cohort.title', { id: cohort.id.slice(0, 8) })} actions={<Button variant="ghost" size="sm" icon="x" iconOnly aria-label={t('exec.close')} onClick={onClose} />}>
      <div className="exec-detail" data-cohort-id={cohort.id}>
        <dl className="pg-dl">
          <dt>{t('exec.cohort.initial')}</dt>
          <dd>{cohort.initial_quantity}</dd>
          <dt>{t('exec.cohort.planted')}</dt>
          <dd>{formatDate(cohort.planting_date)}</dd>
          <dt>{t('exec.cohort.placement')}</dt>
          <dd>
            <code className="pg-code">{cohort.placement_id.slice(0, 8)}</code>
          </dd>
          <dt>{t('exec.cohort.source')}</dt>
          <dd>
            <code className="pg-code">{cohort.source_work_order_id.slice(0, 8)}</code>
          </dd>
          {cohort.replaces_cohort_id ? (
            <>
              <dt>{t('exec.cohort.replaces')}</dt>
              <dd>
                <code className="pg-code">{cohort.replaces_cohort_id.slice(0, 8)}</code>
              </dd>
            </>
          ) : null}
        </dl>
        <h4>{t('exec.inspections')}</h4>
        {inspections.isPending ? (
          <Skeleton lines={2} />
        ) : inspections.isError ? (
          <ApiErrorView compact error={inspections.error} onRetry={() => void inspections.refetch()} />
        ) : inspections.data.length === 0 ? (
          <p className="pg-muted">{t('exec.inspections.empty')}</p>
        ) : (
          <ul className="exec-inspections">
            {inspections.data.map((i) => (
              <li key={i.id} data-inspection-id={i.id}>
                {i.id === cohort.latest_inspection_id ? <Badge tone="accent">{t('exec.inspection.latest')}</Badge> : null} {formatDateTime(i.observed_at, timeZone)} ·{' '}
                {t('exec.inspection.counts', { alive: i.alive_count, dead: i.dead_count, unknown: i.unknown_count })} · {i.method}
              </li>
            ))}
          </ul>
        )}
        {hasRole('specialist') ? (
          <>
            <InspectionForm cohort={cohort} timeZone={timeZone} />
            {!cohort.replaces_cohort_id ? <ReplacementForm cohort={cohort} timeZone={timeZone} /> : null}
            <ForecastObserved cohort={cohort} inspections={inspections.data ?? []} />
          </>
        ) : null}
      </div>
    </Card>
  );
}

/** Cohorts of the city with their lineage; selecting one opens inspections and comparisons. */
export function CohortsPanel({ city, selected, onSelect }: { city: City; selected: string | null; onSelect: (id: string | null) => void }) {
  const ok = useOperationAvailable('listCohorts');
  const cohorts = useQuery({
    queryKey: ['list', 'cohorts', city.id],
    enabled: ok !== false,
    queryFn: async ({ signal }) => (await unwrap(api.GET('/v1/cohorts', { params: { query: { city_id: city.id, limit: 200 } }, signal }))).data.items,
  });
  if (ok === false) return <OperationUnavailable compact operationId="listCohorts" />;
  if (cohorts.isPending) return <Skeleton lines={3} />;
  if (cohorts.isError) return <ApiErrorView compact error={cohorts.error} onRetry={() => void cohorts.refetch()} />;
  const current = cohorts.data.find((c) => c.id === selected) ?? null;
  return (
    <div className={current ? 'app-split is-open' : 'app-split'}>
      {cohorts.data.length === 0 ? (
        <StateView compact state="empty" title={t('exec.cohorts.empty')} description={t('exec.cohorts.empty.desc')} />
      ) : (
        <table className="acc-table exec-cohorts">
          <caption className="pg-sr-only">{t('exec.cohorts')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('exec.cohort.title', { id: '' })}</th>
              <th scope="col">{t('exec.cohort.initial')}</th>
              <th scope="col">{t('exec.cohort.planted')}</th>
              <th scope="col">{t('exec.cohort.lineage')}</th>
            </tr>
          </thead>
          <tbody>
            {cohorts.data.map((c) => (
              <tr key={c.id} className={c.id === selected ? 'is-selected' : undefined}>
                <td>
                  <button type="button" className="pg-link-button" onClick={() => onSelect(c.id)}>
                    <code className="pg-code">{c.id.slice(0, 8)}</code>
                  </button>
                </td>
                <td>{c.initial_quantity}</td>
                <td>{formatDate(c.planting_date)}</td>
                <td>{c.replaces_cohort_id ? t('exec.cohort.replacementOf', { id: c.replaces_cohort_id.slice(0, 8) }) : t('exec.cohort.original')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {current ? <CohortDetail key={current.id} cohort={current} timeZone={city.timezone} onClose={() => onSelect(null)} /> : null}
    </div>
  );
}
