import { describe, expect, it } from 'vitest';
import { zonedIso } from './queries';

describe('zonedIso', () => {
  it('formats wall-clock time with the city offset (request only, no sun maths)', () => {
    expect(zonedIso('2026-06-21', '13:00', 'Asia/Almaty')).toMatch(/^2026-06-21T13:00:00\+0[56]:00$/);
    expect(zonedIso('2026-01-15', '08:30', 'UTC')).toBe('2026-01-15T08:30:00+00:00');
    expect(zonedIso('2026-07-01', '12:00', 'Europe/Berlin')).toBe('2026-07-01T12:00:00+02:00');
    expect(zonedIso('2026-01-01', '12:00', 'Europe/Berlin')).toBe('2026-01-01T12:00:00+01:00');
  });
});
