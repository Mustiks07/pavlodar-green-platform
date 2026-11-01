// Live end-to-end for zone drawing/editing against the real API:
// draw with the mouse -> reload keeps the unsaved contour -> createZone -> keyboard drawing ->
// self-intersection preview -> edit (drag vertex, insert via midpoint) -> updateZone with If-Match ->
// concurrent edit -> 412 -> keep my contour -> save -> scenario on old geometry offers explicit re-bind.
// Creates only SYNTHETIC TEST zones/scenarios.
//
//   PG_TEST_CREDENTIALS=<ignored local test-credentials.json> node scripts/zone-draw-check.mjs
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sessionCookie } from './lib/session-login.mjs';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5173';
const OUT = resolve('../../docs/evidence/wp04-zone-drawing');
const creds = JSON.parse(readFileSync(process.env.PG_TEST_CREDENTIALS ?? '', 'utf8'));
mkdirSync(OUT, { recursive: true });

const report = { base: BASE, startedAt: new Date().toISOString(), checks: [], shots: [] };
const check = (name, pass, detail) => {
  report.checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
};
const shot = async (page, file) => {
  await page.screenshot({ path: join(OUT, file) });
  report.shots.push(`docs/evidence/wp04-zone-drawing/${file}`);
};
const settle = (page) =>
  page.waitForFunction(() => !document.querySelector('.pg-state .pg-spinner, .pg-skeleton'), null, { timeout: 15_000 }).catch(() => {});

const apiCall = (page, method, path, body, extra = {}) =>
  page.evaluate(
    async ({ method, path, body, extra }) => {
      const me = await (await fetch('/v1/me')).json();
      const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token, 'Idempotency-Key': crypto.randomUUID(), ...extra };
      const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, etag: res.headers.get('ETag'), body: await res.json().catch(() => null) };
    },
    { method, path, body, extra },
  );

const browser = await chromium.launch({ channel: process.env.PG_BROWSER_CHANNEL ?? 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'ru-RU' });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(String(e)));

// Login (specialist)
if (await sessionCookie(ctx, 'specialist', BASE)) {
  await page.goto(BASE + '/');
} else {
  await page.goto(BASE + '/');
  const btn = page.getByRole('button', { name: 'Войти через корпоративную учётную запись' }).first();
  await btn.waitFor({ timeout: 15_000 });
  await Promise.all([page.waitForURL(/openid-connect\/auth/, { waitUntil: 'commit', timeout: 20_000 }), btn.click()]);
  await page.waitForSelector('#username');
  await page.fill('#username', 'specialist');
  await page.fill('#password', creds.specialist);
  await page.click('#kc-login');
  await page.waitForURL((u) => u.origin === new URL(BASE).origin && !u.pathname.startsWith('/auth/'), { waitUntil: 'commit', timeout: 20_000 });
}
await page.waitForTimeout(2500);
const city = (await page.evaluate(async () => (await fetch('/v1/cities')).json())).items[0];
const zonesBefore = (await page.evaluate(async (id) => (await fetch(`/v1/zones?city_id=${id}&limit=200`)).json(), city.id)).items.length;

// Start at a known camera near the city centre so pixel offsets stay inside the boundary.
const ring = city.boundary.type === 'Polygon' ? city.boundary.coordinates[0] : city.boundary.coordinates[0][0];
const cx = (Math.min(...ring.map((c) => c[0])) + Math.max(...ring.map((c) => c[0]))) / 2;
const cy = (Math.min(...ring.map((c) => c[1])) + Math.max(...ring.map((c) => c[1]))) / 2;
await page.goto(`${BASE}/?city=${city.id}&ll=${cx.toFixed(5)},${cy.toFixed(5)}&z=15.5`);
await settle(page);
await page.waitForTimeout(1200);
const box = await page.locator('.map-canvas').boundingBox();
const at = (dx, dy) => [box.x + box.width / 2 + dx, box.y + box.height / 2 + dy];
const waitHandles = (role, n) =>
  page.waitForFunction(
    ({ role, n }) => (window.__pgMap?.querySourceFeatures('draw') ?? []).filter((f) => f.properties.role === role).length >= n,
    { role, n },
    { timeout: 10_000 },
  );
