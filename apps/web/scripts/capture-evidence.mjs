// Visual review evidence for WP-02 (AC-16). Drives a real browser against the running
// dev server and stores screenshots + a JSON report under docs/evidence/wp02/.
//
//   npm run dev                       # in another terminal (API may be down)
//   npm run evidence                  # uses installed Microsoft Edge (channel msedge)
//   PG_BROWSER_CHANNEL=chrome npm run evidence
//
// Network interception only changes HTTP *status* of /v1/me and /health to show the
// unauthenticated / forbidden states; no response data is invented.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5173';
const OUT = resolve('../../docs/evidence/wp02');
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: 'desktop-1440', width: 1440, height: 900 },
  { name: 'desktop-1920', width: 1920, height: 1080 },
  { name: 'tablet-1024', width: 1024, height: 768 },
  { name: 'mobile-390', width: 390, height: 844 },
];

const ROUTES = [
  { name: 'map', path: '/' },
  { name: 'problems', path: '/problems' },
  { name: 'catalog', path: '/catalog' },
  { name: 'compare', path: '/compare' },
  { name: 'notfound', path: '/no-such-page' },
  { name: 'gallery', path: '/dev/ui' },
];

const GALLERY_SECTIONS = ['g-states', 'g-errors', 'g-data', 'g-progress', 'g-legend', 'g-table', 'g-ready', 'g-catalog', 'g-cost', 'g-height'];

const report = { base: BASE, browser: null, startedAt: new Date().toISOString(), shots: [], checks: [] };

function check(name, pass, detail) {
  report.checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${JSON.stringify(detail)}` : ''}`);
}

async function settle(page) {
  // API retries end within ~4 s; wait until no spinner is left or 12 s pass.
  await page.waitForFunction(() => !document.querySelector('.pg-state .pg-spinner'), null, { timeout: 12_000 }).catch(() => {});
  await page.waitForTimeout(300);
}

async function shot(page, file) {
  const path = join(OUT, file);
  await page.screenshot({ path });
  report.shots.push(`docs/evidence/wp02/${file}`);
}

const browser = await chromium.launch({ channel: process.env.PG_BROWSER_CHANNEL ?? 'msedge' });
report.browser = `${browser.browserType().name()} ${browser.version()}`;

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, locale: 'ru-RU', colorScheme: 'light' });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|500 \(Internal Server Error\)/.test(m.text()) && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  for (const r of ROUTES) {
    await page.goto(BASE + r.path);
    await settle(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`${vp.name} ${r.name}: no horizontal page scroll`, overflow <= 0, { overflow });
    await shot(page, `${r.name}-${vp.name}.png`);
  }

  // Gallery sections (main scrolls internally, so capture each section in view).
  await page.goto(BASE + '/dev/ui');
  await settle(page);
  for (const id of GALLERY_SECTIONS) {
    await page.locator(`#${id}`).scrollIntoViewIfNeeded();
    await page.evaluate((sid) => document.getElementById(sid)?.closest('section')?.scrollIntoView({ block: 'start' }), id);
    await page.waitForTimeout(150);
    await shot(page, `gallery-${id}-${vp.name}.png`);
  }

  if (vp.name === 'mobile-390') {
    await page.goto(BASE + '/');
    await settle(page);
    await page.getByRole('button', { name: 'Открыть меню разделов' }).click();
    await page.waitForTimeout(300);
    await shot(page, `map-mobile-390-nav-open.png`);
    await page.keyboard.press('Escape');
    const closed = await page.locator('#app-nav').evaluate((el) => !el.classList.contains('is-open'));
    check('mobile drawer closes on Escape', closed);
  }

  check(`${vp.name}: no uncaught console errors`, consoleErrors.length === 0, consoleErrors.slice(0, 5));
  await ctx.close();
}

