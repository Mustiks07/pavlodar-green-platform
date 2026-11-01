import { useQuery } from '@tanstack/react-query';
import { ApiError, unwrap, type CalculationSnapshot, type CareOperation, type Plant, type ScenarioRevision } from '@pg/api-client';
import { Badge, CostBreakdown, formatDateTime, formatNumber, MetricValue, MoneyText, Notice, Skeleton, StateView, SurvivalStrip, UnitText } from '@pg/ui';
import { api, useOperationAvailable } from '../../api';
import { t } from '../../i18n';
import { ApiErrorView } from '../../shell/ApiErrorView';
import { OperationUnavailable } from '../../shell/OperationUnavailable';
import { metricLabel } from '../zones/ZoneCard';
import { ExportPanel } from '../exports/ExportPanel';
import './CalculationStory.css';

const SURVIVAL_SHOWN = 5;
const MONTHS = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];

export function careCalendar(operations: CareOperation[]) {
  return MONTHS.map((name, index) => ({ name, month: index + 1, operations: operations.filter((item) => item.month === index + 1) }));
}

/**
 * A server CalculationSnapshot exactly as returned: cost breakdown, survival per placement, care
 * operations and ecosystem metrics. Nothing is summed or derived here; an incomplete total stays
 * unknown, partial results say so, and only blocking warnings are listed (presentation policy).
 */
