import { describe, expect, it } from 'vitest';
import type { DetectedProblem, PriorityResult, Scenario, ScenarioRevision, Zone } from '@pg/api-client';
import { insightPick, insightTooltip, placementCollection, priorityCollection, problemCollection } from './MapInsightLayers';

const zone = {
  id: 'zone-1',
  name: 'Сквер',
  geometry: { type: 'Polygon', coordinates: [[[76.9, 52.2], [76.91, 52.2], [76.91, 52.21], [76.9, 52.2]]] },
} as unknown as Zone;

describe('map analytical layers', () => {
  it('shows only active problems and keeps the highest severity for a zone', () => {
    const problem = (status: string, severity: string) => ({
      zone_id: zone.id,
      status,
      severity,
      description: `${severity} problem`,
    }) as unknown as DetectedProblem;
    const result = problemCollection([
      problem('open', 'medium'),
      problem('acknowledged', 'high'),
      problem('dismissed', 'high'),
    ], [zone]);
    expect(result.features).toHaveLength(1);
    expect(result.features[0]?.properties).toMatchObject({ severity: 'high', count: 2, zone_name: 'Сквер' });
  });

  it('joins a calculated score to canonical zone geometry', () => {
    const result = priorityCollection({
      zones: [{ zone_id: zone.id, score: 82.5, data_coverage: 0.75, contributions: [] }],
    } as unknown as PriorityResult, [zone]);
    expect(result.features[0]?.properties).toMatchObject({ score: 82.5, coverage: 75, rank: 1 });
    expect(result.features[0]?.geometry).toEqual(zone.geometry);
  });

  it('creates clickable point and area features from the selected scenario revision', () => {
    const scenario = { id: 'scenario-1', zone_id: zone.id, name: 'Проект сквера' } as unknown as Scenario;
    const revision = {
      placements: [{ id: 'planting-1', position: { type: 'Point', coordinates: [76.9, 52.2] }, quantity: 8 }],
      area_patches: [{ id: 'patch-1', geometry: zone.geometry, density_plants_per_m2: 2 }],
    } as unknown as ScenarioRevision;
    const result = placementCollection(revision, scenario);
    expect(result.features).toHaveLength(2);
    expect(insightPick(result.features[1]?.properties)).toEqual({ kind: 'placements', zoneId: zone.id, scenarioId: scenario.id });
    expect(insightTooltip(result.features[1]?.properties)).toEqual({ title: scenario.name, detail: '8 шт. в проекте «Проект сквера»' });
  });
});
