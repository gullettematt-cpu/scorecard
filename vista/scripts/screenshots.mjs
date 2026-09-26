// Walkthrough + screenshots for both crews. Needs: npm run dev in another shell, and playwright installed.
// node scripts/screenshots.mjs   → docs/screenshots/*.png, web/icons/*.png
import { chromium } from 'playwright';
const base = 'http://localhost:4173';
const browser = await chromium.launch();
const errors = [];
// PNG icons from the SVG
{
  const p = await browser.newPage();
  for (const size of [192, 512]) {
    await p.setViewportSize({ width: size, height: size });
    await p.setContent(`<html><body style="margin:0"><img src="${base}/icons/vista.svg" width="${size}" height="${size}" style="display:block"></body></html>`);
    await p.waitForTimeout(200);
    await p.screenshot({ path: `web/icons/vista-${size}.png`, omitBackground: true });
  }
  await p.close();
}
for (const [crew, tag] of [['crew-12', 'en'], ['crew-7', 'es']]) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: tag === 'es' ? 'es-US' : 'en-US' });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') errors.push(`[${crew}] console: ${m.text()}`); });
  page.on('pageerror', e => errors.push(`[${crew}] pageerror: ${e.message}`));
  await page.goto(base + '/#/today');
  await page.waitForSelector('[data-crew]');
  if (crew === 'crew-12') await page.screenshot({ path: 'docs/screenshots/00-pick-crew.png' });
  await page.click(`[data-crew="${crew}"]`);
  await page.waitForSelector('.card[href^="#/job/"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `docs/screenshots/${tag}-1-today.png`, fullPage: true });
  const href = await page.getAttribute('.card[href^="#/job/"]', 'href');
  await page.click('.card[href^="#/job/"]');
  await page.waitForSelector('.check');
  // tick two checklist items to exercise local save + outbox
  const boxes = page.locator('input[data-step]');
  await boxes.nth(0).check(); await boxes.nth(1).check();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `docs/screenshots/${tag}-2-job.png`, fullPage: true });
  // reload: checklist must persist from IndexedDB
  await page.reload(); await page.waitForSelector('.check');
  const persisted = await page.locator('input[data-step]:checked').count();
  const progress = await page.textContent('#clProgress');
  const swOk = await page.evaluate(async () => !!(await navigator.serviceWorker?.getRegistration()));
  console.log(`${crew}: job=${href} persisted=${persisted} progress="${progress}" sw=${swOk}`);
  // offline: header pill flips and app still renders from cache/IDB
  await ctx.setOffline(true);
  await page.goto(base + '/#/today').catch(() => {});
  await page.waitForTimeout(600);
  const pill = await page.textContent('#netPill').catch(() => 'no render');
  const cards = await page.locator('.card[href^="#/job/"]').count();
  console.log(`${crew}: offline pill="${pill.trim()}" cards=${cards}`);
  if (crew === 'crew-7') await page.screenshot({ path: `docs/screenshots/${tag}-3-offline.png` });
  await ctx.close();
}
await browser.close();
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no console errors');
