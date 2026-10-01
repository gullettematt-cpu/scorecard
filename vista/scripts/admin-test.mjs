// Program admin (payroll), end to end in demo mode: Lisa's pay run board and PM reminder, People (find, change,
// turn off), Rollout (switching Augusta off really hides Vista from a crew), Health, and the PM's cutoff countdown.
// Run with the dev server up:  npm run dev  (another terminal)  then  npm run test:admin
import os from 'node:os'; import fs from 'node:fs'; import path from 'node:path';
import { chromium } from 'playwright';
const S = fs.mkdtempSync(path.join(os.tmpdir(), 'vista-admin-')), BASE = process.env.BASE || 'http://localhost:4173';
const b = await chromium.launch(); const errors = [];
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const p = await ctx.newPage(); p.on('pageerror', e => errors.push(e.message)); p.on('console', m => m.type() === 'error' && errors.push(m.text()));
const shot = async n => { await p.waitForTimeout(350); await p.screenshot({ path: `${S}/${n}.jpg`, type: 'jpeg', quality: 78 }); };
const text = async sel => (await p.textContent(sel)).replace(/\s+/g, ' ').trim();
const pick = async crew => { await p.waitForSelector('[data-crew]'); await p.click(`[data-crew="${crew}"]`); await p.waitForSelector('#nav a'); await p.waitForTimeout(500); };
const switchTo = async crew => { const admin = await p.$('#nav a[href="#/admin/health"]'); await p.goto(BASE + (admin ? '/#/admin/health' : '/#/today')); await p.waitForSelector('#switchCrew'); await p.click('#switchCrew'); await pick(crew); };
let fail = 0; const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fail++; };

