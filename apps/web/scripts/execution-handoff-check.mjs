import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5173';
const CITY = process.env.PG_CITY_ID ?? '2de4e9e4-1602-5bdb-b17d-13df22510458';
const credentialPath = process.env.PG_TEST_CREDENTIALS;
if (!credentialPath) throw new Error('Set PG_TEST_CREDENTIALS to an ignored local credentials file');
const credentials = JSON.parse(readFileSync(credentialPath, 'utf8'));
const output = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/evidence/jury-execution-handoff');
mkdirSync(output, { recursive: true });

const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass, ...(detail === undefined ? {} : { detail }) });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`);
};
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'ru-RU' });
const page = await context.newPage();
const serverErrors = [];
page.on('response', (response) => {
  if (response.status() >= 500 && new URL(response.url()).pathname.startsWith('/v1/')) {
    serverErrors.push({ status: response.status(), url: response.url() });
  }
});

try {
  await page.goto(`${BASE}/auth/login`, { waitUntil: 'commit' });
  await page.waitForURL(/openid-connect\/auth/, { waitUntil: 'commit' });
  await page.fill('#username', 'specialist');
  await page.fill('#password', credentials.specialist);
  await page.click('#kc-login');
  await page.waitForURL((url) => url.origin === new URL(BASE).origin && !url.pathname.startsWith('/auth/'), { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await page.waitForFunction(() => fetch('/v1/me').then((response) => response.ok).catch(() => false), null, { timeout: 20_000 });
  await page.goto(`${BASE}/execution?city=${CITY}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Уход и исполнение' }).waitFor({ timeout: 30_000 });
  const queue = page.locator('.program-launch-passport');
  await queue.getByRole('heading', { name: 'Три проекта готовы к внутреннему согласованию' }).waitFor({ timeout: 30_000 });
  const cards = queue.locator('.program-launch-passport__grid > article');
  check('three exact program projects form the handoff queue', await cards.count() === 3);
  check('each project has a direct approval route', await queue.getByRole('link', { name: 'Открыть проект и согласовать' }).count() === 3);
  const queueText = await queue.innerText();
  check('queue exposes exact care resources and first period', queueText.includes('9,0 м³') && queueText.includes('19,5 ч') && queueText.includes('Май · 1-й год'), queueText);
  check('empty execution advertising and zero KPI cards are absent', await page.locator('.execution-visual, .app-overview, #exec-orders-h, #exec-cohorts-h').count() === 0);
  check('screen explains the real approval gate', await page.getByText('Согласуйте один из рассчитанных проектов выше').count() === 1);
  check('no API 5xx occurred', serverErrors.length === 0, serverErrors);
  await page.screenshot({ path: resolve(output, 'execution-handoff-queue.png'), fullPage: true });
} finally {
  await context.close();
  await browser.close();
}

const report = { base: BASE, city: CITY, checks, passed: checks.every((item) => item.pass), screenshot: 'docs/evidence/jury-execution-handoff/execution-handoff-queue.png' };
writeFileSync(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`${checks.filter((item) => item.pass).length}/${checks.length} checks passed`);
process.exit(report.passed ? 0 : 1);
