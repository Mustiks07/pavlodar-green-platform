// Live end-to-end: zone on map -> zone card -> scenario draft -> new revision with If-Match ->
// concurrent edit -> 412 conflict UI -> rebase -> save -> reload restores data and selection.
// Runs against the real foundation API; creates only labelled SYNTHETIC test zone/scenarios.
//
//   PG_TEST_CREDENTIALS=<ignored local test-credentials.json> node scripts/scenario-check.mjs
import { chromium } from '@playwright/test';
import { sessionCookie } from './lib/session-login.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5173';
const OUT = resolve('../../docs/evidence/wp04-zones-scenarios');
const creds = JSON.parse(readFileSync(process.env.PG_TEST_CREDENTIALS ?? '', 'utf8'));
mkdirSync(OUT, { recursive: true });

const report = { base: BASE, startedAt: new Date().toISOString(), checks: [], shots: [] };
const check = (name, pass, detail) => {
  report.checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
};
const shot = async (page, file) => {
  await page.screenshot({ path: join(OUT, file) });
  report.shots.push(`docs/evidence/wp04-zones-scenarios/${file}`);
};
const settle = (page) =>
  page.waitForFunction(() => !document.querySelector('.pg-state .pg-spinner, .pg-skeleton'), null, { timeout: 15_000 }).catch(() => {});

async function login(browser, role) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'ru-RU' });
  const page = await ctx.newPage();
  if (await sessionCookie(ctx, role, BASE)) {
    await page.goto(BASE + '/');
    await page.waitForTimeout(800);
    return { ctx, page };
  }
  await page.goto(BASE + '/');
  const btn = page.getByRole('button', { name: 'Войти через корпоративную учётную запись' }).first();
  await btn.waitFor({ timeout: 15_000 });
  await Promise.all([page.waitForURL(/openid-connect\/auth/, { waitUntil: 'commit', timeout: 20_000 }), btn.click()]);
  await page.waitForSelector('#username');
  await page.fill('#username', role);
  await page.fill('#password', creds[role]);
  await page.click('#kc-login');
  await page.waitForURL((u) => u.origin === new URL(BASE).origin && !u.pathname.startsWith('/auth/'), { waitUntil: 'commit', timeout: 20_000 });
  await settle(page);
  return { ctx, page };
}

/** Test-only API calls from inside the signed-in page (same cookie + CSRF as the UI). */
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

// ---------------------------------------------------------------- specialist
const { ctx, page } = await login(browser, 'specialist');
const cities = await page.evaluate(async () => (await fetch('/v1/cities')).json());
const city = cities.items[0];
check('specialist: city from API', Boolean(city), { name: city?.name, boundary_status: city?.boundary_status });

