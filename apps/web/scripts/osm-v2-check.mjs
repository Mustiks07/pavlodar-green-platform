// Live acceptance of the published OSM v2 layers (contract 1.13.0, 60 144 public objects) as a
// plain viewer against the running API, read-only, no mocks: roads with MultiLineString parts are
// drawn, the roads layer toggles, a click on a road opens the canonical feature card (getMapFeature)
// with its highlight, a reload / deep link keeps the selected object, no 4xx/5xx for public layers,
// and cold map readiness (performance mark pg:map-ready, P-01 <= 5 s) over five fresh contexts.
//
//   PG_TEST_CREDENTIALS=<path> PG_CITY_ID=<uuid> node scripts/osm-v2-check.mjs
// Runs against the dev server (default http://localhost:5173 -> the API on :8001).
import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sessionCookie } from "./lib/session-login.mjs";

const BASE = process.env.PG_WEB_URL ?? "http://localhost:5173";
const CITY = process.env.PG_CITY_ID ?? "2de4e9e4-1602-5bdb-b17d-13df22510458";
const OUT = resolve("../../docs/evidence/wp03-osm-v2");
const creds = process.env.PG_TEST_CREDENTIALS
  ? JSON.parse(readFileSync(process.env.PG_TEST_CREDENTIALS, "utf8"))
  : null;
mkdirSync(OUT, { recursive: true });
const report = {
  base: BASE,
  city: CITY,
  startedAt: new Date().toISOString(),
  checks: [],
  shots: [],
  measurements: {},
};
const check = (name, pass, detail) => {
  report.checks.push({ name, pass, detail });
  console.log(
    `${pass ? "PASS" : "FAIL"} ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ""}`,
  );
};
const shot = async (page, file) => {
  await page.screenshot({ path: join(OUT, file) });
  report.shots.push(`docs/evidence/wp03-osm-v2/${file}`);
};

async function signIn(browser, role, opts = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "ru-RU",
    ...opts,
  });
  const page = await ctx.newPage();
  if (await sessionCookie(ctx, role, BASE)) return { ctx, page };
  await page.goto(BASE + "/");
  const btn = page
    .getByRole("button", { name: "Войти через корпоративную учётную запись" })
    .first();
  await btn.waitFor({ timeout: 20_000 });
  await Promise.all([
    page.waitForURL(/openid-connect\/auth/, {
      waitUntil: "commit",
      timeout: 20_000,
    }),
    btn.click(),
  ]);
  await page.fill("#username", role);
  await page.fill("#password", creds[role]);
  await page.click("#kc-login");
  // The OIDC callback may land on the allow-listed dev origin; the session cookie is host-scoped
  // (localhost), so the check continues on BASE.
  await page.waitForURL(
    (u) =>
      u.hostname === "localhost" &&
      !u.pathname.startsWith("/auth/") &&
      !u.pathname.includes("openid-connect"),
    { waitUntil: "commit", timeout: 20_000 },
  );
  if (new URL(page.url()).origin !== new URL(BASE).origin)
    await page.goto(BASE + "/");
  return { ctx, page };
}
const idle = (page) =>
  page.evaluate(
    () =>
      new Promise((r) =>
        window.__pgMap.loaded()
          ? r(true)
          : window.__pgMap.once("idle", () => r(true)),
      ),
  );

const browser = await chromium.launch({
  channel: process.env.PG_BROWSER_CHANNEL ?? "msedge",
});
const { ctx, page } = await signIn(browser, "viewer");
const failures = [];
page.on("response", (r) => {
  const u = new URL(r.url());
  if (
    r.status() >= 400 &&
    (u.pathname.startsWith("/v1/") || u.pathname.startsWith("/health"))
  )
    failures.push({ status: r.status(), path: u.pathname });
});
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

// Central Pavlodar at a street zoom: dense roads, buildings and green.
const view = `/?city=${CITY}&ll=76.9535,52.2885&z=16`;
await page.goto(BASE + view);
await page.waitForFunction(() => window.__pgMap?.isStyleLoaded(), null, {
  timeout: 30_000,
});
await idle(page);
await page.waitForTimeout(1500);
const layers =
  (await page.evaluate(
    async (c) =>
      (await (await fetch(`/v1/map/layers?city_id=${c}&limit=200`)).json())
        .items,
    CITY,
  )) ?? [];
