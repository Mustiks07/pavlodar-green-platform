// Live restricted dataset access administration on the real API (disposable environment): admin
// city rights manage grants but do not open content, grant with reason + confirmation, 409 when
// another admin granted first, 404 when the grant is already revoked, self-revoke warning,
// reload, not-restricted / unknown dataset, forbidden for non-admins, audit history, phone and
// dark theme. Creates only SYNTHETIC TEST data.
//
//   uv run python -m tools.dev.browser_test_env --cwd apps/web -- node scripts/grants-check.mjs
import { chromium } from '@playwright/test';
import { sessionCookie } from './lib/session-login.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5173';
const OUT = resolve('../../docs/evidence/wp05-grants');
const creds = JSON.parse(readFileSync(process.env.PG_TEST_CREDENTIALS ?? '', 'utf8'));
mkdirSync(OUT, { recursive: true });

const report = { base: BASE, startedAt: new Date().toISOString(), checks: [], shots: [] };
const check = (name, pass, detail) => {
  report.checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
};
const shot = async (page, file) => {
  await page.screenshot({ path: join(OUT, file), fullPage: false });
  report.shots.push(`docs/evidence/wp05-grants/${file}`);
};
const settle = (page) =>
  page.waitForFunction(() => !document.querySelector('.pg-state .pg-spinner, .pg-skeleton'), null, { timeout: 15_000 }).catch(() => {});
