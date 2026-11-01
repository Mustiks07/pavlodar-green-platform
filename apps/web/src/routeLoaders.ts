/**
 * Dynamic imports for route chunks. Kept apart from routes.tsx so navigation can prefetch a
 * section on hover/focus without importing the router (and without circular imports).
 * Each loader is memoised by the module system: calling it twice fetches once.
 */
export const loadMap = () => import('./features/map/MapWorkspace');
export const loadLists = () => import('./pages/lists');
export const loadScenario = () => import('./features/scenarios/ScenarioPage');
export const loadMisc = () => import('./pages/misc');

const BY_PATH: Record<string, () => Promise<unknown>> = {
  '/': loadMap,
  '/problems': loadLists,
  '/program': loadLists,
  '/projects': loadLists,
  '/catalog': loadLists,
  '/execution': loadLists,
  '/imports': loadLists,
  '/reference': loadLists,
  '/sources': loadLists,
  '/admin': loadLists,
  '/compare': loadMisc,
};

/** Best-effort prefetch; a failure here is ignored and surfaces only when the route renders. */
export function prefetchRoute(path: string) {
  const load = BY_PATH[path];
  if (load) void load().catch(() => undefined);
}
