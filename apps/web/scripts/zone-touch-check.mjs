// Live touch/mobile zone editing against the real API, on a phone viewport with touch input:
// finger pan vs. vertex drag, tap slop, tap-to-select, midpoint tap insert, on-map delete,
// two-finger gesture cancels an edit, keyboard parity, reload keeps the draft, 412 keeps my
// contour. Creates only SYNTHETIC TEST zones. Run it in the disposable environment:
//
//   uv run python -m tools.dev.browser_test_env --cwd apps/web -- node scripts/zone-touch-check.mjs
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5173';
const OUT = resolve('../../docs/evidence/wp04-zone-touch');
const creds = JSON.parse(readFileSync(process.env.PG_TEST_CREDENTIALS ?? '', 'utf8'));
mkdirSync(OUT, { recursive: true });

const report = { base: BASE, startedAt: new Date().toISOString(), checks: [], shots: [] };
const check = (name, pass, detail) => {
  report.checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
};
const shot = async (page, file) => {
  await page.screenshot({ path: join(OUT, file) });
  report.shots.push(`docs/evidence/wp04-zone-touch/${file}`);
};
const settle = (page) =>
  page.waitForFunction(() => !document.querySelector('.pg-state .pg-spinner, .pg-skeleton'), null, { timeout: 15_000 }).catch(() => {});
const apiCall = (page, method, path, body, extra = {}) =>
  page.evaluate(
    async ({ method, path, body, extra }) => {
      const me = await (await fetch('/v1/me')).json();
      const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token, 'Idempotency-Key': crypto.randomUUID(), ...extra };
      const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, etag: res.headers.get('ETag'), body: await res.json().catch(() => null) };
    },
    { method, path, body, extra },
  );

const browser = await chromium.launch({ channel: process.env.PG_BROWSER_CHANNEL ?? 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, locale: 'ru-RU' });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
const cdp = await ctx.newCDPSession(page);

await page.goto(BASE + '/');
const btn = page.getByRole('button', { name: 'Войти через корпоративную учётную запись' }).first();
await btn.waitFor({ timeout: 20_000 });
await Promise.all([page.waitForURL(/openid-connect\/auth/, { waitUntil: 'commit', timeout: 20_000 }), btn.click()]);
await page.waitForSelector('#username');
await page.fill('#username', 'specialist');
await page.fill('#password', creds.specialist);
await page.click('#kc-login');
await page.waitForURL((u) => u.origin === new URL(BASE).origin && !u.pathname.startsWith('/auth/'), { waitUntil: 'commit', timeout: 20_000 });
await page.waitForTimeout(1500);

const city = (await page.evaluate(async () => (await fetch('/v1/cities')).json())).items[0];
const ring = city.boundary.type === 'Polygon' ? city.boundary.coordinates[0] : city.boundary.coordinates[0][0];
const cx = (Math.min(...ring.map((c) => c[0])) + Math.max(...ring.map((c) => c[0]))) / 2;
const cy = (Math.min(...ring.map((c) => c[1])) + Math.max(...ring.map((c) => c[1]))) / 2;
const d = 0.0012;
const stamp = new Date().toISOString().slice(11, 19);
const created = await apiCall(page, 'POST', '/v1/zones', {
  city_id: city.id,
  name: `SYNTHETIC TEST касание ${stamp}`,
  purpose: 'courtyard',
  geometry: { type: 'Polygon', coordinates: [[[cx - d, cy - d], [cx + d, cy - d], [cx + d, cy + d], [cx - d, cy + d], [cx - d, cy - d]]] },
});
check('synthetic zone created (setup)', created.status === 201, { status: created.status });
const zoneId = created.body.id;

// Camera slightly south of the zone so the contour sits in the visible part above the sheet.
await page.goto(`${BASE}/?city=${city.id}&zone=${zoneId}&ll=${cx.toFixed(5)},${(cy - 0.0016).toFixed(5)}&z=16`);
await page.waitForSelector('.zone-card', { timeout: 20_000 });
await settle(page);
await page.getByRole('button', { name: 'Изменить границы участка' }).click();
await page.waitForFunction(() => (window.__pgMap?.querySourceFeatures('draw') ?? []).filter((f) => f.properties.role === 'vertex').length >= 4, null, { timeout: 15_000 });
await page.waitForTimeout(500);

