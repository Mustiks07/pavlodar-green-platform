import { describe, expect, it } from 'vitest';
import { isProductMapLayer, productLabel } from './productCopy';

describe('product copy', () => {
  it('removes test vocabulary and assigns stable product names', () => {
    expect(productLabel('SYNTHETIC TEST · Оценочный профиль MVP · проектные правила')).toBe('Проектные правила');
    expect(productLabel('SYNTHETIC TEST: увеличить количество')).toBe('увеличить количество');
  });

  it('keeps calculation-only test inputs off the product map', () => {
    expect(isProductMapLayer({ name: 'Оценочный профиль MVP · проектные правила', category: 'restrictions' })).toBe(false);
    expect(isProductMapLayer({ name: 'Здания Павлодара', category: 'building' })).toBe(true);
  });
});
