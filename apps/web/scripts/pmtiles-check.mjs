// PMTiles browser acceptance (contract 1.5.0, ADR-031) in the disposable environment: a SYNTHETIC
// TEST public layer is published, its archive is registered with the server's own register_archive,
// listMapLayers switches it to source_type=pmtiles, and the map reads the archive only through
// single Range requests (206) with the session cookie: render, overzoom, feature card, toggle,
// reload and a failing archive (503) shown on the layer card.
//
//   uv run python -m tools.dev.browser_test_env --cwd apps/web -- node scripts/pmtiles-check.mjs
// PG_GPT_ROOT points to the backend checkout used by the harness (for register_archive).
import { chromium } from '@playwright/test';
import { sessionCookie } from './lib/session-login.mjs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5173';
const OUT = resolve('../../docs/evidence/wp03-pmtiles-ui');
const GPT_ROOT = resolve(process.env.PG_GPT_ROOT ?? '../../../team-vtiposhnik-gpt');
const creds = JSON.parse(readFileSync(process.env.PG_TEST_CREDENTIALS ?? '', 'utf8'));
mkdirSync(OUT, { recursive: true });

const report = { base: BASE, startedAt: new Date().toISOString(), checks: [], shots: [] };
const check = (name, pass, detail) => {
  report.checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
};
const shot = async (page, file) => {
  await page.screenshot({ path: join(OUT, file), fullPage: false });
  report.shots.push(`docs/evidence/wp03-pmtiles-ui/${file}`);
};
const apiCall = (page, method, path, body, raw) =>
  page.evaluate(
    async ({ method, path, body, raw }) => {
      const me = await (await fetch('/v1/me')).json();
      const headers = { 'X-CSRF-Token': me.csrf_token, 'Idempotency-Key': crypto.randomUUID() };
      if (!raw) headers['Content-Type'] = 'application/json';
      else headers['Content-Type'] = 'application/geo+json';
      const res = await fetch(path, { method, headers, body: raw ?? (body ? JSON.stringify(body) : undefined) });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    { method, path, body, raw },
  );
async function login(browser, role, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ru-RU', ...opts });
  const page = await ctx.newPage();
  if (await sessionCookie(ctx, role, BASE)) {
    await page.goto(BASE + '/');
    await page.waitForTimeout(800);
    return { ctx, page };
  }
  await page.goto(BASE + '/');
  const btn = page.getByRole('button', { name: 'Войти через корпоративную учётную запись' }).first();
  await btn.waitFor({ timeout: 20_000 });
  await Promise.all([page.waitForURL(/openid-connect\/auth/, { waitUntil: 'commit', timeout: 20_000 }), btn.click()]);
  await page.waitForSelector('#username');
  await page.fill('#username', role);
  await page.fill('#password', creds[role]);
  await page.click('#kc-login');
  await page.waitForURL((u) => u.origin === new URL(BASE).origin && !u.pathname.startsWith('/auth/'), { waitUntil: 'commit', timeout: 20_000 });
  await page.waitForTimeout(1500);
  return { ctx, page };
}
const idle = (page) => page.evaluate(() => new Promise((r) => (window.__pgMap.loaded() ? r(true) : window.__pgMap.once('idle', () => r(true)))));

const browser = await chromium.launch({ channel: process.env.PG_BROWSER_CHANNEL ?? 'msedge' });
const stamp = new Date().toISOString().slice(11, 19);

// --- Setup: SYNTHETIC public polygons, imported and published through the real pipeline ---
const sp = await login(browser, 'specialist');
const city = (await sp.page.evaluate(async () => (await fetch('/v1/cities')).json())).items[0];
const [lng0, lat0] = [76.9805, 52.2805];
const square = (i, j) => {
  const w = lng0 + i * 0.0012;
  const s = lat0 + j * 0.0008;
  return [[[w, s], [w + 0.0008, s], [w + 0.0008, s + 0.0005], [w, s + 0.0005], [w, s]]];
};
const features = [];
for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) features.push({ type: 'Feature', id: `pm-${i}-${j}`, properties: { name: `SYNTHETIC TEST PMTiles ${i}-${j}` }, geometry: { type: 'Polygon', coordinates: square(i, j) } });
const content = JSON.stringify({ type: 'FeatureCollection', features });
const dsName = `SYNTHETIC TEST PMTiles ${stamp}`;
const ds = await apiCall(sp.page, 'POST', '/v1/datasets', { city_id: city.id, name: dsName, kind: 'green_inventory', owner: 'SYNTHETIC TEST', license: 'CC0-1.0', access_level: 'public', source_uri: null });
const ticket = await apiCall(sp.page, 'POST', `/v1/datasets/${ds.body.id}/uploads`, {
  filename: 'synthetic-pmtiles.geojson', content_type: 'application/geo+json', byte_size: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex'),
});
const put = await apiCall(sp.page, 'PUT', ticket.body.put_url, null, content);
const queued = await apiCall(sp.page, 'POST', `/v1/datasets/${ds.body.id}/imports`, {
  upload_id: ticket.body.upload_id, format: 'geojson', source_crs: 'EPSG:4326', field_mapping: [{ source_field: 'name', target_field: 'name' }], observed_at: null, method: 'SYNTHETIC TEST PMTiles browser acceptance', spatial_resolution_m: null,
});
let job = queued.body;
for (let i = 0; i < 120 && !['succeeded', 'failed', 'cancelled'].includes(job?.state); i++) {
  await sp.page.waitForTimeout(500);
  job = (await sp.page.evaluate(async (id) => (await fetch(`/v1/jobs/${id}`)).json(), job.id));
}
const ad = await login(browser, 'admin');
const published = await apiCall(ad.page, 'POST', `/v1/dataset-versions/${job.result_ref_id}/publish`, { reason: 'SYNTHETIC TEST PMTiles browser acceptance' });
const layersBefore = (await sp.page.evaluate(async (c) => (await fetch(`/v1/map/layers?city_id=${c}&limit=200`)).json(), city.id)).items;
const layer = layersBefore.find((l) => l.dataset_id === ds.body.id);
check('setup: SYNTHETIC public layer published and served as dynamic MVT before the archive exists', [ds.status, ticket.status, put.status, queued.status, published.status].join() === '201,201,204,202,200' && job.state === 'succeeded' && layer?.source_type === 'mvt', { statuses: [ds.status, ticket.status, put.status, queued.status, published.status], job: job.state, type: layer?.source_type });

