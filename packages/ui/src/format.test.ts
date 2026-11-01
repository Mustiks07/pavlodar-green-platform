import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime, formatMoney, formatProbability, unitLabel } from './format';

const nb = ' ';

describe('formatMoney', () => {
  it('regroups a decimal string without floating point', () => {
    expect(formatMoney('12500.00')).toBe(`12${nb}500,00${nb}₸`);
    expect(formatMoney('9007199254740993.01')).toBe(`9${nb}007${nb}199${nb}254${nb}740${nb}993,01${nb}₸`);
    expect(formatMoney('0.10', { currency: false })).toBe('0,10');
  });
  it('rejects non-canonical money instead of guessing', () => {
    expect(formatMoney('12.5')).toBeNull();
    expect(formatMoney('-1.00')).toBeNull();
    expect(formatMoney('01.00')).toBeNull();
  });
  it('keeps null as missing, never zero', () => {
    expect(formatMoney(null)).toBeNull();
  });
});

describe('formatProbability', () => {
  it('formats 0..1 as percent', () => {
    expect(formatProbability(0.684)?.replace(/\s/g, ' ')).toBe('68 %');
  });
  it('refuses out-of-range or null', () => {
    expect(formatProbability(1.2)).toBeNull();
    expect(formatProbability(null)).toBeNull();
  });
});

describe('dates', () => {
  it('shows UTC timestamps in the city timezone', () => {
    // 2026-10-29T19:30Z is 30.10 00:30 in Asia/Almaty (UTC+5).
    expect(formatDateTime('2026-10-29T19:30:00Z', 'Asia/Almaty')).toBe('30.10.2026, 00:30');
  });
  it('does not shift calendar dates by timezone', () => {
    expect(formatDate('2026-03-01')).toBe('01.03.2026');
  });
});

describe('unitLabel', () => {
  it('maps machine keys and reports unknown ones', () => {
    expect(unitLabel('m2')).toEqual({ label: 'м²', known: true, decimals: 0 });
    expect(unitLabel('score_100')).toEqual({ label: 'из 100', known: true, decimals: 0 });
    expect(unitLabel('furlong')).toEqual({ label: 'furlong', known: false, decimals: null });
  });
});
