// Read-only live check of the real Pavlodar open working layers as a plain viewer (ADR-029 GPT):
// datasets/layers/record counts in the UI equal the API (nothing hard-coded), each family renders,
// toggles and legends work, layer families are told apart, the feature card and 3D show server
// heights only, and main screens carry no repeated "Источник"/"не проверено" lines.
//
//   PG_TEST_CREDENTIALS=<path> PG_CITY_ID=<uuid> node scripts/open-data-check.mjs
// Runs against the shared API behind the dev server (default http://localhost:5173 -> :8001).
import { chromium } from '@playwright/test';
import { sessionCookie } from './lib/session-login.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5173';
const CITY = process.env.PG_CITY_ID ?? '2de4e9e4-1602-5bdb-b17d-13df22510458';
const OUT = resolve('../../docs/evidence/wp03-open-data');
const creds = JSON.parse(readFileSync(process.env.PG_TEST_CREDENTIALS ?? '', 'utf8'));
// GPT's live smoke lists one sample tile per family; used only to find where each family is.
const live = JSON.parse(readFileSync(resolve('../../docs/evidence/pavlodar_open_live.json'), 'utf8'));
mkdirSync(OUT, { recursive: true });

const report = { base: BASE, city: CITY, startedAt: new Date().toISOString(), checks: [], shots: [], facts: {} };
const check = (name, pass, detail) => {
  report.checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
};
const shot = async (page, file) => {
  await page.screenshot({ path: join(OUT, file), fullPage: false });
  report.shots.push(`docs/evidence/wp03-open-data/${file}`);
};
const POLICY = /Источник|не провер/i;

async function login(browser, role, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ru-RU', ...opts });
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
const api = (page, path) => page.evaluate(async (p) => { const r = await fetch(p); return { status: r.status, body: await r.json().catch(() => null) }; }, path);
const idle = (page) => page.evaluate(() => new Promise((r) => (window.__pgMap.loaded() ? r(true) : window.__pgMap.once('idle', () => r(true)))));
const tileCentre = ([z, x, y]) => {
  const n = 2 ** z;
  const lng = ((x + 0.5) / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) * 180) / Math.PI;
  return [lng, lat];
};
const rendered = (page, layerId) =>
  page.evaluate((id) => {
    const m = window.__pgMap;
    const ids = m.getStyle().layers.filter((l) => l.source === `pgl-${id}` && l.type !== 'fill-extrusion').map((l) => l.id);
    if (!ids.length) return { onMap: false, n: 0, distinct: 0 };
    const fs = m.queryRenderedFeatures({ layers: ids });
    return { onMap: true, n: fs.length, distinct: new Set(fs.map((f) => f.properties?.feature_id ?? f.id)).size };
  }, layerId);

const browser = await chromium.launch({ channel: process.env.PG_BROWSER_CHANNEL ?? 'msedge' });
const { ctx, page } = await login(browser, 'viewer');
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

// --- API facts (the reference for the UI; nothing below is a literal count) ---
const me = await api(page, '/v1/me');
const cities = await api(page, '/v1/cities');
const city = cities.body.items.find((c) => c.id === CITY);
const layers = (await api(page, `/v1/map/layers?city_id=${CITY}&limit=200`)).body.items;
const datasets = (await api(page, `/v1/datasets?city_id=${CITY}&limit=200`)).body.items;
const versions = {};
for (const d of datasets) {
  const v = (await api(page, `/v1/datasets/${d.id}/versions?limit=50`)).body.items.find((x) => x.id === d.current_version_id);
  versions[d.id] = v;
}
const records = Object.values(versions).reduce((n, v) => n + (v?.record_count ?? 0), 0);
const families = [...new Set(layers.map((l) => l.dataset_id))];
report.facts = {
  viewer_roles: me.body.roles,
  city: city?.name,
  datasets: datasets.length,
  layers: layers.length,
  records,
  per_dataset: datasets.map((d) => ({ name: d.name, kind: d.kind, records: versions[d.id]?.record_count ?? null, layers: layers.filter((l) => l.dataset_id === d.id).length })),
};
console.log('facts', JSON.stringify(report.facts));
check('viewer sees the real city and its published datasets/layers', me.body.roles.join() === 'viewer' && Boolean(city) && datasets.length > 0 && layers.length > 0, report.facts);
check(
  'API totals match GPT live smoke (datasets / layer manifests / records)',
  datasets.length === live.dataset_count && layers.length === live.map_layer_count && records === live.record_count && families.length === datasets.length,
  { api: [datasets.length, layers.length, records], smoke: [live.dataset_count, live.map_layer_count, live.record_count] },
);

