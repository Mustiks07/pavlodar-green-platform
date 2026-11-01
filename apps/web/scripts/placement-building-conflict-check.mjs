// Live destructive-only-on-success guard: drag one existing placement onto a real frozen building.
// The expected 422 means no revision is created and the user's draft stays visibly highlighted.
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5173';
const scenarioId = process.env.PG_SCENARIO_ID;
const conflict = [Number(process.env.PG_CONFLICT_LNG), Number(process.env.PG_CONFLICT_LAT)];
if (!scenarioId || conflict.some((value) => !Number.isFinite(value))) throw new Error('PG_SCENARIO_ID and conflict coordinates are required');
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
if (!before.placements.length) throw new Error('No unlocked placement');

await page.goto(`${BASE}/projects/${scenarioId}?city=${before.city}`);
const editor = page.locator('#scenario-placement-editor');
await editor.locator('.pl-map canvas').waitFor({ timeout: 30_000 });
await editor.scrollIntoViewIfNeeded();
await editor.locator('.pl-map__3d button').click();
await page.waitForFunction(() => window.__pgPlacementScene?.state === 'on', null, { timeout: 30_000 });
await page.waitForTimeout(600);
await editor.locator('.pl-map').scrollIntoViewIfNeeded();
await page.waitForTimeout(150);
const points = await page.evaluate(({ to }) => {
  const map = window.__pgPlacementMap;
  const rect = map.getCanvas().getBoundingClientRect();
  const rendered = map.queryRenderedFeatures({ layers: ['pl-circle'] });
  const candidates = rendered.map((feature) => ({ feature, point: map.project(feature.geometry.coordinates) }));
  const chosen = candidates.find(({ point }) => point.x > 30 && point.y > 100 && point.x < rect.width - 30 && point.y < rect.height - 30);
  if (!chosen) throw new Error('No rendered placement hit target');
  const a = chosen.point;
  const b = map.project(to);
  const hit = map.queryRenderedFeatures([[a.x - 8, a.y - 8], [a.x + 8, a.y + 8]], { layers: ['pl-circle'] }).map((feature) => feature.properties?.id);
  const pageX = rect.left + a.x;
  const pageY = rect.top + a.y;
  const roundtrip = map.unproject(b);
  return { id: chosen.feature.properties?.id, hit, roundtrip: [roundtrip.lng, roundtrip.lat], element: document.elementFromPoint(pageX, pageY)?.className ?? null, from: [pageX, pageY], to: [rect.left + b.x, rect.top + b.y] };
}, { to: conflict });
if (!points.hit.includes(points.id)) throw new Error(`Placement hit target is not queryable: ${JSON.stringify(points)}`);
await page.mouse.move(...points.from);
await page.mouse.down();
await page.mouse.move(...points.to, { steps: 18 });
await page.mouse.up();
await page.waitForTimeout(400);
const movedDraft = await page.evaluate(({ scenarioId, conflict }) => {
  const draft = JSON.parse(localStorage.getItem(`pg.scenario-draft.${scenarioId}`) ?? 'null');
  return draft?.edits?.placements?.find((item) => Math.abs(item.position.coordinates[0] - conflict[0]) < 3e-5 && Math.abs(item.position.coordinates[1] - conflict[1]) < 3e-5) ?? null;
}, { scenarioId, conflict });
if (!movedDraft) {
  const dragDebug = await page.evaluate(() => window.__pgPlacementDrag ?? null);
  const pointerDebug = await page.evaluate(() => window.__pgPlacementPointer ?? null);
  throw new Error(`3D drag did not reach target: ${JSON.stringify({ points, movedDraft, conflict, dragDebug, pointerDebug })}`);
}
await page.getByLabel('Комментарий к ревизии').fill('Проверка переноса посадки в объёмном виде');
const saveButton = page.getByRole('button', { name: 'Сохранить новую ревизию' });
await saveButton.waitFor({ state: 'visible' });
await page.waitForTimeout(1200);
if (await saveButton.isDisabled()) {
  const notices = await page.locator('.scn-main .pg-notice, .scn-main [role="alert"]').allInnerTexts();
  throw new Error(`Save stayed disabled after 3D move: ${JSON.stringify(notices)}`);
}
await saveButton.click();
await page.getByText('Посадка пересекает здание', { exact: true }).first().waitFor({ timeout: 20_000 });
const after = await page.evaluate(async (id) => (await (await fetch(`/v1/scenarios/${id}`)).json()).current_revision_id, scenarioId);
const highlighted = await page.waitForFunction(() => {
  const map = window.__pgPlacementMap;
  return map?.querySourceFeatures('pl')?.some((feature) => feature.properties?.conflict === true || feature.properties?.conflict === 1);
}, null, { timeout: 10_000 }).then(() => true).catch(() => false);
await editor.locator('.pl-map').scrollIntoViewIfNeeded();
await page.waitForTimeout(250);
await editor.locator('.pl-map-wrap').screenshot({ path: resolve(out, 'placement-building-conflict-map.png') });
const errorCard = page.getByText('Посадка пересекает здание', { exact: true }).first().locator('..');
await errorCard.scrollIntoViewIfNeeded();
await errorCard.screenshot({ path: resolve(out, 'placement-building-conflict-error.png') });
await browser.close();

const passed = after === before.revision && highlighted && apiErrors.length === 0 && pageErrors.length === 0;
console.log(JSON.stringify({ passed, revisionUnchanged: after === before.revision, highlighted, apiErrors, pageErrors }));
process.exit(passed ? 0 : 1);
