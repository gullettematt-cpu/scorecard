import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createHandler } from '../src/http.mjs';
import { createWorker } from '../src/worker.mjs';
import { signToken, verifyToken, normalizePhone, createAuth } from '../src/lib/auth.mjs';
import { jwtAssertion, createSalesforce, lit, inList } from '../src/lib/salesforce.mjs';
import { twilioSignature, validTwilioSignature, createTwilio } from '../src/lib/twilio.mjs';
import { createPhotos, photoKey } from '../src/lib/photos.mjs';
import { createVi, createTranslations, VI_MODEL } from '../src/lib/vi.mjs';
import { memoryStore } from '../src/lib/store.mjs';
import { readManifest } from '../src/lib/shared.mjs';
import { testDeps, PEOPLE } from './fakes.mjs';
import { S3Client } from '@aws-sdk/client-s3';

const call = (handler, method, path, { body, token, headers = {}, form } = {}) => handler({
  requestContext: { http: { method } }, rawPath: path,
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  body: form ? new URLSearchParams(form).toString() : body ? JSON.stringify(body) : undefined, isBase64Encoded: false
}).then(r => ({ ...r, json: (() => { try { return JSON.parse(r.body); } catch { return null; } })() }));
const tokenFor = (deps, p) => signToken({ sub: p.id, phone: p.phone }, deps.secrets.jwt);

// ---- building blocks ---------------------------------------------------------------------------
test('app tokens: sign, verify, tamper, expiry', () => {
  const t = signToken({ sub: 'x', phone: '+1' }, 's', 60);
  assert.equal(verifyToken(t, 's').sub, 'x');
  assert.equal(verifyToken(t, 'other'), null);
  assert.equal(verifyToken(t.slice(0, -2) + 'aa', 's'), null);
  assert.equal(verifyToken(t, 's', Date.now() + 61_000), null);
});

test('phone numbers normalize to E.164', () => {
  assert.equal(normalizePhone('(706) 555-0112'), '+17065550112');
  assert.equal(normalizePhone('1 706 555 0112'), '+17065550112');
  assert.equal(normalizePhone('555-0112'), null);
});

test('sign-in codes: one use, five tries, rate-limited, never sent to unknown numbers', async () => {
  const store = memoryStore(), texts = [];
  let clock = Date.now(); // the memory store expires items against the real clock
  const auth = createAuth({ store, secret: 's', sendText: async (to, t) => texts.push({ to, t }), now: () => clock });
  await auth.start('+17065550199', null);
  assert.equal(texts.length, 0);
  await auth.start('+17065550112', { id: 'p' }, 'es');
  const code = texts[0].t.match(/\d{6}/)[0];
  assert.match(texts[0].t, /su código/);
  assert.equal(await auth.verify('+17065550112', '000000'.replace(/./g, (_, i) => (Number(code[i]) + 1) % 10)), false);
  assert.equal(await auth.verify('+17065550112', code), true);
  assert.equal(await auth.verify('+17065550112', code), false, 'code is single-use');
  await auth.start('+17065550112', { id: 'p' });
  assert.equal(texts.length, 1, 'no second code within 30 seconds');
  clock += 31e3;
  await auth.start('+17065550112', { id: 'p', lang: 'bi' });
  assert.match(texts[1].t, /your code[\s\S]*su código/, 'bilingual people get both');
  const code2 = texts[1].t.match(/\d{6}/)[0];
  for (let i = 0; i < 5; i++) await auth.verify('+17065550112', '999999' === code2 ? '888888' : '999999');
  assert.equal(await auth.verify('+17065550112', code2), false, 'locked after 5 wrong tries');
  for (let i = 0; i < 6; i++) { clock += 31e3; await auth.start('+17065550112', { id: 'p' }); }
  assert.equal(texts.length, 5, 'at most 5 codes an hour');
  clock += 3600e3; await auth.start('+17065550112', { id: 'p' });
  assert.equal(texts.length, 6, 'allowed again after the hour');
});

