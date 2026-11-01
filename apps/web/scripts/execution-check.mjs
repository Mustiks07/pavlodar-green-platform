// WP-09 execution journey (contracts 1.10/1.11) on the isolated stack: a specialist creates a work
// order for an approved SYNTHETIC scenario, moves it through assigned/in_progress with reasons and
// If-Match (a stale ETag gives 412 and a refresh, nothing lost), records partial completions and a
// correction (server total counts chain leaves only), completes it, creates a cohort, records an
// inspection and a replacement, and compares forecast with observation; every total and comparison
// is the server's. A viewer sees completed orders only, without completion details.
//
//   uv run python -m tools.dev.isolated_browser_env --cwd apps/web -- node scripts/execution-check.mjs
import { chromium } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sessionCookie } from './lib/session-login.mjs';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5174';
const OUT = resolve('../../docs/evidence/wp09-execution-ui');
const ROOT = resolve('../..');
mkdirSync(OUT, { recursive: true });
const report = { base: BASE, startedAt: new Date().toISOString(), checks: [], shots: [] };
const check = (name, pass, detail) => {
  report.checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
};
const shot = async (page, file) => {
  await page.screenshot({ path: join(OUT, file), fullPage: false });
  report.shots.push(`docs/evidence/wp09-execution-ui/${file}`);
};
const api = (page, method, path, body, extra = {}) =>
  page.evaluate(
    async ({ method, path, body, extra }) => {
      const me = await (await fetch('/v1/me')).json();
      const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token, 'Idempotency-Key': crypto.randomUUID(), ...extra }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, etag: res.headers.get('ETag'), body: await res.json().catch(() => null) };
    },
    { method, path, body, extra },
  );
async function signIn(browser, role, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ru-RU', ...opts });
  const page = await ctx.newPage();
  if (!(await sessionCookie(ctx, role, BASE))) throw new Error('Run through tools/dev/isolated_browser_env.py (PG_SESSIONS)');
  await page.goto(BASE + '/');
  await page.waitForTimeout(800);
  return { ctx, page };
}

const fixture = spawnSync('uv', ['run', 'python', '-m', 'tools.dev.synthetic_execution_fixture'], { cwd: ROOT, env: process.env, encoding: 'utf8' });
const fx = fixture.status === 0 ? JSON.parse(fixture.stdout.trim().split('\n').at(-1)) : null;
check('setup: SYNTHETIC approved scenario with placements and a complete snapshot (disposable DB only)', Boolean(fx), { err: (fixture.stderr ?? '').slice(-300) });
if (!fx) process.exit(1);

