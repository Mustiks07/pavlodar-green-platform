// Read-only authenticated acceptance for project placements inside the existing 3D editor.
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5173';
const credentials = JSON.parse(readFileSync(process.env.PG_TEST_CREDENTIALS ?? '', 'utf8'));
const out = resolve('../../docs/evidence/jury-placement-3d');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: process.env.PG_BROWSER_CHANNEL ?? 'msedge' });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'ru-RU' });
const page = await context.newPage();
const apiErrors = [];
const pageErrors = [];
page.on('response', (response) => {
  if (response.url().includes('/v1/') && response.status() >= 500) apiErrors.push(`${response.status()} ${new URL(response.url()).pathname}`);
});
page.on('pageerror', (error) => pageErrors.push(String(error)));

await page.goto(`${BASE}/auth/login`);
await page.locator('#username').fill('specialist');
await page.locator('#password').fill(credentials.specialist);
await page.locator('#kc-login').click();
await page.waitForURL((url) => url.origin === new URL(BASE).origin && !url.pathname.startsWith('/auth/'), { timeout: 25_000 });
const ids = await page.evaluate(async () => {
  const city = (await (await fetch('/v1/cities')).json()).items[0];
  const scenarios = (await (await fetch(`/v1/scenarios?city_id=${city.id}&limit=100`)).json()).items;
  const layers = (await (await fetch(`/v1/map/layers?city_id=${city.id}&limit=200`)).json()).items;
  const buildingVersions = new Set(layers.filter((layer) => layer.category === 'building').map((layer) => layer.dataset_version_id));
  let fallback = null;
  for (const scenario of scenarios) {
    const revision = await (await fetch(`/v1/scenario-revisions/${scenario.current_revision_id}`)).json();
    if (!revision.placements?.length) continue;
    const candidate = {
      city: city.id,
      scenario: scenario.id,
      placements: revision.placements.length,
      datasetVersionIds: revision.dataset_version_ids,
      matchedBuildingVersions: revision.dataset_version_ids.filter((id) => buildingVersions.has(id)),
    };
    if (candidate.matchedBuildingVersions.length) return candidate;
    fallback ??= candidate;
  }
  return fallback;
});
if (!ids) throw new Error('No scenario with placements');
await page.goto(`${BASE}/projects/${ids.scenario}?city=${ids.city}`);
const editor = page.locator('#scenario-placement-editor');
await editor.locator('.pl-map canvas').waitFor({ timeout: 30_000 });
await editor.scrollIntoViewIfNeeded();
await editor.locator('.pl-map__3d button').click();
await page.waitForFunction((count) => window.__pgPlacementScene?.state === 'on' && window.__pgPlacementScene?.stats()?.plantings === count, ids.placements, { timeout: 30_000 });
if (ids.matchedBuildingVersions.length) {
  try {
    await page.waitForFunction(() => {
      const map = window.__pgPlacementMap;
      return map?.getStyle().layers?.some((layer) => layer.type === 'fill-extrusion' && layer.id.startsWith('pgl-'));
    }, null, { timeout: 30_000 });
  } catch {
    // Keep collecting diagnostics below; the final assertion will fail with useful state.
  }
}
await page.waitForTimeout(900);
await page.screenshot({ path: resolve(out, 'placement-editor-3d.png') });
const state = await page.evaluate(() => {
  const map = window.__pgPlacementMap;
  const extrusions = map?.getStyle().layers?.filter((layer) => layer.type === 'fill-extrusion').map((layer) => layer.id) ?? [];
  const exactExtrusions = extrusions.filter((id) => id.startsWith('pgl-'));
  return {
    stats: window.__pgPlacementScene?.stats() ?? null,
    extrusions,
    renderedBuildings: exactExtrusions.length ? map.queryRenderedFeatures({ layers: exactExtrusions }).length : 0,
  };
});
await browser.close();

const exactExtrusions = state.extrusions.filter((id) => id.startsWith('pgl-'));
const passed = state.stats?.plantings === ids.placements && state.stats?.drawCalls > 0
  && (ids.matchedBuildingVersions.length === 0 || (exactExtrusions.length > 0 && state.renderedBuildings > 0))
  && apiErrors.length === 0 && pageErrors.length === 0;
console.log(JSON.stringify({ passed, placements: ids.placements, ...state, apiErrors, pageErrors }));
process.exit(passed ? 0 : 1);
