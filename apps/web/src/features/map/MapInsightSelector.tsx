import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  unwrap,
  type DetectedProblem,
  type PriorityResult,
  type Program,
  type Scenario,
  type ScenarioRevision,
  type Zone,
} from '@pg/api-client';
import { api } from '../../api';
import {
  placementCollection,
  priorityCollection,
  problemCollection,
  type InsightCollections,
  type InsightKind,
} from './MapInsightLayers';
import './MapInsightLayers.css';

const DEFAULT_ENABLED: Record<InsightKind, boolean> = { problems: true, priority: true, placements: true };
const SCENARIO_ORDER = { approved: 0, in_review: 1, draft: 2, archived: 3 } as const;

export interface MapInsightModel {
  enabled: Record<InsightKind, boolean>;
  setEnabled: (kind: InsightKind, value: boolean) => void;
  collections: InsightCollections;
  problems: { loading: boolean; error: boolean; count: number };
  priority: { loading: boolean; error: boolean; count: number; programName: string | null };
  placements: { loading: boolean; error: boolean; count: number; selectedZone: boolean; scenarios: Scenario[]; scenarioId: string; setScenarioId: (id: string) => void };
}

export function useMapInsightModel({ cityId, zones, selectedZoneId }: { cityId: string | null; zones: Zone[]; selectedZoneId: string | null }): MapInsightModel {
  const [enabled, setEnabledState] = useState(DEFAULT_ENABLED);
  const [scenarioId, setScenarioId] = useState('');
  const problems = useQuery({
    queryKey: ['map-insights', 'problems', cityId],
    enabled: Boolean(cityId),
    queryFn: async ({ signal }) => (
      await unwrap(api.GET('/v1/problems', { params: { query: { city_id: cityId!, limit: 100 } }, signal }))
    ).data.items as DetectedProblem[],
  });
  const programs = useQuery({
    queryKey: ['map-insights', 'programs', cityId],
    enabled: Boolean(cityId),
    queryFn: async ({ signal }) => (
      await unwrap(api.GET('/v1/programs', { params: { query: { city_id: cityId!, limit: 100 } }, signal }))
    ).data.items as Program[],
  });
  const priorityProgram = useMemo(() => [...(programs.data ?? [])]
    .filter((program) => Boolean(program.priority_result_id))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] ?? null, [programs.data]);
  const priority = useQuery({
    queryKey: ['map-insights', 'priority', priorityProgram?.priority_result_id ?? ''],
    enabled: Boolean(priorityProgram?.priority_result_id),
    queryFn: async ({ signal }) => (
      await unwrap<PriorityResult>(api.GET('/v1/priorities/{priority_id}', {
        params: { path: { priority_id: priorityProgram!.priority_result_id! } }, signal,
      }))
    ).data,
  });
  const scenarios = useQuery({
    queryKey: ['map-insights', 'scenarios', cityId, selectedZoneId],
    enabled: Boolean(cityId && selectedZoneId),
    queryFn: async ({ signal }) => (
      await unwrap(api.GET('/v1/scenarios', { params: { query: { city_id: cityId!, zone_id: selectedZoneId!, limit: 100 } }, signal }))
    ).data.items as Scenario[],
  });
  const orderedScenarios = useMemo(() => [...(scenarios.data ?? [])]
    .filter((scenario) => scenario.status !== 'archived')
    .sort((a, b) => SCENARIO_ORDER[a.status] - SCENARIO_ORDER[b.status] || b.updated_at.localeCompare(a.updated_at)), [scenarios.data]);
  useEffect(() => {
    if (orderedScenarios.some((scenario) => scenario.id === scenarioId)) return;
    setScenarioId(orderedScenarios[0]?.id ?? '');
  }, [orderedScenarios, scenarioId]);
  const scenario = orderedScenarios.find((item) => item.id === scenarioId) ?? null;
  const revision = useQuery({
    queryKey: ['map-insights', 'revision', scenario?.current_revision_id ?? ''],
    enabled: Boolean(scenario?.current_revision_id),
    queryFn: async ({ signal }) => (
      await unwrap<ScenarioRevision>(api.GET('/v1/scenario-revisions/{revision_id}', {
        params: { path: { revision_id: scenario!.current_revision_id } }, signal,
      }))
    ).data,
  });

  const collections = useMemo<InsightCollections>(() => ({
    problems: problemCollection(problems.data ?? [], zones),
    priority: priorityCollection(priority.data ?? null, zones),
    placements: placementCollection(revision.data ?? null, scenario),
  }), [problems.data, priority.data, revision.data, scenario, zones]);

  return {
    enabled,
    setEnabled: (kind, value) => setEnabledState((current) => ({ ...current, [kind]: value })),
    collections,
    problems: { loading: problems.isPending, error: problems.isError, count: collections.problems.features.length },
    priority: {
      loading: programs.isPending || (Boolean(priorityProgram?.priority_result_id) && priority.isPending),
      error: programs.isError || priority.isError,
      count: collections.priority.features.length,
      programName: priorityProgram?.name ?? null,
    },
    placements: {
      loading: (Boolean(selectedZoneId) && scenarios.isPending) || (Boolean(scenario) && revision.isPending),
      error: scenarios.isError || revision.isError,
      count: collections.placements.features.length,
      selectedZone: Boolean(selectedZoneId),
      scenarios: orderedScenarios,
      scenarioId,
      setScenarioId,
    },
  };
}

