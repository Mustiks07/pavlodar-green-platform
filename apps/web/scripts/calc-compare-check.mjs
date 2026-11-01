// C4/C5 live journey on the isolated stack (tools/dev/isolated_browser_env.py): a durable full
// calculation is started from the scenario screen, tracked through the shared useJob (SSE with
// polling fallback), resumed after reload, cancelled, retried after a start error, and only counts
// as done once the canonical CalculationSnapshot is loaded; compareScenarios then lays 2 snapshots
// side by side with comparability warnings, unknown totals and links to the exact snapshot ids,
// and a revision without a calculation is named. SYNTHETIC TEST data only.
//
//   uv run python -m tools.dev.isolated_browser_env --cwd apps/web -- node scripts/calc-compare-check.mjs
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sessionCookie } from './lib/session-login.mjs';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5174';
const OUT = resolve('../../docs/evidence/wp05-calc-compare');
mkdirSync(OUT, { recursive: true });
const report = { base: BASE, startedAt: new Date().toISOString(), checks: [], shots: [] };
const check = (name, pass, detail) => {
  report.checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
};
const shot = async (page, file) => {
  await page.screenshot({ path: join(OUT, file), fullPage: false });
  report.shots.push(`docs/evidence/wp05-calc-compare/${file}`);
};
const apiCall = (page, method, path, body) =>
  page.evaluate(
    async ({ method, path, body }) => {
      const me = await (await fetch('/v1/me')).json();
      const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token, 'Idempotency-Key': crypto.randomUUID() }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    { method, path, body },
  );
async function signIn(browser, role, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ru-RU', ...opts });
  const page = await ctx.newPage();
  if (!(await sessionCookie(ctx, role, BASE))) throw new Error('Run through tools/dev/isolated_browser_env.py (PG_SESSIONS)');
  await page.goto(BASE + '/');
  await page.waitForTimeout(800);
  return { ctx, page };
}

const browser = await chromium.launch({ channel: process.env.PG_BROWSER_CHANNEL ?? 'msedge' });
const sp = await signIn(browser, 'specialist');
const page = sp.page;
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
const reads = { snapshots: [], streams: [] };
page.on('response', (r) => {
  const p = new URL(r.url()).pathname;
  if (/^\/v1\/calculations\/[0-9a-f-]{36}$/.test(p)) reads.snapshots.push({ id: p.split('/').pop(), status: r.status() });
  if (/\/events$/.test(p)) reads.streams.push(r.status());
});

// --- Setup: SYNTHETIC zone and three scenarios (empty drafts) ---
const city = (await page.evaluate(async () => (await fetch('/v1/cities')).json())).items[0];
const zone = await apiCall(page, 'POST', '/v1/zones', {
  city_id: city.id, name: 'SYNTHETIC TEST calc/compare', purpose: 'park',
  geometry: { type: 'Polygon', coordinates: [[[76.98, 52.28], [76.981, 52.28], [76.981, 52.281], [76.98, 52.281], [76.98, 52.28]]] },
});
const draft = {
  zone_version_id: zone.body.version_id, parent_revision_id: null, dataset_version_ids: [], catalog_version_id: null, rate_version_id: null, coefficient_version_id: null,
  rule_version_id: null, model_version_id: null, placements: [], area_patches: [], capital_budget: null, care_horizon_years: 3, resource_limits: [], excluded_plant_ids: [],
  diversity_caps: [], care_strategy: 'standard', custom_care_operations: [], comment: 'SYNTHETIC TEST calc/compare',
};
const scen = [];
for (const n of ['A', 'B', 'C']) {
  const r = await apiCall(page, 'POST', '/v1/scenarios', { city_id: city.id, zone_id: zone.body.id, name: `SYNTHETIC TEST вариант ${n}`, base_revision_id: null, initial_state: draft });
  scen.push(r.body);
}
check('setup: SYNTHETIC zone and three scenarios', zone.status === 201 && scen.every((s) => s?.current_revision_id), scen.map((s) => s?.id));
const [A, B, C] = scen;
const card = () => page.locator('.calc-full');
const urlParam = (k) => new URL(page.url()).searchParams.get(k);

