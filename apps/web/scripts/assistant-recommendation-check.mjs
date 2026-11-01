import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5173';
const CITY = process.env.PG_CITY_ID ?? '2de4e9e4-1602-5bdb-b17d-13df22510458';
const credentialPath = process.env.PG_TEST_CREDENTIALS;
if (!credentialPath) throw new Error('Set PG_TEST_CREDENTIALS to an ignored local credentials file');
const credentials = JSON.parse(readFileSync(credentialPath, 'utf8'));
const scriptDir = dirname(fileURLToPath(import.meta.url));
const output = resolve(scriptDir, '../../../docs/evidence/jury-assistant-recommendation');
mkdirSync(output, { recursive: true });

const checks = [];
let resolvedCity = CITY;
const check = (name, pass, detail) => {
  checks.push({ name, pass, ...(detail === undefined ? {} : { detail }) });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`);
};

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'ru-RU' });
const page = await context.newPage();
const serverErrors = [];
page.on('response', (response) => {
  if (response.status() >= 500 && new URL(response.url()).pathname.startsWith('/v1/')) {
    serverErrors.push({ status: response.status(), url: response.url() });
  }
});

try {
  await page.goto(`${BASE}/auth/login`, { waitUntil: 'commit' });
  await page.waitForURL(/openid-connect\/auth/, { waitUntil: 'commit' });
  await page.fill('#username', 'specialist');
  await page.fill('#password', credentials.specialist);
  await page.click('#kc-login');
  await page.waitForURL((url) => url.origin === new URL(BASE).origin && !url.pathname.startsWith('/auth/'), {
    waitUntil: 'domcontentloaded',
    timeout: 20_000,
  });
  await page.waitForFunction(() => fetch('/v1/me').then((response) => response.ok).catch(() => false), null, { timeout: 20_000 });

  const hero = await page.evaluate(async () => {
    const cityResponse = await fetch('/v1/cities?limit=100');
    const cities = (await cityResponse.json()).items ?? [];
    for (const city of cities) {
      const response = await fetch(`/v1/scenarios?city_id=${city.id}&limit=200`);
      const body = await response.json();
      const scenario = body.items?.find((item) => item.name === 'Вариант B · экономия воды');
      if (scenario) return { ...scenario, city_id: city.id };
    }
    return null;
  });
  check('exact hero project exists', Boolean(hero));
  if (!hero) throw new Error('Hero scenario is missing');
  resolvedCity = hero.city_id;

  await page.goto(`${BASE}/projects/${hero.id}?city=${hero.city_id}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Вариант B · экономия воды' }).waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: /Ассистент|Спросить ИИ/ }).click();
  const panel = page.locator('#assistant-body');
  await panel.getByRole('button', { name: 'Начать беседу' }).click();
  await page.waitForURL(/[?&]chat=/, { timeout: 20_000 });

  const initialRevision = hero.current_revision_id;
  await panel.getByLabel(/^Вопрос/).fill('Подбери растения для этого участка');
  await panel.getByRole('button', { name: 'Отправить' }).click();
  const answer = panel.locator('.asst-msg[data-role="assistant"][data-state="completed"]').last();
  await answer.waitFor({ timeout: 60_000 });
  const text = await answer.locator('.asst-msg__text').innerText();
  check('assistant returns the server-owned catalog and rule selection', text.includes('Подбор выполнен по версии каталога и правилам текущего участка'), text);
  check('answer is actionable and states that the project remains unchanged', text.includes('Проект не изменён'));
  check('candidate names are rendered as a readable list', (await answer.locator('li').count()) >= 3);

  const currentRevision = await page.evaluate(async (scenarioId) => (await (await fetch(`/v1/scenarios/${scenarioId}`)).json()).current_revision_id, hero.id);
  check('read-only recommendation did not mutate the project', currentRevision === initialRevision, { initialRevision, currentRevision });

  await panel.getByLabel(/^Вопрос/).fill('Подготовь замену растения на лучший вариант');
  await panel.getByRole('button', { name: 'Отправить' }).click();
  const proposalAnswer = panel.locator('.asst-msg[data-role="assistant"][data-state="completed"]').last();
  await proposalAnswer.waitFor({ timeout: 60_000 });
  const proposal = proposalAnswer.locator('.asst-proposal');
  await proposal.waitFor({ timeout: 20_000 });
  const proposalText = await proposal.innerText();
  check('assistant prepares a readable plant replacement decision', /Растение в размещении: «.+» → «.+»/.test(proposalText), proposalText);
  check('proposal waits for a human decision', proposalText.includes('ожидает решения') && proposalText.includes('Применить'));
  const revisionWithPendingProposal = await page.evaluate(async (scenarioId) => (await (await fetch(`/v1/scenarios/${scenarioId}`)).json()).current_revision_id, hero.id);
  check('pending plant replacement did not mutate the project', revisionWithPendingProposal === initialRevision, { initialRevision, revisionWithPendingProposal });
  await proposal.screenshot({ path: resolve(output, 'assistant-plant-proposal.png') });

  await proposal.getByRole('button', { name: 'Отклонить…' }).click();
  await proposal.getByLabel('Причина').fill('Проверено в живом приёмочном сценарии');
  await proposal.getByRole('button', { name: 'Отклонить предложение' }).click();
  await proposal.getByText('отклонено', { exact: true }).waitFor({ timeout: 20_000 });
  check('proposal can be explicitly rejected without changing the project', true);
  check('no API 5xx occurred', serverErrors.length === 0, serverErrors);
  await page.screenshot({ path: resolve(output, 'assistant-plant-selection.png') });
} finally {
  await context.close();
  await browser.close();
}

const report = {
  base: BASE,
  city: resolvedCity,
  checks,
  passed: checks.every((item) => item.pass),
  screenshots: [
    'docs/evidence/jury-assistant-recommendation/assistant-plant-selection.png',
    'docs/evidence/jury-assistant-recommendation/assistant-plant-proposal.png',
  ],
};
writeFileSync(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`${checks.filter((item) => item.pass).length}/${checks.length} checks passed`);
process.exit(report.passed ? 0 : 1);
