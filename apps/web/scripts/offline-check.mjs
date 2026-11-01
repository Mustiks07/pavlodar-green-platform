// Live offline/cold-start check against a PRODUCTION build (vite build && vite preview on :5173;
// the service worker is not registered by the dev server) and the real API:
// what is cached (shell, hashed assets, public basemap — never /v1, /auth, /health), explicit
// offline/unreachable/reconnected states, offline writes fail fast and keep drafts, cold start
// without network, recovery without reload. Creates no server data.
//
//   npm run build && npx vite preview --port 5173 --strictPort   (separate terminal)
//   uv run python -m tools.dev.browser_test_env --cwd apps/web -- node scripts/offline-check.mjs
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5173';
const OUT = resolve('../../docs/evidence/wp02-offline');
const creds = JSON.parse(readFileSync(process.env.PG_TEST_CREDENTIALS ?? '', 'utf8'));
mkdirSync(OUT, { recursive: true });

const report = { base: BASE, startedAt: new Date().toISOString(), checks: [], shots: [] };
const check = (name, pass, detail) => {
  report.checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
};
const shot = async (page, file) => {
  await page.screenshot({ path: join(OUT, file) });
  report.shots.push(`docs/evidence/wp02-offline/${file}`);
};

const browser = await chromium.launch({ channel: process.env.PG_BROWSER_CHANNEL ?? 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, locale: 'ru-RU' });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

await page.goto(BASE + '/');
const btn = page.getByRole('button', { name: 'Войти через корпоративную учётную запись' }).first();
await btn.waitFor({ timeout: 20_000 });
await Promise.all([page.waitForURL(/openid-connect\/auth/, { waitUntil: 'commit', timeout: 20_000 }), btn.click()]);
await page.waitForSelector('#username');
await page.fill('#username', 'specialist');
await page.fill('#password', creds.specialist);
await page.click('#kc-login');
await page.waitForURL((u) => u.origin === new URL(BASE).origin && !u.pathname.startsWith('/auth/'), { waitUntil: 'commit', timeout: 20_000 });

const isProd = await page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration('/')) || document.querySelector('script[src^="/assets/"]')));
check('production build is served (hashed /assets entry)', isProd);
await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.ready).active), null, { timeout: 20_000 });
const city = (await page.evaluate(async () => (await fetch('/v1/cities')).json())).items[0];
// Second visit: now controlled by the worker, so the map chunk and basemap pass through it.
await page.goto(`${BASE}/?city=${city.id}`);
await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15_000 });
await page.waitForSelector('.map-canvas canvas', { timeout: 30_000 });
await page.waitForTimeout(5000);

const caches = await page.evaluate(async () => {
  const out = {};
  for (const name of await self.caches.keys()) out[name] = (await (await self.caches.open(name)).keys()).map((r) => r.url);
  return out;
});
const all = Object.values(caches).flat();
const names = Object.keys(caches);
check('caches: versioned shell, hashed assets and public basemap only', names.some((n) => n.startsWith('pg-shell-')) && (caches['pg-assets'] ?? []).some((u) => /\/assets\/.+\.js$/.test(u)) && (caches['pg-basemap'] ?? []).some((u) => u.includes('openfreemap')), {
  names,
  assets: (caches['pg-assets'] ?? []).length,
  basemap: (caches['pg-basemap'] ?? []).length,
});
const leaked = all.filter((u) => /\/(v1|auth)\/|\/health|openapi\.json/.test(new URL(u).pathname));
check('no platform API, session or published-layer tile is cached', leaked.length === 0, leaked.slice(0, 5));

// --- offline with the page open
const zoneCountOnline = await page.locator('[data-row-id]').count();
await ctx.setOffline(true);
const banner = page.locator('.app-net[data-net="offline"]');
const bannerShown = await banner.waitFor({ timeout: 5000 }).then(() => true).catch(() => false);
check('going offline shows an explicit offline banner with the last server contact', bannerShown && /последний ответ сервера в \d\d:\d\d/.test(await banner.innerText()), await banner.innerText().catch(() => ''));
check('footer API indicator says "нет сети" offline, not the last health answer', (await page.locator('.app-status__api').innerText()).includes('нет сети'), await page.locator('.app-status__api').innerText());
check('data loaded earlier stays on screen offline (zones list)', zoneCountOnline > 0 && (await page.locator('[data-row-id]').count()) === zoneCountOnline, { zoneCountOnline });
await shot(page, 'offline-open-map.png');