const roads = layers.find((l) => l.category === "road");
check(
  "viewer sees the published public layers of the city",
  layers.length >= 8 && Boolean(roads),
  { layers: layers.map((l) => `${l.name} (${l.geometry_type})`) },
);

const roadStats = await page.evaluate((id) => {
  const m = window.__pgMap;
  const ids = m
    .getStyle()
    .layers.filter((l) => l.source === `pgl-${id}`)
    .map((l) => l.id);
  const feats = m.queryRenderedFeatures({ layers: ids });
  const types = {};
  for (const f of feats)
    types[f.geometry.type] = (types[f.geometry.type] ?? 0) + 1;
  return { ids, rendered: feats.length, types };
}, roads.id);
report.measurements.roads = roadStats;
check(
  "roads are drawn, MultiLineString parts included",
  roadStats.rendered > 50 && (roadStats.types.MultiLineString ?? 0) > 0,
  roadStats.types,
);

// Toggle the roads layer off and on from the layer panel.
const toggle = page
  .getByRole("checkbox", { name: new RegExp(roads.name) })
  .first();
const visible = () =>
  page.evaluate(
    (ids) =>
      ids.every(
        (id) =>
          window.__pgMap.getLayer(id) &&
          window.__pgMap.getLayoutProperty(id, "visibility") !== "none",
      ),
    roadStats.ids,
  );
const before = await visible();
await toggle.click();
await page.waitForTimeout(600);
const hidden = !(await page.evaluate(
  (ids) =>
    ids.some(
      (id) =>
        window.__pgMap.getLayer(id) &&
        window.__pgMap.getLayoutProperty(id, "visibility") !== "none",
    ),
  roadStats.ids,
));
await toggle.click();
await page.waitForTimeout(600);
await idle(page);
const shown = await page.evaluate((id) => {
  const m = window.__pgMap;
  const ids = m
    .getStyle()
    .layers.filter((l) => l.source === `pgl-${id}`)
    .map((l) => l.id);
  return (
    ids.length > 0 &&
    ids.every((x) => m.getLayoutProperty(x, "visibility") !== "none") &&
    m.queryRenderedFeatures({ layers: ids }).length > 0
  );
}, roads.id);
check("roads layer toggles off and back on", before && hidden && shown, {
  before,
  hidden,
  shown,
});

// Click a road whose canonical server geometry is a MultiLineString (a tile may also split a plain
// LineString at its edge, so the tile type alone proves nothing). Candidates come from the roads
// drawn at an overview zoom; their server geometry is read with getMapFeature (GET only).
await page.evaluate(() =>
  window.__pgMap.jumpTo({ center: [76.955, 52.285], zoom: 13 }),
);
await idle(page);
await page.waitForTimeout(1500);
const candidates = await page.evaluate((id) => {
  const m = window.__pgMap;
  const ids = m
    .getStyle()
    .layers.filter((l) => l.source === `pgl-${id}`)
    .map((l) => l.id);
  return [
    ...new Set(
      m
        .queryRenderedFeatures({ layers: ids })
        .map((f) => f.properties.feature_id)
        .filter(Boolean),
    ),
  ].slice(0, 600);
}, roads.id);
const multi = await page.evaluate(async (ids) => {
  for (let i = 0; i < ids.length; i += 20) {
    const batch = await Promise.all(
      ids
        .slice(i, i + 20)
        .map(async (fid) =>
          (await fetch(`/v1/map/features/${fid}`)).json().catch(() => null),
        ),
    );
    const hit = batch.find((f) => f?.geometry?.type === "MultiLineString");
    if (hit) return { id: hit.id, coordinates: hit.geometry.coordinates };
  }
  return null;
}, candidates);
report.measurements.multiLineSearch = {
  candidates: candidates.length,
  found: multi?.id ?? null,
};
let target = null;
if (multi) {
  const [lon, lat] =
    multi.coordinates[0][Math.floor(multi.coordinates[0].length / 2)];
  await page.evaluate(
    ([x, y]) => window.__pgMap.jumpTo({ center: [x, y], zoom: 17 }),
    [lon, lat],
  );
  await idle(page);
  await page.waitForTimeout(1200);
  target = await page.evaluate(
    ([id, fid]) => {
      const m = window.__pgMap;
      const ids = m
        .getStyle()
        .layers.filter((l) => l.source === `pgl-${id}`)
        .map((l) => l.id);
      const c = m.getCanvas();
      const r = c.getBoundingClientRect();
      for (let y = 60; y < c.clientHeight - 60; y += 4)
        for (let x = 60; x < c.clientWidth - 60; x += 4) {
          const f = m.queryRenderedFeatures([x, y], { layers: ids })[0];
          if (
            f?.properties?.feature_id === fid &&
            document.elementFromPoint(r.left + x, r.top + y) === c
          )
            return { x: r.left + x, y: r.top + y, id: fid };
        }
      return null;
    },
    [roads.id, multi.id],
  );
}
let cardOk = false;
let featureParam = null;
let serverGeometry = null;
if (target) {
  const featureResponse = page
    .waitForResponse(
      (r) =>
        /\/v1\/map\/features\/[0-9a-f-]+/.test(r.url()) &&
        r.request().method() === "GET",
      { timeout: 15_000 },
    )
    .catch(() => null);
  await page.mouse.click(target.x, target.y);
  const resp = await featureResponse;
  serverGeometry = resp
    ? ((await resp.json().catch(() => null))?.geometry?.type ?? null)
    : null;
  cardOk = await page
    .locator(".map-inspect .map-inspect__server")
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  featureParam = new URL(page.url()).searchParams.get("feature");
  await page.waitForTimeout(800);
}
const highlight = await page.evaluate(() =>
  window.__pgMap.getSource("feature-highlight")
    ? window.__pgMap.querySourceFeatures("feature-highlight").length
    : 0,
);
check(
  "click on a road stored as MultiLineString opens the canonical card and highlights it",
  Boolean(target) &&
    cardOk &&
    Boolean(featureParam) &&
    highlight > 0 &&
    serverGeometry === "MultiLineString",
  { target: target?.id, featureParam, serverGeometry, highlight },
);
await shot(page, "road-card.png");

