// WP-06 acceptance under load on the isolated stack. A SYNTHETIC building layer (1 200 footprints
// with recorded heights) is published; in 3D, with 4x CPU throttling and the camera rotating all
// the time, the WebGL context is lost and restored five times. After every restore the published
// extrusions and the Three scene layer must draw again and the selected object (URL, card,
// highlight) must be unchanged. Then on an emulated phone with touch: tap-select in 2D, tap into
// 3D, one-finger pan, two-finger pitch and rotate, tap-select another object in 3D.
// Emulation only: no physical device was attached to this machine.
//
//   uv run python -m tools.dev.isolated_browser_env --cwd apps/web -- node scripts/scene3d-stress-check.mjs
import { chromium } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sessionCookie } from './lib/session-login.mjs';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5174';
const OUT = resolve('../../docs/evidence/wp06-stress-touch');
const FILES = mkdtempSync(join(tmpdir(), 'pg-3d-stress-'));
mkdirSync(OUT, { recursive: true });
const report = { base: BASE, startedAt: new Date().toISOString(), device: 'emulated only (no physical device attached)', checks: [], shots: [], measurements: {} };
const check = (name, pass, detail) => {
  report.checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
};
const shot = async (page, file) => {
  await page.screenshot({ path: join(OUT, file) });
  report.shots.push(`docs/evidence/wp06-stress-touch/${file}`);
};
const settle = (page) => page.waitForFunction(() => !document.querySelector('.pg-state .pg-spinner, .pg-skeleton'), null, { timeout: 15_000 }).catch(() => {});
async function signIn(browser, role, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ru-RU', ...opts });
  const page = await ctx.newPage();
  if (!(await sessionCookie(ctx, role, BASE))) throw new Error('Run through tools/dev/isolated_browser_env.py (PG_SESSIONS)');
  await page.goto(BASE + '/');
  await page.waitForTimeout(800);
  return { ctx, page };
}

const browser = await chromium.launch({ channel: process.env.PG_BROWSER_CHANNEL ?? 'msedge' });
const sp = await signIn(browser, 'specialist');
const city = (await sp.page.evaluate(async () => (await fetch('/v1/cities')).json())).items[0];
const ring = city.boundary.type === 'Polygon' ? city.boundary.coordinates[0] : city.boundary.coordinates[0][0];
const cx = (Math.min(...ring.map((c) => c[0])) + Math.max(...ring.map((c) => c[0]))) / 2 + 0.01;
const cy = (Math.min(...ring.map((c) => c[1])) + Math.max(...ring.map((c) => c[1]))) / 2 + 0.01;
const square = (x, y, d) => [[[x - d, y - d], [x + d, y - d], [x + d, y + d], [x - d, y + d], [x - d, y - d]]];
const features = [
  { type: 'Feature', id: 'stress-a', properties: { name: 'SYNTHETIC 3D здание A', height: 24 }, geometry: { type: 'Polygon', coordinates: square(cx - 0.0016, cy, 0.0004) } },
  { type: 'Feature', id: 'stress-b', properties: { name: 'SYNTHETIC 3D здание B', height: 36 }, geometry: { type: 'Polygon', coordinates: square(cx + 0.0016, cy, 0.0004) } },
];
for (let i = 0; i < 40; i++)
  for (let j = 0; j < 30; j++) {
    const x = cx - 0.012 + i * 0.0006;
    const y = cy + 0.0012 + j * 0.0004;
    features.push({ type: 'Feature', id: `stress-${i}-${j}`, properties: { name: `SYNTHETIC фон ${i}-${j}`, height: 6 + ((i * 7 + j * 3) % 40) }, geometry: { type: 'Polygon', coordinates: square(x, y, 0.00012) } });
  }
const file = join(FILES, 'synthetic-buildings.geojson');
writeFileSync(file, JSON.stringify({ type: 'FeatureCollection', features }));

