// Visual acceptance of the demo contour on the running stand (tools/dev/demo_bootstrap.py), read-only,
// as viewer, specialist and admin: the 9 DR-02 catalog plants, the 3 demo zones on the map, the 6
// draft variants for specialists (hidden from viewers by the server), a comparison of two variants
// with partial server calculations, and the explained empty states of program and execution with a
// link to the projects. No API mocks; every number on screen comes from the server.
//
//   PG_TEST_CREDENTIALS=<path> PG_CITY_ID=<uuid> node scripts/demo-contour-check.mjs
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sessionCookie } from './lib/session-login.mjs';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5173';
const CITY = process.env.PG_CITY_ID ?? '2de4e9e4-1602-5bdb-b17d-13df22510458';
const OUT = resolve('../../docs/evidence/demo-contour');
const creds = process.env.PG_TEST_CREDENTIALS ? JSON.parse(readFileSync(process.env.PG_TEST_CREDENTIALS, 'utf8')) : null;
mkdirSync(OUT, { recursive: true });
const report = { base: BASE, city: CITY, startedAt: new Date().toISOString(), checks: [], shots: [] };
const check = (name, pass, detail) => {
  report.checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
};
const DEMO_PLANTS = ['Populus alba', 'Pinus sylvestris', 'Tilia cordata', 'Syringa vulgaris', 'Picea obovata', 'Ricinus communis', 'Salix sp.', 'Acer sp.', 'Fraxinus sp.'];

async function signIn(browser, role) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ru-RU' });
  const page = await ctx.newPage();
  if (!(await sessionCookie(ctx, role, BASE))) {
    await page.goto(BASE + '/');
    const btn = page.getByRole('button', { name: 'Войти через корпоративную учётную запись' }).first();
    await btn.waitFor({ timeout: 20_000 });
    await Promise.all([page.waitForURL(/openid-connect\/auth/, { waitUntil: 'commit', timeout: 20_000 }), btn.click()]);
    await page.fill('#username', role);
    await page.fill('#password', creds[role]);
    await page.click('#kc-login');
    // The OIDC callback may land on the allow-listed dev origin; the session cookie is host-scoped
  // (localhost), so the check continues on BASE.
  await page.waitForURL((u) => u.hostname === 'localhost' && !u.pathname.startsWith('/auth/') && !u.pathname.includes('openid-connect'), { waitUntil: 'commit', timeout: 20_000 });
  if (new URL(page.url()).origin !== new URL(BASE).origin) await page.goto(BASE + '/');
  }
  const failures = [];
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (r.status() >= 500 && u.pathname.startsWith('/v1/')) failures.push({ status: r.status(), path: u.pathname });
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  return { ctx, page, failures, errors };
}
const api = (page, path) => page.evaluate(async (p) => { const r = await fetch(p); return { status: r.status, body: await r.json().catch(() => null) }; }, path);
const settle = (page) => page.waitForFunction(() => !document.querySelector('.pg-state .pg-spinner, .pg-skeleton'), null, { timeout: 20_000 }).catch(() => {});
const go = async (page, path) => {
  await page.goto(BASE + path);
  await page.waitForTimeout(1200);
  await settle(page);
};