test('Salesforce JWT bearer assertion is RS256 and verifies with the certificate key', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwt = jwtAssertion({ clientId: 'CID', username: 'vista@si.com', audience: 'https://login.salesforce.com', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  const [h, p, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256' });
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(claims.iss, 'CID'); assert.equal(claims.sub, 'vista@si.com'); assert.equal(claims.aud, 'https://login.salesforce.com');
  assert.ok(claims.exp - Date.now() / 1000 <= 180);
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url')));
});

test('Salesforce client: logs in, pages queries, re-logs in once on 401, escapes SOQL', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const seen = []; let logins = 0, expired = true;
  const fetchImpl = async (url, opts = {}) => {
    seen.push(url);
    const ok = b => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
    if (url.endsWith('/services/oauth2/token')) { logins++; assert.match(String(opts.body), /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer/); return ok({ access_token: `T${logins}`, instance_url: 'https://si.my.salesforce.com' }); }
    if (url.includes('/query?') && expired) { expired = false; return { ok: false, status: 401, text: async () => 'expired' }; }
    if (url.includes('/query?')) return ok({ done: false, records: [{ Id: 1 }], nextRecordsUrl: '/services/data/v62.0/query/01g-2000' });
    if (url.includes('/query/01g-2000')) return ok({ done: true, records: [{ Id: 2 }] });
    throw new Error(url);
  };
  const sf = createSalesforce({ loginUrl: 'https://login.salesforce.com', clientId: 'c', username: 'u', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), fetchImpl });
  assert.deepEqual((await sf.query('SELECT Id FROM WorkOrder')).map(r => r.Id), [1, 2]);
  assert.equal(logins, 2, 'logged in again after the 401');
  assert.equal(lit("O'Brien\\"), "'O\\'Brien\\\\'");
  assert.equal(inList(['a', "b'"]), "('a','b\\'')");
});

test('Twilio webhook signatures', () => {
  const params = { From: '+17065550112', Body: 'hoy', MessageSid: 'SM1' };
  const sig = twilioSignature('tok', 'https://api.test/sms/inbound', params);
  assert.ok(validTwilioSignature({ authToken: 'tok', url: 'https://api.test/sms/inbound', params, signature: sig }));
  assert.ok(!validTwilioSignature({ authToken: 'tok', url: 'https://api.test/sms/inbound', params: { ...params, Body: 'yes' }, signature: sig }));
});

test('Twilio client: sends from a Messaging Service when set; deletes only this account\'s media', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, ...opts }); return { ok: true, status: 200, json: async () => ({ sid: 'SM1' }) }; };
  await createTwilio({ accountSid: 'AC1', authToken: 't', from: '+17065550100', fetchImpl }).send('+17065550112', 'hi');
  assert.equal(new URLSearchParams(calls[0].body).get('From'), '+17065550100');
  await createTwilio({ accountSid: 'AC1', authToken: 't', from: '+17065550100', messagingServiceSid: 'MG1', fetchImpl }).send('+17065550112', 'hi');
  const b = new URLSearchParams(calls[1].body); assert.equal(b.get('MessagingServiceSid'), 'MG1'); assert.equal(b.get('From'), null);
  const tw = createTwilio({ accountSid: 'AC1', authToken: 't', fetchImpl });
  assert.equal(await tw.deleteMedia('https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME1'), true);
  assert.equal(calls.at(-1).method, 'DELETE'); assert.equal(calls.at(-1).url, 'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME1.json');
  assert.equal(await tw.deleteMedia('https://api.twilio.com/2010-04-01/Accounts/OTHER/Messages/MM1/Media/ME1'), false);
  assert.equal(await tw.deleteMedia('https://evil.test/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME1'), false);
  assert.equal(calls.length, 3);
});

test('photo uploads use short-lived S3 signed URLs under the job', async () => {
  const photos = createPhotos({ bucket: 'vista-photos', region: 'us-east-1', s3: new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'x' } }) });
  const key = photoKey({ workOrderId: '0WO1', serviceAppointmentId: '08p1', kind: 'before', n: 1, at: new Date('2026-09-27T14:02:11Z') });
  assert.equal(key, 'vista/0WO1/08p1/20260927T140211-before-1.jpg');
  const url = new URL(await photos.signPut(key));
  assert.equal(url.hostname, 'vista-photos.s3.us-east-1.amazonaws.com');
  assert.equal(url.searchParams.get('X-Amz-Expires'), '900');
  assert.ok(url.searchParams.get('X-Amz-Signature'));
});

