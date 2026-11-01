// PDF/XLSX export acceptance (contract 1.11.0, ADR-045) on the isolated stack: a specialist
// exports a CalculationSnapshot and a ProgramRevision in both formats through startExport ->
// useJob (SSE/polling) -> getExport -> signed download_url; reload resumes a running export,
// cancel and retry work, an expired link is renewed through getExport without a new export, a
// tampered token is refused, and IDOR/401/404 hold. Files are checked for Content-Type, filename,
// size and SHA-256 against the server value. SYNTHETIC TEST data only.
//
//   uv run python -m tools.dev.isolated_browser_env --cwd apps/web -- node scripts/export-check.mjs
import { chromium } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sessionCookie } from './lib/session-login.mjs';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5174';
const OUT = resolve('../../docs/evidence/wp10-export-ui');
const ROOT = resolve('../..');
mkdirSync(OUT, { recursive: true });
const report = { base: BASE, startedAt: new Date().toISOString(), checks: [], shots: [], files: [] };
const check = (name, pass, detail) => {
  report.checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
};
const shot = async (page, file) => {
  await page.screenshot({ path: join(OUT, file), fullPage: false });
  report.shots.push(`docs/evidence/wp10-export-ui/${file}`);
};
const apiCall = (page, method, path, body) =>
  page.evaluate(
    async ({ method, path, body }) => {
      const me = await (await fetch('/v1/me')).json();
      const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token, 'Idempotency-Key': crypto.randomUUID() }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    { method, path, body },
  );
async function signIn(browser, role, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ru-RU', acceptDownloads: true, ...opts });
  const page = await ctx.newPage();
  if (!(await sessionCookie(ctx, role, BASE))) throw new Error('Run through tools/dev/isolated_browser_env.py (PG_SESSIONS)');
  await page.goto(BASE + '/');
  await page.waitForTimeout(800);
  return { ctx, page };
}

const browser = await chromium.launch({ channel: process.env.PG_BROWSER_CHANNEL ?? 'msedge' });
const sp = await signIn(browser, 'specialist');
const page = sp.page;
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
const calls = { start: 0, get: 0, download: [] };
page.on('request', (r) => {
  const p = new URL(r.url()).pathname;
  if (p === '/v1/exports' && r.method() === 'POST') calls.start += 1;
  if (/^\/v1\/exports\/[0-9a-f-]{36}$/.test(p)) calls.get += 1;
});
page.on('response', (r) => {
  if (/\/download$/.test(new URL(r.url()).pathname)) calls.download.push({ status: r.status(), type: r.headers()['content-type'] ?? '', disposition: r.headers()['content-disposition'] ?? '' });
});

// --- Setup: SYNTHETIC zone, scenario and a server fast calculation snapshot ---
const city = (await page.evaluate(async () => (await fetch('/v1/cities')).json())).items[0];
const zone = await apiCall(page, 'POST', '/v1/zones', { city_id: city.id, name: 'SYNTHETIC TEST экспорт', purpose: 'park', geometry: { type: 'Polygon', coordinates: [[[76.98, 52.28], [76.981, 52.28], [76.981, 52.281], [76.98, 52.281], [76.98, 52.28]]] } });
const draft = { zone_version_id: zone.body.version_id, parent_revision_id: null, dataset_version_ids: [], catalog_version_id: null, rate_version_id: null, coefficient_version_id: null, rule_version_id: null, model_version_id: null, placements: [], area_patches: [], capital_budget: null, care_horizon_years: 3, resource_limits: [], excluded_plant_ids: [], diversity_caps: [], care_strategy: 'standard', custom_care_operations: [], comment: 'SYNTHETIC TEST export' };
const scenario = (await apiCall(page, 'POST', '/v1/scenarios', { city_id: city.id, zone_id: zone.body.id, name: 'SYNTHETIC TEST экспорт', base_revision_id: null, initial_state: draft })).body;
const fast = await apiCall(page, 'POST', '/v1/calculations/fast', { scenario_revision_id: scenario.current_revision_id, mode: 'fast', include_modules: ['cost', 'survival', 'care'], seed: 0 });
const snapshotId = fast.body?.snapshot?.id;
check('setup: SYNTHETIC scenario with a server calculation snapshot', Boolean(snapshotId), { status: fast.status });