export function SnapshotView({ snapshot, timeZone }: { snapshot: CalculationSnapshot; timeZone?: string }) {
  const gaps = snapshot.warnings.filter((g) => g.blocking);
  const revision = useQuery({
    queryKey: ['calculation-story-revision', snapshot.scenario_revision_id],
    staleTime: Infinity,
    queryFn: async ({ signal }) => (
      await unwrap<ScenarioRevision>(api.GET('/v1/scenario-revisions/{revision_id}', { params: { path: { revision_id: snapshot.scenario_revision_id } }, signal }))
    ).data,
  });
  const plants = useQuery({
    queryKey: ['calculation-story-plants'],
    enabled: snapshot.survival.length > 0,
    staleTime: 60_000,
    queryFn: async ({ signal }) => (await unwrap(api.GET('/v1/plants', { params: { query: { limit: 200 } }, signal }))).data.items as Plant[],
  });
  const plantNames = new Map((plants.data ?? []).map((plant) => [plant.id, plant.russian_name]));
  const placementNames = new Map(
    (revision.data?.placements ?? []).map((placement, index) => [placement.id, plantNames.get(placement.plant_id) ?? `Группа посадок ${index + 1}`]),
  );
  const calendar = careCalendar(snapshot.care);
  const ecosystemHorizons = [...new Set(snapshot.ecosystem.map((metric) => metric.horizon_year).filter((value): value is number => value !== null))].sort((a, b) => a - b);
  return (
    <div className="scn-calculation__result calc-story" data-calculation-id={snapshot.id} data-status={snapshot.status}>
      <section className={`calc-story__hero is-${snapshot.status}`}>
        <header>
          <span>
            <small>Результат серверного расчёта</small>
            <h3>{snapshot.status === 'complete' ? 'Расчёт готов' : 'Доступна рассчитанная часть'}</h3>
            <p>{formatDateTime(snapshot.created_at, timeZone)}</p>
          </span>
          <Badge tone={snapshot.status === 'complete' ? 'positive' : 'warning'}>
            {t(snapshot.status === 'complete' ? 'scenario.calc.complete' : 'scenario.calc.partial')}
          </Badge>
        </header>
        <div className="calc-story__totals">
          <article><small>Известная стоимость</small><strong><MoneyText value={snapshot.cost.known_subtotal} /></strong><span>по доступным статьям</span></article>
          <article><small>Полная стоимость</small><strong>{snapshot.cost.status === 'complete' && snapshot.cost.total ? <MoneyText value={snapshot.cost.total} /> : '—'}</strong><span>{snapshot.cost.status === 'complete' ? 'все статьи учтены' : 'нужны недостающие расценки'}</span></article>
          <article><small>Горизонты анализа</small><strong>{snapshot.survival.length ? '1 · 2 · 3 года' : '—'}</strong><span>приживаемость посадок</span></article>
        </div>
        <details className="calc-story__technical">
          <summary>Техническая информация</summary>
          <dl>
            <dt>Расчётный снимок</dt><dd><code className="pg-code">{snapshot.id}</code></dd>
            <dt>Версия проекта</dt><dd><code className="pg-code">{snapshot.scenario_revision_id}</code></dd>
          </dl>
        </details>
      </section>
      {snapshot.is_stale ? (
        <Notice tone="warning" icon="clock" title={t('scenario.calc.stale')}>
          {t('scenario.calc.stale.desc')}
        </Notice>
      ) : null}
      <ExportPanel kind="calculation" target={snapshot.id} />
      <h3>{t('scenario.calc.lines')}</h3>
      <CostBreakdown cost={snapshot.cost} compact />
      {snapshot.survival.length ? (
        <section className="calc-story__section">
          <header><small>Прогноз</small><h3>{t('calc.survival')}</h3><p>Вероятность сохранения исходной когорты через один, два и три года.</p></header>
          {snapshot.survival.slice(0, SURVIVAL_SHOWN).map((r) => (
            <SurvivalStrip key={r.placement_id} result={r} synthetic={snapshot.synthetic_inputs} title={placementNames.get(r.placement_id) ?? 'Группа посадок'} />
          ))}
          {snapshot.survival.length > SURVIVAL_SHOWN ? <p className="pg-muted">{t('calc.more', { n: SURVIVAL_SHOWN, total: snapshot.survival.length })}</p> : null}
        </section>
      ) : null}
      {snapshot.care.length ? (
        <section className="calc-story__section">
          <header><small>Календарь</small><h3>{t('calc.care')}</h3><p>Месяцы работ, потребность в воде и количество выездов бригады.</p></header>
          <div className="care-calendar" role="list" aria-label="Календарь ухода по месяцам">
            {calendar.map((month) => (
              <article key={month.month} className={month.operations.length ? 'is-active' : undefined} role="listitem">
                <strong>{month.name}</strong>
                {month.operations.length ? <ul>{month.operations.map((operation) => (
                  <li key={operation.id}>
                    <span>{operation.operation}</span>
                    <small>{operation.year_offset + 1}-й год · {formatNumber(operation.water_m3, 2)} м³ · {operation.visits} выезд.</small>
                  </li>
                ))}</ul> : <span className="care-calendar__empty">—</span>}
              </article>
            ))}
          </div>
          <details className="calc-story__details">
            <summary>Полная таблица операций ({snapshot.care.length})</summary>
            <div className="calc-story__table-wrap"><table className="acc-table">
              <caption className="pg-sr-only">{t('calc.care')}</caption>
              <thead><tr><th scope="col">{t('calc.care.operation')}</th><th scope="col">{t('calc.care.when')}</th><th scope="col">{t('calc.care.quantity')}</th><th scope="col">Вода</th><th scope="col">Выезды</th></tr></thead>
              <tbody>{snapshot.care.map((c) => <tr key={c.id}><td>{c.operation}</td><td>{c.year_offset + 1}-й год, {MONTHS[c.month - 1]}</td><td>{formatNumber(c.quantity, 2)} <UnitText unit={c.unit} /></td><td>{formatNumber(c.water_m3, 2)} <UnitText unit="m3" /></td><td>{c.visits}</td></tr>)}</tbody>
            </table></div>
          </details>
        </section>
      ) : null}
      {snapshot.ecosystem.length ? (
        <section className="calc-story__section">
          <header><small>Эффект во времени</small><h3>{t('calc.ecosystem')}</h3><p>Одинаковый набор показателей на горизонтах 5, 10 и 20 лет.</p></header>
          <div className="ecosystem-horizons">
            {ecosystemHorizons.map((horizon) => (
              <section key={horizon}>
                <header><strong>{horizon} лет</strong><span>{snapshot.ecosystem.filter((metric) => metric.horizon_year === horizon && metric.value !== null).length} из {snapshot.ecosystem.filter((metric) => metric.horizon_year === horizon).length} рассчитано</span></header>
                <div>{snapshot.ecosystem.filter((metric) => metric.horizon_year === horizon).map((metric) => <MetricValue key={`${metric.key}:${horizon}`} label={metricLabel(metric.key)} metric={metric} detailed={false} />)}</div>
              </section>
            ))}
          </div>
        </section>
      ) : null}
      {gaps.length ? (
        <Notice tone="warning" icon="alert" title={t('scenario.calc.gaps')}>
          <ul className="pg-list">
            {gaps.map((item, index) => (
              <li key={`${item.code}-${index}`}>{item.message}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      <p className="pg-muted">
        {t('scenario.calc.manifest.desc')}{' '}
        <a href={snapshot.manifest_url} target="_blank" rel="noreferrer noopener">
          {t('scenario.calc.manifest')}
        </a>
      </p>
    </div>
  );
}

/** Canonical snapshot by id (getCalculation); 404 covers unknown and not visible. */
export function useCalculation(id: string | null) {
  const available = useOperationAvailable('getCalculation');
  return {
    available,
    query: useQuery({
      queryKey: ['calculation', id ?? ''],
      enabled: Boolean(id) && available !== false,
      // is_stale can change when a newer revision is saved; the rest is immutable.
      staleTime: 30_000,
      retry: (n, e) => n < 2 && !(e instanceof ApiError && e.status !== null && e.status < 500),
      queryFn: async ({ signal }) =>
        (await unwrap<CalculationSnapshot>(api.GET('/v1/calculations/{calculation_id}', { params: { path: { calculation_id: id! } }, signal }))).data,
    }),
  };
}

export function SnapshotById({ id, timeZone }: { id: string; timeZone?: string }) {
  const { available, query } = useCalculation(id);
  if (available === false) return <OperationUnavailable compact operationId="getCalculation" />;
  if (query.isPending) return <Skeleton lines={4} />;
  if (query.isError) {
    if (query.error instanceof ApiError && query.error.category === 'not_found') {
      return <StateView compact state="not_found" title={t('calc.notFound')} description={t('calc.notFound.desc')} />;
    }
    return <ApiErrorView compact error={query.error} onRetry={() => void query.refetch()} />;
  }
  return <SnapshotView snapshot={query.data} timeZone={timeZone} />;
}
