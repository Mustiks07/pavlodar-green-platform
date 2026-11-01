// Read-only acceptance for the mandatory same-camera 3D before/after decision view.
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5173';
const scenarioId = process.env.PG_SCENARIO_ID;
if (!scenarioId) throw new Error('PG_SCENARIO_ID is required');
const credentials = JSON.parse(readFileSync(process.env.PG_TEST_CREDENTIALS ?? '', 'utf8'));
const out = resolve('../../docs/evidence/jury-placement-3d');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: process.env.PG_BROWSER_CHANNEL ?? 'msedge' });
const context = await browser.newContext({ viewport: { width: 1680, height: 1050 }, locale: 'ru-RU' });
const page = await context.newPage();
const pageErrors = [];
const apiErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));
page.on('response', (response) => {
  if (response.url().includes('/v1/') && response.status() >= 500) apiErrors.push(`${response.status()} ${new URL(response.url()).pathname}`);
});

await page.goto(`${BASE}/auth/login`);
await page.locator('#username').fill('specialist');
await page.locator('#password').fill(credentials.specialist);
await page.locator('#kc-login').click();
await page.waitForURL((url) => url.origin === new URL(BASE).origin && !url.pathname.startsWith('/auth/'), { timeout: 25_000 });
const cityId = await page.evaluate(async (id) => (await (await fetch(`/v1/scenarios/${id}`)).json()).city_id, scenarioId);
await page.goto(`${BASE}/projects/${scenarioId}?city=${cityId}`);
const compare = page.locator('.revision-3d-compare');
await compare.waitFor({ timeout: 30_000 });
await page.waitForFunction(() => {
  const value = window.__pgRevisionCompare;
  return value?.left?.isStyleLoaded() && value?.right?.isStyleLoaded();
}, null, { timeout: 30_000 });
await page.waitForTimeout(1200);
const camera = await page.evaluate(() => {
  const { left, right } = window.__pgRevisionCompare;
  left.jumpTo({ center: [76.95256, 52.28824], zoom: 18.1, pitch: 57, bearing: 24 });
  const a = { center: left.getCenter().toArray(), zoom: left.getZoom(), pitch: left.getPitch(), bearing: left.getBearing() };
  const b = { center: right.getCenter().toArray(), zoom: right.getZoom(), pitch: right.getPitch(), bearing: right.getBearing() };
  return { a, b };
});
await page.waitForTimeout(250);
const synced = await page.evaluate(() => {
  const { left, right } = window.__pgRevisionCompare;
  const a = [left.getCenter().lng, left.getCenter().lat, left.getZoom(), left.getPitch(), left.getBearing()];
  const b = [right.getCenter().lng, right.getCenter().lat, right.getZoom(), right.getPitch(), right.getBearing()];
  return a.every((value, index) => Math.abs(value - b[index]) < 1e-7);
});
await compare.scrollIntoViewIfNeeded();
await page.waitForTimeout(350);
await compare.screenshot({ path: resolve(out, 'placement-revision-3d-compare.png') });
const calculation = page.locator('.calc-full').first();
await calculation.scrollIntoViewIfNeeded();
await calculation.screenshot({ path: resolve(out, 'placement-save-full-calculation.png') });
const labels = await compare.locator('.revision-3d-compare__label').allTextContents();
await browser.close();

const passed = synced && labels.some((value) => value.includes('До изменения')) && labels.some((value) => value.includes('После изменения'))
  && pageErrors.length === 0 && apiErrors.length === 0;
console.log(JSON.stringify({ passed, synced, camera, labels, pageErrors, apiErrors }));
process.exit(passed ? 0 : 1);
