// Runs text-message conversations against the fixtures and checks every reply and action.
//   node scripts/sms-test.mjs            # assertions
//   node scripts/sms-test.mjs --write    # also regenerate docs/sms-examples.md
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.fetch = async url => { const f = path.join(root, 'web', String(url).replace(/^\.\//, '')); return { ok: fs.existsSync(f), json: async () => JSON.parse(fs.readFileSync(f, 'utf8')) }; };
const { adapter } = await import('../web/src/data.js');
const { createEngine } = await import('../web/src/sms/engine.js');
const { makeTranslator } = await import('../web/src/translate.js');
const J = f => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));

async function freshStore() {
  const people = await adapter.crews();
  const pm = people.find(p => p.role === 'pm');
  const { jobs, draws } = await adapter.load(pm);
  return { people, jobs, draws, rollout: J('web/fixtures/rollout.json'), drawRules: J('web/content/draw-rules.json'),
    checklists: { windows: J('web/content/checklists/windows.json'), siding: J('web/content/checklists/siding.json') } };
}
const strings = { en: J('i18n/en.json'), es: J('i18n/es.json') };
const PHONE = { tucker: '+17065550112', luis: '+17065550107', rafael: '+17065550133', mike: '+17065550100' };
const NAME = Object.fromEntries(Object.entries(PHONE).map(([k, v]) => [v, k]));

let fails = 0, md = [];
const check = (cond, msg) => { if (!cond) { fails++; console.log('  FAIL', msg); } else console.log('  ok  ', msg); };
function transcript(title) { md.push(`\n### ${title}\n`); }
async function say(engine, who, body, media = []) {
  const r = await engine.handle(PHONE[who], body, media);
  md.push(`**${who}:** ${body}${media.length ? ` 📷×${media.length}` : ''}  `);
  for (const x of r.replies) md.push(`${x.to === PHONE[who] ? '> **Vista:**' : `> *→ text to ${NAME[x.to] || x.to}:*`} ${x.text.replace(/\n/g, '  \n> ')}\n`);
  return { me: r.replies.find(x => x.to === PHONE[who])?.text || '', others: r.replies.filter(x => x.to !== PHONE[who]), actions: r.actions };
}
const photo = n => Array.from({ length: n }, (_, i) => `https://mms.example/p${Date.now()}-${i}.jpg`);

// ---------------------------------------------------------------------------------------------
const store = await freshStore();
let lastVi = null;
const e = createEngine({ store, strings, tr: makeTranslator(J('web/fixtures/translations.json')),
  askVi: async a => { lastVi = a; return a.viLanguage ? `(Vi answers in ${a.viLanguage})` : a.lang === 'es' ? '(respuesta de Vi)' : a.lang === 'bi' ? '(Vi answers here) / (respuesta de Vi)' : '(Vi answers here)'; } });
let r;

console.log('Unknown number'); transcript('Unknown number');
r = await e.handle('+19995550000', 'hi'); md.push(`**unknown:** hi  \n> **Vista:** ${r.replies[0].text.replace(/\n/g, '  \n> ')}\n`);
check(/isn't set up/.test(r.replies[0].text) && /no está registrado/.test(r.replies[0].text), 'unknown number gets EN + ES');

console.log('Installer, English: list, start, line items, pay with photos'); transcript('Installer (English): the whole job by text');
r = await say(e, 'tucker', 'today');
check(/Patricia Simmons/.test(r.me) && !/Andre Bolton/.test(r.me), 'list shows dispatched visits only (Bolton not dispatched)');
r = await say(e, 'tucker', '1');
check(/WO 00041872/.test(r.me) && /Map: https/.test(r.me), 'details with map link');
r = await say(e, 'tucker', 'pay 1');
check(/Start the job first/.test(r.me), 'pay blocked until started');
r = await say(e, 'tucker', 'start 1');
check(r.actions.some(a => a.kind === 'serviceappointment.start'), 'start writes ServiceAppointment In Progress');
r = await say(e, 'tucker', 'done 1 all');
check(r.actions.filter(a => a.kind === 'woli.status').length === 3 && /All line items/.test(r.me), 'DONE 1 ALL marks 3 line items installed');
r = await say(e, 'tucker', 'pay 1');
check(/How much\? \(up to \$14,850\)/.test(r.me), 'asks amount, capped at contract');
r = await say(e, 'tucker', '20000');
check(/up to \$14,850/.test(r.me), 'rejects amount over contract');
r = await say(e, 'tucker', '$1,500');
check(/Before, each opening/.test(r.me), 'first photo kind requested');
r = await say(e, 'tucker', '', photo(2));
check(/Got 2 of 1/.test(r.me) && /Flashing/.test(r.me), 'MMS photos counted, moves to next kind');
r = await say(e, 'tucker', 'next');
check(/Still need 1 more/.test(r.me) && /No photos, no pay/.test(r.me), 'NEXT without photos is refused');
r = await say(e, 'tucker', '', photo(1));
r = await say(e, 'tucker', '', photo(2));
r = await say(e, 'tucker', '', photo(3));
check(/checklist steps/.test(r.me), 'after all photo kinds, asks checklist');
r = await say(e, 'tucker', 'steps');
check(/1\) Walk the job/.test(r.me), 'STEPS lists the checklist');
r = await say(e, 'tucker', 'yes');
check(/Describe the work/.test(r.me), 'line items already done, goes to description');
r = await say(e, 'tucker', 'Replaced 8 double-hung and the picture window, capped outside, cleaned up.');
check(/Submit for pay: \$1,500/.test(r.me) && /8 photos/.test(r.me) && /3\/3/.test(r.me), 'summary before sending');
r = await say(e, 'tucker', 'send');
check(r.actions.some(a => a.kind === 'payrequest.create') && /Sent to Mike/.test(r.me), 'pay request created at New');
check(r.others.some(x => x.to === PHONE.mike && /new pay request/.test(x.text)), 'PM gets a text');

console.log('PM, English: review, approve with confirmation'); transcript('PM (English): review and approve by text');
r = await say(e, 'mike', 'review');
check(/3 pay requests waiting/.test(r.me), 'three pay requests waiting');
const idxOf = name => r.me.split('\n').find(l => l.includes(name))?.match(/^(\d+)\)/)?.[1];
const simmons = idxOf('Patricia Simmons'), pierce = idxOf('Yolanda Pierce');
r = await say(e, 'mike', `review ${simmons}`);
check(/✔ Before, each opening: 2 \(need 1\)/.test(r.me) && /Photos: https/.test(r.me), 'checklist lines with photo link');
r = await say(e, 'mike', `review ${pierce}`);
check(/Replaced 6 courses on the rear elevation/.test(r.me), "installer's Spanish description translated for the PM");
r = await say(e, 'mike', `approve ${simmons}`);
check(/Are you sure you want to submit this pay request\?/.test(r.me), 'confirmation question');
r = await say(e, 'mike', 'yes');
check(r.actions.some(a => a.kind === 'payrequest.approve' && a.payload.Status__c === 'Approved'), 'approved directly (no approval process)');
check(r.others.some(x => x.to === PHONE.tucker && /approved \$1,500/.test(x.text)), 'installer told it was approved');