let zones = await page.evaluate(async (id) => (await fetch(`/v1/zones?city_id=${id}&limit=200`)).json(), city.id);
let zone = zones.items?.[0];
if (!zone) {
  // Test profile has no zones: create one SYNTHETIC test zone inside the city bbox via the real API.
  const ring = city.boundary.type === 'Polygon' ? city.boundary.coordinates[0] : city.boundary.coordinates[0][0];
  const xs = ring.map((c) => c[0]);
  const ys = ring.map((c) => c[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const d = 0.0015;
  const created = await apiCall(page, 'POST', '/v1/zones', {
    city_id: city.id,
    name: 'SYNTHETIC TEST участок (UI check)',
    purpose: 'square',
    geometry: { type: 'Polygon', coordinates: [[[cx - d, cy - d], [cx + d, cy - d], [cx + d, cy + d], [cx - d, cy + d], [cx - d, cy - d]]] },
  });
  check('specialist: synthetic test zone created through API', created.status === 201, { status: created.status, code: created.body?.code });
  zone = created.body;
}

await page.goto(`${BASE}/?city=${city.id}`);
await settle(page);
await page.waitForTimeout(1500);
const rendered = await page.evaluate(() => window.__pgMap?.queryRenderedFeatures({ layers: ['zones-fill'] }).length ?? -1);
check('map: zones from listZones rendered', rendered > 0, { rendered });
await shot(page, 'map-zones-specialist.png');

await page.locator(`[data-row-id="${zone.id}"]`).click();
await page.waitForSelector('.zone-card', { timeout: 15_000 });
await settle(page);
const card = await page.locator('.zone-card').innerText();
check('zone card: area from server with unit and version', card.includes('м²') && card.includes('Версия геометрии'), {});
check('zone card: empty restrictions not presented as "none on the ground"', card.includes('не означает их отсутствия') || card.includes('Ограничения'), {});
await shot(page, 'zone-card-specialist.png');
await page.reload();
await page.waitForSelector('.zone-card', { timeout: 15_000 }).catch(() => {});
check('reload keeps selected zone', (await page.locator('.zone-card').count()) === 1 && page.url().includes(`zone=${zone.id}`), { url: page.url() });

// Create a draft through the dialog
const scenarioName = `SYNTHETIC TEST сценарий ${new Date().toISOString().slice(11, 19)}`;
await page.getByRole('button', { name: 'Создать черновик сценария' }).click();
await page.getByLabel('Название сценария').fill(scenarioName);
await shot(page, 'scenario-create-dialog.png');
await Promise.all([page.waitForURL(/\/projects\/[0-9a-f-]{36}/, { timeout: 20_000 }), page.getByRole('button', { name: 'Создать черновик', exact: true }).click()]);
await settle(page);
const scenarioId = new URL(page.url()).pathname.split('/').pop();
// The map now has its own semantic h1. Router navigation commits the URL before the lazy
// scenario chunk replaces that heading, so wait for the destination heading explicitly.
await page.getByRole('heading', { name: scenarioName, exact: true, level: 1 }).waitFor({ timeout: 15_000 });
const header = await page.locator('main h1').innerText();
check('draft created via createScenario and opened', header === scenarioName, { header, scenarioId });
await shot(page, 'scenario-draft.png');

// Edit and save a new revision (If-Match from scenario ETag)
await page.getByLabel('Капитальный бюджет, ₸').fill('12.5');
const invalidShown = await page.getByText('Сумма в формате 1500000.00').isVisible();
check('budget validates Money format before sending', invalidShown);
await page.getByLabel('Капитальный бюджет, ₸').fill('1500000.00');
await page.getByLabel('Комментарий к ревизии').fill('SYNTHETIC TEST: бюджет задан');
await page.getByRole('button', { name: 'Сохранить новую ревизию' }).click();
await page.waitForSelector('.pg-save--saved', { timeout: 15_000 }).catch(() => {});
const savedText = await page.locator('.pg-save').first().innerText();
check('save creates new revision and reports it', savedText.includes('Сохранено, ревизия'), { savedText });
const revs1 = await page.evaluate(async (id) => (await fetch(`/v1/scenarios/${id}/revisions?limit=200`)).json(), scenarioId);
check('server has 2 revisions after save', revs1.items?.length === 2, { count: revs1.items?.length });

// Unsaved draft survives reload (local only, labelled)
await page.getByLabel('Комментарий к ревизии').fill('SYNTHETIC TEST: несохранённая правка');
await page.reload();
await settle(page);
const restored = await page.getByText('Восстановлены ваши несохранённые правки').isVisible().catch(() => false);
const restoredValue = await page.getByLabel('Комментарий к ревизии').inputValue();
check('unsaved edits restored after reload and labelled as local', restored && restoredValue.includes('несохранённая'), { restoredValue });

// Concurrent edit through the API, then the UI save must get 412 and show the conflict
const sc = await page.evaluate(async (id) => {
  const r = await fetch(`/v1/scenarios/${id}`);
  return { etag: r.headers.get('ETag'), body: await r.json() };
}, scenarioId);
const cur = await page.evaluate(async (id) => (await fetch(`/v1/scenario-revisions/${id}`)).json(), sc.body.current_revision_id);
const keys = ['zone_version_id', 'dataset_version_ids', 'catalog_version_id', 'rate_version_id', 'coefficient_version_id', 'rule_version_id', 'model_version_id', 'placements', 'area_patches', 'capital_budget', 'care_horizon_years', 'resource_limits', 'excluded_plant_ids', 'diversity_caps', 'care_strategy', 'custom_care_operations'];
const concurrent = await apiCall(
  page,
  'POST',
  `/v1/scenarios/${scenarioId}/revisions`,
  { ...Object.fromEntries(keys.map((k) => [k, cur[k]])), parent_revision_id: cur.id, care_horizon_years: 1, comment: 'SYNTHETIC TEST: параллельная правка' },
  { 'If-Match': sc.etag },
);
check('concurrent revision accepted by server', concurrent.status === 201, { status: concurrent.status, code: concurrent.body?.code });

await page.getByRole('button', { name: 'Сохранить новую ревизию' }).click();
await page.waitForSelector('.pg-save--conflict', { timeout: 15_000 }).catch(() => {});
const conflictVisible = await page.getByText('Сценарий изменён другим пользователем или вкладкой').isVisible().catch(() => false);
const keptValue = await page.getByLabel('Комментарий к ревизии').inputValue();
check('stale If-Match -> 412 conflict shown, edits kept', conflictVisible && keptValue.includes('несохранённая'), { keptValue });
await shot(page, 'scenario-conflict-412.png');

await page.getByRole('button', { name: 'Перенести мои правки на текущую ревизию' }).first().click();
await page.waitForFunction(() => !document.body.innerText.includes('Сценарий изменён другим пользователем'), null, { timeout: 15_000 }).catch(() => {});
await settle(page);
await page.getByRole('button', { name: 'Сохранить новую ревизию' }).click();
await page.waitForSelector('.pg-save--saved', { timeout: 15_000 }).catch(() => {});
const revs2 = await page.evaluate(async (id) => (await fetch(`/v1/scenarios/${id}/revisions?limit=200`)).json(), scenarioId);
check('after rebase the save succeeds as a 4th revision (no lost update)', revs2.items?.length === 4, { count: revs2.items?.length });
await shot(page, 'scenario-after-rebase.png');

// Reload restores saved data; selecting an old revision persists in URL
await page.reload();
await settle(page);
await page.waitForSelector('.scn-main .pg-money', { timeout: 15_000 }).catch(() => {});
const summary = (await page.locator('.scn-main').innerText()).replace(/\s/g, ' ');
check('reload shows saved budget from server', summary.includes('1 500 000,00'), {});
const oldRev = revs2.items.find((r) => r.comment === 'SYNTHETIC TEST: бюджет задан');
await page.locator(`[data-row-id="${oldRev.id}"]`).click();
await page.waitForSelector('text=Просмотр прежней ревизии');
await page.reload();
await settle(page);
const oldShown = await page.getByText('Просмотр прежней ревизии').isVisible().catch(() => false);
check('reload keeps the selected (old, immutable) revision', oldShown && page.url().includes(`revision=${oldRev.id}`), { url: page.url() });
await shot(page, 'scenario-old-revision.png');

await page.getByRole('button', { name: 'Запустить быстрый расчёт' }).click();
await page.waitForSelector('.scn-calculation__result[data-calculation-id]', { timeout: 15_000 });
const calculation = await page.locator('.scn-calculation__result').innerText();
const calculationId = await page.locator('.scn-calculation__result').getAttribute('data-calculation-id');
check(
  'calculateFast is connected: immutable server snapshot and honest partial state are shown',
  Boolean(calculationId) && calculation.includes('Неполный расчёт') && calculation.includes('Известная сумма'),
  { calculationId, text: calculation.slice(0, 240) },
);
const manifestHref = await page.locator('.scn-calculation__result a', { hasText: 'Манифест расчёта' }).getAttribute('href').catch(() => null);
await page.locator('.scn-calculation__result').scrollIntoViewIfNeeded();
await shot(page, 'scenario-calculation.png');
check(
  'calculation card: server cost breakdown with tax state, unknown total not shown as zero, manifest link, no source/unverified lines',
  /Не рассчитан|Итог/.test(calculation) && calculation.includes('Строки серверной сметы') && Boolean(manifestHref) && !/Источник|не провер/i.test(calculation),
  { manifestHref, text: calculation.slice(0, 400) },
);

// Status transition through the real server: submit for review with a reason.
await page.getByRole('button', { name: 'К текущей ревизии' }).click();
await page.getByRole('button', { name: 'Отправить на внутреннюю проверку' }).click();
await page.getByLabel('Причина').fill('SYNTHETIC TEST: проверка перехода');
await page.getByRole('button', { name: 'Подтвердить переход' }).click();
await page.waitForFunction(() => !document.querySelector('dialog[open] [aria-busy="true"]'), null, { timeout: 15_000 }).catch(() => {});
await page.waitForTimeout(800);
const dialogStillOpen = (await page.locator('dialog[open]').count()) === 1;
const afterStatus = await page.evaluate(async (id) => (await (await fetch(`/v1/scenarios/${id}`)).json()).status, scenarioId);
const dialogText = dialogStillOpen ? await page.locator('dialog[open]').innerText() : '';
check('transition: server result shown (status changed, or refusal with reasons)', (!dialogStillOpen && afterStatus === 'in_review') || /причины|Не удалось|недоступн|Версия изменилась|Нет доступа/i.test(dialogText), { afterStatus, dialog: dialogText.slice(0, 200) });
await shot(page, 'scenario-transition.png');
if (dialogStillOpen) await page.keyboard.press('Escape');
const editorLocked = afterStatus !== 'draft' ? await page.getByText('Сценарий не в статусе черновика').isVisible().catch(() => false) : true;
check('non-draft scenario locks the editor with an explanation', editorLocked, { afterStatus });
await ctx.close();

// ---------------------------------------------------------------- viewer
{
  const { ctx: vctx, page: vpage } = await login(browser, 'viewer');
  await vpage.goto(`${BASE}/?city=${city.id}&zone=${zone.id}`);
  await vpage.waitForSelector('.zone-card', { timeout: 15_000 }).catch(() => {});
  await settle(vpage);
  await shot(vpage, 'zone-card-viewer.png');
  const noCreate = (await vpage.getByRole('button', { name: 'Создать черновик сценария' }).count()) === 0;
  const hint = await vpage.getByText('доступно роли «специалист»').isVisible().catch(() => false);
  check('viewer: no create-draft action, role hint shown instead', noCreate && hint, { main: (await vpage.locator('aside').first().innerText()).slice(0, 300) });
  const scenarioStatus = await vpage.evaluate(async (id) => (await fetch(`/v1/scenarios/${id}`)).status, scenarioId);
  await vpage.goto(`${BASE}/projects/${scenarioId}?city=${city.id}`);
  await settle(vpage);
  await vpage.waitForTimeout(1000);
  const text = await vpage.locator('main').innerText();
  // Viewer either reads the draft read-only or gets the server's denial as a typed state.
  const readOnly = (await vpage.locator('fieldset.scn-form').count()) === 1 ? await vpage.locator('fieldset.scn-form').isDisabled() : false;
  const denied = /Нет доступа|не найден|Недостаточно прав/.test(text);
  check('viewer: draft scenario is read-only or denied by server with a clear state', readOnly || denied, { apiStatus: scenarioStatus, readOnly, denied });
  await shot(vpage, 'scenario-viewer.png');
  await vctx.close();
}

await browser.close();
report.finishedAt = new Date().toISOString();
report.passed = report.checks.every((c) => c.pass);
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`\n${report.checks.filter((c) => c.pass).length}/${report.checks.length} checks passed`);
process.exit(report.passed ? 0 : 1);
