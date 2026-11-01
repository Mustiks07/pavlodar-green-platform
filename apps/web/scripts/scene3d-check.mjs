// WP-06 foundation: MapLibre 6.16.0 + Three 0.180.0 compatibility in a real browser.
//   A. /dev/3d harness (SYNTHETIC buildings near 0°/0°): render, alignment under camera changes,
//      per-basis styles, GPU object and heap release over 25 mount/unmount cycles, context loss/restore.
//   B. Real app + live API: 3D module loads only on demand, honest empty state, clean exit.
//   C. No WebGL2: explicit fallback, 2D routes keep working.
//   D. 3D chunk fails to load: explained, retry, 2D map unaffected.
//
//   PG_TEST_CREDENTIALS=<ignored local test-credentials.json> node scripts/scene3d-check.mjs
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sessionCookie } from './lib/session-login.mjs';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5173';
const OUT = resolve('../../docs/evidence/wp06-foundation');
mkdirSync(OUT, { recursive: true });
const creds = process.env.PG_TEST_CREDENTIALS ? JSON.parse(readFileSync(process.env.PG_TEST_CREDENTIALS, 'utf8')) : null;

// Disposable stacks hand out sessions (PG_SESSIONS); otherwise the test realm login is used.
const signedIn = Boolean(creds || process.env.PG_SESSIONS);
async function signInViewer(ctx, page) {
  if (await sessionCookie(ctx, 'viewer', BASE)) {
    await page.goto(BASE + '/');
    return;
  }
  await page.goto(BASE + '/');
  const btn = page.getByRole('button', { name: 'Войти через корпоративную учётную запись' }).first();
  await btn.waitFor({ timeout: 15_000 });
  await Promise.all([page.waitForURL(/openid-connect\/auth/, { waitUntil: 'commit', timeout: 20_000 }), btn.click()]);
  await page.waitForSelector('#username');
  await page.fill('#username', 'viewer');
  await page.fill('#password', creds.viewer);
  await page.click('#kc-login');
  await page.waitForURL((u) => u.origin === new URL(BASE).origin && !u.pathname.startsWith('/auth/'), { waitUntil: 'commit', timeout: 20_000 });
}

const report = { base: BASE, startedAt: new Date().toISOString(), browser: null, versions: { maplibre: '6.16.0', three: '0.180.0' }, checks: [], shots: [], measurements: {} };
const check = (name, pass, detail) => {
  report.checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
};
const shot = async (page, file) => {
  await page.screenshot({ path: join(OUT, file) });
  report.shots.push(`docs/evidence/wp06-foundation/${file}`);
};

// Counts live WebGL objects for every context on the page (MapLibre + Three).
const GL_COUNTER = () => {
  const live = { buffers: 0, vaos: 0, programs: 0, textures: 0, framebuffers: 0 };
  window.__glLive = live;
  const P = WebGL2RenderingContext.prototype;
  const wrap = (create, del, key) => {
    const c = P[create];
    const d = P[del];
    P[create] = function (...a) {
      const r = c.apply(this, a);
      if (r) live[key] += 1;
      return r;
    };
    P[del] = function (o, ...a) {
      if (o) live[key] -= 1;
      return d.call(this, o, ...a);
    };
  };
  wrap('createBuffer', 'deleteBuffer', 'buffers');
  wrap('createVertexArray', 'deleteVertexArray', 'vaos');
  wrap('createProgram', 'deleteProgram', 'programs');
  wrap('createTexture', 'deleteTexture', 'textures');
  wrap('createFramebuffer', 'deleteFramebuffer', 'framebuffers');
};

const idle = (page) => page.evaluate(() => new Promise((r) => { const m = window.__pg3d.map; m.once('idle', r); m.triggerRepaint(); }));

const browser = await chromium.launch({ channel: process.env.PG_BROWSER_CHANNEL ?? 'msedge', args: ['--js-flags=--expose-gc', '--enable-precise-memory-info'] });
report.browser = `${browser.browserType().name()} ${browser.version()}`;

