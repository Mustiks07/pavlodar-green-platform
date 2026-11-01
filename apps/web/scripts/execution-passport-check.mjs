// Read-only proof that the selected immutable city program becomes a concrete launch passport.
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5173';
const credentials = JSON.parse(readFileSync(process.env.PG_TEST_CREDENTIALS ?? '', 'utf8'));
const out = resolve('../../docs/evidence/jury-execution-passport');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PG_BROWSER_CHANNEL ?? 'msedge' });
const context = await browser.newContext({ viewport: { width: 1680, height: 1050 }, locale: 'ru-RU' });
const page = await context.newPage();
const apiErrors = [];
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));
page.on('response', (response) => {
  if (response.url().includes('/v1/') && response.status() >= 500) apiErrors.push(`${response.status()} ${new URL(response.url()).pathname}`);
});

await page.goto(`${BASE}/auth/login`);
await page.locator('#username').fill('specialist');
await page.locator('#password').fill(credentials.specialist);
await page.locator('#kc-login').click();
await page.waitForURL((url) => url.origin === new URL(BASE).origin && !url.pathname.startsWith('/auth/'), { timeout: 25_000 });
const city = await page.evaluate(async () => (await (await fetch('/v1/cities')).json()).items[0]);
await page.goto(`${BASE}/execution?city=${city.id}`);
const passport = page.locator('.program-launch-passport');
await passport.waitFor({ timeout: 30_000 });
const cards = passport.locator('.program-launch-passport__grid > article');
await cards.first().waitFor();
const cardCount = await cards.count();
const text = await passport.innerText();
const operations = await cards.locator('dt', { hasText: 'Операции' }).count();
await passport.scrollIntoViewIfNeeded();
await page.waitForTimeout(300);
await passport.screenshot({ path: resolve(out, 'program-launch-passport.png') });
await browser.close();

const passed = cardCount === 3 && operations === 3
  && text.includes('Расчётный план сформирован · в наряды ещё не передан')
  && text.includes('Ближайший период') && apiErrors.length === 0 && pageErrors.length === 0;
console.log(JSON.stringify({ passed, cardCount, operations, apiErrors, pageErrors }));
process.exit(passed ? 0 : 1);