// Dark theme and reduced motion at the primary desktop size.
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', reducedMotion: 'reduce', locale: 'ru-RU' });
  const page = await ctx.newPage();
  for (const r of [ROUTES[0], ROUTES[5]]) {
    await page.goto(BASE + r.path);
    await settle(page);
    await shot(page, `${r.name}-desktop-1440-dark.png`);
  }
  for (const id of ['g-states', 'g-data']) {
    await page.evaluate((sid) => document.getElementById(sid)?.closest('section')?.scrollIntoView({ block: 'start' }), id);
    await page.waitForTimeout(150);
    await shot(page, `gallery-${id}-desktop-1440-dark.png`);
  }
  const anim = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pg-dur').trim());
  check('reduced motion zeroes transition tokens', anim === '0ms', { '--pg-dur': anim });
  await ctx.close();
}

// Auth / permission states driven by HTTP status only.
for (const [status, name] of [
  [401, 'unauthenticated'],
  [403, 'forbidden'],
]) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ru-RU' });
  const page = await ctx.newPage();
  await page.route('**/v1/me', (route) => route.fulfill({ status, body: '' }));
  await page.route('**/health/ready', (route) => route.fulfill({ status: 503, body: '' }));
  await page.goto(BASE + '/problems?severity=high');
  await settle(page);
  const text = await page.locator('main').innerText();
  check(`${name} state rendered for HTTP ${status}`, text.includes(status === 401 ? 'Требуется вход' : 'Нет доступа'));
  await shot(page, `problems-desktop-1440-${name}.png`);
  if (status === 401) {
    const filter = new URL(page.url()).searchParams.get('severity');
    check('deep-link filter kept in URL while signed out', filter === 'high', { url: page.url() });
  }
  await ctx.close();
}

// Keyboard: skip link, focus order, table row navigation, panel resize via keyboard.
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ru-RU' });
  const page = await ctx.newPage();
  await page.goto(BASE + '/dev/ui');
  await settle(page);
  await page.keyboard.press('Tab');
  const first = await page.evaluate(() => document.activeElement?.textContent?.trim());
  check('first Tab lands on skip link', first === 'Перейти к содержимому', { first });
  await page.keyboard.press('Enter');
  const focusedMain = await page.evaluate(() => document.activeElement?.id);
  check('skip link moves focus to main', focusedMain === 'main', { focusedMain });

  const row = page.locator('[data-row-id="row-003"]');
  await row.scrollIntoViewIfNeeded();
  await row.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  const selected = await page.locator('tr.is-selected').getAttribute('data-row-id');
  check('table: arrows + Enter select row', selected === 'row-005', { selected });
  await page.keyboard.press('End');
  await page.waitForTimeout(100);
  const lastFocused = await page.evaluate(() => document.activeElement?.getAttribute('data-row-id'));
  check('table: End reaches last of 400 windowed rows', lastFocused === 'row-400', { lastFocused });
  const rendered = await page.locator('.pg-table tbody tr[data-row-id]').count();
  check('table: windowing renders a subset of rows', rendered < 120, { rendered });
  await shot(page, 'gallery-table-keyboard-desktop-1440.png');

  await page.getByRole('button', { name: 'Ассистент' }).click();
  const sep = page.getByRole('separator', { name: 'Изменить ширину панели' });
  await sep.focus();
  const before = Number(await sep.getAttribute('aria-valuenow'));
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  const after = Number(await sep.getAttribute('aria-valuenow'));
  check('panel: keyboard resize changes width', after === before + 32, { before, after });
  await shot(page, 'gallery-assistant-panel-desktop-1440.png');
  await page.getByRole('button', { name: 'Свернуть панель' }).click();
  const gone = await page.getByRole('separator', { name: 'Изменить ширину панели' }).count();
  check('panel: collapse button closes panel', gone === 0);

  await page.getByRole('button', { name: 'Открыть диалог' }).click();
  const dialogOpen = await page.locator('dialog[open]').count();
  await page.keyboard.press('Escape');
  const dialogClosed = await page.locator('dialog[open]').count();
  check('dialog opens and closes with Escape', dialogOpen === 1 && dialogClosed === 0);
  await ctx.close();
}

await browser.close();
report.finishedAt = new Date().toISOString();
report.passed = report.checks.every((c) => c.pass);
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`\n${report.checks.filter((c) => c.pass).length}/${report.checks.length} checks passed; ${report.shots.length} screenshots in docs/evidence/wp02`);
process.exit(report.passed ? 0 : 1);
