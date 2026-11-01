// P-01 benchmark (TZ §26): city map ready for interaction <= 5 s p95, cold load.
// Production build served by `vite preview` (proxy to the integration API), authenticated
// session, network profile 20 Mbit/s with RTT 50 ms (CDP emulation). 30 cold runs (fresh
// browser context = empty HTTP cache) and 30 warm reloads, as §26 requires.
//
// Readiness = performance mark 'pg:map-ready': city boundary and zones from the API are drawn
// and the map reached its first idle (this includes basemap tiles). 'pg:map-style-ready' is the
// earlier point when the style is loaded and platform layers can be drawn.
//
//   npm run build
//   PG_TEST_CREDENTIALS=<ignored local file> node scripts/p01-bench.mjs <label> [runs]
// Login uses the dev server on :5173 (OIDC callback allowlist); the session cookie is host-scoped
// (localhost) and therefore valid for the preview server on :4173.
import { chromium } from '@playwright/test';
import { spawn, execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir, totalmem, release, platform } from 'node:os';
import { join, resolve } from 'node:path';

const label = process.argv[2] ?? 'run';
const RUNS = Number(process.argv[3] ?? 30);
const DEV = process.env.PG_WEB_URL ?? 'http://localhost:5173';
const PREVIEW = 'http://localhost:4173';
const OUT = resolve('../../docs/evidence/p01');
mkdirSync(OUT, { recursive: true });
const creds = JSON.parse(readFileSync(process.env.PG_TEST_CREDENTIALS ?? '', 'utf8'));
const NET = { offline: false, latency: 50, downloadThroughput: (20 * 1024 * 1024) / 8, uploadThroughput: (20 * 1024 * 1024) / 8 };

// PG_DIST lets the same script measure another build (e.g. a frozen baseline) with identical settings.
const DIST = process.env.PG_DIST ?? 'dist';
const chunks = readdirSync(join(DIST, 'assets'))
  .filter((f) => /\.(js|css)$/.test(f))
  .map((f) => ({ file: f, bytes: statSync(join(DIST, 'assets', f)).size }))
  .sort((a, b) => b.bytes - a.bytes);

const preview = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', '4173', '--strictPort', '--outDir', DIST], { stdio: 'pipe' });
preview.on('exit', (c) => c && console.error(`preview exited ${c}`));
for (let i = 0; ; i++) {
  if (i > 60) throw new Error('preview did not start on :4173');
  const up = await fetch(PREVIEW + '/').then((r) => r.ok).catch(() => false);
  if (up) break;
  await new Promise((r) => setTimeout(r, 500));
}

const browser = await chromium.launch({ channel: process.env.PG_BROWSER_CHANNEL ?? 'msedge' });

// Session once, through the dev server (OIDC callback allowlist).
const stateFile = join(mkdtempSync(join(tmpdir(), 'pg-p01-')), 'state.json');
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(DEV + '/');
  const btn = page.getByRole('button', { name: 'Войти через корпоративную учётную запись' }).first();
  await btn.waitFor({ timeout: 90_000 });
  await Promise.all([page.waitForURL(/openid-connect\/auth/, { waitUntil: 'commit' }), btn.click()]);
  await page.waitForSelector('#username');
  await page.fill('#username', 'viewer');
  await page.fill('#password', creds.viewer);
  await page.click('#kc-login');
  await page.waitForURL((u) => u.origin === new URL(DEV).origin && !u.pathname.startsWith('/auth/'), { waitUntil: 'commit' });
  await page.waitForTimeout(1500);
  await ctx.storageState({ path: stateFile });
  await ctx.close();
}

