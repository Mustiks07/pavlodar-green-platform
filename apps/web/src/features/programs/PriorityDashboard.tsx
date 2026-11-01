import { Link } from 'react-router';
import type { PriorityResult } from '@pg/api-client';
import { Badge } from '@pg/ui';
import './PriorityDashboard.css';

const FACTOR_LABELS: Record<string, string> = {
  green_deficit: 'Дефицит существующего озеленения',
  soil_coverage: 'Готовность почвенных данных',
  population_density: 'Плотность населения',
  social_objects: 'Социальные объекты рядом',
  heat_load: 'Тепловая нагрузка',
  cost_effectiveness: 'Эффект на единицу затрат',
};

const factorLabel = (factor: string, labels?: ReadonlyMap<string, string>) =>
  labels?.get(factor) ?? FACTOR_LABELS[factor] ?? factor.replaceAll('_', ' ');

const scoreText = (value: number | null) => value === null ? '—' : value.toFixed(1);

const scoreTone = (value: number | null) => {
  if (value === null) return 'neutral' as const;
  if (value >= 70) return 'negative' as const;
  if (value >= 40) return 'warning' as const;
  return 'positive' as const;
};

export function PriorityDashboard({
  result,
  zoneNames,
  cityId,
  factorLabels,
}: {
  result: PriorityResult;
  zoneNames: ReadonlyMap<string, string>;
  cityId: string;
  factorLabels?: ReadonlyMap<string, string>;
}) {
  const ranked = [...result.zones].sort((a, b) => {
    if (a.score === null) return b.score === null ? 0 : 1;
    if (b.score === null) return -1;
    return b.score - a.score;
  });

  return (
    <section className="priority-dashboard" aria-labelledby={`priority-title-${result.id}`}>
      <header className="priority-dashboard__head">
        <span>
          <small>Серверный рейтинг территорий</small>
          <strong id={`priority-title-${result.id}`}>Куда направить озеленение в первую очередь</strong>
        </span>
        <Badge tone="accent">0–100</Badge>
      </header>
      <p className="priority-dashboard__intro">
        Чем выше итоговый балл, тем выше очерёдность территории. Покрытие показывает, какая доля выбранных факторов подтверждена данными.
      </p>
      <div className="priority-dashboard__list">
        {ranked.map((zone, index) => {
          const coverage = Math.round(zone.data_coverage * 100);
          const name = zoneNames.get(zone.zone_id) ?? 'Территория';
          return (
            <article className="priority-zone" key={zone.zone_id}>
              <div className="priority-zone__rank" aria-label={`Место ${index + 1}`}>{index + 1}</div>
              <div className="priority-zone__body">
                <header>
                  <span><strong>{name}</strong><small>Покрытие данных {coverage}%</small></span>
                  <Badge tone={scoreTone(zone.score)}>{zone.score === null ? 'нужны данные' : `${zone.score.toFixed(1)} / 100`}</Badge>
                </header>
                <div className="priority-zone__score" aria-label={`Приоритет ${scoreText(zone.score)} из 100`}>
                  <span style={{ width: `${zone.score ?? 0}%` }} />
                </div>
                <dl className="priority-zone__summary">
                  <div><dt>Потребность</dt><dd>{scoreText(zone.need_score)}</dd></div>
                  <div><dt>Готовность</dt><dd>{scoreText(zone.readiness_score)}</dd></div>
                  <div><dt>Данные</dt><dd>{coverage}%</dd></div>
                </dl>
                <div className="priority-zone__factors">
                  {zone.contributions.map((contribution) => (
                    <div className="priority-factor" key={contribution.factor}>
                      <div>
                        <strong>{factorLabel(contribution.factor, factorLabels)}</strong>
                        <span>{contribution.explanation}</span>
                      </div>
                      <span className="priority-factor__value">
                        {contribution.score === null ? 'нет данных' : `${Math.round(contribution.score * 100)}%`}
                      </span>
                    </div>
                  ))}
                </div>
                <Link className="priority-zone__map" to={`/?city=${cityId}&zone=${zone.zone_id}`}>Открыть территорию на карте →</Link>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
