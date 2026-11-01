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
  for (const scenario of scenarios) {
    const revision = await (await fetch(`/v1/scenario-revisions/${scenario.current_revision_id}`)).json();
    if (revision.placements?.length) return { city: city.id, scenario: scenario.id, placements: revision.placements.length };
  }
  return null;
});
if (!ids) throw new Error('No scenario with placements');
await page.goto(`${BASE}/projects/${ids.scenario}?city=${ids.city}`);
const editor = page.locator('#scenario-placement-editor');
await editor.locator('.pl-map canvas').waitFor({ timeout: 30_000 });
await editor.scrollIntoViewIfNeeded();
await editor.locator('.pl-map__3d button').click();
await page.waitForFunction((count) => window.__pgPlacementScene?.state === 'on' && window.__pgPlacementScene?.stats()?.plantings === count, ids.placements, { timeout: 30_000 });
await page.waitForTimeout(500);
await editor.screenshot({ path: resolve(out, 'placement-editor-3d.png') });
const stats = await page.evaluate(() => window.__pgPlacementScene?.stats() ?? null);
await browser.close();

const passed = stats?.plantings === ids.placements && stats?.drawCalls > 0 && apiErrors.length === 0 && pageErrors.length === 0;
console.log(JSON.stringify({ passed, placements: ids.placements, stats, apiErrors, pageErrors }));
process.exit(passed ? 0 : 1);
