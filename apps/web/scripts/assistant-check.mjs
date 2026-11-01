// WP-10 assistant journey (contract 1.12.0) on the isolated stack with the deterministic loopback
// LLM stub (tools/dev/llm_stub.py; nothing leaves the machine). A specialist opens a SYNTHETIC draft
// scenario, starts a chat bound to its exact revision, gets an answer whose numbers come only from
// server facts, reloads mid-answer (session and job resume from the URL), cancels and retries,
// sees a provider failure, receives two proposals, applies one with a fresh If-Match (new revision,
// nothing applied before the confirmation), gets a 412 on the other (kept on screen, re-read
// offered) and rejects it with a reason. A viewer cannot chat; phone dark has no horizontal scroll.
//
//   uv run python -m tools.dev.isolated_browser_env --cwd apps/web -- node scripts/assistant-check.mjs
import { chromium } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sessionCookie } from './lib/session-login.mjs';

const BASE = process.env.PG_WEB_URL ?? 'http://localhost:5174';
const OUT = resolve('../../docs/evidence/wp10-assistant-ui');
const ROOT = resolve('../..');
mkdirSync(OUT, { recursive: true });
const report = { base: BASE, startedAt: new Date().toISOString(), checks: [], shots: [] };
const check = (name, pass, detail) => {
  report.checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
};
const shot = async (page, file) => {
  await page.screenshot({ path: join(OUT, file), fullPage: false });
  report.shots.push(`docs/evidence/wp10-assistant-ui/${file}`);
};
const get = (page, path) => page.evaluate(async (p) => { const r = await fetch(p); return { status: r.status, etag: r.headers.get('ETag'), body: await r.json().catch(() => null) }; }, path);
async function signIn(browser, role, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ru-RU', ...opts });
  const page = await ctx.newPage();
  if (!(await sessionCookie(ctx, role, BASE))) throw new Error('Run through tools/dev/isolated_browser_env.py (PG_SESSIONS)');
  await page.goto(BASE + '/');
  await page.waitForTimeout(800);
  return { ctx, page };
}