// ---------------------------------------------------------------- A. harness
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ru-RU' });
  await ctx.addInitScript(GL_COUNTER);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && /\[map\]|THREE|WebGL/i.test(m.text()) && errors.push(m.text()));
  await page.goto(BASE + '/dev/3d');
  await page.waitForFunction(() => (window.__pg3d?.stats()?.drawCalls ?? 0) > 0, null, { timeout: 20_000 });
  await idle(page);
  const s0 = await page.evaluate(() => window.__pg3d.stats());
  check('A1 Three renders inside MapLibre 6 custom layer (shared WebGL2 context)', s0.drawCalls > 0 && s0.triangles > 0, s0);
  await shot(page, 'harness-render.png');

  // Ground alignment under several cameras; corners of the synthetic footprints.
  const pts = [[0.00045, 0.0007], [0.00255, 0.0009], [0.00135, 0.0002], [0.00165, 0.0004]];
  const cams = [
    { pitch: 0, bearing: 0, zoom: 17 },
    { pitch: 60, bearing: -40, zoom: 18.5 },
    { pitch: 45, bearing: 120, zoom: 16 },
    { pitch: 70, bearing: 10, zoom: 19.5 },
  ];
  let worst = 0;
  for (const cam of cams) {
    await page.evaluate((c) => window.__pg3d.map.jumpTo({ ...c, center: [0.0015, 0.0008] }), cam);
    await idle(page);
    const errs = await page.evaluate((p) => p.map((x) => window.__pg3d.alignment(x)), pts);
    worst = Math.max(worst, ...errs.map((e) => e ?? Infinity));
  }
  report.measurements.maxGroundAlignmentPx = worst;
  check('A2 footprints align with map.project under 4 camera states (< 0.5 px)', worst < 0.5, { worstPx: worst });
  await page.evaluate(() => window.__pg3d.map.jumpTo({ center: [0.0015, 0.0009], zoom: 17.6, pitch: 55, bearing: -25 }));
  await idle(page);

  const styles = await page.evaluate(() => window.__pg3d.describe());
  const by = Object.fromEntries(styles.map((x) => [x.basis, x]));
  check(
    'A3 height bases are visually distinct (solid / opaque / translucent dashed / ghost dashed / flat)',
    by.measured?.extruded && by.measured.fillOpacity === 1 && !by.measured.dashedEdges &&
      by.recorded_unverified?.extruded && by.recorded_unverified.fillOpacity > 0.7 && !by.recorded_unverified.dashedEdges &&
      by.floors_estimate?.extruded && by.floors_estimate.fillOpacity < 0.6 && by.floors_estimate.dashedEdges &&
      by.visual_placeholder?.extruded && by.visual_placeholder.fillOpacity < 0.3 && by.visual_placeholder.dashedEdges &&
      by.unknown && !by.unknown.extruded && by.unknown.dashedEdges,
    styles,
  );

  // Release: 25 cycles; live GL objects and JS heap must return to the pre-mount baseline.
  await page.evaluate(() => window.__pg3d.unmount());
  await idle(page);
  const after1 = await page.evaluate(() => window.__pg3d.lastStats());
  check('A4 unmount releases all Three geometries, materials and programs', after1?.disposed && after1.geometriesAfterRelease === 0, after1);
  await page.evaluate(() => window.gc?.());
  const baseGl = await page.evaluate(() => ({ ...window.__glLive }));
  const baseHeap = await page.evaluate(() => (window.gc?.(), performance.memory?.usedJSHeapSize ?? null));
  for (let i = 0; i < 25; i++) {
    await page.evaluate(() => window.__pg3d.mount());
    await idle(page);
    await page.evaluate(() => window.__pg3d.unmount());
    await idle(page);
  }
  await page.waitForTimeout(500);
  const endGl = await page.evaluate(() => ({ ...window.__glLive }));
  const endHeap = await page.evaluate(() => (window.gc?.(), window.gc?.(), performance.memory?.usedJSHeapSize ?? null));
  const glDelta = Object.fromEntries(Object.keys(baseGl).map((k) => [k, endGl[k] - baseGl[k]]));
  report.measurements.glDeltaAfter25Cycles = glDelta;
  report.measurements.heapGrowthBytesAfter25Cycles = baseHeap && endHeap ? endHeap - baseHeap : null;
  check('A5 25 mount/unmount cycles leave no live WebGL buffers/VAOs/programs/textures', Object.values(glDelta).every((d) => d <= 0), { baseGl, endGl });
  check('A6 JS heap growth after 25 cycles stays < 3 MB (forced GC)', report.measurements.heapGrowthBytesAfter25Cycles !== null && report.measurements.heapGrowthBytesAfter25Cycles < 3 * 1024 * 1024, {
    growthKB: report.measurements.heapGrowthBytesAfter25Cycles && Math.round(report.measurements.heapGrowthBytesAfter25Cycles / 1024),
  });

  // Context loss and restore.
  await page.evaluate(() => window.__pg3d.mount());
  await idle(page);
  const lost = await page.evaluate(() => new Promise((r) => {
    window.__pg3d.map.getCanvas().addEventListener('webglcontextlost', () => r(true), { once: true });
    if (!window.__pg3d.loseContext()) r(false);
  }));
  check('A7 forced context loss is observed', lost === true);
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__pg3d.restoreContext());
  const restored = await page.waitForFunction(() => (window.__pg3d?.stats()?.drawCalls ?? 0) > 0, null, { timeout: 15_000 }).then(() => true).catch(() => false);
  check('A8 after restore the Three layer is recreated and draws again', restored, await page.evaluate(() => window.__pg3d.stats()));
  await shot(page, 'harness-after-restore.png');
  check('A9 no map/Three/WebGL errors in console', errors.length === 0, errors.slice(0, 5));

  // Software renderer timing for information only (not P-04 acceptance).
  const fps = await page.evaluate(() => new Promise((r) => {
    const m = window.__pg3d.map;
    let n = 0;
    const t0 = performance.now();
    const step = () => {
      m.setBearing(m.getBearing() + 1);
      n += 1;
      if (performance.now() - t0 < 2000) requestAnimationFrame(step);
      else r(Math.round((n / (performance.now() - t0)) * 1000));
    };
    requestAnimationFrame(step);
  }));
  report.measurements.harnessFpsHeadlessSoftware = fps;
  await ctx.close();
}

