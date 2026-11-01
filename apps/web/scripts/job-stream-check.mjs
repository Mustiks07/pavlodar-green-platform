// Job tracking transport (ADR-035) in the disposable environment: an import job started from the
// wizard is tracked through the resumable SSE stream (streamJobEvents) without repeated getJob
// polling; with the stream blocked the shared useJob falls back to polling and still reaches the
// result; a reload during tracking reopens the stream for the job in the URL. SYNTHETIC TEST only.
//
//   uv run python -m tools.dev.browser_test_env --cwd apps/web -- node scripts/job-stream-check.mjs
import { chromium } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sessionCookie } from './lib/session-login.mjs';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5173';
const OUT = resolve('../../docs/evidence/wp01-job-stream');
const creds = process.env.PG_TEST_CREDENTIALS ? JSON.parse(readFileSync(process.env.PG_TEST_CREDENTIALS, 'utf8')) : null;
mkdirSync(OUT, { recursive: true });
const report = { base: BASE, startedAt: new Date().toISOString(), checks: [], shots: [] };
const check = (name, pass, detail) => {
  report.checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
};
const shot = async (page, file) => {
  await page.screenshot({ path: join(OUT, file), fullPage: false });
  report.shots.push(`docs/evidence/wp01-job-stream/${file}`);
};
const settle = (page) => page.waitForFunction(() => !document.querySelector('.pg-state .pg-spinner, .pg-skeleton'), null, { timeout: 15_000 }).catch(() => {});

