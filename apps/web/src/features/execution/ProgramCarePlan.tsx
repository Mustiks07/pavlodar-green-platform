import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import {
  unwrap,
  type CalculationSnapshot,
  type CareOperation,
  type Program,
  type ProgramRevision,
  type Scenario,
  type ScenarioRevision,
  type Zone,
} from '@pg/api-client';
import { Badge, formatNumber, Icon, Select, Skeleton, StateView, UnitText } from '@pg/ui';
import { api } from '../../api';
import { ApiErrorView } from '../../shell/ApiErrorView';

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

type PlannedOperation = CareOperation & {
  snapshotId: string;
  scenarioId: string | null;
  scenarioRevisionId: string;
  scenarioName: string;
  zoneName: string;
};

type Period = {
  key: string;
  year: number;
  month: number;
  operations: PlannedOperation[];
  water: number;
  crew: number;
  visits: number;
};

type LaunchPassportProject = {
  id: string;
  scenarioId: string | null;
  scenarioName: string;
  zoneName: string;
  operations: number;
  water: number;
  crew: number;
  visits: number;
  firstYear: number;
  firstMonth: number;
};

/** Frozen care operations from the exact calculation snapshots selected by ProgramRevision. */
export function ProgramCarePlan({ cityId }: { cityId: string }) {
  const [params, setParams] = useSearchParams();
  const programs = useQuery({
    queryKey: ['execution-programs', cityId],
    queryFn: async ({ signal }) => (
      await unwrap(api.GET('/v1/programs', { params: { query: { city_id: cityId, limit: 100 } }, signal }))
    ).data.items as Program[],
  });
  const readyPrograms = (programs.data ?? []).filter((item) => item.current_revision_id);
  const requestedProgramId = params.get('program');
  const program = readyPrograms.find((item) => item.id === requestedProgramId) ?? readyPrograms[0] ?? null;
  const requestedRevisionId = requestedProgramId === program?.id ? params.get('programRevision') : null;
  const revisionId = requestedRevisionId ?? program?.current_revision_id ?? null;
  const revision = useQuery({
    queryKey: ['execution-program-revision', program?.id ?? '', revisionId ?? ''],
    enabled: Boolean(program && revisionId),
    queryFn: async ({ signal }) => (
      await unwrap<ProgramRevision>(
        api.GET('/v1/program-revisions/{revision_id}', {
          params: { path: { revision_id: revisionId! } },
          signal,
        }),
      )
    ).data,
  });
  const snapshots = useQueries({
    queries: (revision.data?.calculation_snapshot_ids ?? []).map((id) => ({
      queryKey: ['execution-program-calculation', id],
      queryFn: async ({ signal }: { signal: AbortSignal }) => (
        await unwrap<CalculationSnapshot>(api.GET('/v1/calculations/{calculation_id}', { params: { path: { calculation_id: id } }, signal }))
      ).data,
      staleTime: Infinity,
    })),
  });
  const selectedRevisionIds = new Set(revision.data?.selected_scenario_revision_ids ?? []);
  const snapshotValues = snapshots
    .flatMap((query) => query.data ? [query.data] : [])
    .filter((snapshot) => selectedRevisionIds.has(snapshot.scenario_revision_id));
  const scenarioRevisions = useQueries({
    queries: snapshotValues.map((snapshot) => ({
      queryKey: ['execution-program-scenario-revision', snapshot.scenario_revision_id],
      queryFn: async ({ signal }: { signal: AbortSignal }) => (
        await unwrap<ScenarioRevision>(api.GET('/v1/scenario-revisions/{revision_id}', { params: { path: { revision_id: snapshot.scenario_revision_id } }, signal }))
      ).data,
      staleTime: Infinity,
    })),
  });
  const scenarios = useQuery({
    queryKey: ['execution-program-scenarios', cityId],
    enabled: Boolean(revision.data),
    queryFn: async ({ signal }) => (
      await unwrap(api.GET('/v1/scenarios', { params: { query: { city_id: cityId, limit: 200 } }, signal }))
    ).data.items as Scenario[],
  });
  const zones = useQuery({
    queryKey: ['execution-program-zones', cityId],
    enabled: Boolean(revision.data),
    queryFn: async ({ signal }) => (
      await unwrap(api.GET('/v1/zones', { params: { query: { city_id: cityId, limit: 200 } }, signal }))
    ).data.items as Zone[],
  });
  const scenarioById = useMemo(() => new Map((scenarios.data ?? []).map((item) => [item.id, item])), [scenarios.data]);
  const zoneById = useMemo(() => new Map((zones.data ?? []).map((item) => [item.id, item])), [zones.data]);
  const operations = useMemo(() => snapshotValues.flatMap((snapshot, index): PlannedOperation[] => {
    const scenarioRevision = scenarioRevisions[index]?.data;
    const scenario = scenarioRevision ? scenarioById.get(scenarioRevision.scenario_id) : null;
    const zone = scenario ? zoneById.get(scenario.zone_id) : null;
    return snapshot.care.map((operation) => ({
      ...operation,
      snapshotId: snapshot.id,
      scenarioId: scenario?.id ?? null,
      scenarioRevisionId: snapshot.scenario_revision_id,
      scenarioName: scenario?.name ?? 'Проект участка',
      zoneName: zone?.name ?? 'Участок программы',
    }));
  }), [scenarioById, scenarioRevisions, snapshotValues, zoneById]);
  const periods = useMemo(() => {
    const grouped = new Map<string, Period>();
    for (const operation of operations) {
      const key = `${operation.year_offset}:${operation.month}`;
      const period = grouped.get(key) ?? {
        key,
        year: operation.year_offset + 1,
        month: operation.month,
        operations: [],
        water: 0,
        crew: 0,
        visits: 0,
      };
      period.operations.push(operation);
      period.water += operation.water_m3;
      period.crew += operation.crew_minutes;
      period.visits += operation.visits;
      grouped.set(key, period);
    }
    return [...grouped.values()].sort((left, right) => left.year - right.year || left.month - right.month);
  }, [operations]);
  const totals = useMemo(() => operations.reduce((sum, operation) => ({
    water: sum.water + operation.water_m3,
    crew: sum.crew + operation.crew_minutes,
    visits: sum.visits + operation.visits,
  }), { water: 0, crew: 0, visits: 0 }), [operations]);
  const launchPassport = useMemo(() => {
    const projects = new Map<string, LaunchPassportProject>();
    for (const operation of operations) {
      const periodIndex = operation.year_offset * 12 + operation.month;
      const current = projects.get(operation.scenarioRevisionId);
      if (!current) {
        projects.set(operation.scenarioRevisionId, {
          id: operation.scenarioRevisionId,
          scenarioId: operation.scenarioId,
          scenarioName: operation.scenarioName,
          zoneName: operation.zoneName,
          operations: 1,
          water: operation.water_m3,
          crew: operation.crew_minutes,
          visits: operation.visits,
          firstYear: operation.year_offset + 1,
          firstMonth: operation.month,
        });
        continue;
      }
      current.operations += 1;
      current.water += operation.water_m3;
      current.crew += operation.crew_minutes;
      current.visits += operation.visits;
      const currentPeriodIndex = (current.firstYear - 1) * 12 + current.firstMonth;
      if (periodIndex < currentPeriodIndex) {
        current.firstYear = operation.year_offset + 1;
        current.firstMonth = operation.month;
      }
    }
    return [...projects.values()].sort((left, right) => left.zoneName.localeCompare(right.zoneName, 'ru'));
  }, [operations]);
  const pending = programs.isPending || revision.isPending || snapshots.some((query) => query.isPending)
    || scenarioRevisions.some((query) => query.isPending) || scenarios.isPending || zones.isPending;
  const failed = [programs, revision, scenarios, zones, ...snapshots, ...scenarioRevisions].find((query) => query.isError);

  if (programs.isPending) return <Skeleton lines={5} />;
  if (programs.isError) return <ApiErrorView error={programs.error} onRetry={() => void programs.refetch()} />;
  if (!program) {
    return <StateView state="empty" title="Сначала рассчитайте городскую программу" description="После оптимизации здесь появится единый календарь ухода по выбранным участкам." actions={<Link className="pg-btn pg-btn--primary" to={`/program?city=${cityId}`}>Открыть городскую программу</Link>} />;
  }
  return (
    <section className="program-care-plan" aria-labelledby="program-care-plan-title">
      <header>
        <span>
          <small>Расчётный план · ещё не передан в работу</small>
          <h2 id="program-care-plan-title">Уход за выбранной программой</h2>
          <p>Точный календарь из сохранённых расчётов проектов, вошедших в оптимальный портфель.</p>
        </span>
        <div className="program-care-plan__pick">
          <label htmlFor="execution-program">Программа</label>
          <Select id="execution-program" value={program.id} onChange={(event) => {
            const next = new URLSearchParams(params);
            next.set('program', event.target.value);
            next.delete('programRevision');
            setParams(next, { replace: true });
          }}>
            {readyPrograms.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </Select>
        </div>
      </header>
      {failed ? <ApiErrorView compact error={failed.error} /> : pending ? <Skeleton lines={5} /> : revision.data && operations.length ? (
        <>
          <div className="program-care-plan__metrics">
            <article><Icon name="sprout" size={20} /><span><strong>{revision.data.selected_scenario_revision_ids.length}</strong><small>проекта в портфеле</small></span></article>
            <article><Icon name="calendar" size={20} /><span><strong>{operations.length}</strong><small>операций ухода</small></span></article>
            <article><Icon name="flask" size={20} /><span><strong>{formatNumber(totals.water, 1)} м³</strong><small>воды по плану</small></span></article>
            <article><Icon name="clock" size={20} /><span><strong>{formatNumber(totals.crew / 60, 1)} ч</strong><small>работы бригад</small></span></article>
            <article><Icon name="map" size={20} /><span><strong>{formatNumber(totals.visits, 0)}</strong><small>плановых выездов</small></span></article>
          </div>
          <section className="program-launch-passport" aria-labelledby="program-launch-passport-title">
            <header>
              <span>
                <small>Очередь передачи в работу</small>
                <h3 id="program-launch-passport-title">Три проекта готовы к внутреннему согласованию</h3>
              </span>
              <Badge tone="warning">Ожидают утверждения</Badge>
            </header>
            <div className="program-launch-passport__grid">
              {launchPassport.map((project) => (
                <article key={project.id}>
                  <header>
                    <span className="program-launch-passport__icon" aria-hidden="true"><Icon name="sprout" size={19} /></span>
                    <span><small>{project.zoneName}</small><strong>{project.scenarioName}</strong></span>
                  </header>
                  <dl>
                    <div><dt>Операции</dt><dd>{formatNumber(project.operations, 0)}</dd></div>
                    <div><dt>Вода</dt><dd>{formatNumber(project.water, 1)} м³</dd></div>
                    <div><dt>Работа бригады</dt><dd>{formatNumber(project.crew / 60, 1)} ч</dd></div>
                    <div><dt>Выезды</dt><dd>{formatNumber(project.visits, 0)}</dd></div>
                  </dl>
                  <footer>
                    <div>
                      <span><Icon name="calendar" size={16} /> Ближайший период</span>
                      <strong>{MONTHS[project.firstMonth - 1]} · {project.firstYear}-й год</strong>
                    </div>
                    {project.scenarioId ? (
                      <Link className="pg-btn pg-btn--secondary pg-btn--sm" to={`/projects/${project.scenarioId}?city=${cityId}&revision=${project.id}`}>
                        Открыть проект и согласовать
                      </Link>
                    ) : null}
                  </footer>
                </article>
              ))}
            </div>
          </section>
          <div className="program-care-plan__timeline">
            {periods.map((period) => (
              <article key={period.key}>
                <header>
                  <span><small>{period.year}-й год</small><strong>{MONTHS[period.month - 1]}</strong></span>
                  <Badge tone="accent">{period.operations.length} операций</Badge>
                </header>
                <div className="program-care-plan__period-total">
                  <span>{formatNumber(period.water, 1)} м³ воды</span>
                  <span>{formatNumber(period.crew / 60, 1)} ч</span>
                  <span>{formatNumber(period.visits, 0)} выезд.</span>
                </div>
                <ul>
                  {period.operations.map((operation) => (
                    <li key={`${operation.snapshotId}:${operation.id}`}>
                      <span><small>{operation.zoneName}</small><strong>{operation.operation}</strong><em>{operation.scenarioName}</em></span>
                      <b>{formatNumber(operation.quantity, 1)} <UnitText unit={operation.unit} /></b>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
          <footer>
            <span><Icon name="lock" size={17} /> Календарь связан с точной сохранённой версией программы. Наряды появятся только после утверждения проектов.</span>
            <Link className="pg-btn pg-btn--secondary pg-btn--sm" to={`/program?city=${cityId}&program=${program.id}&revision=${revision.data.id}`}>Вернуться к портфелю</Link>
          </footer>
        </>
      ) : (
        <StateView compact state="empty" title="В выбранных расчётах нет календаря ухода" description="Платформа не подставляет примерные операции: календарь появится после серверного расчёта ухода." />
      )}
    </section>
  );
}
