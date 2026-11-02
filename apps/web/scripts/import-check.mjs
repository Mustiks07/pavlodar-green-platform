// Live checks for WP-03 browser upload/review and the OpenFreeMap basemap, against the
// integration API (http://localhost:8001 via Vite). Creates only SYNTHETIC TEST datasets/files.
//
//   PG_TEST_CREDENTIALS=<ignored local test-credentials.json> node scripts/import-check.mjs
import { chromium } from '@playwright/test';
import { sessionCookie } from './lib/session-login.mjs';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5173';
const OUT = resolve('../../docs/evidence/wp03-import-ui');
mkdirSync(OUT, { recursive: true });
const creds = JSON.parse(readFileSync(process.env.PG_TEST_CREDENTIALS ?? '', 'utf8'));
const FILES = mkdtempSync(join(tmpdir(), 'pg-import-'));

const report = { base: BASE, startedAt: new Date().toISOString(), checks: [], shots: [] };
const check = (name, pass, detail) => {
  report.checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 360)}` : ''}`);
};
const shot = async (page, file) => {
  await page.screenshot({ path: join(OUT, file) });
  report.shots.push(`docs/evidence/wp03-import-ui/${file}`);
};
const settle = (page) =>
  page.waitForFunction(() => !document.querySelector('.pg-state .pg-spinner, .pg-skeleton'), null, { timeout: 15_000 }).catch(() => {});

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