// --- C4: start error -> retry; then the run reaches its snapshot ---
await page.goto(`${BASE}/projects/${A.id}?city=${city.id}`);
await card().waitFor({ timeout: 30_000 });
let failed = false;
await page.route('**/v1/calculations', (route) => {
  if (route.request().method() !== 'POST' || failed) return route.continue();
  failed = true;
  return route.fulfill({ status: 503, contentType: 'application/problem+json', body: JSON.stringify({ type: 'about:blank', title: 'storage_unavailable', status: 503, detail: 'SYNTHETIC TEST outage', code: 'storage_unavailable', request_id: crypto.randomUUID(), current_revision_id: null, field_errors: [], blockers: [] }) });
});
await card().getByRole('button', { name: 'Запустить полный расчёт' }).click();
const startErr = await card().locator('.pg-state, [role=alert]').first().waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
await card().scrollIntoViewIfNeeded();
await shot(page, 'calc-start-503.png');
await card().getByRole('button', { name: 'Запустить полный расчёт' }).click();
await page.waitForFunction(() => new URLSearchParams(location.search).has('calcJob'), null, { timeout: 15_000 });
const jobA = urlParam('calcJob');
const transport = await page.locator('.calc-full').getAttribute('data-job-transport');
await page.waitForFunction(() => new URLSearchParams(location.search).has('calc') && !new URLSearchParams(location.search).has('calcJob'), null, { timeout: 120_000 });
const snapA = urlParam('calc');
await page.locator(`.calc-full .scn-calculation__result[data-calculation-id="${snapA}"]`).waitFor({ timeout: 20_000 });
await page.unroute('**/v1/calculations');
const jobAfter = (await apiCall(page, 'GET', `/v1/jobs/${jobA}`)).body;
const snapApi = (await apiCall(page, 'GET', `/v1/calculations/${snapA}`)).body;
const resultText = await page.locator(`.calc-full .scn-calculation__result[data-calculation-id="${snapA}"]`).innerText();
check('start 503 offers retry; the retried run is a new job', startErr && failed && Boolean(jobA), { startErr, jobA });
check(
  'succeeded job -> canonical CalculationSnapshot loaded by result_ref_id (not just the terminal job)',
  jobAfter.state === 'succeeded' && jobAfter.result_ref_id === snapA && reads.snapshots.some((s) => s.id === snapA && s.status === 200),
  { job: jobAfter.state, ref: jobAfter.result_ref_id, snapA, snapshotReads: reads.snapshots.filter((s) => s.id === snapA).length },
);
check(
  'partial result shown as partial; incomplete total is unknown, not zero',
  snapApi.status === 'partial' ? resultText.includes('Неполный расчёт') : resultText.includes('Полный'),
  { status: snapApi.status, costStatus: snapApi.cost.status, total: snapApi.cost.total, text: resultText.slice(0, 200) },
);
check('job tracked through the SSE stream (shared useJob)', transport === 'stream' || reads.streams.includes(200), { transport, streams: reads.streams.slice(0, 3) });
await page.locator(`.scn-calculation__result[data-calculation-id="${snapA}"]`).scrollIntoViewIfNeeded();
await shot(page, 'calc-full-snapshot.png');

// --- C4: reload during a run resumes from the URL ---
await page.goto(`${BASE}/projects/${B.id}?city=${city.id}`);
await card().waitFor({ timeout: 30_000 });
await card().getByRole('button', { name: 'Запустить полный расчёт' }).click();
await page.waitForFunction(() => new URLSearchParams(location.search).has('calcJob'), null, { timeout: 15_000 });
const jobB = urlParam('calcJob');
await page.reload();
await page.waitForFunction(() => new URLSearchParams(location.search).has('calc') && !new URLSearchParams(location.search).has('calcJob'), null, { timeout: 120_000 });
const snapB = urlParam('calc');
const jobBApi = (await apiCall(page, 'GET', `/v1/jobs/${jobB}`)).body;
await page.locator(`.scn-calculation__result[data-calculation-id="${snapB}"]`).waitFor({ timeout: 20_000 });
check('reload during the run resumes the same job and lands on its snapshot', jobBApi.result_ref_id === snapB, { jobB, snapB, state: jobBApi.state });
await page.reload();
await page.locator(`.scn-calculation__result[data-calculation-id="${snapB}"]`).waitFor({ timeout: 20_000 });
check('reload keeps the snapshot from the URL', true);