const vertexPx = (i) =>
  page.evaluate((i) => {
    const m = window.__pgMap;
    const f = m.querySourceFeatures('draw').find((x) => x.properties.role === 'vertex' && x.properties.i === i);
    const p = m.project(f.geometry.coordinates);
    const r = m.getCanvas().getBoundingClientRect();
    return [r.left + p.x, r.top + p.y];
  }, i);

// 1. Mouse drawing
await page.getByRole('button', { name: 'Нарисовать новый участок' }).click();
for (const [dx, dy] of [[-90, -60], [90, -60], [90, 60], [-90, 60]]) {
  await page.mouse.click(...at(dx, dy));
  await page.waitForTimeout(150);
}
await page.mouse.click(...at(-90, -60)); // first vertex closes
await page.waitForTimeout(300);
const status1 = await page.locator('.draw-status').innerText();
check('mouse: 4 vertices placed and ring closed by clicking the first vertex', status1.includes('контур замкнут') && status1.includes('4'), { status1 });
await shot(page, 'draw-closed.png');

// 2. Reload keeps the unsaved contour (local, labelled)
await page.reload();
await settle(page);
await page.waitForTimeout(800);
const restored = await page.getByText('Восстановлен несохранённый контур').isVisible().catch(() => false);
const status2 = await page.locator('.draw-status').innerText().catch(() => '');
check('reload restores the unsaved contour with a local-only label', restored && status2.includes('замкнут'), { status2 });

// 3. Save -> createZone; area comes from the server
const zoneName = `SYNTHETIC TEST участок ${new Date().toISOString().slice(11, 19)}`;
await page.getByLabel('Название участка').fill(zoneName);
await page.getByLabel('Назначение участка').selectOption('courtyard');
await page.getByRole('button', { name: 'Создать участок' }).click();
await page.waitForSelector('.zone-card', { timeout: 15_000 });
await settle(page);
const card = await page.locator('.zone-card').innerText();
const zonesAfter = (await page.evaluate(async (id) => (await fetch(`/v1/zones?city_id=${id}&limit=200`)).json(), city.id)).items;
const created = zonesAfter.find((z) => z.name === zoneName);
check('createZone persisted the drawn polygon; card shows server area', Boolean(created) && zonesAfter.length === zonesBefore + 1 && card.includes('м²'), {
  area_m2: created?.area_m2,
  vertices: created?.geometry.coordinates[0].length,
});
await shot(page, 'zone-created.png');
const draftCleared = await page.evaluate((k) => localStorage.getItem(k) === null, `pg.zone-draw.${city.id}`);
check('local draft cleared after save', draftCleared);

// A scenario on the first geometry version, used later for the re-bind check.
const v1 = created.version_id;
const sc = await apiCall(page, 'POST', '/v1/scenarios', {
  city_id: city.id,
  zone_id: created.id,
  name: 'SYNTHETIC TEST сценарий на версии 1',
  base_revision_id: null,
  initial_state: {
    zone_version_id: v1, parent_revision_id: null, dataset_version_ids: [], catalog_version_id: null, rate_version_id: null,
    coefficient_version_id: null, rule_version_id: null, model_version_id: null, placements: [], area_patches: [], capital_budget: null,
    care_horizon_years: 3, resource_limits: [], excluded_plant_ids: [], diversity_caps: [], care_strategy: 'standard', custom_care_operations: [],
    comment: 'SYNTHETIC TEST',
  },
});
check('scenario created on geometry v1 (setup)', sc.status === 201, { status: sc.status });

