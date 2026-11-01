import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  newIdempotencyKey,
  unwrap,
  type Placement,
  type Plant,
  type PlantRecommendation,
  type RecommendationRequest,
  type RecommendationResult,
} from '@pg/api-client';
import { Badge, Button, Icon, Notice, Skeleton, StateView } from '@pg/ui';
import { api, useOperationAvailable } from '../../api';
import { ApiErrorView } from '../../shell/ApiErrorView';
import { useSession } from '../../shell/session';
import './RecommendationPanel.css';

const DEFAULT_WEIGHTS: RecommendationRequest['weights'] = [
  { factor: 'hardiness_fit', weight: 3 },
  { factor: 'moisture_fit', weight: 3 },
  { factor: 'salt_fit', weight: 2 },
  { factor: 'wind_fit', weight: 2 },
  { factor: 'light_fit', weight: 1 },
];

const FACTOR_LABELS: Record<string, string> = {
  hardiness_fit: 'зимостойкость',
  moisture_fit: 'соответствие по влаге',
  salt_fit: 'устойчивость к соли',
  wind_fit: 'устойчивость к ветру',
  light_fit: 'соответствие освещённости',
};

const ELIGIBILITY = {
  eligible: { label: 'подходит', tone: 'positive' as const },
  requires_review: { label: 'нужна проверка', tone: 'warning' as const },
  excluded: { label: 'исключено', tone: 'negative' as const },
};

export function buildRecommendationRequest({
  zoneVersionId,
  catalogVersionId,
  ruleVersionId,
  topN,
  excludedPlantIds,
  placements,
}: {
  zoneVersionId: string;
  catalogVersionId: string;
  ruleVersionId: string;
  topN: number;
  excludedPlantIds: string[];
  placements: Placement[];
}): RecommendationRequest {
  const excluded = [...new Set(excludedPlantIds)];
  const locked = [...new Set(placements.filter((item) => item.locked).map((item) => item.plant_id))].filter(
    (id) => !excluded.includes(id),
  );
  return {
    zone_version_id: zoneVersionId,
    catalog_version_id: catalogVersionId,
    rule_version_id: ruleVersionId,
    top_n: Math.max(topN, locked.length),
    excluded_plant_ids: excluded,
    locked_plant_ids: locked,
    weights: DEFAULT_WEIGHTS,
  };
}

