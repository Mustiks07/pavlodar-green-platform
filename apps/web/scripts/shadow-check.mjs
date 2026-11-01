// Live shadow-run journey on the shared API (contract 1.4.0, ADR-030): a specialist starts a run
// for a saved revision, the job is tracked (progress), the immutable SpatialResult and its artifact
// are shown and drawn in 3D; night is unavailable (not zero); start/poll failures recover by retry;
// reload keeps the job and the result; a viewer gets 404 for someone else's result (IDOR) and for
// an unknown id. The browser never computes shadows or heights.
//
// Reuses the SYNTHETIC TEST revision of GPT's live smoke (docs/evidence/wp08-shadow-live.json), so
// no new zones or scenarios are created in the real city.
//   PG_TEST_CREDENTIALS=<path> node scripts/shadow-check.mjs
import { chromium } from '@playwright/test';
import { sessionCookie } from './lib/session-login.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5173';
const OUT = resolve('../../docs/evidence/wp08-shadow-ui');
const creds = JSON.parse(readFileSync(process.env.PG_TEST_CREDENTIALS ?? '', 'utf8'));
const smoke = JSON.parse(readFileSync(resolve('../../docs/evidence/wp08-shadow-live.json'), 'utf8'));
mkdirSync(OUT, { recursive: true });

const report = { base: BASE, startedAt: new Date().toISOString(), checks: [], shots: [], runs: [] };
const check = (name, pass, detail) => {
  report.checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
};
const shot = async (page, file) => {
  await page.screenshot({ path: join(OUT, file), fullPage: false });
  report.shots.push(`docs/evidence/wp08-shadow-ui/${file}`);
};
const POLICY = /Источник|не провер/i;
const api = (page, path) => page.evaluate(async (p) => { const r = await fetch(p); return { status: r.status, body: await r.json().catch(() => null) }; }, path);

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

const browser = await chromium.launch({ channel: process.env.PG_BROWSER_CHANNEL ?? 'msedge' });
const sp = await login(browser, 'specialist');
const page = sp.page;
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
const jobStates = [];
const streams = [];
page.on('response', (r) => {
  if (/\/v1\/jobs\/[0-9a-f-]{36}\/events/.test(r.url())) streams.push({ status: r.status(), type: r.headers()['content-type'] ?? '', lastEventId: r.request().headers()['last-event-id'] ?? null });
});
page.on('response', async (r) => {
  if (/\/v1\/jobs\/[0-9a-f-]{36}$/.test(new URL(r.url()).pathname) && r.request().method() === 'GET' && r.status() === 200) {
    const j = await r.json().catch(() => null);
    if (j) jobStates.push({ id: j.id, state: j.state, progress: j.progress, phase: j.phase });
  }
});

const revision = (await api(page, `/v1/scenario-revisions/${smoke.scenario_revision_id}`)).body;
const scenarioId = revision.scenario_id;
const cityId = smoke.city_id;
check('setup: SYNTHETIC TEST revision of the live smoke is readable by its specialist', Boolean(scenarioId), { revision: smoke.scenario_revision_id, scenarioId });

const card = () => page.locator('.shd-section').first();
async function run(date, time, label) {
  await card().getByLabel(/^Дата/).fill(date);
  await card().getByLabel(/^Время/).fill(time);
  const previous = new URL(page.url()).searchParams.get('shadow');
  const started = page.waitForResponse((r) => r.url().endsWith('/v1/shadow-runs') && r.request().method() === 'POST' && r.status() === 202, { timeout: 15_000 });
  await card().getByRole('button', { name: 'Рассчитать тени' }).click();
  const jobId = (await (await started).json()).id;
  await page.waitForFunction((old) => { const p = new URLSearchParams(location.search); return p.get('shadow') && p.get('shadow') !== old && !p.has('shadowJob'); }, previous, { timeout: 120_000 });
  const resultId = new URL(page.url()).searchParams.get('shadow');
  await page.locator(`.shd-result[data-spatial-result-id="${resultId}"]`).waitFor({ timeout: 20_000 });
  report.runs.push({ label, jobId, resultId });
  return { jobId, resultId };
}

