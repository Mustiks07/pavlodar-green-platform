// Curated product screenshots from the real running UI and published city layers.
// No fixtures or DOM text are injected. Stage crops are kept for presentation assets;
// full-page captures show the authenticated product itself in the repository README.
//
// PG_TEST_CREDENTIALS=<ignored path> node scripts/readme-capture.mjs
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5173';
const CITY = process.env.PG_CITY_ID ?? '10000000-0000-4000-8000-000000000001';
const credentialPath = process.env.PG_TEST_CREDENTIALS;
if (!credentialPath) throw new Error('Set PG_TEST_CREDENTIALS to an ignored local credentials file');
const credentials = JSON.parse(readFileSync(credentialPath, 'utf8'));
const output = resolve(process.env.PG_CAPTURE_OUT ?? '../../docs/assets/readme');
mkdirSync(output, { recursive: true });

async function login(page) {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  const button = page.getByRole('button', { name: 'Войти через корпоративную учётную запись' });
  await button.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
  if (!(await button.isVisible().catch(() => false))) return;
  // Use the same BFF login endpoint as the button. Direct navigation is stable while the map
  // continues repainting behind the unauthenticated overlay in a headless capture.
  await page.goto(`${BASE}/auth/login`, { waitUntil: 'commit' });
  await page.waitForURL(/openid-connect\/auth/, { waitUntil: 'commit' });
  await page.fill('#username', 'specialist');
  await page.fill('#password', credentials.specialist);
  await page.click('#kc-login');
  await page.waitForURL((url) => url.origin === new URL(BASE).origin && !url.pathname.startsWith('/auth/') && !url.pathname.includes('openid-connect'), {
    waitUntil: 'domcontentloaded',
    timeout: 20_000,
  });
  await page.waitForFunction(
    () => fetch('/v1/me').then(async (response) => response.ok && Array.isArray((await response.json()).roles)).catch(() => false),
    null,
    { timeout: 20_000 },
  );
}

async function waitForMap(page) {
  await page.locator('.map-stage').waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator('.maplibregl-canvas').waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(() => /** @type {{ __pgMap?: { loaded?: () => boolean } }} */ (window).__pgMap?.loaded?.() === true, null, { timeout: 30_000 });
  await page.waitForTimeout(2_000);
}

async function compactAttribution(page) {
  const button = page.locator('.maplibregl-ctrl-attrib-button');
  if (await button.isVisible().catch(() => false)) await button.click();
}

async function capturePage(page, route, file) {
  await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
  await page.locator('main h1').waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForTimeout(1_500);
  await page.screenshot({ path: resolve(output, file) });
}

async function collapseMapContext(page) {
  const collapse = page.locator('button[aria-controls="map-context-body"][aria-expanded="true"]');
  if (await collapse.isVisible().catch(() => false)) await collapse.click();
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'ru-RU' });
const page = await context.newPage();
try {
  await login(page);
  await page.goto(`${BASE}/?city=${CITY}&ll=76.95000,52.28500&z=13.20`, { waitUntil: 'domcontentloaded' });
  await waitForMap(page);
  await compactAttribution(page);
  await page.locator('.map-stage').screenshot({ path: resolve(output, 'city-map.png') });
  await page.screenshot({ path: resolve(output, 'platform-map.png') });
  await collapseMapContext(page);

  await page.goto(`${BASE}/?city=${CITY}&ll=76.95000,52.28500&z=15.00&p=55&b=-24`, {
    waitUntil: 'domcontentloaded',
  });
  await waitForMap(page);
  await page.locator('.scene3d-toggle button').click();
  await page.waitForFunction(
    () => /** @type {{ __pgScene?: { state?: string } }} */ (window).__pgScene?.state === 'on',
    null,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(2_000);
  await compactAttribution(page);
  await page.locator('.map-stage').screenshot({ path: resolve(output, 'city-3d.png') });
  await page.screenshot({ path: resolve(output, 'platform-3d.png') });
  await collapseMapContext(page);

  await capturePage(page, `/catalog?city=${CITY}`, 'platform-catalog.png');
  await capturePage(page, `/projects?city=${CITY}`, 'platform-projects.png');
  await capturePage(page, `/problems?city=${CITY}`, 'platform-problems.png');
  await capturePage(page, `/execution?city=${CITY}`, 'platform-execution.png');
  await capturePage(page, `/sources?city=${CITY}`, 'platform-sources.png');

  await page.goto(`${BASE}/compare?city=${CITY}`, { waitUntil: 'domcontentloaded' });
  await page.locator('main h1').waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator('.cmp-summary-card').first().waitFor({ state: 'visible', timeout: 30_000 });
  await page.screenshot({ path: resolve(output, 'platform-compare.png') });

  await page.goto(`${BASE}/program?city=${CITY}`, { waitUntil: 'domcontentloaded' });
  await page.locator('main h1').waitFor({ state: 'visible', timeout: 30_000 });
  const programRow = page.locator('.app-list tbody tr').first();
  await programRow.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});
  if (await programRow.isVisible().catch(() => false)) {
    await programRow.click();
    await page.locator('.program-summary').waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForFunction(() => /вариантов собрано|Готова к запуску|результат сохранён/.test(document.querySelector('.program-summary')?.textContent ?? ''), null, { timeout: 20_000 });
    await page.locator('.priority-dashboard').waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});
    await page.locator('.pg-skeleton').waitFor({ state: 'detached', timeout: 20_000 }).catch(() => {});
  }
  await page.screenshot({ path: resolve(output, 'platform-program.png') });

  const scenario = await page.evaluate(async (city) => {
    const response = await fetch(`/v1/scenarios?city_id=${city}&limit=200`);
    const body = await response.json();
    return body.items?.find((item) => item.name === 'Вариант B · экономия воды')
      ?? body.items?.find((item) => item.name?.startsWith('Вариант'))
      ?? null;
  }, CITY);
  if (scenario) {
    await capturePage(page, `/projects/${scenario.id}?city=${CITY}`, 'platform-scenario.png');
  }
  // Assistant providers can be rate-limited independently of the product pages. Release asset
  // refreshes may explicitly keep the last verified assistant capture while updating every other
  // authenticated screen.
  if (scenario && process.env.PG_CAPTURE_SKIP_ASSISTANT !== '1') {
    await page.getByRole('button', { name: 'Спросить ИИ' }).click();
    await page.getByRole('heading', { name: 'Ассистент' }).waitFor({ timeout: 20_000 });
    const assistant = page.locator('#assistant-body');
    const start = assistant.getByRole('button', { name: 'Начать беседу' });
    if (await start.isVisible().catch(() => false)) {
      await start.click();
      await page.waitForURL(/[?&]chat=/, { timeout: 20_000 });
    }
    const question = 'В пяти коротких пунктах объясни сильные стороны этого варианта: состав посадок, экономию воды и что специалисту проверить перед утверждением.';
    await assistant.getByLabel(/^Вопрос/).fill(question);
    await assistant.getByRole('button', { name: 'Отправить' }).click();
    await assistant.locator('.asst-msg[data-role="assistant"][data-state="completed"]').last().waitFor({ timeout: 90_000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: resolve(output, 'platform-assistant.png') });
  }
  console.log('README screenshots captured from the running platform.');
} finally {
  await context.close();
  await browser.close();
}
