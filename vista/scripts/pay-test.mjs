// Submit for pay, end to end in demo mode: photos, checklist, line items, amount, confirm; Mike reviews the
// real photos and sends it back; Tucker adds only what's missing; Mike approves.
// Run with the dev server up:  npm run dev  (another terminal)  then  npm run test:pay
import os from 'node:os'; import fs from 'node:fs'; import path from 'node:path';
import { chromium } from 'playwright';
const S = fs.mkdtempSync(path.join(os.tmpdir(), 'vista-pay-')), BASE = process.env.BASE || 'http://localhost:4173';
fs.mkdirSync(S + '/pay');
const b = await chromium.launch(); const errors = [];
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const p = await ctx.newPage(); p.on('pageerror', e => errors.push(e.message)); p.on('console', m => m.type() === 'error' && errors.push(m.text()));
// A real JPEG to "take": render a coloured block and screenshot it.
const cam = await ctx.newPage(); const jpg = {};
for (const [k, c] of [['before', '#8a6d4b'], ['flashing', '#3d6b8a'], ['serial', '#777'], ['after', '#4b8a5a']]) { await cam.setContent(`<body style="margin:0;background:${c};display:grid;place-items:center;height:100vh;font:bold 60px sans-serif;color:#fff">${k}</body>`); jpg[k] = await cam.screenshot({ type: 'jpeg' }); }
await cam.close();
const shot = async n => { await p.waitForTimeout(400); await p.screenshot({ path: `${S}/pay/${n}.jpg`, type: 'jpeg', quality: 78 }); };
const text = async sel => (await p.textContent(sel)).replace(/\s+/g, ' ').trim();
const idb = (store) => p.evaluate(s => new Promise(r => { const q = indexedDB.open('vista'); q.onsuccess = () => { const t = q.result.transaction(s).objectStore(s).getAll(); t.onsuccess = () => r(t.result.map(x => ({ ...x, blob: x.blob ? x.blob.size : undefined }))); }; }), store);
const pick = async crew => { await p.waitForSelector('[data-crew]'); await p.click(`[data-crew="${crew}"]`); await p.waitForSelector('#nav a'); await p.waitForTimeout(400); };
const switchTo = async crew => { await p.goto(BASE + '/#/today'); await p.waitForSelector('#switchCrew'); await p.click('#switchCrew'); await pick(crew); };