// --- Retry: the first start fails (503), the error offers retry, the second start succeeds ---
await page.goto(`${BASE}/projects/${scenarioId}?city=${cityId}`);
await card().waitFor({ timeout: 30_000 });
let failedOnce = false;
await page.route('**/v1/shadow-runs', (route) => {
  if (failedOnce) return route.continue();
  failedOnce = true;
  return route.fulfill({ status: 503, contentType: 'application/problem+json', body: JSON.stringify({ type: 'about:blank', title: 'storage_unavailable', status: 503, detail: 'SYNTHETIC TEST outage', code: 'storage_unavailable', request_id: crypto.randomUUID(), current_revision_id: null, field_errors: [], blockers: [] }) });
});
await card().getByLabel(/^Дата/).fill('2026-06-21');
await card().getByLabel(/^Время/).fill('11:52');
await card().getByRole('button', { name: 'Рассчитать тени' }).click();
const startError = await card().locator('.pg-state, [role=alert]').first().waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
await card().scrollIntoViewIfNeeded();
await shot(page, 'shadow-start-503.png');
// Poll failures too: the first two job reads fail, polling must recover on its own.
let pollFails = 0;
await page.route('**/v1/jobs/*', (route) => {
  if (route.request().method() === 'GET' && pollFails < 2) {
    pollFails += 1;
    return route.fulfill({ status: 503, contentType: 'application/problem+json', body: JSON.stringify({ type: 'about:blank', title: 'unavailable', status: 503, detail: 'SYNTHETIC TEST outage', code: 'service_unavailable', request_id: crypto.randomUUID(), current_revision_id: null, field_errors: [], blockers: [] }) });
  }
  return route.continue();
});
const day = await run('2026-06-21', '11:52', 'day');
await page.unroute('**/v1/shadow-runs');
await page.unroute('**/v1/jobs/*');
check('retry: start 503 shown with retry, poll 503s recovered, the run completes', startError && failedOnce && pollFails === 2 && Boolean(day.resultId), { startError, pollFails, day });

// --- Complete result: UI shows exactly the server result ---
const server = (await api(page, `/v1/spatial-results/${day.resultId}`)).body;
const artifact = (await api(page, `/v1/spatial-results/${day.resultId}/artifact`)).body;
const resultText = await page.locator(`.shd-result[data-spatial-result-id="${day.resultId}"]`).innerText();
const area = server.metrics.find((m) => m.key === 'shade_area');
const areaText = area?.value != null ? new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(area.value)) : null;
check(
  'complete: status, shaded area, moment and sun come from getSpatialResult/artifact',
  server.status === 'complete' && resultText.includes('Рассчитано') && Boolean(areaText) && resultText.replace(/\s/g, ' ').includes(areaText.replace(/\s/g, ' ')) && resultText.includes('высота') && !POLICY.test(resultText),
  { status: server.status, area: area?.value, areaText, sun: artifact?.metadata?.sun, text: resultText.slice(0, 300) },
);
const progressSeen = jobStates.filter((s) => s.id === day.jobId);
check('progress: job states were tracked until a terminal state', progressSeen.length > 0 && progressSeen.at(-1).state === 'succeeded', progressSeen.slice(-4));
await page.locator(`.shd-result[data-spatial-result-id="${day.resultId}"]`).scrollIntoViewIfNeeded();
await shot(page, 'shadow-complete.png');