// --- Map overview: panel count and layer cards come from the API ---
await page.goto(`${BASE}/?city=${CITY}`);
await page.waitForFunction(() => window.__pgMap?.loaded(), null, { timeout: 30_000 });
await page.waitForFunction((n) => window.__pgMap.getStyle().layers.filter((l) => l.source?.startsWith?.('pgl-')).length >= n, layers.length, { timeout: 30_000 }).catch(() => {});
await idle(page);
await shot(page, 'open-overview.png');
const panel = await page.locator('.pg-sidepanel, aside').last().innerText();
const countLine = panel.match(/Опубликованных слоёв: (\d+)/)?.[1];
const namesShown = layers.every((l) => panel.includes(l.name));
check('layer panel: count and every layer name come from listMapLayers', Number(countLine) === layers.length && namesShown, { countLine, namesShown });
const legends = await page.locator('.pg-legend').count();
check('every layer has a legend', legends >= layers.length, { legends });
check('main map panel has no "Источник"/"не проверено" lines', !POLICY.test(panel));

// Families are told apart: legend swatch colour = paint colour, distinct across categories.
const colours = await page.evaluate((ls) => {
  const m = window.__pgMap;
  return ls.map((l) => {
    const id = m.getStyle().layers.find((x) => x.source === `pgl-${l.id}`)?.id;
    const type = m.getLayer(id)?.type;
    const prop = type === 'fill' ? 'fill-color' : type === 'line' ? 'line-color' : 'circle-color';
    return { category: l.category, name: l.name, paint: String(m.getPaintProperty(id, prop)) };
  });
}, layers.map((l) => ({ id: l.id, category: l.category, name: l.name })));
const byCategory = new Map(colours.map((c) => [c.category, c.paint]));
check('layer families have distinct colours (server category identity)', new Set(byCategory.values()).size === byCategory.size, colours);
const swatches = await page.evaluate(() =>
  [...document.querySelectorAll('.pg-legend .pg-swatch')].map((s) => getComputedStyle(s).backgroundColor),
);
check('legend swatches are coloured (not all one grey)', new Set(swatches).size >= Math.min(byCategory.size, 2), swatches);

// --- Each family renders where GPT's smoke sampled it ---
const profileLayers = { roads: 'road', green: 'existing_green', trees: 'existing_green', water: 'water', buildings: 'building' };
for (const r of live.results) {
  const ls = layers.filter((l) => l.dataset_version_id === r.dataset_version_id);
  const [lng, lat] = tileCentre(r.sample_tile);
  await page.evaluate(([x, y]) => window.__pgMap.jumpTo({ center: [x, y], zoom: 15 }), [lng, lat]);
  await idle(page);
  await page.waitForTimeout(600);
  const counts = [];
  for (const l of ls) counts.push({ layer: l.name, ...(await rendered(page, l.id)) });
  check(`${r.profile}: features render at the sampled place (${ls.length} layer(s))`, ls.length > 0 && ls.every((l) => profileLayers[r.profile] === l.category) && counts.some((c) => c.n > 0), counts);
  await shot(page, `open-${r.profile}.png`);
}

// --- Toggle: hide and show the roads layer from its checkbox ---
const roads = layers.find((l) => l.category === 'road');
const roadCard = page.locator('.map-layer, li').filter({ hasText: roads.name }).first();
const roadBox = roadCard.getByRole('checkbox').first();
await roadBox.uncheck();
await page.waitForTimeout(800);
const hiddenNow = await rendered(page, roads.id);
await roadBox.check();
await idle(page);
await page.waitForTimeout(800);
const shownAgain = await rendered(page, roads.id);
check('roads toggle hides and restores the layer', !hiddenNow.onMap && shownAgain.onMap, { hiddenNow, shownAgain });