// Upload (specialist) and publish (admin) through the UI.
const stamp = new Date().toISOString().slice(11, 19);
const dsName = `SYNTHETIC TEST 3D нагрузка ${stamp}`;
await sp.page.goto(`${BASE}/imports?city=${city.id}`);
await settle(sp.page);
await sp.page.getByRole('button', { name: 'Создать набор данных' }).click();
await sp.page.getByLabel(/^Название/).fill(dsName);
await sp.page.getByLabel('Тип', { exact: true }).selectOption('buildings');
await sp.page.getByLabel('Владелец').fill('SYNTHETIC integration test');
await sp.page.getByLabel('Лицензия').fill('CC0-1.0');
await sp.page.getByLabel('Доступ', { exact: true }).selectOption('public');
await sp.page.getByRole('button', { name: 'Создать набор', exact: true }).click();
await sp.page.waitForFunction((n) => [...document.querySelectorAll('select option:checked')].some((o) => o.textContent?.includes(n)), dsName, { timeout: 15_000 });
const datasetId = await sp.page.evaluate((n) => [...document.querySelectorAll('select option')].find((o) => o.textContent?.includes(n))?.value, dsName);
await sp.page.locator('input[type=file]').setInputFiles(file);
await sp.page.getByLabel('Метод получения данных').fill('SYNTHETIC TEST 3D stress');
await sp.page.getByRole('button', { name: 'Загрузить и проверить' }).click();
await sp.page.waitForURL(/[?&]job=/, { timeout: 60_000 });
await sp.page.getByText('Проверка завершена').waitFor({ timeout: 180_000 });
const job = await sp.page.evaluate(async (id) => (await fetch(`/v1/jobs/${id}`)).json(), new URL(sp.page.url()).searchParams.get('job'));
const versionId = job.result_ref_id;
await sp.ctx.close();

const ad = await signIn(browser, 'admin');
await ad.page.goto(`${BASE}/imports?city=${city.id}&selected=${datasetId}`);
await ad.page.waitForSelector('.app-split.is-open .pg-card', { timeout: 20_000 });
await settle(ad.page);
await ad.page.locator('.app-versions > li').filter({ hasText: versionId.slice(0, 8) }).getByRole('button', { name: 'Опубликовать версию…' }).click();
await ad.page.locator('dialog[open]').getByLabel('Причина решения').fill('SYNTHETIC TEST: 3D stress');
await ad.page.locator('dialog[open]').getByRole('button', { name: 'Опубликовать', exact: true }).click();
await ad.page.locator('dialog[open]').waitFor({ state: 'detached', timeout: 20_000 }).catch(() => {});
const layer = (await ad.page.evaluate(async (c) => (await (await fetch(`/v1/map/layers?city_id=${c}&limit=200`)).json()).items, city.id)).find((l) => l.dataset_version_id === versionId);
check('setup: SYNTHETIC building layer with 1 202 recorded heights published', Boolean(layer) && layer.category === 'building', { layer: layer?.id, category: layer?.category, features: features.length });
await ad.ctx.close();
if (!layer) process.exit(1);