const browser = await chromium.launch({ channel: process.env.PG_BROWSER_CHANNEL ?? 'msedge' });
for (const role of ['viewer', 'specialist', 'admin']) {
  const s = await signIn(browser, role);
  const { page } = s;
  const shot = async (name) => {
    await page.screenshot({ path: join(OUT, `${role}-${name}.png`) });
    report.shots.push(`docs/evidence/demo-contour/${role}-${name}.png`);
  };

  await go(page, `/catalog?city=${CITY}`);
  const catalogText = await page.locator('main').innerText();
  const plants = ((await api(page, '/v1/plants?limit=200')).body?.items ?? []).filter((p) => DEMO_PLANTS.includes(p.latin_name));
  check(`${role}: catalog shows the 9 DR-02 plants with Russian and Latin names`, plants.length === 9 && plants.every((p) => catalogText.includes(p.russian_name) && catalogText.includes(p.latin_name)), { plants: plants.length });
  await shot('catalog');

  const zones = ((await api(page, `/v1/zones?city_id=${CITY}&limit=200`)).body?.items ?? []).filter((z) => z.name.startsWith('Демо-участок'));
  await go(page, `/?city=${CITY}&zone=${zones[0]?.id ?? ''}`);
  await page.locator('.zone-card, .pg-panel').first().waitFor({ timeout: 20_000 }).catch(() => {});
  const mapText = await page.locator('main').innerText();
  check(`${role}: the 3 demo zones are on the map and open their card`, zones.length === 3 && mapText.includes(zones[0].name), { zones: zones.map((z) => z.name) });
  await shot('map-zone');

  const scenarios = ((await api(page, `/v1/scenarios?city_id=${CITY}&limit=200`)).body?.items ?? []).filter((x) => x.name.startsWith('Вариант') && zones.some((z) => z.id === x.zone_id));
  await go(page, `/projects?city=${CITY}`);
  const projectsText = await page.locator('main').innerText();
  if (role === 'viewer') {
    check('viewer: draft variants stay hidden (server rule); the projects page does not fail', scenarios.length === 0 && projectsText.length > 0, { scenarios: scenarios.length });
  } else {
    check(`${role}: 6 draft demo variants listed`, scenarios.length === 6 && scenarios.every((x) => x.status === 'draft') && (projectsText.match(/Вариант [AB]/g) ?? []).length >= 6, { scenarios: scenarios.length });
    const calcs = [];
    for (const x of scenarios) {
      const c = (await api(page, `/v1/calculations?scenario_revision_id=${x.current_revision_id}&limit=50`)).body?.items ?? [];
      calcs.push(c[0]?.status ?? null);
    }
    check(`${role}: every variant has a server calculation, all honestly partial`, calcs.length === 6 && calcs.every((c) => c === 'partial'), calcs);
    const pair = scenarios.filter((x) => x.zone_id === zones[0].id).slice(0, 2);
    // compareScenarios is a POST: the API accepts mutations only from its public origin (:5173).
    const publicOrigin = (await api(page, '/v1/me')).body && new URL(BASE).port === '5173';
    if (!publicOrigin) {
      report.checks.push({ name: `${role}: comparison`, pass: true, skipped: 'not run from a non-public origin (POST compareScenarios is origin-checked)' });
      console.log(`SKIP ${role}: comparison — POST compareScenarios needs the public origin :5173`);
    } else {
    await go(page, `/compare?city=${CITY}&revisions=${pair.map((x) => x.current_revision_id).join(',')}`);
    await page.getByText('Сравнение снимков').first().waitFor({ timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const compareText = await page.locator('main').innerText();
    check(`${role}: comparing A and B shows both partial calculations side by side`, pair.length === 2 && compareText.includes('Вариант A') && compareText.includes('Вариант B') && /частичн/i.test(compareText), { pair: pair.map((x) => x.name) });
    await shot('compare');
    }
  }

  await go(page, `/program?city=${CITY}`);
  const programText = await page.locator('main').innerText();
  const programLink = await page.getByRole('link', { name: 'Открыть проекты участков' }).count();
  check(`${role}: empty program explains budget and full calculation, links to projects`, programText.includes('капитальный бюджет') && programText.includes('полным расчётом') && programLink >= 1, { programLink });
  await shot('program');

  await go(page, `/execution?city=${CITY}`);
  const executionText = await page.locator('main').innerText();
  const executionLink = await page.getByRole('link', { name: 'Открыть проекты участков' }).count();
  check(`${role}: empty execution explains approval and full calculation, links to projects`, executionText.includes('утверждённому сценарию') && executionText.includes('полного расчёта') && executionLink >= 1, { executionLink });
  await shot('execution');

  check(`${role}: no 5xx and no page errors`, s.failures.length === 0 && s.errors.length === 0, { failures: s.failures.slice(0, 3), errors: s.errors.slice(0, 2) });
  await s.ctx.close();
}
await browser.close();
report.finishedAt = new Date().toISOString();
report.passed = report.checks.every((c) => c.pass);
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const run = report.checks.filter((c) => !c.skipped);
console.log(`\n${run.filter((c) => c.pass).length}/${run.length} checks passed, ${report.checks.length - run.length} skipped`);
process.exit(report.passed ? 0 : 1);