// Register the archive with the server's own builder (same code and database as the API).
const py = `
from pathlib import Path
from services.api.config import settings
from services.api.db import session
from services.worker.pmtiles import register_archive
with session() as db, db.begin():
    r = register_archive(db, "${layer.id}", Path(settings().tile_root), min_zoom=10, max_zoom=14)
    print(r.byte_size, r.tile_count)
`;
const pyFile = join(mkdtempSync(join(tmpdir(), 'pg-pmtiles-')), 'register.py');
writeFileSync(pyFile, py);
const built = spawnSync('uv', ['run', 'python', pyFile], { cwd: GPT_ROOT, env: { ...process.env, PYTHONPATH: GPT_ROOT }, encoding: 'utf8' });
const [archiveBytes, archiveTiles] = (built.stdout ?? '').trim().split(/\s+/).map(Number);
const after = (await sp.page.evaluate(async (c) => (await fetch(`/v1/map/layers?city_id=${c}&limit=200`)).json(), city.id)).items.find((l) => l.dataset_id === ds.body.id);
check('archive registered; listMapLayers now reports source_type=pmtiles with the archive URL', built.status === 0 && archiveBytes > 0 && after?.source_type === 'pmtiles' && after.source_url === `/v1/map/archives/${after.id}.pmtiles`, { status: built.status, archiveBytes, archiveTiles, type: after?.source_type, url: after?.source_url, err: (built.stderr ?? '').slice(-300) });
await sp.ctx.close();
await ad.ctx.close();

// --- Viewer journey ---
const vw = await login(browser, 'viewer');
const page = vw.page;
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
const archiveReqs = [];
const dynamicReqs = [];
page.on('response', (r) => {
  const u = new URL(r.url());
  if (u.pathname === `/v1/map/archives/${after.id}.pmtiles`) archiveReqs.push({ status: r.status(), range: r.request().headers().range ?? null, type: r.headers()['content-type'] ?? '' });
  if (u.pathname.startsWith(`/v1/map/tiles/${after.id}/`)) dynamicReqs.push(r.status());
});
const rendered = () =>
  page.evaluate((id) => {
    const m = window.__pgMap;
    const ids = m.getStyle().layers.filter((l) => l.source === `pgl-${id}`).map((l) => l.id);
    const fs = ids.length ? m.queryRenderedFeatures({ layers: ids }) : [];
    return { onMap: ids.length > 0, n: new Set(fs.map((f) => f.properties?.feature_id)).size };
  }, after.id);
