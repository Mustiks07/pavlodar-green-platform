import { describe, expect, it } from 'vitest';
import type { Placement } from '@pg/api-client';
import { buildRecommendationRequest } from './RecommendationPanel';

const placement = (plantId: string, locked: boolean): Placement => ({
  id: crypto.randomUUID(),
  plant_id: plantId,
  stock_item_id: null,
  position: { type: 'Point', coordinates: [76.95, 52.28] },
  quantity: 1,
  planting_date: '2027-04-15',
  locked,
  initial_height_m: null,
  initial_crown_radius_m: null,
  dimension_basis: 'unknown',
});

describe('buildRecommendationRequest', () => {
  it('preserves exclusions, sends unique locked plants and sourced ranking factors', () => {
    const locked = crypto.randomUUID();
    const excluded = crypto.randomUUID();
    const request = buildRecommendationRequest({
      zoneVersionId: crypto.randomUUID(),
      catalogVersionId: crypto.randomUUID(),
      ruleVersionId: crypto.randomUUID(),
      topN: 5,
      excludedPlantIds: [excluded, excluded],
      placements: [placement(locked, true), placement(locked, true), placement(excluded, true)],
    });
    expect(request.top_n).toBe(5);
    expect(request.excluded_plant_ids).toEqual([excluded]);
    expect(request.locked_plant_ids).toEqual([locked]);
    expect(request.weights.map((item) => item.factor)).toEqual(['hardiness_fit', 'moisture_fit', 'salt_fit', 'wind_fit', 'light_fit']);
    expect(request.weights.every((item) => item.weight > 0)).toBe(true);
  });
});
