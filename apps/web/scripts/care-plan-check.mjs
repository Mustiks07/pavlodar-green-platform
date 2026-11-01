import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5173';
const credentialPath = process.env.PG_TEST_CREDENTIALS;
if (!credentialPath) throw new Error('Set PG_TEST_CREDENTIALS to an ignored local credentials file');
const credentials = JSON.parse(readFileSync(credentialPath, 'utf8'));
const output = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/evidence/jury-care-plan');
mkdirSync(output, { recursive: true });
const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass, ...(detail === undefined ? {} : { detail }) });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`);
};

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'ru-RU' });
const page = await context.newPage();
const serverErrors = [];
page.on('response', (response) => {
  if (response.status() >= 500 && new URL(response.url()).pathname.startsWith('/v1/')) serverErrors.push({ status: response.status(), url: response.url() });
});
try {
  await page.goto(`${BASE}/auth/login`, { waitUntil: 'commit' });
  await page.waitForURL(/openid-connect\/auth/, { waitUntil: 'commit' });
  await page.fill('#username', 'specialist');
  await page.fill('#password', credentials.specialist);
  await page.click('#kc-login');
  await page.waitForURL((url) => url.origin === new URL(BASE).origin && !url.pathname.startsWith('/auth/'), { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await page.waitForFunction(() => fetch('/v1/me').then((response) => response.ok).catch(() => false), null, { timeout: 20_000 });
  const hero = await page.evaluate(async () => {
    const cities = (await (await fetch('/v1/cities?limit=100')).json()).items ?? [];
    for (const city of cities) {
      const scenarios = (await (await fetch(`/v1/scenarios?city_id=${city.id}&limit=200`)).json()).items ?? [];
      const scenario = scenarios.find((item) => item.name === 'Вариант B · экономия воды');
      if (scenario) return { ...scenario, city_id: city.id };
    }
    return null;
  });
  check('exact hero project exists', Boolean(hero));
  if (!hero) throw new Error('Hero scenario is missing');
  await page.goto(`${BASE}/projects/${hero.id}?city=${hero.city_id}`, { waitUntil: 'domcontentloaded' });
  const action = page.getByRole('button', { name: 'Изменить план ухода' });
  await action.waitFor({ timeout: 30_000 });
  await action.click();
  const editor = page.locator('#scenario-care-editor');
  await editor.waitFor({ state: 'visible', timeout: 10_000 });
  await editor.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  check('calculated project opens an editable annual care plan', (await editor.locator('article').count()) > 0);
  check('water, crew and visit limits are visible together', await editor.getByLabel('Лимит воды, м³').isVisible() && await editor.getByLabel('Лимит работы бригады, мин').isVisible() && await editor.getByLabel('Лимит выездов').isVisible());
  await page.screenshot({ path: resolve(output, 'care-plan-editor.png') });

  const originalRevision = hero.current_revision_id;
  await editor.getByLabel('Лимит воды, м³').fill('0');
  await page.getByLabel('Комментарий к ревизии').fill('Проверка доступности ресурсов ухода');
  await page.getByRole('button', { name: 'Сохранить новую ревизию' }).click();
  await page.getByText('Превышен ресурс ухода', { exact: true }).waitFor({ timeout: 20_000 });
  const fieldMessage = await editor.getByText(/По плану .* доступно 0 м³/).innerText();
  check('server binds the resource rejection to the exact water limit', Boolean(fieldMessage), fieldMessage);
  const currentRevision = await page.evaluate(async (scenarioId) => (await (await fetch(`/v1/scenarios/${scenarioId}`)).json()).current_revision_id, hero.id);
  check('rejected plan preserves the existing immutable revision', currentRevision === originalRevision, { originalRevision, currentRevision });
  check('local value stays available for correction', await editor.getByLabel('Лимит воды, м³').inputValue() === '0');
  check('no API 5xx occurred', serverErrors.length === 0, serverErrors);
  await editor.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(output, 'care-plan-resource-rejected.png') });
  await page.getByRole('button', { name: 'Отменить правки' }).click();
} finally {
  await context.close();
  await browser.close();
}
const report = { base: BASE, checks, passed: checks.every((item) => item.pass), screenshots: ['docs/evidence/jury-care-plan/care-plan-editor.png', 'docs/evidence/jury-care-plan/care-plan-resource-rejected.png'] };
writeFileSync(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`${checks.filter((item) => item.pass).length}/${checks.length} checks passed`);
process.exit(report.passed ? 0 : 1);