// --- Building: click on the map -> server card with the server height, readable title ---
const buildingsLayer = layers.find((l) => l.category === 'building');
// Buildings are sparse (only those with a published height): centre the camera on the smoke's
// sample building (geometry from its server card) and click it at the canvas centre.
const bSample = live.results.find((r) => r.profile === 'buildings');
const sampleCard = (await api(page, `/v1/map/features/${bSample.map_feature_id}`)).body;
const ring = sampleCard.geometry.type === 'Polygon' ? sampleCard.geometry.coordinates[0] : sampleCard.geometry.coordinates[0][0];
const centre = [ring.reduce((a, p) => a + p[0], 0) / ring.length, ring.reduce((a, p) => a + p[1], 0) / ring.length];
await page.evaluate(([x, y]) => window.__pgMap.jumpTo({ center: [x, y], zoom: 17.5 }), centre);
await idle(page);
await page.waitForTimeout(800);
const target = await page.evaluate(([id, fid]) => {
  // The averaged ring centre can fall outside a non-convex footprint: find a pixel on the building.
  const m = window.__pgMap;
  const r = m.getCanvas().getBoundingClientRect();
  for (let d = 0; d <= 200; d += 8) {
    for (const [dx, dy] of [[0, 0], [d, 0], [-d, 0], [0, d], [0, -d], [d, d], [-d, -d], [d, -d], [-d, d]]) {
      const p = [r.width / 2 + dx, r.height / 2 + dy];
      const f = m.queryRenderedFeatures(p, { layers: [`pgl-${id}-fill`] }).find((v) => v.properties?.feature_id === fid);
      // Zones are picked first; old SYNTHETIC zones overlap some real buildings.
      const zone = m.getLayer('zones-fill') ? m.queryRenderedFeatures(p, { layers: ['zones-fill'] }).length : 0;
      if (f && !zone) return { x: r.left + p[0], y: r.top + p[1], featureId: fid };
    }
  }
  return null;
}, [buildingsLayer.id, bSample.map_feature_id]);
let cardText = '';
let server = null;
if (target) await page.mouse.click(target.x, target.y);
else await page.goto(`${BASE}/?city=${CITY}&feature=${bSample.map_feature_id}`); // shared-link journey
{
  await page.locator('.map-inspect__server').waitFor({ timeout: 20_000 }).catch(() => {});
  const fid = new URL(page.url()).searchParams.get('feature');
  server = fid ? (await api(page, `/v1/map/features/${fid}`)).body : null;
  cardText = await page.locator('.map-inspect').innerText().catch(() => '');
}
const heightText = server?.height_m != null ? `${String(server.height_m.toFixed(1)).replace('.', ',')} м` : null;
const title = cardText.split('\n')[0]?.trim();
check(
  'building card: server height with its basis, readable title, no source/unverified lines',
  Boolean(server) && Boolean(heightText) && cardText.includes(heightText) && cardText.includes('по данным набора') && !/^\d+$/.test(title) && !POLICY.test(cardText),
  { title, height: server?.height_m, basis: server?.height_basis, text: cardText.slice(0, 300) },
);
await shot(page, 'open-building-card.png');

