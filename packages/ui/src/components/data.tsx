import type { ReactNode } from 'react';
import { metricKeyEntry, type CostResult, type DataGap, type Job, type Metric, type SourceRef, type SurvivalResult } from '@pg/api-client';
import { Icon, type IconName } from './Icon';
import { Button } from './controls';
import { formatDate, formatDateTime, formatMoney, formatNumber, formatProbability, unitLabel } from '../format';
import { tUi } from '../i18n';

type Provenance = Metric['status'];

const PROV_ICON: Record<Provenance, IconName> = {
  measured: 'ruler',
  estimated: 'approx',
  synthetic: 'flask',
  unavailable: 'slash',
};

/** Provenance is shown as icon + word + pattern, never by color alone (TZ §06, §22). */
export function ProvenanceBadge({ status }: { status: Provenance }) {
  return (
    <span className={`pg-prov pg-prov--${status}`}>
      <Icon name={PROV_ICON[status]} size={12} />
      {tUi(`prov.${status}`)}
    </span>
  );
}

export function UnitText({ unit }: { unit: string }) {
  const { label, known } = unitLabel(unit);
  if (known) return <span className="pg-unit">{label}</span>;
  return (
    <span className="pg-unit pg-unit--unknown" title={tUi('metric.unknownUnit', { unit })}>
      {label}
      <Icon name="alert" size={11} label={tUi('metric.unknownUnit', { unit })} />
    </span>
  );
}

function decimalsFor(value: number, unit: string): number {
  const registered = unitLabel(unit).decimals;
  if (registered !== null) return registered;
  const abs = Math.abs(value);
  if (abs === 0 || abs >= 100) return 0;
  if (abs >= 10) return 1;
  return 2;
}

export function SourceList({ refs }: { refs: SourceRef[] }) {
  if (refs.length === 0) return <span className="pg-muted">{tUi('metric.noSources')}</span>;
  return (
    <ul className="pg-sources">
      {refs.map((r) => (
        <li key={`${r.dataset_version_id}:${r.source_record_id ?? ''}`}>
          {r.uri ? (
            <a href={r.uri} target="_blank" rel="noreferrer noopener">
              {r.label} <Icon name="external" size={11} />
            </a>
          ) : (
            r.label
          )}
          <code className="pg-code" title="dataset_version_id">
            {r.dataset_version_id.slice(0, 8)}
          </code>
        </li>
      ))}
    </ul>
  );
}