// ------------------------------------------------------------------ basemap
let city;
{
  const { ctx, page } = await login(browser, 'specialist');
  city = (await page.evaluate(async () => (await fetch('/v1/cities')).json())).items[0];
  await page.goto(`${BASE}/?city=${city.id}`);
  await page.waitForFunction(() => window.__pgMap?.loaded?.() && window.__pgMap.getLayer('city-boundary-line'), null, { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const info = await page.evaluate(() => {
    const m = window.__pgMap;
    const layers = m.getStyle().layers;
    const ext = layers.filter((l) => l.type === 'fill-extrusion').map((l) => ({ id: l.id, h: m.getPaintProperty(l.id, 'fill-extrusion-height') }));
    const attrib = document.querySelector('.maplibregl-ctrl-attrib');
    const platform = new Set(['city-boundary-fill', 'city-boundary-line', 'zones-fill', 'zones-line', 'zones-selected', 'zone-history-line']);
    const firstPlatform = layers.findIndex((l) => platform.has(l.id));
    const lastBasemap = layers.reduce((acc, l, i) => (platform.has(l.id) || l.id.startsWith('pgl-') || l.id.startsWith('draw-') || l.id.startsWith('feature-highlight') ? acc : i), -1);
    return { layerCount: layers.length, ext, attribText: attrib?.textContent ?? '', attribLinks: [...(attrib?.querySelectorAll('a') ?? [])].map((a) => a.href), top: layers.slice(-3).map((l) => l.id), firstPlatform, lastBasemap, hasBoundary: layers.some((l) => l.id === 'city-boundary-line') };
  });
  const note = await page.locator('.map-basemap-note').innerText().catch(() => null);
  check('basemap: OpenFreeMap liberty style loaded with platform interaction layers on top', info.layerCount > 50 && info.hasBoundary && info.top.every((id) => /^(feature-highlight|zone-history)/.test(id)), { layers: info.layerCount, top: info.top, firstPlatform: info.firstPlatform, lastBasemap: info.lastBasemap, note });
  check('basemap: building extrusions flattened (unverified OpenMapTiles heights not shown as volume)', info.ext.length > 0 && info.ext.every((e) => e.h === 0), info.ext);
  const a = info.attribText + ' ' + info.attribLinks.join(' ');
  check('basemap: attribution OpenFreeMap / OpenMapTiles / OpenStreetMap kept', /OpenFreeMap/i.test(a) && /OpenMapTiles/i.test(a) && /OpenStreetMap/i.test(a), { attrib: info.attribText });
  await shot(page, 'map-basemap.png');
  await ctx.close();
}
{
  const { ctx, page } = await login(browser, 'viewer', (c) => c.route(/tiles\.openfreemap\.org\/styles/, (r) => r.abort('failed')));
  await page.goto(`${BASE}/?city=${city.id}`);
  const note = await page.getByText('Подложка недоступна.').waitFor({ timeout: 20_000 }).then(() => true).catch(() => false);
  await page.waitForFunction(() => window.__pgMap?.getLayer('city-boundary-line'), null, { timeout: 20_000 }).catch(() => {});
  const layersOk = await page.evaluate(() => Boolean(window.__pgMap?.getLayer('city-boundary-line')));
  check('basemap failure: explained; platform layers still drawn on blank background', note && layersOk, { note, layersOk });
  await shot(page, 'map-basemap-failed.png');
  await ctx.close();
}

// ------------------------------------------------------------------ test files
const ring = city.boundary.type === 'Polygon' ? city.boundary.coordinates[0] : city.boundary.coordinates[0][0];
const cx = (Math.min(...ring.map((c) => c[0])) + Math.max(...ring.map((c) => c[0]))) / 2;
const cy = (Math.min(...ring.map((c) => c[1])) + Math.max(...ring.map((c) => c[1]))) / 2;
const sq = (dx, dy, d = 0.0008) => [[[cx + dx - d, cy + dy - d], [cx + dx + d, cy + dy - d], [cx + dx + d, cy + dy + d], [cx + dx - d, cy + dy + d], [cx + dx - d, cy + dy - d]]];
const files = {
  good: join(FILES, 'synthetic-zones.geojson'),
  bad: join(FILES, 'synthetic-invalid-record.geojson'),
  notCollection: join(FILES, 'synthetic-not-collection.geojson'),
  csv: join(FILES, 'synthetic-points.csv'),
  kml: join(FILES, 'synthetic.kml'),
};
writeFileSync(files.good, JSON.stringify({ type: 'FeatureCollection', features: [
  { type: 'Feature', id: 'syn-1', properties: { name: 'SYNTHETIC участок 1', note: 'test' }, geometry: { type: 'Polygon', coordinates: sq(0, 0) } },
  { type: 'Feature', id: 'syn-2', properties: { name: 'SYNTHETIC участок 2', note: 'test' }, geometry: { type: 'Polygon', coordinates: sq(0.003, 0.002) } },
] }));
const bow = [[[cx, cy], [cx + 0.001, cy + 0.001], [cx + 0.001, cy], [cx, cy + 0.001], [cx, cy]]];
writeFileSync(files.bad, JSON.stringify({ type: 'FeatureCollection', features: [
  { type: 'Feature', id: 'ok', properties: { name: 'SYNTHETIC ok' }, geometry: { type: 'Polygon', coordinates: sq(0.005, 0) } },
  { type: 'Feature', id: 'bowtie', properties: { name: 'SYNTHETIC self-intersecting' }, geometry: { type: 'Polygon', coordinates: bow } },
] }));
writeFileSync(files.notCollection, JSON.stringify({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [cx, cy] } }));
writeFileSync(files.csv, `name,lon,lat\n"SYNTHETIC, точка 1",${cx},${cy}\nSYNTHETIC точка 2,${cx + 0.001},${cy + 0.001}\n`);
writeFileSync(files.kml, `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark id="kml-1"><name>SYNTHETIC KML участок</name><Polygon><outerBoundaryIs><LinearRing><coordinates>${cx - 0.0008},${cy - 0.0008},0 ${cx + 0.0008},${cy - 0.0008},0 ${cx + 0.0008},${cy + 0.0008},0 ${cx - 0.0008},${cy + 0.0008},0 ${cx - 0.0008},${cy - 0.0008},0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>`);

// ------------------------------------------------------------------ specialist upload flow
const dsName = `SYNTHETIC TEST импорт ${new Date().toISOString().slice(11, 19)}`;
let goodVersionId;
let csvVersionId;
let datasetId;
{
  const { ctx, page } = await login(browser, 'specialist');
  const uploadRequests = [];
  page.on('request', (r) => /\/v1\/(uploads|datasets\/[^/]+\/(uploads|imports))/.test(r.url()) && uploadRequests.push(`${r.method()} ${new URL(r.url()).pathname}`));
  await page.goto(`${BASE}/imports?city=${city.id}`);
  await settle(page);
  await page.getByRole('button', { name: 'Создать набор данных' }).click();
  await page.getByLabel(/^Название/).fill(dsName);
  await page.getByLabel('Тип', { exact: true }).selectOption('zones');
  await page.getByLabel('Владелец').fill('SYNTHETIC integration test');
  await page.getByLabel('Лицензия').fill('CC0-1.0');
  await page.getByRole('button', { name: 'Создать набор', exact: true }).click();
  await page.waitForFunction((n) => [...document.querySelectorAll('select option')].some((o) => o.textContent?.includes(n)), dsName, { timeout: 15_000 }).catch(() => {});
  datasetId = await page.evaluate((n) => [...document.querySelectorAll('select option')].find((o) => o.textContent?.includes(n))?.value, dsName);
  datasetId ??= await page.evaluate(() => [...document.querySelectorAll('select option')].find((o) => o.value)?.value);
  if (datasetId) await page.getByLabel('Набор данных').selectOption(datasetId);
  check('wizard has a target dataset for the import journey', Boolean(datasetId), { datasetId });

  // KML: opaque in the browser, parsed and reviewed by the same durable server pipeline.
  await page.locator('input[type=file]').setInputFiles(files.kml);
  const kmlNote = await page.getByText('KML готов к серверной проверке').isVisible();
  await page.getByLabel('Метод получения данных').fill('SYNTHETIC TEST browser KML');
  const kmlEnabled = await page.getByRole('button', { name: 'Загрузить и проверить' }).isEnabled();
  check('KML: accepted by the UI without pretending to parse it locally', kmlNote && kmlEnabled);
  await shot(page, 'kml-server-validation.png');
  await page.getByRole('button', { name: 'Загрузить и проверить' }).click();
  await page.waitForURL(/[?&]job=/, { timeout: 60_000 });
  await page.getByText('Проверка завершена').waitFor({ timeout: 90_000 });
  const kmlJob = await page.evaluate(async (id) => (await fetch(`/v1/jobs/${id}`)).json(), new URL(page.url()).searchParams.get('job'));
  const kmlQuality = await page.evaluate(async (v) => (await fetch(`/v1/dataset-versions/${v}/quality`)).json(), kmlJob.result_ref_id);
  check('KML: durable job creates a reviewable version with one polygon', kmlJob.state === 'succeeded' && kmlQuality.valid_count === 1, { state: kmlJob.state, valid: kmlQuality.valid_count });
  await page.getByRole('button', { name: 'Загрузить другой файл' }).click();
  await page.getByLabel('Набор данных').selectOption(datasetId);
  const requestsAfterKml = uploadRequests.length;

  // Non-FeatureCollection GeoJSON: blocked before upload
  await page.locator('input[type=file]').setInputFiles(files.notCollection);
  await page.getByLabel('Метод получения данных').fill('SYNTHETIC TEST');
  const fatalDisabled = await page.getByRole('button', { name: 'Загрузить и проверить' }).isDisabled();
  check('GeoJSON that the server would reject as a whole is blocked before upload', fatalDisabled && (await page.getByText('FeatureCollection').first().isVisible()));
  check('invalid GeoJSON root creates no additional upload', uploadRequests.length === requestsAfterKml, uploadRequests);

  // Good GeoJSON: full flow
  await page.locator('input[type=file]').setInputFiles(files.good);
  await page.getByText('Объектов: 2').waitFor({ timeout: 10_000 });
  await page.getByLabel('Метод получения данных').fill('SYNTHETIC TEST browser upload');
  await page.getByLabel('Новое имя поля note').fill('remark');
  await shot(page, 'geojson-preview.png');
  await page.getByRole('button', { name: 'Загрузить и проверить' }).click();
  await page.waitForURL(/[?&]job=/, { timeout: 60_000 });
  await page.getByText('Проверка завершена').waitFor({ timeout: 90_000 });
  await settle(page);
  const jobUrl = page.url();
  const jobId = new URL(jobUrl).searchParams.get('job');
  const job = await page.evaluate(async (id) => (await fetch(`/v1/jobs/${id}`)).json(), jobId);
  goodVersionId = job.result_ref_id;
  check('ticket -> PUT -> startImport -> Job succeeded (real API)', job.state === 'succeeded' && uploadRequests.some((r) => r.startsWith('PUT /v1/uploads/')) && uploadRequests.some((r) => /imports$/.test(r)), { state: job.state, kind: job.kind, requests: uploadRequests });
  const quality = await page.evaluate(async (v) => (await fetch(`/v1/dataset-versions/${v}/quality`)).json(), goodVersionId);
  const result = await page.locator('.imp-result').innerText();
  check('QualityReport shown for the new version (needs_review, 2 valid records)', quality.valid_count === 2 && /только что загружена/.test(result) && /нужна проверка/.test(result), { valid: quality.valid_count, errors: quality.error_count, publish_allowed: quality.publish_allowed });
  check('specialist cannot publish (admin only)', (await page.getByRole('button', { name: 'Опубликовать версию…' }).count()) === 0);
  await shot(page, 'geojson-imported.png');
  await page.reload();
  await page.getByText('Проверка завершена').waitFor({ timeout: 20_000 }).catch(() => {});
  check('reload resumes the job view from the URL', (await page.getByText('Проверка завершена').isVisible()) && page.url().includes(`job=${jobId}`), { url: page.url() });

  // Invalid record: server-side rejection shown verbatim
  await page.getByRole('button', { name: 'Загрузить другой файл' }).click();
  await page.getByLabel('Набор данных').selectOption(datasetId);
  await page.locator('input[type=file]').setInputFiles(files.bad);
  await page.getByLabel('Метод получения данных').fill('SYNTHETIC TEST invalid record');
  await page.getByRole('button', { name: 'Загрузить и проверить' }).click();
  await page.waitForURL(/[?&]job=/, { timeout: 60_000 });
  await page.getByText('Проверка завершена').waitFor({ timeout: 90_000 });
  const badJob = await page.evaluate(async (id) => (await fetch(`/v1/jobs/${id}`)).json(), new URL(page.url()).searchParams.get('job'));
  const badVersion = badJob.result_ref_id;
  const badQuality = await page.evaluate(async (v) => (await fetch(`/v1/dataset-versions/${v}/quality`)).json(), badVersion);
  const badItem = page.locator('.app-versions > li.is-new');
  await badItem.getByText('record_invalid').first().waitFor({ timeout: 20_000 }).catch(() => {});
  const badText = await badItem.innerText().catch(() => '');
  check('server rejection of an invalid geometry is shown with its reason (no fake success)', badQuality.error_count > 0 && /record_invalid/.test(badText) && /отклонена/.test(badText) && /Публикация заблокирована/.test(badText), {
    status: badQuality.publish_allowed,
    errors: badQuality.error_count,
    issues: badQuality.issues.map((i) => i.code),
  });
  await shot(page, 'geojson-rejected.png');

  // CSV: table import, coordinate columns not converted
  await page.getByRole('button', { name: 'Загрузить другой файл' }).click();
  await page.getByLabel('Набор данных').selectOption(datasetId);
  await page.locator('input[type=file]').setInputFiles(files.csv);
  const coordWarn = await page.getByText('Координатные колонки не станут геометрией').waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
  await page.getByLabel('Метод получения данных').fill('SYNTHETIC TEST csv');
  await shot(page, 'csv-preview.png');
  await page.getByRole('button', { name: 'Загрузить и проверить' }).click();
  await page.waitForURL(/[?&]job=/, { timeout: 60_000 });
  await page.getByText('Проверка завершена').waitFor({ timeout: 90_000 });
  const csvJob = await page.evaluate(async (id) => (await fetch(`/v1/jobs/${id}`)).json(), new URL(page.url()).searchParams.get('job'));
  csvVersionId = csvJob.result_ref_id;
  const versions = await page.evaluate(async (d) => (await fetch(`/v1/datasets/${d}/versions?limit=50`)).json(), datasetId);
  const csvVersion = versions.items.find((v) => v.id === csvVersionId);
  check('CSV imported as a table; UI warned coordinates stay columns', coordWarn && csvVersion?.content_kind === 'table', { content_kind: csvVersion?.content_kind, records: csvVersion?.record_count });
  await ctx.close();
}

// ------------------------------------------------------------------ admin publish / reject
{
  const { ctx, page } = await login(browser, 'admin');
  await page.goto(`${BASE}/imports?city=${city.id}&selected=${datasetId}`);
  await page.waitForSelector('.app-split.is-open .pg-card', { timeout: 20_000 });
  await settle(page);
  const pubButtons = page.getByRole('button', { name: 'Опубликовать версию…' });
  check('admin sees publish only on versions that are not published/rejected', (await pubButtons.count()) >= 1, { count: await pubButtons.count() });
  // Reject the CSV version
  const csvItem = page.locator('.app-versions > li', { has: page.locator(`code[title]`) }).filter({ hasText: csvVersionId.slice(0, 8) });
  await csvItem.getByRole('button', { name: 'Отклонить версию…' }).click();
  await page.locator('dialog[open]').getByLabel('Причина решения').fill('SYNTHETIC TEST: CSV без геометрии не нужен для слоя зон');
  await page.locator('dialog[open]').getByRole('button', { name: 'Отклонить', exact: true }).click();
  await page.waitForTimeout(1500);
  const afterReject = await page.evaluate(async (d) => (await fetch(`/v1/datasets/${d}/versions?limit=50`)).json(), datasetId);
  check('admin reject with reason -> version rejected', afterReject.items.find((v) => v.id === csvVersionId)?.status === 'rejected');
  // Publish the good GeoJSON version
  const goodItem = page.locator('.app-versions > li').filter({ hasText: goodVersionId.slice(0, 8) });
  await goodItem.getByRole('button', { name: 'Опубликовать версию…' }).click();
  await page.locator('dialog[open]').getByLabel('Причина решения').fill('SYNTHETIC TEST: проверка публикации в тестовом профиле');
  await page.locator('dialog[open]').getByRole('button', { name: 'Опубликовать', exact: true }).click();
  await page.waitForTimeout(2000);
  const ds = await page.evaluate(async ({ c, d }) => (await (await fetch(`/v1/datasets?city_id=${c}&limit=200`)).json()).items.find((x) => x.id === d), { c: city.id, d: datasetId });
  const pubErr = await page.locator('dialog[open]').innerText().catch(() => '');
  check('admin publish: server result shown (published, or refusal with reasons)', ds?.current_version_id === goodVersionId || /причины|заблокирован|Не удалось/i.test(pubErr), { current: ds?.current_version_id, dialog: pubErr.slice(0, 200) });
  await shot(page, 'admin-after-publish.png');
  await ctx.close();
}

// ------------------------------------------------------------------ viewer
{
  const { ctx, page } = await login(browser, 'viewer');
  await page.goto(`${BASE}/imports?city=${city.id}`);
  await settle(page);
  check('viewer: no upload form, role explained', (await page.getByText('Загрузка данных доступна роли «специалист»').isVisible()) && (await page.locator('input[type=file]').count()) === 0);
  await ctx.close();
}

await browser.close();
report.finishedAt = new Date().toISOString();
report.passed = report.checks.every((c) => c.pass);
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`\n${report.checks.filter((c) => c.pass).length}/${report.checks.length} checks passed`);
process.exit(report.passed ? 0 : 1);