// 4. Keyboard drawing (crosshair + Enter, arrows pan the map)
await page.getByRole('button', { name: 'Закрыть карточку участка' }).click();
await page.getByRole('button', { name: 'Нарисовать новый участок' }).click();
await page.locator('.map-canvas').focus();
await page.keyboard.press('Enter');
for (const key of ['ArrowRight', 'ArrowDown']) {
  for (let i = 0; i < 3; i++) await page.keyboard.press(key);
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
}
await page.getByRole('button', { name: 'Замкнуть' }).click();
const status3 = await page.locator('.draw-status').innerText();
check('keyboard: Enter adds vertices at the crosshair, toolbar closes the ring', status3.includes('вершин: 3') && status3.includes('замкнут'), { status3 });
await page.keyboard.press('Control+z');
const status3b = await page.locator('.draw-status').innerText();
check('Ctrl+Z undoes the close', status3b.includes('не замкнут'), { status3b });
await shot(page, 'draw-keyboard.png');
await page.getByRole('button', { name: 'Выйти без сохранения' }).click();

// 5. Self-intersection preview blocks save
await page.getByRole('button', { name: 'Нарисовать новый участок' }).click();
for (const [dx, dy] of [[-80, -50], [80, 50], [80, -50], [-80, 50]]) {
  await page.mouse.click(...at(dx, dy));
  await page.waitForTimeout(150);
}
await page.getByRole('button', { name: 'Замкнуть' }).click();
await page.getByLabel('Название участка').fill('SYNTHETIC bow-tie');
const bowtieMsg = await page.getByText('Стороны контура пересекаются').isVisible();
const bowtieSaveDisabled = await page.getByRole('button', { name: 'Создать участок' }).isDisabled();
check('self-intersecting contour is explained and cannot be sent', bowtieMsg && bowtieSaveDisabled);
await shot(page, 'draw-self-intersection.png');
await page.getByRole('button', { name: 'Выйти без сохранения' }).click();

