// Live WP-06 check: selection and camera shared by 2D and 3D on published server objects.
// A SYNTHETIC polygon dataset is uploaded and published; the selected object's server geometry
// becomes the 3D scene content with the server height_basis (unknown -> flat footprint, never an
// invented height). 3D mode, pitch and bearing live in the URL and survive reload.
// Run in the disposable environment:
//
//   uv run python -m tools.dev.browser_test_env --cwd apps/web -- node scripts/scene3d-sync-check.mjs
import { chromium } from '@playwright/test';
import { sessionCookie } from './lib/session-login.mjs';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5173';
const OUT = resolve('../../docs/evidence/wp06-scene-sync');
const creds = JSON.parse(readFileSync(process.env.PG_TEST_CREDENTIALS ?? '', 'utf8'));
mkdirSync(OUT, { recursive: true });
const FILES = mkdtempSync(join(tmpdir(), 'pg-3d-'));

const report = { base: BASE, startedAt: new Date().toISOString(), checks: [], shots: [] };
const check = (name, pass, detail) => {
  report.checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
};
const shot = async (page, file) => {
  await page.screenshot({ path: join(OUT, file) });
  report.shots.push(`docs/evidence/wp06-scene-sync/${file}`);
};
const settle = (page) =>
  page.waitForFunction(() => !document.querySelector('.pg-state .pg-spinner, .pg-skeleton'), null, { timeout: 15_000 }).catch(() => {});

async function login(browser, role) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ru-RU' });
  const page = await ctx.newPage();
  if (await sessionCookie(ctx, role, BASE)) {
    await page.goto(BASE + '/');
    await page.waitForTimeout(800);
    return { ctx, page };
  }
  await page.goto(BASE + '/');
  const btn = page.getByRole('button', { name: 'Войти через корпоративную учётную запись' }).first();
  await btn.waitFor({ timeout: 20_000 });
  await Promise.all([page.waitForURL(/openid-connect\/auth/, { waitUntil: 'commit', timeout: 20_000 }), btn.click()]);
  await page.waitForSelector('#username');
  await page.fill('#username', role);
  await page.fill('#password', creds[role]);
  await page.click('#kc-login');
  await page.waitForURL((u) => u.origin === new URL(BASE).origin && !u.pathname.startsWith('/auth/'), { waitUntil: 'commit', timeout: 20_000 });
  await page.waitForTimeout(1500);
  return { ctx, page };
}

const browser = await chromium.launch({ channel: process.env.PG_BROWSER_CHANNEL ?? 'msedge' });
const specialist = await login(browser, 'specialist');
const city = (await specialist.page.evaluate(async () => (await fetch('/v1/cities')).json())).items[0];
const ring = city.boundary.type === 'Polygon' ? city.boundary.coordinates[0] : city.boundary.coordinates[0][0];
const cx = (Math.min(...ring.map((c) => c[0])) + Math.max(...ring.map((c) => c[0]))) / 2 + 0.01;
const cy = (Math.min(...ring.map((c) => c[1])) + Math.max(...ring.map((c) => c[1]))) / 2 + 0.01;
const sq = (dx, dy, d = 0.0008) => [[[cx + dx - d, cy + dy - d], [cx + dx + d, cy + dy - d], [cx + dx + d, cy + dy + d], [cx + dx - d, cy + dy + d], [cx + dx - d, cy + dy - d]]];
const stamp = new Date().toISOString().slice(11, 19);
const file = join(FILES, 'synthetic-3d.geojson');
writeFileSync(file, JSON.stringify({ type: 'FeatureCollection', features: [
  { type: 'Feature', id: '3d-a', properties: { name: 'SYNTHETIC 3D объект A' }, geometry: { type: 'Polygon', coordinates: sq(-0.0015, 0) } },
  { type: 'Feature', id: '3d-b', properties: { name: 'SYNTHETIC 3D объект B' }, geometry: { type: 'Polygon', coordinates: sq(0.0015, 0) } },
] }));