// --- Job transport: the SSE stream is used; polling takes over when the stream is unavailable ---
const sseServed = await page.evaluate(async () => {
  const doc = await (await fetch('/openapi.json')).json();
  return Object.values(doc.paths).some((p) => Object.values(p).some((op) => op?.operationId === 'streamJobEvents'));
});
const reads = jobStates.filter((s) => s.id === day.jobId).length;
check(
  sseServed ? 'job progress comes from the SSE stream (text/event-stream), getJob is not polled repeatedly' : 'this API does not serve streamJobEvents: the client polls getJob and opens no stream',
  sseServed ? streams.some((s) => s.status === 200 && s.type.includes('text/event-stream')) && reads <= 4 : streams.length === 0 && reads >= 1,
  { sseServed, streams: streams.slice(0, 3), getJobReads: reads },
);
await page.route('**/v1/jobs/*/events*', (route) => route.abort());
const pollStart = jobStates.length;
const fallback = await run('2026-06-21', '10:00', 'polling-fallback');
await page.unroute('**/v1/jobs/*/events*');
const polled = jobStates.slice(pollStart).filter((s) => s.id === fallback.jobId);
check('stream unavailable: polling fallback tracks the job to its result', Boolean(fallback.resultId) && polled.length >= 1 && polled.at(-1).state === 'succeeded', { polled: polled.length, last: polled.at(-1) });

// --- Reload keeps the result (and a job id in the URL resumes tracking) ---
await page.reload();
await page.locator(`.shd-result[data-spatial-result-id="${fallback.resultId}"]`).waitFor({ timeout: 30_000 });
check('reload restores the result from the URL', true);
await card().getByLabel(/^Время/).fill('12:30');
await card().getByRole('button', { name: 'Рассчитать тени' }).click();
await page.waitForFunction(() => new URLSearchParams(location.search).has('shadowJob'), null, { timeout: 15_000 });
const pendingJob = new URL(page.url()).searchParams.get('shadowJob');
await page.reload();
await page.waitForFunction(() => new URLSearchParams(location.search).has('shadow') && !new URLSearchParams(location.search).has('shadowJob'), null, { timeout: 120_000 });
const afterReload = new URL(page.url()).searchParams.get('shadow');
const resumed = await api(page, `/v1/jobs/${pendingJob}`);
check('reload during a run resumes tracking the same job and lands on its result', resumed.body?.result_ref_id === afterReload, { pendingJob, afterReload, state: resumed.body?.state });

// --- Night: unavailable, no geometry, the reason is the server's ---
const night = await run('2026-06-21', '23:30', 'night');
const nightServer = (await api(page, `/v1/spatial-results/${night.resultId}`)).body;
const nightText = await page.locator(`.shd-result[data-spatial-result-id="${night.resultId}"]`).innerText();
const nightLink = await page.locator(`.shd-result[data-spatial-result-id="${night.resultId}"]`).getByRole('link', { name: 'Показать в 3D' }).count();
check(
  'night: unavailable with the server reason, no 3D link, not shown as zero',
  nightServer.status === 'unavailable' && nightServer.artifact_url === null && nightText.includes('Нет результата') && nightText.includes('Нет данных') && nightLink === 0,
  { status: nightServer.status, text: nightText.slice(0, 300) },
);
await page.locator(`.shd-result[data-spatial-result-id="${night.resultId}"]`).scrollIntoViewIfNeeded();
await shot(page, 'shadow-night.png');

