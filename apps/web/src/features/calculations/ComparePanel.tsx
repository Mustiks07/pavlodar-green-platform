import { useEffect, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError, newIdempotencyKey, problemCodeEntry, unwrap, type CalculationSnapshot, type City, type CompareResult, type Metric, type Scenario } from '@pg/api-client';
import { Badge, Button, formatDateTime, formatNumber, MoneyText, Notice, Skeleton, StateView, UnitText } from '@pg/ui';
import { api, useOperationAvailable } from '../../api';
import { t, type AppKey } from '../../i18n';
import { ApiErrorView } from '../../shell/ApiErrorView';
import { OperationUnavailable } from '../../shell/OperationUnavailable';
import { useSession } from '../../shell/session';
import { metricLabel } from '../zones/ZoneCard';
import { CALC_RESULT } from './FullCalculation';
import { useZones } from '../zones/queries';

/** Selected revisions live in the URL (?revisions=a,b[,c]) so a comparison can be reloaded and shared. */
const PARAM = 'revisions';
const MAX = 3;

function useCityScenarios(cityId: string) {
  return useQuery({
    queryKey: ['compare-scenarios', cityId],
    queryFn: async ({ signal }) => {
      const items: Scenario[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 10; i++) {
        const page = (await unwrap(api.GET('/v1/scenarios', { params: { query: { city_id: cityId, cursor, limit: 200 } }, signal }))).data;
        items.push(...page.items);
        if (!page.next_cursor) break;
        cursor = page.next_cursor;
      }
      return items;
    },
  });
}

/** One row of ecosystem metrics across snapshots: same key and horizon; units must agree. */
interface MetricRow {
  id: string;
  key: string;
  horizon: number | null;
  cells: (Metric | null)[];
  unitsDiffer: boolean;
}

function metricRows(snapshots: CalculationSnapshot[]): MetricRow[] {
  const ids = new Map<string, { key: string; horizon: number | null }>();
  for (const s of snapshots) for (const m of s.ecosystem) ids.set(`${m.key}@${m.horizon_year ?? 'now'}`, { key: m.key, horizon: m.horizon_year });
  return [...ids.entries()].map(([id, { key, horizon }]) => {
    const cells = snapshots.map((s) => s.ecosystem.find((m) => m.key === key && (m.horizon_year ?? null) === horizon) ?? null);
    const units = new Set(cells.filter((c): c is Metric => c !== null).map((c) => c.unit));
    return { id, key, horizon, cells, unitsDiffer: units.size > 1 };
  });
}

function MetricCell({ m }: { m: Metric | null }) {
  if (!m) return <span className="pg-unknown">{t('compare.notCalculated')}</span>;
  if (m.value === null || m.status === 'unavailable') return <span className="pg-unknown">{t('compare.noData')}</span>;
  return (
    <>
      {formatNumber(m.value, 2)} <UnitText unit={m.unit} />
    </>
  );
}

function SnapshotSummary({ snapshot, scenario, city, zoneName }: { snapshot: CalculationSnapshot; scenario: Scenario | undefined; city: City; zoneName: string }) {
  const knownCost = snapshot.cost.status === 'complete' || Number(snapshot.cost.known_subtotal) > 0;
  const careMonths = [...new Set(snapshot.care.map((item) => item.month))].sort((a, b) => a - b);
  const impactHorizon = Math.max(0, ...snapshot.ecosystem.map((item) => item.horizon_year ?? 0));
  const impact = snapshot.ecosystem.filter((item) => item.horizon_year === impactHorizon && item.value !== null).slice(0, 2);
  return (
    <article className="cmp-summary-card">
      <header>
        <span><small>{zoneName}</small><strong>{scenario?.name ?? 'Проект участка'}</strong></span>
        <Badge tone={snapshot.status === 'complete' ? 'positive' : 'warning'}>{t(snapshot.status === 'complete' ? 'scenario.calc.complete' : 'scenario.calc.partial')}</Badge>
      </header>
      <dl>
        <div><dt>Известная стоимость</dt><dd>{knownCost ? <MoneyText value={snapshot.cost.known_subtotal} /> : 'нужны расценки'}</dd></div>
        <div><dt>Календарь ухода</dt><dd>{careMonths.length ? `${careMonths.length} мес. работ` : 'ещё не рассчитан'}</dd></div>
        <div><dt>Приживаемость</dt><dd>{snapshot.survival.length ? `${snapshot.survival.length} групп посадок` : 'ещё не рассчитана'}</dd></div>
      </dl>
      {impact.length ? (
        <div className="cmp-summary-card__impact">
          <small>Эффект через {impactHorizon} лет</small>
          {impact.map((metric) => (
            <span key={`${metric.key}:${metric.horizon_year}`}><em>{metricLabel(metric.key)}</em><strong><MetricCell m={metric} /></strong></span>
          ))}
        </div>
      ) : <p className="cmp-summary-card__empty">Экологический эффект ещё не рассчитан</p>}
      {scenario ? <Link className="pg-btn pg-btn--secondary pg-btn--sm" to={`/projects/${scenario.id}?city=${city.id}&${CALC_RESULT}=${snapshot.id}`}>Открыть проект</Link> : null}
    </article>
  );
}