// Reload and a cold deep link keep the selected object.
const deep = page.url();
await page.reload();
const afterReload = await page
  .locator(".map-inspect .map-inspect__server")
  .waitFor({ timeout: 20_000 })
  .then(() => true)
  .catch(() => false);
const sameFeature =
  new URL(page.url()).searchParams.get("feature") === featureParam;
const fresh = await signIn(browser, "viewer");
await fresh.page.goto(deep);
const deepOk = await fresh.page
  .locator(".map-inspect .map-inspect__server")
  .waitFor({ timeout: 20_000 })
  .then(() => true)
  .catch(() => false);
const deepHighlight = deepOk
  ? await fresh.page
      .waitForFunction(
        () =>
          window.__pgMap?.getSource("feature-highlight") &&
          window.__pgMap.querySourceFeatures("feature-highlight").length > 0,
        null,
        { timeout: 15_000 },
      )
      .then(() => true)
      .catch(() => false)
  : false;
await fresh.ctx.close();
check(
  "reload and a deep link in a new session keep the selected road with its card and highlight",
  afterReload && sameFeature && deepOk && deepHighlight,
  { afterReload, sameFeature, deepOk, deepHighlight },
);

// Every public OSM layer: a click on one of its objects opens the canonical card (getMapFeature),
// titled with the server label, with the geometry family of the layer.
const osmLayers = layers.filter((l) =>
  ["building", "existing_green", "water", "social_facility", "road"].includes(
    l.category,
  ),
);
const cards = [];
const VIEWS = [
  "76.9535,52.2885&z=16",
  "76.9800,52.2900&z=14",
  "76.9500,52.3000&z=13",
];
for (const layer of osmLayers) {
  let at = null;
  for (const view of VIEWS) {
    await page.goto(`${BASE}/?city=${CITY}&ll=${view}`);
    await page
      .waitForFunction(
        (id) => window.__pgMap?.getSource(`pgl-${id}`),
        layer.id,
        { timeout: 30_000 },
      )
      .catch(() => {});
    await idle(page);
    await page.waitForTimeout(800);
    // The topmost platform object at a reachable pixel must belong to this layer.
    at = await page.evaluate((id) => {
      const m = window.__pgMap;
      const ids = m
        .getStyle()
        .layers.filter((l) => l.source === `pgl-${id}`)
        .map((l) => l.id);
      const others = m
        .getStyle()
        .layers.filter(
          (l) => l.source?.startsWith?.("pgl-") && l.source !== `pgl-${id}`,
        )
        .map((l) => l.id);
      const c = m.getCanvas();
      const r = c.getBoundingClientRect();
      for (let y = 80; y < c.clientHeight - 80; y += 5)
        for (let x = 80; x < c.clientWidth - 80; x += 5) {
          // Topmost platform object at this pixel (basemap layers are not candidates).
          const top = m.queryRenderedFeatures([x, y], {
            layers: [...ids, ...others],
          })[0];
          if (
            top &&
            ids.includes(top.layer.id) &&
            document.elementFromPoint(r.left + x, r.top + y) === c
          ) {
            return {
              x: r.left + x,
              y: r.top + y,
              id: top.properties.feature_id,
              type: top.geometry.type,
            };
          }
        }
      return null;
    }, layer.id);
    if (at) break;
  }
  if (!at) {
    cards.push({ layer: layer.name, found: false });
    continue;
  }
  const response = page
    .waitForResponse((r) => /\/v1\/map\/features\/[0-9a-f-]+/.test(r.url()), {
      timeout: 15_000,
    })
    .catch(() => null);
  await page.mouse.click(at.x, at.y);
  const res = await response;
  const body = res ? await res.json().catch(() => null) : null;
  const opened = await page
    .locator(".map-inspect .map-inspect__server")
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  const title = await page
    .locator(".map-inspect")
    .first()
    .innerText()
    .catch(() => "");
  cards.push({
    layer: layer.name,
    status: res?.status() ?? null,
    geometry: body?.geometry?.type ?? null,
    opened,
    titled: Boolean(body?.label) && title.length > 0,
  });
}
report.measurements.cards = cards;
check(
  "every public OSM layer: a click opens the canonical card (getMapFeature 200) with the server geometry",
  cards.length >= 6 &&
    cards.every((c) => c.status === 200 && c.opened && c.titled && c.geometry),
  cards,
);
await shot(page, "last-card.png");