// --- 3D: the artifact polygon is drawn; the camera tilts; buildings keep their server heights ---
await page.goto(`${BASE}/?city=${cityId}&zone=${smoke.zone_id}&scene=3d&shadow=${day.resultId}`);
await page.waitForFunction(() => window.__pgMap?.getLayer('shadow-fill'), null, { timeout: 30_000 }).catch(() => {});
await page.waitForFunction(() => window.__pgScene?.state === 'on', null, { timeout: 20_000 }).catch(() => {});
await page.waitForTimeout(2500);
const drawn = await page.evaluate(() => {
  const m = window.__pgMap;
  return m.getSource('shadow').getData().then((data) => ({ layer: Boolean(m.getLayer('shadow-fill')), pitch: m.getPitch(), geometryType: data?.geometry?.type ?? null, rings: JSON.stringify(data?.geometry?.coordinates ?? null).length }));
});
const artifactRings = JSON.stringify(artifact.features[0].geometry.coordinates).length;
const panelText = await page.locator('.map-shadow').innerText().catch(() => '');
check(
  '3D: shadow geometry drawn exactly as the artifact, tilted scene, panel without source/unverified lines',
  drawn.layer && drawn.pitch > 0 && drawn.geometryType === artifact.features[0].geometry.type && drawn.rings === artifactRings && !POLICY.test(panelText),
  { drawn, artifactRings },
);
await shot(page, 'shadow-3d.png');
await page.reload();
await page.waitForFunction(() => window.__pgMap?.getLayer('shadow-fill'), null, { timeout: 30_000 }).catch(() => {});
check('reload of the 3D link restores the shadow layer', await page.evaluate(() => Boolean(window.__pgMap.getLayer('shadow-fill'))));
// Another moment from the map panel (date/time control in 3D).
await page.locator('.map-shadow details summary').click();
await page.locator('.map-shadow').getByLabel(/^Время/).fill('16:00');
await page.locator('.map-shadow').getByLabel(/^Дата/).fill('2026-06-21');
await page.locator('.map-shadow').getByRole('button', { name: 'Рассчитать тени' }).click();
await page.waitForFunction((old) => { const p = new URLSearchParams(location.search); return p.get('shadow') && p.get('shadow') !== old && !p.has('shadowJob'); }, day.resultId, { timeout: 120_000 });
const pmId = new URL(page.url()).searchParams.get('shadow');
await page.locator(`.map-shadow .shd-result[data-spatial-result-id="${pmId}"]`).waitFor({ timeout: 20_000 });
await page.waitForTimeout(1500);
const pmSun = (await api(page, `/v1/spatial-results/${pmId}/artifact`)).body?.metadata?.sun;
check('3D date/time control starts a new run and redraws for the new moment', Boolean(pmId) && pmSun && pmSun.azimuth_deg > artifact.metadata.sun.azimuth_deg, { pmId, sun: pmSun, noon: artifact.metadata.sun });
await shot(page, 'shadow-3d-afternoon.png');
check('no page errors in the specialist session', pageErrors.length === 0, pageErrors.slice(0, 3));
await sp.ctx.close();

// --- Viewer: someone else's draft result is 404 (IDOR), unknown id is 404, artifact too ---
const vw = await login(browser, 'viewer');
const idor = await api(vw.page, `/v1/spatial-results/${day.resultId}`);
const idorArtifact = await api(vw.page, `/v1/spatial-results/${day.resultId}/artifact`);
await vw.page.goto(`${BASE}/?city=${cityId}&shadow=${day.resultId}`);
const idorUi = await vw.page.getByText('Результат не найден').waitFor({ timeout: 20_000 }).then(() => true).catch(() => false);
const noLayer = await vw.page.evaluate(() => !window.__pgMap?.getLayer('shadow-fill'));
await vw.page.goto(`${BASE}/?city=${cityId}&shadow=${crypto.randomUUID()}`);
const unknownUi = await vw.page.getByText('Результат не найден').waitFor({ timeout: 20_000 }).then(() => true).catch(() => false);
await shot(vw.page, 'shadow-viewer-404.png');
check('IDOR: viewer gets 404 for result and artifact; UI says not found and draws nothing', idor.status === 404 && idorArtifact.status === 404 && idorUi && noLayer && unknownUi, { idor: idor.status, artifact: idorArtifact.status, idorUi, noLayer, unknownUi });
await vw.ctx.close();

// --- Phone + dark ---
const ph = await login(browser, 'specialist', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark' });
await ph.page.goto(`${BASE}/?city=${cityId}&zone=${smoke.zone_id}&shadow=${day.resultId}`);
await ph.page.waitForFunction(() => window.__pgMap?.getLayer('shadow-fill'), null, { timeout: 30_000 }).catch(() => {});
await ph.page.waitForTimeout(1500);
const overflow = await ph.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('phone (dark): shadow layer drawn, no horizontal scroll', (await ph.page.evaluate(() => Boolean(window.__pgMap.getLayer('shadow-fill')))) && overflow <= 0, { overflow });
await shot(ph.page, 'shadow-mobile-dark.png');
await ph.ctx.close();

await browser.close();
report.finishedAt = new Date().toISOString();
report.passed = report.checks.every((c) => c.pass);
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`\n${report.checks.filter((c) => c.pass).length}/${report.checks.length} checks passed`);
process.exit(report.passed ? 0 : 1);
