// Focused acceptance of the jury-facing "Демо 3 минуты" route on the real local API.
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionCookie } from './lib/session-login.mjs';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5173';
const CITY = process.env.PG_CITY_ID ?? '2de4e9e4-1602-5bdb-b17d-13df22510458';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/evidence/jury-demo-tour');
const credentialPath = process.env.PG_TEST_CREDENTIALS;
const credentials = credentialPath ? JSON.parse(readFileSync(credentialPath, 'utf8')) : null;
mkdirSync(OUT, { recursive: true });
const report = { base: BASE, city: CITY, startedAt: new Date().toISOString(), checks: [], shots: [] };
const check = (name, pass, detail) => {
  report.checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
};

const browser = await chromium.launch({ channel: process.env.PG_BROWSER_CHANNEL ?? 'msedge' });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'ru-RU' });
const page = await context.newPage();
if (!(await sessionCookie(context, 'specialist', BASE))) {
  if (!credentials?.specialist) throw new Error('PG_TEST_CREDENTIALS is required');
  await page.goto(`${BASE}/auth/login`);
  await page.waitForURL(/\/realms\/pavlodar-test\//, { timeout: 20_000 });
  await page.fill('#username', 'specialist');
  await page.fill('#password', credentials.specialist);
  await page.click('#kc-login');
  await page.waitForURL((url) => url.origin === new URL(BASE).origin && !url.pathname.startsWith('/auth/'), { timeout: 30_000 });
}
const serverErrors = [];
const pageErrors = [];
page.on('response', (response) => {
  const url = new URL(response.url());
  if (response.status() >= 500 && url.pathname.startsWith('/v1/')) serverErrors.push({ status: response.status(), path: url.pathname });
});
page.on('pageerror', (error) => pageErrors.push(String(error)));

await page.goto(`${BASE}/?city=${CITY}`);
await page.getByRole('button', { name: 'Демо 3 минуты' }).click();
const dialog = page.getByRole('dialog', { name: 'Маршрут показа · 3 минуты' });
await dialog.waitFor();
check('tour exposes the full seven-step decision story', await dialog.locator('.demo-tour__steps li').count() === 7);
const start = dialog.getByRole('button', { name: 'Начать показ' });
check('tour resolves exact existing demo objects before start', await start.isEnabled());
await page.screenshot({ path: join(OUT, '01-tour-ready.png') });
report.shots.push('docs/evidence/jury-demo-tour/01-tour-ready.png');

await start.click();
await page.waitForURL((url) => url.pathname === '/' && url.searchParams.has('zone'));
const selectedZone = new URL(page.url()).searchParams.get('zone');
await page.getByText('Шаг 1 из 7').waitFor();
const placementRow = page.locator('.map-insight-item').filter({ hasText: 'Предлагаемые посадки' });
await placementRow.waitFor({ timeout: 20_000 });
await page.waitForFunction(() => {
  const row = [...document.querySelectorAll('.map-insight-item')].find((item) => item.textContent?.includes('Предлагаемые посадки'));
  return row?.querySelector('input')?.disabled === false;
}, null, { timeout: 20_000 }).catch(() => {});
check('map step opens the exact zone and enables proposed plantings', Boolean(selectedZone) && await placementRow.locator('input').isEnabled(), { zone: selectedZone });

const next = () => page.getByRole('button', { name: 'Дальше' }).click();
await next();
await page.waitForURL((url) => url.pathname === '/problems' && url.searchParams.has('problem'));
check('problem step opens one exact active problem', new URL(page.url()).searchParams.has('problem'));

await next();
await page.waitForURL((url) => /^\/projects\/[^/]+$/.test(url.pathname) && url.searchParams.has('calc'));
const projectUrl = new URL(page.url());
check('project step is bound to exact revision and calculation', projectUrl.searchParams.has('revision') && projectUrl.searchParams.has('calc'));

await next();
await page.waitForURL((url) => url.pathname === '/compare' && (url.searchParams.get('revisions')?.split(',').length ?? 0) >= 2);
check('comparison step carries variants of the prepared territory', (new URL(page.url()).searchParams.get('revisions')?.split(',').length ?? 0) === 3);

await next();
await page.waitForURL((url) => url.pathname === '/program' && url.searchParams.has('selected') && url.searchParams.has('revision'));
check('program step opens the existing optimized revision', new URL(page.url()).searchParams.has('revision'));

await next();
await page.waitForURL((url) => url.pathname === '/execution');
check('execution step keeps the guided route visible', await page.getByText('Шаг 6 из 7').isVisible());

await next();
await page.waitForURL((url) => /^\/projects\/[^/]+$/.test(url.pathname) && url.searchParams.has('calc'));
const finalCalculation = new URL(page.url()).searchParams.get('calc');
check('final report step returns to the same exact calculation', finalCalculation === projectUrl.searchParams.get('calc'), { calculation: finalCalculation });
await page.getByText('Вариант B · экономия воды', { exact: false }).first().waitFor({ timeout: 20_000 });
await page.waitForFunction(() => !document.querySelector('main .pg-skeleton'), null, { timeout: 20_000 }).catch(() => {});
await page.screenshot({ path: join(OUT, '07-exact-report-step.png') });
report.shots.push('docs/evidence/jury-demo-tour/07-exact-report-step.png');

await page.reload();
await page.getByText('Шаг 7 из 7').waitFor();
check('current step survives reload', await page.getByText('Шаг 7 из 7').isVisible());
check('tour produced no API 5xx or page errors', serverErrors.length === 0 && pageErrors.length === 0, { serverErrors, pageErrors });

await context.close();
await browser.close();
report.finishedAt = new Date().toISOString();
report.passed = report.checks.every((item) => item.pass);
writeFileSync(join(OUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n${report.checks.filter((item) => item.pass).length}/${report.checks.length} checks passed`);
process.exit(report.passed ? 0 : 1);
