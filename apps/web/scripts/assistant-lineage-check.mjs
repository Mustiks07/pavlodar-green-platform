// Focused live proof: a model answer is accompanied by exact server metrics and one-click lineage.
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5173';
const scenarioId = process.env.PG_SCENARIO_ID;
if (!scenarioId) throw new Error('PG_SCENARIO_ID is required');
const credentials = JSON.parse(readFileSync(process.env.PG_TEST_CREDENTIALS ?? '', 'utf8'));
const out = resolve('../../docs/evidence/jury-assistant-lineage');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PG_BROWSER_CHANNEL ?? 'msedge' });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'ru-RU' });
const page = await context.newPage();
const apiErrors = [];
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));
page.on('response', (response) => {
  if (response.url().includes('/v1/') && response.status() >= 500) apiErrors.push(`${response.status()} ${new URL(response.url()).pathname}`);
});

await page.goto(`${BASE}/auth/login`);
await page.locator('#username').fill('specialist');
await page.locator('#password').fill(credentials.specialist);
await page.locator('#kc-login').click();
await page.waitForURL((url) => url.origin === new URL(BASE).origin && !url.pathname.startsWith('/auth/'), { timeout: 25_000 });
const scenario = await page.evaluate(async (id) => (await (await fetch(`/v1/scenarios/${id}`)).json()), scenarioId);
await page.goto(`${BASE}/projects/${scenarioId}?city=${scenario.city_id}`);
await page.getByRole('button', { name: /Ассистент|Спросить ИИ/ }).click();
const panel = page.locator('#assistant-body');
await panel.getByRole('button', { name: 'Начать беседу' }).click();
await page.waitForURL(/[?&]chat=/, { timeout: 20_000 });
await panel.getByLabel(/^Вопрос/).fill('Какова приживаемость посадок через один год? Покажи, откуда взято число.');
await panel.getByRole('button', { name: 'Отправить' }).click();
const answer = panel.locator('.asst-msg[data-role="assistant"]').last();
await answer.locator('[data-fact-key="survival_probability"]').first().waitFor({ timeout: 90_000 });
const disclosure = answer.locator('[data-fact-key="survival_probability"]').first().locator('.asst-fact-lineage');
await disclosure.locator('summary').click();
await disclosure.getByText('Снимок расчёта', { exact: true }).waitFor();
const exactLink = await disclosure.getByRole('link', { name: 'Открыть точный расчёт' }).getAttribute('href');
const manifestLink = await disclosure.getByRole('link', { name: /Паспорт расчёта/ }).getAttribute('href');
await answer.scrollIntoViewIfNeeded();
await page.waitForTimeout(250);
await answer.screenshot({ path: resolve(out, 'assistant-number-lineage.png') });
const factCount = await answer.locator('[data-fact-key="survival_probability"]').count();
await browser.close();

const passed = factCount > 0 && exactLink?.includes(`/projects/${scenarioId}`) && exactLink.includes('calc=')
  && manifestLink?.includes('/manifest') && apiErrors.length === 0 && pageErrors.length === 0;
console.log(JSON.stringify({ passed, factCount, exactLink, manifestLink, apiErrors, pageErrors }));
process.exit(passed ? 0 : 1);