test('Vi and translation send the right Claude requests', async () => {
  const reqs = [];
  const client = { messages: { create: async r => { reqs.push(r); return r.output_config.format
    ? { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ items: [{ source_language: 'es', english: 'Day 1: full tear-off.', spanish: 'Día 1: demolición completa.' }] }) }] }
    : { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Deja curar 30 minutos.' }] }; } } };
  const vi = createVi({ client });
  const answer = await vi.ask({ lang: 'es', question: 'cuánto cura la espuma?', job: { WorkOrderNumber: '1', Subject: 's', Street: 'a', City: 'b', State: 'GA', PostalCode: '1', WorkOrderLineItems: [] } });
  assert.equal(answer, 'Deja curar 30 minutos.');
  assert.equal(reqs[0].model, 'claude-sonnet-5'); assert.equal(VI_MODEL, 'claude-sonnet-5');
  assert.equal(reqs[0].output_config.effort, 'medium');
  assert.equal(reqs[0].system[0].cache_control.type, 'ephemeral');
  assert.match(reqs[0].messages[0].content.at(-1).text, /Reply in Spanish/);
  const pairs = await vi.translate(['Día 1: demolición completa.']);
  assert.deepEqual(pairs, [{ src: 'es', en: 'Day 1: full tear-off.', es: 'Día 1: demolición completa.' }]);
  assert.equal(reqs[1].output_config.format.type, 'json_schema');
  assert.equal(reqs[1].output_config.effort, 'low');
  const refused = createVi({ client: { messages: { create: async () => ({ stop_reason: 'refusal', content: [] }) } } });
  assert.match(await refused.ask({ lang: 'en', question: 'x' }), /call your PM/);
  // cache: second lookup doesn't call Claude again
  const store = memoryStore(); let n = 0;
  const tr = createTranslations({ store, vi: { translate: async t => { n++; return t.map(x => ({ en: x, es: 'es:' + x, src: 'en' })); } } });
  await tr.pairsFor(['Demo and prep, day 1.']); await tr.pairsFor(['Demo and prep, day 1.', 'es:Demo and prep, day 1.']);
  assert.equal(n, 1);
});

// ---- the API end to end, against fixture-backed Salesforce ---------------------------------------
test('sign in by text code, then load a live snapshot with translations', async () => {
  const deps = await testDeps(), h = createHandler(async () => deps);
  assert.equal((await call(h, 'POST', '/auth/start', { body: { phone: '(706) 555-0107' } })).statusCode, 200);
  const code = deps.twilio.sent.at(-1).body.match(/\d{6}/)[0];
  assert.equal((await call(h, 'POST', '/auth/start', { body: { phone: '706-555-9999' } })).statusCode, 200, 'unknown numbers get the same answer');
  assert.equal(deps.twilio.sent.length, 1, '...and no text');
  assert.equal((await call(h, 'POST', '/auth/verify', { body: { phone: '7065550107', code: '000000' } })).statusCode, 401);
  const v = await call(h, 'POST', '/auth/verify', { body: { phone: '7065550107', code } });
  assert.equal(v.statusCode, 200); assert.equal(v.json.person.name, 'Luis Hernández');
  const snap = await call(h, 'GET', '/snapshot', { token: v.json.token });
  assert.equal(snap.statusCode, 200);
  assert.deepEqual(snap.json.jobs.map(j => j.WorkOrderNumber).sort(), ['00041859', '00041880', '00041905']);
  assert.ok(snap.json.jobs.every(j => j._crew === PEOPLE.luis.id && j.ServiceAppointment.Id));
  assert.ok(snap.json.translations.pairs.some(p => p.es.startsWith('Quitar el revestimiento')));
  assert.equal((await call(h, 'GET', '/snapshot')).statusCode, 401);
});