// --- Helpers on a page with the map ---
const tools = (page) => {
  const params = () => Object.fromEntries(new URL(page.url()).searchParams);
  const idle = () => page.evaluate(() => new Promise((r) => (window.__pgMap.loaded() ? r(true) : window.__pgMap.once('idle', () => r(true)))));
  const pixelOf = (name) =>
    page.evaluate(([id, name]) => {
      const m = window.__pgMap;
      const ids = m.getStyle().layers.filter((l) => l.source === `pgl-${id}`).map((l) => l.id);
      const c = m.getCanvas();
      const r = c.getBoundingClientRect();
      for (let y = 60; y < c.clientHeight - 60; y += 8)
        for (let x = 30; x < c.clientWidth - 30; x += 8) {
          const f = m.queryRenderedFeatures([x, y], { layers: ids })[0];
          if (f?.properties?.name === name && document.elementFromPoint(r.left + x, r.top + y) === c) return [r.left + x, r.top + y];
        }
      return null;
    }, [layer.id, name]);
  const camera = () => page.evaluate(() => ({ pitch: window.__pgMap.getPitch(), bearing: window.__pgMap.getBearing(), center: window.__pgMap.getCenter().toArray(), zoom: window.__pgMap.getZoom() }));
  // The part of the canvas the finger can reach (on a phone the bottom sheet covers the rest).
  const visibleBand = () =>
    page.evaluate(() => {
      const c = window.__pgMap.getCanvas();
      const r = c.getBoundingClientRect();
      const x = r.left + r.width / 2;
      let top = null;
      let bottom = null;
      for (let y = r.top + 4; y < r.bottom - 4; y += 4) {
        if (document.elementFromPoint(x, y) === c) {
          top ??= y;
          bottom = y;
        } else if (top !== null) break;
      }
      return { x, top, bottom, mid: top === null ? null : (top + bottom) / 2 };
    });
  // Pans so that a coordinate lands in the middle of the reachable band.
  const bringIntoView = async (lngLat) => {
    const band = await visibleBand();
    await page.evaluate(([ll, mid]) => {
      const m = window.__pgMap;
      m.jumpTo({ center: ll });
      const r = m.getCanvas().getBoundingClientRect();
      const p = m.project(ll);
      m.panBy([0, r.top + p.y - mid], { duration: 0 });
    }, [lngLat, band.mid]);
    await idle();
    await page.waitForTimeout(400);
  };
  return { params, idle, pixelOf, camera, visibleBand, bringIntoView };
};

// --- A. Context loss and restore under load, selection kept ---
const { ctx, page } = await signIn(browser, 'specialist');
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error' && !/context lost|CONTEXT_LOST/i.test(m.text())) errors.push(m.text());
});
const t = tools(page);
await page.goto(`${BASE}/?city=${city.id}&ll=${cx.toFixed(5)},${(cy + 0.002).toFixed(5)}&z=15.5`);
await page.waitForFunction((id) => window.__pgMap?.getSource(`pgl-${id}`), layer.id, { timeout: 30_000 });
await t.idle();
await page.waitForTimeout(800);
const pa = await t.pixelOf('SYNTHETIC 3D здание A');
if (pa) await page.mouse.click(...pa);
const card = page.locator('.map-inspect');
await card.locator('.map-inspect__server').waitFor({ timeout: 15_000 }).catch(() => {});
const featureA = t.params().feature;
await page.getByRole('button', { name: '3D-вид' }).click();
await page.waitForFunction(() => window.__pgMap.getPitch() > 40 && window.__pgScene?.state === 'on', null, { timeout: 20_000 });
await t.idle();
const extrusion = `pgl-${layer.id}-extrusion`;
const drawn = () =>
  page.evaluate((ex) => {
    const m = window.__pgMap;
    return {
      scene: window.__pgScene?.state,
      sceneLayer: Boolean(m.getLayer('scene3d')),
      extrusionLayer: Boolean(m.getLayer(ex)),
      extruded: m.getLayer(ex) ? m.queryRenderedFeatures({ layers: [ex] }).length : 0,
      highlight: m.getSource('feature-highlight') ? m.querySourceFeatures('feature-highlight').length : 0,
    };
  }, extrusion);
const start = await drawn();
check('3D on with the selected building: extrusions drawn, scene layer on', Boolean(featureA) && start.scene === 'on' && start.sceneLayer && start.extruded > 100, { featureA, ...start });
await shot(page, 'stress-3d-before.png');

