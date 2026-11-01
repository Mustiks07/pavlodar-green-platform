// Focused mobile visual acceptance for the authenticated map workspace.
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const credentialPath = process.env.PG_TEST_CREDENTIALS;
if (!credentialPath) throw new Error('Set PG_TEST_CREDENTIALS to an ignored local credentials file');
const credentials = JSON.parse(readFileSync(credentialPath, 'utf8'));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' });
const page = await context.newPage();
try {
  await page.goto('http://localhost:5173/auth/login', { waitUntil: 'commit' });
  await page.waitForURL(/openid-connect\/auth/);
  await page.fill('#username', 'specialist');
  await page.fill('#password', credentials.specialist);
  await page.click('#kc-login');
  await page.waitForURL((url) => url.origin === 'http://localhost:5173' && !url.pathname.startsWith('/auth/'), { timeout: 20_000 });
  await page.goto('http://localhost:5173/?city=10000000-0000-4000-8000-000000000001&ll=76.95000,52.28500&z=13.2');
  await page.locator('.maplibregl-canvas').waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForTimeout(2_000);
  const geometry = await page.evaluate(() => {
    const stage = document.querySelector('.map-stage')?.getBoundingClientRect();
    const top = document.querySelector('.app-top')?.getBoundingClientRect();
    return {
      stage: stage && { width: stage.width, height: stage.height },
      header: top && { width: top.width, height: top.height },
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  if (!geometry.stage || geometry.stage.height < 340 || geometry.overflow > 1) throw new Error(JSON.stringify(geometry));
  await page.screenshot({ path: resolve('../../docs/evidence/final-visual/mobile-map-final.png'), fullPage: true });
  console.log(JSON.stringify(geometry));
} finally {
  await context.close();
  await browser.close();
}
