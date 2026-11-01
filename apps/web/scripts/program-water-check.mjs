// Read-only live acceptance for the required resource what-if: changing available water produces
// a different immutable optimizer portfolio and the UI explains the exact project delta.
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5173';
const credentialsPath = process.env.PG_TEST_CREDENTIALS;
if (!credentialsPath) throw new Error('PG_TEST_CREDENTIALS is required');
const credentials = JSON.parse(readFileSync(credentialsPath, 'utf8'));
const out = resolve('../../docs/evidence/jury-program-water');
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
await page.locator('#username').fill('specialist');
await page.locator('#password').fill(credentials.specialist);
await page.locator('#kc-login').click();
await page.waitForURL((url) => url.origin === new URL(BASE).origin && !url.pathname.startsWith('/auth/'), { timeout: 25_000 });
const city = await page.evaluate(async () => (await fetch('/v1/cities')).json()).then((value) => value.items[0]);
await page.goto(`${BASE}/program?city=${city.id}`);
await page.locator('.app-list tbody tr').first().click();
const whatIf = page.locator('.program-whatif');
await whatIf.locator('.program-whatif__water').waitFor({ timeout: 90_000 });
const text = await whatIf.innerText();
const changedProjects = await whatIf.locator('.program-whatif__changes li').count();
await whatIf.screenshot({ path: resolve(out, 'program-water-whatif.png') });
await browser.close();

const normalized = text.replace(/\s/g, '').toLocaleLowerCase('ru-RU');
const passed = normalized.includes('7,0м³')
  && normalized.includes('12,0м³')
  && normalized.includes('серверзанововыбрал')
  && changedProjects > 0
  && apiErrors.length === 0
  && pageErrors.length === 0;
console.log(JSON.stringify({ passed, changedProjects, apiErrors, pageErrors }));
process.exit(passed ? 0 : 1);