const MAGIC = { pdf: '%PDF', xlsx: 'PK' };
const TYPE = { pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const row = (fmt) => page.locator(`.exp-row[data-format="${fmt}"]`).first();
async function exportAndDownload(fmt, label) {
  const r = row(fmt);
  await r.getByRole('button', { name: `Сформировать ${fmt.toUpperCase()}` }).click();
  await r.locator('.exp-artifact').waitFor({ timeout: 120_000 });
  const artifactId = await r.locator('.exp-artifact').getAttribute('data-export-id');
  const meta = (await apiCall(page, 'GET', `/v1/exports/${artifactId}`)).body;
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), r.getByRole('button', { name: `Скачать ${fmt.toUpperCase()}` }).click()]);
  const path = join(OUT, `${label}.${fmt}`);
  await download.saveAs(path);
  const bytes = readFileSync(path);
  const okStatus = await r.locator('[data-download-ok="true"]').waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
  const http = calls.download.at(-1);
  const uiSize = await r.locator('[data-byte-size]').getAttribute('data-byte-size');
  report.files.push({ label, format: fmt, artifactId, bytes: bytes.length, sha256: meta.sha256 });
  return {
    artifactId,
    ok:
      bytes.length > 0 &&
      bytes.subarray(0, MAGIC[fmt].length).toString('latin1') === MAGIC[fmt] &&
      createHash('sha256').update(bytes).digest('hex') === meta.sha256 &&
      meta.byte_size === bytes.length &&
      meta.media_type === TYPE[fmt] &&
      uiSize === String(meta.byte_size) &&
      download.suggestedFilename().endsWith(`.${fmt}`) &&
      http?.status === 200 &&
      http.type.startsWith(TYPE[fmt]) &&
      /filename/i.test(http.disposition) &&
      okStatus,
    detail: { artifactId, bytes: bytes.length, byte_size: meta.byte_size, media_type: meta.media_type, uiSize, filename: download.suggestedFilename(), http, okStatus },
  };
}

// --- Calculation snapshot: retry after a start error, PDF and XLSX ---
await page.goto(`${BASE}/projects/${scenario.id}?city=${city.id}&calc=${snapshotId}`);
await page.locator('.exp-panel').first().waitFor({ timeout: 30_000 });
let failed = false;
await page.route('**/v1/exports', (route) => {
  if (route.request().method() !== 'POST' || failed) return route.continue();
  failed = true;
  return route.fulfill({ status: 503, contentType: 'application/problem+json', body: JSON.stringify({ type: 'about:blank', title: 'storage_unavailable', status: 503, detail: 'SYNTHETIC TEST outage', code: 'storage_unavailable', request_id: crypto.randomUUID(), current_revision_id: null, field_errors: [], blockers: [] }) });
});
await row('pdf').getByRole('button', { name: 'Сформировать PDF' }).click();
const startErr = await row('pdf').locator('.pg-state, [role=alert]').first().waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
await page.unroute('**/v1/exports');
check('start error is shown with retry; nothing is exported', startErr && failed);
const calcPdf = await exportAndDownload('pdf', 'calculation');
check('calculation PDF: job -> getExport -> signed download; %PDF, Content-Type, filename, server byte_size/media_type = file, SHA-256', calcPdf.ok, calcPdf.detail);
const calcXlsx = await exportAndDownload('xlsx', 'calculation');
check('calculation XLSX: PK zip, Content-Type, filename, size, SHA-256', calcXlsx.ok, calcXlsx.detail);
await page.locator('.exp-panel').first().scrollIntoViewIfNeeded();
await shot(page, 'export-calculation.png');

