import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';
import '@pg/ui';
import './app.css';
import { queryClient } from './api';
import { router } from './routes';
import { prefetchRoute } from './routeLoaders';
import { applyTheme, useUi } from './shell/ui-store';
import { registerOfflineShell, syncOnlineManager } from './shell/offline';

applyTheme(useUi.getState().theme);
syncOnlineManager();
registerOfflineShell();

// Landing on the map: start fetching its chunk (and MapLibre) before React mounts, so the map
// download overlaps the session/city requests instead of waiting for the first render (P-01).
if (window.location.pathname === '/') prefetchRoute('/');

if (import.meta.env.DEV) (window as unknown as { __pgQuery?: typeof queryClient }).__pgQuery = queryClient;

const root = document.getElementById('root');
if (!root) throw new Error('#root element is missing from index.html');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
