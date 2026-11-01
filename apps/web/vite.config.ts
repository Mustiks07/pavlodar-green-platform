/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// packages/ui and packages/api-client are consumed as source until WP-00 adds a root
// workspace. `dedupe` makes bare imports from those folders resolve to this app's deps.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiOrigin = env.PG_API_ORIGIN || 'http://127.0.0.1:8001';
  const contract = JSON.parse(readFileSync(r('../../contracts/openapi.json'), 'utf8')) as { info: { version: string } };
  const proxy = { target: apiOrigin, changeOrigin: false, xfwd: true };
  return {
    // A second dev server (isolated browser runs) needs its own dependency cache.
    ...(env.PG_VITE_CACHE_DIR ? { cacheDir: env.PG_VITE_CACHE_DIR } : {}),
    plugins: [react()],
    define: {
      __CONTRACT_VERSION__: JSON.stringify(contract.info.version),
      // Versions the offline shell cache: every build gets a fresh shell, hashed assets stay.
      __BUILD_ID__: JSON.stringify(`${contract.info.version}-${Date.now().toString(36)}`),
    },
    resolve: {
      alias: {
        '@pg/ui': r('../../packages/ui/src'),
        '@pg/api-client': r('../../packages/api-client/src'),
        '@contracts': r('../../contracts'),
      },
      dedupe: ['react', 'react-dom', 'openapi-fetch', 'maplibre-gl'],
    },
    server: {
      port: 5173,
      strictPort: true,
      fs: { allow: [r('../..')] },
      // Same-origin BFF in dev: browser talks only to Vite, Vite forwards to the API.
      proxy: { '/v1': proxy, '/auth': proxy, '/health': proxy, '/openapi.json': proxy },
    },
    preview: { port: 4173, proxy: { '/v1': proxy, '/auth': proxy, '/health': proxy, '/openapi.json': proxy } },
    // MapLibre builds its worker from stringified code: lowering class fields below
    // ES2022 injects an esbuild helper the worker cannot see (__publicField is not defined).
    optimizeDeps: { esbuildOptions: { target: 'es2022' } },
    esbuild: { target: 'es2022' },
    build: {
      target: 'es2022',
      sourcemap: true,
      chunkSizeWarningLimit: 1100,
      rollupOptions: {
        output: {
          // Vendor code changes rarely: separate chunks stay cached across app releases.
          // MapLibre is only reachable from the lazy map route, so it never blocks other pages.
          manualChunks(id) {
            if (id.includes('/node_modules/maplibre-gl/')) return 'maplibre';
            if (/\/node_modules\/(react|react-dom|scheduler|react-router)\//.test(id)) return 'react';
            if (id.includes('/node_modules/@tanstack/')) return 'query';
            return undefined;
          },
        },
      },
    },
    test: {
      environment: 'jsdom',
      include: ['src/**/*.test.{ts,tsx}', '../../packages/*/src/**/*.test.{ts,tsx}'],
    },
  };
});