// ---------------------------------------------------------------- B. real app with the live API
if (signedIn) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ru-RU' });
  const page = await ctx.newPage();
  const chunkRequests = [];
  page.on('request', (r) => /threeLayer|\/three\//.test(r.url()) && chunkRequests.push(r.url()));
  await signInViewer(ctx, page);
  await page.getByRole('button', { name: '3D-вид' }).waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1000);
  check('B1 2D map does not load the 3D module', chunkRequests.length === 0, chunkRequests);
  await page.getByRole('button', { name: '3D-вид' }).click();
  await page.getByText('Выберите опубликованный объект на карте').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(600);
  const on = await page.evaluate(() => ({ layer: Boolean(window.__pgMap?.getLayer('scene3d')), pitch: window.__pgMap?.getPitch() }));
  check('B2 3D module loads on demand and adds the shared-context layer', chunkRequests.length > 0 && on.layer && on.pitch > 40, { chunkRequests: chunkRequests.length, ...on });
  const panel = await page.locator('aside').first().innerText();
  check('B3 no buildings are invented; legend and limits are explained', panel.includes('не подставляет высоты') && panel.includes('Основание высот') && panel.includes('не является положением солнца'));
  await shot(page, 'app-3d-empty-state.png');
  // Context loss on the real map while 3D is on: explained, then recreated after restore.
  await page.evaluate(() => {
    window.__appLose = window.__pgMap.getCanvas().getContext('webgl2').getExtension('WEBGL_lose_context');
    window.__appLose.loseContext();
  });
  const lostShown = await page.getByText('Графический контекст потерян').waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__appLose.restoreContext());
  const back = await page.waitForFunction(() => Boolean(window.__pgMap?.getLayer('scene3d')) && Boolean(window.__pgMap?.getLayer('city-boundary-line')), null, { timeout: 15_000 }).then(() => true).catch(() => false);
  const noticeGone = !(await page.getByText('Графический контекст потерян').isVisible().catch(() => false));
  const after = await page.evaluate(() => ({
    scene: window.__pgScene?.state,
    scene3d: Boolean(window.__pgMap?.getLayer('scene3d')),
    boundary: Boolean(window.__pgMap?.getLayer('city-boundary-line')),
    styleLoaded: window.__pgMap?.isStyleLoaded(),
    layers: window.__pgMap?.getLayersOrder().length,
  }));
  check('B5 context loss in the app is explained; map style and 3D layer come back after restore', lostShown && back && noticeGone, { lostShown, back, noticeGone, after });
  await page.getByRole('button', { name: 'Выйти из 3D' }).first().click();
  await page.waitForTimeout(600);
  const off = await page.evaluate(() => ({ layer: Boolean(window.__pgMap?.getLayer('scene3d')), pitch: window.__pgMap?.getPitch() }));
  check('B4 exit removes the layer and restores the 2D camera', !off.layer && off.pitch < 1, off);
  await ctx.close();
} else {
  check('B* real app checks skipped (PG_TEST_CREDENTIALS not set)', true);
}