const cdp = await ctx.newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
await page.evaluate(() => {
  const m = window.__pgMap;
  window.__spin = setInterval(() => m.rotateTo((m.getBearing() + 4) % 360, { duration: 120, essential: true }), 140);
  window.__frames = 0;
  m.on('render', () => (window.__frames += 1));
});
const cycles = [];
for (let n = 0; n < 5; n++) {
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    window.__lose = window.__pgMap.getCanvas().getContext('webgl2').getExtension('WEBGL_lose_context');
    window.__lose.loseContext();
  });
  const lostSeen = await page.waitForFunction(() => window.__pgScene?.state === 'context_lost', null, { timeout: 10_000 }).then(() => true).catch(() => false);
  const notice = await page.getByText('Графический контекст потерян').isVisible().catch(() => false);
  await page.waitForTimeout(300);
  const t0 = Date.now();
  await page.evaluate(() => window.__lose.restoreContext());
  const back = await page
    .waitForFunction(
      (ex) => {
        const m = window.__pgMap;
        return window.__pgScene?.state === 'on' && Boolean(m.getLayer('scene3d')) && Boolean(m.getLayer(ex)) && m.queryRenderedFeatures({ layers: [ex] }).length > 100;
      },
      extrusion,
      { timeout: 25_000, polling: 200 },
    )
    .then(() => true)
    .catch(() => false);
  const ms = Date.now() - t0;
  const framesBefore = await page.evaluate(() => window.__frames);
  await page.waitForTimeout(800);
  const framesAfter = await page.evaluate(() => window.__frames);
  const state = await drawn();
  const selectionKept = t.params().feature === featureA && (await card.innerText().catch(() => '')).includes('здание A') && state.highlight > 0;
  cycles.push({ n, lostSeen, notice, back, ms, frames: framesAfter - framesBefore, selectionKept, ...state });
}
await page.evaluate(() => clearInterval(window.__spin));
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
report.measurements.restoreCycles = cycles;
check(
  'five context losses while rotating with 4x CPU throttling: each observed, explained, and 3D (extrusions + scene layer) drawn again',
  cycles.every((c) => c.lostSeen && c.notice && c.back && c.frames > 0),
  cycles.map(({ n, ms, back, frames }) => ({ n, ms, back, frames })),
);
check('selection survives every restore: URL feature, card and highlight unchanged', cycles.every((c) => c.selectionKept), cycles.map((c) => c.selectionKept));
const heap = await cdp.send('Runtime.getHeapUsage').catch(() => null);
report.measurements.heapAfterCycles = heap;
check('no page or WebGL errors besides the forced context loss', errors.length === 0, errors.slice(0, 5));
await shot(page, 'stress-3d-after-restores.png');

// Selection sync after the stress: pick B in 3D, back to 2D keeps B.
await page.evaluate(() => window.__pgMap.easeTo({ bearing: 0, duration: 0 }));
await t.idle();
const pb = await t.pixelOf('SYNTHETIC 3D здание B');
if (pb) await page.mouse.click(...pb);
await page.waitForFunction(() => document.querySelector('.map-inspect')?.textContent?.includes('здание B'), null, { timeout: 15_000 }).catch(() => {});
const pickedB = t.params().feature;
const pitch3d = (await t.camera()).pitch;
await page.getByRole('button', { name: 'Выйти из 3D' }).click();
await page.waitForTimeout(900);
const flat = await t.camera();
check('2D/3D sync after the stress: 3D pick of B moves card and URL; exiting 3D keeps B selected', Boolean(pb) && pickedB && pickedB !== featureA && pitch3d > 40 && flat.pitch === 0 && (await card.innerText()).includes('здание B') && t.params().feature === pickedB, { pickedB, pitch3d, flat: flat.pitch });
await ctx.close();