export function DataGapList({ gaps }: { gaps: DataGap[] }) {
  if (gaps.length === 0) return null;
  return (
    <ul className="pg-gaps">
      {gaps.map((g) => (
        <li key={g.code} className={g.blocking ? 'is-blocking' : undefined}>
          <Icon name={g.blocking ? 'error' : 'alert'} size={14} />
          <div>
            <p>
              {g.message}
              {g.blocking ? <span className="pg-gaps__flag"> · {tUi('metric.blocking')}</span> : null}
            </p>
            {g.required_inputs.length ? (
              <p className="pg-muted">
                {tUi('metric.requiredInputs')}:{' '}
                {g.required_inputs.map((i) => (
                  <code key={i} className="pg-code">
                    {i}
                  </code>
                ))}
              </p>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

export interface MetricValueProps {
  metric: Metric;
  label: string;
  /** Show method and sources disclosure (cards); tables keep it compact. */
  detailed?: boolean;
}

/**
 * Renders a server metric. null is "Нет данных" with a reason, never 0; the interval is
 * shown only when the server returned one, otherwise the qualitative confidence.
 */
export function MetricValue({ metric, label, detailed = true }: MetricValueProps) {
  const unavailable = metric.status === 'unavailable' || metric.value === null;
  const probability = metric.key === 'survival_probability' && metric.unit === '1';
  const decimals = metric.value === null ? 0 : decimalsFor(metric.value, metric.unit);
  const expectedUnit = metricKeyEntry(metric.key)?.unit ?? null;
  const horizon =
    metric.horizon_year == null || metric.horizon_year === 0
      ? tUi('metric.horizon.now')
      : tUi('metric.horizon', { years: metric.horizon_year });
  const interval =
    metric.lower != null && metric.upper != null
      ? tUi('metric.interval', {
          lower: probability ? formatProbability(metric.lower)! : formatNumber(metric.lower, decimals)!,
          upper: probability ? formatProbability(metric.upper)! : formatNumber(metric.upper, decimals)!,
        })
      : tUi('metric.confidence', { level: tUi(`metric.confidence.${metric.qualitative_confidence}`) });

  return (
    <div className={unavailable ? 'pg-metric is-unavailable' : 'pg-metric'}>
      <div className="pg-metric__head">
        <span className="pg-metric__label">{label}</span>
        <ProvenanceBadge status={metric.status} />
      </div>
      {unavailable ? (
        <p className="pg-metric__value pg-metric__value--na">{tUi('state.unavailable')}</p>
      ) : (
        <p className="pg-metric__value">
          {probability ? formatProbability(metric.value) : <>{formatNumber(metric.value, decimals)} <UnitText unit={metric.unit} /></>}
        </p>
      )}
      {expectedUnit && expectedUnit !== metric.unit ? (
        <p className="pg-metric__warn" role="note">
          <Icon name="alert" size={12} /> {tUi('metric.unitMismatch', { expected: expectedUnit })}
        </p>
      ) : null}
      <p className="pg-metric__meta">
        {horizon}
        {unavailable ? null : <> · {interval}</>}
      </p>
      {unavailable && metric.missing_reason ? <DataGapList gaps={[metric.missing_reason]} /> : null}
      {detailed ? (
        <details className="pg-disclosure">
          <summary>
            {tUi('metric.method')} и {tUi('metric.sources').toLowerCase()}
          </summary>
          <dl className="pg-dl">
            <dt>{tUi('metric.method')}</dt>
            <dd>
              <code className="pg-code">{metric.method_version}</code>
            </dd>
            <dt>{tUi('metric.sources')}</dt>
            <dd>
              <SourceList refs={metric.source_refs} />
            </dd>
          </dl>
        </details>
      ) : null}
    </div>
  );
}

export function MoneyText({ value }: { value: string | null }) {
  const text = formatMoney(value);
  if (text === null) return <span className="pg-money pg-money--na">{tUi('cost.missingPrice')}</span>;
  return <span className="pg-money">{text}</span>;
}

/** Total is shown only when the server says complete; known_subtotal is never a budget. */
export function CostSummary({ cost }: { cost: CostResult }) {
  const complete = cost.status === 'complete' && cost.total !== null;
  return (
    <div className="pg-cost">
      {complete ? (
        <p className="pg-cost__total">
          <span>{tUi('cost.total')}</span> <MoneyText value={cost.total} />
        </p>
      ) : (
        <div className="pg-cost__incomplete" role="note">
          <p className="pg-cost__total pg-cost__total--na">
            <Icon name="alert" size={16} /> {tUi('cost.incomplete')}
          </p>
          <p>
            {tUi('cost.knownSubtotal', { amount: formatMoney(cost.known_subtotal) ?? '—' })}{' '}
            <span className="pg-muted">({tUi('cost.knownSubtotal.note')})</span>
          </p>
        </div>
      )}
      <DataGapList gaps={cost.data_gaps} />
    </div>
  );
}

const MODEL_KIND: Record<SurvivalResult['model_kind'], string> = {
  expert_rules: 'экспертные правила',
  ml: 'ML-модель',
  hybrid: 'гибридная модель',
};
const CALIBRATION: Record<SurvivalResult['calibration_status'], string> = {
  uncalibrated: 'не откалибрована',
  expert_confirmed: 'подтверждена экспертом',
  locally_validated: 'проверена на местных данных',
};

const survivalYear = (year: number) => `${year} ${year % 10 === 1 && year % 100 !== 11 ? 'год' : year % 10 >= 2 && year % 10 <= 4 && (year % 100 < 12 || year % 100 > 14) ? 'года' : 'лет'}`;

function survivalGuidance(result: SurvivalResult) {
  return result.risks.map((item) => {
    const match = /^(risk|measure):(.*)$/.exec(item.factor);
    return {
      ...item,
      kind: match?.[1] === 'measure' ? ('measure' as const) : ('risk' as const),
      label: match?.[2]?.trim() || item.factor,
    };
  });
}

/** S1..S3 of the original cohort; method, calibration, risks and gaps stay visible (F-SURV-01). */
export function SurvivalStrip({ result, synthetic, title }: { result: SurvivalResult; synthetic: boolean; title?: string }) {
  const guidance = survivalGuidance(result);
  const risks = guidance.filter((item) => item.kind === 'risk');
  const measures = guidance.filter((item) => item.kind === 'measure');
  return (
    <div className="pg-survival">
      {title ? <h4 className="pg-survival__title">{title}</h4> : null}
      <div className="pg-survival__points">
        {result.points.map((p) => (
          <div key={p.year} className="pg-survival__point">
            <span className="pg-survival__year">{survivalYear(p.year)}</span>
            <span className="pg-survival__value">{formatProbability(p.probability) ?? tUi('state.unavailable')}</span>
            <span className="pg-muted pg-survival__ci">
              {p.lower != null && p.upper != null
                ? `интервал ${formatProbability(p.lower)}–${formatProbability(p.upper)}`
                : 'интервал не рассчитан'}
            </span>
          </div>
        ))}
      </div>
      <p className="pg-muted">
        {MODEL_KIND[result.model_kind]} · {CALIBRATION[result.calibration_status]}
        {synthetic ? (
          <>
            {' · '}
            <ProvenanceBadge status="synthetic" />
          </>
        ) : null}
      </p>
      {guidance.length ? (
        <div className="pg-survival__guidance">
          {risks.length ? (
            <section aria-label="Что влияет на приживаемость">
              <header><Icon name="alert" size={16} /><strong>Что влияет</strong></header>
              <div>
                {risks.map((risk) => (
                  <article key={risk.factor}>
                    <span><strong>{risk.label}</strong>{risk.score === null ? null : <em>Уровень {formatProbability(risk.score)}</em>}</span>
                    <p>{risk.explanation}</p>
                  </article>
                ))}
              </div>
            </section>
          ) : null}
          {measures.length ? (
            <section className="is-measure" aria-label="Что сделать для повышения приживаемости">
              <header><Icon name="checkCircle" size={16} /><strong>Что сделать</strong></header>
              <div>
                {measures.map((measure) => (
                  <article key={measure.factor}>
                    <span><strong>{measure.label}</strong>{measure.score === null ? null : <em>Приоритет {formatProbability(measure.score)}</em>}</span>
                    <p>{measure.explanation}</p>
                  </article>
                ))}
              </div>
            </section>
          ) : null}
          {result.calibration_status === 'uncalibrated' ? (
            <p className="pg-survival__guidance-note">Факторы объясняют экспертный профиль, но не изменяют показанные проценты и не означают локальную калибровку.</p>
          ) : null}
        </div>
      ) : null}
      <DataGapList gaps={result.data_gaps} />
    </div>
  );
}

export type SaveState = 'idle' | 'editing' | 'saving' | 'saved' | 'failed' | 'conflict';

const SAVE_ICON: Record<SaveState, IconName> = {
  idle: 'checkCircle',
  editing: 'dot',
  saving: 'refresh',
  saved: 'checkCircle',
  failed: 'error',
  conflict: 'conflict',
};

/** Distinguishes editing/saving/saved/failed/conflict (F-SCEN-02). Never green after a failure. */
export function SaveStatus({ state, revisionLabel, onRetry }: { state: SaveState; revisionLabel?: string; onRetry?: () => void }) {
  const text =
    state === 'saved' ? tUi('save.saved', { revision: revisionLabel ?? '—' }) : tUi(`save.${state}`);
  return (
    <span className={`pg-save pg-save--${state}`} role="status" aria-live="polite">
      <Icon name={SAVE_ICON[state]} size={14} className={state === 'saving' ? 'pg-rotate' : undefined} />
      {text}
      {state === 'failed' && onRetry ? (
        <Button size="sm" variant="ghost" icon="refresh" onClick={onRetry}>
          {tUi('action.retry')}
        </Button>
      ) : null}
    </span>
  );
}

/**
 * Job progress: shows a percentage only when the server reports one; with phases only,
 * an indeterminate bar labelled by the phase (TZ §23 «процент прогресса не придумывать»).
 */
export function JobStatus({ job, onCancel, timeZone }: { job: Job; onCancel?: () => void; timeZone?: string }) {
  const active = job.state === 'queued' || job.state === 'running';
  const pct = job.progress == null ? null : Math.round(job.progress * 100);
  const tone =
    job.state === 'succeeded' ? 'positive' : job.state === 'failed' ? 'negative' : job.state === 'cancelled' ? 'neutral' : 'info';
  return (
    <div className={`pg-job pg-job--${tone}`}>
      <div className="pg-job__head">
        <strong>{tUi(`job.${job.state}`)}</strong>
        {job.phase || job.attempt > 1 ? (
          <span className="pg-muted">
            {job.phase ? tUi('job.phase', { phase: job.phase }) : null}
            {job.phase && job.attempt > 1 ? ' · ' : null}
            {job.attempt > 1 ? tUi('job.attempt', { n: job.attempt }) : null}
          </span>
        ) : null}
      </div>
      {active ? (
        <div
          className={pct == null ? 'pg-progress is-indeterminate' : 'pg-progress'}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct ?? undefined}
          aria-valuetext={pct == null ? tUi('job.progressUnknown') : `${pct}%`}
        >
          <span style={pct == null ? undefined : { width: `${pct}%` }} />
        </div>
      ) : null}
      <p className="pg-muted pg-job__time">
        {formatDateTime(job.created_at, timeZone)}
        {job.completed_at ? ` → ${formatDateTime(job.completed_at, timeZone)}` : null}
      </p>
      {job.error ? <p className="pg-job__error">{job.error.detail}</p> : null}
      {active && onCancel ? (
        <Button size="sm" variant="secondary" icon="x" onClick={onCancel}>
          {tUi('action.cancel')}
        </Button>
      ) : null}
    </div>
  );
}

export interface LegendClass {
  key: string;
  label: string;
  swatch: string;
  pattern?: 'solid' | 'hatched';
}

export interface LegendProps {
  title: string;
  classes: LegendClass[] | null;
  unit: string | null;
  period: { from: string | null; to: string | null } | null;
  /** Optional: main map screens omit it; attribution stays in the map's attribution control. */
  source?: ReactNode;
  stale?: boolean;
  unknownLabel?: string | null;
}

/** Each active scale states unit and period (F-MAP-01). Missing legend is explicit. */
export function Legend({ title, classes, unit, period, source, stale, unknownLabel }: LegendProps) {
  return (
    <section className="pg-legend" aria-label={`${tUi('legend.title')}: ${title}`}>
      <h3 className="pg-legend__title">{title}</h3>
      {stale ? (
        <p className="pg-legend__stale">
          <Icon name="clock" size={13} /> {tUi('legend.stale')}
        </p>
      ) : null}
      {classes ? (
        <ul className="pg-legend__classes">
          {classes.map((c) => (
            <li key={c.key}>
              <span
                className={c.pattern === 'hatched' ? 'pg-swatch pg-swatch--hatched' : 'pg-swatch'}
                style={{ background: c.swatch }}
                aria-hidden
              />
              {c.label}
            </li>
          ))}
          {unknownLabel !== null ? (
            <li>
              <span className="pg-swatch pg-swatch--unknown" aria-hidden />
              {unknownLabel ?? tUi('legend.unknown')}
            </li>
          ) : null}
        </ul>
      ) : (
        <p className="pg-muted">
          <Icon name="info" size={13} /> {tUi('legend.notProvided')}
        </p>
      )}
      <dl className="pg-legend__meta">
        <dt>{tUi('legend.unit')}</dt>
        <dd>{unit ? <UnitText unit={unit} /> : '—'}</dd>
        <dt>{tUi('legend.period')}</dt>
        <dd>{period ? `${formatDate(period.from) ?? '…'} – ${formatDate(period.to) ?? '…'}` : '—'}</dd>
        {source !== undefined ? (
          <>
            <dt>{tUi('legend.source')}</dt>
            <dd>{source}</dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}
