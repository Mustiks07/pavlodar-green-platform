export const GROWTH_YEARS = [0, 1, 3, 5, 10, 20] as const;
export type GrowthYear = (typeof GROWTH_YEARS)[number];

/**
 * Presentation-only scale used when the frozen catalog has no admitted age curve.
 * It must never be used by calculations, reports or factual dimensions.
 */
export function illustrativeGrowthScale(year: GrowthYear): number {
  return ({ 0: 1, 1: 1.08, 3: 1.2, 5: 1.32, 10: 1.55, 20: 1.8 } as const)[year];
}

export function growthYearFromUrl(value: string | null): GrowthYear {
  const numeric = Number(value);
  return GROWTH_YEARS.includes(numeric as GrowthYear) ? numeric as GrowthYear : 0;
}