// --- B. Phone with touch ---
const ph = await signIn(browser, 'specialist', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
const pp = ph.page;
const pt = tools(pp);
const touch = await ph.ctx.newCDPSession(pp);
const gesture = async (frames) => {
  const [first, ...rest] = frames;
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: first.map(([x, y], id) => ({ x, y, id })) });
  for (const f of rest) {
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: f.map(([x, y], id) => ({ x, y, id })) });
    await pp.waitForTimeout(16);
  }
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await pp.waitForTimeout(500);
};
await pp.goto(`${BASE}/?city=${city.id}&ll=${cx.toFixed(5)},${cy.toFixed(5)}&z=16`);
await pp.waitForFunction((id) => window.__pgMap?.getSource(`pgl-${id}`), layer.id, { timeout: 30_000 });
await pt.idle();
await pp.waitForTimeout(800);
const ta = await pt.pixelOf('SYNTHETIC 3D здание A');
if (ta) await pp.touchscreen.tap(...ta);
const pcard = pp.locator('.map-inspect');
const tapA = await pcard.getByText('здание A').first().waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
check('phone 2D: tap selects building A (card and URL)', Boolean(ta) && tapA && Boolean(pt.params().feature), { ta });
const toggle = pp.locator('.scene3d-toggle');
const tb = await toggle.boundingBox();
await pp.touchscreen.tap(tb.x + tb.width / 2, tb.y + tb.height / 2);
const on3d = await pp.waitForFunction(() => window.__pgMap.getPitch() > 40 && window.__pgScene?.state === 'on', null, { timeout: 20_000 }).then(() => true).catch(() => false);
check('phone: tap on the 3D toggle enters 3D with the selection kept', on3d && (await pcard.innerText()).includes('здание A'));
await pt.idle();
const band = await pt.visibleBand();
const vp = { x: band.x, y: band.mid };
report.measurements.phoneReachableMap = band;
const c0 = await pt.camera();
await gesture(Array.from({ length: 12 }, (_, i) => [[vp.x - i * 8, vp.y]]));
const c1 = await pt.camera();
check('touch: one-finger drag pans the 3D map', Math.abs(c1.center[0] - c0.center[0]) > 1e-5 && Math.abs(c1.pitch - c0.pitch) < 2, { from: c0.center, to: c1.center });
await gesture(Array.from({ length: 14 }, (_, i) => [[vp.x - 60, vp.y + 40 - i * 6], [vp.x + 60, vp.y + 40 - i * 6]]));
const c2 = await pt.camera();
const angle = (i) => (i * Math.PI) / 40;
await gesture(Array.from({ length: 14 }, (_, i) => [[vp.x - 80 * Math.cos(angle(i)), vp.y - 80 * Math.sin(angle(i))], [vp.x + 80 * Math.cos(angle(i)), vp.y + 80 * Math.sin(angle(i))]]));
const c3 = await pt.camera();
check('touch: two-finger vertical drag changes pitch, two-finger twist rotates', Math.abs(c2.pitch - c1.pitch) > 2 && Math.abs(c3.bearing - c2.bearing) > 2, { pitch: [c1.pitch, c2.pitch], bearing: [c2.bearing, c3.bearing] });
check('touch: camera gestures are written to the URL', Math.abs(Number(pt.params().b) - Math.round(c3.bearing)) <= 1 && Math.abs(Number(pt.params().p) - Math.round(c3.pitch)) <= 1, pt.params());
await pp.evaluate(() => window.__pgMap.easeTo({ bearing: 0, duration: 0 }));
await pt.bringIntoView([cx + 0.0016, cy]);
const tbPick = await pt.pixelOf('SYNTHETIC 3D здание B');
if (tbPick) await pp.touchscreen.tap(...tbPick);
const tapB = await pp.waitForFunction(() => document.querySelector('.map-inspect')?.textContent?.includes('здание B'), null, { timeout: 15_000 }).then(() => true).catch(() => false);
check('phone 3D: tap selects building B; camera stays tilted', Boolean(tbPick) && tapB && (await pt.camera()).pitch > 40, { tbPick });
const overflow = await pp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const tbox = await toggle.boundingBox().catch(() => null);
const cbox = await pcard.boundingBox().catch(() => null);
check('phone: no horizontal scroll; card and 3D controls do not overlap', overflow <= 0 && Boolean(tbox && cbox) && (tbox.y + tbox.height <= cbox.y || cbox.y + cbox.height <= tbox.y || tbox.x + tbox.width <= cbox.x || cbox.x + cbox.width <= tbox.x), { overflow, tbox, cbox });
await shot(pp, 'phone-3d-touch.png');
await ph.ctx.close();

await browser.close();
report.finishedAt = new Date().toISOString();
report.passed = report.checks.every((c) => c.pass);
report.synthetic = { dataset: dsName, version: versionId };
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`\n${report.checks.filter((c) => c.pass).length}/${report.checks.length} checks passed`);
process.exit(report.passed ? 0 : 1);