/**
 * Comparison of 2–3 scenario revisions through compareScenarios (ADR-027): the server picks each
 * revision's latest immutable CalculationSnapshot and returns them unchanged with comparability
 * warnings. The browser only lays them side by side: no differences, sums or conversions.
 */
export function ComparePanel({ city }: { city: City }) {
  const { user } = useSession();
  const available = useOperationAvailable('compareScenarios');
  const [params, setParams] = useSearchParams();
  const selected = useMemo(() => (params.get(PARAM) ?? '').split(',').filter(Boolean).slice(0, MAX), [params]);
  const scenarios = useCityScenarios(city.id);
  const zones = useZones(city.id);
  const zoneNames = useMemo(() => new Map((zones.data?.items ?? []).map((zone) => [zone.id, zone.name])), [zones.data]);
  const byRevision = useMemo(() => new Map((scenarios.data ?? []).map((s) => [s.current_revision_id, s])), [scenarios.data]);
  useEffect(() => {
    if (params.has(PARAM) || !scenarios.data || scenarios.data.length < 2) return;
    const byZone = new Map<string, Scenario[]>();
    for (const scenario of scenarios.data) {
      const group = byZone.get(scenario.zone_id) ?? [];
      group.push(scenario);
      byZone.set(scenario.zone_id, group);
    }
    const sameZone = [...byZone.values()].find((group) => group.length >= 2);
    const defaults = (sameZone ?? scenarios.data).slice(0, 2);
    const next = new URLSearchParams(params);
    next.set(PARAM, defaults.map((scenario) => scenario.current_revision_id).join(','));
    setParams(next, { replace: true });
  }, [params, scenarios.data, setParams]);
  const compare = useMutation({
    mutationFn: async (revisionIds: string[]) =>
      (
        await unwrap<CompareResult>(
          api.POST('/v1/comparisons', {
            params: { header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': newIdempotencyKey() } },
            body: { scenario_revision_ids: revisionIds },
          }),
        )
      ).data,
  });
  const key = selected.join(',');
  useEffect(() => {
    // A link or reload with 2–3 revisions compares them again (read-only request).
    if (selected.length >= 2 && available !== false) compare.mutate(selected);
  }, [key, available]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (revisionId: string, on: boolean) => {
    const next = on ? [...selected, revisionId].slice(0, MAX) : selected.filter((r) => r !== revisionId);
    const p = new URLSearchParams(params);
    if (next.length) p.set(PARAM, next.join(','));
    else p.delete(PARAM);
    setParams(p, { replace: true });
  };

  if (available === false) return <OperationUnavailable operationId="compareScenarios" />;
  const result = compare.data;
  const snapshots = result?.snapshots ?? [];
  const rows = metricRows(snapshots);
  const problem = compare.error instanceof ApiError ? compare.error.problem : null;
  return (
    <div className="cmp" data-compared={snapshots.map((s) => s.id).join(',') || undefined}>
      <section className="cmp-picker" aria-labelledby="cmp-pick-h">
        <div className="cmp-picker__head">
          <div>
            <h2 id="cmp-pick-h">{t('compare.pick')}</h2>
            <p className="pg-muted">{t('compare.pick.desc', { max: MAX })}</p>
          </div>
          <Badge tone={selected.length >= 2 ? 'positive' : 'neutral'}>{selected.length} / {MAX}</Badge>
        </div>
        {scenarios.isPending ? (
          <Skeleton lines={3} />
        ) : scenarios.isError ? (
          <ApiErrorView compact error={scenarios.error} onRetry={() => void scenarios.refetch()} />
        ) : scenarios.data.length === 0 ? (
          <StateView compact state="empty" title={t('page.compare.empty')} description={t('page.compare.empty.desc')} />
        ) : (
          <ul className="cmp-pick">
            {scenarios.data.map((s) => {
              const on = selected.includes(s.current_revision_id);
              return (
                <li key={s.id} className={on ? 'is-selected' : undefined}>
                  <label className="cmp-check">
                    <input type="checkbox" checked={on} disabled={!on && selected.length >= MAX} onChange={(e) => toggle(s.current_revision_id, e.target.checked)} />
                    <span>
                      <strong>{s.name}</strong>
                      <span className="cmp-check__revision">{zoneNames.get(s.zone_id) ?? t(`wf.${s.status}` as AppKey)}</span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {selected.length < 2 ? <StateView compact state="empty" title={t('compare.needTwo')} description={t('compare.needTwo.desc')} /> : null}
      {compare.isPending ? <Skeleton lines={5} /> : null}
      {compare.isError ? (
        problem?.code === 'comparison_calculation_missing' || problem?.blockers?.length ? (
          <Notice
            tone="warning"
            title={problem.blockers?.some((b) => b.code === 'comparison_calculation_missing') ? t('compare.missing') : (problemCodeEntry(problem.code)?.title_ru ?? t('compare.missing'))}
          >
            <ul className="pg-list">
              {(problem.blockers ?? []).map((b, i) => {
                const s = byRevision.get(b.required_inputs[0] ?? '');
                return (
                  <li key={`${b.code}-${i}`}>
                    {s ? <Link to={`/projects/${s.id}?city=${city.id}`}>{s.name}</Link> : <code className="pg-code">{(b.required_inputs[0] ?? '').slice(0, 8)}</code>} — {t('compare.missing.desc')}
                  </li>
                );
              })}
            </ul>
          </Notice>
        ) : (
          <ApiErrorView compact error={compare.error} onRetry={() => compare.mutate(selected)} />
        )
      ) : null}
      {result ? (
        <section aria-labelledby="cmp-result-h" className="cmp-result">
          <h2 id="cmp-result-h">{t('compare.result')}</h2>
          {result.comparability_warnings.length ? (
            <Notice tone="warning" title={t('compare.warnings')}>
              <ul className="pg-list">
                {result.comparability_warnings.map((w, i) => {
                  const names = w.required_inputs.map((id) => byRevision.get(id)?.name).filter((name): name is string => Boolean(name));
                  return <li key={`${w.code}-${i}`} data-code={w.code}><strong>{problemCodeEntry(w.code)?.title_ru ?? 'Варианты требуют дополнительной проверки'}</strong>{names.length ? ` — ${names.join(', ')}` : ''}</li>;
                })}
              </ul>
            </Notice>
          ) : (
            <p className="pg-muted">{t('compare.noWarnings')}</p>
          )}
          <div className="cmp-summary-grid">
            {snapshots.map((snapshot) => {
              const scenario = byRevision.get(snapshot.scenario_revision_id);
              return <SnapshotSummary key={snapshot.id} snapshot={snapshot} scenario={scenario} city={city} zoneName={scenario ? (zoneNames.get(scenario.zone_id) ?? 'Проект участка') : 'Проект участка'} />;
            })}
          </div>
          <details className="cmp-details">
            <summary>Подробное сравнение показателей</summary>
            <div className="cmp-scroll">
            <table className="cmp-table">
              <caption className="pg-sr-only">{t('compare.result')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('compare.row')}</th>
                  {snapshots.map((s) => {
                    const sc = byRevision.get(s.scenario_revision_id);
                    return (
                      <th scope="col" key={s.id}>
                        {sc?.name ?? <code className="pg-code">{s.scenario_revision_id.slice(0, 8)}</code>}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">{t('compare.snapshot')}</th>
                  {snapshots.map((s) => {
                    const sc = byRevision.get(s.scenario_revision_id);
                    return (
                      <td key={s.id}>
                        {sc ? (
                          <Link to={`/projects/${sc.id}?city=${city.id}&${CALC_RESULT}=${s.id}`} title={s.id}>
                            <code className="pg-code">{s.id.slice(0, 8)}</code>
                          </Link>
                        ) : (
                          <code className="pg-code" title={s.id}>
                            {s.id.slice(0, 8)}
                          </code>
                        )}
                        <div className="pg-muted">
                          {t('compare.revision')} <code className="pg-code">{s.scenario_revision_id.slice(0, 8)}</code> · {formatDateTime(s.created_at, city.timezone)}
                        </div>
                      </td>
                    );
                  })}
                </tr>
                <tr>
                  <th scope="row">{t('compare.status')}</th>
                  {snapshots.map((s) => (
                    <td key={s.id}>
                      <span className="pg-flags">
                        <Badge tone={s.status === 'complete' ? 'positive' : 'warning'}>{t(s.status === 'complete' ? 'scenario.calc.complete' : 'scenario.calc.partial')}</Badge>
                        {s.is_stale ? <Badge tone="warning" icon="clock">{t('compare.stale')}</Badge> : null}
                      </span>
                    </td>
                  ))}
                </tr>
                <tr>
                  <th scope="row">{t('scenario.calc.known')}</th>
                  {snapshots.map((s) => (
                    <td key={s.id}>
                      <MoneyText value={s.cost.known_subtotal} />
                    </td>
                  ))}
                </tr>
                <tr>
                  <th scope="row">{t('scenario.calc.total')}</th>
                  {snapshots.map((s) => (
                    <td key={s.id}>{s.cost.status === 'complete' && s.cost.total ? <MoneyText value={s.cost.total} /> : <span className="pg-unknown">{t('scenario.calc.unknown')}</span>}</td>
                  ))}
                </tr>
                {new Set(snapshots.map((s) => s.cost.currency)).size > 1 ? (
                  <tr>
                    <th scope="row">{t('compare.currency')}</th>
                    {snapshots.map((s) => (
                      <td key={s.id}>
                        <Badge tone="warning">{s.cost.currency}</Badge>
                      </td>
                    ))}
                  </tr>
                ) : null}
                <tr>
                  <th scope="row">{t('calc.survival')}</th>
                  {snapshots.map((s) => (
                    <td key={s.id}>{s.survival.length ? t('compare.survival.n', { n: s.survival.length }) : <span className="pg-unknown">{t('compare.notCalculated')}</span>}</td>
                  ))}
                </tr>
                <tr>
                  <th scope="row">{t('calc.care')}</th>
                  {snapshots.map((s) => (
                    <td key={s.id}>{s.care.length ? t('compare.care.n', { n: s.care.length }) : <span className="pg-unknown">{t('compare.notCalculated')}</span>}</td>
                  ))}
                </tr>
                {rows.map((r) => (
                  <tr key={r.id} className={r.unitsDiffer ? 'is-incomparable' : undefined} data-metric={r.id}>
                    <th scope="row">
                      {metricLabel(r.key)}
                      <div className="pg-muted">{r.horizon == null || r.horizon === 0 ? t('compare.horizon.now') : t('compare.horizon', { years: r.horizon })}</div>
                      {r.unitsDiffer ? <Badge tone="warning" icon="alert">{t('compare.unitsDiffer')}</Badge> : null}
                    </th>
                    {r.cells.map((m, i) => (
                      <td key={snapshots[i]!.id}>
                        <MetricCell m={m} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            <p className="pg-muted">{t('compare.note')}</p>
          </details>
          {selected.length >= 2 ? (
            <Button size="sm" variant="ghost" icon="refresh" onClick={() => compare.mutate(selected)}>
              {t('compare.refresh')}
            </Button>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
