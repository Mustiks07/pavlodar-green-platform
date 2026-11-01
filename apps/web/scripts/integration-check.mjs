// Live integration checkpoint against the real foundation API (TEAM_PROTOCOL §8:
// "auth + город + источник данных из API в UI"). Requires GPT's local stack and the
// web dev server. Signs in through the local test Keycloak with synthetic test users.
//
//   PG_TEST_CREDENTIALS=<path to ignored .local/test-credentials.json> npm run integration
//
// Credentials are read from the ignored local file at runtime and never logged or saved.
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5173';
const OUT = resolve('../../docs/evidence/wp02-integration');
const credsPath = process.env.PG_TEST_CREDENTIALS;
if (!credsPath) {
  console.error('Set PG_TEST_CREDENTIALS to the local test-credentials.json path.');
  process.exit(2);
}
const creds = JSON.parse(readFileSync(credsPath, 'utf8'));
mkdirSync(OUT, { recursive: true });

const report = { base: BASE, startedAt: new Date().toISOString(), api: null, checks: [], shots: [] };
const check = (name, pass, detail) => {
  report.checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
};
const shot = async (page, file) => {
  await page.screenshot({ path: join(OUT, file) });
  report.shots.push(`docs/evidence/wp02-integration/${file}`);
};
const settle = (page) =>
  page.waitForFunction(() => !document.querySelector('.pg-state .pg-spinner, .app-list__loading'), null, { timeout: 15_000 }).catch(() => {});

const browser = await chromium.launch({ channel: process.env.PG_BROWSER_CHANNEL ?? 'msedge' });