const statusText = (kind: InsightKind, model: MapInsightModel) => {
  if (kind === 'problems') {
    const state = model.problems;
    if (state.loading) return 'загрузка…';
    if (state.error) return 'не удалось загрузить';
    return state.count ? `${state.count} территорий` : 'открытых проблем нет';
  }
  if (kind === 'priority') {
    const state = model.priority;
    if (state.loading) return 'загрузка…';
    if (state.error) return 'не удалось загрузить';
    return state.programName ? `${state.count} территорий · ${state.programName}` : 'сначала рассчитайте приоритеты';
  }
  const state = model.placements;
  if (state.loading) return 'загрузка…';
  if (state.error) return 'не удалось загрузить';
  if (!state.selectedZone) return 'сначала выберите участок';
  if (!state.scenarios.length) return 'у участка пока нет проектов';
  return state.count ? `${state.count} групп посадок` : 'в выбранном проекте нет посадок';
};

const ITEMS: { kind: InsightKind; title: string; color: string }[] = [
  { kind: 'problems', title: 'Проблемные территории', color: '#b42318' },
  { kind: 'priority', title: 'Приоритет озеленения', color: '#d97706' },
  { kind: 'placements', title: 'Предлагаемые посадки', color: '#147d64' },
];

export function MapInsightSelector({ model }: { model: MapInsightModel }) {
  return (
    <details className="map-insights" open>
      <summary><span>AI-слои решений</span><small>3 слоя</small></summary>
      <div className="map-insights__body">
        <p>Результаты серверного анализа поверх городской карты.</p>
        {ITEMS.map((item) => {
          const disabled = item.kind === 'placements' && (!model.placements.selectedZone || model.placements.scenarios.length === 0);
          return (
            <div className="map-insight-item" key={item.kind}>
              <label>
                <input type="checkbox" checked={model.enabled[item.kind]} disabled={disabled} onChange={(event) => model.setEnabled(item.kind, event.target.checked)} />
                <span className="map-insight-item__swatch" style={{ background: item.color }} aria-hidden />
                <span><strong>{item.title}</strong><small>{statusText(item.kind, model)}</small></span>
              </label>
              {item.kind === 'placements' && model.placements.scenarios.length > 1 && model.enabled.placements ? (
                <select aria-label="Проект для слоя посадок" value={model.placements.scenarioId} onChange={(event) => model.placements.setScenarioId(event.target.value)}>
                  {model.placements.scenarios.map((scenario) => <option key={scenario.id} value={scenario.id}>{scenario.name}</option>)}
                </select>
              ) : null}
            </div>
          );
        })}
        <div className="map-insights__legend"><span><i className="is-high" /> высокий</span><span><i className="is-medium" /> средний</span><span><i className="is-low" /> низкий</span></div>
        <small className="map-insights__hint">Нажмите на территорию или посадку, чтобы открыть подробности.</small>
      </div>
    </details>
  );
}