async function measure(page, url, reload) {
  if (reload) await page.reload({ waitUntil: 'commit' });
  else await page.goto(url, { waitUntil: 'commit' });
  await page.waitForFunction(() => performance.getEntriesByName('pg:map-ready').length > 0, null, { timeout: 60_000, polling: 50 });
  return page.evaluate(() => {
    const mark = (n) => performance.getEntriesByName(n)[0]?.startTime ?? null;
    const res = performance.getEntriesByType('resource');
    const nav = performance.getEntriesByType('navigation')[0];
    const sum = (f) => res.filter(f).reduce((a, r) => a + (r.transferSize || 0), 0);
    return {
      mapReadyMs: mark('pg:map-ready'),
      styleReadyMs: mark('pg:map-style-ready'),
      fcpMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
      domContentLoadedMs: nav?.domContentLoadedEventEnd ?? null,
      jsTransferBytes: sum((r) => /\.js(\?|$)/.test(r.name) && r.name.startsWith(location.origin)) + (nav?.transferSize ?? 0),
      appTransferBytes: sum((r) => r.name.startsWith(location.origin)),
      basemapTransferBytes: sum((r) => r.name.includes('openfreemap')),
      zones: performance.getEntriesByName('pg:map-ready')[0]?.detail?.zones ?? null,
    };
  });
}

const cityId = await (async () => {
  const ctx = await browser.newContext({ storageState: stateFile });
  const page = await ctx.newPage();
  await page.goto(PREVIEW + '/sources');
  const id = await page.evaluate(async () => (await (await fetch('/v1/cities')).json()).items?.[0]?.id ?? null);
  await ctx.close();
  return id;
})();
if (!cityId) throw new Error('No city for the session — is the API on :8001 up?');
const url = `${PREVIEW}/?city=${cityId}`;

const cold = [];
for (let i = 0; i < RUNS; i++) {
  const ctx = await browser.newContext({ storageState: stateFile, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', NET);
  cold.push(await measure(page, url, false));
  await ctx.close();
  process.stdout.write(`cold ${i + 1}/${RUNS} ${Math.round(cold.at(-1).mapReadyMs)} ms\r`);
}
console.log();
const warm = [];
{
  const ctx = await browser.newContext({ storageState: stateFile, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', NET);
  await measure(page, url, false); // prime cache, not counted
  for (let i = 0; i < RUNS; i++) {
    warm.push(await measure(page, url, true));
    process.stdout.write(`warm ${i + 1}/${RUNS} ${Math.round(warm.at(-1).mapReadyMs)} ms\r`);
  }
  await ctx.close();
}
console.log();
const browserVersion = browser.version();
await browser.close();
preview.kill();

const stats = (xs) => {
  const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  const q = (p) => v[Math.min(v.length - 1, Math.ceil(p * v.length) - 1)];
  return { n: v.length, p50: Math.round(q(0.5)), p95: Math.round(q(0.95)), max: Math.round(v.at(-1)), mean: Math.round(v.reduce((a, b) => a + b, 0) / v.length) };
};
const summarize = (rows) => ({
  mapReadyMs: stats(rows.map((r) => r.mapReadyMs)),
  styleReadyMs: stats(rows.map((r) => r.styleReadyMs)),
  fcpMs: stats(rows.map((r) => r.fcpMs)),
  jsTransferBytes: stats(rows.map((r) => r.jsTransferBytes)),
  basemapTransferBytes: stats(rows.map((r) => r.basemapTransferBytes)),
});
let sha = null;
try {
  sha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
} catch {
  /* not a git checkout */
}
const result = {
  label,
  requirement: 'P-01: map ready <= 5000 ms p95, cold',
  git: sha,
  measuredAt: new Date().toISOString(),
  machine: { platform: `${platform()} ${release()}`, cpu: cpus()[0]?.model, cores: cpus().length, memGB: Math.round(totalmem() / 2 ** 30) },
  browser: `msedge ${browserVersion} (Playwright, headless)`,
  network: '20 Mbit/s down/up, RTT 50 ms (CDP emulation); API http://localhost:8001 via vite preview proxy; basemap OpenFreeMap over the real internet',
  readiness: "performance mark 'pg:map-ready' (boundary + zones drawn, first map idle incl. basemap tiles)",
  chunks,
  cold: summarize(cold),
  warm: summarize(warm),
  passP01: summarize(cold).mapReadyMs.p95 <= 5000,
  rawCold: cold,
  rawWarm: warm,
};
writeFileSync(join(OUT, `${label}.json`), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ label, cold: result.cold, warm: result.warm, passP01: result.passP01 }, null, 1));
