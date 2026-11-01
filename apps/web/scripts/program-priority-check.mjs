// Authenticated decision-loop acceptance: reweight -> server priority -> persist -> optimize.
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5173';
const credentials = JSON.parse(readFileSync(process.env.PG_TEST_CREDENTIALS ?? '', 'utf8'));
const out = resolve('../../docs/evidence/jury-program-priority');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: process.env.PG_BROWSER_CHANNEL ?? 'msedge' });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'ru-RU' });
const page = await context.newPage();
const apiErrors = [];
const pageErrors = [];
page.on('response', (response) => {
  if (response.url().includes('/v1/') && response.status() >= 500) apiErrors.push(`${response.status()} ${new URL(response.url()).pathname}`);
});
page.on('pageerror', (error) => pageErrors.push(String(error)));

await page.goto(`${BASE}/auth/login`);
await page.locator('#username').fill('specialist');
await page.locator('#password').fill(credentials.specialist);
await page.locator('#kc-login').click();
await page.waitForURL((url) => url.origin === new URL(BASE).origin && !url.pathname.startsWith('/auth/'), { timeout: 25_000 });
const target = await page.evaluate(async () => {
  const city = (await (await fetch('/v1/cities')).json()).items[0];
  const programs = (await (await fetch(`/v1/programs?city_id=${city.id}&limit=100`)).json()).items;
  const program = programs.find((item) => item.status === 'draft' && item.priority_result_id && item.current_revision_id);
  return program ? { cityId: city.id, program } : null;
});
if (!target) throw new Error('No optimized draft program with a priority result');

await page.goto(`${BASE}/program?city=${target.cityId}&selected=${target.program.id}`);
await page.getByRole('button', { name: 'Изменить приоритеты' }).waitFor({ timeout: 30_000 });
await page.getByRole('button', { name: 'Изменить приоритеты' }).click();
const dialog = page.getByRole('dialog', { name: 'Сценарий городских приоритетов' });
await dialog.waitFor();
await dialog.locator('.priority-weight-panel').waitFor({ timeout: 20_000 }).catch(async () => {
  throw new Error(`Priority editor did not load: ${(await dialog.innerText()).slice(0, 1200)}`);
});
const sliders = dialog.locator('input[type="range"]');
const sliderCount = await sliders.count();
if (sliderCount < 2) throw new Error(`Expected at least two admitted priority factors, got ${sliderCount}`);
const firstDominant = Number(target.program.benefit_weights?.[0]?.weight ?? 0) >= Number(target.program.benefit_weights?.[1]?.weight ?? 0);
for (let index = 0; index < sliderCount; index += 1) {
  await sliders.nth(index).evaluate((input, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, index === 0 ? (firstDominant ? '0' : '100') : index === 1 ? (firstDominant ? '100' : '0') : '0');
}
const priorityResponsePromise = page.waitForResponse((response) => (
  response.request().method() === 'POST' && new URL(response.url()).pathname === '/v1/priorities'
));
await dialog.getByRole('button', { name: 'Пересчитать рейтинг территорий' }).click();
const newPriorityId = (await (await priorityResponsePromise).json()).id;
await dialog.getByText('Новый рейтинг рассчитан сервером').waitFor({ timeout: 30_000 });
const deltaText = await dialog.locator('.priority-zone__result').allInnerTexts();
await page.screenshot({ path: resolve(out, 'priority-what-if-preview.png') });
const optimizeResponsePromise = page.waitForResponse((response) => (
  response.request().method() === 'POST'
  && new URL(response.url()).pathname === `/v1/programs/${target.program.id}/optimize`
));
await dialog.getByRole('button', { name: 'Применить и пересчитать программу' }).click();
await dialog.waitFor({ state: 'hidden', timeout: 30_000 });
const job = await (await optimizeResponsePromise).json();
let completedJob = null;
for (let attempt = 0; attempt < 90; attempt += 1) {
  completedJob = await page.evaluate(async (jobId) => {
    const response = await fetch(`/v1/jobs/${jobId}`, { cache: 'no-store' });
    return response.ok ? await response.json() : null;
  }, job.id);
  if (completedJob && ['succeeded', 'failed', 'cancelled'].includes(completedJob.state)) break;
  await page.waitForTimeout(1_000);
}
const updated = await page.evaluate(async (programId) => {
  const program = await (await fetch(`/v1/programs/${programId}`, { cache: 'no-store' })).json();
  return { priorityId: program.priority_result_id, revisionId: program.current_revision_id };
}, target.program.id);
await page.getByRole('button', { name: 'Изменить приоритеты' }).scrollIntoViewIfNeeded();
await page.waitForTimeout(500);
await page.screenshot({ path: resolve(out, 'priority-program-recalculated.png') });
await browser.close();

const passed = sliderCount >= 2 && deltaText.some((value) => value.trim()) && updated?.priorityId === newPriorityId
  && updated?.revisionId === completedJob?.result_ref_id && apiErrors.length === 0 && pageErrors.length === 0;
console.log(JSON.stringify({ passed, sliderCount, deltaText, job: { id: job.id, state: completedJob?.state, result: completedJob?.result_ref_id }, updated, apiErrors, pageErrors }));
process.exit(passed ? 0 : 1);
