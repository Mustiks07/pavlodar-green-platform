import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, unwrap, type CalculationSnapshot, type CareOperation, type Plant, type ScenarioRevision } from '@pg/api-client';
import { Badge, Button, CostBreakdown, formatDateTime, formatNumber, Icon, MetricValue, MoneyText, Notice, Skeleton, StateView, SurvivalStrip, UnitText } from '@pg/ui';
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
 * operations and ecosystem metrics. The compact header only exposes the min/max of the returned
 * one-year probabilities; no aggregate probability is invented. An incomplete total stays unknown,
 * partial results say so, and only blocking warnings are listed (presentation policy).
 */
export function SnapshotView({ snapshot, timeZone, compact = false }: { snapshot: CalculationSnapshot; timeZone?: string; compact?: boolean }) {
  const [showAllSurvival, setShowAllSurvival] = useState(false);
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
  const yearOneProbabilities = snapshot.survival
    .map((result) => result.points.find((point) => point.year === 1)?.probability)
    .filter((value): value is number => value !== null && value !== undefined);
  const yearOneMin = yearOneProbabilities.length ? Math.min(...yearOneProbabilities) : null;
  const yearOneMax = yearOneProbabilities.length ? Math.max(...yearOneProbabilities) : null;
  const yearOneRange = yearOneMin === null || yearOneMax === null
    ? '—'
    : yearOneMin === yearOneMax
      ? `${formatNumber(yearOneMin * 100, 0)}%`
      : `${formatNumber(yearOneMin * 100, 0)}–${formatNumber(yearOneMax * 100, 0)}%`;
  const calendar = careCalendar(snapshot.care);
  const moduleReason = (patterns: RegExp) => snapshot.warnings.find((item) => patterns.test(`${item.code} ${item.message}`))?.message;
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
          <article><small>Приживаемость через 1 год</small><strong>{yearOneRange}</strong><span>{yearOneProbabilities.length ? `диапазон по ${yearOneProbabilities.length} группам` : 'прогноз ещё не рассчитан'}</span></article>
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
      <details className={`calc-story__report${compact ? ' is-compact' : ''}`} open={!compact}>
      <summary>Открыть полный расчёт: смета, приживаемость, уход и экологический эффект</summary>
      <div className="calc-story__report-body">
      <h3>{t('scenario.calc.lines')}</h3>
      <CostBreakdown cost={snapshot.cost} compact />
      <section className="calc-story__section">
        <header><small>Прогноз</small><h3>{t('calc.survival')}</h3><p>Вероятность сохранения исходной когорты через один, два и три года.</p></header>
        {snapshot.survival.length ? (
          <>
          {snapshot.survival.slice(0, showAllSurvival ? undefined : SURVIVAL_SHOWN).map((r) => (
            <SurvivalStrip key={r.placement_id} result={r} synthetic={snapshot.synthetic_inputs} title={placementNames.get(r.placement_id) ?? 'Группа посадок'} />
          ))}
          {snapshot.survival.length > SURVIVAL_SHOWN ? (
            <Button size="sm" variant="secondary" onClick={() => setShowAllSurvival((value) => !value)}>
              {showAllSurvival ? 'Показать основные группы' : `Показать все группы (${snapshot.survival.length})`}
            </Button>
          ) : null}
          </>
        ) : <CalculationModuleEmpty text={moduleReason(/survival|приживаем/i) ?? 'Для прогноза приживаемости нужны допустимая модель и входные данные проекта.'} />}
      </section>
      <section className="calc-story__section">
        <header><small>Календарь</small><h3>{t('calc.care')}</h3><p>Месяцы работ, потребность в воде и количество выездов бригады.</p></header>
        {snapshot.care.length ? (
          <>
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
          </>
        ) : <CalculationModuleEmpty text={moduleReason(/care|уход/i) ?? 'Для календаря ухода нужны закреплённые операции, нормы и горизонт планирования.'} />}
      </section>
      <section className="calc-story__section">
        <header><small>Эффект во времени</small><h3>{t('calc.ecosystem')}</h3><p>Одинаковый набор показателей на горизонтах 5, 10 и 20 лет.</p></header>
        {snapshot.ecosystem.length ? (
          <div className="ecosystem-horizons">
            {ecosystemHorizons.map((horizon) => (
              <section key={horizon}>
                <header><strong>{horizon} лет</strong><span>{snapshot.ecosystem.filter((metric) => metric.horizon_year === horizon && metric.value !== null).length} из {snapshot.ecosystem.filter((metric) => metric.horizon_year === horizon).length} рассчитано</span></header>
                <div>{snapshot.ecosystem.filter((metric) => metric.horizon_year === horizon).map((metric) => <MetricValue key={`${metric.key}:${horizon}`} label={metricLabel(metric.key)} metric={metric} detailed={false} />)}</div>
              </section>
            ))}
          </div>
        ) : <CalculationModuleEmpty text={moduleReason(/ecosystem|ecolog|эколог/i) ?? 'Для экологического эффекта нужен утверждённый профиль коэффициентов.'} />}
      </section>
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
      </details>
    </div>
  );
}

function CalculationModuleEmpty({ text }: { text: string }) {
  return (
    <div className="calc-story__empty">
      <Icon name="clock" size={20} />
      <span><strong>Результат пока не рассчитан</strong><small>{text}</small></span>
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

export function SnapshotById({ id, timeZone, compact = false }: { id: string; timeZone?: string; compact?: boolean }) {
  const { available, query } = useCalculation(id);
  if (available === false) return <OperationUnavailable compact operationId="getCalculation" />;
  if (query.isPending) return <Skeleton lines={4} />;
  if (query.isError) {
    if (query.error instanceof ApiError && query.error.category === 'not_found') {
      return <StateView compact state="not_found" title={t('calc.notFound')} description={t('calc.notFound.desc')} />;
    }
    return <ApiErrorView compact error={query.error} onRetry={() => void query.refetch()} />;
  }
  return <SnapshotView snapshot={query.data} timeZone={timeZone} compact={compact} />;
}