// ---------------------------------------------------------------- C. no WebGL2
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ru-RU' });
  await ctx.addInitScript(() => {
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...a) {
      if (type === 'webgl2' || type === 'webgl' || type === 'experimental-webgl') return null;
      return orig.call(this, type, ...a);
    };
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE + '/');
  await page.waitForTimeout(2500);
  const text = await page.locator('main').innerText();
  const signInFirst = text.includes('Требуется вход') && !(await page.locator('.map-overlay').count());
  check('C1 without WebGL and without session: sign-in is shown first, nothing covers it', signInFirst, { text: text.slice(0, 160) });
  check('C2 no 3D toggle is offered without WebGL', (await page.getByRole('button', { name: '3D-вид' }).count()) === 0);
  await page.goto(BASE + '/problems');
  await page.waitForTimeout(1000);
  check('C3 2D routes keep working without WebGL', new URL(page.url()).pathname === '/problems' && (await page.locator('main h1').innerText()).length > 0 && errors.length === 0, { url: page.url(), errors });
  await page.goto(BASE + '/');
  await page.waitForTimeout(1500);
  await shot(page, 'no-webgl-fallback.png');
  await ctx.close();
}

if (signedIn) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ru-RU' });
  await ctx.addInitScript(() => {
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...a) {
      if (type === 'webgl2' || type === 'webgl' || type === 'experimental-webgl') return null;
      return orig.call(this, type, ...a);
    };
  });
  const page = await ctx.newPage();
  await signInViewer(ctx, page);
  const link = page.getByRole('link', { name: 'Открыть таблицу проблем' });
  const shown = await link.waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
  await shot(page, 'no-webgl-signed-in.png');
  if (shown) await link.click();
  await page.waitForTimeout(800);
  check('C4 signed in without WebGL: explicit fallback, its 2D link works, no 3D offered', shown && new URL(page.url()).pathname === '/problems' && (await page.getByRole('button', { name: '3D-вид' }).count()) === 0, { url: page.url() });
  await ctx.close();
}

// ---------------------------------------------------------------- D. 3D chunk fails to load
if (signedIn) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ru-RU' });
  const page = await ctx.newPage();
  await page.route(/threeLayer/, (r) => r.abort('failed'));
  await signInViewer(ctx, page);
  await page.getByRole('button', { name: '3D-вид' }).waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: '3D-вид' }).click();
  const failed = await page.getByText('3D-модуль не загрузился').first().waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
  const mapAlive = await page.evaluate(() => Boolean(window.__pgMap?.getLayer('city-boundary-line')) && !window.__pgMap?.getLayer('scene3d'));
  const retries = await page.getByRole('button', { name: 'Повторить' }).count();
  check('D1 failed 3D chunk is explained with retry; 2D map stays intact', failed && mapAlive && retries >= 1, { failed, mapAlive, retries, state: await page.evaluate(() => window.__pgScene?.state) });
  await shot(page, 'app-3d-load-failed.png');
  await ctx.close();
}

await browser.close();
report.finishedAt = new Date().toISOString();
report.passed = report.checks.every((c) => c.pass);
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`\n${report.checks.filter((c) => c.pass).length}/${report.checks.length} checks passed`);
console.log('measurements', JSON.stringify(report.measurements));
process.exit(report.passed ? 0 : 1);