const fixture = spawnSync('uv', ['run', 'python', '-m', 'tools.dev.synthetic_chat_fixture'], { cwd: ROOT, env: process.env, encoding: 'utf8' });
const fx = fixture.status === 0 ? JSON.parse(fixture.stdout.trim().split('\n').at(-1)) : null;
check('setup: SYNTHETIC draft scenario with an unlocked placement, catalog and rule (disposable DB only)', Boolean(fx), { err: (fixture.stderr ?? '').split(/\r?\n/).filter((l) => /Error|error:|File "C:.*(tests|tools)/.test(l)).slice(-6) });
if (!fx) {
  writeFileSync(join(process.env.TEMP ?? OUT, 'assistant-fixture-stderr.txt'), fixture.stderr ?? '');
  process.exit(1);
}

const browser = await chromium.launch({ channel: process.env.PG_BROWSER_CHANNEL ?? 'msedge' });
const sp = await signIn(browser, 'specialist');
const page = sp.page;
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
const city = (await page.evaluate(async () => (await fetch('/v1/cities')).json())).items[0];
const panel = page.locator('#assistant-body');
const lastAssistant = () => panel.locator('.asst-msg[data-role="assistant"]').last();
const sessionId = () => new URL(page.url()).searchParams.get('chat');
const messages = async () => (await get(page, `/v1/chat/sessions/${sessionId()}/messages?limit=200`)).body?.items ?? [];
const ask = async (text) => {
  const before = await panel.locator('.asst-msg[data-role="assistant"]').count();
  await panel.getByLabel(/^Вопрос/).fill(text);
  await panel.getByRole('button', { name: 'Отправить' }).click();
  await panel.locator('.asst-msg[data-role="assistant"]').nth(before).waitFor({ timeout: 15_000 });
};
const settled = (state = 'completed', timeout = 40_000) => lastAssistant().and(page.locator(`[data-state="${state}"]`)).waitFor({ timeout }).then(() => true).catch(() => false);

// --- Start a session bound to the exact revision of the open project ---
await page.goto(`${BASE}/projects/${fx.scenario_id}?city=${city.id}`);
await page.getByRole('button', { name: 'Ассистент' }).click();
await panel.getByRole('button', { name: 'Начать беседу' }).waitFor({ timeout: 15_000 }).catch(async (e) => {
  await shot(page, 'assistant-start-failed.png');
  console.log('panel:', await panel.innerText().catch(() => '(no panel)'), pageErrors);
  throw e;
});
const levelText = await panel.getByTestId('chat-level').locator('option:checked').innerText();
await panel.getByRole('button', { name: 'Начать беседу' }).click();
await page.waitForURL(/[?&]chat=/, { timeout: 15_000 });
const binding = panel.locator('.asst-binding');
check(
  'session created for the open project: bound to its zone and exact current revision',
  levelText.includes('ревизия') && (await binding.getAttribute('data-binding-revision')) === fx.revision_id && (await binding.getAttribute('data-binding-zone')) === fx.zone_id,
  { levelText },
);

// --- A plain answer: text as stored, numbers only from server facts ---
await ask('SYNTHETIC TEST: какая площадь участка?');
const answered = await settled();
const server = (await messages()).filter((m) => m.role === 'assistant').at(-1);
const uiText = await lastAssistant().locator('.asst-msg__text').innerText().catch(() => '');
const uiFacts = await lastAssistant().locator('[data-fact-key]').evaluateAll((els) => els.map((e) => ({ key: e.getAttribute('data-fact-key'), value: e.getAttribute('data-fact-value') })));
const serverFacts = (server?.facts ?? []).map((f) => ({ key: f.metric.key, value: f.metric.value == null ? '' : String(f.metric.value) }));
check('answer through the durable sendChatMessage job is shown exactly as the server stored it', answered && uiText === server?.text, { state: server?.state });
check('server facts only: the zone area fact equals the server value; the panel shows it under «Данные сервера»', serverFacts.length > 0 && JSON.stringify(uiFacts) === JSON.stringify(serverFacts) && (await lastAssistant().getByText('Данные сервера').count()) === 1, { uiFacts, serverFacts });
await shot(page, 'assistant-answer.png');

// --- Reload mid-answer, then cancel and retry ---
await ask('SYNTHETIC SLOW: подробнее, пожалуйста');
const jobBefore = new URL(page.url()).searchParams.get('chatJob');
await page.reload();
await panel.locator('.asst-msg[data-role="assistant"]').last().waitFor({ timeout: 15_000 });
const resumedState = await lastAssistant().getAttribute('data-state');
const transport = await page.waitForFunction(() => document.querySelector('[data-chat-job]')?.getAttribute('data-job-transport') === 'stream', null, { timeout: 6_000 }).then(() => 'stream').catch(async () => panel.locator('[data-chat-job]').getAttribute('data-job-transport').catch(() => null));
check('reload mid-answer: panel reopens on the same session; the pending answer resumes its job over the shared useJob stream', Boolean(jobBefore) && new URL(page.url()).searchParams.get('chatJob') === jobBefore && ['queued', 'streaming'].includes(resumedState ?? '') && transport === 'stream', { jobBefore, resumedState, transport });
await panel.locator('[data-chat-job]').getByRole('button', { name: 'Отменить' }).click();
const cancelled = await settled('cancelled');
const cancelledJob = (await get(page, `/v1/jobs/${jobBefore}`)).body;
check('cancel: the job and the assistant message become cancelled on the server', cancelled && cancelledJob?.state === 'cancelled', { job: cancelledJob?.state });
await lastAssistant().getByRole('button', { name: 'Повторить вопрос' }).click();
const retried = await settled('completed', 60_000);
const afterRetry = await messages();
check('retry re-sends the same question as a new job and completes', retried && afterRetry.filter((m) => m.role === 'user' && m.text.startsWith('SYNTHETIC SLOW')).length === 2, { count: afterRetry.length });

// --- Provider failure ---
await ask('SYNTHETIC FAIL: проверка отказа');
const failed = await settled('failed', 90_000);
const failText = await lastAssistant().innerText().catch(() => '');
check('provider failure: message marked failed with a retry offered, no invented answer', failed && failText.includes('ответ не получен') && failText.includes('Повторить вопрос'), { failText: failText.slice(0, 160) });
await shot(page, 'assistant-failed.png');

// --- Two proposals; nothing changes before an explicit confirmation ---
await ask('SYNTHETIC PROPOSE: увеличь количество');
await settled();
await ask('SYNTHETIC PROPOSE: и ещё одно предложение');
await settled();
const cards = panel.locator('.asst-proposal');
await cards.nth(1).waitFor({ timeout: 15_000 });
const [p1, p2] = await cards.evaluateAll((els) => els.map((e) => e.getAttribute('data-proposal-id')));
const change = await cards.first().locator('[data-placement-id]').first();
const before = await change.getAttribute('data-before');
const after = await change.getAttribute('data-after');
const unchanged = (await get(page, `/v1/scenarios/${fx.scenario_id}`)).body;
check(
  'proposal opened via getProposal: server quantities shown, scenario unchanged until confirmed',
  before === String(fx.quantity) && after === String(fx.quantity + 1) && unchanged.current_revision_id === fx.revision_id,
  { before, after, current: unchanged.current_revision_id },
);
await shot(page, 'assistant-proposal.png');

const applyCalls = [];
page.on('request', (r) => {
  if (r.method() === 'POST' && /\/v1\/proposals\/[^/]+\/apply$/.test(r.url())) applyCalls.push({ ifMatch: r.headers()['if-match'], body: r.postDataJSON() });
});
const card1 = panel.locator(`.asst-proposal[data-proposal-id="${p1}"]`);
await card1.getByRole('button', { name: 'Применить…' }).click();
const nothingYet = applyCalls.length === 0;
const etag = (await get(page, `/v1/scenarios/${fx.scenario_id}`)).etag;
await card1.getByRole('button', { name: 'Подтвердить применение' }).click();
await card1.locator('[data-applied-revision]').waitFor({ timeout: 20_000 });
const appliedId = await card1.locator('[data-applied-revision]').getAttribute('data-applied-revision');
const scenarioNow = (await get(page, `/v1/scenarios/${fx.scenario_id}`)).body;
const revisionNow = (await get(page, `/v1/scenario-revisions/${appliedId}`)).body;
const p1Server = (await get(page, `/v1/proposals/${p1}`)).body;
check(
  'apply: explicit confirmation, current If-Match and proposal base_revision_id -> one new server revision',
  nothingYet &&
    applyCalls.length === 1 &&
    applyCalls[0].ifMatch === etag &&
    applyCalls[0].body?.base_revision_id === fx.revision_id &&
    scenarioNow.current_revision_id === appliedId &&
    revisionNow.placements.find((p) => p.id === fx.placement_id)?.quantity === fx.quantity + 1 &&
    p1Server.status === 'applied',
  { applyCalls, appliedId, status: p1Server.status },
);

// The open project follows the applied revision; an untouched editor must not claim local edits.
const followed = await page.locator('.pg-dl, table').getByText(appliedId.slice(0, 8)).first().waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
const phantom = await page.getByText('Ваши несохранённые правки сделаны на другой ревизии').count();
check('project page follows the applied revision without phantom unsaved edits', followed && phantom === 0, { followed, phantom });
const card2 = panel.locator(`.asst-proposal[data-proposal-id="${p2}"]`);
await card2.getByRole('button', { name: 'Применить…' }).click();
await card2.getByRole('button', { name: 'Подтвердить применение' }).click();
const conflict = await card2.locator('[data-conflict="true"]').waitFor({ timeout: 20_000 }).then(() => true).catch(() => false);
const kept = await card2.getByText('SYNTHETIC TEST: увеличить количество').count();
const currentLink = await card2.getByRole('link', { name: /Открыть текущую ревизию/ }).getAttribute('href').catch(() => null);
const stillOne = (await get(page, `/v1/scenarios/${fx.scenario_id}`)).body.current_revision_id === appliedId;
check('stale base: 412 keeps the proposal on screen, links the current revision, creates nothing', conflict && kept === 1 && Boolean(currentLink?.includes(appliedId)) && stillOne, { currentLink });
await shot(page, 'assistant-conflict.png');
await card2.getByRole('button', { name: 'Перечитать текущую ревизию' }).click();
const outdated = await card2.getByText('Сценарий уже изменён').waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
check('re-read: the card now states the current revision instead of the conflict', outdated);
await card2.getByRole('button', { name: 'Отклонить…' }).click({ timeout: 10_000 }).catch(async (e) => {
  await shot(page, 'assistant-reject-failed.png');
  console.log('card2:', await card2.innerText().catch(() => '(none)'));
  throw e;
});
await card2.getByLabel(/^Причина/).fill('SYNTHETIC TEST: основа устарела');
await card2.getByRole('button', { name: 'Отклонить предложение' }).click();
const rejected = await card2.and(page.locator('[data-proposal-status="rejected"]')).waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
const p2Server = (await get(page, `/v1/proposals/${p2}`)).body;
check('reject with a reason: proposal rejected on the server', rejected && p2Server.status === 'rejected', { status: p2Server.status });

// --- Reload restores the whole conversation from the server ---
const count = (await messages()).length;
await page.reload();
await panel.locator('.asst-msg').nth(count - 1).waitFor({ timeout: 15_000 }).catch(() => {});
// Messages and proposal details are separate server queries. The message list may be complete
// before the proposal card has resolved its durable status after a reload.
await panel.locator('[data-proposal-status="applied"]').waitFor({ timeout: 15_000 }).catch(() => {});
const restored = await panel.locator('.asst-msg').count();
check('reload restores the conversation and proposal states from the server', restored === count && (await panel.locator('[data-proposal-status="applied"]').count()) === 1, { restored, count });
check('no page errors in the specialist session', pageErrors.length === 0, pageErrors.slice(0, 3));
const chatId = sessionId();
await sp.ctx.close();

// --- Viewer ---
const vw = await signIn(browser, 'viewer');
await vw.page.goto(`${BASE}/?city=${city.id}`);
await vw.page.getByRole('button', { name: 'Ассистент' }).click();
const viewerText = await vw.page.locator('#assistant-body').innerText().catch(() => '');
check('viewer: no chat controls, the role limitation is explained', viewerText.includes('Ассистент доступен специалистам') && (await vw.page.locator('#assistant-body').getByRole('button', { name: 'Начать беседу' }).count()) === 0);
await vw.ctx.close();

// --- Phone + dark ---
const ph = await signIn(browser, 'specialist', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark' });
await ph.page.goto(`${BASE}/projects/${fx.scenario_id}?city=${city.id}&chat=${chatId ?? ''}`);
await ph.page.locator('#assistant-body .asst-msg').first().waitFor({ timeout: 15_000 }).catch(() => {});
const overflow = await ph.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('phone (dark): assistant opened from the link without horizontal scroll', overflow <= 0 && (await ph.page.locator('#assistant-body .asst-msg').count()) > 0, { overflow });
await shot(ph.page, 'assistant-mobile-dark.png');
await ph.ctx.close();

await browser.close();
report.finishedAt = new Date().toISOString();
report.passed = report.checks.every((c) => c.pass);
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`\n${report.checks.filter((c) => c.pass).length}/${report.checks.length} checks passed`);
process.exit(report.passed ? 0 : 1);