// Upload (specialist) and publish (admin) through the UI, as in layers-check.
const sp = specialist.page;
await sp.goto(`${BASE}/imports?city=${city.id}`);
await settle(sp);
const dsName = `SYNTHETIC TEST 3D ${stamp}`;
await sp.getByRole('button', { name: 'Создать набор данных' }).click();
await sp.getByLabel(/^Название/).fill(dsName);
await sp.getByLabel('Тип', { exact: true }).selectOption('zones');
await sp.getByLabel('Владелец').fill('SYNTHETIC integration test');
await sp.getByLabel('Лицензия').fill('CC0-1.0');
await sp.getByLabel('Доступ', { exact: true }).selectOption('public');
await sp.getByRole('button', { name: 'Создать набор', exact: true }).click();
await sp.waitForFunction((n) => [...document.querySelectorAll('select option:checked')].some((o) => o.textContent?.includes(n)), dsName, { timeout: 15_000 });
const datasetId = await sp.evaluate((n) => [...document.querySelectorAll('select option')].find((o) => o.textContent?.includes(n))?.value, dsName);
await sp.locator('input[type=file]').setInputFiles(file);
await sp.getByLabel('Метод получения данных').fill('SYNTHETIC TEST 3D sync');
await sp.getByRole('button', { name: 'Загрузить и проверить' }).click();
await sp.waitForURL(/[?&]job=/, { timeout: 60_000 });
await sp.getByText('Проверка завершена').waitFor({ timeout: 90_000 });
const job = await sp.evaluate(async (id) => (await fetch(`/v1/jobs/${id}`)).json(), new URL(sp.url()).searchParams.get('job'));
const versionId = job.result_ref_id;

const { ctx, page } = await login(browser, 'admin');
await page.goto(`${BASE}/imports?city=${city.id}&selected=${datasetId}`);
await page.waitForSelector('.app-split.is-open .pg-card', { timeout: 20_000 });
await settle(page);
await page.locator('.app-versions > li').filter({ hasText: versionId.slice(0, 8) }).getByRole('button', { name: 'Опубликовать версию…' }).click();
await page.locator('dialog[open]').getByLabel('Причина решения').fill('SYNTHETIC TEST: 3D sync');
await page.locator('dialog[open]').getByRole('button', { name: 'Опубликовать', exact: true }).click();
await page.locator('dialog[open]').waitFor({ state: 'detached', timeout: 20_000 }).catch(() => {});
const layer = (await page.evaluate(async (c) => (await (await fetch(`/v1/map/layers?city_id=${c}&limit=200`)).json()).items, city.id)).find((l) => l.dataset_version_id === versionId);
check('synthetic polygon layer published (setup)', Boolean(layer), { layer: layer?.id });

const pixelOf = (name) =>
  page.evaluate(([id, name]) => {
    const m = window.__pgMap;
    const ids = m.getStyle().layers.filter((l) => l.source === `pgl-${id}`).map((l) => l.id);
    const c = m.getCanvas();
    for (let y = 60; y < c.clientHeight - 60; y += 10)
      for (let x = 60; x < c.clientWidth - 60; x += 10) {
        const f = m.queryRenderedFeatures([x, y], { layers: ids })[0];
        const zone = m.getLayer('zones-fill') ? m.queryRenderedFeatures([x, y], { layers: ['zones-fill'] }) : [];
        const r = c.getBoundingClientRect();
        // Only pixels the pointer can reach: not under the card, toggle or panel.
        if (f?.properties?.name === name && zone.length === 0 && document.elementFromPoint(r.left + x, r.top + y) === c) return [r.left + x, r.top + y];
      }
    return null;
  }, [layer.id, name]);
const camera = () => page.evaluate(() => ({ pitch: Math.round(window.__pgMap.getPitch()), bearing: Math.round(window.__pgMap.getBearing()), zoom: window.__pgMap.getZoom() }));
const params = () => Object.fromEntries(new URL(page.url()).searchParams);
const scene = () => page.evaluate(() => window.__pgScene?.stats() ?? null);
const idle = () => page.evaluate(() => new Promise((r) => (window.__pgMap.loaded() ? r(true) : window.__pgMap.once('idle', () => r(true)))));
const card = page.locator('.map-inspect');

await page.goto(`${BASE}/?city=${city.id}&ll=${cx.toFixed(5)},${cy.toFixed(5)}&z=16`);
await page.waitForFunction((id) => window.__pgMap?.getSource(`pgl-${id}`), layer.id, { timeout: 30_000 });
await idle();
await page.waitForTimeout(800);
const pa = await pixelOf('SYNTHETIC 3D объект A');
await page.mouse.click(...pa);
await card.locator('.map-inspect__server').waitFor({ timeout: 15_000 });
const featureA = params().feature;
check('2D: object A opened from the server card', Boolean(featureA) && (await card.innerText()).includes('SYNTHETIC 3D объект A'), { featureA });