await p.goto(BASE + '/'); await pick('crew-12');
const wo = '0WO5e00000A1k9pEAB';
// Before starting: Pay tab says start first
await p.goto(BASE + '/#/draw'); await p.waitForTimeout(400); console.log('pay tab before start:', (await text('#app')).slice(80, 220));
await p.goto(BASE + '/#/job/' + wo); await p.waitForSelector('#startJob'); await p.click('#startJob'); await p.waitForTimeout(500);
await p.goto(BASE + '/#/draw'); await p.waitForSelector('.shot'); console.log('redirected to:', p.url().split('#')[1]);
await shot('01-empty');
console.log('submit disabled at start:', await p.$eval('#paySubmit', e => e.disabled), '| blockers:', await text('#blockers'));
for (const k of ['before', 'flashing', 'serial', 'after']) {
  await p.setInputFiles(`input[data-kind="${k}"]`, { name: `${k}.jpg`, mimeType: 'image/jpeg', buffer: jpg[k] });
  await p.waitForSelector(`input[data-kind="${k}"]`, { state: "attached" }); await p.waitForTimeout(400);
}
await p.setInputFiles('input[data-kind="before"]', [{ name: 'b2.jpg', mimeType: 'image/jpeg', buffer: jpg.before }, { name: 'b3.jpg', mimeType: 'image/jpeg', buffer: jpg.before }]); await p.waitForTimeout(500);
await shot('02-photos');
const photos = await idb('photos'); console.log('photos on phone:', photos.length, photos.map(x => x.Id.split('/').pop() + ':' + x.blob + 'B draft=' + x.draft).join(' '));
// remove one extra
await p.click('[data-rm]'); await p.waitForTimeout(400); console.log('after remove:', (await idb('photos')).length);
// Tick checklist steps and line items right on the Pay screen (each tick redraws).
for (const sel of ['input[data-step]', 'input[data-woli]']) { while (await p.locator(sel).count()) { await p.locator(sel).first().check(); await p.waitForTimeout(120); } }
console.log('sections now:', await p.$$eval('.sec h2', e => e.map(x => x.textContent.replace(/\s+/g, ' ').trim()).join(' | ')));
// Amount over contract, then valid
await p.fill('#payAmount', '999999'); console.log('over:', await text('#blockers'));
await p.fill('#payAmount', '1500'); await p.fill('#payDesc', 'Replaced 9 windows, all trim caulked, homeowner walked it.');
console.log('ready:', !(await p.$eval('#paySubmit', e => e.disabled)), '|', await text('#blockers'));
await p.evaluate(() => window.scrollTo(0, 1e5)); await shot('03-ready');
await p.click('#paySubmit'); await p.waitForSelector('.sheet'); await shot('04-confirm');
console.log('confirm:', await text('.sheet'));
await p.click('[data-yes]'); await p.waitForTimeout(900); await shot('05-after');
console.log('back on:', p.url().split('#')[1], '| toast:', await p.evaluate(() => document.querySelector('.toast')?.textContent));
const d = (await idb('draws')).find(x => x._local); const m = JSON.parse(d.Additional_Work_Performed_Description__c.split('-->')[1]);
console.log('local request:', d.Amount__c, d.Status__c, 'photos', m.photos.length, m.photos.map(x => x.kind).join(','), 'checklist', m.checklist?.done?.length);
console.log('job pay chip:', (await text('#app')).match(/With your PM|Con su PM/)?.[0]);
await p.goto(BASE + '/#/draw?job=' + wo); await p.waitForTimeout(400); console.log('pay screen now:', (await text('#app')).match(/This job's pay request[^.]*\./)?.[0]);

// Mike reviews: real photos, send back 'after'
await switchTo('pm-mike');
await p.goto(BASE + '/#/approve'); await p.waitForTimeout(500); console.log('queue:', await text('#app').then(s => s.match(/Patricia Simmons[^·]*/)?.[0]));
await p.click(`a[href="#/approve/${d.Id}"]`); await p.waitForSelector('#sendBack');
console.log('review imgs:', await p.$$eval('.phgrid img', e => e.filter(i => i.naturalWidth > 0).length));
await shot('06-review');
const n = await p.locator('li[data-line] input:not([disabled])').count();
for (let i = 0; i < n; i++) { const li = p.locator('li[data-line]').nth(i); if ((await li.getAttribute('data-line')) !== 'photo:after') { const cb = li.locator('input'); if (!(await cb.isDisabled())) await cb.check(); } }
await p.waitForTimeout(500); await p.click('#sendBack'); await p.waitForTimeout(300);
if (await p.$('.sheet')) await p.click('[data-yes]');
await p.waitForTimeout(700);
// Tucker fixes: only 'after' asked
await switchTo('crew-12');
await p.goto(BASE + '/#/job/' + wo); await p.waitForTimeout(500); console.log('job button:', (await text('#app')).match(/Add what's missing/)?.[0]);
await p.goto(BASE + '/#/draw?job=' + wo); await p.waitForSelector('.shot'); await shot('07-fix');
console.log('fix asks for:', await p.$$eval('.shot h3', e => e.map(x => x.textContent)), '| missed:', await text('.missedcard'));
await p.setInputFiles('input[data-kind="after"]', { name: 'a2.jpg', mimeType: 'image/jpeg', buffer: jpg.after }); await p.waitForTimeout(500);
await p.click('#paySubmit'); await p.waitForSelector('.sheet'); await p.click('[data-yes]'); await p.waitForTimeout(700);
const d2 = (await idb('draws')).find(x => x.Id === d.Id); const m2 = JSON.parse(d2.Additional_Work_Performed_Description__c.split('-->')[1]);
console.log('resubmitted photos:', m2.photos.length, 'resubmitted_at set:', !!m2.resubmitted_at);
const ob = await idb('outbox'); console.log('outbox kinds:', ob.map(e => e.kind).join(' > '));
// Mike approves
await switchTo('pm-mike'); await p.goto(BASE + '/#/approve/' + d.Id); await p.waitForSelector('#approveBtn');
const n2 = await p.locator('li[data-line] input:not([disabled])').count(); for (let i = 0; i < n2; i++) await p.locator('li[data-line] input:not([disabled])').nth(i).check();
await p.waitForTimeout(300); console.log('approve enabled:', !(await p.$eval('#approveBtn', e => e.disabled)));
await p.click('#approveBtn'); await p.waitForSelector('.sheet'); await p.click('[data-yes]'); await p.waitForTimeout(600);
console.log('final status:', (await idb('draws')).find(x => x.Id === d.Id).Status__c);
// Spanish screen
await switchTo('crew-7'); await p.goto(BASE + '/#/job/0WO5e00000B2m1qEAB'); await p.waitForTimeout(300); await p.goto(BASE + '/#/draw?job=0WO5e00000B2m1qEAB'); await p.waitForTimeout(600); await shot('08-es');
console.log('es:', (await text('#app')).slice(60, 260));
console.log('errors:', errors); await b.close();
if (errors.length) process.exit(1);
console.log('screenshots in', S + '/pay');