await p.goto(BASE + '/'); await p.waitForSelector('[data-crew="admin-lisa"]');
check(/Payroll · program admin/.test(await text('[data-crew="admin-lisa"]')), 'Lisa is on the sign-in list as payroll');
await pick('admin-lisa');
await p.waitForSelector('.tiles');
check((await p.$$eval('#nav a', a => a.map(x => x.textContent.trim()))).join('|') === 'Pay run|People|Rollout|Health|Ask Vi', 'admin navigation');
check(/cutoff/i.test(await text('.cutoff')), 'cutoff countdown in the header');
const tiles = await p.$$eval('.tile b', e => e.map(x => Number(x.textContent)));
check(tiles[0] >= 1, `requests waiting on PMs: ${tiles[0]}`);
check((await p.$$('.pmcard')).length >= 1 && /Mike/.test(await text('.pmcard h3')), 'grouped by PM (Mike)');
await shot('01-payrun');
await p.click('.nudge'); await p.waitForSelector('.nudge-result .hint.ok');
check(/Texted Mike about \d+ waiting/.test(await text('.nudge-result')), 'reminder sent to Mike');
check(/pay request\(s\) are waiting for your review/.test(await text('.nudge-result .bubble')), 'shows the text Mike gets');
await shot('02-nudged');
await p.goto(BASE + '/#/admin'); await p.waitForSelector('.nudge'); await p.click('.nudge'); await p.waitForSelector('.nudge-result .hint');
check(/already texted/.test(await text('.nudge-result')), 'no second reminder within the hour');
// People
await p.click('#nav a[href="#/admin/people"]'); await p.waitForSelector('#pSearch');
check((await p.$$('.person')).length >= 4, 'people listed by role');
await p.fill('#pSearch', 'luis'); await p.waitForTimeout(200);
check((await p.$$('[data-phone]')).length === 1 && (await p.$eval('#pSearch', e => document.activeElement === e)), 'search filters and keeps focus');
await shot('03-people');
await p.click('[data-phone]'); await p.waitForSelector('#pForm');
await p.selectOption('#pForm [name=channel]', 'text'); await p.check('#pForm [name=disabled]');
await p.click('#pForm button.primary'); await p.waitForSelector('.sheet'); await p.click('[data-yes]'); await p.waitForSelector('#pSearch');
await p.fill('#pSearch', ''); await p.waitForTimeout(200);
check(/Off/.test(await text('.person.off')) && /Texts only/.test(await text('.person.off')), 'Luis turned off, texts only');
await p.click('#pAdd'); await p.waitForSelector('#pForm');
await p.fill('#pForm [name=name]', 'Ana Ruiz'); await p.fill('#pForm [name=phone]', '+17065550188'); await p.selectOption('#pForm [name=lang]', 'es');
await p.click('#pForm button.primary'); await p.waitForTimeout(400);
check(/Ana Ruiz/.test(await text('#app')), 'new person added');
// Rollout: Augusta off, then check a crew sees it off
await p.click('#nav a[href="#/admin/rollout"]'); await p.waitForSelector('.seg');
check(await p.$eval('.seg button.on', e => e.textContent === 'On'), 'Augusta starts On in the demo');
await p.click('.seg button[data-mode="pilot"]'); await p.fill('[data-in="Augusta|pilotAccounts"]', 'Tucker Installs LLC'); await p.click('[data-add="Augusta|pilotAccounts"]');
check(/Tucker Installs LLC/.test(await text('.acct')), 'pilot company added');
await shot('04-rollout');
await p.click('.seg button[data-mode="off"]'); await p.click('#saveRoll'); await p.waitForSelector('.sheet'); await p.click('[data-yes]'); await p.waitForTimeout(400);
// Health
await p.click('#nav a[href="#/admin/health"]'); await p.waitForSelector('#runHb');
check(/Vista is working/.test(await text('.health')), 'health shows working');
await p.click('#runHb'); await p.waitForSelector('#runHb:not([disabled])'); check(/Last good check/.test(await text('.health')), 'health check re-run');
await p.click('#runSf'); await p.waitForSelector('#sfResult .sfhead');
check(/Ready: \d+ passed/.test(await text('#sfResult')), 'Check Salesforce shows Ready');
await p.click('#runDiag'); await p.waitForSelector('#diagResult .sfhead');
check(/1 problem/.test(await text('#diagResult .sfhead')) && (await p.$$('[data-fix="twilio.webhook"]')).length === 1, 'Diagnose finds the Twilio webhook problem, with Fix it');
await shot('05b-diagnose');
await p.click('[data-fix="twilio.webhook"]'); await p.waitForSelector('[data-yes]'); await p.click('[data-yes]');
await p.waitForFunction(() => /All clear/.test(document.querySelector('#diagResult .sfhead')?.textContent || ''), null, { timeout: 10000 }).catch(() => {});
check(/All clear/.test(await text('#diagResult .sfhead')), 'Fix it repairs it and the diagnosis re-runs clean');
await shot('05-health');
// A crew now sees Vista switched off
await switchTo('crew-12');
check(/rollout|not on Vista|isn't on Vista|Vista isn/i.test(await text('#app')) || (await p.$$('a[href^="#/job/"]')).length === 0, 'Augusta off: Tucker sees no jobs');
// PM sees the cutoff countdown on Approve
await switchTo('pm-mike'); await p.goto(BASE + '/#/approve'); await p.waitForTimeout(400);
check((await p.$$('.cutoff')).length === 1, 'PM approve list shows the cutoff countdown');
// Spanish admin
await switchTo('admin-lisa'); await p.waitForSelector('.nudge, .tile'); await p.click('#langBtn'); await p.waitForSelector('[data-lang]'); await p.click('[data-lang="es"]'); await p.waitForFunction(() => /Esperando/.test(document.querySelector('#app')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
const es = await text('#app'), nv = await text('#nav'); check(/Esperando a los PM/.test(es) && /Pagos/.test(nv), 'Spanish admin screens'); if (!/Esperando/.test(es)) console.log('   app text:', es.slice(0, 200), '| nav:', nv);
console.log('errors:', errors); await b.close();
console.log('screenshots in', S);
if (fail || errors.length) process.exit(1);