test('app sync: installer starts, marks items, submits for pay; server enforces the rules', async () => {
  const deps = await testDeps(), h = createHandler(async () => deps), tok = tokenFor(deps, PEOPLE.tucker);
  const sync = entries => call(h, 'POST', '/sync', { token: tok, body: { entries } }).then(r => r.json.results);
  const wo = '0WO5e00000A1k9pEAB', sa = '08p5e0000001aA1';
  let r = await sync([{ id: 1, kind: 'serviceappointment.start', payload: { serviceAppointmentId: sa } }]);
  assert.equal(r[0].ok, true);
  assert.equal(deps.sf.world.ServiceAppointment.find(x => x.Id === sa).Status, 'In Progress');
  r = await sync([{ id: 1, kind: 'serviceappointment.start', payload: { serviceAppointmentId: sa } }]);
  assert.equal(r[0].duplicate, true, 'the same outbox entry is only applied once');
  r = await sync([{ id: 2, kind: 'woli.status', payload: { workOrderLineItemId: '1WL1', Status: 'Completed' } }]);
  assert.equal(r[0].ok, false, 'only Installation Completed is allowed from the phone');
  r = await sync(['1WL1', '1WL2', '1WL3'].map((li, i) => ({ id: 10 + i, kind: 'woli.status', payload: { workOrderLineItemId: li, Status: 'Installation Completed' } })));
  assert.ok(r.every(x => x.ok));
  // someone else's visit
  r = await sync([{ id: 20, kind: 'serviceappointment.start', payload: { serviceAppointmentId: '08p5e0000002bB3' } }]);
  assert.equal(r[0].status, 403);
  // pay request: photos below minimum refused; over-contract refused; then accepted
  const photos = kinds => kinds.map(kind => ({ kind, key: `vista/${wo}/${sa}/20260928T120000-${kind}-1.jpg` }));
  // The phone names its keys and asks for upload links; keys outside this job are refused.
  const keys = photos(['before', 'flashing', 'serial', 'after']).map(p => p.key);
  const signed = await call(h, 'POST', '/photos/sign', { token: tok, body: { workOrderId: wo, keys } });
  assert.deepEqual(signed.json.uploads.map(u => u.key), keys);
  assert.equal((await call(h, 'POST', '/photos/sign', { token: tok, body: { workOrderId: wo, keys: ['vista/OTHER/x/20260928T120000-before-1.jpg'] } })).statusCode, 422);
  assert.equal((await call(h, 'POST', '/photos/sign', { token: tok, body: { workOrderId: '0WO5e00000B2m1qEAB', keys } })).statusCode, 403, 'not his job');
  // Listed but not uploaded yet: "try again", not refused.
  r = await sync([{ id: 29, kind: 'payrequest.create', payload: { workOrderId: wo, Amount__c: 1500, description: 'done', manifest: { photos: photos(['before', 'flashing', 'serial', 'after']) } } }]);
  assert.equal(r[0].status, 503); assert.match(r[0].error, /still uploading/);
  for (const k of keys) deps.photos.objects.set(k, 'jpeg'); // the phone's PUTs land
  r = await sync([{ id: 30, kind: 'payrequest.create', payload: { workOrderId: wo, Amount__c: 1500, description: 'done', manifest: { photos: photos(['before', 'after']) } } }]);
  assert.equal(r[0].status, 422); assert.match(r[0].error, /no photos, no pay/);
  r = await sync([{ id: 31, kind: 'payrequest.create', payload: { workOrderId: wo, Amount__c: 99999, description: 'done', manifest: { photos: photos(['before', 'flashing', 'serial', 'after']) } } }]);
  assert.equal(r[0].status, 422);
  r = await sync([{ id: 32, kind: 'payrequest.create', payload: { workOrderId: wo, Amount__c: 1500, description: 'Replaced 9 windows.', manifest: { photos: photos(['before', 'flashing', 'serial', 'after']), checklist: { id: 'windows-v1', done: ['walk'] } } } }]);
  assert.equal(r[0].ok, true);
  const created = deps.sf.log.creates.find(c => c.sobject === 'SA_Expense__c');
  assert.equal(created.fields.Type__c, 'Vista'); assert.equal(created.fields.Status__c, 'New');
  assert.equal(created.fields.Did_you_complete_the_job_or_service__c, 'Yes');
  assert.equal(created.fields.Service_Appointment__c, sa); assert.equal(created.fields.Account__c, PEOPLE.tucker.account.Id);
  assert.equal(created.fields.Production_Manager__c, PEOPLE.mike.userId);
  assert.equal(readManifest(created.fields.Additional_Work_Performed_Description__c).photos.length, 4);
  // installers can't approve
  r = await sync([{ id: 40, kind: 'payrequest.approve', payload: { expenseId: r[0].id } }]);
  assert.equal(r[0].status, 403);
  // The PM's snapshot carries view links for the photos.
  const snap = (await call(h, 'GET', '/snapshot', { token: tokenFor(deps, PEOPLE.mike) })).json;
  for (const k of keys) assert.match(snap.photoUrls[k], /^https:\/\/s3\.test\//);
});

test('PM: approve is refused while short, approves a complete one, issues a draw', async () => {
  const deps = await testDeps(), h = createHandler(async () => deps), tok = tokenFor(deps, PEOPLE.mike);
  const sync = entries => call(h, 'POST', '/sync', { token: tok, body: { entries } }).then(r => r.json.results);
  let r = await sync([{ id: 1, kind: 'payrequest.approve', payload: { expenseId: 'a0X3' } }]); // Pierce: photos short
  assert.equal(r[0].status, 422); assert.match(r[0].error, /short/);
  r = await sync([{ id: 2, kind: 'payrequest.approve', payload: { expenseId: 'a0X5', approval: { checked: ['x'] } } }]); // Whitfield: complete
  assert.equal(r[0].ok, true);
  const up = deps.sf.log.updates.find(u => u.id === 'a0X5');
  assert.equal(up.fields.Status__c, 'Approved'); assert.equal(up.fields.Approver__c, 'Mike Duncan');
  assert.equal(readManifest(up.fields.Additional_Work_Performed_Description__c).approval.decision, 'submitted');
  r = await sync([{ id: 3, kind: 'payrequest.sendBack', payload: { expenseId: 'a0X3', approval: { missed: [{ item: 'photo:before', reason: 'missing', text: 'Antes: 2 (mínimo 4)' }] } } }]);
  assert.equal(r[0].ok, true);
  // draw: blocked without progress photos, then allowed
  const hall = '0WO5e00000B2m1qEAB';
  r = await sync([{ id: 4, kind: 'draw.issue', payload: { workOrderId: hall, Amount__c: 3000, covers: 'front elevations', requested_by: 'Luis' } }]);
  assert.equal(r[0].status, 422);
  await deps.store.put({ pk: `PROGRESS#${hall}`, sk: 'PHOTO#vista/x/p1.jpg', key: `vista/${hall}/08p/p1.jpg` });
  r = await sync([{ id: 5, kind: 'draw.issue', payload: { workOrderId: hall, Amount__c: 999999, covers: 'x' } }]);
  assert.equal(r[0].status, 422, 'over the contract');
  r = await sync([{ id: 6, kind: 'draw.issue', payload: { workOrderId: hall, Amount__c: 3000, covers: 'front elevations', requested_by: 'Luis' } }]);
  assert.equal(r[0].ok, true);
  const draw = deps.sf.log.creates.find(c => c.fields.Did_you_complete_the_job_or_service__c === 'No');
  assert.equal(draw.fields.Status__c, 'Approved'); assert.equal(draw.fields.Approver__c, 'Mike Duncan'); assert.equal(draw.fields.Amount__c, 3000);
});

test('texts: signed webhook runs the engine, writes Salesforce, answers; forged or repeated ones are ignored', async () => {
  const deps = await testDeps(), h = createHandler(async () => deps);
  const text = (from, body, sid, extra = {}) => {
    const form = { From: from, Body: body, MessageSid: sid, NumMedia: '0', ...extra };
    return call(h, 'POST', '/sms/inbound', { form, headers: { 'x-twilio-signature': twilioSignature('twilio-token', 'https://api.test/sms/inbound', form) } });
  };
  const forged = await call(h, 'POST', '/sms/inbound', { form: { From: PEOPLE.luis.phone, Body: 'hoy' }, headers: { 'x-twilio-signature': 'nope' } });
  assert.equal(forged.statusCode, 403);
  let res = await text(PEOPLE.luis.phone, 'hoy', 'SM1');
  assert.equal(res.statusCode, 200); assert.match(res.body, /<Response>/);
  assert.match(deps.twilio.sent.at(-1).body, /Tus trabajos/);
  const before = deps.twilio.sent.length;
  await text(PEOPLE.luis.phone, 'hoy', 'SM1');
  assert.equal(deps.twilio.sent.length, before, 'Twilio retries are ignored');
  await text(PEOPLE.luis.phone, '1', 'SM2');
  assert.match(deps.twilio.sent.at(-1).body, /Quitar el revestimiento/, 'job text translated to Spanish from the cache');
  // the conversation continues across messages (session stored between texts)
  await text(PEOPLE.rafael.phone, 'hoy', 'SM3');
  await text(PEOPLE.rafael.phone, 'empezar 1', 'SM4');
  assert.ok(deps.sf.log.updates.some(u => u.sobject === 'ServiceAppointment' && u.fields.Status === 'In Progress'));
  await text(PEOPLE.rafael.phone, 'listo 1 todas', 'SM5');
  assert.equal(deps.sf.log.updates.filter(u => u.sobject === 'WorkOrderLineItem' && u.fields.Status === 'Measurement Completed').length, 2);
  // PM approves by text with the confirmation
  await text(PEOPLE.mike.phone, 'review', 'SM6');
  const list = deps.twilio.sent.at(-1).body;
  const n = list.split('\n').find(l => l.includes('Whitfield')).match(/^(\d+)\)/)[1];
  await text(PEOPLE.mike.phone, `approve ${n}`, 'SM7');
  assert.match(deps.twilio.sent.at(-1).body, /Are you sure you want to submit this pay request/);
  await text(PEOPLE.mike.phone, 'yes', 'SM8');
  assert.equal(deps.sf.world.SA_Expense__c.find(d => d.Id === 'a0X5').Status__c, 'Approved');
  assert.ok(deps.twilio.sent.some(m => m.to === PEOPLE.tucker.phone && /approved \$1,400/.test(m.body)), 'installer told');
  // unknown number
  await text('+19995550000', 'hi', 'SM9');
  assert.match(deps.twilio.sent.at(-1).body, /isn't set up for Vista/);
});

test('texts: pay request with picture messages copies photos into S3', async () => {
  const deps = await testDeps(), h = createHandler(async () => deps);
  let sid = 0;
  const text = (body, media = []) => {
    const form = { From: PEOPLE.tucker.phone, Body: body, MessageSid: `SM${++sid}`, NumMedia: String(media.length), ...Object.fromEntries(media.map((u, i) => [`MediaUrl${i}`, u])) };
    return call(h, 'POST', '/sms/inbound', { form, headers: { 'x-twilio-signature': twilioSignature('twilio-token', 'https://api.test/sms/inbound', form) } });
  };
  for (const [b, m] of [['today'], ['start 1'], ['done 1 all'], ['pay 1'], ['1500'], ['', ['https://api.twilio.com/m/1']], ['', ['https://api.twilio.com/m/2']], ['', ['https://api.twilio.com/m/3']], ['', ['https://api.twilio.com/m/4']], ['yes'], ['Replaced 9 windows'], ['send']]) await text(b, m || []);
  const created = deps.sf.log.creates.find(c => c.sobject === 'SA_Expense__c');
  assert.ok(created, 'pay request created'); assert.equal(created.fields.Amount__c, 1500);
  const m = readManifest(created.fields.Additional_Work_Performed_Description__c);
  assert.equal(m.photos.length, 4); assert.ok(m.photos.every(p => p.key?.startsWith('vista/0WO5e00000A1k9pEAB/')));
  assert.equal(deps.photos.objects.size, 4);
  assert.deepEqual(deps.twilio.deleted.sort(), [1, 2, 3, 4].map(n => `https://api.twilio.com/m/${n}`), 'picture messages removed from Twilio once saved');
  assert.match(deps.twilio.sent.find(x => x.to === PEOPLE.tucker.phone && /Sent to/.test(x.body)).body, /Sent to Mike Duncan/);
});

test('language, channel and language requests are saved per person', async () => {
  const deps = await testDeps(), h = createHandler(async () => deps), tok = tokenFor(deps, PEOPLE.tucker);
  await call(h, 'PATCH', '/me/prefs', { token: tok, body: { lang: 'bi', channel: 'text' } });
  const me = await call(h, 'GET', '/me', { token: tok });
  assert.equal(me.json.person.lang, 'bi'); assert.equal(me.json.person.channel, 'text');
  const r = await call(h, 'POST', '/sync', { token: tok, body: { entries: [{ id: 1, kind: 'language.request', payload: { language: 'Português' } }] } });
  assert.equal(r.json.results[0].ok, true);
  assert.ok(deps.twilio.sent.some(m => m.to === '+17065550001' && /Português/.test(m.body)), 'Matt is told');
  const adm = await call(h, 'GET', '/admin/language-requests', { headers: { 'x-admin-token': 'test-admin' } });
  assert.equal(adm.json.requests[0].language, 'Português');
  assert.equal((await call(h, 'GET', '/admin/language-requests', { headers: { 'x-admin-token': 'wrong' } })).statusCode, 403);
});

test('10 AM cutoff: subs told what was missed in their language, PM reminded, once per day', async () => {
  const deps = await testDeps(), h = createHandler(async () => deps), w = createWorker(async () => deps);
  await call(h, 'POST', '/sync', { token: tokenFor(deps, PEOPLE.mike), body: { entries: [{ id: 1, kind: 'payrequest.sendBack', payload: { expenseId: 'a0X3', approval: { missed: [{ item: 'photo:before', text: 'Antes, cada fachada: 2 (mínimo 4) — falta' }] } } }] } });
  deps.twilio.sent.length = 0;
  const r = await w({ job: 'cutoff' });
  assert.equal(r.subs, 2);
  const luis = deps.twilio.sent.find(m => m.to === PEOPLE.luis.phone);
  assert.match(luis.body, /no fue enviada para el pago de hoy/); assert.match(luis.body, /mínimo 4/);
  const tucker = deps.twilio.sent.find(m => m.to === PEOPLE.tucker.phone);
  assert.match(tucker.body, /still with your PM/);
  assert.ok(deps.twilio.sent.some(m => m.to === PEOPLE.mike.phone && /missed today's 10:00 AM run/.test(m.body)));
  deps.twilio.sent.length = 0;
  await w({ job: 'cutoff' });
  assert.equal(deps.twilio.sent.length, 0, 'not sent twice the same day');
});

test('heartbeat: writes a test record and a photo; texts Matt and Mike once on failure and on recovery', async () => {
  const deps = await testDeps(), w = createWorker(async () => deps);
  let r = await w({ job: 'heartbeat' });
  assert.equal(r.ok, true);
  const hb = deps.sf.log.creates.at(-1);
  assert.equal(hb.fields.TEST_SA__c, true); assert.equal(hb.fields.Status__c, 'New'); assert.equal(hb.fields.Type__c, 'Vista');
  assert.ok([...deps.photos.objects.keys()].some(k => k.startsWith('vista/heartbeat/')));
  await w({ job: 'heartbeat' });
  assert.ok(deps.sf.log.deletes.some(d => d.id === hb.id), 'previous test record cleaned up');
  deps.sf.failAuth(true);
  r = await w({ job: 'heartbeat' });
  assert.equal(r.ok, false); assert.equal(r.step, 'login');
  assert.equal(deps.twilio.sent.filter(m => /heartbeat failed/.test(m.body)).length, 2, 'Matt and Mike');
  await w({ job: 'heartbeat' });
  assert.equal(deps.twilio.sent.filter(m => /heartbeat failed/.test(m.body)).length, 2, 'not repeated while still failing');
  deps.sf.failAuth(false);
  await w({ job: 'heartbeat' });
  assert.equal(deps.twilio.sent.filter(m => /recovered/.test(m.body)).length, 2);
});

test('morning and dispatch texts respect the person\'s channel', async () => {
  const deps = await testDeps(), w = createWorker(async () => deps);
  await deps.people.update(await deps.people.byPhone(PEOPLE.tucker.phone), { channel: 'app' });
  await w({ job: 'morning' });
  assert.ok(deps.twilio.sent.some(m => m.to === PEOPLE.luis.phone && /Buenos días, Luis/.test(m.body)));
  assert.ok(!deps.twilio.sent.some(m => m.to === PEOPLE.tucker.phone), 'app-only people get no texts');
  deps.twilio.sent.length = 0;
  const r = await w({ job: 'dispatch-poll' });
  assert.ok(r.sent >= 1);
  assert.ok(deps.twilio.sent.every(m => m.to !== PEOPLE.tucker.phone));
  assert.ok(deps.twilio.sent.some(m => m.to === PEOPLE.luis.phone && /nuevo trabajo despachado/.test(m.body)));
  const again = await w({ job: 'dispatch-poll' });
  assert.equal(again.sent, 0, 'each dispatch is announced once');
  // Location switched off: a freshly dispatched visit is not announced.
  const off = await testDeps(), w2 = createWorker(async () => off);
  await off.store.put({ pk: 'CONFIG', sk: 'ROLLOUT', rollout: { defaultMode: 'off', locations: { Augusta: { mode: 'off' } } } });
  assert.equal((await w2({ job: 'dispatch-poll' })).sent, 0, 'no dispatch texts where Vista is off');
});

test('admin can enroll a person who has no Salesforce user', async () => {
  const deps = await testDeps(), h = createHandler(async () => deps);
  const r = await call(h, 'POST', '/admin/people', { headers: { 'x-admin-token': 'test-admin' }, body: { phone: '706-555-0150', name: 'Jorge Ruiz', role: 'installer', serviceResourceIds: ['0HnRUIZ'], lang: 'es' } });
  assert.equal(r.statusCode, 200);
  assert.equal((await deps.people.byResource('0HnRUIZ')).name, 'Jorge Ruiz');
});

test('rollout switch: set by admin without a redeploy, and applied to texts', async () => {
  const deps = await testDeps(), h = createHandler(async () => deps);
  const put = body => call(h, 'PUT', '/admin/rollout', { headers: { 'x-admin-token': 'test-admin' }, body });
  assert.equal((await put({ locations: { Augusta: { mode: 'maybe' } } })).statusCode, 422);
  await put({ locations: { Augusta: { mode: 'pilot', pilotAccounts: ['Tucker Installs LLC'] } } });
  const form = { From: PEOPLE.luis.phone, Body: 'hoy', MessageSid: 'SMR1', NumMedia: '0' };
  await call(h, 'POST', '/sms/inbound', { form, headers: { 'x-twilio-signature': twilioSignature('twilio-token', 'https://api.test/sms/inbound', form) } });
  assert.match(deps.twilio.sent.at(-1).body, /todavía no está activo/, 'Luis is not in the pilot');
  const form2 = { From: PEOPLE.tucker.phone, Body: 'today', MessageSid: 'SMR2', NumMedia: '0' };
  await call(h, 'POST', '/sms/inbound', { form: form2, headers: { 'x-twilio-signature': twilioSignature('twilio-token', 'https://api.test/sms/inbound', form2) } });
  assert.match(deps.twilio.sent.at(-1).body, /Your jobs/, 'Tucker is');
  const snap = await call(h, 'GET', '/snapshot', { token: tokenFor(deps, PEOPLE.tucker) });
  assert.equal(snap.json.rollout.locations.Augusta.mode, 'pilot', 'the app gets the same switch');
});