const apiCall = (page, method, path, body) =>
  page.evaluate(
    async ({ method, path, body }) => {
      const me = await (await fetch('/v1/me')).json();
      const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token, 'Idempotency-Key': crypto.randomUUID() };
      const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    { method, path, body },
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

const browser = await chromium.launch({ channel: process.env.PG_BROWSER_CHANNEL ?? 'msedge' });
const stamp = new Date().toISOString().slice(11, 19);
const pageErrors = [];

// Setup: a specialist registers a restricted and a public SYNTHETIC dataset (the creator gets the
// only grant of the restricted one).
const sp = await login(browser, 'specialist');
const cityId = (await sp.page.evaluate(async () => (await fetch('/v1/cities')).json())).items[0].id;
const mkDataset = (name, access_level) =>
  apiCall(sp.page, 'POST', '/v1/datasets', { city_id: cityId, name, kind: 'observations', owner: 'SYNTHETIC TEST', license: 'CC0-1.0', access_level, source_uri: null });
const restrictedName = `SYNTHETIC TEST закрытый набор ${stamp}`;
const restricted = (await mkDataset(restrictedName, 'restricted')).body;
const open = (await mkDataset(`SYNTHETIC TEST открытый набор ${stamp}`, 'public')).body;
check('setup: SYNTHETIC restricted and public datasets created by the specialist', Boolean(restricted?.id && open?.id), { restricted: restricted?.id, open: open?.id });
const spMe = await sp.page.evaluate(async () => (await fetch('/v1/me')).json());

const admin = await login(browser, 'admin');
const page = admin.page;
page.on('pageerror', (e) => pageErrors.push(String(e)));
const adMe = await page.evaluate(async () => (await fetch('/v1/me')).json());
const viewerCtx = await login(browser, 'viewer');
const vwMe = await viewerCtx.page.evaluate(async () => (await fetch('/v1/me')).json());

// Admin city rights do not open the content: the server hides the dataset from the admin.
const contentStatus = await page.evaluate(async (id) => (await fetch(`/v1/datasets/${id}/versions`)).status, restricted.id);
await page.goto(`${BASE}/admin?city=${cityId}`);
await settle(page);
const listedForAdmin = await page.locator('.acc-datasets').getByText(restrictedName).count();
check('admin without a grant: server returns 404 for content and the dataset is not listed', contentStatus === 404 && listedForAdmin === 0, { contentStatus, listedForAdmin });

// Open by id.
await page.getByLabel('Открыть набор по идентификатору').fill('not-a-uuid');
const invalidShown = await page.getByText('Нужен идентификатор UUID').isVisible();
await page.getByLabel('Открыть набор по идентификатору').fill(restricted.id);
await page.getByRole('button', { name: 'Открыть', exact: true }).click();
await page.locator('.acc-panel .acc-table').waitFor({ timeout: 20_000 });
await settle(page);
const panel = page.locator('.acc-panel');
const panelText = await panel.innerText();
const hiddenName = panelText.includes('Название скрыто');
const adminOnly = await panel.getByText('Только управление').isVisible();
const policy = await panel.getByText('Роль администратора не открывает содержимое').isVisible();
const creatorListed = (await panel.locator('.acc-table tbody tr').allInnerTexts()).some((r) => r.includes('SYNTHETIC TEST specialist'));
check('opened by id: name hidden, "management only" stated, policy shown, creator listed', invalidShown && hiddenName && adminOnly && policy && creatorListed, {
  invalidShown,
  hiddenName,
  adminOnly,
  policy,
  creatorListed,
});
check('URL keeps the opened dataset', new URL(page.url()).searchParams.get('grants') === restricted.id);
await shot(page, 'grants-admin-only.png');

// Grant to the viewer: reason is required, confirmation summarises the decision.
const userSelect = panel.locator('.acc-form').getByLabel(/^Пользователь города/);
const options = await userSelect.locator('option').allInnerTexts();
const candidatesOk = !options.some((o) => o.includes('SYNTHETIC TEST specialist')) && options.some((o) => o.includes('SYNTHETIC TEST viewer'));
await userSelect.selectOption({ label: options.find((o) => o.includes('SYNTHETIC TEST viewer')) });
const submit = panel.getByRole('button', { name: 'Выдать доступ…' });
const blockedNoReason = await submit.isDisabled();
await panel.locator('.acc-form').getByLabel(/^Причина/).fill('SYNTHETIC TEST: проверка выдачи доступа');
await submit.click();
const dialog = page.locator('dialog[open]');
await dialog.waitFor();
const dialogText = await dialog.innerText();
await shot(page, 'grants-confirm.png');
check('grant: candidates exclude existing grants; reason required; confirmation names user and reason', candidatesOk && blockedNoReason && dialogText.includes('SYNTHETIC TEST viewer') && dialogText.includes('проверка выдачи доступа'), {
  candidatesOk,
  blockedNoReason,
});
await dialog.getByRole('button', { name: 'Выдать доступ', exact: true }).click();
await page.getByText('Доступ выдан: SYNTHETIC TEST viewer').waitFor({ timeout: 15_000 });
await settle(page);
await panel.locator('.acc-table tbody tr').filter({ hasText: 'SYNTHETIC TEST viewer' }).waitFor({ timeout: 15_000 }).catch(() => {});
const rowsAfterGrant = await panel.locator('.acc-table tbody tr').allInnerTexts();
const viewerSees = await viewerCtx.page.evaluate(
  async ({ city, id }) => ((await (await fetch(`/v1/datasets?city_id=${city}&limit=200`)).json()).items ?? []).some((d) => d.id === id),
  { city: cityId, id: restricted.id },
);
check('grant saved: viewer in the list and the viewer now sees the dataset (server)', rowsAfterGrant.some((r) => r.includes('SYNTHETIC TEST viewer')) && viewerSees, { rowsAfterGrant, viewerSees });
await page.getByText('выдан доступ').first().waitFor({ timeout: 15_000 }).catch(() => {});
const history = await page.locator('.acc-history').innerText();
check('audit history shows the decision with author and reason', history.includes('выдан доступ') && history.includes('SYNTHETIC TEST admin') && history.includes('проверка выдачи доступа'), history.slice(0, 300));
await shot(page, 'grants-granted.png');

// 409: another admin session grants the admin first; this page still offers the admin.
// A second tab of an admin session acts as the concurrent administrator.
const other = { page: await admin.ctx.newPage() };
await other.page.goto(`${BASE}/admin?city=${cityId}`);
const preGrant = await apiCall(other.page, 'POST', `/v1/datasets/${restricted.id}/grants`, { user_id: adMe.id, reason: 'SYNTHETIC TEST: параллельная выдача' });
const adminOption = (await userSelect.locator('option').allInnerTexts()).find((o) => o.includes('SYNTHETIC TEST admin'));
await userSelect.selectOption({ label: adminOption });
await panel.locator('.acc-form').getByLabel(/^Причина/).fill('SYNTHETIC TEST: повторная выдача');
await submit.click();
await dialog.getByRole('button', { name: 'Выдать доступ', exact: true }).click();
const existsShown = await page.getByText('Доступ уже был выдан').waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
await settle(page);
const selfGranted = await panel.getByText('У вас есть явный доступ').waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
check('409 grant_exists: explained, list refreshed, admin now marked as explicitly granted', preGrant.status === 201 && existsShown && selfGranted, { pre: preGrant.status, existsShown, selfGranted });
await shot(page, 'grants-409.png');

// 404 on revoke: the grant disappears in another session while the dialog is open.
const viewerRow = panel.locator('.acc-table tbody tr').filter({ hasText: 'SYNTHETIC TEST viewer' });
await viewerRow.getByRole('button', { name: /Отозвать доступ/ }).click();
await dialog.waitFor();
const revokeBlocked = await dialog.getByRole('button', { name: 'Отозвать доступ', exact: true }).isDisabled();
await dialog.getByLabel(/^Причина/).fill('SYNTHETIC TEST: отзыв');
const preRevoke = await apiCall(other.page, 'DELETE', `/v1/datasets/${restricted.id}/grants/${vwMe.id}`, { reason: 'SYNTHETIC TEST: параллельный отзыв' });
await dialog.getByRole('button', { name: 'Отозвать доступ', exact: true }).click();
const goneShown = await page.getByText('Доступа уже нет').waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
await settle(page);
const viewerGone = (await panel.locator('.acc-table tbody tr').filter({ hasText: 'SYNTHETIC TEST viewer' }).count()) === 0;
check('revoke: reason required; 404 when already revoked is explained and the list refreshed', revokeBlocked && preRevoke.status === 200 && goneShown && viewerGone, {
  revokeBlocked,
  pre: preRevoke.status,
  goneShown,
  viewerGone,
});
await other.page.close();

// Self revoke warns that content becomes unavailable while management stays.
const selfRow = panel.locator('.acc-table tbody tr').filter({ hasText: 'SYNTHETIC TEST admin' });
await selfRow.getByRole('button', { name: /Отозвать доступ/ }).click();
await dialog.waitFor();
const selfWarn = await dialog.getByText('Вы отзываете доступ у себя').isVisible();
await shot(page, 'grants-revoke-self.png');
await dialog.getByLabel(/^Причина/).fill('SYNTHETIC TEST: отзыв у себя');
await dialog.getByRole('button', { name: 'Отозвать доступ', exact: true }).click();
await page.getByText('Доступ отозван: SYNTHETIC TEST admin').waitFor({ timeout: 15_000 });
await settle(page);
const backToAdminOnly = await panel.getByText('Только управление').waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
const contentAfter = await page.evaluate(async (id) => (await fetch(`/v1/datasets/${id}/versions`)).status, restricted.id);
check('self revoke: warning shown, state back to "management only", server hides content again', selfWarn && backToAdminOnly && contentAfter === 404, { selfWarn, backToAdminOnly, contentAfter });

// Reload restores the opened dataset and its grants.
await page.reload();
await page.locator('.acc-panel .acc-table').waitFor({ timeout: 20_000 });
check('reload restores the dataset panel from the URL', (await page.locator('.acc-panel').innerText()).includes(restricted.id.slice(0, 8)));

// Not restricted / unknown dataset.
await page.goto(`${BASE}/admin?city=${cityId}&grants=${open.id}`);
const notRestricted = await page.getByText('Набор не закрытый').waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
await page.goto(`${BASE}/admin?city=${cityId}&grants=${crypto.randomUUID()}`);
const notFound = await page.getByText('Набор не найден').waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
check('public dataset: grants not applicable; unknown id: not found', notRestricted && notFound, { notRestricted, notFound });
await shot(page, 'grants-not-found.png');

// City users list shows roles as roles, with the note that roles are not dataset access.
await page.goto(`${BASE}/admin?city=${cityId}`);
await settle(page);
const usersText = await page.locator('section[aria-labelledby="adm-users-h"]').innerText();
check('city users: roles listed with the "role is not dataset access" note', usersText.includes('SYNTHETIC TEST viewer') && usersText.includes('не доступ к закрытым наборам'));
const auditText = await page.locator('section[aria-labelledby="adm-audit-h"]').innerText();
check('audit log shows actor names for grant decisions', auditText.includes('dataset.grant_added') && auditText.includes('SYNTHETIC TEST admin'));

// Non-admin: the section is forbidden in the UI and on the server.
await sp.page.goto(`${BASE}/admin?city=${cityId}&grants=${restricted.id}`);
await settle(sp.page);
const spForbidden = await sp.page.getByText('Нет прав администратора').isVisible();
const spApi = await sp.page.evaluate(async (id) => (await fetch(`/v1/datasets/${id}/grants`)).status, restricted.id);
await shot(sp.page, 'grants-forbidden.png');
check('specialist: admin section forbidden; server answers 403', spForbidden && spApi === 403, { spForbidden, spApi });

// Imports: the creator sees the dataset; only admins get the "manage access" link.
await sp.page.goto(`${BASE}/imports?city=${cityId}&selected=${restricted.id}`);
await sp.page.waitForSelector('.app-split.is-open .pg-card', { timeout: 20_000 });
const spLink = await sp.page.getByRole('link', { name: 'Управлять доступом к набору' }).count();
check('imports detail: no access-management link for the specialist', spLink === 0, { spLink });

// Phone + dark theme.
const phoneCtx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  colorScheme: 'dark',
  locale: 'ru-RU',
  storageState: await admin.ctx.storageState(),
});
const phone = { ctx: phoneCtx, page: await phoneCtx.newPage() };
await phone.page.goto(`${BASE}/admin?city=${cityId}&grants=${restricted.id}`);
await phone.page.locator('.acc-panel .acc-table').waitFor({ timeout: 20_000 });
await settle(phone.page);
await phone.page.locator('.acc-panel').scrollIntoViewIfNeeded();
await shot(phone.page, 'grants-mobile-dark.png');
const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const pb = await phone.page.locator('.acc-panel').boundingBox();
check('phone (dark): no horizontal scroll, panel fits 390 px', overflow <= 0 && Boolean(pb) && pb.x >= 0 && pb.x + pb.width <= 391, { overflow, pb });
await phone.ctx.close();

check('no page errors in the admin session', pageErrors.length === 0, pageErrors.slice(0, 3));
await browser.close();
report.finishedAt = new Date().toISOString();
report.passed = report.checks.every((c) => c.pass);
report.synthetic = { restricted: restricted?.id, public: open?.id, specialist: spMe.id };
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`\n${report.checks.filter((c) => c.pass).length}/${report.checks.length} checks passed`);
process.exit(report.passed ? 0 : 1);