// --- Expired link: renewed through getExport, no new export ---
const startsBefore = calls.start;
const getsBefore = calls.get;
let expiredOnce = false;
await page.route('**/v1/exports/*/download*', (route) => {
  if (expiredOnce) return route.continue();
  expiredOnce = true;
  return route.fulfill({ status: 403, contentType: 'application/problem+json', body: JSON.stringify({ type: 'about:blank', title: 'export_download_expired', status: 403, detail: 'SYNTHETIC TEST expired', code: 'export_download_expired', request_id: crypto.randomUUID(), current_revision_id: null, field_errors: [], blockers: [] }) });
});
const [renewed] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), row('pdf').getByRole('button', { name: 'Скачать PDF' }).click()]);
await page.unroute('**/v1/exports/*/download*');
check('expired link: getExport renews it and the download succeeds without a new startExport', expiredOnce && calls.start === startsBefore && calls.get > getsBefore && Boolean(renewed.suggestedFilename()), { gets: calls.get - getsBefore, starts: calls.start - startsBefore });
// Expired metadata is shown as such.
await page.route('**/v1/exports/*', async (route) => {
  if (route.request().method() !== 'GET' || /\/download/.test(route.request().url())) return route.continue();
  const res = await route.fetch();
  const body = await res.json();
  return route.fulfill({ response: res, json: { ...body, expires_at: '2020-01-01T00:00:00Z' } });
});
await page.reload();
const expiredShown = await row('pdf').locator('[data-link-state="expired"]').waitFor({ timeout: 20_000 }).then(() => true).catch(() => false);
await page.unroute('**/v1/exports/*');
check('a past expires_at is shown as an expired link (reload keeps the artifacts from the URL)', expiredShown);
// Tampered token is refused by the server.
const meta = (await apiCall(page, 'GET', `/v1/exports/${calcPdf.artifactId}`)).body;
const tampered = await page.evaluate(async (url) => {
  const u = new URL(url, location.origin);
  const tok = u.searchParams.get('token');
  u.searchParams.set('token', tok.slice(0, -1) + (tok.endsWith('A') ? 'B' : 'A'));
  const r = await fetch(u);
  return { status: r.status, code: (await r.json().catch(() => ({}))).code };
}, meta.download_url);
check('tampered token: 403 export_download_invalid', tampered.status === 403 && tampered.code === 'export_download_invalid', tampered);

// --- Cancel (the worker may finish first) and reload/resume on a running export ---
await page.goto(`${BASE}/projects/${scenario.id}?city=${city.id}&calc=${snapshotId}`);
await page.locator('.exp-panel').first().waitFor({ timeout: 30_000 });
// A fresh target: a second snapshot keeps the earlier artifacts untouched.
const fast2 = await apiCall(page, 'POST', '/v1/calculations/fast', { scenario_revision_id: scenario.current_revision_id, mode: 'fast', include_modules: ['cost'], seed: 1 });
await page.goto(`${BASE}/projects/${scenario.id}?city=${city.id}&calc=${fast2.body.snapshot.id}`);
await page.locator('.exp-panel').first().waitFor({ timeout: 30_000 });
await row('pdf').getByRole('button', { name: 'Сформировать PDF' }).click();
await row('pdf').locator('.pg-job').waitFor({ timeout: 10_000 }).catch(() => {});
const cancelBtn = row('pdf').locator('.pg-job').getByRole('button');
const couldCancel = await cancelBtn.isVisible().catch(() => false);
if (couldCancel) await cancelBtn.click().catch(() => {});
const cancelJobId = new URL(page.url()).searchParams.getAll('export').find((v) => v.includes(':pdf:job:'))?.split(':')[3] ?? null;
let cancelState = null;
for (let i = 0; i < 120 && cancelJobId; i++) {
  cancelState = (await apiCall(page, 'GET', `/v1/jobs/${cancelJobId}`)).body.state;
  if (['succeeded', 'cancelled', 'failed'].includes(cancelState)) break;
  await page.waitForTimeout(500);
}
const afterCancel = cancelState === 'cancelled' ? await row('pdf').getByRole('button', { name: 'Сформировать заново' }).waitFor({ timeout: 15_000 }).then(() => true).catch(() => false) : await row('pdf').locator('.exp-artifact').waitFor({ timeout: 30_000 }).then(() => true).catch(() => false);
check('cancel: the row ends in the server state (cancelled offers a new export; finished first shows the artifact)', Boolean(cancelJobId) && afterCancel, { couldCancel, cancelState });
await row('xlsx').getByRole('button', { name: 'Сформировать XLSX' }).click();
await page.waitForFunction(() => new URLSearchParams(location.search).getAll('export').some((v) => v.includes(':xlsx:job:')), null, { timeout: 15_000 });
await page.reload();
const resumed = await row('xlsx').locator('.exp-artifact').waitFor({ timeout: 120_000 }).then(() => true).catch(() => false);
check('reload during an export resumes the job from the URL and lands on its artifact', resumed);