const browser = await chromium.launch({ channel: process.env.PG_BROWSER_CHANNEL ?? 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ru-RU' });
const page = await ctx.newPage();
// Disposable stacks hand out sessions (PG_SESSIONS); otherwise the test realm login is used.
if (await sessionCookie(ctx, 'specialist', BASE)) await page.goto(BASE + '/');
else {
  await page.goto(BASE + '/');
  const btn = page.getByRole('button', { name: 'Войти через корпоративную учётную запись' }).first();
  await btn.waitFor({ timeout: 20_000 });
  await Promise.all([page.waitForURL(/openid-connect\/auth/, { waitUntil: 'commit', timeout: 20_000 }), btn.click()]);
  await page.fill('#username', 'specialist');
  await page.fill('#password', creds.specialist);
  await page.click('#kc-login');
  await page.waitForURL((u) => u.origin === new URL(BASE).origin && !u.pathname.startsWith('/auth/'), { waitUntil: 'commit', timeout: 20_000 });
}
await page.waitForTimeout(1500);
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

const streams = [];
const polls = [];
page.on('response', (r) => {
  const p = new URL(r.url()).pathname;
  if (/^\/v1\/jobs\/[0-9a-f-]{36}\/events$/.test(p)) streams.push({ status: r.status(), type: r.headers()['content-type'] ?? '' });
  else if (/^\/v1\/jobs\/[0-9a-f-]{36}$/.test(p) && r.request().method() === 'GET') polls.push(p);
});

const city = (await page.evaluate(async () => (await fetch('/v1/cities')).json())).items[0];
const served = await page.evaluate(async () => Object.values((await (await fetch('/openapi.json')).json()).paths).some((p) => Object.values(p).some((op) => op?.operationId === 'streamJobEvents')));
check('this environment serves streamJobEvents (contract 1.5.0, ADR-035)', served);

const dir = mkdtempSync(join(tmpdir(), 'pg-stream-'));
const file = (n) => {
  const f = join(dir, `synthetic-${n}.geojson`);
  writeFileSync(f, JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', id: `s-${n}`, properties: { name: `SYNTHETIC TEST stream ${n}` }, geometry: { type: 'Point', coordinates: [76.98, 52.28] } }] }));
  return f;
};
const stamp = new Date().toISOString().slice(11, 19);
let datasetId = null;
async function importOnce(n, { create }) {
  await page.goto(`${BASE}/imports?city=${city.id}`);
  await settle(page);
  if (create) {
    await page.getByRole('button', { name: 'Создать набор данных' }).click();
    await page.getByLabel(/^Название/).fill(`SYNTHETIC TEST stream ${stamp}`);
    await page.getByLabel('Тип', { exact: true }).selectOption('observations');
    await page.getByLabel('Владелец').fill('SYNTHETIC TEST');
    await page.getByLabel('Лицензия').fill('CC0-1.0');
    await page.getByLabel('Доступ', { exact: true }).selectOption('internal');
    await page.getByRole('button', { name: 'Создать набор', exact: true }).click();
    await page.waitForFunction((n) => [...document.querySelectorAll('select option:checked')].some((o) => o.textContent?.includes(n)), `SYNTHETIC TEST stream ${stamp}`, { timeout: 15_000 });
    datasetId = await page.evaluate((n) => [...document.querySelectorAll('select option')].find((o) => o.textContent?.includes(n))?.value, `SYNTHETIC TEST stream ${stamp}`);
  } else {
    await page.getByLabel('Набор данных').selectOption(datasetId);
  }
  await page.locator('input[type=file]').setInputFiles(file(n));
  await page.getByLabel('Метод получения данных').fill('SYNTHETIC TEST job stream');
  await page.getByRole('button', { name: 'Загрузить и проверить' }).click();
  await page.waitForURL(/[?&]job=/, { timeout: 60_000 });
  return new URL(page.url()).searchParams.get('job');
}

// 1. Stream: the job reaches its terminal state through SSE; getJob only for the full Job.
const job1 = await importOnce(1, { create: true });
const transportSeen = await page.waitForFunction(() => document.querySelector('[data-job-transport]')?.getAttribute('data-job-transport') === 'stream', null, { timeout: 15_000 }).then(() => true).catch(() => false);
await page.getByText('Проверка завершена').waitFor({ timeout: 90_000 });
const reads1 = polls.filter((p) => p.endsWith(job1)).length;
check('import job tracked through the SSE stream (200 text/event-stream), getJob read only at start/terminal', transportSeen && streams.some((s) => s.status === 200 && s.type.includes('text/event-stream')) && reads1 <= 3, { transportSeen, streams: streams.slice(0, 2), getJobReads: reads1 });
await shot(page, 'job-stream-done.png');

// 2. Stream blocked: polling fallback.
await page.route('**/v1/jobs/*/events*', (route) => route.abort());
const before = polls.length;
const job2 = await importOnce(2, { create: false });
const pollingSeen = await page.waitForFunction(() => document.querySelector('[data-job-transport]')?.getAttribute('data-job-transport') === 'polling', null, { timeout: 15_000 }).then(() => true).catch(() => false);
await page.getByText('Проверка завершена').waitFor({ timeout: 90_000 });
const reads2 = polls.slice(before).filter((p) => p.endsWith(job2)).length;
await page.unroute('**/v1/jobs/*/events*');
const final2 = await page.evaluate(async (id) => (await fetch(`/v1/jobs/${id}`)).json(), job2);
check('stream unavailable: polling fallback reaches the terminal state', pollingSeen && reads2 >= 1 && final2.state === 'succeeded', { pollingSeen, getJobReads: reads2, state: final2.state });

// 3. Reload during tracking reopens the stream for the job in the URL.
const job3 = await importOnce(3, { create: false });
const streamsBefore = streams.length;
await page.reload();
await page.getByText('Проверка завершена').waitFor({ timeout: 90_000 });
const final = await page.evaluate(async (id) => (await fetch(`/v1/jobs/${id}`)).json(), job3);
check('reload keeps tracking the job from the URL and ends in its terminal state', final.state === 'succeeded' && new URL(page.url()).searchParams.get('job') === job3, { state: final.state, streamsAfterReload: streams.length - streamsBefore });
check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3));

await browser.close();
report.finishedAt = new Date().toISOString();
report.passed = report.checks.every((c) => c.pass);
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`\n${report.checks.filter((c) => c.pass).length}/${report.checks.length} checks passed`);
process.exit(report.passed ? 0 : 1);