// Into 3D: the selection, card and highlight stay; the object is the scene content.
await page.getByRole('button', { name: '3D-вид' }).click();
await page.waitForFunction(() => window.__pgMap.getPitch() > 40 && window.__pgScene?.state === 'on', null, { timeout: 15_000 });
await idle();
await page.waitForTimeout(500);
const s1 = await scene();
const styles = await page.evaluate(() => window.__pgScene?.handle.current?.describe() ?? []);
const status3d = await page.locator('.scene3d-status').innerText().catch(() => '');
check('3D keeps the selected object: card open, URL scene=3d with pitch, feature unchanged', params().scene === '3d' && Number(params().p) > 40 && params().feature === featureA && (await card.count()) === 1, params());
check('server height_basis unknown -> one flat footprint, nothing extruded, said in the panel', s1?.buildingsByBasis.unknown === 1 && Object.values(s1.buildingsByBasis).reduce((a, b) => a + b, 0) === 1 && styles.every((x) => !x.extruded) && /не указана сервером/.test(status3d), { counts: s1?.buildingsByBasis, styles, status3d: status3d.slice(0, 200) });
check('2D highlight of the server geometry stays visible in 3D', (await page.evaluate(() => window.__pgMap.querySourceFeatures('feature-highlight').length)) > 0);
await shot(page, '3d-selected.png');

// Rotate: the camera goes into the URL and survives reload.
await page.evaluate(() => window.__pgMap.easeTo({ bearing: 30, duration: 0 }));
await page.waitForTimeout(600);
const before = await camera();
check('bearing and pitch written to the URL', Number(params().b) === 30 && Math.abs(Number(params().p) - before.pitch) <= 1, params());
await page.reload();
await page.waitForFunction(() => window.__pgScene?.state === 'on', null, { timeout: 30_000 }).catch(() => {});
await card.locator('.map-inspect__server').waitFor({ timeout: 20_000 }).catch(() => {});
await page.waitForTimeout(1200);
const after = await camera();
const s2 = await scene();
check('reload restores 3D, pitch, bearing, the selected object and its flat footprint', Math.abs(after.pitch - before.pitch) <= 1 && Math.abs(after.bearing - 30) <= 1 && s2?.buildingsByBasis.unknown === 1 && (await card.innerText()).includes('SYNTHETIC 3D объект A'), { before, after, counts: s2?.buildingsByBasis });

// Pick another object in 3D: selection follows, the tilted camera is kept.
await idle();
const pb = await pixelOf('SYNTHETIC 3D объект B');
if (pb) await page.mouse.click(...pb);
await page.waitForFunction(() => document.querySelector('.map-inspect')?.textContent?.includes('объект B'), null, { timeout: 15_000 }).catch(() => {});
await page.waitForTimeout(600);
const afterPick = await camera();
const s3 = await scene();
check('3D pick of object B: card and URL follow, camera stays tilted and rotated, scene shows B only', Boolean(pb) && params().feature !== featureA && (await card.innerText()).includes('SYNTHETIC 3D объект B') && afterPick.pitch > 40 && Math.abs(afterPick.bearing - 30) <= 1 && s3?.buildingsByBasis.unknown === 1, { afterPick, feature: params().feature });
await page.emulateMedia({ colorScheme: 'dark' });
await page.waitForTimeout(400);
await shot(page, '3d-selected-dark.png');
await page.emulateMedia({ colorScheme: 'light' });

// Back to 2D: flat camera, selection kept, 3D params gone.
await page.getByRole('button', { name: 'Выйти из 3D' }).click();
await page.waitForTimeout(900);
const flat = await camera();
check('exit 3D: pitch and bearing back to 0, object B still selected, URL without scene/p/b', flat.pitch === 0 && flat.bearing === 0 && !params().scene && !params().p && !params().b && (await card.innerText()).includes('объект B'), { flat, params: params() });

// Phone: 3D with the selected object.
await page.getByRole('button', { name: '3D-вид' }).click();
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(1200);
await shot(page, '3d-selected-mobile.png');
const tb = await page.locator('.scene3d-toggle').boundingBox();
const cb = await card.boundingBox();
check('phone: card and 3D toggle do not overlap', Boolean(tb && cb) && (tb.y + tb.height <= cb.y || cb.y + cb.height <= tb.y || tb.x + tb.width <= cb.x), { tb, cb });

await browser.close();
report.finishedAt = new Date().toISOString();
report.passed = report.checks.every((c) => c.pass);
report.synthetic = { dataset: dsName, version: versionId };
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`\n${report.checks.filter((c) => c.pass).length}/${report.checks.length} checks passed`);
process.exit(report.passed ? 0 : 1);