// --- Program revision: PDF and XLSX ---
const fixture = spawnSync('uv', ['run', 'python', '-m', 'tools.dev.synthetic_program_fixture'], { cwd: ROOT, env: process.env, encoding: 'utf8' });
const program = fixture.status === 0 ? JSON.parse(fixture.stdout.trim().split('\n').at(-1)) : null;
check('setup: SYNTHETIC program optimized into a ProgramRevision (disposable DB only)', Boolean(program?.program_revision_id), { status: fixture.status, err: (fixture.stderr ?? '').slice(-300) });
if (program) {
  await page.goto(`${BASE}/program?city=${city.id}&selected=${program.program_id}`);
  await page.locator('.exp-panel').first().waitFor({ timeout: 30_000 });
  const target = await page.locator('.exp-panel').first().getAttribute('data-target');
  const progPdf = await exportAndDownload('pdf', 'program');
  check('program revision PDF exported for the selected revision', target === program.program_revision_id && progPdf.ok, { target, ...progPdf.detail });
  const progXlsx = await exportAndDownload('xlsx', 'program');
  check('program revision XLSX exported', progXlsx.ok, progXlsx.detail);
  await page.locator('.exp-panel').first().scrollIntoViewIfNeeded();
  await shot(page, 'export-program.png');
}
check('no page errors in the specialist session', pageErrors.length === 0, pageErrors.slice(0, 3));
const downloadUrl = (await apiCall(page, 'GET', `/v1/exports/${calcPdf.artifactId}`)).body.download_url;
await sp.ctx.close();

// --- IDOR / 401 / 404 ---
const vw = await signIn(browser, 'viewer');
const idorMeta = await vw.page.evaluate(async (id) => (await fetch(`/v1/exports/${id}`)).status, calcPdf.artifactId);
const idorDownload = await vw.page.evaluate(async (u) => (await fetch(u)).status, downloadUrl);
const unknown = await vw.page.evaluate(async () => (await fetch(`/v1/exports/${crypto.randomUUID()}`)).status);
await vw.page.goto(`${BASE}/projects/${scenario.id}?city=${city.id}&export=${snapshotId}:pdf:art:${calcPdf.artifactId}`);
// The draft scenario itself is hidden from a viewer; the page settles on a typed state.
await vw.page.locator('.pg-state').filter({ hasNotText: 'Загрузка' }).first().waitFor({ timeout: 30_000 }).catch(() => {});
await shot(vw.page, 'export-viewer.png');
await vw.ctx.close();
const anon = await browser.newContext();
const anonPage = await anon.newPage();
await anonPage.goto(BASE + '/');
const anonymous = await anonPage.evaluate(async (u) => (await fetch(u)).status, downloadUrl);
await anon.close();
check('IDOR: viewer gets 404 for metadata and download of a draft scenario export; unknown id 404; anonymous 401', idorMeta === 404 && idorDownload === 404 && unknown === 404 && anonymous === 401, { idorMeta, idorDownload, unknown, anonymous });

await browser.close();
report.finishedAt = new Date().toISOString();
report.passed = report.checks.every((c) => c.pass);
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`\n${report.checks.filter((c) => c.pass).length}/${report.checks.length} checks passed`);
process.exit(report.passed ? 0 : 1);