const browser = await chromium.launch({ channel: process.env.PG_BROWSER_CHANNEL ?? 'msedge' });
const sp = await signIn(browser, 'specialist');
const page = sp.page;
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
const city = (await page.evaluate(async () => (await fetch('/v1/cities')).json())).items[0];
const cityDay = new Intl.DateTimeFormat('en-CA', { timeZone: city.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(Date.now());
const anniversaryDay = `${Number(cityDay.slice(0, 4)) + 1}${cityDay.slice(4)}`;
const detail = () => page.locator('.exec-detail[data-work-order-id]');
const serverOrder = async (id) => (await api(page, 'GET', `/v1/work-orders/${id}`)).body;
const transition = async (label, reason) => {
  await detail().getByRole('button', { name: label }).click();
  const dlg = page.locator('dialog[open]');
  await dlg.getByLabel(/^Причина/).fill(reason);
  await dlg.getByRole('button', { name: label }).click();
  await dlg.waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {});
};
const completion = async (qty, note, correctionLabel) => {
  const form = detail().locator('form.exec-form').filter({ hasText: 'Записать выполнение' });
  if (correctionLabel) await form.getByLabel(/^Тип записи/).selectOption({ label: correctionLabel });
  await form.getByLabel(/^Объём/).fill(String(qty));
  await form.getByLabel(/^Комментарий/).fill(note);
  await form.getByRole('button', { name: 'Записать', exact: true }).click();
};

// --- Create a work order through the UI ---
await page.goto(`${BASE}/execution?city=${city.id}`);
await page.getByRole('button', { name: 'Новый наряд' }).click();
const dlg = page.locator('dialog[open]');
await dlg.getByLabel(/^Сценарий/).selectOption({ label: 'SYNTHETIC TEST исполнение' });
await dlg.getByLabel(/^Операция/).fill('SYNTHETIC TEST посадка');
await dlg.getByLabel(/^Плановый объём/).fill('4');
await dlg.getByRole('button', { name: 'Создать наряд' }).click();
await page.waitForFunction(() => new URLSearchParams(location.search).has('order'), null, { timeout: 15_000 });
const orderId = new URL(page.url()).searchParams.get('order');
await detail().waitFor({ timeout: 15_000 });
check('work order created for the approved revision and opened from the URL', (await serverOrder(orderId)).scenario_revision_id === fx.revision_id, { orderId });

// --- Transitions with reasons ---
await transition('Назначить', 'SYNTHETIC TEST назначено');
await page.locator('.exec-detail[data-status="assigned"]').waitFor({ timeout: 15_000 });
await transition('Начать работы', 'SYNTHETIC TEST начато');
await page.locator('.exec-detail[data-status="in_progress"]').waitFor({ timeout: 15_000 });
check('transitions assigned -> in_progress through the server', (await serverOrder(orderId)).status === 'in_progress');

// --- 412: someone records a completion; the UI's ETag is stale ---
const fresh = await api(page, 'GET', `/v1/work-orders/${orderId}`);
const other = await api(page, 'POST', `/v1/work-orders/${orderId}/completions`, { performed_at: new Date().toISOString(), quantity: 1, water_m3: null, crew_minutes: 30, note: 'SYNTHETIC TEST параллельная запись', correction_of_id: null }, { 'If-Match': fresh.etag });
await completion(3, 'SYNTHETIC TEST основная посадка');
const conflict = await page.getByText('Наряд изменён другим пользователем').waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
await page.waitForFunction(() => document.querySelector('[data-completed]')?.getAttribute('data-completed') === '1', null, { timeout: 15_000 }).catch(() => {});
check('stale If-Match: 412 explained, server state reloaded (total 1), nothing written', other.status === 201 && conflict && (await serverOrder(orderId)).completed_quantity === 1, { other: other.status, conflict });
await completion(3, 'SYNTHETIC TEST основная посадка');
await page.waitForFunction(() => document.querySelector('[data-completed]')?.getAttribute('data-completed') === '4', null, { timeout: 15_000 }).catch(() => {});
const afterTwo = await serverOrder(orderId);
check('partial completions: server total 1 + 3 = 4 shown as the server value', afterTwo.completed_quantity === 4 && (await detail().locator('[data-completed]').getAttribute('data-completed')) === '4', { server: afterTwo.completed_quantity });

// --- Correction: the 1-piece record is corrected to 1 (chain leaf replaces it) ---
const rows = (await api(page, 'GET', `/v1/work-orders/${orderId}/completions?limit=200`)).body.items;
const small = rows.find((r) => r.quantity === 1);
const label = await detail().locator('form.exec-form').getByLabel(/^Тип записи/).locator('option').evaluateAll((os, id) => os.find((o) => o.value === id)?.textContent, small.id);
await completion(1, 'SYNTHETIC TEST исправление', label);
await detail().locator(`tr.is-superseded[data-completion-id="${small.id}"]`).waitFor({ timeout: 15_000 });
const afterFix = await serverOrder(orderId);
check('correction: original kept and marked superseded; server total still 4 (leaves only)', afterFix.completed_quantity === 4, { server: afterFix.completed_quantity });
await shot(page, 'execution-completions.png');

// --- Complete, then cohort ---
await transition('Завершить', 'SYNTHETIC TEST выполнено');
await page.locator('.exec-detail[data-status="completed"]').waitFor({ timeout: 15_000 });
const cohortForm = detail().locator('form.exec-form').filter({ hasText: 'Когорта посадки' });
const p4 = fx.placements.find((p) => p.quantity === 4);
await cohortForm.getByLabel(/^Позиция посадки/).selectOption(p4.id);
await cohortForm.getByRole('button', { name: 'Создать когорту' }).click();
const cohortCreated = await cohortForm.getByText('Когорта создана.').waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
const cohorts = (await api(page, 'GET', `/v1/cohorts?city_id=${city.id}&limit=200`)).body.items;
const cohort = cohorts.find((c) => c.source_work_order_id === orderId);
check('completed order -> cohort with the server initial quantity (4) for the exact placement', cohortCreated && cohort?.initial_quantity === 4 && cohort.placement_id === p4.id, { cohort });

// --- Inspection, replacement, forecast vs observed ---
await page.goto(`${BASE}/execution?city=${city.id}&cohort=${cohort.id}`);
const cd = page.locator(`.exec-detail[data-cohort-id="${cohort.id}"]`);
await cd.waitFor({ timeout: 15_000 });
const insp = cd.locator('form.exec-form').filter({ hasText: 'Записать осмотр' });
await insp.getByLabel(/^Живых/).fill('3');
await insp.getByLabel(/^Погибших/).fill('1');
await insp.getByLabel(/^Неизвестно/).fill('0');
await insp.getByLabel(/^Метод осмотра/).fill('SYNTHETIC TEST визуальный');
await insp.getByLabel(/^Комментарий/).fill('SYNTHETIC TEST осмотр');
await insp.getByRole('button', { name: 'Записать осмотр' }).click();
const latest = await cd.getByText('последний').waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
const cohortNow = (await api(page, 'GET', `/v1/cohorts?city_id=${city.id}&limit=200`)).body.items.find((c) => c.id === cohort.id);
check('inspection recorded; the server marks it as the latest', latest && Boolean(cohortNow.latest_inspection_id), { latest: cohortNow.latest_inspection_id });
const anniversaryInspection = await api(page, 'POST', '/v1/inspections', {
  city_id: city.id,
  zone_id: fx.zone_id,
  cohort_id: cohort.id,
  observed_at: `${anniversaryDay}T09:00:00Z`,
  alive_count: 3,
  dead_count: 1,
  unknown_count: 0,
  method: 'SYNTHETIC TEST годовщина',
  note: 'SYNTHETIC TEST сопоставимый полный осмотр',
  source_refs: [],
});
check('anniversary inspection is available for comparable forecast-versus-observed', anniversaryInspection.status === 201, { status: anniversaryInspection.status });

// A second completed piece order (API) to plant the replacement, dated on the city's calendar day
// (the UI's planting date defaults to it; 06:00Z is the same day in Pavlodar).
const rep = await api(page, 'POST', '/v1/work-orders', { city_id: city.id, scenario_revision_id: fx.revision_id, zone_id: fx.zone_id, operation: 'SYNTHETIC TEST замена', planned_start: cityDay, planned_end: cityDay, quantity: 1, unit: 'piece', assignee_group: null });
let etag = rep.etag;
for (const target of ['assigned', 'in_progress']) etag = (await api(page, 'POST', `/v1/work-orders/${rep.body.id}/transitions`, { target_status: target, reason: 'SYNTHETIC TEST' }, { 'If-Match': etag })).etag;
await api(page, 'POST', `/v1/work-orders/${rep.body.id}/completions`, { performed_at: `${cityDay}T06:00:00Z`, quantity: 1, water_m3: null, crew_minutes: 10, note: 'SYNTHETIC TEST замена', correction_of_id: null }, { 'If-Match': etag });
etag = (await api(page, 'GET', `/v1/work-orders/${rep.body.id}`)).etag;
await api(page, 'POST', `/v1/work-orders/${rep.body.id}/transitions`, { target_status: 'completed', reason: 'SYNTHETIC TEST' }, { 'If-Match': etag });
await page.reload();
await cd.waitFor({ timeout: 15_000 });
const repl = cd.locator('form.exec-form').filter({ hasText: 'Замена погибших' });
await repl.getByLabel(/^Наряд замены/).selectOption(rep.body.id);
await repl.getByLabel(/^Позиция замены/).selectOption(fx.placements.find((p) => p.quantity === 1).id);
const qtyFilled = await repl.getByLabel(/^Количество/).inputValue();
await repl.getByLabel(/^Причина/).fill('SYNTHETIC TEST замена погибшего');
await repl.getByRole('button', { name: 'Записать замену' }).click();
const replaced = await repl.getByText('Замена записана.').waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
const lineage = (await api(page, 'GET', `/v1/cohorts?city_id=${city.id}&limit=200`)).body.items.find((c) => c.replaces_cohort_id === cohort.id);
check('replacement: placement chosen from the revision (quantity taken from it) -> new cohort linked to the original', replaced && qtyFilled === '1' && lineage?.initial_quantity === 1, { qtyFilled, lineage });
const replacementInspection = await api(page, 'POST', '/v1/inspections', {
  city_id: city.id,
  zone_id: fx.zone_id,
  cohort_id: lineage.id,
  observed_at: `${cityDay}T09:00:00Z`,
  alive_count: 1,
  dead_count: 0,
  unknown_count: 0,
  method: 'SYNTHETIC TEST визуальный',
  note: 'SYNTHETIC TEST полный осмотр замены',
  source_refs: [],
});
check('replacement cohort has its own complete inspection', replacementInspection.status === 201, { status: replacementInspection.status });

const fo = cd.locator('.exec-form').filter({ hasText: 'Прогноз и факт' });
// Snapshots are discovered for the cohort's exact revision (listCalculations); no typed id.
const snapSelect = fo.getByLabel(/^Снимок расчёта/);
await snapSelect.waitFor({ timeout: 15_000 });
const offered = await snapSelect.locator('option').evaluateAll((els) => els.map((e) => e.value));
const listed = (await api(page, 'GET', `/v1/calculations?scenario_revision_id=${fx.revision_id}&limit=200`)).body?.items ?? [];
check(
  'forecast vs observed: snapshots offered from listCalculations for the exact cohort revision, no manual id input',
  (await snapSelect.evaluate((e) => e.tagName)) === 'SELECT' &&
    (await snapSelect.getAttribute('data-revision-id')) === fx.revision_id &&
    offered.includes(fx.snapshot_id) &&
    offered.length === listed.length &&
    listed.every((s) => s.scenario_revision_id === fx.revision_id),
  { offered: offered.length, listed: listed.length },
);
await snapSelect.selectOption(fx.snapshot_id);
const foResponse = page.waitForResponse((r) => r.url().endsWith('/v1/forecast-observed'));
await fo.getByRole('button', { name: 'Сравнить' }).click();
const server = await (await foResponse).json();
await fo.locator('.exec-fo').waitFor({ timeout: 15_000 });
const foText = await fo.locator('.exec-fo').innerText();
const comparableShown = (await fo.locator('.exec-fo').getAttribute('data-comparable')) === String(server.comparable);
check(
  'forecast vs observed: comparability, probabilities and delta are the server result; a non-comparable delta stays unknown',
  comparableShown && (server.probability_delta === null ? foText.includes('не рассчитана') : true) && foText.includes(server.method_version),
  { comparable: server.comparable, delta: server.probability_delta, offset: server.date_offset_days, gaps: server.data_gaps?.map((g) => g.code) },
);
const outcomeValues = await fo.locator('.exec-outcome article strong').allInnerTexts();
check(
  'original deaths remain separate after replacement: initial 4, original alive 3, replacement alive 1, total alive 4',
  server.initial_quantity === 4 &&
    server.observed_alive_initial === 3 &&
    server.replacements_alive === 1 &&
    server.total_alive === 4 &&
    server.observed_survival_probability === 0.75 &&
    outcomeValues.join('|') === '4|3|1|4',
  { outcomeValues, initial: server.initial_quantity, originalAlive: server.observed_alive_initial, replacementsAlive: server.replacements_alive, totalAlive: server.total_alive },
);
await fo.locator('.exec-fo').scrollIntoViewIfNeeded();
await shot(page, 'execution-outcome.png');
await cd.scrollIntoViewIfNeeded();
await shot(page, 'execution-cohort.png');
await page.reload();
const restored = await page.locator(`.exec-detail[data-cohort-id="${cohort.id}"]`).waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
check('reload restores the selected cohort from the URL', restored);
check('no page errors in the specialist session', pageErrors.length === 0, pageErrors.slice(0, 3));
await sp.ctx.close();

// --- Viewer: completed orders only, no completion details ---
const vw = await signIn(browser, 'viewer');
const vOrders = (await vw.page.evaluate(async (c) => (await fetch(`/v1/work-orders?city_id=${c}&limit=200`)).json(), city.id)).items ?? [];
await vw.page.goto(`${BASE}/execution?city=${city.id}&order=${orderId}`);
await vw.page.locator('.exec-detail').waitFor({ timeout: 15_000 }).catch(() => {});
const vText = await vw.page.locator('.exec-detail').innerText().catch(() => '');
check('viewer: only completed orders listed; completion details withheld', vOrders.every((o) => o.status === 'completed') && vText.includes('Подробные выполнения видят специалист'), { statuses: vOrders.map((o) => o.status) });
await shot(vw.page, 'execution-viewer.png');
await vw.ctx.close();

// --- Phone + dark ---
const ph = await signIn(browser, 'specialist', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark' });
await ph.page.goto(`${BASE}/execution?city=${city.id}&order=${orderId}`);
await ph.page.locator('.exec-detail').waitFor({ timeout: 15_000 }).catch(() => {});
const overflow = await ph.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('phone (dark): execution page without horizontal scroll', overflow <= 0, { overflow });
await shot(ph.page, 'execution-mobile-dark.png');
await ph.ctx.close();

await browser.close();
report.finishedAt = new Date().toISOString();
report.passed = report.checks.every((c) => c.pass);
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`\n${report.checks.filter((c) => c.pass).length}/${report.checks.length} checks passed`);
process.exit(report.passed ? 0 : 1);