// --- C4: cancel (the worker may finish first; the UI must end in the server's state) ---
await card().getByRole('button', { name: 'Запустить полный расчёт' }).click();
await page.waitForFunction(() => new URLSearchParams(location.search).has('calcJob'), null, { timeout: 15_000 });
const jobCancel = urlParam('calcJob');
await card().locator('.pg-job').waitFor({ timeout: 10_000 }).catch(() => {});
const cancelBtn = card().locator('.pg-job').getByRole('button');
const couldCancel = await cancelBtn.isVisible().catch(() => false);
if (couldCancel) await cancelBtn.click().catch(() => {});
let cancelled = null;
for (let i = 0; i < 120; i++) {
  cancelled = (await apiCall(page, 'GET', `/v1/jobs/${jobCancel}`)).body;
  if (['succeeded', 'cancelled', 'failed'].includes(cancelled.state)) break;
  await page.waitForTimeout(500);
}
await page.waitForTimeout(1500);
const cardText = await card().innerText();
const consistent = cancelled.state === 'cancelled' ? /Расчёт отменён|Отменена/.test(cardText) && urlParam('calc') === snapB : cancelled.state === 'succeeded' ? urlParam('calc') === cancelled.result_ref_id : false;
check('cancel: UI ends in the server state (cancelled keeps the previous snapshot; a run that finished first shows its snapshot)', consistent, { couldCancel, state: cancelled.state });
await card().scrollIntoViewIfNeeded();
await shot(page, 'calc-cancel.png');

// --- C4: unknown snapshot id ---
await page.goto(`${BASE}/projects/${A.id}?city=${city.id}&calc=${crypto.randomUUID()}`);
const missing = await page.getByText('Снимок расчёта не найден').waitFor({ timeout: 20_000 }).then(() => true).catch(() => false);
check('unknown snapshot id: not found state, nothing invented', missing);

// --- C5: compare A and B (latest immutable snapshots, server-chosen) ---
// The reference is the very response the page received (a background run may add snapshots).
const compareResponse = page.waitForResponse((r) => r.url().endsWith('/v1/comparisons') && r.request().method() === 'POST', { timeout: 30_000 });
await page.goto(`${BASE}/compare?city=${city.id}&revisions=${A.current_revision_id},${B.current_revision_id}`);
const latestA = await (await compareResponse).json();
await page.locator('.cmp-result').waitFor({ timeout: 30_000 });
const compared = (await page.locator('.cmp').getAttribute('data-compared')).split(',');
const links = await page.locator('.cmp-table a[href*="calc="]').evaluateAll((as) => as.map((a) => new URL(a.href).searchParams.get('calc')));
const warnings = await page.locator('.cmp-result [data-code]').evaluateAll((li) => li.map((x) => x.getAttribute('data-code')));
const tableText = await page.locator('.cmp-table').innerText();
const serverIds = latestA.snapshots.map((s) => s.id);
check('compare: columns are the server-chosen snapshots, each linked by its exact id', JSON.stringify(compared) === JSON.stringify(serverIds) && JSON.stringify(links) === JSON.stringify(serverIds), { compared, links, serverIds });
check('compare: comparability warnings shown as returned', JSON.stringify(warnings) === JSON.stringify(latestA.comparability_warnings.map((w) => w.code)), { warnings });
const unknownTotals = latestA.snapshots.filter((s) => !(s.cost.status === 'complete' && s.cost.total)).length;
check('compare: unknown totals stay unknown (not 0), statuses and snapshot ids visible', (tableText.match(/Не рассчитан из-за отсутствующих данных/g) ?? []).length === unknownTotals && serverIds.every((id) => tableText.includes(id.slice(0, 8))), { unknownTotals });
await shot(page, 'compare-a-b.png');

// --- C5: a revision without a calculation is named (422) ---
await page.goto(`${BASE}/compare?city=${city.id}&revisions=${A.current_revision_id},${C.current_revision_id}`);
const missingNotice = page.getByText('Для сравнения отсутствует расчёт');
const named = await missingNotice.waitFor({ timeout: 20_000 }).then(() => true).catch(() => false);
const linkToC = await page.locator(`a[href*="/projects/${C.id}"]`).count();
check('compare without a calculation: 422 names the revision with a link to its scenario', named && linkToC > 0, { named, linkToC });
await shot(page, 'compare-missing.png');
check('no page errors in the specialist session', pageErrors.length === 0, pageErrors.slice(0, 3));
await sp.ctx.close();

// --- Phone + dark ---
const ph = await signIn(browser, 'specialist', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark' });
await ph.page.goto(`${BASE}/compare?city=${city.id}&revisions=${A.current_revision_id},${B.current_revision_id}`);
await ph.page.locator('.cmp-result').waitFor({ timeout: 30_000 });
const overflow = await ph.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('phone (dark): comparison fits (table scrolls inside its box)', overflow <= 0, { overflow });
await shot(ph.page, 'compare-mobile-dark.png');
await ph.ctx.close();

await browser.close();
report.finishedAt = new Date().toISOString();
report.passed = report.checks.every((c) => c.pass);
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`\n${report.checks.filter((c) => c.pass).length}/${report.checks.length} checks passed`);
process.exit(report.passed ? 0 : 1);
