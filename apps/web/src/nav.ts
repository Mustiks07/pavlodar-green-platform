import type { AppKey } from './i18n';

export interface NavItem {
  path: string;
  label: AppKey;
  icon: string;
  group: AppKey;
  /** Routes can stay addressable and breadcrumb-aware without crowding the permanent sidebar. */
  sidebar?: boolean;
  requiredRole?: 'specialist' | 'admin';
}

/** Information architecture: every working screen from TZ §22, grouped by user route A–D. */
export const NAV: NavItem[] = [
  { path: '/', label: 'nav.map', icon: 'map', group: 'nav.group.city' },
  { path: '/problems', label: 'nav.problems', icon: 'alertMap', group: 'nav.group.city' },
  { path: '/program', label: 'nav.program', icon: 'target', group: 'nav.group.city' },
  { path: '/projects', label: 'nav.projects', icon: 'sprout', group: 'nav.group.project' },
  { path: '/compare', label: 'nav.compare', icon: 'compare', group: 'nav.group.project' },
  { path: '/catalog', label: 'nav.catalog', icon: 'book', group: 'nav.group.project' },
  { path: '/execution', label: 'nav.execution', icon: 'calendar', group: 'nav.group.ops' },
  { path: '/imports', label: 'nav.imports', icon: 'upload', group: 'nav.group.data', sidebar: false, requiredRole: 'specialist' },
  { path: '/reference', label: 'nav.reference', icon: 'table', group: 'nav.group.data', sidebar: false },
  { path: '/sources', label: 'nav.sources', icon: 'database', group: 'nav.group.data' },
  { path: '/admin', label: 'nav.admin', icon: 'shield', group: 'nav.group.data', requiredRole: 'admin' },
];