// --- 3D: tile heights extruded; frame counts equal what the tiles carry ---
await page.getByRole('button', { name: /3D/ }).first().click();
await page.waitForFunction(() => window.__pgScene?.state === 'on', null, { timeout: 20_000 }).catch(() => {});
await page.evaluate(() => window.__pgMap.easeTo({ zoom: 15.5, duration: 0 }));
await idle(page);
await page.waitForTimeout(1500);
const selectedId = new URL(page.url()).searchParams.get('feature');
const scene = await page.evaluate(([id, sel]) => {
  const m = window.__pgMap;
  const ext = m.getLayer(`pgl-${id}-extrusion`) ? m.queryRenderedFeatures({ layers: [`pgl-${id}-extrusion`] }) : [];
  const fills = m.queryRenderedFeatures({ layers: [`pgl-${id}-fill`] });
  const valid = new Set(
    fills.filter((f) => typeof f.properties?.height_m === 'number' && f.properties.height_m > 0 && ['measured', 'recorded_unverified', 'floors_estimate'].includes(f.properties.height_basis)).map((f) => f.properties.feature_id),
  );
  const heights = ext.map((f) => f.properties.height_m);
  const extruded = new Set(ext.map((f) => f.properties.feature_id));
  return {
    extruded: extruded.size,
    valid: valid.size,
    selectedInFrame: valid.has(sel),
    selectedNotDoubled: !extruded.has(sel),
    sameHeights: ext.every((f) => typeof f.properties.height_m === 'number'),
    heights: heights.slice(0, 5),
  };
}, [buildingsLayer.id, selectedId]);
const status = await page.locator('.scene3d-status').innerText().catch(() => '');
const recordedCount = Number(status.match(/Высота по данным набора · (\d+)/)?.[1] ?? NaN);
check('3D: buildings extruded from tile heights only; the selected one comes from its card', scene.extruded > 0 && scene.sameHeights && scene.selectedNotDoubled && scene.extruded + (scene.selectedInFrame ? 1 : 0) === scene.valid, scene);
check('3D legend counts what is in the frame (not a constant)', Number.isFinite(recordedCount) && recordedCount >= scene.extruded && recordedCount <= scene.valid + 1, { recordedCount, scene });
check('3D panel has no "Источник"/"не проверено" lines', !POLICY.test(status), status.slice(0, 300));
await shot(page, 'open-buildings-3d.png');
check('no page errors in the viewer session', pageErrors.length === 0, pageErrors.slice(0, 3));

// --- Sources page: record counts per dataset equal the API ---
await page.goto(`${BASE}/sources?city=${CITY}`);
await page.waitForSelector('table', { timeout: 20_000 });
const shownRecords = [];
for (const d of datasets) {
  await page.goto(`${BASE}/sources?city=${CITY}&selected=${d.id}`);
  await page.waitForSelector('.app-split.is-open .pg-card', { timeout: 20_000 });
  await page.locator('.app-versions').waitFor({ timeout: 20_000 }).catch(() => {});
  const text = await page.locator('.app-split.is-open .pg-card').innerText();
  shownRecords.push(Number(text.match(/Записей\s*\n?\s*([\d\s ]+)/)?.[1]?.replace(/\s| /g, '') ?? NaN));
}
const shownTotal = shownRecords.reduce((a, b) => a + b, 0);
check('sources page: record counts per dataset equal the API, total included', shownRecords.every((n, i) => n === (versions[datasets[i].id]?.record_count ?? NaN)) && shownTotal === records, { shownRecords, shownTotal, records });
await shot(page, 'open-sources.png');
await ctx.close();

// --- Phone + dark theme: same session state, layers render, card docks ---
const phone = await login(browser, 'viewer', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark' });
await phone.page.goto(`${BASE}/?city=${CITY}`);
await phone.page.waitForFunction(() => window.__pgMap?.loaded(), null, { timeout: 30_000 });
await idle(phone.page);
await phone.page.waitForTimeout(1500);
const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const phoneLayers = await phone.page.evaluate(() => window.__pgMap.getStyle().layers.filter((l) => l.source?.startsWith?.('pgl-')).length);
check('phone (dark): layers on the map, no horizontal scroll', phoneLayers > 0 && overflow <= 0, { phoneLayers, overflow });
await shot(phone.page, 'open-mobile-dark.png');
await phone.ctx.close();

await browser.close();
report.finishedAt = new Date().toISOString();
report.passed = report.checks.every((c) => c.pass);
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`\n${report.checks.filter((c) => c.pass).length}/${report.checks.length} checks passed`);
process.exit(report.passed ? 0 : 1);
