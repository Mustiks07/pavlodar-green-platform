// Live checks for published map layers (listMapLayers + authorized MVT, ADR-012) against the
// integration API (http://localhost:8001 via Vite). Creates only SYNTHETIC TEST datasets.
//
//   PG_TEST_CREDENTIALS=<ignored local test-credentials.json> node scripts/layers-check.mjs
//
// Route: specialist uploads GeoJSON in the wizard -> admin publishes -> SPA navigation to the map
// shows the layer without a page reload; a viewer map open during a second publication drops the
// old version (no more tile requests) and draws the new one; errors and viewport loading.
import { chromium } from '@playwright/test';
import { sessionCookie } from './lib/session-login.mjs';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5173';
const OUT = resolve('../../docs/evidence/wp04-map-layers');
mkdirSync(OUT, { recursive: true });
const creds = JSON.parse(readFileSync(process.env.PG_TEST_CREDENTIALS ?? '', 'utf8'));
const FILES = mkdtempSync(join(tmpdir(), 'pg-layers-'));

const report = { base: BASE, startedAt: new Date().toISOString(), checks: [], shots: [], perf: {} };
const check = (name, pass, detail) => {
  report.checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
};
const shot = async (page, file) => {
  await page.screenshot({ path: join(OUT, file) });
  report.shots.push(`docs/evidence/wp04-map-layers/${file}`);
};
const settle = (page) =>
  page.waitForFunction(() => !document.querySelector('.pg-state .pg-spinner, .pg-skeleton'), null, { timeout: 15_000 }).catch(() => {});
