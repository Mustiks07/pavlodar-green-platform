/**
 * Canonical registries shipped with the contract (contracts/*.json, same SHA as openapi.json).
 * The UI reads them as data; it does not extend or reinterpret them. Russian display labels
 * for units and metrics live in the UI i18n layer, keyed by these machine keys.
 */
import problemCodes from '../../../contracts/problem_codes.json';
import units from '../../../contracts/units.json';
import metricKeys from '../../../contracts/metric_keys.json';

export interface ProblemCodeEntry {
  code: string;
  status: number | null;
  title_ru: string;
}
export interface UnitEntry {
  key: string;
  dimension: string;
  display_decimals: number;
}
export interface MetricKeyEntry {
  key: string;
  unit: string;
  kind: 'flow' | 'stock' | 'state';
  domain: string;
}

export const REGISTRY_VERSION = {
  problemCodes: (problemCodes as { version: string }).version,
  units: (units as { version: string }).version,
  metricKeys: (metricKeys as { version: string }).version,
};

const problemByCode = new Map((problemCodes as { codes: ProblemCodeEntry[] }).codes.map((c) => [c.code, c]));
const unitByKey = new Map((units as { units: UnitEntry[] }).units.map((u) => [u.key, u]));
const metricByKey = new Map((metricKeys as { metrics: MetricKeyEntry[] }).metrics.map((m) => [m.key, m]));

export const problemCodeEntry = (code: string): ProblemCodeEntry | null => problemByCode.get(code) ?? null;
export const unitEntry = (key: string): UnitEntry | null => unitByKey.get(key) ?? null;
export const metricKeyEntry = (key: string): MetricKeyEntry | null => metricByKey.get(key) ?? null;

export const allProblemCodes = (): ProblemCodeEntry[] => [...problemByCode.values()];
export const allUnits = (): UnitEntry[] => [...unitByKey.values()];
export const allMetricKeys = (): MetricKeyEntry[] => [...metricByKey.values()];