const status = () => page.locator('.draw-status').innerText();
const vertices = () => page.evaluate(() => {
  const fs = window.__pgMap.querySourceFeatures('draw').filter((f) => f.properties.role === 'vertex');
  const by = new Map(fs.map((f) => [f.properties.i, f.geometry.coordinates]));
  return [...by.keys()].sort((a, b) => a - b).map((i) => by.get(i));
});
const handlePx = (role, i) =>
  page.evaluate(({ role, i }) => {
    const m = window.__pgMap;
    const f = m.querySourceFeatures('draw').find((x) => x.properties.role === role && x.properties.i === i);
    if (!f) return null;
    const p = m.project(f.geometry.coordinates);
    const r = m.getCanvas().getBoundingClientRect();
    return [r.left + p.x, r.top + p.y];
  }, { role, i });
const center = () => page.evaluate(() => window.__pgMap.getCenter().toArray());
// Handles the finger can reach: on screen and not under the bottom sheet or a toolbar.
const reachable = (role) =>
  page.evaluate((role) => {
    const m = window.__pgMap;
    const r = m.getCanvas().getBoundingClientRect();
    return m
      .querySourceFeatures('draw')
      .filter((f) => f.properties.role === role)
      .map((f) => {
        const p = m.project(f.geometry.coordinates);
        const x = r.left + p.x;
        const y = r.top + p.y;
        return { i: f.properties.i, x, y, ok: document.elementFromPoint(x, y) === m.getCanvas() && document.elementFromPoint(x + 45, y + 35) === m.getCanvas() };
      })
      .filter((h, k, all) => h.ok && all.findIndex((o) => o.i === h.i) === k)
      .sort((a, b) => a.i - b.i);
  }, role);