// 6. Edit: drag a vertex, insert via midpoint, save -> new version
await page.goto(`${BASE}/?city=${city.id}&zone=${created.id}`);
await page.waitForSelector('.zone-card', { timeout: 15_000 });
await settle(page);
await page.getByRole('button', { name: 'Изменить границы участка' }).click();
await waitHandles('vertex', 4);
await page.waitForTimeout(400);
const statusEditStart = await page.locator('.draw-status').innerText();
const serverRing = (await page.evaluate(async (id) => (await fetch(`/v1/zones/${id}`)).json(), created.id)).geometry.coordinates[0];
check('edit starts from the server ring without the closing duplicate', statusEditStart.includes('вершин: 4'), { statusEditStart, serverRing });
let [vx, vy] = await vertexPx(1);
await page.mouse.move(vx, vy);
await page.mouse.down();
await page.mouse.move(vx + 40, vy - 30, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(300);
const afterVertexDrag = await page.locator('.draw-status').innerText();
check('edit: vertex drag keeps the vertex count', afterVertexDrag.includes('вершин: 4'), { afterVertexDrag });
await waitHandles('mid', 4);
await page.waitForTimeout(300);
const midPx = await page.evaluate(() => {
  const m = window.__pgMap;
  const f = m.querySourceFeatures('draw').find((x) => x.properties.role === 'mid' && x.properties.i === 2);
  const p = m.project(f.geometry.coordinates);
  const r = m.getCanvas().getBoundingClientRect();
  return [r.left + p.x, r.top + p.y];
});
await page.mouse.move(midPx[0], midPx[1]);
await page.mouse.down();
await page.mouse.move(midPx[0] + 35, midPx[1] + 10, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(300);
const status4 = await page.locator('.draw-status').innerText();
check('edit: drag moved a vertex and midpoint drag inserted one (5 vertices)', status4.includes('вершин: 5'), { status4 });
await shot(page, 'edit-dragged.png');
await page.getByRole('button', { name: 'Сохранить новую версию границ' }).click();
await page.waitForSelector('.zone-card', { timeout: 15_000 }).catch(async () => {
  await shot(page, 'edit-save-failed.png');
  console.log('PANEL', (await page.locator('aside').first().innerText()).slice(0, 800));
});
const z2 = (await page.evaluate(async (id) => (await fetch(`/v1/zones/${id}`)).json(), created.id));
check('updateZone with If-Match created a new geometry version', z2.version_id !== v1 && z2.geometry.coordinates[0].length === 6, {
  v1: v1.slice(0, 8),
  v2: z2.version_id.slice(0, 8),
  area_before: created.area_m2,
  area_after: z2.area_m2,
});

// 7. Concurrent edit -> 412 -> keep my contour -> save
await page.getByRole('button', { name: 'Изменить границы участка' }).click();
await waitHandles('vertex', 5);
await page.waitForTimeout(400);
[vx, vy] = await vertexPx(0);
await page.mouse.move(vx, vy);
await page.mouse.down();
await page.mouse.move(vx - 30, vy - 20, { steps: 6 });
await page.mouse.up();
const fresh = await page.evaluate(async (id) => {
  const r = await fetch(`/v1/zones/${id}`);
  return { etag: r.headers.get('ETag'), body: await r.json() };
}, created.id);
const other = await apiCall(
  page,
  'PUT',
  `/v1/zones/${created.id}`,
  { city_id: city.id, name: fresh.body.name + ' (параллельно)', purpose: fresh.body.purpose, geometry: fresh.body.geometry },
  { 'If-Match': fresh.etag },
);
check('concurrent updateZone accepted by server (setup)', other.status === 200, { status: other.status });
await page.getByRole('button', { name: 'Сохранить новую версию границ' }).click();
await page.waitForSelector('text=Участок изменён другим пользователем', { timeout: 15_000 }).catch(() => {});
const conflictShown = await page.getByText('Участок изменён другим пользователем').isVisible().catch(() => false);
const stillDrawing = (await page.locator('.draw-status').innerText()).includes('вершин: 5');
check('stale If-Match -> 412 shown, my contour kept', conflictShown && stillDrawing);
await shot(page, 'edit-conflict-412.png');
await page.getByRole('button', { name: 'Сохранить мой контур поверх новой версии' }).click();
await page.waitForTimeout(800);
await page.getByRole('button', { name: 'Сохранить новую версию границ' }).click();
await page.waitForSelector('.zone-card', { timeout: 15_000 }).catch(() => {});
const z3 = await page.evaluate(async (id) => (await fetch(`/v1/zones/${id}`)).json(), created.id);
check('after explicit keep: my geometry saved on the new version, the concurrent rename preserved', z3.version_id !== other.body?.version_id && z3.geometry.coordinates[0].length === 6 && z3.name.includes('(параллельно)'), {
  v3: z3.version_id.slice(0, 8),
  name: z3.name,
  ring: z3.geometry.coordinates[0].length,
});

// 8. Scenario made on v1 flags the change and offers explicit re-bind
await page.goto(`${BASE}/projects/${sc.body.id}?city=${city.id}`);
await settle(page);
await page.waitForTimeout(800);
const notice = await page.getByText('Границы участка изменились после этой ревизии').waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
const rebind = page.getByRole('checkbox', { name: /Перенести следующую ревизию на текущие границы участка/ });
check('scenario on old geometry shows version notice and re-bind option', notice && (await rebind.count()) === 1);
await rebind.check();
await page.getByLabel('Комментарий к ревизии').fill('SYNTHETIC TEST: перенос на новые границы');
await page.getByRole('button', { name: 'Сохранить новую ревизию' }).click();
await page.waitForSelector('.pg-save--saved', { timeout: 15_000 }).catch(() => {});
const sc2 = await page.evaluate(async (id) => {
  const s = await (await fetch(`/v1/scenarios/${id}`)).json();
  return (await fetch(`/v1/scenario-revisions/${s.current_revision_id}`)).json();
}, sc.body.id);
check('new revision is bound to the current geometry only after explicit opt-in', sc2.zone_version_id === z3.version_id, {
  revision_zone_version: sc2.zone_version_id?.slice(0, 8),
  current: z3.version_id.slice(0, 8),
});
await shot(page, 'scenario-rebound.png');

check('no uncaught page errors', consoleErrors.length === 0, consoleErrors.slice(0, 3));
await browser.close();
report.finishedAt = new Date().toISOString();
report.passed = report.checks.every((c) => c.pass);
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`\n${report.checks.filter((c) => c.pass).length}/${report.checks.length} checks passed`);
process.exit(report.passed ? 0 : 1);
