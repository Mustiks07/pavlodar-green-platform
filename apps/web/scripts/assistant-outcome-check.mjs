// Focused disposable acceptance for the jury flow: AI proposal -> human apply -> full calculation
// -> exact before/after result. Uses the local deterministic LLM stub and writes no shared data.
//
//   uv run python -m tools.dev.isolated_browser_env --cwd apps/web -- node scripts/assistant-outcome-check.mjs
import { chromium } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { sessionCookie } from './lib/session-login.mjs';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5174';
const ROOT = resolve('../..');
const OUT = resolve('../../docs/evidence/wp10-assistant-outcome');
mkdirSync(OUT, { recursive: true });

const fixture = spawnSync('uv', ['run', 'python', '-m', 'tools.dev.synthetic_chat_fixture'], {
  cwd: ROOT,
  env: process.env,
  encoding: 'utf8',
});
if (fixture.status !== 0) throw new Error(fixture.stderr || 'fixture failed');
const fx = JSON.parse(fixture.stdout.trim().split('\n').at(-1));

const browser = await chromium.launch({ channel: process.env.PG_BROWSER_CHANNEL ?? 'msedge' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ru-RU' });
if (!(await sessionCookie(context, 'specialist', BASE))) throw new Error('PG_SESSIONS is required');
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));
const city = await page.goto(BASE).then(() => page.evaluate(async () => (await fetch('/v1/cities')).json())).then((value) => value.items[0]);
await page.goto(`${BASE}/projects/${fx.scenario_id}?city=${city.id}`);
await page.getByRole('button', { name: /Ассистент|Спросить ИИ/ }).click();
const panel = page.locator('#assistant-body');
await panel.getByRole('button', { name: 'Начать беседу' }).click();
await page.waitForURL(/[?&]chat=/, { timeout: 15_000 });
await panel.getByLabel(/^Вопрос/).fill('SYNTHETIC PROPOSE: увеличь количество');
await panel.getByRole('button', { name: 'Отправить' }).click();
const proposal = panel.locator('.asst-proposal').first();
await proposal.waitFor({ timeout: 60_000 }).catch(async (error) => {
  const binding = await panel.locator('.asst-binding').evaluate((node) => ({
    zone: node.getAttribute('data-binding-zone'),
    revision: node.getAttribute('data-binding-revision'),
  })).catch(() => null);
  const messages = await panel.locator('.asst-msg').evaluateAll((nodes) => nodes.map((node) => ({
    state: node.getAttribute('data-state'),
    text: node.textContent,
  })));
  await page.screenshot({ path: resolve(OUT, 'assistant-outcome-failed.png') });
  console.error(JSON.stringify({ binding, expectedRevision: fx.revision_id, messages }));
  throw error;
});
await proposal.getByRole('button', { name: 'Применить…' }).click();
await proposal.getByRole('button', { name: 'Подтвердить применение' }).click();
const appliedLink = proposal.locator('[data-applied-revision]');
await appliedLink.waitFor({ timeout: 30_000 });
const revisionId = await appliedLink.getAttribute('data-applied-revision');
const outcome = proposal.locator(`[data-proposal-outcome="${revisionId}"]`);
await outcome.getByRole('button', { name: 'Рассчитать последствия' }).click();
await outcome.getByText('сравнено', { exact: true }).waitFor({ timeout: 120_000 });
const cards = await outcome.locator('.asst-outcome__card').count();
await page.screenshot({ path: resolve(OUT, 'assistant-outcome.png') });
const link = await outcome.locator('a[href*="calc="]').getAttribute('href', { timeout: 30_000 }).catch(async (error) => {
  console.error(JSON.stringify({ outcome: await outcome.innerText(), cards }));
  throw error;
});
await context.close();
await browser.close();

const passed = cards === 2 && Boolean(revisionId) && Boolean(link?.includes(`revision=${revisionId}`)) && Boolean(link?.includes('calc=')) && pageErrors.length === 0;
console.log(JSON.stringify({ passed, cards, revisionId, link, pageErrors }));
process.exit(passed ? 0 : 1);