console.log('PM sends back a short one; Spanish installer fixes it by text'); transcript('PM sends back; installer (Spanish) fixes it by text');
r = await say(e, 'mike', 'review');
const pierce2 = idxOf('Yolanda Pierce');
r = await say(e, 'mike', `approve ${pierce2}`);
check(/Can't approve: lines 1 2 are short/.test(r.me), 'approval blocked when photos are short');
r = await say(e, 'mike', `fix ${pierce2} blurry`);
check(r.actions.some(a => a.kind === 'payrequest.sendBack'), 'sent back');
const toLuis = r.others.find(x => x.to === PHONE.luis);
check(toLuis && /tu PM devolvió/.test(toLuis.text) && /mínimo 4/.test(toLuis.text), 'installer notified in Spanish');
r = await say(e, 'luis', 'cobrar 41880');
check(/Tu PM necesita/.test(r.me) && /Envía 2 o más/.test(r.me), 'resubmit asks only for the missing before photos (2 more)');
r = await say(e, 'luis', '', photo(2));
check(/Membrana/.test(r.me), 'then the wrap photos');
r = await say(e, 'luis', '', photo(2));
check(/Reenviar a tu PM/.test(r.me), 'resubmit summary');
r = await say(e, 'luis', 'enviar');
check(r.actions.some(a => a.kind === 'payrequest.resubmit') && r.others.some(x => x.to === PHONE.mike), 'resubmitted, PM notified');
r = await say(e, 'mike', 'review');
const pierce3 = idxOf('Yolanda Pierce');
r = await say(e, 'mike', `approve ${pierce3}`);
check(/Are you sure/.test(r.me), 'now approvable');
r = await say(e, 'mike', 'no');
check(/Cancelled/.test(r.me), 'NO cancels the confirmation');

console.log('PM issues a draw by text'); transcript('PM issues a draw by text');
r = await say(e, 'mike', 'draw 41872 2000 first floor windows');
check(/No draw on WO 00041872/.test(r.me) && /progress photos/.test(r.me), 'draw blocked without progress photos');
r = await say(e, 'mike', 'draw 41859 3000 front and left elevations');
check(/Are you sure you want to submit this draw\?/.test(r.me), 'draw confirmation question');
r = await say(e, 'mike', 'yes');
check(r.actions.some(a => a.kind === 'draw.issue') && store.draws.some(d => d.Did_you_complete_the_job_or_service__c === 'No' && d.Status__c === 'Approved' && d.Amount__c === 3000), 'draw created Approved, job complete = No');

console.log('Installer asks for a draw'); transcript('Installer asks for a draw');
r = await say(e, 'luis', 'adelanto');
check(/tu PM/.test(r.me) && /\+17065550100/.test(r.me), 'installer pointed to the PM directly');

console.log('Measure tech, Spanish'); transcript('Measure tech (Spanish)');
r = await say(e, 'rafael', 'hoy');
check(/Denise Oglesby/.test(r.me) && !/Byrd/.test(r.me), 'measurement visits only, undispatched hidden');
r = await say(e, 'rafael', 'empezar 1');
r = await say(e, 'rafael', 'terminar 1');
check(/Faltan 2 partidas/.test(r.me), 'finish blocked until measured');
r = await say(e, 'rafael', 'listo 1 todas');
check(/Medición terminada|Todas las partidas/.test(r.me) && r.actions.every(a => a.payload.Status === 'Measurement Completed'), 'line items → Measurement Completed');
r = await say(e, 'rafael', 'terminar 1');
check(r.actions.some(a => a.kind === 'serviceappointment.complete'), 'visit completed');
r = await say(e, 'rafael', 'cobrar 1');
check(/TERMINAR/.test(r.me) && !r.actions.length, 'measure techs have no pay');

console.log('Language, channel, Vi, digest'); transcript('Language, channel choice, and Vi');
r = await say(e, 'mike', 'español');
check(/en español/.test(r.me), 'PM switches to Spanish');
r = await say(e, 'mike', 'ayuda');
check(/REVISAR 1/.test(r.me), 'Spanish help for PMs');
r = await say(e, 'mike', 'english');
r = await say(e, 'tucker', 'app');
check(store.people.find(p => p.id === 'crew-12').channel === 'app' && r.actions.some(a => a.kind === 'person.channel'), 'installer chooses app-only');
r = await say(e, 'tucker', 'how long should low-expansion foam cure before trim?');
check(/^Vi: /.test(r.me) && r.actions.some(a => a.kind === 'vi.ask'), 'free text goes to Vi');
check(e.morningDigest(store.people.find(p => p.id === 'crew-12')) === null, 'no morning text for app-only people');
const luisDigest = e.morningDigest(store.people.find(p => p.id === 'crew-7'));
check(/Buenos días, Luis/.test(luisDigest || ''), 'morning digest in Spanish');

console.log('Languages: translation, original, bilingual, request'); transcript('Languages: translated job text, ORIGINAL, bilingual, requesting a language');
r = await say(e, 'luis', 'hoy');
r = await say(e, 'luis', '1');
check(/Quitar el revestimiento de madera/.test(r.me) && /Traducido para ti/.test(r.me) && /Revestimiento de vinilo D4/.test(r.me), 'job text from Salesforce translated to Spanish');
r = await say(e, 'luis', 'original 1');
check(/Tear off wood lap siding/.test(r.me) && !/Traducido/.test(r.me), 'ORIGINAL shows it as written');
r = await say(e, 'luis', 'bilingue');
check(/Got it: English and Spanish/.test(r.me) && /Listo: inglés y español/.test(r.me) && r.actions.some(a => a.kind === 'person.prefs' && a.payload.lang === 'bi'), 'bilingual mode, saved as a preference');
r = await say(e, 'luis', 'hoy');
check(/Your jobs: \/ Tus trabajos:/.test(r.me) && /In progress \/ En curso/.test(r.me), 'bilingual list');
r = await say(e, 'luis', '1');
check(/Tear off wood lap siding.* \/ Quitar el revestimiento/s.test(r.me), 'bilingual details show original and translation');
r = await say(e, 'tucker', 'idioma');
check(/LANGUAGE Português/.test(r.me), 'LANGUAGE alone lists the options');
r = await say(e, 'tucker', 'language Português');
check(r.actions.some(a => a.kind === 'language.request' && a.payload.language === 'Português') && /Sent to Matt: Português/.test(r.me), 'language request sent to Matt');
r = await say(e, 'tucker', 'what sealant do I use on bronze capping?');
check(lastVi?.viLanguage === 'Português' && /Vi answers in Português/.test(r.me), 'Vi answers in the requested language');
r = await say(e, 'luis', 'español');
check(/en español/.test(r.me), 'back to Spanish');

console.log('Rollout off'); transcript('Crew not switched on');
store.rollout.locations.Augusta.optOutAccounts = ['Hernández Siding'];
r = await say(e, 'luis', 'hoy');
check(/todavía no está activo/.test(r.me), 'opted-out crew gets the off message');

if (process.argv.includes('--write')) {
  fs.writeFileSync(path.join(root, 'docs/sms-examples.md'), `# Vista by text: example conversations\n\nGenerated by \`node scripts/sms-test.mjs --write\` from the fixtures. Every line below is real engine output.\n${md.join('\n')}\n`);
  console.log('wrote docs/sms-examples.md');
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
