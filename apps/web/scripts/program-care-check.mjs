// Read-only live acceptance for the jury path: optimized city portfolio -> frozen care calendar.
//
//   PG_TEST_CREDENTIALS=../../.local/test-credentials.json node scripts/program-care-check.mjs
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5173';
const credentialsPath = process.env.PG_TEST_CREDENTIALS;
if (!credentialsPath) throw new Error('PG_TEST_CREDENTIALS is required');
const credentials = JSON.parse(readFileSync(credentialsPath, 'utf8'));
const out = resolve('../../docs/evidence/jury-program-care');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: process.env.PG_BROWSER_CHANNEL ?? 'msedge' });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'ru-RU' });
const page = await context.newPage();
const apiErrors = [];
const pageErrors = [];
page.on('response', (response) => {
  if (response.url().includes('/v1/') && response.status() >= 500) apiErrors.push(`${response.status()} ${new URL(response.url()).pathname}`);
});
page.on('pageerror', (error) => pageErrors.push(String(error)));

await page.goto(`${BASE}/auth/login`);
await page.locator('#username').waitFor({ timeout: 20_000 });
await page.locator('#username').fill('specialist');
await page.locator('#password').fill(credentials.specialist);
await page.locator('#kc-login').click();
await page.waitForURL((url) => url.origin === new URL(BASE).origin && !url.pathname.startsWith('/auth/'), { timeout: 25_000 });
const city = await page.evaluate(async () => (await fetch('/v1/cities')).json()).then((value) => value.items[0]);
await page.goto(`${BASE}/execution?city=${city.id}`);
const plan = page.locator('.program-care-plan');
await plan.getByRole('heading', { name: 'Уход за выбранной программой' }).waitFor({ timeout: 30_000 }).catch(async (error) => {
  await page.screenshot({ path: resolve(out, 'program-care-failed.png'), fullPage: true });
  console.error(JSON.stringify({ url: page.url(), main: (await page.locator('main').innerText().catch(() => '')).slice(0, 2000) }));
  throw error;
});
await plan.locator('.program-care-plan__timeline > article').first().waitFor({ timeout: 30_000 });
const metrics = await plan.locator('.program-care-plan__metrics article').count();
const periods = await plan.locator('.program-care-plan__timeline > article').count();
const operations = await plan.locator('.program-care-plan__timeline li').count();
const text = await plan.innerText();
const normalized = text.toLocaleLowerCase('ru-RU');
await plan.screenshot({ path: resolve(out, 'program-care-plan.png') });
await browser.close();

const passed = metrics === 5
  && periods > 0
  && operations > 0
  && normalized.includes('ещё не передан в работу')
  && normalized.includes('воды по плану')
  && apiErrors.length === 0
  && pageErrors.length === 0;
console.log(JSON.stringify({ passed, metrics, periods, operations, apiErrors, pageErrors }));
process.exit(passed ? 0 : 1);
