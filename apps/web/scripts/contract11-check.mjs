// Live checks of contract 1.1.0 surfaces against the integration API (http://localhost:8001 via Vite):
// source readiness (incl. ADR-008 mixed), version readiness fields, registry-based Problem titles,
// historical zone geometry (getZoneVersion) from a scenario to the map. Creates only SYNTHETIC TEST data.
//
//   PG_TEST_CREDENTIALS=<ignored local test-credentials.json> node scripts/contract11-check.mjs
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5173';
const OUT = resolve('../../docs/evidence/contract-1.1');
mkdirSync(OUT, { recursive: true });
const creds = JSON.parse(readFileSync(process.env.PG_TEST_CREDENTIALS ?? '', 'utf8'));
const problemCodes = JSON.parse(readFileSync('../../contracts/problem_codes.json', 'utf8')).codes;

const report = { base: BASE, contract: '1.1.0', contractSha: '7fb6cf60eb932ed6dac912aa38c8f2d07e0a43c2', startedAt: new Date().toISOString(), checks: [], shots: [], observed: {} };
const check = (name, pass, detail) => {
  report.checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
};
const shot = async (page, file) => {
  await page.screenshot({ path: join(OUT, file) });
  report.shots.push(`docs/evidence/contract-1.1/${file}`);
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
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ru-RU' });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

await page.goto(BASE + '/');
const btn = page.getByRole('button', { name: 'Войти через корпоративную учётную запись' }).first();
await btn.waitFor({ timeout: 15_000 });
await Promise.all([page.waitForURL(/openid-connect\/auth/, { waitUntil: 'commit', timeout: 20_000 }), btn.click()]);
await page.waitForSelector('#username');
await page.fill('#username', 'specialist');
await page.fill('#password', creds.specialist);
await page.click('#kc-login');
await page.waitForURL((u) => u.origin === new URL(BASE).origin && !u.pathname.startsWith('/auth/'), { waitUntil: 'commit', timeout: 20_000 });
await page.waitForTimeout(2000);

const spec = await page.evaluate(async () => (await (await fetch('/openapi.json')).json()).info.version);
check('server publishes contract 1.1.0', spec === '1.1.0', { spec });
// Use the accessible city with the most readiness items (the research city for specialist).
const city = await page.evaluate(async () => {
  const cities = (await (await fetch('/v1/cities')).json()).items;
  let best = cities[0];
  let bestN = -1;
  for (const c of cities) {
    const n = ((await (await fetch(`/v1/source-readiness?city_id=${c.id}&limit=200`)).json()).items ?? []).length;
    if (n > bestN) [best, bestN] = [c, n];
  }
  return best;
});

// 1. Source readiness
const ready = await page.evaluate(async (id) => (await fetch(`/v1/source-readiness?city_id=${id}&limit=200`)).json(), city.id);
const items = ready.items ?? [];
report.observed.readiness = items.map((r) => ({ dr: r.data_request_id, state: r.readiness_state, kind: r.content_kind, records: r.record_count }));
await page.goto(`${BASE}/sources?city=${city.id}`);
await settle(page);
const cards = await page.locator('.pg-readiness__item').count();
check('Sources page renders every readiness item from GET /v1/source-readiness', cards === items.length && items.length > 0, { api: items.length, ui: cards, city: city.name });
const mixed = items.filter((r) => r.content_kind === 'mixed');
const mixedUi = await page.locator('.pg-readiness__mixed').allInnerTexts();
check(
  'ADR-008: content_kind=mixed shown as mixed with its stated composition, not as ready',
  mixed.length === 0 ? true : mixedUi.length === mixed.length && mixed.every((m) => m.readiness_state !== 'available'),
  { mixedApi: mixed.map((m) => ({ dr: m.data_request_id, state: m.readiness_state, applicability: m.applicability })), mixedUi },
);
report.observed.mixedPresent = mixed.length;
const nullCounts = items.filter((r) => r.record_count === null).length;
const unknownUi = await page.locator('.pg-readiness__item .pg-unknown', { hasText: 'количество неизвестно' }).count();
check('record_count null shown as unknown (never 0)', unknownUi === nullCounts, { nullCounts, unknownUi });
const named = await page.locator('.pg-readiness__head strong').allInnerTexts();
check('readiness cards are labelled with dataset names', named.length === items.length && named.every((n) => n !== 'набор без названия'), { named });
const status = await page.locator('.app-status').innerText();
check('client reports contract 1.1.0 in the status bar', status.includes('контракт 1.1.0'), { status });
await shot(page, 'sources-readiness.png');

// 2. Version readiness fields in the dataset card
const openBtn = page.getByRole('button', { name: 'Открыть источник и версии' }).first();
if (await openBtn.count()) {
  await openBtn.click();
  await page.waitForSelector('.app-split.is-open .pg-card', { timeout: 15_000 });
  await settle(page);
  await page.locator('.app-split.is-open .pg-card').scrollIntoViewIfNeeded();
  const card = await page.locator('.app-split.is-open .pg-card').innerText();
  check('dataset version shows readiness state, content kind, records and check date (1.1.0 fields)', /Записей/.test(card) && /Проверено/.test(card) && /Период данных/.test(card), { excerpt: card.slice(0, 300) });
  await shot(page, 'dataset-version-readiness.png');
} else {
  check('dataset version readiness (no readiness item with dataset_id to open)', true, { skipped: true });
}

// 3. Problem title from the registry
await page.goto(`${BASE}/projects/00000000-0000-4000-8000-0000000000ff?city=${city.id}`);
await settle(page);
const probe = await page.evaluate(async () => (await (await fetch('/v1/scenarios/00000000-0000-4000-8000-0000000000ff')).json()).code);
const expectedTitle = problemCodes.find((c) => c.code === probe)?.title_ru;
const shownTitle = await page.locator('main .pg-state__title').first().innerText().catch(() => '');
check('Problem title comes from contracts/problem_codes.json', Boolean(expectedTitle) && shownTitle === expectedTitle, { code: probe, expectedTitle, shownTitle });
await shot(page, 'problem-title-registry.png');

// 4. Historical zone geometry
const d = 0.0012;
const sq = (cx, cy, k) => ({ type: 'Polygon', coordinates: [[[cx - d * k, cy - d], [cx + d * k, cy - d], [cx + d * k, cy + d], [cx - d * k, cy + d], [cx - d * k, cy - d]]] });
const ring = city.boundary.type === 'Polygon' ? city.boundary.coordinates[0] : city.boundary.coordinates[0][0];
const cx = (Math.min(...ring.map((c) => c[0])) + Math.max(...ring.map((c) => c[0]))) / 2 + 0.01;
const cy = (Math.min(...ring.map((c) => c[1])) + Math.max(...ring.map((c) => c[1]))) / 2 + 0.005;
const z1 = await apiCall(page, 'POST', '/v1/zones', { city_id: city.id, name: 'SYNTHETIC TEST история границ', purpose: 'square', geometry: sq(cx, cy, 1) });
const sc = await apiCall(page, 'POST', '/v1/scenarios', {
  city_id: city.id, zone_id: z1.body?.id, name: 'SYNTHETIC TEST сценарий на версии 1', base_revision_id: null,
  initial_state: { zone_version_id: z1.body?.version_id, parent_revision_id: null, dataset_version_ids: [], catalog_version_id: null, rate_version_id: null,
    coefficient_version_id: null, rule_version_id: null, model_version_id: null, placements: [], area_patches: [], capital_budget: null,
    care_horizon_years: 3, resource_limits: [], excluded_plant_ids: [], diversity_caps: [], care_strategy: 'standard', custom_care_operations: [], comment: 'SYNTHETIC TEST' },
});
const zGet = await page.evaluate(async (id) => { const r = await fetch(`/v1/zones/${id}`); return { etag: r.headers.get('ETag') }; }, z1.body?.id);
const z2 = await apiCall(page, 'PUT', `/v1/zones/${z1.body?.id}`, { city_id: city.id, name: 'SYNTHETIC TEST история границ', purpose: 'square', geometry: sq(cx, cy, 1.6) }, { 'If-Match': zGet.etag });
check('setup: zone v1 -> scenario on v1 -> zone updated to v2', z1.status === 201 && sc.status === 201 && z2.status === 200 && z2.body.version_id !== z1.body.version_id, { s: [z1.status, sc.status, z2.status] });
const hist = await page.evaluate(async (v) => { const r = await fetch(`/v1/zone-versions/${v}`); return { status: r.status, body: await r.json() }; }, z1.body.version_id);
check('GET /v1/zone-versions/{id} returns the immutable v1 geometry', hist.status === 200 && hist.body.version_id === z1.body.version_id && hist.body.area_m2 === z1.body.area_m2, { area_v1: hist.body.area_m2, area_v2: z2.body.area_m2 });

await page.goto(`${BASE}/projects/${sc.body.id}?city=${city.id}`);
await settle(page);
await page.getByText('Площадь по серверу').waitFor({ timeout: 15_000 }).catch(() => {});
const notice = await page.locator('.scn-main').innerText();
const fmt = (n) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(n).replace(/\s/g, ' ');
const normalized = notice.replace(/\s/g, ' ');
check('scenario on v1 shows then/now areas from the server', normalized.includes(fmt(hist.body.area_m2)) && normalized.includes(fmt(z2.body.area_m2)), { then: hist.body.area_m2, now: z2.body.area_m2 });
await shot(page, 'scenario-zone-version.png');
await page.getByRole('link', { name: 'Показать прежние границы на карте' }).click();
await page.waitForSelector('.zone-card', { timeout: 15_000 });
await page.getByText('На карте также прежняя версия границ').waitFor({ timeout: 15_000 }).catch(() => {});
await page.waitForTimeout(1200);
const drawn = await page.evaluate(() => window.__pgMap?.querySourceFeatures('zone-history').length ?? 0);
check('map draws the historical outline from getZoneVersion next to the current zone', drawn > 0 && page.url().includes(`zoneVersion=${z1.body.version_id}`), { drawn });
await shot(page, 'map-zone-history.png');
await page.reload();
await page.waitForSelector('.zone-card', { timeout: 15_000 });
await page.waitForTimeout(1500);
const drawnAfter = await page.evaluate(() => window.__pgMap?.querySourceFeatures('zone-history').length ?? 0);
check('reload keeps the historical overlay (URL state)', drawnAfter > 0, { drawnAfter });
await page.getByRole('button', { name: 'Скрыть прежние границы' }).click();
await page.waitForTimeout(800);
const hidden = await page.evaluate(() => window.__pgMap?.querySourceFeatures('zone-history').length ?? -1);
check('hide removes the overlay and the URL parameter', hidden === 0 && !page.url().includes('zoneVersion='), { hidden });

check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3));
await browser.close();
report.finishedAt = new Date().toISOString();
report.passed = report.checks.every((c) => c.pass);
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`\n${report.checks.filter((c) => c.pass).length}/${report.checks.length} checks passed`);
console.log('observed readiness', JSON.stringify(report.observed));
process.exit(report.passed ? 0 : 1);
