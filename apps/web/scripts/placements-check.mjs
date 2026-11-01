// Live scenario placement editor journey on the real API (disposable environment): add on the
// plan, stable ids, drag, undo/redo, lock, keyboard nudge/delete, outside-zone warning, save
// as an immutable revision with If-Match, reload keeps the draft, 412 -> three-way merge by id
// with the collision listed, touch on a phone, dark theme. Creates only SYNTHETIC TEST data.
//
//   uv run python -m tools.dev.browser_test_env --cwd apps/web -- node scripts/placements-check.mjs
import { chromium } from '@playwright/test';
import { sessionCookie } from './lib/session-login.mjs';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5173';
const OUT = resolve('../../docs/evidence/wp06-placements');
const creds = JSON.parse(readFileSync(process.env.PG_TEST_CREDENTIALS ?? '', 'utf8'));
mkdirSync(OUT, { recursive: true });

const report = { base: BASE, startedAt: new Date().toISOString(), checks: [], shots: [] };
const check = (name, pass, detail) => {
  report.checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
};
const shot = async (page, file) => {
  await page.screenshot({ path: join(OUT, file), fullPage: false });
  report.shots.push(`docs/evidence/wp06-placements/${file}`);
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
const stamp = new Date().toISOString().slice(11, 19);

// Setup. A plant needs a trait sourced from a public published catalog dataset (server rule),
// so a SYNTHETIC catalog record is uploaded (specialist) and published (admin) first.
const FILES = mkdtempSync(join(tmpdir(), 'pg-placements-'));
const catFile = join(FILES, 'synthetic-catalog.geojson');
writeFileSync(catFile, JSON.stringify({ type: 'FeatureCollection', features: [
  { type: 'Feature', id: 'cat-1', properties: { name: 'SYNTHETIC catalog record' }, geometry: { type: 'Point', coordinates: [76.95, 52.29] } },
] }));
// A rule version comes from a published restrictions record of type rule_version.
const ruleId = crypto.randomUUID();
const pendingRuleId = crypto.randomUUID();
const ruleFile = join(FILES, 'synthetic-rule.geojson');
writeFileSync(ruleFile, JSON.stringify({ type: 'FeatureCollection', features: [
  { type: 'Feature', id: 'rule-1', geometry: { type: 'Point', coordinates: [76.95, 52.29] }, properties: {
    record_type: 'rule_version', id: ruleId, act_number: 'SYNTHETIC-ACT-1', clause: '1', revision_date: '2026-01-01', parameter: 'synthetic_spacing',
    value: 1.5, unit: 'm', applicability: 'SYNTHETIC TEST only', condition: null, review_status: 'expert_confirmed', source_status: 'synthetic', superseded_by: null } },
  // Listed but not selectable: it still needs an expert.
  { type: 'Feature', id: 'rule-2', geometry: { type: 'Point', coordinates: [76.95, 52.29] }, properties: {
    record_type: 'rule_version', id: pendingRuleId, act_number: 'SYNTHETIC-ACT-2', clause: '2', revision_date: '2026-01-01', parameter: 'synthetic_pending',
    value: 2, unit: 'm', applicability: 'SYNTHETIC TEST only', condition: null, review_status: 'verified_text_requires_expert', source_status: 'synthetic', superseded_by: null } },
] }));
const sp0 = await login(browser, 'specialist');
const cityId0 = (await sp0.page.evaluate(async () => (await fetch('/v1/cities')).json())).items[0].id;
async function uploadDataset(name, kind, file, pg = sp0.page) {
  await pg.goto(`${BASE}/imports?city=${cityId0}`);
  await settle(pg);
  await pg.getByRole('button', { name: 'Создать набор данных' }).click();
  await pg.getByLabel(/^Название/).fill(name);
  await pg.getByLabel('Тип', { exact: true }).selectOption(kind);
  await pg.getByLabel('Владелец').fill('SYNTHETIC integration test');
  await pg.getByLabel('Лицензия').fill('CC0-1.0');
  await pg.getByLabel('Доступ', { exact: true }).selectOption('public');
  await pg.getByRole('button', { name: 'Создать набор', exact: true }).click();
  await pg.waitForFunction((n) => [...document.querySelectorAll('select option:checked')].some((o) => o.textContent?.includes(n)), name, { timeout: 15_000 });
  const datasetId = await pg.evaluate((n) => [...document.querySelectorAll('select option')].find((o) => o.textContent?.includes(n))?.value, name);
  await pg.locator('input[type=file]').setInputFiles(file);
  await pg.getByLabel('Метод получения данных').fill(`SYNTHETIC TEST ${kind}`);
  await pg.getByRole('button', { name: 'Загрузить и проверить' }).click();
  await pg.waitForURL(/[?&]job=/, { timeout: 60_000 });
  await pg.getByText('Проверка завершена').waitFor({ timeout: 90_000 });
  const job = await pg.evaluate(async (id) => (await fetch(`/v1/jobs/${id}`)).json(), new URL(pg.url()).searchParams.get('job'));
  return { datasetId, versionId: job.result_ref_id };
}
const catName = `SYNTHETIC TEST каталог ${stamp}`;
const cat = await uploadDataset(catName, 'catalog', catFile);
const rules = await uploadDataset(`SYNTHETIC TEST правила ${stamp}`, 'restrictions', ruleFile);
const catVersion = cat.versionId;
await sp0.ctx.close();

const admin = await login(browser, 'admin');
async function publish({ datasetId, versionId }) {
  await admin.page.goto(`${BASE}/imports?city=${cityId0}&selected=${datasetId}`);
  await admin.page.waitForSelector('.app-split.is-open .pg-card', { timeout: 20_000 });
  await settle(admin.page);
  await admin.page.locator('.app-versions > li').filter({ hasText: versionId.slice(0, 8) }).getByRole('button', { name: 'Опубликовать версию…' }).click();
  await admin.page.locator('dialog[open]').getByLabel('Причина решения').fill('SYNTHETIC TEST: реестр для посадок');
  await admin.page.locator('dialog[open]').getByRole('button', { name: 'Опубликовать', exact: true }).click();
  await admin.page.locator('dialog[open]').waitFor({ state: 'detached', timeout: 20_000 }).catch(() => {});
}
for (const ds of [cat, rules]) await publish(ds);
const ruleStatus = await admin.page.evaluate(async (id) => (await fetch(`/v1/rule-versions/${id}`)).status, ruleId);
check('synthetic restrictions record promoted to an expert-confirmed rule version (setup)', ruleStatus === 200, { ruleStatus });
const plantBody = (n) => ({
  latin_name: `Synthetica testii ${n} ${stamp}`, russian_name: `SYNTHETIC растение ${n} ${stamp}`, cultivar: null, stratum: 'tree',
  traits: [{ key: 'synthetic_note', value_text: 'SYNTHETIC TEST', value_number: null, unit: null, status: 'known', source_refs: [{ dataset_version_id: catVersion, source_record_id: 'cat-1', label: catName, uri: null }] }],
  allergy_risk: 'unknown', toxicity_risk: 'unknown', expert_status: 'pending', taxon_rank: 'species', local_evidence: null,
  sensitive_site_status: 'allowed', exclusion_reason: null, exclusion_basis: null, review_reasons: [],
});
const pl1 = await apiCall(admin.page, 'POST', '/v1/plants', plantBody('A'));
const pl2 = await apiCall(admin.page, 'POST', '/v1/plants', plantBody('B'));
check('synthetic catalog published and two plants created (setup)', pl1.status === 201 && pl2.status === 201, { s: [pl1.status, pl2.status], e: pl1.status === 201 ? undefined : pl1.body });
if (pl1.status !== 201) { await browser.close(); process.exit(1); }
// SYNTHETIC stock of plant A: unknown (null), zero and five pieces are different facts.
const stockBase = {
  record_type: 'stock_item', plant_id: pl1.body.id, supplier: 'SYNTHETIC TEST питомник', size_description: 'SYNTHETIC TEST контейнер',
  currency: 'KZT', observed_at: '2026-10-30T00:00:00Z', supplier_city: 'Павлодар', is_local_supply: true, height_min_m: 1.0, height_max_m: 1.5,
  container: 'C10', root_system: 'container', tax_mode: 'included', applicability: 'SYNTHETIC TEST only',
};
const stockFile = join(FILES, 'synthetic-stock.geojson');
writeFileSync(stockFile, JSON.stringify({ type: 'FeatureCollection', features: [
  { id: 'stock-unknown', available_quantity: null, unit_price: '1000.00', availability: 'listing_only', stock_counted_at: null, checked_at: '2026-10-30' },
  { id: 'stock-zero', available_quantity: 0, unit_price: null, availability: 'not_in_stock', stock_counted_at: '2026-10-30', checked_at: '2026-10-30' },
  { id: 'stock-five', available_quantity: 5, unit_price: '1200.00', availability: 'in_stock', stock_counted_at: '2026-10-30', checked_at: '2026-10-30' },
].map(({ id, ...p }) => ({ type: 'Feature', id, geometry: { type: 'Point', coordinates: [76.95, 52.29] }, properties: { ...stockBase, ...p } })) }));
await publish(await uploadDataset(`SYNTHETIC TEST склад ${stamp}`, 'stock', stockFile, admin.page));
const stockItems = (await admin.page.evaluate(async (id) => (await fetch(`/v1/stock?plant_id=${id}`)).json(), pl1.body.id)).items ?? [];
check('synthetic stock published: null, 0 and 5 kept apart (setup)', stockItems.length === 3, { n: stockItems.length });
await admin.ctx.close();

const { ctx, page } = await login(browser, 'specialist');
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
const city = (await page.evaluate(async () => (await fetch('/v1/cities')).json())).items[0];
const ring = city.boundary.type === 'Polygon' ? city.boundary.coordinates[0] : city.boundary.coordinates[0][0];
const cx = (Math.min(...ring.map((c) => c[0])) + Math.max(...ring.map((c) => c[0]))) / 2 - 0.01;
const cy = (Math.min(...ring.map((c) => c[1])) + Math.max(...ring.map((c) => c[1]))) / 2 - 0.01;
const d = 0.0015;
const zone = await apiCall(page, 'POST', '/v1/zones', {
  city_id: city.id, name: `SYNTHETIC TEST посадки ${stamp}`, purpose: 'square',
  geometry: { type: 'Polygon', coordinates: [[[cx - d, cy - d], [cx + d, cy - d], [cx + d, cy + d], [cx - d, cy + d], [cx - d, cy - d]]] },
});
const sc = await apiCall(page, 'POST', '/v1/scenarios', {
  city_id: city.id, zone_id: zone.body?.id, name: `SYNTHETIC TEST посадки ${stamp}`, base_revision_id: null,
  initial_state: { zone_version_id: zone.body?.version_id, parent_revision_id: null, dataset_version_ids: [], catalog_version_id: null, rate_version_id: null,
    coefficient_version_id: null, rule_version_id: null, model_version_id: null, placements: [], area_patches: [], capital_budget: null,
    care_horizon_years: 3, resource_limits: [], excluded_plant_ids: [], diversity_caps: [], care_strategy: 'standard', custom_care_operations: [], comment: 'SYNTHETIC TEST' },
});
check('synthetic zone and empty draft scenario created (setup)', zone.status === 201 && sc.status === 201, { s: [zone.status, sc.status] });
const scenarioId = sc.body.id;

await page.goto(`${BASE}/projects/${scenarioId}?city=${city.id}`);
await page.waitForSelector('.pl-editor', { timeout: 20_000 });
await settle(page);
await page.waitForFunction(() => window.__pgPlacementMap?.getLayer('pl-circle'), null, { timeout: 20_000 });
const editor = page.locator('.pl-editor');
check('editor shows an empty state and the zone plan', (await editor.innerText()).includes('Посадок пока нет') && (await page.locator('.pl-map canvas').count()) === 1);

const px = (lng, lat) =>
  page.evaluate(([lng, lat]) => {
    const m = window.__pgPlacementMap;
    const p = m.project([lng, lat]);
    const r = m.getCanvas().getBoundingClientRect();
    return [r.left + p.x, r.top + p.y];
  }, [lng, lat]);
const draft = () => page.evaluate((id) => JSON.parse(localStorage.getItem(`pg.scenario-draft.${id}`) ?? 'null'), scenarioId);
const placements = async () => (await draft())?.edits?.placements ?? [];
const count = async () => Number((await editor.locator('[aria-live="polite"]').innerText()).match(/\d+/)?.[0] ?? -1);

// Add three placements on the plan.
await page.getByLabel('Поиск в каталоге').fill(`SYNTHETIC растение A ${stamp}`);
await page.waitForTimeout(700);
await page.locator('.pl-picker select').waitFor({ timeout: 15_000 });
await page.locator('.pl-picker select').selectOption(pl1.body.id);
await editor.getByLabel('Дата посадки').first().fill('2027-04-15');
await page.getByRole('button', { name: 'Ставить на плане' }).click();
await page.locator('.pl-map').scrollIntoViewIfNeeded();
for (const [dx, dy] of [[-0.0008, 0], [0, 0.0006], [0.0008, -0.0005]]) {
  await page.mouse.click(...(await px(cx + dx, cy + dy)));
  await page.waitForTimeout(250);
}
await page.getByRole('button', { name: 'Закончить расстановку' }).click();
const added = await placements();
const stockBox = page.locator('.pl-stock');
await stockBox.locator('.pg-offer').first().waitFor({ timeout: 15_000 }).catch(() => {});
const stockText = await stockBox.innerText().catch(() => '');
check('selected placement shows supplier offers: unknown stock is not zero, zero is explicit, no source line', /остаток неизвестен/.test(stockText) && /нет в наличии \(0\)/.test(stockText) && /налог включён/.test(stockText) && !/Источник/.test(stockText), stockText.slice(0, 300));
check('three placements added on the plan with fresh stable UUIDs', (await count()) === 3 && added.length === 3 && new Set(added.map((p) => p.id)).size === 3 && added.every((p) => /^[0-9a-f-]{36}$/.test(p.id) && p.plant_id === pl1.body.id && p.dimension_basis === 'unknown' && p.initial_height_m === null), added.map((p) => p.id.slice(0, 8)));

// Drag placement 1; undo/redo.
const [p1] = added;
const from = await px(...p1.position.coordinates);
await page.mouse.move(...from);
await page.mouse.down();
await page.mouse.move(from[0] + 40, from[1] + 25, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(300);
const afterDrag = (await placements()).find((p) => p.id === p1.id);
check('drag moves the placement and keeps its id', afterDrag && JSON.stringify(afterDrag.position) !== JSON.stringify(p1.position));
await page.getByRole('button', { name: 'Отменить', exact: true }).click();
const undone = (await placements()).find((p) => p.id === p1.id);
await page.getByRole('button', { name: 'Повторить', exact: true }).click();
const redone = (await placements()).find((p) => p.id === p1.id);
check('undo restores the position, redo re-applies it', JSON.stringify(undone?.position) === JSON.stringify(p1.position) && JSON.stringify(redone?.position) === JSON.stringify(afterDrag?.position));

// Select placement 2 in the table: quantity, lock; a locked placement does not drag.
await editor.locator('tr[data-row-id]').nth(1).click();
await page.getByLabel('Количество').fill('5');
await page.getByLabel('Закрепить — не двигать при правке и расчётах').check();
const p2 = (await placements())[1];
const at2 = await px(...p2.position.coordinates);
await page.mouse.move(...at2);
await page.mouse.down();
await page.mouse.move(at2[0] + 50, at2[1] + 30, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(300);
const p2b = (await placements())[1];
check('quantity and lock edited; a locked placement does not move', p2.quantity === 5 && p2.locked && JSON.stringify(p2b.position) === JSON.stringify(p2.position));

// Keyboard: select placement 3, nudge, delete, undo.
await editor.locator('tr[data-row-id]').nth(2).click();
const p3 = (await placements())[2];
await page.locator('.pl-map').focus();
await page.keyboard.press('ArrowRight');
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(200);
const p3b = (await placements()).find((p) => p.id === p3.id);
const dxPx = await page.evaluate(([a, b]) => Math.round(window.__pgPlacementMap.project(b).x - window.__pgPlacementMap.project(a).x), [p3.position.coordinates, p3b.position.coordinates]);
await page.keyboard.press('Delete');
await page.waitForTimeout(200);
const afterDel = await count();
await page.keyboard.press('Control+z');
await page.waitForTimeout(200);
check('keyboard: arrows nudge 5 px per press, Delete removes, Ctrl+Z restores', dxPx === 10 && afterDel === 2 && (await count()) === 3, { dxPx, afterDel });

// Outside the zone: warned before sending, then undone.
await page.getByRole('button', { name: 'Ставить на плане' }).click();
await page.mouse.click(...(await px(cx + d * 1.6, cy)));
await page.getByRole('button', { name: 'Закончить расстановку' }).click();
const outsideWarn = await page.getByText(/Посадок вне границ участка: 1/).isVisible().catch(() => false);
await shot(page, 'placements-outside-warning.png');
await page.getByRole('button', { name: 'Отменить', exact: true }).click();
check('a placement outside the zone is flagged before sending; undo removes it', outsideWarn && (await count()) === 3);
const editorText = await editor.innerText();
check('editor shows no money or survival numbers', !/₸|\d+\s?%/.test(editorText));

// Without a rule version the server would refuse placements: the form says so and blocks saving.
await page.getByLabel('Комментарий к ревизии').fill('SYNTHETIC TEST: посадки');
const blockedNoRule = await page.getByRole('button', { name: 'Сохранить новую ревизию' }).isDisabled();
const ruleMsg = await page.getByText('Для посадок сервер требует подтверждённую версию правил').isVisible().catch(() => false);
// Plants of the list carry the current catalog snapshot (each createPlant makes a new one).
const currentCatalog = (await page.evaluate(async (id) => (await fetch(`/v1/plants/${id}`)).json(), pl1.body.id)).version_id;
const catalogShown = (await editor.innerText()).includes(currentCatalog.slice(0, 8)) && (await draft())?.edits?.catalog_version_id === currentCatalog;
check('catalog version taken from the chosen plant; saving blocked until a rule version is set', blockedNoRule && ruleMsg && catalogShown, { blockedNoRule, ruleMsg, catalogShown });
// Rule picker (listRuleVersions): nothing preselected, the unusable rule is listed but disabled.
const picker = page.getByLabel(/^Версия правил размещения/);
await picker.locator(`option[value="${ruleId}"]`).waitFor({ state: 'attached', timeout: 15_000 });
const preselected = await picker.inputValue();
const pendingDisabled = await picker.locator(`option[value="${pendingRuleId}"]`).isDisabled();
const pendingLabel = await picker.locator(`option[value="${pendingRuleId}"]`).innerText();
check('rule picker: nothing preselected; rule needing an expert listed with status and not selectable', preselected === '' && pendingDisabled && /нужен эксперт/.test(pendingLabel), { preselected, pendingDisabled, pendingLabel });
await shot(page, 'placements-rule-picker.png');
await picker.selectOption(ruleId);
const ruleOk = await page.locator('.pl-rule__info').getByText('подтверждено экспертом').waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
const ruleAct = (await page.locator('.pl-rule__info').innerText()).includes('SYNTHETIC-ACT-1');
check('rule chosen from listRuleVersions: expert status and act shown, saving unblocked', ruleOk && ruleAct && !(await page.getByRole('button', { name: 'Сохранить новую ревизию' }).isDisabled()), { ruleOk, ruleAct });
// The verified id fallback stays available and checks the id with getRuleVersion.
await page.getByRole('button', { name: 'Ввести идентификатор вручную' }).click();
const manual = page.getByLabel(/^Идентификатор версии правил/);
check('manual id fallback shows the chosen id', (await manual.inputValue()) === ruleId);
// Save as a new immutable revision.
await page.getByRole('button', { name: 'Сохранить новую ревизию' }).click();
await page.waitForFunction((id) => localStorage.getItem(`pg.scenario-draft.${id}`) === null, scenarioId, { timeout: 20_000 }).catch(() => {});
const s1 = await page.evaluate(async (id) => (await fetch(`/v1/scenarios/${id}`)).json(), scenarioId);
const r1 = await page.evaluate(async (id) => (await fetch(`/v1/scenario-revisions/${id}`)).json(), s1.current_revision_id);
const ids = (await page.evaluate(async (id) => (await fetch(`/v1/scenario-revisions/${id}`)).json(), s1.current_revision_id)).placements.map((p) => p.id);
check('saved via If-Match as a new revision; server kept the client placement ids', r1.placements?.length === 3 && added.every((p) => ids.includes(p.id)) && r1.placements.find((p) => p.id === p2.id)?.locked === true, { n: r1.placements?.length, revision: s1.current_revision_id?.slice(0, 8) });
await shot(page, 'placements-saved.png');

// Reload keeps an unsaved edit.
await editor.locator('tr[data-row-id]').first().click();
await page.getByLabel('Количество').fill('7');
await page.reload();
await page.waitForSelector('.pl-editor', { timeout: 20_000 });
await settle(page);
const restored = await page.getByText('Восстановлены ваши несохранённые правки').isVisible().catch(() => false);
check('reload restores the unsaved placement edit (local draft)', restored && (await placements()).find((p) => p.id === p1.id)?.quantity === 7);

// 412: someone else adds a placement and edits placement 1 first.
const sNow = await page.evaluate(async (id) => {
  const r = await fetch(`/v1/scenarios/${id}`);
  return { etag: r.headers.get('ETag'), body: await r.json() };
}, scenarioId);
const cur = await page.evaluate(async (id) => (await fetch(`/v1/scenario-revisions/${id}`)).json(), sNow.body.current_revision_id);
const keys = ['zone_version_id', 'dataset_version_ids', 'catalog_version_id', 'rate_version_id', 'coefficient_version_id', 'rule_version_id', 'model_version_id', 'area_patches', 'capital_budget', 'care_horizon_years', 'resource_limits', 'excluded_plant_ids', 'diversity_caps', 'care_strategy', 'custom_care_operations'];
const theirsT = { ...cur.placements[0], id: crypto.randomUUID(), plant_id: pl2.body.id, position: { type: 'Point', coordinates: [cx - 0.001, cy - 0.001] }, quantity: 2, locked: false };
const other = await apiCall(page, 'POST', `/v1/scenarios/${scenarioId}/revisions`, {
  ...Object.fromEntries(keys.map((k) => [k, cur[k]])),
  parent_revision_id: cur.id,
  placements: [{ ...cur.placements.find((p) => p.id === p1.id), quantity: 9 }, ...cur.placements.filter((p) => p.id !== p1.id), theirsT],
  comment: 'SYNTHETIC TEST: параллельная правка',
}, { 'If-Match': sNow.etag });
check('concurrent revision accepted (setup)', other.status === 201, { status: other.status, body: other.status === 201 ? undefined : other.body });
await page.getByLabel('Комментарий к ревизии').fill('SYNTHETIC TEST: моё количество');
await page.getByRole('button', { name: 'Сохранить новую ревизию' }).click();
const conflictShown = await page.getByText('Сценарий изменён другим пользователем или вкладкой').waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
check('stale If-Match -> 412 explained; my draft kept', conflictShown && (await placements()).find((p) => p.id === p1.id)?.quantity === 7);
await shot(page, 'placements-conflict-412.png');
await page.getByRole('button', { name: 'Перенести мои правки на текущую ревизию' }).first().click();
const merged = await page.getByText(/Ваши правки посадок перенесены на ревизию/).waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
const mergeText = await page.locator('.pl-conflicts').innerText().catch(() => '');
const afterMerge = await placements();
check('three-way merge: their new placement kept, my edit wins on the shared one, the collision is listed', merged && afterMerge.length === 4 && afterMerge.some((p) => p.id === theirsT.id) && afterMerge.find((p) => p.id === p1.id)?.quantity === 7 && mergeText.includes(p1.id.slice(0, 8)) && /оставлена ваша версия/.test(mergeText), { n: afterMerge.length, mergeText });
await shot(page, 'placements-merged.png');
await page.getByRole('button', { name: 'Сохранить новую ревизию' }).click();
await page.waitForFunction((id) => localStorage.getItem(`pg.scenario-draft.${id}`) === null, scenarioId, { timeout: 20_000 }).catch(() => {});
const s2 = await page.evaluate(async (id) => (await fetch(`/v1/scenarios/${id}`)).json(), scenarioId);
const r2 = await page.evaluate(async (id) => (await fetch(`/v1/scenario-revisions/${id}`)).json(), s2.current_revision_id);
check('merged revision saved: 4 placements, theirs included, my quantity on placement 1', r2.placements?.length === 4 && r2.placements.some((p) => p.id === theirsT.id) && r2.placements.find((p) => p.id === p1.id)?.quantity === 7 && r2.parent_revision_id === other.body.id, { n: r2.placements?.length });

await page.emulateMedia({ colorScheme: 'dark' });
await page.locator('.pl-editor').scrollIntoViewIfNeeded();
await page.waitForTimeout(500);
await shot(page, 'placements-dark.png');
check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3));
await ctx.close();

// Phone with touch: tap adds, finger drag moves.
const phone = await login(browser, 'specialist', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
const pp = phone.page;
const cdp = await phone.ctx.newCDPSession(pp);
await pp.goto(`${BASE}/projects/${scenarioId}?city=${city.id}`);
await pp.waitForFunction(() => window.__pgPlacementMap?.getLayer('pl-circle'), null, { timeout: 20_000 });
await pp.locator('.pl-map').scrollIntoViewIfNeeded();
await pp.waitForTimeout(600);
const ppx = (lng, lat) => pp.evaluate(([lng, lat]) => {
  const m = window.__pgPlacementMap;
  const p = m.project([lng, lat]);
  const r = m.getCanvas().getBoundingClientRect();
  return [r.left + p.x, r.top + p.y];
}, [lng, lat]);
const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
const pDraft = async () => (await pp.evaluate((id) => JSON.parse(localStorage.getItem(`pg.scenario-draft.${id}`) ?? 'null'), scenarioId))?.edits?.placements ?? null;
const unlocked = r2.placements.find((p) => !p.locked && p.id !== theirsT.id);
const s0 = await ppx(...unlocked.position.coordinates);
await touch('touchStart', [s0]);
for (let i = 1; i <= 10; i++) {
  await touch('touchMove', [[s0[0] + i * 3, s0[1] + i * 2]]);
  await pp.waitForTimeout(16);
}
await touch('touchEnd', []);
await pp.waitForTimeout(500);
const movedByFinger = (await pDraft())?.find((p) => p.id === unlocked.id);
check('phone: finger drag moves an unlocked placement (draft), id unchanged', Boolean(movedByFinger) && JSON.stringify(movedByFinger.position) !== JSON.stringify(unlocked.position));
await shot(pp, 'placements-mobile.png');
const pb = await pp.locator('.pl-editor').boundingBox();
check('phone: editor fits the viewport width', Boolean(pb) && pb.x >= 0 && pb.x + pb.width <= 391, pb);
await phone.ctx.close();

await browser.close();
report.finishedAt = new Date().toISOString();
report.passed = report.checks.every((c) => c.pass);
report.synthetic = { scenario: scenarioId, zone: zone.body?.id, plants: [pl1.body?.id, pl2.body?.id] };
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`\n${report.checks.filter((c) => c.pass).length}/${report.checks.length} checks passed`);
process.exit(report.passed ? 0 : 1);
