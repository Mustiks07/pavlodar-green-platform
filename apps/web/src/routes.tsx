import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { createBrowserRouter, isRouteErrorResponse, Outlet, useRouteError } from 'react-router';
import { Button, StateView } from '@pg/ui';
import { t } from './i18n';
import { AppShell } from './shell/AppShell';
import { SessionProvider } from './shell/session';
import { loadLists, loadMap, loadMisc, loadScenario } from './routeLoaders';

// Every page is a lazy chunk: the shell renders first, MapLibre loads only with the map route,
// list/scenario/import pages only when opened (P-01, bundle split).
const pick = <M, K extends keyof M>(load: () => Promise<M>, key: K) =>
  lazy(async () => ({ default: (await load())[key] as unknown as ComponentType }));

const MapWorkspace = pick(loadMap, 'MapWorkspace');
const ProblemsPage = pick(loadLists, 'ProblemsPage');
const ProgramsPage = pick(loadLists, 'ProgramsPage');
const ProjectsPage = pick(loadLists, 'ProjectsPage');
const CatalogPage = pick(loadLists, 'CatalogPage');
const ExecutionPage = pick(loadLists, 'ExecutionPage');
const ImportsPage = pick(loadLists, 'ImportsPage');
const ReferencePage = pick(loadLists, 'ReferencePage');
const SourcesPage = pick(loadLists, 'SourcesPage');
const AdminPage = pick(loadLists, 'AdminPage');
const ScenarioPage = pick(loadScenario, 'ScenarioPage');
const ComparePage = pick(loadMisc, 'ComparePage');
const NotFoundPage = pick(loadMisc, 'NotFoundPage');

// The design-system gallery and 3D harness use synthetic fixtures: dev builds only.
const UiGallery = import.meta.env.DEV ? lazy(() => import('./dev/UiGallery')) : null;
const Scene3DHarness = import.meta.env.DEV ? lazy(() => import('./dev/Scene3DHarness')) : null;

function Page({ children }: { children: ReactNode }) {
  return <Suspense fallback={<StateView state="loading" title={t('route.loading')} />}>{children}</Suspense>;
}

/** Shown when a route chunk cannot be loaded (offline, or a new deployment replaced it). */
function RouteError() {
  const error = useRouteError();
  const message = error instanceof Error ? error.message : isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : String(error);
  const chunk = /dynamically imported module|Importing a module script failed|error loading dynamically|Failed to fetch/i.test(message);
  return (
    <StateView
      state="error"
      title={chunk ? t('route.chunkFailed') : t('route.failed')}
      description={chunk ? t('route.chunkFailed.desc') : t('route.failed.desc')}
      actions={
        <Button icon="refresh" onClick={() => window.location.reload()}>
          {t('route.reload')}
        </Button>
      }
      details={<code className="pg-code">{message}</code>}
    />
  );
}

function Root() {
  return (
    <SessionProvider>
      <Outlet />
    </SessionProvider>
  );
}

const page = (path: string, el: ReactNode) => ({ path, element: <Page>{el}</Page>, errorElement: <RouteError /> });

export const router = createBrowserRouter([
  {
    element: <Root />,
    children: [
      {
        element: <AppShell />,
        children: [
          { index: true, element: <Page><MapWorkspace /></Page>, errorElement: <RouteError /> },
          page('problems', <ProblemsPage />),
          page('program', <ProgramsPage />),
          page('projects', <ProjectsPage />),
          page('projects/:scenarioId', <ScenarioPage />),
          page('compare', <ComparePage />),
          page('catalog', <CatalogPage />),
          page('execution', <ExecutionPage />),
          page('imports', <ImportsPage />),
          page('reference', <ReferencePage />),
          page('sources', <SourcesPage />),
          page('admin', <AdminPage />),
          ...(UiGallery ? [page('dev/ui', <UiGallery />)] : []),
          ...(Scene3DHarness ? [page('dev/3d', <Scene3DHarness />)] : []),
          page('*', <NotFoundPage />),
        ],
      },
    ],
  },
]);
