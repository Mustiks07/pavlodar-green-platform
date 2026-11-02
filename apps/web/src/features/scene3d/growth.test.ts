import { describe, expect, it } from 'vitest';
import { GROWTH_YEARS, growthYearFromUrl, illustrativeGrowthScale } from './growth';

describe('illustrative 3D growth', () => {
  it('offers exactly the required discrete horizons and grows monotonically', () => {
    expect(GROWTH_YEARS).toEqual([0, 1, 3, 5, 10, 20]);
    const scales = GROWTH_YEARS.map(illustrativeGrowthScale);
    expect(scales[0]).toBe(1);
    expect(scales.every((value, index) => index === 0 || value > scales[index - 1]!)).toBe(true);
  });

  it('accepts only admitted URL values', () => {
    expect(growthYearFromUrl('10')).toBe(10);
    expect(growthYearFromUrl('2')).toBe(0);
    expect(growthYearFromUrl(null)).toBe(0);
  });
});