// An offline write fails at once with a network message; the local draft stays.
await page.getByRole('button', { name: 'Нарисовать новый участок' }).click();
await page.locator('.map-canvas').focus();
// Keyboard drawing (the prod build has no map handle): arrows pan, Enter drops a vertex.
for (const keys of [[], ['ArrowRight', 'ArrowRight', 'ArrowRight'], ['ArrowDown', 'ArrowDown', 'ArrowDown']]) {
  for (const k of keys) await page.keyboard.press(k);
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
}
await page.getByRole('button', { name: 'Замкнуть' }).click();
await page.getByLabel(/Название участка/).fill('SYNTHETIC TEST офлайн');
const t0 = Date.now();
await page.getByRole('button', { name: 'Создать участок' }).click();
const netErr = await page.getByText('Нет соединения с сервером').first().waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
const draft = await page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('pg.zone-draw.')));
check('offline save fails fast with a network message; the contour stays as a local draft', netErr && Date.now() - t0 < 8000 && draft, { ms: Date.now() - t0, draft });
await shot(page, 'offline-save-blocked.png');

// --- cold start without network
const apiFromSw = [];
page.on('response', (r) => {
  const p = new URL(r.url()).pathname;
  if (/^\/(v1|auth)\/|^\/health/.test(p) && r.fromServiceWorker()) apiFromSw.push(p);
});
await page.reload();
const shellUp = await page.locator('.app-top').waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
const coldBanner = await page.locator('.app-net[data-net="offline"]').waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
const waiting = await page.getByText('Нет сети: загрузка начнётся сама').first().waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
check('cold start offline: app shell from the cache, offline banner, loading says it waits for the network', shellUp && coldBanner && waiting, { shellUp, coldBanner, waiting });
check('cold start offline: no API answer came from the cache', apiFromSw.length === 0, apiFromSw);
await shot(page, 'offline-cold-start.png');

// --- network back: recovers without reload
const navBefore = await page.evaluate(() => performance.getEntriesByType('navigation').length);
await ctx.setOffline(false);
const reconnected = await page.locator('.app-net.is-positive').waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
await shot(page, 'offline-reconnected.png');
const mapBack = await page.locator('.map-canvas canvas').waitFor({ timeout: 30_000 }).then(() => true).catch(() => false);
const sessionBack = await page.locator('.app-user').waitFor({ timeout: 30_000 }).then(() => true).catch(() => false);
const restored = await page.getByText('Восстановлен несохранённый контур').waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
check('network back: "connection restored", session and map load without a reload; the offline draft is restored', reconnected && mapBack && sessionBack && restored && navBefore === (await page.evaluate(() => performance.getEntriesByType('navigation').length)), { reconnected, mapBack, sessionBack, restored });
await page.getByRole('button', { name: 'Выйти без сохранения' }).click().catch(() => {});

// --- server unreachable while the browser is online
await page.route(/\/health\/ready/, (r) => r.abort('connectionrefused'));
await page.route(/\/v1\//, (r) => r.abort('connectionrefused'));
const unreachable = await page.locator('.app-net[data-net="unreachable"]').waitFor({ timeout: 45_000 }).then(() => true).catch(() => false);
check('API not answering (browser online): banner says the server does not answer, with a check button', unreachable && (await page.getByRole('button', { name: 'Проверить связь' }).count()) === 1);
await page.emulateMedia({ colorScheme: 'dark' });
await shot(page, 'offline-unreachable-dark.png');
await page.emulateMedia({ colorScheme: 'light' });
await page.unroute(/\/health\/ready/);
await page.unroute(/\/v1\//);
await page.getByRole('button', { name: 'Проверить связь' }).click();
const back = await page.locator('.app-net.is-positive').waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
check('server back: banner turns to "restored" after "Проверить связь"', back);

// --- phone layout offline
await ctx.setOffline(true);
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(800);
const b = await page.locator('.app-net').boundingBox();
check('offline banner fits a phone viewport', Boolean(b) && b.x >= 0 && b.x + b.width <= 391, b);
await shot(page, 'offline-mobile.png');
await ctx.setOffline(false);
check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3));

await browser.close();
report.finishedAt = new Date().toISOString();
report.passed = report.checks.every((c) => c.pass);
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`\n${report.checks.filter((c) => c.pass).length}/${report.checks.length} checks passed`);
process.exit(report.passed ? 0 : 1);