check(
  "viewer: no 4xx/5xx from the API while browsing public layers",
  failures.length === 0,
  failures.slice(0, 5),
);
check("no page errors", errors.length === 0, errors.slice(0, 3));
await shot(page, "city-center.png");
await ctx.close();

// Cold readiness with all public layers: five fresh contexts, city view.
const cold = [];
for (let i = 0; i < 5; i++) {
  const s = await signIn(browser, "viewer");
  const t0 = Date.now();
  await s.page.goto(`${BASE}/?city=${CITY}`);
  const ready = await s.page
    .waitForFunction(
      () => performance.getEntriesByName("pg:map-ready").length > 0,
      null,
      { timeout: 60_000 },
    )
    .then(() =>
      s.page.evaluate(() =>
        Math.round(performance.getEntriesByName("pg:map-ready")[0].startTime),
      ),
    )
    .catch(() => null);
  const fps = await s.page.evaluate(
    () =>
      new Promise((r) => {
        const m = window.__pgMap;
        let n = 0;
        const t = performance.now();
        const step = () => {
          m.setBearing((m.getBearing() + 2) % 360);
          n += 1;
          if (performance.now() - t < 2000) requestAnimationFrame(step);
          else {
            m.setBearing(0);
            r(Math.round((n / (performance.now() - t)) * 1000));
          }
        };
        requestAnimationFrame(step);
      }),
  );
  cold.push({ readyMs: ready, wallMs: Date.now() - t0, fps });
  await s.ctx.close();
}
const sorted = cold.map((c) => c.readyMs ?? Infinity).sort((a, b) => a - b);
report.measurements.cold = cold;
// Dev server (unminified, no throttling): a median for orientation; P-01 itself is p95 over 30 cold
// runs of the production build with a 20 Mbit/s profile (scripts/p01-bench.mjs).
const median = sorted[Math.floor(sorted.length / 2)];
check(
  "cold map readiness with 60 144 public objects, dev server median <= 5 s (P-01 verdict: p01-bench)",
  median <= 5000,
  {
    medianMs: median,
    readyMs: cold.map((c) => c.readyMs),
    fps: cold.map((c) => c.fps),
  },
);

await browser.close();
report.finishedAt = new Date().toISOString();
report.passed = report.checks.every((c) => c.pass);
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(
  `\n${report.checks.filter((c) => c.pass).length}/${report.checks.length} checks passed`,
);
process.exit(report.passed ? 0 : 1);
