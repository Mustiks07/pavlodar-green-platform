import type { Feature, FeatureCollection, Geometry } from 'geojson';
import type { DetectedProblem, PriorityResult, Scenario, ScenarioRevision, Zone } from '@pg/api-client';
import type { Map as MapLibreMap, GeoJSONSource } from 'maplibre-gl';

export type InsightKind = 'problems' | 'priority' | 'placements';
export type InsightPick = { kind: InsightKind; zoneId: string | null; scenarioId: string | null };
export type InsightCollections = Record<InsightKind, FeatureCollection>;

export const INSIGHT_LAYER_IDS = [
  'insight-problems-fill',
  'insight-problems-line',
  'insight-priority-fill',
  'insight-priority-line',
  'insight-placements-area',
  'insight-placements-area-line',
  'insight-placements-point',
] as const;

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };
const severityRank = { low: 1, medium: 2, high: 3 } as const;

export function problemCollection(problems: DetectedProblem[], zones: Zone[]): FeatureCollection {
  const byZone = new Map<string, DetectedProblem[]>();
  for (const problem of problems) {
    if (problem.status === 'dismissed') continue;
    byZone.set(problem.zone_id, [...(byZone.get(problem.zone_id) ?? []), problem]);
  }
  const zoneById = new Map(zones.map((zone) => [zone.id, zone]));
  const features: Feature[] = [];
  for (const [zoneId, items] of byZone) {
    const zone = zoneById.get(zoneId);
    if (!zone) continue;
    const top = [...items].sort((a, b) => severityRank[b.severity] - severityRank[a.severity])[0]!;
    features.push({
      type: 'Feature',
      id: `problem:${zoneId}`,
      geometry: zone.geometry as Geometry,
      properties: {
        insight: 'problems',
        zone_id: zoneId,
        zone_name: zone.name,
        severity: top.severity,
        count: items.length,
        label: items.length === 1 ? top.description : `${items.length} проблемы территории`,
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

export function priorityCollection(priority: PriorityResult | null, zones: Zone[]): FeatureCollection {
  if (!priority) return EMPTY;
  const zoneById = new Map(zones.map((zone) => [zone.id, zone]));
  return {
    type: 'FeatureCollection',
    features: priority.zones.flatMap((item, index) => {
      const zone = zoneById.get(item.zone_id);
      if (!zone) return [];
      return [{
        type: 'Feature' as const,
        id: `priority:${zone.id}`,
        geometry: zone.geometry as Geometry,
        properties: {
          insight: 'priority',
          zone_id: zone.id,
          zone_name: zone.name,
          score: item.score,
          coverage: Math.round(item.data_coverage * 100),
          rank: index + 1,
          label: item.score === null ? 'Недостаточно данных для итогового балла' : `Приоритет ${item.score.toFixed(1)} из 100`,
        },
      }];
    }),
  };
}

export function placementCollection(revision: ScenarioRevision | null, scenario: Scenario | null): FeatureCollection {
  if (!revision || !scenario) return EMPTY;
  const points: Feature[] = revision.placements.map((placement) => ({
    type: 'Feature',
    id: `placement:${placement.id}`,
    geometry: placement.position as Geometry,
    properties: {
      insight: 'placements',
      geometry_kind: 'point',
      zone_id: scenario.zone_id,
      scenario_id: scenario.id,
      scenario_name: scenario.name,
      quantity: placement.quantity,
      label: `${placement.quantity} шт. в проекте «${scenario.name}»`,
    },
  }));
  const areas: Feature[] = revision.area_patches.map((patch) => ({
    type: 'Feature',
    id: `area-patch:${patch.id}`,
    geometry: patch.geometry as Geometry,
    properties: {
      insight: 'placements',
      geometry_kind: 'area',
      zone_id: scenario.zone_id,
      scenario_id: scenario.id,
      scenario_name: scenario.name,
      density: patch.density_plants_per_m2,
      label: `Площадная посадка в проекте «${scenario.name}»`,
    },
  }));
  return { type: 'FeatureCollection', features: [...areas, ...points] };
}

const setSource = (map: MapLibreMap, id: string, data: FeatureCollection) => {
  const source = map.getSource(id) as GeoJSONSource | undefined;
  if (source) source.setData(data);
  else map.addSource(id, { type: 'geojson', data });
};

export function syncInsightLayers(map: MapLibreMap, collections: InsightCollections, enabled: Record<InsightKind, boolean>) {
  setSource(map, 'insight-problems', enabled.problems ? collections.problems : EMPTY);
  setSource(map, 'insight-priority', enabled.priority ? collections.priority : EMPTY);
  setSource(map, 'insight-placements', enabled.placements ? collections.placements : EMPTY);

  const beforeLine = map.getLayer('zones-line') ? 'zones-line' : undefined;
  if (!map.getLayer('insight-priority-fill')) map.addLayer({
    id: 'insight-priority-fill', type: 'fill', source: 'insight-priority',
    paint: {
      'fill-color': ['case', ['==', ['get', 'score'], null], '#7b8580', ['interpolate', ['linear'], ['get', 'score'], 0, '#2f855a', 50, '#d97706', 100, '#b42318']],
      'fill-opacity': 0.26,
    },
  }, beforeLine);
  if (!map.getLayer('insight-priority-line')) map.addLayer({
    id: 'insight-priority-line', type: 'line', source: 'insight-priority',
    paint: { 'line-color': ['case', ['==', ['get', 'score'], null], '#5f6b65', '#7f1d1d'], 'line-width': 2.5 },
  }, beforeLine);
  if (!map.getLayer('insight-problems-fill')) map.addLayer({
    id: 'insight-problems-fill', type: 'fill', source: 'insight-problems',
    paint: { 'fill-color': ['match', ['get', 'severity'], 'high', '#b42318', 'medium', '#d97706', '#ca8a04'], 'fill-opacity': 0.34 },
  }, beforeLine);
  if (!map.getLayer('insight-problems-line')) map.addLayer({
    id: 'insight-problems-line', type: 'line', source: 'insight-problems',
    paint: { 'line-color': ['match', ['get', 'severity'], 'high', '#991b1b', 'medium', '#a35200', '#854d0e'], 'line-width': 3, 'line-dasharray': [2, 1] },
  }, beforeLine);
  if (!map.getLayer('insight-placements-area')) map.addLayer({
    id: 'insight-placements-area', type: 'fill', source: 'insight-placements',
    filter: ['==', ['get', 'geometry_kind'], 'area'],
    paint: { 'fill-color': '#147d64', 'fill-opacity': 0.42 },
  });
  if (!map.getLayer('insight-placements-area-line')) map.addLayer({
    id: 'insight-placements-area-line', type: 'line', source: 'insight-placements',
    filter: ['==', ['get', 'geometry_kind'], 'area'],
    paint: { 'line-color': '#075e4b', 'line-width': 2 },
  });
  if (!map.getLayer('insight-placements-point')) map.addLayer({
    id: 'insight-placements-point', type: 'circle', source: 'insight-placements',
    filter: ['==', ['get', 'geometry_kind'], 'point'],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['get', 'quantity'], 1, 5, 20, 10],
      'circle-color': '#147d64',
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 2,
    },
  });
}

export function insightPick(properties: Record<string, unknown> | null | undefined): InsightPick | null {
  const values = properties ?? {};
  const kind = values.insight;
  if (kind !== 'problems' && kind !== 'priority' && kind !== 'placements') return null;
  return {
    kind,
    zoneId: typeof values.zone_id === 'string' ? values.zone_id : null,
    scenarioId: typeof values.scenario_id === 'string' ? values.scenario_id : null,
  };
}

export function insightTooltip(properties: Record<string, unknown> | null | undefined): { title: string; detail: string } | null {
  const pick = insightPick(properties);
  if (!pick) return null;
  const values = properties ?? {};
  const title = typeof values.zone_name === 'string'
    ? values.zone_name
    : typeof values.scenario_name === 'string' ? values.scenario_name : 'Результат анализа';
  return { title, detail: typeof values.label === 'string' ? values.label : 'Открыть подробности' };
}