// Same framing rule as the app: keep the contour clear of the bottom sheet.
const frameZone = async () => {
  await page.evaluate((b) => {
    const m = window.__pgMap;
    const c = m.getCanvas().getBoundingClientRect();
    const sheet = document.querySelector('.pg-panel:not(.is-collapsed)')?.getBoundingClientRect();
    const bottom = sheet && sheet.top > c.top ? c.bottom - sheet.top : 0;
    m.fitBounds(b, { padding: { top: 39, left: 39, right: 39, bottom: bottom + 39 }, maxZoom: 17, duration: 0 });
  }, [cx - d, cy - d, cx + d, cy + d]);
  await page.waitForTimeout(500);
};
const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
async function fingerDrag(from, to, steps = 10) {
  await touch('touchStart', [from]);
  for (let s = 1; s <= steps; s++) {
    await touch('touchMove', [[from[0] + ((to[0] - from[0]) * s) / steps, from[1] + ((to[1] - from[1]) * s) / steps]]);
    await page.waitForTimeout(16);
  }
  await touch('touchEnd', []);
  await page.waitForTimeout(400);
}
const tap = async (p) => {
  await touch('touchStart', [p]);
  await touch('touchEnd', []);
  await page.waitForTimeout(450);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const framedAtStart = await reachable('vertex');
const sheetH = await page.evaluate(() => Math.round(document.querySelector('.pg-panel:not(.is-collapsed)')?.getBoundingClientRect().height ?? 0));
check('editing on a phone: compact sheet and the whole contour framed above it', framedAtStart.length === 4 && sheetH <= 844 * 0.4, { reachable: framedAtStart.map((h) => h.i), sheetH });
await shot(page, 'touch-edit-start.png');

// 1. A finger on empty map pans and leaves the contour alone.
const box = await page.locator('.map-canvas').boundingBox();
const v0 = await vertices();
const c0 = await center();
await fingerDrag([box.x + 40, box.y + 120], [box.x + 120, box.y + 200]);
const c1 = await center();
check('finger on empty map pans the map; contour unchanged', !same(c0, c1) && same(v0, await vertices()), { c0, c1 });

// 2. A finger starting on a vertex drags it and does not pan.
await frameZone();
const cFramed = await center();
const [h1] = await reachable('vertex');
check('a vertex is reachable by the finger above the sheet (setup)', Boolean(h1), await reachable('vertex'));
const before = await vertices();
await fingerDrag([h1.x, h1.y], [h1.x + 40, h1.y + 30]);
const after = await vertices();
const others = before.every((v, i) => i === h1.i || same(v, after[i]));
check('finger drag on a vertex moves it, keeps the count and does not pan the map', !same(before[h1.i], after[h1.i]) && others && after.length === 4 && same(cFramed, await center()), { i: h1.i, before: before[h1.i], after: after[h1.i] });
check('dragged vertex becomes the selected one (on-map toolbar)', (await page.locator('.draw-vertex-bar').innerText().catch(() => '')).includes(`Вершина ${h1.i + 1} из 4`));
await shot(page, 'touch-vertex-dragged.png');

// 3. Tap slop: 4 px of jitter on a vertex is a tap (selects), not a move.
const h3 = (await reachable('vertex')).find((h) => h.i !== h1.i);
const beforeJitter = await vertices();
await fingerDrag([h3.x, h3.y], [h3.x + 3, h3.y + 2], 3);
check('finger jitter under the slop does not move the vertex; it selects it', same(beforeJitter, await vertices()) && (await page.locator('.draw-vertex-bar').innerText()).includes(`Вершина ${h3.i + 1} из 4`));

// 4. Tap on a midpoint inserts a vertex there and selects it.
await page.waitForFunction(() => window.__pgMap.querySourceFeatures('draw').some((f) => f.properties.role === 'mid'), null, { timeout: 5000 });
const [m0] = await reachable('mid');
await tap([m0.x, m0.y]);
check('tap on a midpoint inserts a vertex (5) and selects it', (await status()).includes('вершин: 5') && (await page.locator('.draw-vertex-bar').innerText()).includes(`Вершина ${m0.i + 2} из 5`), { mid: m0.i, status: await status() });

// 5. Delete through the on-map toolbar.
await page.locator('.draw-vertex-bar').getByRole('button', { name: 'Удалить' }).tap();
await page.waitForTimeout(300);
check('on-map "Удалить" removes the selected vertex (back to 4)', (await status()).includes('вершин: 4'), { status: await status() });
const barBox = await page.locator('.draw-vertex-bar button').first().boundingBox();
check('on-map toolbar buttons are at least 44 px tall for fingers', barBox && barBox.height >= 44, barBox);

// 6. Two fingers starting on a vertex are pan/zoom: the vertex does not move.
const [hp] = await reachable('vertex');
const p2 = [hp.x, hp.y];
const beforePinch = await vertices();
await touch('touchStart', [p2, [p2[0] + 80, p2[1] + 80]]);
for (let s = 1; s <= 8; s++) {
  await touch('touchMove', [[p2[0] - s * 4, p2[1] - s * 4], [p2[0] + 80 + s * 4, p2[1] + 80 + s * 4]]);
  await page.waitForTimeout(16);
}
await touch('touchEnd', []);
await page.waitForTimeout(500);
const afterPinch = await vertices();
check('two-finger gesture never moves a vertex (pinch is zoom)', afterPinch.length === 4 && afterPinch.every((v, i) => Math.abs(v[0] - beforePinch[i][0]) < 1e-9 && Math.abs(v[1] - beforePinch[i][1]) < 1e-9));

// 7. Keyboard parity on the same contour.
await page.locator('.map-canvas').focus();
await page.keyboard.press('Escape');
await page.keyboard.press(']');
await page.waitForTimeout(150);
const selKb = await page.locator('.draw-vertex-bar').innerText().catch(() => '');
const k0 = await vertices();
const cKb = await center();
await page.keyboard.press('ArrowRight');
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(200);
const k1 = await vertices();
const movedPx = await page.evaluate(([a, b]) => {
  const m = window.__pgMap;
  return Math.round(m.project(b).x - m.project(a).x);
}, [k0[0], k1[0]]);
check('keyboard: ] selects vertex 1, arrows nudge it 5 px per press, map does not pan', selKb.includes('Вершина 1 из 4') && movedPx === 10 && same(cKb, await center()), { selKb, movedPx });
await page.keyboard.press('i');
await page.waitForTimeout(150);
const afterInsert = await status();
await page.keyboard.press('Delete');
await page.waitForTimeout(150);
const afterDelete = await status();
await page.keyboard.press('Control+z');
await page.waitForTimeout(150);
const afterUndo = await status();
check('keyboard: I inserts after the selected vertex, Delete removes, Ctrl+Z undoes', afterInsert.includes('вершин: 5') && afterDelete.includes('вершин: 4') && afterUndo.includes('вершин: 5'), { afterInsert, afterDelete, afterUndo });
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
check('Esc clears the selection and hides the toolbar', (await page.locator('.draw-vertex-bar').count()) === 0);

// 8. Reload keeps the unsaved contour.
const draftBefore = await vertices();
await page.reload();
await settle(page);
await page.waitForFunction(() => (window.__pgMap?.querySourceFeatures('draw') ?? []).some((f) => f.properties.role === 'vertex'), null, { timeout: 20_000 }).catch(() => {});
await page.waitForTimeout(600);
const draftAfter = await vertices();
const restoredNote = await page.getByText('Восстановлен несохранённый контур').isVisible().catch(() => false);
check('reload restores the touched contour (local draft, labelled)', restoredNote && draftAfter.length === draftBefore.length && draftAfter.every((v, i) => Math.abs(v[0] - draftBefore[i][0]) < 1e-9), { n: draftAfter.length });

// 9. 412: someone else saves first; my contour stays; explicit keep saves it on the new version.
const fresh = await page.evaluate(async (id) => {
  const r = await fetch(`/v1/zones/${id}`);
  return { etag: r.headers.get('ETag'), body: await r.json() };
}, zoneId);
const other = await apiCall(page, 'PUT', `/v1/zones/${zoneId}`, { city_id: city.id, name: `${fresh.body.name} (параллельно)`, purpose: fresh.body.purpose, geometry: fresh.body.geometry }, { 'If-Match': fresh.etag });
check('concurrent updateZone accepted (setup)', other.status === 200, { status: other.status });
await page.getByRole('button', { name: 'Сохранить новую версию границ' }).tap();
const conflict = await page.getByText('Участок изменён другим пользователем').waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
const kept = (await vertices()).length === draftAfter.length;
await page.getByText('Участок изменён другим пользователем').scrollIntoViewIfNeeded().catch(() => {});
await shot(page, 'touch-conflict-412.png');
check('stale If-Match -> 412 explained; my touched contour kept', conflict && kept);
await page.getByRole('button', { name: 'Сохранить мой контур поверх новой версии' }).tap();
await page.waitForTimeout(800);
await page.getByRole('button', { name: 'Сохранить новую версию границ' }).tap();
await page.waitForSelector('.zone-card', { timeout: 20_000 }).catch(() => {});
const z = await page.evaluate(async (id) => (await fetch(`/v1/zones/${id}`)).json(), zoneId);
check('after explicit keep: server saved my contour on a new version, concurrent rename preserved', z.version_id !== other.body?.version_id && z.geometry.coordinates[0].length === draftAfter.length + 1 && z.name.includes('(параллельно)'), { vertices: z.geometry.coordinates[0].length - 1, name: z.name });

// Dark theme with the toolbar visible.
await page.getByRole('button', { name: 'Изменить границы участка' }).tap();
await page.waitForFunction(() => (window.__pgMap?.querySourceFeatures('draw') ?? []).some((f) => f.properties.role === 'vertex'), null, { timeout: 15_000 });
await page.waitForTimeout(400);
await tap(await handlePx('vertex', 0));
await page.emulateMedia({ colorScheme: 'dark' });
await page.waitForTimeout(500);
await shot(page, 'touch-selected-dark.png');
await page.emulateMedia({ colorScheme: 'light' });
await page.waitForTimeout(300);
await shot(page, 'touch-selected-light.png');
check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3));

await browser.close();
report.finishedAt = new Date().toISOString();
report.passed = report.checks.every((c) => c.pass);
report.synthetic = { zone: zoneId };
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`\n${report.checks.filter((c) => c.pass).length}/${report.checks.length} checks passed`);
process.exit(report.passed ? 0 : 1);
