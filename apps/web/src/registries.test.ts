import { describe, expect, it } from 'vitest';
import { allMetricKeys, allProblemCodes, allUnits, metricKeyEntry, problemCodeEntry, REGISTRY_VERSION, unitEntry } from '@pg/api-client';
import { UNIT_LABEL_KEYS, unitLabel } from '@pg/ui';
import { appRu } from './i18n';

describe('contract registries 1.16.0 vs UI', () => {
  it('reads registries of the same contract version', () => {
    expect(REGISTRY_VERSION).toEqual({ problemCodes: '1.16.0', units: '1.16.0', metricKeys: '1.16.0' });
  });
  it('every registered unit has a Russian label and registry decimals', () => {
    for (const u of allUnits()) {
      expect(UNIT_LABEL_KEYS, `label for unit ${u.key}`).toContain(u.key);
      expect(unitLabel(u.key)).toMatchObject({ known: true, decimals: u.display_decimals });
    }
  });
  it('every metric key uses a registered unit and has a Russian label', () => {
    for (const m of allMetricKeys()) {
      expect(unitEntry(m.unit), `unit of ${m.key}`).not.toBeNull();
      expect(Object.keys(appRu), `label for metric ${m.key}`).toContain(`metric.${m.key}`);
    }
    expect(metricKeyEntry('co2_sequestered')).toMatchObject({ unit: 't_CO2_per_year', kind: 'flow' });
  });
  it('problem codes carry Russian titles; unknown units are flagged, not hidden', () => {
    expect(allProblemCodes().every((c) => c.title_ru.length > 0)).toBe(true);
    expect(problemCodeEntry('revision_conflict')).toMatchObject({ status: 412 });
    expect(problemCodeEntry('no_such_code')).toBeNull();
    expect(unitLabel('piece')).toMatchObject({ label: 'шт.', known: true, decimals: 0 });
    expect(unitLabel('furlong')).toMatchObject({ label: 'furlong', known: false, decimals: null });
  });
});
