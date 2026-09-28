// Report a problem, end to end in demo mode: Tucker reports "work stopped" with photos; the job shows the
// case with its photos; Mike sees it after switching crews; Luis gets the screen in Spanish.
// Run with the dev server up:  npm run dev  (another terminal)  then  npm run test:problem
import os from 'node:os'; import fs from 'node:fs'; import path from 'node:path';
import { chromium } from 'playwright';
const S = fs.mkdtempSync(path.join(os.tmpdir(), 'vista-problem-')), BASE = process.env.BASE || 'http://localhost:4173';
const b = await chromium.launch(); const errors = [];
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const p = await ctx.newPage(); p.on('pageerror', e => errors.push(e.message)); p.on('console', m => m.type() === 'error' && errors.push(m.text()));
const cam = await ctx.newPage(); await cam.setContent('<body style="margin:0;background:#6b4e2e;height:100vh;display:grid;place-items:center;font:bold 60px sans-serif;color:#fff">rot</body>'); const jpg = await cam.screenshot({ type: 'jpeg' }); await cam.close();
const shot = async n => { await p.waitForTimeout(350); await p.screenshot({ path: `${S}/${n}.jpg`, type: 'jpeg', quality: 78 }); };
const text = async sel => (await p.textContent(sel)).replace(/\s+/g, ' ').trim();
const idb = s => p.evaluate(s => new Promise(r => { const q = indexedDB.open('vista'); q.onsuccess = () => { const t = q.result.transaction(s).objectStore(s).getAll(); t.onsuccess = () => r(t.result.map(x => ({ ...x, blob: x.blob?.size }))); }; }), s);
const pick = async crew => { await p.waitForSelector('[data-crew]'); await p.click(`[data-crew="${crew}"]`); await p.waitForSelector('#nav a'); await p.waitForTimeout(400); };
const switchTo = async crew => { await p.goto(BASE + '/#/today'); await p.waitForSelector('#switchCrew'); await p.click('#switchCrew'); await pick(crew); };
let fail = 0; const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fail++; };

await p.goto(BASE + '/'); await pick('crew-12');
const wo = '0WO5e00000A1k9pEAB';
await p.goto(BASE + '/#/job/' + wo); await p.waitForTimeout(300);
await p.click(`a[href="#/problem?job=${wo}"]`); await p.waitForSelector('#pbSubject');
check((await p.$eval('#pbWorkType', e => e.value)) === 'Window', 'work type defaults from the trade (Window)');
check(await p.$eval('#pbSend', e => e.disabled), 'send locked until the required answers are in');
await shot('01-empty');
await p.fill('#pbSubject', 'Rot in the sill at the picture window');
await p.fill('#pbDetails', 'Soft wood about 18 inches along the sill. Stopped before setting the unit.');
await p.check('#pbBlocking');
await p.setInputFiles('#pbPhoto', [{ name: 'a.jpg', mimeType: 'image/jpeg', buffer: jpg }, { name: 'b.jpg', mimeType: 'image/jpeg', buffer: jpg }]); await p.waitForTimeout(600);
check((await p.$$('.shot .thumbs img')).length === 2, 'two photos on the report');
check((await p.$eval('#pbSubject', e => e.value)).startsWith('Rot'), 'typed text survives adding photos');
check(await p.$eval('#pbBlocking', e => e.checked), '"work is stopped" survives adding photos');
check((await text('#blockers')).includes('who pays'), 'still needs who pays');
await p.click('input[name=serviceType][value="Warranty"]'); await p.click('input[name=warrantyType][value="Installer Warranty"]');
check(!(await p.$eval('#pbSend', e => e.disabled)), 'send enabled once answered');
await p.evaluate(() => window.scrollTo(0, 0)); await shot('02-filled');
await p.evaluate(() => window.scrollTo(0, 1e5)); await shot('03-questions');
await p.click('#pbSend'); await p.waitForSelector('.sheet'); await shot('04-confirm');
const sheet = await text('.sheet'); check(/High · work stopped/.test(sheet) && /Installer workmanship/.test(sheet), 'confirm shows priority and plain-language warranty');
await p.click('[data-yes]'); await p.waitForTimeout(900);
check(p.url().endsWith('#/job/' + wo), 'back on the job');
const c = (await idb('cases')).find(x => x._local);
check(c && c.Subject === '[Vista] Rot in the sill at the picture window' && c.Priority === 'High' && c.Warranty_Type__c === 'Installer Warranty' && c._photos.length === 2, 'local case saved with the Salesforce values');
await p.evaluate(() => { const el = [...document.querySelectorAll('.sec h2')].find(h => /problems/i.test(h.textContent)); el && window.scrollTo(0, el.getBoundingClientRect().top + scrollY - 80); });
await p.waitForTimeout(500); await shot('05-job');
check((await p.$$eval('.casethumbs img', e => e.filter(i => i.naturalWidth > 0).length)) === 2, 'job shows the case with its photos');
const ph = await idb('photos'); check(ph.filter(x => x.purpose === 'problem' && !x.draft).length === 2, 'photos marked for upload, kept apart from pay photos');
await p.goto(BASE + '/#/draw?job=' + wo); await p.waitForTimeout(300); // pay screen must not pick up problem photos
await p.goto(BASE + '/#/job/' + wo); await p.waitForSelector('#startJob'); await p.click('#startJob'); await p.waitForTimeout(300);
await p.goto(BASE + '/#/draw?job=' + wo); await p.waitForSelector('.shot');
check((await p.$$('.shot .thumbs img')).length === 0, 'pay screen does not show problem photos');
await switchTo('pm-mike'); await p.goto(BASE + '/#/job/' + wo); await p.waitForTimeout(600);
check(/Rot in the sill/.test(await text('#app')), 'Mike sees the problem on the job');
await switchTo('crew-7'); await p.goto(BASE + '/#/problem?job=0WO5e00000B2m1qEAB'); await p.waitForSelector('#pbSubject');
check((await p.$eval('#pbWorkType', e => e.value)) === 'Siding', 'siding job defaults to Siding');
check(/Reportar un problema/.test(await text('#app')) && /Quién paga el arreglo/.test(await text('#app')), 'Spanish screen');
await shot('06-es');
console.log('errors:', errors); await b.close();
console.log('screenshots in', S);
if (fail || errors.length) process.exit(1);