for (const role of ['viewer', 'specialist']) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ru-RU' });
  const page = await ctx.newPage();
  const apiErrors = [];
  page.on('response', (r) => {
    if (r.url().includes('/v1/') && r.status() >= 500) apiErrors.push(`${r.status()} ${new URL(r.url()).pathname}`);
  });

  // Deep link before login: must come back to the same page with the filter.
  await page.goto(`${BASE}/sources`);
  await settle(page);
  const loginBtn = page.getByRole('button', { name: 'Войти через корпоративную учётную запись' }).first();
  await loginBtn.waitFor({ state: 'visible', timeout: 15_000 });
  await Promise.all([
    page.waitForURL(/realms\/.+\/protocol\/openid-connect\/auth/, { timeout: 20_000, waitUntil: 'commit' }),
    loginBtn.click(),
  ]).catch(async (e) => {
    await shot(page, `login-failed-${role}.png`);
    console.log('URL at failure:', page.url(), (await page.locator('main').innerText()).slice(0, 400));
    throw e;
  });
  await page.waitForSelector('#username', { timeout: 15_000 });
  await page.fill('#username', role);
  await page.fill('#password', creds[role]);
  await page.click('#kc-login');
  await page.waitForURL((u) => u.origin === new URL(BASE).origin && !u.pathname.startsWith('/auth/'), { timeout: 20_000, waitUntil: 'commit' });
  await settle(page);

  // The app restores the stored deep link once the session is confirmed.
  await page.waitForURL((u) => u.pathname === '/sources', { timeout: 8_000 }).catch(() => {});
  const me = await page.evaluate(async () => (await fetch('/v1/me')).json());
  check(`${role}: /v1/me after OIDC login`, Array.isArray(me.roles) && me.roles.includes(role), { roles: me.roles, cities: me.city_ids?.length });
  report.api ??= await page.evaluate(async () => (await fetch('/health/ready')).json());
  check(`${role}: deep link restored after login`, new URL(page.url()).pathname === '/sources', { url: page.url() });

  const cityParam = new URL(page.url()).searchParams.get('city');
  const cities = await page.evaluate(async () => (await fetch('/v1/cities')).json());
  const cityId = cityParam ?? cities.items?.[0]?.id;
  check(`${role}: city available from API`, Boolean(cityId), { count: cities.items?.length, name: cities.items?.[0]?.name });

  await page.goto(`${BASE}/sources${cityId ? `?city=${cityId}` : ''}`);
  await settle(page);
  const sidebarLinks = await page.locator('#app-nav .app-nav__link').allInnerTexts();
  const dataLinks = await page.locator('.app-data-nav a').allInnerTexts();
  check(`${role}: permanent navigation excludes task-only and administrative clutter`,
    !sidebarLinks.includes('Импорт данных') && !sidebarLinks.includes('Справочники') && !sidebarLinks.includes('Настройки'),
    { sidebarLinks });
  check(`${role}: data workspace exposes only role-appropriate task tabs`,
    dataLinks.includes('Данные и источники') && dataLinks.includes('Справочники') && (role === 'specialist' ? dataLinks.includes('Импорт данных') : !dataLinks.includes('Импорт данных')),
    { dataLinks });
  const sourcesText = await page.locator('main').innerText();
  const rows = await page.locator('.pg-table tbody tr[data-row-id]').count();
  check(`${role}: sources page renders API rows or an explicit empty state`, rows > 0 || sourcesText.includes('Наборов данных нет'), { rows });
  await shot(page, `sources-${role}.png`);
  if (rows > 0) {
    await page.locator('.pg-table tbody tr[data-row-id]').first().click();
    await page.waitForSelector('.app-split.is-open .pg-card', { timeout: 10_000 });
    await settle(page);
    const detail = await page.locator('.app-split .pg-card').innerText();
    check(`${role}: source detail shows owner, license and versions from API`, detail.includes('Лицензия') && detail.includes('Версии'));
    const selectedUrl = page.url();
    await page.reload();
    await page.waitForSelector('.app-split.is-open .pg-card', { timeout: 15_000 }).catch(() => {});
    check(`${role}: reload keeps selected source`, page.url() === selectedUrl && (await page.locator('.app-split.is-open .pg-card').count()) === 1, { url: page.url() });
    await shot(page, `sources-detail-${role}.png`);
  }

  await page.goto(`${BASE}/${cityId ? `?city=${cityId}` : ''}`);
  await settle(page);
  await page.waitForTimeout(1500);
  const hasBoundary = await page.evaluate(() => {
    const m = window.__pgMap;
    if (!m) return { error: 'no map handle' };
    const src = m.getSource('city-boundary');
    return {
      layers: m.getStyle().layers.map((l) => l.id),
      sourceLoaded: Boolean(src) && m.isSourceLoaded('city-boundary'),
      rendered: m.queryRenderedFeatures({ layers: ['city-boundary-line', 'city-boundary-fill'] }).length,
      bounds: m.getBounds().toArray(),
    };
  });
  check(`${role}: city boundary from API rendered on map`, (hasBoundary.rendered ?? 0) > 0, hasBoundary);
  const panel = await page.locator('aside').first().innerText().catch(() => '');
  check(`${role}: map shows city context panel from API`, panel.includes('Часовой пояс'), { boundaryCanvas: hasBoundary });
  // Presentation policy: the main map neither labels the working boundary as unverified nor claims it is official.
  check(`${role}: map panel has no unverified/official boundary label`, !/не подтвержд|официальн/i.test(panel), {});
  await shot(page, `map-${role}.png`);

  const urlBefore = page.url();
  await page.reload();
  await settle(page);
  await page.waitForTimeout(1200);
  const after = new URL(page.url());
  check(`${role}: reload keeps city and camera in URL`, after.searchParams.get('city') === cityId && after.searchParams.has('z'), {
    before: urlBefore,
    after: page.url(),
  });

  for (const path of ['/problems', '/catalog', '/projects', '/admin']) {
    await page.goto(`${BASE}${path}?city=${cityId}`);
    await settle(page);
    await shot(page, `${path.slice(1)}-${role}.png`);
    const text = await page.locator('main').innerText();
    // Not implemented foundation routes must surface a typed state, not a crash or a fake table.
    check(`${role}: ${path} renders a defined state`, /Загружено|Нет записей|нет|Нет доступа|не найден|недоступен|Не удалось|не поддерживает/i.test(text));
  }

  check(`${role}: no 5xx from API during session`, apiErrors.length === 0, apiErrors);
  await ctx.close();
}

await browser.close();
report.finishedAt = new Date().toISOString();
report.passed = report.checks.every((c) => c.pass);
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`\n${report.checks.filter((c) => c.pass).length}/${report.checks.length} checks passed`);
process.exit(report.passed ? 0 : 1);
