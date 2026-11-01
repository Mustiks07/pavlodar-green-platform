// One deliberate live demo mutation: a valid 3D move creates an immutable revision and queues
// the full server calculation through the combined specialist action.
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5173';
const scenarioId = process.env.PG_SCENARIO_ID;
const target = [Number(process.env.PG_TARGET_LNG), Number(process.env.PG_TARGET_LAT)];
if (!scenarioId || target.some((value) => !Number.isFinite(value))) throw new Error('Scenario and target coordinates are required');
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
const before = await page.evaluate(async (id) => {
  const scenario = await (await fetch(`/v1/scenarios/${id}`)).json();
  const revision = await (await fetch(`/v1/scenario-revisions/${scenario.current_revision_id}`)).json();
  return { city: scenario.city_id, revision: scenario.current_revision_id, placements: revision.placements.filter((item) => !item.locked) };
}, scenarioId);
const moving = [...before.placements].sort((a, b) => {
  const da = Math.hypot(a.position.coordinates[0] - target[0], a.position.coordinates[1] - target[1]);
  const db = Math.hypot(b.position.coordinates[0] - target[0], b.position.coordinates[1] - target[1]);
  return da - db;
})[0];
if (!moving) throw new Error('No movable placement');

await page.goto(`${BASE}/projects/${scenarioId}?city=${before.city}`);
const editor = page.locator('#scenario-placement-editor');
await editor.locator('.pl-map canvas').waitFor({ timeout: 30_000 });
await editor.locator('.pl-map__3d button').click();
await page.waitForFunction(() => window.__pgPlacementScene?.state === 'on', null, { timeout: 30_000 });
await page.waitForTimeout(600);
await editor.locator('.pl-map').scrollIntoViewIfNeeded();
await page.waitForTimeout(150);
const points = await page.evaluate(({ from, to }) => {
  const map = window.__pgPlacementMap;
  const rect = map.getCanvas().getBoundingClientRect();
  const a = map.project(from);
  const b = map.project(to);
  return { from: [rect.left + a.x, rect.top + a.y], to: [rect.left + b.x, rect.top + b.y] };
}, { from: moving.position.coordinates, to: target });
await page.mouse.move(...points.from);
await page.mouse.down();
await page.mouse.move(...points.to, { steps: 18 });
await page.mouse.up();
await page.waitForFunction(({ id, target }) => {
  const scenarioId = new URLSearchParams(location.search).get('scenarioCheck') ?? location.pathname.split('/').at(-1);
  const draft = JSON.parse(localStorage.getItem(`pg.scenario-draft.${scenarioId}`) ?? 'null');
  const placement = draft?.edits?.placements?.find((item) => item.id === id);
  return placement && Math.abs(placement.position.coordinates[0] - target[0]) < 3e-5 && Math.abs(placement.position.coordinates[1] - target[1]) < 3e-5;
}, { id: moving.id, target }, { timeout: 10_000 });
await page.getByLabel('Комментарий к ревизии').fill('Перенос дерева в 3D после проверки ограничений');
await page.getByRole('button', { name: 'Сохранить и пересчитать' }).click();
await page.waitForFunction(() => new URLSearchParams(location.search).has('calcJob'), null, { timeout: 20_000 });
const jobId = await page.evaluate(() => new URLSearchParams(location.search).get('calcJob'));
let job = null;
const jobDeadline = Date.now() + 120_000;
while (Date.now() < jobDeadline) {
  job = await page.evaluate(async (id) => {
    const body = await (await fetch(`/v1/jobs/${id}`)).json();
    return body.data ?? body;
  }, jobId);
  if (['succeeded', 'failed', 'cancelled'].includes(job.state)) break;
  await page.waitForTimeout(800);
}
if (!job) throw new Error('Calculation job was not returned');
if (job.state !== 'succeeded') throw new Error(`Calculation job ended as ${job.state}`);
await page.waitForFunction((id) => new URLSearchParams(location.search).get('calc') === id, job.result_ref_id, { timeout: 20_000 });
const after = await page.evaluate(async (id) => {
  const scenario = await (await fetch(`/v1/scenarios/${id}`)).json();
  const revision = await (await fetch(`/v1/scenario-revisions/${scenario.current_revision_id}`)).json();
  return { revision: scenario.current_revision_id, parent: revision.parent_revision_id, placements: revision.placements };
}, scenarioId);
await page.locator('.calc-full').first().scrollIntoViewIfNeeded();
await page.waitForTimeout(300);
await page.locator('.calc-full').first().screenshot({ path: resolve(out, 'placement-save-full-calculation.png') });
await browser.close();

const moved = after.placements.find((item) => item.id === moving.id);
const passed = after.revision !== before.revision
  && after.parent === before.revision
  && moved && Math.abs(moved.position.coordinates[0] - target[0]) < 3e-5
  && job.result_ref_id
  && apiErrors.length === 0 && pageErrors.length === 0;
console.log(JSON.stringify({ passed, before: before.revision, after: after.revision, snapshot: job.result_ref_id, apiErrors, pageErrors }));
process.exit(passed ? 0 : 1);