function RecommendationCard({ recommendation, plant }: { recommendation: PlantRecommendation; plant: Plant | null }) {
  const eligibility = ELIGIBILITY[recommendation.eligibility];
  const knownContributions = recommendation.contributions.filter((item) => item.score !== null);
  return (
    <article className={`rec-card is-${recommendation.eligibility}`}>
      <header>
        <span className="rec-card__plant">
          <span className="rec-card__icon" aria-hidden="true"><Icon name="sprout" size={20} /></span>
          <span>
            <strong>{plant?.russian_name ?? 'Растение каталога'}</strong>
            {plant ? <small>{plant.latin_name}</small> : null}
          </span>
        </span>
        <span className="rec-card__result">
          <Badge tone={eligibility.tone}>{eligibility.label}</Badge>
          <strong>{recommendation.score === null ? '—' : recommendation.score.toFixed(0)}</strong>
          <small>из 100</small>
        </span>
      </header>
      <div className="rec-card__coverage" aria-label={`Покрытие данных ${Math.round(recommendation.data_coverage * 100)} процентов`}>
        <span style={{ width: `${Math.round(recommendation.data_coverage * 100)}%` }} />
      </div>
      <p className="rec-card__coverage-label">Данных для оценки: {Math.round(recommendation.data_coverage * 100)}%</p>
      {knownContributions.length ? (
        <dl className="rec-card__factors">
          {knownContributions.map((item) => (
            <div key={item.factor}>
              <dt>{FACTOR_LABELS[item.factor] ?? item.factor}</dt>
              <dd>{item.score === null ? '—' : `${Math.round(item.score * 100)} / 100`}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <details>
        <summary>Почему получен такой результат</summary>
        <ul>
          {recommendation.contributions.map((item) => (
            <li key={item.factor}>
              <strong>{FACTOR_LABELS[item.factor] ?? item.factor}:</strong> {item.explanation}
            </li>
          ))}
          {recommendation.blockers.map((item, index) => <li key={`${item.code}-${index}`}>{item.message}</li>)}
        </ul>
      </details>
    </article>
  );
}

export function RecommendationPanel({
  zoneVersionId,
  catalogVersionId,
  ruleVersionId,
  excludedPlantIds,
  placements,
  disabled = false,
}: {
  zoneVersionId: string;
  catalogVersionId: string | null;
  ruleVersionId: string | null;
  excludedPlantIds: string[];
  placements: Placement[];
  disabled?: boolean;
}) {
  const { user } = useSession();
  const available = useOperationAvailable('recommendPlants');
  const [topN, setTopN] = useState(5);
  const plants = useQuery({
    queryKey: ['recommendation-plant-names'],
    enabled: available !== false,
    staleTime: 60_000,
    queryFn: async ({ signal }) => (await unwrap(api.GET('/v1/plants', { params: { query: { limit: 200 } }, signal }))).data.items as Plant[],
  });
  const plantById = useMemo(() => new Map((plants.data ?? []).map((plant) => [plant.id, plant])), [plants.data]);
  const ready = Boolean(catalogVersionId && ruleVersionId);
  const recommendation = useMutation({
    mutationFn: async () => {
      if (!catalogVersionId || !ruleVersionId) throw new Error('Recommendation registry versions are missing');
      const body = buildRecommendationRequest({
        zoneVersionId,
        catalogVersionId,
        ruleVersionId,
        topN,
        excludedPlantIds,
        placements,
      });
      return (
        await unwrap<RecommendationResult>(
          api.POST('/v1/recommendations', {
            params: { header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': newIdempotencyKey() } },
            body,
          }),
        )
      ).data;
    },
  });
  const goToPlacement = () => document.getElementById('scenario-placement-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  if (available === false) return null;
  return (
    <section className="rec-panel" aria-labelledby="rec-panel-title">
      <header className="rec-panel__head">
        <span>
          <small>Автоматический подбор</small>
          <h3 id="rec-panel-title">Растения для этого участка</h3>
          <p>Сервер сначала применяет обязательные ограничения, затем ранжирует каталог по характеристикам растений.</p>
        </span>
        <span className="rec-panel__actions">
          <label>
            <span>Показать</span>
            <select value={topN} onChange={(event) => setTopN(Number(event.target.value))} disabled={disabled || recommendation.isPending}>
              {[3, 5, 7, 9].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <Button variant="primary" icon="sprout" busy={recommendation.isPending} disabled={disabled || !ready} onClick={() => recommendation.mutate()}>
            Подобрать растения
          </Button>
        </span>
      </header>
      {!ready ? (
        <Notice tone="warning" icon="alert" title="Сначала закрепите каталог и правила">
          Для воспроизводимого подбора проекту нужны точная версия каталога и утверждённая версия правил.
        </Notice>
      ) : null}
      {recommendation.isError ? <ApiErrorView compact error={recommendation.error} onRetry={() => recommendation.mutate()} /> : null}
      {recommendation.isPending || plants.isPending ? <Skeleton lines={4} /> : null}
      {plants.isError ? <ApiErrorView compact error={plants.error} onRetry={() => void plants.refetch()} /> : null}
      {recommendation.data ? (
        recommendation.data.candidates.length ? (
          <>
            <div className="rec-panel__summary">
              <strong>Top-{recommendation.data.candidates.length} по текущим версиям данных</strong>
              <span>Оценка показывается только при достаточном покрытии признаков.</span>
            </div>
            <div className="rec-panel__grid">
              {recommendation.data.candidates.map((item) => <RecommendationCard key={item.plant_id} recommendation={item} plant={plantById.get(item.plant_id) ?? null} />)}
            </div>
            <div className="rec-panel__footer">
              <p>Выберите подходящий вид и разместите его точкой внутри участка. Проверки геометрии и ограничений повторит сервер.</p>
              <Button variant="secondary" icon="map" onClick={goToPlacement}>Перейти к размещению</Button>
            </div>
          </>
        ) : <StateView compact state="empty" title="Подходящих растений не найдено" description="Измените исходные данные или проверьте обязательные ограничения участка." />
      ) : null}
    </section>
  );
}
