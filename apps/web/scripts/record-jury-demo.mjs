// Records an authenticated, browser-chrome-free jury walkthrough from the live platform.
import { chromium } from '@playwright/test';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5173';
const CITY = '10000000-0000-4000-8000-000000000001';
const credentialPath = process.env.PG_TEST_CREDENTIALS;
if (!credentialPath) throw new Error('Set PG_TEST_CREDENTIALS to an ignored local credentials file');
const credentials = JSON.parse(readFileSync(credentialPath, 'utf8'));
const output = resolve('../../output/jury-kit');
const rawDir = resolve('../../.local/jury-video-raw');
mkdirSync(output, { recursive: true });
mkdirSync(rawDir, { recursive: true });

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const prep = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: 'ru-RU' });
const setup = await prep.newPage();
await setup.goto(`${BASE}/auth/login`, { waitUntil: 'commit' });
await setup.waitForURL(/openid-connect\/auth/);
await setup.fill('#username', 'specialist');
await setup.fill('#password', credentials.specialist);
await setup.click('#kc-login');
await setup.waitForURL((url) => url.origin === BASE && !url.pathname.startsWith('/auth/'), { timeout: 20_000 });
await setup.waitForFunction(() => fetch('/v1/me').then((r) => r.ok).catch(() => false), null, { timeout: 20_000 });
const hero = await setup.evaluate(async (city) => {
  const response = await fetch(`/v1/scenarios?city_id=${city}&limit=200`);
  const body = await response.json();
  return body.items.find((item) => item.name === 'Вариант B · экономия воды');
}, CITY);
if (!hero) throw new Error('Hero scenario is missing');
const state = await prep.storageState();
await prep.close();

const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  locale: 'ru-RU',
  storageState: state,
  recordVideo: { dir: rawDir, size: { width: 1920, height: 1080 } },
});
const page = await context.newPage();
const hold = (ms) => page.waitForTimeout(ms);
try {
  await page.goto(`${BASE}/?city=${CITY}&ll=76.95000,52.28500&z=13.2`, { waitUntil: 'domcontentloaded' });
  await page.locator('.maplibregl-canvas').waitFor({ state: 'visible', timeout: 30_000 });
  await hold(5_500);

  await page.locator('.scene3d-toggle button').click();
  await page.waitForFunction(() => window.__pgScene?.state === 'on', null, { timeout: 30_000 });
  await hold(5_500);

  await page.goto(`${BASE}/projects?city=${CITY}`, { waitUntil: 'domcontentloaded' });
  await page.locator('main h1').waitFor({ state: 'visible' });
  await hold(5_000);

  await page.goto(`${BASE}/projects/${hero.id}?city=${CITY}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.scn-journey').waitFor({ state: 'visible' });
  await hold(5_000);
  const story = page.locator('.calc-story').first();
  if (await story.isVisible().catch(() => false)) await story.scrollIntoViewIfNeeded();
  else await page.mouse.wheel(0, 850);
  await hold(6_500);

  await page.goto(`${BASE}/compare?city=${CITY}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.cmp-summary-card').first().waitFor({ state: 'visible', timeout: 30_000 });
  await hold(5_500);

  await page.goto(`${BASE}/program?city=${CITY}`, { waitUntil: 'domcontentloaded' });
  const row = page.locator('.app-list tbody tr').first();
  await row.waitFor({ state: 'visible', timeout: 20_000 });
  await row.click();
  await page.locator('.priority-dashboard').waitFor({ state: 'visible', timeout: 20_000 });
  await hold(5_500);

  const assistantPng = readFileSync(resolve('../../docs/assets/readme/platform-assistant.png')).toString('base64');
  await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#eef2ee}img{display:block;width:100%;height:100%;object-fit:contain}</style><img alt="Ответ ИИ-ассистента по проекту" src="data:image/png;base64,${assistantPng}">`);
  await hold(7_000);
} finally {
  const video = page.video();
  await context.close();
  if (!video) throw new Error('Playwright video was not created');
  copyFileSync(await video.path(), resolve(output, 'Pavlodar_Greening_Demo_raw.webm'));
  await browser.close();
}
console.log('Raw jury demo recorded.');