const apiCall = (page, method, path, body) =>
  page.evaluate(
    async ({ method, path, body }) => {
      const me = await (await fetch('/v1/me')).json();
      const response = await fetch(path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': me.csrf_token,
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    },
    { method, path, body },
  );

async function login(browser, role, setup) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ru-RU' });
  if (setup) await setup(ctx);
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
const layersOf = (page) => page.evaluate(async (c) => (await (await fetch(`/v1/map/layers?city_id=${c}&limit=200`)).json()).items, city.id);

// ------------------------------------------------------------------ SYNTHETIC files
const ring = city.boundary.type === 'Polygon' ? city.boundary.coordinates[0] : city.boundary.coordinates[0][0];
const cx = (Math.min(...ring.map((c) => c[0])) + Math.max(...ring.map((c) => c[0]))) / 2;
const cy = (Math.min(...ring.map((c) => c[1])) + Math.max(...ring.map((c) => c[1]))) / 2;
const sq = (dx, dy, d = 0.0012) => [[[cx + dx - d, cy + dy - d], [cx + dx + d, cy + dy - d], [cx + dx + d, cy + dy + d], [cx + dx - d, cy + dy + d], [cx + dx - d, cy + dy - d]]];
const stamp = new Date().toISOString().slice(11, 19);
const zoneFixture = await apiCall(specialist.page, 'POST', '/v1/zones', {
  city_id: city.id,
  name: `SYNTHETIC TEST карточка зоны ${stamp}`,
  purpose: 'courtyard',
  geometry: { type: 'Polygon', coordinates: sq(-0.02, -0.02, 0.001) },
});
if (zoneFixture.status !== 201) throw new Error(`Synthetic zone fixture failed: ${zoneFixture.status}`);
const v1File = join(FILES, 'synthetic-layer-v1.geojson');
const v2File = join(FILES, 'synthetic-layer-v2.geojson');
const internalFile = join(FILES, 'synthetic-internal.geojson');
const restrictedFile = join(FILES, 'synthetic-restricted.geojson');
writeFileSync(v1File, JSON.stringify({ type: 'FeatureCollection', features: [
  { type: 'Feature', id: 'v1-a', properties: { name: 'SYNTHETIC v1 участок A', note: '<b>не HTML</b>' }, geometry: { type: 'Polygon', coordinates: sq(0, 0) } },
  { type: 'Feature', id: 'v1-b', properties: { name: 'SYNTHETIC v1 участок B', note: '<b>не HTML</b>' }, geometry: { type: 'Polygon', coordinates: sq(0.004, 0.002) } },
] }));
writeFileSync(v2File, JSON.stringify({ type: 'FeatureCollection', features: [
  { type: 'Feature', id: 'v2-a', properties: { name: 'SYNTHETIC v2 участок' }, geometry: { type: 'Polygon', coordinates: sq(-0.003, -0.002) } },
  { type: 'Feature', id: 'v2-l', properties: { name: 'SYNTHETIC v2 линия' }, geometry: { type: 'LineString', coordinates: [[cx - 0.006, cy], [cx + 0.006, cy + 0.003]] } },
  { type: 'Feature', id: 'v2-p', properties: { name: 'SYNTHETIC v2 точка' }, geometry: { type: 'Point', coordinates: [cx + 0.002, cy - 0.003] } },
] }));
writeFileSync(restrictedFile, JSON.stringify({ type: 'FeatureCollection', features: [
  { type: 'Feature', id: 'r-1', properties: { name: 'SYNTHETIC restricted' }, geometry: { type: 'Point', coordinates: [cx, cy + 0.004] } },
] }));
writeFileSync(internalFile, JSON.stringify({ type: 'FeatureCollection', features: [
  { type: 'Feature', id: 'i-1', properties: { name: 'SYNTHETIC internal' }, geometry: { type: 'Point', coordinates: [cx - 0.004, cy + 0.004] } },
] }));

async function uploadViaWizard(page, { create, datasetId, file, method }) {
  await page.goto(`${BASE}/imports?city=${city.id}`);
  await settle(page);
  if (create) {
    await page.getByRole('button', { name: 'Создать набор данных' }).click();
    await page.getByLabel(/^Название/).fill(create.name);
    await page.getByLabel('Тип', { exact: true }).selectOption('zones');
    await page.getByLabel('Владелец').fill('SYNTHETIC integration test');
    await page.getByLabel('Лицензия').fill('CC0-1.0');
    await page.getByLabel('Доступ', { exact: true }).selectOption(create.access);
    await page.getByRole('button', { name: 'Создать набор', exact: true }).click();
    await page.waitForFunction((n) => [...document.querySelectorAll('select option:checked')].some((o) => o.textContent?.includes(n)), create.name, { timeout: 15_000 });
    datasetId = await page.evaluate((n) => [...document.querySelectorAll('select option')].find((o) => o.textContent?.includes(n))?.value, create.name);
  } else {
    await page.getByLabel('Набор данных').selectOption(datasetId);
  }
  await page.locator('input[type=file]').setInputFiles(file);
  await page.getByLabel('Метод получения данных').fill(method);
  await page.getByRole('button', { name: 'Загрузить и проверить' }).click();
  await page.waitForURL(/[?&]job=/, { timeout: 60_000 });
  await page.getByText('Проверка завершена').waitFor({ timeout: 90_000 });
  const job = await page.evaluate(async (id) => (await fetch(`/v1/jobs/${id}`)).json(), new URL(page.url()).searchParams.get('job'));
  return { datasetId, versionId: job.result_ref_id, state: job.state };
}

async function publishViaUi(page, datasetId, versionId) {
  await page.goto(`${BASE}/imports?city=${city.id}&selected=${datasetId}`);
  await page.waitForSelector('.app-split.is-open .pg-card', { timeout: 20_000 });
  await settle(page);
  const item = page.locator('.app-versions > li').filter({ hasText: versionId.slice(0, 8) });
  await item.getByRole('button', { name: 'Опубликовать версию…' }).click();
  await page.locator('dialog[open]').getByLabel('Причина решения').fill('SYNTHETIC TEST: проверка слоя карты');
  await page.locator('dialog[open]').getByRole('button', { name: 'Опубликовать', exact: true }).click();
  await page.locator('dialog[open]').waitFor({ state: 'detached', timeout: 20_000 }).catch(() => {});
}

const waitSource = (page, layerIds, timeout = 20_000) =>
  page.waitForFunction((ids) => ids.every((id) => window.__pgMap?.getSource(`pgl-${id}`)), layerIds, { timeout }).then(() => true).catch(() => false);
const renderedCount = (page, layerId) =>
  page.evaluate((id) => {
    const m = window.__pgMap;
    const ids = m.getStyle().layers.filter((l) => l.source === `pgl-${id}`).map((l) => l.id);
    return { layers: m.getStyle().layers.filter((l) => l.source === `pgl-${id}`).map((l) => l.type), rendered: ids.length ? m.queryRenderedFeatures({ layers: ids }).length : 0 };
  }, layerId);
const idle = (page) => page.evaluate(() => new Promise((r) => (window.__pgMap.loaded() ? r(true) : window.__pgMap.once('idle', () => r(true)))));

// ------------------------------------------------------------------ v1: upload -> publish -> map
const dsName = `SYNTHETIC TEST слой ${stamp}`;
const v1 = await uploadViaWizard(specialist.page, { create: { name: dsName, access: 'public' }, file: v1File, method: 'SYNTHETIC TEST layers v1' });
check('specialist upload v1 via wizard: job succeeded, not yet a layer', v1.state === 'succeeded' && !(await layersOf(specialist.page)).some((l) => l.dataset_version_id === v1.versionId), v1);

const admin = await login(browser, 'admin');
// The map is opened first, so the layer query is already cached when the publication happens.
await admin.page.goto(`${BASE}/?city=${city.id}&ll=${cx.toFixed(5)},${cy.toFixed(5)}&z=14`);
await admin.page.waitForFunction(() => window.__pgMap?.getLayer('city-boundary-line'), null, { timeout: 30_000 });
await settle(admin.page);
const navEntriesBefore = await admin.page.evaluate(() => performance.getEntriesByType('navigation').length);
const t0 = Date.now();
// Publish from the imports page, reached by client-side navigation (no reload).
await admin.page.getByRole('navigation', { name: 'Разделы' }).getByRole('link', { name: 'Данные и источники', exact: true }).click();
await admin.page.getByRole('navigation', { name: 'Раздел данных' }).getByRole('link', { name: 'Импорт данных', exact: true }).click();
await admin.page.waitForURL(/\/imports/);
await settle(admin.page);
// Select the dataset through the list (SPA) and publish.
const row = admin.page.locator(`[data-row-id="${v1.datasetId}"]`);
if (await row.waitFor({ timeout: 10_000 }).then(() => true).catch(() => false)) await row.click();
else {
  // Not on the first list page: in-app navigation via the history API (still no document reload).
  await admin.page.evaluate((u) => {
    window.history.pushState(window.history.state, '', u);
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
  }, `/imports?city=${city.id}&selected=${v1.datasetId}`);
}
await admin.page.waitForSelector('.app-split.is-open .pg-card', { timeout: 20_000 });
await settle(admin.page);
const v1Item = admin.page.locator('.app-versions > li').filter({ hasText: v1.versionId.slice(0, 8) });
await v1Item.getByRole('button', { name: 'Опубликовать версию…' }).click();
await admin.page.locator('dialog[open]').getByLabel('Причина решения').fill('SYNTHETIC TEST: проверка слоя карты');
await admin.page.locator('dialog[open]').getByRole('button', { name: 'Опубликовать', exact: true }).click();
await admin.page.locator('dialog[open]').waitFor({ state: 'detached', timeout: 20_000 }).catch(() => {});
const v1Layers = (await layersOf(admin.page)).filter((l) => l.dataset_version_id === v1.versionId);
check('admin publish creates a polygon manifest for v1 (server)', v1Layers.length === 1 && v1Layers[0].geometry_type === 'polygon' && v1Layers[0].source_type === 'mvt', v1Layers.map((l) => ({ g: l.geometry_type, s: l.source_layer, url: l.source_url })));
const v1Layer = v1Layers[0];
await admin.page.getByRole('navigation', { name: 'Разделы' }).getByRole('link', { name: 'Обзор города', exact: true }).click();
await admin.page.waitForURL((u) => u.pathname === '/');
const tileReqs = [];
admin.page.on('response', (r) => r.url().includes('/v1/map/tiles/') && tileReqs.push({ url: new URL(r.url()).pathname, status: r.status(), type: r.headers()['content-type'] ?? '', at: Date.now() }));
const appeared = await waitSource(admin.page, [v1Layer.id]);
await admin.page.evaluate(([x, y]) => window.__pgMap.jumpTo({ center: [x, y], zoom: 15 }), [cx, cy]);
await idle(admin.page);
await admin.page.waitForTimeout(800);
const r1 = await renderedCount(admin.page, v1Layer.id);
const navEntriesAfter = await admin.page.evaluate(() => performance.getEntriesByType('navigation').length);
check('layer appears on the map after publish without a page reload', appeared && r1.rendered > 0 && navEntriesBefore === navEntriesAfter, { appeared, ...r1, sec: Math.round((Date.now() - t0) / 1000), reloads: navEntriesAfter - navEntriesBefore });
check('polygon layer drawn as fill + outline from source_layer "features"', r1.layers.join(',') === 'fill,line');
const v1Tiles = tileReqs.filter((r) => r.url.includes(v1Layer.id));
check('MVT tiles fetched from the server source_url (200, vector-tile type)', v1Tiles.length > 0 && v1Tiles.every((r) => [200, 304].includes(r.status)) && v1Tiles.some((r) => r.type.startsWith('application/vnd.mapbox-vector-tile')), { n: v1Tiles.length, sample: v1Tiles.slice(0, 2) });
const panel = admin.page.locator(`.map-layer[data-layer-id="${v1Layer.id}"]`);
// Version details are collapsed on the main map; open them to read the version and date.
await panel.locator('details.map-layer__more summary').click().catch(() => {});
const panelText = await panel.innerText().catch(() => '');
check('panel shows legend, observed_at, access_level and dataset_version_id; no source line (attribution lives in the map control)', /Легенда/.test(panelText) && !/Источник/.test(panelText) && panelText.includes(v1.versionId.slice(0, 8)) && /открытый/.test(panelText) && /Дата наблюдения/.test(panelText) && /Объекты опубликованного набора/.test(panelText), panelText.slice(0, 400));
const attrib = await admin.page.locator('.maplibregl-ctrl-attrib').innerText().catch(() => '');
check('map attribution includes the layer attribution (escaped text)', attrib.includes('SYNTHETIC integration test · CC0-1.0'), attrib.slice(0, 200));
const swatch = await panel.locator('.pg-swatch').first().evaluate((e) => e.style.background).catch(() => '');
check('legend swatch is the semantic token (neutral, basemap palette), not an invented colour', swatch.includes('--pg-basemap-neutral'), swatch);
await panel.scrollIntoViewIfNeeded();
await shot(admin.page, 'layer-published-admin.png');

// Inspector: click the centre of v1 feature A.
// Zones are drawn above data and win the click: pick a pixel of v1 feature B that no zone covers.
await admin.page.evaluate(([x, y]) => window.__pgMap.jumpTo({ center: [x, y], zoom: 16 }), [cx + 0.004, cy + 0.002]);
await idle(admin.page);
const pt = await admin.page.evaluate((id) => {
  const m = window.__pgMap;
  const ids = m.getStyle().layers.filter((l) => l.source === `pgl-${id}`).map((l) => l.id);
  const c = m.getCanvas();
  for (let y = 40; y < c.clientHeight - 40; y += 12)
    for (let x = 40; x < c.clientWidth - 40; x += 12) {
      const data = m.queryRenderedFeatures([x, y], { layers: ids });
      const zone = m.getLayer('zones-fill') ? m.queryRenderedFeatures([x, y], { layers: ['zones-fill'] }) : [];
      if (data.some((f) => f.properties?.name === 'SYNTHETIC v1 участок B') && zone.length === 0) return { x, y };
    }
  return null;
}, v1Layer.id);
const canvasBox = await admin.page.locator('.map-canvas').boundingBox();
const tilePropsB = pt ? await admin.page.evaluate(([p, id]) => {
  const m = window.__pgMap;
  const ids = m.getStyle().layers.filter((l) => l.source === `pgl-${id}`).map((l) => l.id);
  return m.queryRenderedFeatures([p.x, p.y], { layers: ids })[0]?.properties ?? null;
}, [pt, v1Layer.id]) : null;
const featReqs = [];
admin.page.on('response', (r) => r.url().includes('/v1/map/features/') && featReqs.push({ path: new URL(r.url()).pathname, status: r.status() }));
if (pt) await admin.page.mouse.click(canvasBox.x + pt.x, canvasBox.y + pt.y);
const insp = admin.page.locator('.map-inspect');
const featureB = tilePropsB?.feature_id ?? null;
check('MVT carries a uuid feature_id property (not the numeric row id)', /^[0-9a-f-]{36}$/i.test(featureB ?? ''), { feature_id: featureB });
const cardOk = await insp.locator('.map-inspect__server').waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
const cardText = cardOk ? await insp.innerText() : '';
const urlFeature = new URL(admin.page.url()).searchParams.get('feature');
check('click on a feature: server card from getMapFeature(feature_id) — label, version; no source/unverified lines (presentation policy)', cardOk && featReqs.some((r) => r.path === `/v1/map/features/${featureB}` && r.status === 200) && cardText.includes('SYNTHETIC v1 участок B') && cardText.includes(v1.versionId.slice(0, 8)) && cardText.includes(dsName) && !/Источник|не провер/i.test(cardText) && /не рассчитывает показатели/.test(cardText) && /основание неизвестно/.test(cardText), { requests: featReqs, text: cardText.slice(0, 400) });
check('open feature is in the URL (?feature=<uuid>)', urlFeature === featureB, { urlFeature });
const hl = await admin.page.evaluate(() => window.__pgMap.querySourceFeatures('feature-highlight').length);
check('server geometry of the feature is highlighted on the map', hl > 0, { features: hl });
await insp.locator('summary').click();
const rawText = await insp.innerText();
const inspHtml = await insp.innerHTML();
check('tile attributes stay available as text without an unverified label; HTML not interpreted; platform id hidden', rawText.includes('<b>не HTML</b>') && !/не провер/i.test(rawText) && !/<b>/.test(inspHtml) && !rawText.includes('feature_id'), rawText.slice(0, 300));
await shot(admin.page, 'layer-inspector.png');
await admin.page.reload();
const afterReload = await insp.locator('.map-inspect__server').waitFor({ timeout: 30_000 }).then(() => true).catch(() => false);
const reloadText = afterReload ? await insp.innerText() : '';
await admin.page.waitForFunction(() => window.__pgMap?.getSource('feature-highlight'), null, { timeout: 15_000 }).catch(() => {});
await idle(admin.page);
const hlReload = await admin.page.evaluate(() => window.__pgMap.querySourceFeatures('feature-highlight').length);
check('feature card survives reload (server card from the URL, highlight restored, no tile attributes)', afterReload && reloadText.includes('SYNTHETIC v1 участок B') && hlReload > 0 && (await insp.locator('summary').count()) === 0, { hlReload, text: reloadText.slice(0, 160) });
await shot(admin.page, 'feature-card-reload.png');
await insp.getByRole('button', { name: 'Закрыть карточку объекта' }).click();
await insp.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
const closed = (await insp.count()) === 0 && !new URL(admin.page.url()).searchParams.get('feature') && (await admin.page.evaluate(() => window.__pgMap.querySourceFeatures('feature-highlight').length)) === 0;
check('closing the card clears the URL and the highlight', closed);
{
  // A feature card and a zone card are exclusive: opening a zone from the list closes the feature.
  await admin.page.goto(`${BASE}/?city=${city.id}&feature=${featureB}&ll=${(cx + 0.004).toFixed(5)},${(cy + 0.002).toFixed(5)}&z=16`);
  await insp.locator('.map-inspect__server').waitFor({ timeout: 30_000 }).catch(() => {});
  const row = admin.page.locator('[data-row-id]').first();
  const hasRow = await row.waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
  if (hasRow) await row.click();
  await admin.page.waitForTimeout(800);
  const u = new URL(admin.page.url()).searchParams;
  check('selecting a zone closes the feature card (one selection in the URL)', hasRow && Boolean(u.get('zone')) && !u.get('feature') && (await insp.count()) === 0, { zone: Boolean(u.get('zone')), feature: u.get('feature') });
}
await admin.page.goto(`${BASE}/?city=${city.id}`);
await admin.page.waitForFunction(() => window.__pgMap?.getLayer('city-boundary-line'), null, { timeout: 30_000 });
await settle(admin.page);

// Toggle hides the layer and stops its tiles; survives reload.
await panel.getByRole('checkbox').uncheck();
await admin.page.waitForTimeout(300);
const hiddenGone = await admin.page.evaluate((id) => !window.__pgMap.getSource(`pgl-${id}`), v1Layer.id);
await admin.page.reload();
await admin.page.waitForFunction(() => window.__pgMap?.getLayer('city-boundary-line'), null, { timeout: 30_000 });
await settle(admin.page);
await admin.page.waitForTimeout(1500);
const stillHidden = await admin.page.evaluate((id) => !window.__pgMap.getSource(`pgl-${id}`), v1Layer.id);
const unchecked = !(await admin.page.locator(`.map-layer[data-layer-id="${v1Layer.id}"]`).getByRole('checkbox').isChecked());
check('hiding a layer removes its source; the choice survives reload', hiddenGone && stillHidden && unchecked, { hiddenGone, stillHidden, unchecked });
await admin.page.locator(`.map-layer[data-layer-id="${v1Layer.id}"]`).getByRole('checkbox').check();
check('re-enabling draws it again', await waitSource(admin.page, [v1Layer.id]));

// ------------------------------------------------------------------ viewport performance
{
  const p = admin.page;
  // MapLibre 6 fetches tiles in its worker: measured from the network, not page resource timings.
  const net = [];
  const onResp = (resp) => {
    if (!resp.url().includes('/v1/map/tiles/')) return;
    const tm = resp.request().timing();
    net.push({ status: resp.status(), ms: tm.responseEnd > 0 ? tm.responseEnd : null });
  };
  p.on('response', onResp);
  const ourLoaded = () =>
    p.waitForFunction(() => {
      const m = window.__pgMap;
      return Object.keys(m.getStyle().sources).filter((s) => s.startsWith('pgl-')).every((s) => m.isSourceLoaded(s));
    }, null, { timeout: 30_000, polling: 25 });
  await p.evaluate(([x, y]) => window.__pgMap.jumpTo({ center: [x, y], zoom: 13 }), [cx, cy]);
  await idle(p);
  await new Promise((r) => setTimeout(r, 300));
  net.length = 0;
  await p.evaluate(() => performance.clearResourceTimings());
  const steps = [];
  const ours = [];
  for (const [dx, dy] of [[0.02, 0], [0, 0.015], [-0.02, 0], [0, -0.015]]) {
    const s = Date.now();
    await p.evaluate(([x, y]) => window.__pgMap.jumpTo({ center: [x, y] }), [cx + dx, cy + dy]);
    await p.waitForTimeout(50);
    await ourLoaded();
    ours.push(Date.now() - s);
    await idle(p);
    steps.push(Date.now() - s);
  }
  p.off('response', onResp);
  // Tiles are fetched on the main thread by the pgtile protocol: resource timings are available.
  const d = await p.evaluate(() => performance.getEntriesByType('resource').filter((r) => r.name.includes('/v1/map/tiles/')).map((r) => r.duration).sort((a, b) => a - b));
  const q = (x) => (d.length ? Math.round(d[Math.min(d.length - 1, Math.ceil(x * d.length) - 1)]) : null);
  const meta = await p.evaluate(() => {
    const m = window.__pgMap;
    const c = m.getCanvas();
    return { zoom: m.getZoom(), canvas: [c.clientWidth, c.clientHeight], sources: Object.keys(m.getStyle().sources).filter((s) => s.startsWith('pgl-')).length };
  });
  // Only viewport tiles: at z13 the canvas spans ~3x3 512px tiles, a pan adds a few new ones per source.
  const perSourceStep = net.length / Math.max(1, meta.sources) / 4;
  report.perf = {
    ...meta,
    tileResponses: net.length,
    statuses: [...new Set(net.map((r) => r.status))],
    tileMsP50: q(0.5),
    tileMsP95: q(0.95),
    perSourcePerPan: Math.round(perSourceStep * 10) / 10,
    publishedSourcesLoadedMs: ours,
    mapIdleInclBasemapMs: steps,
  };
  // Client-side contract: only viewport tiles, all answered. Latency under concurrency is the API's
  // (P-02/P-03, ADR-012): recorded in report.perf and reported, not hidden behind a pass.
  check('viewport loading: only the newly visible tiles per source are requested, all answered', perSourceStep <= 12 && net.every((r) => [200, 304].includes(r.status)), report.perf);
  const probe = await p.evaluate(async ([url, x0, y0]) => {
    const out = [];
    for (let i = 0; i < 8; i++) {
      const u = url.replace('{z}', '13').replace('{x}', String(x0 + (i % 4))).replace('{y}', String(y0 + Math.floor(i / 4)));
      const t = performance.now();
      const res = await fetch(u, { cache: 'no-store' });
      await res.arrayBuffer();
      out.push(Math.round(performance.now() - t));
    }
    return out.sort((a, b) => a - b);
  }, [v1Layer.source_url, Math.floor(((cx + 180) / 360) * 8192), Math.floor(((1 - Math.log(Math.tan((cy * Math.PI) / 180) + 1 / Math.cos((cy * Math.PI) / 180)) / Math.PI) / 2) * 8192)]);
  report.perf.sequentialTileMs = probe;
  console.log(`INFO sequential tile latency (no queueing, dev proxy): ${JSON.stringify(probe)}`);
  // 32 distinct tiles at once: through the browser + Vite proxy, and from Node straight to the API.
  const x0 = Math.floor(((cx + 180) / 360) * 8192) - 4;
  const y0 = Math.floor(((1 - Math.log(Math.tan((cy * Math.PI) / 180) + 1 / Math.cos((cy * Math.PI) / 180)) / Math.PI) / 2) * 8192) - 2;
  const paths = Array.from({ length: 32 }, (_, i) => v1Layer.source_url.replace('{z}', '13').replace('{x}', String(x0 + (i % 8))).replace('{y}', String(y0 + Math.floor(i / 8))));
  const viaBrowser = await p.evaluate(async (ps) => {
    const t = performance.now();
    await Promise.all(ps.map((u) => fetch(u, { cache: 'no-store' }).then((r) => r.arrayBuffer())));
    return Math.round(performance.now() - t);
  }, paths);
  const cookie = (await admin.ctx.cookies(BASE)).map((c) => `${c.name}=${c.value}`).join('; ');
  const api = process.env.PG_API_ORIGIN ?? 'http://127.0.0.1:8001';
  const tDirect = Date.now();
  const direct = await Promise.all(paths.map((u) => fetch(api + u, { headers: { cookie } }).then(async (r) => ({ s: r.status, n: (await r.arrayBuffer()).byteLength }))));
  const viaNodeDirect = Date.now() - tDirect;
  report.perf.parallel32 = { viaBrowserAndProxyMs: viaBrowser, viaNodeDirectToApiMs: viaNodeDirect, directStatuses: [...new Set(direct.map((d) => d.s))] };
  console.log(`INFO 32 parallel tiles: ${JSON.stringify(report.perf.parallel32)}`);
  const lowNet = [];
  const onLow = (resp) => resp.url().includes('/v1/map/tiles/') && lowNet.push(resp.url());
  p.on('response', onLow);
  await p.evaluate(() => window.__pgMap.jumpTo({ zoom: 4 }));
  await idle(p);
  await p.waitForTimeout(500);
  p.off('response', onLow);
  const lowZoom = lowNet.length;
  const zoomNote = await p.locator(`.map-layer[data-layer-id="${v1Layer.id}"]`).innerText();
  check('below min_zoom no tiles are requested and the panel says to zoom in', lowZoom === 0 && /Слой виден с масштаба 5/.test(zoomNote), { lowZoom });
}

// ------------------------------------------------------------------ v2: version switch on an open viewer map
const internal = await uploadViaWizard(specialist.page, {
  create: { name: `SYNTHETIC TEST internal ${stamp}`, access: 'internal' },
  file: internalFile,
  method: 'SYNTHETIC TEST internal access',
});
await publishViaUi(admin.page, internal.datasetId, internal.versionId);
const viewer = await login(browser, 'viewer');
const vTiles = [];
viewer.page.on('response', (r) => r.url().includes('/v1/map/tiles/') && vTiles.push({ url: new URL(r.url()).pathname, status: r.status(), at: Date.now() }));
await viewer.page.goto(`${BASE}/?city=${city.id}&ll=${cx.toFixed(5)},${cy.toFixed(5)}&z=14`);
const viewerSawV1 = await waitSource(viewer.page, [v1Layer.id], 30_000);
await idle(viewer.page);
check('viewer sees the published public layer', viewerSawV1);
{
  const internal = (await layersOf(admin.page)).filter((l) => l.access_level === 'internal');
  const vList = await layersOf(viewer.page);
  const st = internal[0] ? await viewer.page.evaluate(async (u) => (await fetch(u)).status, internal[0].source_url.replace('{z}', '12').replace('{x}', '0').replace('{y}', '0')) : null;
  check('viewer (below specialist): internal layers neither listed nor served', internal.length > 0 && !vList.some((l) => l.access_level === 'internal') && st === 403, { internalForAdmin: internal.length, internalForViewer: vList.filter((l) => l.access_level === 'internal').length, tileStatus: st });
}

const v2 = await uploadViaWizard(specialist.page, { datasetId: v1.datasetId, file: v2File, method: 'SYNTHETIC TEST layers v2' });
await publishViaUi(admin.page, v1.datasetId, v2.versionId);
const switchedAt = Date.now();
const v2Layers = (await layersOf(admin.page)).filter((l) => l.dataset_version_id === v2.versionId);
check('v2 (polygon + line + point) publishes three manifests; v1 manifest is no longer listed', v2Layers.length === 3 && !(await layersOf(admin.page)).some((l) => l.id === v1Layer.id), v2Layers.map((l) => l.geometry_type));
// The viewer moves the map: old tiles answer 404 (not current), the list is refetched.
await viewer.page.evaluate(() => window.__pgMap.jumpTo({ zoom: window.__pgMap.getZoom() + 1 }));
const switched = await waitSource(viewer.page, v2Layers.map((l) => l.id), 30_000);
const oldGone = await viewer.page.evaluate((id) => !window.__pgMap.getSource(`pgl-${id}`), v1Layer.id);
await idle(viewer.page);
const goneAt = Date.now();
for (const z of [13, 15, 14]) {
  await viewer.page.evaluate((zz) => window.__pgMap.jumpTo({ zoom: zz }), z);
  await idle(viewer.page);
}
const oldAfter = vTiles.filter((r) => r.url.includes(v1Layer.id) && r.at > goneAt);
const oldDuring = vTiles.filter((r) => r.url.includes(v1Layer.id) && r.at > switchedAt);
check('version switch without reload: old source removed, no old tiles requested after the switch', switched && oldGone && oldAfter.length === 0, { switched, oldGone, oldAfterSwitch: oldDuring.map((r) => r.status), oldAfterRemoval: oldAfter.length });
const types = await viewer.page.evaluate((ids) => ids.map((id) => window.__pgMap.getStyle().layers.filter((l) => l.source === `pgl-${id}`).map((l) => l.type).join('+')), v2Layers.map((l) => l.id));
const byGeom = Object.fromEntries(v2Layers.map((l, i) => [l.geometry_type, types[i]]));
check('geometry_type drives rendering: polygon fill+line, line line, point circle', byGeom.polygon === 'fill+line' && byGeom.line === 'line' && byGeom.point === 'circle', byGeom);
const order = await viewer.page.evaluate(() => window.__pgMap.getStyle().layers.map((l) => l.id));
const zoneIdx = order.indexOf('zones-fill');
const dataIdx = order.map((id, i) => (id.startsWith('pgl-') ? i : -1)).filter((i) => i >= 0);
check('published data stays under platform layers (boundary, zones, selection)', zoneIdx === -1 || dataIdx.every((i) => i < zoneIdx), { zoneIdx, maxData: Math.max(...dataIdx) });
await viewer.page.evaluate(([x, y]) => window.__pgMap.jumpTo({ center: [x, y], zoom: 15 }), [cx, cy]);
await idle(viewer.page);
await viewer.page.waitForTimeout(500);
await shot(viewer.page, 'layer-v2-viewer.png');
await viewer.page.locator(`.map-layer[data-layer-id="${v2Layers[0].id}"]`).scrollIntoViewIfNeeded();
await shot(viewer.page, 'layer-v2-panel.png');

{
  // The v1 feature is not in the current version any more: the card says so instead of stale data.
  await viewer.page.goto(`${BASE}/?city=${city.id}&feature=${featureB}&ll=${cx.toFixed(5)},${cy.toFixed(5)}&z=14`);
  const gone = await viewer.page.getByText('Объект недоступен').waitFor({ timeout: 30_000 }).then(() => true).catch(() => false);
  check('feature of a superseded version: card shows "not available" (404), no stale server data', gone && (await viewer.page.locator('.map-inspect .map-inspect__server').count()) === 0, { gone });
  await shot(viewer.page, 'feature-card-404.png');
}

// ------------------------------------------------------------------ IDOR / access
// createDataset grants only the creator, and no API grants anyone else: the admin creates it.
const r = await uploadViaWizard(admin.page, { create: { name: `SYNTHETIC TEST restricted ${stamp}`, access: 'restricted' }, file: restrictedFile, method: 'SYNTHETIC TEST restricted' });
await publishViaUi(admin.page, r.datasetId, r.versionId);
const seen = {};
for (const [role, pg] of [['specialist', specialist.page], ['admin', admin.page], ['viewer', viewer.page]]) seen[role] = (await layersOf(pg)).find((l) => l.dataset_version_id === r.versionId) ?? null;
const rLayer = seen.admin ?? seen.specialist;
const viewerList = await layersOf(viewer.page);
const [tx, ty] = (() => {
  const z = 12;
  const n = 2 ** z;
  const x = Math.floor(((cx + 180) / 360) * n);
  const lat = (cy * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n);
  return [x, y];
})();
const tileUrl = (l) => l.source_url.replace('{z}', '12').replace('{x}', String(tx)).replace('{y}', String(ty));
const viewerRestricted = rLayer ? await viewer.page.evaluate(async (u) => (await fetch(u)).status, tileUrl(rLayer)) : null;
const specRestricted = rLayer ? await specialist.page.evaluate(async (u) => (await fetch(u)).status, tileUrl(rLayer)) : null;
check('restricted layer: grant holder sees it; specialist and viewer without grant get no manifest and 404 tiles', Boolean(seen.admin) && !seen.specialist && !seen.viewer && viewerRestricted === 404 && specRestricted === 404, {
  specialistTile: specRestricted,
  seenBy: Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, Boolean(v)])),
  access: rLayer?.access_level,
  viewerListed: viewerList.some((l) => l.id === rLayer?.id),
  viewerTile: viewerRestricted,
});
// getMapFeature IDOR: the feature uuid is deterministic (md5 of version id + row index), so
// guessing it must not reveal a restricted record.
const featureUuid = (versionId, row) => {
  const h = createHash('md5').update(`pavlodar:map-feature:${versionId}:${row}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
{
  const rf = featureUuid(r.versionId, 0);
  const st = {};
  for (const [role, pg] of [['admin', admin.page], ['specialist', specialist.page], ['viewer', viewer.page]]) st[role] = await pg.evaluate(async (u) => (await fetch(u)).status, `/v1/map/features/${rf}`);
  check('getMapFeature on a restricted record: grant holder 200, specialist and viewer 404', st.admin === 200 && st.specialist === 404 && st.viewer === 404, st);
  const unknown = await viewer.page.evaluate(async () => {
    const res = await fetch(`/v1/map/features/${crypto.randomUUID()}`);
    return { status: res.status, type: res.headers.get('content-type') };
  });
  const bad = await viewer.page.evaluate(async () => (await fetch('/v1/map/features/17')).status);
  check('getMapFeature: unknown uuid 404 problem+json; numeric MVT id is not an API id (4xx)', unknown.status === 404 && /problem\+json/.test(unknown.type ?? '') && bad >= 400 && bad < 500, { unknown, numericId: bad });
  const { ctx, page } = await login(browser, 'viewer');
  await page.goto(`${BASE}/?city=${city.id}&feature=${rf}`);
  const shown = await page.getByText('Объект недоступен').waitFor({ timeout: 30_000 }).then(() => true).catch(() => false);
  const leaked = (await page.locator('.map-inspect').innerText().catch(() => '')).includes('SYNTHETIC restricted');
  check('viewer with a restricted feature link sees "not available", nothing of the record', shown && !leaked, { shown, leaked });
  await ctx.close();
}
const random = await viewer.page.evaluate(async () => {
  const res = await fetch(`/v1/map/tiles/${crypto.randomUUID()}/12/0/0.mvt`);
  return { status: res.status, type: res.headers.get('content-type') };
});
check('unknown layer id: 404 problem+json, no tile', random.status === 404 && /problem\+json/.test(random.type ?? ''), random);
{
  const anon = await browser.newContext();
  const ap = await anon.newPage();
  await ap.goto(BASE + '/health/ready').catch(() => {});
  const st = await ap.evaluate(async (u) => (await fetch(u)).status, tileUrl(v2Layers[0]));
  check('tile without a session is refused (401)', st === 401, { status: st });
  const fst = await ap.evaluate(async (u) => (await fetch(u)).status, `/v1/map/features/${featureB}`);
  check('getMapFeature without a session is refused (401)', fst === 401, { status: fst });
  await anon.close();
}

// ------------------------------------------------------------------ UI error states (intercepted)
{
  const { ctx, page } = await login(browser, 'viewer', async (c) => {
    await c.route(/\/v1\/map\/tiles\//, (route) => route.fulfill({ status: 403, contentType: 'application/problem+json', body: JSON.stringify({ type: 'about:blank', title: 'Forbidden', status: 403, code: 'forbidden', detail: 'SYNTHETIC TEST intercepted' }) }));
  });
  await page.goto(`${BASE}/?city=${city.id}&ll=${cx.toFixed(5)},${cy.toFixed(5)}&z=14`);
  await page.getByText('Нет доступа к этому набору: тайлы не выдаются.').first().waitFor({ timeout: 30_000 }).catch(() => {});
  const shown = await page.getByText('Нет доступа к этому набору: тайлы не выдаются.').first().isVisible().catch(() => false);
  check('tile 403 is shown on the layer, not silently empty', shown);
  await page.getByText('Нет доступа к этому набору').first().scrollIntoViewIfNeeded().catch(() => {});
  await shot(page, 'layer-tiles-403.png');
  await ctx.close();
}
{
  let fail = true;
  const { ctx, page } = await login(browser, 'viewer', async (c) => {
    await c.route(/\/v1\/map\/layers/, (route) => (fail ? route.fulfill({ status: 503, contentType: 'application/problem+json', body: JSON.stringify({ type: 'about:blank', title: 'Service Unavailable', status: 503, code: 'service_unavailable', detail: 'SYNTHETIC TEST intercepted' }) }) : route.continue()));
  });
  await page.goto(`${BASE}/?city=${city.id}`);
  const retry = page.locator('.map-layers, .app-main').getByRole('button', { name: /Повторить/ }).last();
  const errShown = await retry.waitFor({ timeout: 30_000 }).then(() => true).catch(() => false);
  await shot(page, 'layers-list-503.png');
  fail = false;
  if (errShown) await retry.click();
  const recovered = await page.locator('.map-layer').first().waitFor({ timeout: 20_000 }).then(() => true).catch(() => false);
  check('listMapLayers 503: error with retry; retry recovers without reload', errShown && recovered, { errShown, recovered });
  await ctx.close();
}
{
  const { ctx, page } = await login(browser, 'viewer', async (c) => {
    await c.route(/\/v1\/map\/layers/, async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      body.items = body.items.map((l, i) => (i === 0 ? { ...l, source_url: 'https://evil.example/{z}/{x}/{y}.mvt' } : l));
      await route.fulfill({ response: res, json: body });
    });
  });
  const evil = [];
  page.on('request', (rq) => rq.url().includes('evil.example') && evil.push(rq.url()));
  await page.goto(`${BASE}/?city=${city.id}`);
  const note = await page.getByText('Адрес тайлов на другом домене').first().waitFor({ timeout: 30_000 }).then(() => true).catch(() => false);
  await page.waitForTimeout(1500);
  check('cross-origin source_url is refused (no request, explained)', note && evil.length === 0, { note, requests: evil.length });
  await ctx.close();
}

{
  let fail = true;
  const v2Point = v2Layers.find((l) => l.geometry_type === 'point');
  const { ctx, page } = await login(browser, 'viewer', async (c) => {
    await c.route(/\/v1\/map\/features\//, (route) => (fail ? route.fulfill({ status: 503, contentType: 'application/problem+json', body: JSON.stringify({ type: 'about:blank', title: 'Service Unavailable', status: 503, code: 'service_unavailable', detail: 'SYNTHETIC TEST intercepted' }) }) : route.continue()));
  });
  const v2f = featureUuid(v2.versionId, 2);
  await page.goto(`${BASE}/?city=${city.id}&feature=${v2f}`);
  const retry = page.locator('.map-inspect').getByRole('button', { name: /Повторить/ });
  const errShown = await retry.waitFor({ timeout: 30_000 }).then(() => true).catch(() => false);
  await shot(page, 'feature-card-503.png');
  fail = false;
  if (errShown) await retry.click();
  const recovered = await page.locator('.map-inspect .map-inspect__server').waitFor({ timeout: 20_000 }).then(() => true).catch(() => false);
  const text = recovered ? await page.locator('.map-inspect').innerText() : '';
  // Framing animates the camera; read the zoom once it has settled.
  await page.waitForFunction(() => !window.__pgMap.isMoving() && window.__pgMap.loaded(), null, { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(300);
  const framed = await page.evaluate(() => window.__pgMap.getZoom());
  check('getMapFeature 503: error with retry in the card; retry recovers; shared link frames the feature', errShown && recovered && text.includes('SYNTHETIC v2 точка') && /точки/.test(text) && framed > 15, { errShown, recovered, zoom: framed, layer: v2Point?.id });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(600);
  await shot(page, 'feature-card-dark.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  const box = await page.locator('.map-inspect').boundingBox();
  const toggle = await page.locator('.scene3d-toggle').boundingBox().catch(() => null);
  const overlap = Boolean(box && toggle && toggle.y + toggle.height > box.y && toggle.x + toggle.width > box.x);
  check('feature card fits a phone viewport without covering the 3D toggle', Boolean(box) && box.x >= 0 && box.x + box.width <= 390 && !overlap, { box, toggle });
  await shot(page, 'feature-card-mobile.png');
  await ctx.close();
}

// Dark theme screenshot of the layer panel and map.
{
  await viewer.page.emulateMedia({ colorScheme: 'dark' });
  await viewer.page.waitForTimeout(800);
  await shot(viewer.page, 'layer-v2-dark.png');
}

await browser.close();
report.finishedAt = new Date().toISOString();
report.passed = report.checks.every((c) => c.pass);
report.synthetic = { datasets: [dsName, `SYNTHETIC TEST restricted ${stamp}`], versions: [v1.versionId, v2.versionId, r.versionId] };
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`\n${report.checks.filter((c) => c.pass).length}/${report.checks.length} checks passed`);
process.exit(report.passed ? 0 : 1);