await page.goto(`${BASE}/?city=${city.id}&ll=${lng0 + 0.0016},${lat0 + 0.001}&z=15`);
await page.waitForFunction((id) => window.__pgMap?.getSource(`pgl-${id}`), after.id, { timeout: 30_000 });
await idle(page);
await page.waitForTimeout(1500);
const r15 = await rendered();
check('viewer: archive layer renders all SYNTHETIC features', r15.onMap && r15.n === features.length, r15);
check(
  'archive read only by single Range requests (206, application/vnd.pmtiles); no dynamic tile requests',
  archiveReqs.length > 0 && archiveReqs.every((r) => r.range && /^bytes=\d+-\d*$/.test(r.range)) && archiveReqs.some((r) => r.status === 206) && archiveReqs.every((r) => [200, 206, 304].includes(r.status)) && archiveReqs.filter((r) => r.status === 206).every((r) => r.type.includes('pmtiles')) && dynamicReqs.length === 0,
  { archive: archiveReqs.slice(0, 6), dynamic: dynamicReqs.length },
);
await shot(page, 'pmtiles-z15.png');

// Overzoom past the archive max zoom (14).
await page.evaluate(([x, y]) => window.__pgMap.jumpTo({ center: [x, y], zoom: 17.5 }), [lng0 + 0.0004, lat0 + 0.00025]);
await idle(page);
await page.waitForTimeout(800);
const r17 = await rendered();
check('overzoom past the archive max zoom keeps the features', r17.n > 0, r17);

// Feature card from the archive tile's feature_id.
const target = await page.evaluate((id) => {
  const m = window.__pgMap;
  const r = m.getCanvas().getBoundingClientRect();
  const p = [r.width / 2, r.height / 2];
  const f = m.queryRenderedFeatures(p, { layers: [`pgl-${id}-fill`] })[0];
  return f ? { x: r.left + p[0], y: r.top + p[1], fid: f.properties.feature_id } : null;
}, after.id);
if (target) await page.mouse.click(target.x, target.y);
await page.locator('.map-inspect__server').waitFor({ timeout: 20_000 }).catch(() => {});
const card = await page.locator('.map-inspect').innerText().catch(() => '');
check('feature card opens from an archive tile (server card by feature_id)', Boolean(target?.fid) && card.includes('SYNTHETIC TEST PMTiles') && new URL(page.url()).searchParams.get('feature') === target.fid, { fid: target?.fid, card: card.slice(0, 200) });
await shot(page, 'pmtiles-card.png');

// Toggle off and on.
const box = page.locator(`.map-layer[data-layer-id="${after.id}"]`).getByRole('checkbox');
await box.uncheck();
await page.waitForTimeout(600);
const off = await rendered();
await box.check();
await idle(page);
await page.waitForTimeout(800);
const on = await rendered();
check('toggle hides and restores the archive layer', !off.onMap && on.onMap && on.n > 0, { off, on });

// Reload: renders again (browser cache may answer, the server still authorizes).
archiveReqs.length = 0;
await page.reload();
await page.waitForFunction((id) => window.__pgMap?.getSource(`pgl-${id}`), after.id, { timeout: 30_000 });
await idle(page);
await page.waitForTimeout(1200);
const rr = await rendered();
check('reload renders the archive layer again', rr.n > 0, { rr, requests: archiveReqs.length });

// Archive failure (volume missing -> 503) is shown on the layer card, the map keeps working.
await page.route(`**/v1/map/archives/${after.id}.pmtiles`, (route) =>
  route.fulfill({ status: 503, contentType: 'application/problem+json', body: JSON.stringify({ type: 'about:blank', title: 'pmtiles_artifact_missing', status: 503, detail: 'SYNTHETIC TEST', code: 'pmtiles_artifact_missing', request_id: crypto.randomUUID(), current_revision_id: null, field_errors: [], blockers: [] }) }),
);
await page.reload();
await page.waitForSelector(`.map-layer[data-layer-id="${after.id}"]`, { timeout: 30_000 });
const failNotice = await page.locator(`.map-layer[data-layer-id="${after.id}"]`).getByText(/не загрузил/).waitFor({ timeout: 20_000 }).then(() => true).catch(() => false);
await page.locator(`.map-layer[data-layer-id="${after.id}"]`).scrollIntoViewIfNeeded();
await shot(page, 'pmtiles-503.png');
check('archive 503 is shown on the layer card instead of a silent empty map', failNotice);
await page.unroute(`**/v1/map/archives/${after.id}.pmtiles`);
check('no page errors in the viewer session', pageErrors.length === 0, pageErrors.slice(0, 3));
await vw.ctx.close();

await browser.close();
report.finishedAt = new Date().toISOString();
report.passed = report.checks.every((c) => c.pass);
report.synthetic = { dataset: ds.body?.id, layer: after?.id, archiveBytes, archiveTiles };
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`\n${report.checks.filter((c) => c.pass).length}/${report.checks.length} checks passed`);
process.exit(report.passed ? 0 : 1);
