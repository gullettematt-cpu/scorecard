import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createHandler } from '../src/http.mjs';
import { createWorker } from '../src/worker.mjs';
import { signToken, verifyToken, normalizePhone, createAuth } from '../src/lib/auth.mjs';
import { jwtAssertion, jwtAudience, createSalesforce, lit, inList } from '../src/lib/salesforce.mjs';
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
test('a resubmit in the same millisecond as the send-back still counts as resubmitted', async () => {
  const { domain } = await import('../src/lib/shared.mjs');
  const at = '2026-10-01T16:49:00.000Z';
  assert.equal(domain.isSentBack({ approval: { decision: 'sent_back', at } }), true);
  assert.equal(domain.isSentBack({ approval: { decision: 'sent_back', at }, resubmitted_at: at }), false);
  assert.equal(domain.isSentBack({ approval: { decision: 'sent_back', at: '2026-10-01T17:00:00.000Z' }, resubmitted_at: at }), true, 'sent back again later');
});

test('Salesforce JWT audience: generic login host, also when logging in through My Domain', () => {
  assert.equal(jwtAudience('https://login.salesforce.com'), 'https://login.salesforce.com');
  assert.equal(jwtAudience('https://southernsiding.my.salesforce.com'), 'https://login.salesforce.com');
  assert.equal(jwtAudience('https://test.salesforce.com'), 'https://test.salesforce.com');
  assert.equal(jwtAudience('https://southernsiding--devsandi.sandbox.my.salesforce.com'), 'https://test.salesforce.com');
  assert.equal(jwtAudience('https://southernsiding--devsandi.my.salesforce.com'), 'https://test.salesforce.com');
});

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
test('Vi conversation: history, cached job context, structured reply, fallbacks', async () => {
  const reqs = [], opts = [];
  let reply = { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ answer: 'Stop and call Mike before you close it up.', suggest_problem_report: true, problem_summary: 'Rot in the sill at the picture window' }) }] };
  const vi = createVi({ client: { messages: { create: async (r, o) => { reqs.push(r); opts.push(o); return reply; } } } });
  const job = { WorkOrderNumber: '00041872', Subject: 's', Street: 'a', City: 'b', State: 'GA', PostalCode: '1', WorkOrderLineItems: [] };
  const out = await vi.chat({ lang: 'en', job, extras: { problems: [], pay: [{ kind: 'completion pay', amount: 1500, status: 'WithPM' }] },
    history: [{ q: 'How long does the foam cure?', a: 'About 30 minutes.' }], question: 'The sill is soft. What do I do?' });
  assert.deepEqual(out, { answer: 'Stop and call Mike before you close it up.', problem: { summary: 'Rot in the sill at the picture window' } });
  const r = reqs[0];
  assert.equal(r.model, 'claude-sonnet-5'); assert.equal(r.output_config.effort, 'medium'); assert.equal(r.output_config.format.type, 'json_schema');
  assert.equal(r.system.at(-1).cache_control.type, 'ephemeral');
  assert.deepEqual(r.messages.map(m => m.role), ['user', 'assistant', 'user'], 'earlier turn kept');
  assert.equal(r.messages[0].content[0].cache_control.type, 'ephemeral', 'job context opens the conversation and is cached');
  assert.match(r.messages[0].content[0].text, /pay_requests_and_draws/);
  assert.match(r.messages[2].content, /Reply in English[\s\S]*sill is soft/);
  assert.equal(opts[0].timeout, 25000, 'gives up before API Gateway does');
  reply = { stop_reason: 'refusal', content: [] };
  assert.match((await vi.chat({ lang: 'es', question: 'x' })).answer, /Llame a su PM/);
  reply = { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"answer": "cut off' }] };
  assert.deepEqual(await vi.chat({ lang: 'en', question: 'x' }), { answer: "I don't have an answer for that. Please call your PM.", problem: null });
});

test('Ask Vi route: own jobs only, job context with problems and pay, history passed, daily cap', async () => {
  const deps = await testDeps(), h = createHandler(async () => deps), tok = tokenFor(deps, PEOPLE.tucker);
  const ask = body => call(h, 'POST', '/vi/ask', { token: tok, body });
  let r = await ask({ workOrderId: '0WO5e00000A1k9pEAB', question: 'The sill has rot, what now?', history: [{ q: 'hi', a: 'hello' }] });
  assert.equal(r.statusCode, 200); assert.equal(r.json.answer, '(Vi answer)'); assert.deepEqual(r.json.problem, { summary: 'Rot in the sill' });
  const c = deps.vi.calls.chat[0];
  assert.equal(c.job.WorkOrderNumber, '00041872'); assert.deepEqual(c.history, [{ q: 'hi', a: 'hello' }]);
  assert.ok(Array.isArray(c.extras.problems) && Array.isArray(c.extras.pay)); assert.ok(c.checklist?.steps?.length, 'trade checklist included');
  assert.equal((await ask({ workOrderId: '0WO5e00000B2m1qEAB', question: 'x' })).statusCode, 403, "not Tucker's job");
  assert.equal((await ask({ question: '  ' })).statusCode, 422);
  assert.equal((await ask({ question: 'general question' })).statusCode, 200, 'no job = general question');
  for (let i = 0; i < 60; i++) await ask({ question: 'again' });
  r = await ask({ question: 'one too many' }); assert.equal(r.statusCode, 429); assert.equal(r.json.limit, 60);
});

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

test('problem report: validated picklists, Service Case with the contract fields, photos checked, PM texted', async () => {
  const deps = await testDeps(), h = createHandler(async () => deps), tok = tokenFor(deps, PEOPLE.tucker);
  const sync = entries => call(h, 'POST', '/sync', { token: tok, body: { entries } }).then(r => r.json.results);
  const wo = '0WO5e00000A1k9pEAB', sa = '08p5e0000001aA1', key = `vista/${wo}/${sa}/20260928T140000-problem-1.jpg`;
  const base = { workOrderId: wo, subject: 'Rot in the sill at the picture window', description: 'Soft wood 18 inches along the sill.', Work_Type__c: 'Window', Service_Type__c: 'Warranty', Warranty_Type__c: 'Company Warranty', lang: 'en', lat: 33.4712, lng: -82.0019 };
  let r = await sync([{ id: 1, kind: 'case.create', payload: { ...base, Warranty_Type__c: 'Whatever' } }]);
  assert.equal(r[0].status, 422, 'picklist values must be the real ones');
  r = await sync([{ id: 2, kind: 'case.create', payload: { ...base, workOrderId: '0WO5e00000B2m1qEAB' } }]);
  assert.equal(r[0].status, 403, 'only jobs he can see');
  r = await sync([{ id: 3, kind: 'case.create', payload: { ...base, photos: [{ kind: 'problem', key }] } }]);
  assert.equal(r[0].status, 503, 'photo not uploaded yet: try again');
  deps.photos.objects.set(key, 'jpeg');
  deps.twilio.sent.length = 0;
  r = await sync([{ id: 4, kind: 'case.create', payload: { ...base, blocking: true, photos: [{ kind: 'problem', key }] } }]);
  assert.equal(r[0].ok, true);
  const c = deps.sf.log.creates.find(x => x.sobject === 'Case').fields;
  assert.equal(c.RecordTypeId, '0124P000000OMP8QAO'); assert.equal(c.Status, 'New'); assert.equal(c.Origin, 'In-Person');
  assert.equal(c.Priority, 'High', "can't continue = High");
  assert.equal(c.Subject, '[Vista] Rot in the sill at the picture window');
  assert.equal(c.Job__c, 'a0J1'); assert.equal(c.Service_Appointment__c, sa); assert.equal(c.AccountId, '001A'); assert.equal(c.ContactId, '003A');
  assert.equal(c.Original_Installer__c, PEOPLE.tucker.account.Id); assert.equal(c.Language, 'en_US'); assert.equal(c.Test_record__c, false);
  assert.match(c.Description, /WO 00041872 · Dwayne Tucker · 33\.47120,-82\.00190/); assert.match(c.Description, new RegExp('Vista photos: ' + key));
  assert.equal(c.Service_Issue__c, 'Rot in the sill at the picture window\n\nSoft wood 18 inches along the sill.');
  assert.ok(deps.twilio.sent.some(m => m.to === PEOPLE.mike.phone && /reported a problem on Patricia Simmons \(WO 00041872\).*Work is stopped/.test(m.body)), 'PM texted');
  // Back in the snapshot with its photo, and a link to view it.
  const snap = (await call(h, 'GET', '/snapshot', { token: tok })).json;
  const back = snap.cases.find(x => x.Subject === c.Subject);
  assert.deepEqual(back._photos, [key]); assert.equal(back.Description, undefined, 'no raw description to the phone');
  assert.match(snap.photoUrls[key], /^https:\/\/s3\.test\//);
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
  // unknown number: first it must opt in; after START it's told to ask the PM
  await text('+19995550000', 'hi', 'SM9');
  assert.match(deps.twilio.sent.at(-1).body, /reply START/);
  await text('+19995550000', 'START', 'SM10');
  await text('+19995550000', 'hi', 'SM11');
  assert.match(deps.twilio.sent.at(-1).body, /isn't set up for Vista/);
});

test('opt-in: only phones that texted START get texts; STOP ends it; branded; first-text notice; daily cap', async () => {
  const deps = await testDeps({ optedIn: false }), h = createHandler(async () => deps), w = createWorker(async () => deps);
  let sid = 0;
  const text = (from, body, extra = {}) => {
    const form = { From: from, Body: body, MessageSid: `SM${++sid}`, NumMedia: '0', ...extra };
    return call(h, 'POST', '/sms/inbound', { form, headers: { 'x-twilio-signature': twilioSignature('twilio-token', 'https://api.test/sms/inbound', form) } });
  };
  const to = phone => deps.twilio.sent.filter(m => m.to === phone);
  // Nobody opted in: scheduled texts go to no one, even people enrolled with channel "both".
  await w({ job: 'morning' }); await w({ job: 'dispatch-poll' });
  assert.equal(deps.twilio.sent.length, 0, 'no texts without START');
  // A crew member who texts a command before opting in gets one "reply START" answer a day, and nothing happens.
  await text(PEOPLE.luis.phone, 'hoy'); await text(PEOPLE.luis.phone, 'hoy');
  assert.equal(to(PEOPLE.luis.phone).length, 1); assert.match(to(PEOPLE.luis.phone)[0].body, /^Vista \(Southern Industries\): .*reply START/);
  // YES is not an opt-in keyword (Vista uses it to confirm approvals).
  await text(PEOPLE.luis.phone, 'yes');
  assert.equal((await deps.store.get(`OPTIN#${PEOPLE.luis.phone}`, 'STATE'))?.status, undefined);
  // START (Twilio passes OptOutType) opts in; Vista doesn't reply, Twilio does.
  const n = deps.twilio.sent.length;
  await text(PEOPLE.luis.phone, 'START', { OptOutType: 'START' });
  assert.equal(deps.twilio.sent.length, n, 'Twilio sends the opt-in confirmation, not Vista');
  // First Vista text: branded, in Spanish, with the opt-out line; the next one without it.
  await text(PEOPLE.luis.phone, 'hoy');
  const first = to(PEOPLE.luis.phone).at(-1).body;
  assert.match(first, /^Vista \(Southern Industries\): /); assert.match(first, /Responda HELP para ayuda, STOP para cancelar\.$/);
  await text(PEOPLE.luis.phone, '1');
  assert.doesNotMatch(to(PEOPLE.luis.phone).at(-1).body, /STOP para cancelar/);
  // "START 1" is a Vista command, not a keyword.
  assert.equal((await import('../src/lib/optin.mjs')).keywordOf('start 1'), null);
  // HELP is answered by Twilio: Vista stays quiet.
  const m = deps.twilio.sent.length; await text(PEOPLE.luis.phone, 'HELP'); assert.equal(deps.twilio.sent.length, m);
  // Morning texts now reach Luis (opted in) but not Tucker (not opted in).
  deps.twilio.sent.length = 0; await w({ job: 'morning' });
  assert.ok(to(PEOPLE.luis.phone).length === 1 && to(PEOPLE.tucker.phone).length === 0);
  // STOP ends it until START again.
  await text(PEOPLE.luis.phone, 'stop');
  deps.twilio.sent.length = 0; await w({ job: 'morning' }); await text(PEOPLE.luis.phone, 'hoy');
  assert.equal(to(PEOPLE.luis.phone).length, 0, 'nothing after STOP, not even the opt-in prompt');
  // Payroll's reminder to a PM who hasn't opted in: not sent, number to call instead.
  const lisa = { id: 'admin:lisa', phone: '+17065550150', name: 'Lisa', role: 'admin', serviceResourceIds: [] }; await deps.people.save(lisa);
  const nudge = (await call(h, 'POST', '/admin/nudge', { token: tokenFor(deps, lisa), body: { pmUserId: PEOPLE.mike.userId } })).json;
  assert.equal(nudge.reason, 'not-opted-in'); assert.equal(nudge.phone, PEOPLE.mike.phone);
  const people = (await call(h, 'GET', '/admin/people', { token: tokenFor(deps, lisa) })).json.people;
  assert.equal(people.find(p => p.phone === PEOPLE.luis.phone).textOptIn, 'out'); assert.equal(people.find(p => p.phone === PEOPLE.tucker.phone).textOptIn, 'none');
  // Daily cap: at most 10 automatic texts per phone per day (replies to their own texts don't count).
  const { gatedTwilio, createOptIns } = await import('../src/lib/optin.mjs');
  const optIns = createOptIns({ store: deps.store }); await optIns.set('+17065550199', 'in');
  const g = gatedTwilio({ twilio: deps.twilio, optIns, people: deps.people, store: deps.store, log: {} });
  let sent = 0; for (let i = 0; i < 12; i++) if (await g.send('+17065550199', `notice ${i}`)) sent++;
  assert.equal(sent, 10); assert.ok(await g.send('+17065550199', 'answer', { reply: true }), 'replies still go out');
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

test('program admin (payroll): signs in by text, sees the pay board, nudges a PM, limited powers', async () => {
  const deps = await testDeps(), h = createHandler(async () => deps);
  const lisa = { id: 'admin:lisa', phone: '+17065550150', name: 'Lisa Payroll', role: 'admin', lang: 'en', channel: 'both', serviceResourceIds: [] };
  await deps.people.save(lisa);
  const tok = tokenFor(deps, lisa), as = (m, path, body) => call(h, m, path, { token: tok, body });
  // Crews and PMs can't use admin routes; Lisa can, without the admin token.
  assert.equal((await call(h, 'GET', '/admin/board', { token: tokenFor(deps, PEOPLE.mike) })).statusCode, 403);
  const board = (await as('GET', '/admin/board')).json;
  assert.ok(board.items.length > 0);
  const waiting = board.items.filter(r => r.stage === 'withPm');
  assert.ok(waiting.length >= 1 && waiting.every(r => r.pmUserId === PEOPLE.mike.userId && r.pmName === 'Mike Duncan' && r.wo && r.homeowner));
  assert.ok(board.items.some(r => r.kind === 'draw'), 'draws are on the board');
  assert.equal(board.byPm[0].pmUserId, PEOPLE.mike.userId); assert.equal(board.byPm[0].count, waiting.length);
  // Nudge Mike: one text, then not again within the hour.
  deps.twilio.sent.length = 0;
  let r = (await as('POST', '/admin/nudge', { pmUserId: PEOPLE.mike.userId })).json;
  assert.equal(r.sent, true); assert.equal(r.n, waiting.length);
  assert.match(deps.twilio.sent[0].body, /Lisa Payroll in payroll: \d+ pay request\(s\) are waiting/); assert.equal(deps.twilio.sent[0].to, PEOPLE.mike.phone);
  r = (await as('POST', '/admin/nudge', { pmUserId: PEOPLE.mike.userId })).json;
  assert.equal(r.sent, false); assert.equal(r.reason, 'recently'); assert.equal(deps.twilio.sent.length, 1);
  // A PM on app-only isn't texted; Lisa gets the number to call instead.
  await deps.people.update(await deps.people.byUser(PEOPLE.mike.userId), { channel: 'app' });
  await deps.store.del(`NUDGE#${PEOPLE.mike.userId}`, 'LAST');
  r = (await as('POST', '/admin/nudge', { pmUserId: PEOPLE.mike.userId })).json;
  assert.equal(r.reason, 'app-only'); assert.equal(r.phone, PEOPLE.mike.phone);
  // Health and heartbeat; mass-text jobs stay on the schedule.
  assert.equal((await as('POST', '/admin/run', { job: 'heartbeat' })).json.ok, true);
  assert.ok((await as('GET', '/admin/health')).json.lastOk);
  assert.equal((await as('POST', '/admin/run', { job: 'morning' })).statusCode, 422);
  const chk = await as('POST', '/admin/run', { job: 'checkSalesforce' }); // read-only, so payroll can run it
  assert.equal(chk.statusCode, 200); assert.ok(Array.isArray(chk.json.results));
  // People: enroll and turn off crews and PMs, but not admins or herself.
  r = await as('POST', '/admin/people', { phone: '706-555-0177', name: 'New Installer', role: 'installer', lang: 'es' });
  assert.equal(r.statusCode, 200); assert.equal(r.json.person.source, 'admin:Lisa Payroll');
  assert.equal((await as('POST', '/admin/people', { phone: '706-555-0178', name: 'X', role: 'admin' })).statusCode, 422);
  assert.equal((await as('POST', '/admin/people', { phone: lisa.phone, name: 'Lisa', role: 'pm' })).statusCode, 403);
  // Rollout
  const roll = (await as('GET', '/admin/rollout')).json.rollout;
  assert.equal((await as('PUT', '/admin/rollout', { ...roll, locations: { Augusta: { mode: 'pilot', pilotAccounts: ['Tucker Installs LLC'], optOutAccounts: [] } } })).json.rollout.locations.Augusta.mode, 'pilot');
  // An admin has no jobs of their own.
  assert.deepEqual((await as('GET', '/snapshot')).json.jobs, []);
});

test('app actions text whoever is next: PM on submit, crew on approve or send-back (in their language); none twice for texts', async () => {
  const deps = await testDeps(), h = createHandler(async () => deps);
  const syncAs = (who, entries) => call(h, 'POST', '/sync', { token: tokenFor(deps, who), body: { entries } }).then(r => r.json.results);
  const sent = to => deps.twilio.sent.filter(m => m.to === to);
  // PM approves Tucker's request in the app -> Tucker gets "approved"
  let r = await syncAs(PEOPLE.mike, [{ id: 1, kind: 'payrequest.approve', payload: { expenseId: 'a0X5', channel: 'app' } }]);
  assert.equal(r[0].ok, true);
  assert.match(sent(PEOPLE.tucker.phone).at(-1)?.body || '', /approved \$1,400 for job 00041866/);
  // PM sends Luis's back -> Luis gets it in Spanish with what's missing
  r = await syncAs(PEOPLE.mike, [{ id: 2, kind: 'payrequest.sendBack', payload: { expenseId: 'a0X3', channel: 'app', approval: { missed: [{ item: 'photo:before', text: 'Antes: 2 (mínimo 4)' }] } } }]);
  assert.equal(r[0].ok, true);
  const luis = sent(PEOPLE.luis.phone).at(-1)?.body || '';
  assert.match(luis, /00041880/); assert.match(luis, /Antes: 2 \(mínimo 4\)/); assert.doesNotMatch(luis, /your PM sent back/, 'Spanish, not English');
  // Tucker submits in the app -> Mike gets "new pay request"
  const wo = '0WO5e00000A1k9pEAB', sa = '08p5e0000001aA1';
  await syncAs(PEOPLE.tucker, [{ id: 3, kind: 'serviceappointment.start', payload: { serviceAppointmentId: sa } }]);
  const photos = ['before', 'flashing', 'serial', 'after'].map(kind => ({ kind, key: `vista/${wo}/${sa}/20260928T120000-${kind}-1.jpg` }));
  for (const ph of photos) deps.photos.objects.set(ph.key, 'jpeg');
  const before = sent(PEOPLE.mike.phone).length;
  r = await syncAs(PEOPLE.tucker, [{ id: 4, kind: 'payrequest.create', payload: { workOrderId: wo, Amount__c: 1500, description: 'Replaced 9 windows.', channel: 'app', manifest: { photos } } }]);
  assert.equal(r[0].ok, true);
  assert.equal(sent(PEOPLE.mike.phone).length, before + 1); assert.match(sent(PEOPLE.mike.phone).at(-1).body, /new pay request, Patricia Simmons \$1,500/);
  // The same kind of action coming from the text engine (channel sms) doesn't text again from here.
  const n = deps.twilio.sent.length;
  await syncAs(PEOPLE.mike, [{ id: 5, kind: 'payrequest.approve', payload: { expenseId: r[0].id, channel: 'sms' } }]);
  assert.equal(deps.twilio.sent.length, n);
  // Someone on app-only gets no texts.
  await deps.people.update(await deps.people.byPhone(PEOPLE.luis.phone), { channel: 'app' });
  const m = sent(PEOPLE.luis.phone).length;
  await syncAs(PEOPLE.mike, [{ id: 6, kind: 'payrequest.sendBack', payload: { expenseId: 'a0X3', channel: 'app', approval: { missed: [{ item: 'x', text: 'x' }] } } }]);
  assert.equal(sent(PEOPLE.luis.phone).length, m);
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

// ---- Check Salesforce ---------------------------------------------------------------------------
import { checkSalesforce, formatReport, WRITES, FLOWS, LIST_VIEWS } from '../src/lib/sfcheck.mjs';
import { SOQL } from '../src/lib/soql.mjs';

// A Salesforce that answers every query with nothing and describes objects from WRITES; `broken` bends it.
function checkOrg(broken = {}) {
  const queries = [], writes = [];
  const describe = obj => {
    const spec = WRITES[obj];
    const names = [...new Set([...(spec.create || []), ...(spec.update || []), ...Object.keys(spec.values || {})])].filter(f => f !== broken.missingField);
    return { createable: true, updateable: true, deletable: true,
      recordTypeInfos: [{ recordTypeId: '0124P000000OMP8QAO', name: 'Service', available: true }],
      fields: names.map(name => ({ name, createable: true, updateable: true, type: spec.values?.[name] ? 'picklist' : 'string', restrictedPicklist: true,
        picklistValues: (spec.values?.[name] || []).filter(v => !(obj === 'SA_Expense__c' && name === 'Type__c' && broken.noVistaType && v === 'Vista')).map(value => ({ value, active: true })) })) };
  };
  return { queries, writes,
    async auth() { if (broken.login) throw new Error('Salesforce login failed (400): invalid_grant'); },
    async query(q) {
      queries.push(q);
      if (broken.query && q.includes(broken.query)) throw new Error("Salesforce GET /query failed (400): INVALID_FIELD: No such column 'Is_Open__c'");
      if (q.includes('FlowDefinitionView')) return FLOWS.map(ApiName => ({ ApiName, IsActive: !broken.flowsDraft }));
      if (q.includes('FROM ListView')) return LIST_VIEWS.map(DeveloperName => ({ DeveloperName }));
      return [];
    },
    async search() { return []; },
    async describe(obj) { return describe(obj); },
    create: async () => writes.push('create'), update: async () => writes.push('update'), del: async () => writes.push('del') };
}

test('check Salesforce: runs every Vista query read-only and checks every written field', async () => {
  const org = checkOrg();
  const r = await checkSalesforce({ sf: org });
  assert.equal(r.ok, true, formatReport(r));
  assert.equal(r.failed, 0); assert.equal(r.warnings, 0);
  assert.equal(org.writes.length, 0, 'never writes');
  const reads = org.queries.filter(q => !/FlowDefinitionView|FROM ListView/.test(q));
  assert.equal(reads.length, Object.keys(SOQL).length, 'every query in soql.mjs');
  assert.ok(reads.every(q => /LIMIT 1$/.test(q)), 'each capped at one row');
  assert.ok(!reads.some(q => /LIMIT \d+ LIMIT/.test(q)));
  assert.match(formatReport(r), /Ready: /);
});

test('check Salesforce: names what is broken', async () => {
  let r = await checkSalesforce({ sf: checkOrg({ query: 'FROM Job__c', noVistaType: true, missingField: 'Service_Issue__c', flowsDraft: true }) });
  assert.equal(r.ok, false);
  const row = name => r.results.find(x => x.name === name || x.name.endsWith(`(${name})`));
  assert.equal(row('pmOpenJob').status, 'fail'); assert.match(row('pmOpenJob').detail, /Is_Open__c/);
  assert.equal(row('SA_Expense__c').status, 'fail'); assert.match(row('SA_Expense__c').detail, /Type__c has no picklist value "Vista"/);
  assert.equal(row('Case').status, 'fail'); assert.match(row('Case').detail, /Service_Issue__c missing/);
  assert.equal(row('Flow Vista_Pay_Request_Submitted').status, 'warn');
  assert.match(formatReport(r), /NOT ready: 3 failed/);
  r = await checkSalesforce({ sf: checkOrg({ login: true }) });
  assert.equal(r.ok, false); assert.equal(r.results.length, 1); assert.match(r.results[0].detail, /invalid_grant/);
});

test('check Salesforce: admin token only, over the API', async () => {
  const deps = await testDeps(); deps.sf.describe = async () => ({ fields: [], createable: true, updateable: true, deletable: true });
  const h = createHandler(async () => deps);
  const r = await call(h, 'POST', '/admin/run', { body: { job: 'checkSalesforce' }, headers: { 'x-admin-token': 'test-admin' } });
  assert.equal(r.statusCode, 200); assert.equal(typeof r.json.ok, 'boolean'); assert.ok(r.json.results.length > 10);
  assert.equal(deps.sf.log.creates.length + deps.sf.log.updates.length + deps.sf.log.deletes.length, 0);
});

test('Salesforce source: list view and flow names fit Salesforce limits', async () => {
  const fs = await import('node:fs'), path = await import('node:path');
  const root = new URL('../../salesforce/force-app/main/default/', import.meta.url).pathname;
  const files = fs.readdirSync(root, { recursive: true }).filter(f => /\.(listView|flow)-meta\.xml$/.test(f));
  assert.ok(files.length >= 5);
  for (const f of files) {
    const x = fs.readFileSync(path.join(root, f), 'utf8');
    const name = path.basename(f).split('.')[0];
    if (/listView/.test(f)) {
      const l = x.match(/<label>([^<]*)<\/label>\s*<\/ListView>/)[1];
      assert.ok(l.length <= 40, `${f}: label "${l}" is ${l.length} chars (max 40)`);
      assert.ok(name.length <= 40, `${f}: API name too long`);
    } else assert.ok(name.length <= 80, `${f}: flow API name too long`);
  }
});

// ---- Integration user permission set --------------------------------------------------------------
import { planAccess, permissionSetXml, soqlRefs } from '../src/lib/sfaccess.mjs';
import { fakeDescribes } from './fakes.mjs';

test('permission set: read what Vista reads, edit what it writes, nothing more', async () => {
  const D = fakeDescribes(), describe = async o => { if (!D[o]) throw new Error('no ' + o); return D[o]; };
  assert.deepEqual(soqlRefs("SELECT Id, (SELECT Id FROM Kids) FROM P WHERE X__c = 'a b' AND T > 2026-10-01T10:00:00Z").map(r => r.from), ['P', 'Kids']);
  const sharing = { WorkOrder: 'Private', ServiceAppointment: 'ReadWrite', WorkOrderLineItem: 'ControlledByParent', AssignedResource: 'ControlledByParent', SA_Expense__c: 'Private', Case: 'Private', Account: 'Read' };
  const plan = await planAccess({ describe, sharing });
  const fp = k => plan.fieldPerms.get(k), op = k => plan.objectPerms.get(k);
  // Reads, including through relationships and subqueries
  assert.deepEqual(fp('Job__c.Office__c'), { readable: true, editable: false }, 'Work_Order__r.Job_Number__r.Office__r.Name');
  assert.ok(fp('AssignedResource.Lead_Installer__c'), 'ServiceResources subquery');
  assert.ok(fp('WorkOrderLineItem.Quantity'), 'WorkOrderLineItems subquery');
  assert.ok(fp('Contact.MobilePhone'));
  assert.ok(fp('WorkOrder.Address'), 'address parts use the compound field');
  assert.equal(fp('WorkOrder.State'), undefined); assert.equal(fp('WorkOrder.Street'), undefined);
  // Writes
  assert.equal(fp('SA_Expense__c.Approver__c').editable, true);
  assert.equal(fp('Case.Service_Issue__c').editable, true);
  assert.equal(fp('ServiceAppointment.ActualEndTime').editable, true);
  assert.equal(fp('SA_Expense__c.Payable_Invoice_New__c').editable, false, 'formula stays read-only');
  assert.equal(fp('WorkOrder.Subject').editable, false, 'read-only where Vista only reads');
  // Never system/required fields, never objects Vista doesn't touch
  assert.equal(fp('SA_Expense__c.Name'), undefined); assert.equal(fp('Case.Status'), undefined);
  assert.equal(op('User'), undefined); assert.equal(op('RecordType'), undefined);
  // Object access and sharing
  assert.deepEqual(op('SA_Expense__c'), { allowRead: true, allowCreate: true, allowEdit: true, allowDelete: true, viewAllRecords: true, modifyAllRecords: false });
  assert.equal(op('Case').allowCreate, true); assert.equal(op('Case').allowEdit, false);
  assert.equal(op('Account').viewAllRecords, false, 'public read needs no View All');
  assert.equal(op('AssignedResource').viewAllRecords, false, 'follows its parent');
  assert.equal(op('ServiceAppointment').modifyAllRecords, false, 'public read/write: no Modify All');
  assert.equal(op('WorkOrder').modifyAllRecords, true, 'private work orders: line item edits need Modify All');
  assert.ok(plan.notes.some(n => /WorkOrder: Modify All/.test(n)));
  // Job__c is a detail of Opportunity: Read Opportunity (View All when private), and no Opportunity fields.
  assert.deepEqual(op('Opportunity'), { allowRead: true, allowCreate: false, allowEdit: false, allowDelete: false, modifyAllRecords: false, viewAllRecords: true });
  assert.ok(![...plan.fieldPerms.keys()].some(k => k.startsWith('Opportunity.')));
  assert.equal((await planAccess({ describe, sharing: { ...sharing, Opportunity: 'ReadWrite' } })).objectPerms.get('Opportunity').viewAllRecords, false);
  // A lookup Vista reads points to a custom object: Read on that object, so the field isn't hidden.
  assert.deepEqual(op('Paycheck_Period__c'), { allowRead: true, allowCreate: false, allowEdit: false, allowDelete: false, viewAllRecords: false, modifyAllRecords: false });
  assert.ok(fp('SA_Expense__c.Paycheck_Period__c'));
  assert.deepEqual(plan.unresolved, []);
  const xml = permissionSetXml(plan);
  assert.match(xml, /<field>SA_Expense__c\.Approver__c<\/field>/);
  assert.deepEqual(plan.recordTypes, ['Case.Service']);
  assert.match(xml, /<recordTypeVisibilities>\s*<recordType>Case\.Service<\/recordType>\s*<visible>true<\/visible>/);
  assert.ok(xml.indexOf('<objectPermissions>') < xml.indexOf('<recordTypeVisibilities>'), 'metadata order');
  assert.ok(xml.indexOf('<fieldPermissions>') < xml.indexOf('<label>') && xml.indexOf('<label>') < xml.indexOf('<objectPermissions>'), 'metadata element order');
});

test('program owners (ADMIN_PHONES) are admins without enrolling and can grant admin access', async () => {
  const deps = await testDeps(), h = createHandler(async () => deps);
  const owner = '+17065550001';
  await deps.store.del(`PERSON#${owner}`, 'PROFILE'); // not enrolled anywhere: ADMIN_PHONES alone is enough
  // Sign-in code goes out, and verifying it signs in as an admin.
  await call(h, 'POST', '/auth/start', { body: { phone: '706-555-0001' } });
  const sent = deps.twilio.sent.find(m => m.to === owner && /code is (\d{6})/.test(m.body));
  assert.ok(sent, 'code texted to the owner');
  const v = await call(h, 'POST', '/auth/verify', { body: { phone: '706-555-0001', code: sent.body.match(/(\d{6})/)[1] } });
  assert.equal(v.statusCode, 200); assert.equal(v.json.person.role, 'admin');
  const as = (m, path, body) => call(h, m, path, { token: v.json.token, body });
  assert.equal((await as('GET', '/admin/board')).statusCode, 200);
  // Owners can make Lisa an admin (an admin person can't), but can't edit owners through the app.
  const r = await as('POST', '/admin/people', { phone: '706-555-0160', name: 'Lisa New', role: 'admin', lang: 'en' });
  assert.equal(r.statusCode, 200); assert.equal(r.json.person.role, 'admin');
  assert.equal((await as('POST', '/admin/people', { phone: owner, name: 'X', role: 'pm' })).statusCode, 422);
  assert.equal((await as('POST', '/admin/run', { job: 'checkSalesforce' })).statusCode, 200);
  assert.equal((await as('POST', '/admin/run', { job: 'morning' })).statusCode, 422, 'mass texts stay on the schedule');
  // A non-owner admin still can't grant admin.
  const lisa = signToken({ sub: r.json.person.id, phone: '+17065550160' }, deps.secrets.jwt);
  assert.equal((await call(h, 'POST', '/admin/people', { token: lisa, body: { phone: '706-555-0161', name: 'Y', role: 'admin' } })).statusCode, 422);
});

test('check Salesforce: Salesforce errors read as causes', async () => {
  const { short } = await import('../src/lib/sfcheck.mjs');
  const wrap = m => new Error(`Salesforce GET /services/data/v62.0/query failed (400): [{"message":${JSON.stringify(m)},"errorCode":"INVALID_TYPE"}]`);
  assert.match(short(wrap("\nSELECT Id FROM AssignedResource\n ^\nERROR at Row:1:Column:34\nsObject type 'AssignedResource' is not supported.")), /can't see AssignedResource \(needs a Field Service permission set license\)/);
  assert.match(short(wrap("No such column 'Service_Appointment__c' on entity 'SA_Expense__c'.")), /SA_Expense__c\.Service_Appointment__c .*Field Service/);
  assert.match(short(wrap("Didn't understand relationship 'WorkType' in field path.")), /can't follow WorkType/);
  assert.equal(short(new Error('Salesforce login failed (400): {"error":"invalid_grant","error_description":"user hasn\'t approved this consumer"}')), "user hasn't approved this consumer");
});

// ---- Diagnose -------------------------------------------------------------------------------------
import { explainLogin, fixForCheck } from '../src/lib/diagnose.mjs';

test('diagnose: login errors and check failures come with the cause and the fix', () => {
  assert.match(explainLogin('Salesforce login failed (400): {"error":"invalid_request","error_description":"refresh_token scope is required and the connected app should be installed and preauthorized."}').fix, /Admin approved users are pre-authorized/);
  assert.match(explainLogin("invalid_grant: user hasn't approved this consumer").cause, /pre-approved/);
  assert.match(explainLogin('invalid_client_id: client identifier invalid').fix, /SF_CLIENT_ID/);
  assert.match(explainLogin('Salesforce login failed (400): {"error":"invalid_grant","error_description":"authentication failure"}').fix, /SF_USERNAME/);
  assert.equal(explainLogin('something else entirely'), null);
  assert.match(fixForCheck({ section: 'reads', name: 'x', detail: "the integration user can't see ServiceAppointment (needs a Field Service permission set license)" }), /--license=salesforce/);
  assert.match(fixForCheck({ section: 'writes', name: 'SA_Expense__c', detail: 'Type__c has no picklist value "Vista"' }), /add-vista-type/);
  assert.match(fixForCheck({ section: 'setup', name: 'Flow Vista_Draw_Issued_Notice', detail: 'deployed but not active' }), /Activate/);
});

test('diagnose: finds a misrouted Twilio webhook and a number outside the pool; owners fix them in one click', async () => {
  const deps = await testDeps(), h = createHandler(async () => deps);
  deps.sf.describe = async o => fakeDescribes()[o];
  deps.twilio.svc.inbound_request_url = 'https://old.example/sms'; deps.twilio.svc.numbers = [];
  const owner = signToken({ sub: 'owner', phone: '+17065550001' }, deps.secrets.jwt);
  const run = async () => (await call(h, 'POST', '/admin/run', { token: owner, body: { job: 'diagnose' } })).json;
  let r = await run();
  const find = (rep, name) => rep.areas.flatMap(a => a.items).find(i => i.name === name);
  assert.equal(find(r, 'Salesforce login').status, 'ok');
  assert.equal(find(r, 'Incoming texts reach Vista').status, 'fail'); assert.equal(find(r, 'Incoming texts reach Vista').action, 'twilio.webhook');
  assert.equal(find(r, 'Vista number in the service').action, 'twilio.addNumber');
  assert.equal(find(r, 'Claude (Vi)').status, 'ok'); assert.equal(find(r, 'Photo storage').status, 'ok');
  assert.equal(find(r, 'Texting campaign (A2P 10DLC)').status, 'ok');
  assert.equal(r.ok, false);
  // The last report is kept for the Health screen.
  assert.equal((await call(h, 'GET', '/admin/diagnose', { token: owner })).json.report.at, r.at);
  // An admin who isn't an owner (Lisa) sees it but can't apply fixes.
  await deps.people.save({ id: 'admin:lisa', phone: '+17065550150', name: 'Lisa Payroll', role: 'admin', lang: 'en' });
  const lisa = signToken({ sub: 'admin:lisa', phone: '+17065550150' }, deps.secrets.jwt);
  assert.equal((await call(h, 'POST', '/admin/run', { token: lisa, body: { job: 'diagnose' } })).statusCode, 200);
  assert.equal((await call(h, 'POST', '/admin/fix', { token: lisa, body: { action: 'twilio.webhook' } })).statusCode, 403);
  // The owner fixes both; the next run is clean there. Nothing was written to Salesforce.
  assert.match((await call(h, 'POST', '/admin/fix', { token: owner, body: { action: 'twilio.webhook' } })).json.result, /api\.test\/sms\/inbound/);
  assert.equal((await call(h, 'POST', '/admin/fix', { token: owner, body: { action: 'twilio.addNumber' } })).statusCode, 200);
  assert.equal((await call(h, 'POST', '/admin/fix', { token: owner, body: { action: 'sf.anything' } })).statusCode, 422);
  r = await run();
  assert.equal(find(r, 'Incoming texts reach Vista').status, 'ok'); assert.equal(find(r, 'Vista number in the service').status, 'ok');
  assert.equal(deps.sf.log.creates.length + deps.sf.log.updates.length + deps.sf.log.deletes.length, 0);
  assert.equal((await deps.store.query('FIXLOG')).length, 2, 'fixes are logged');
});

test('diagnose: a Salesforce login failure names the cause, in the alert text too', async () => {
  const deps = await testDeps(), w = createWorker(async () => deps);
  deps.sf.failAuth(true); deps.sf.auth = async () => { throw new Error('Salesforce login failed (400): {"error":"invalid_grant","error_description":"user hasn\'t approved this consumer"}'); };
  await w({ job: 'heartbeat' });
  const alert = deps.twilio.sent.find(m => /heartbeat failed/.test(m.body));
  assert.match(alert.body, /pre-approved/); assert.match(alert.body, /Diagnose/);
  const h = createHandler(async () => deps), owner = signToken({ sub: 'owner', phone: '+17065550001' }, deps.secrets.jwt);
  const r = (await call(h, 'POST', '/admin/run', { token: owner, body: { job: 'diagnose' } })).json;
  const login = r.areas[0].items[0];
  assert.equal(login.status, 'fail'); assert.match(login.fix, /Admin approved users are pre-authorized/);
  const hc = r.areas.find(a => a.area === 'health').items[0];
  assert.equal(hc.action, 'health.rerun'); assert.match(hc.fix, /Admin approved/);
});

test('Twilio client: Diagnose reads the Messaging Service and repairs only its own webhook and pool', async () => {
  const reqs = [];
  const fetchImpl = async (url, opts = {}) => {
    reqs.push({ url, method: opts.method || 'GET', body: opts.body ? String(opts.body) : '' });
    const j = url.includes('IncomingPhoneNumbers') ? { incoming_phone_numbers: [{ sid: 'PN1' }] } : url.endsWith('/PhoneNumbers?PageSize=50') ? { phone_numbers: [{ phone_number: '+17069552075' }] } : url.includes('Usa2p') ? { compliance: [{ campaign_status: 'VERIFIED' }] } : { sid: 'MG1' };
    return { ok: true, json: async () => j, text: async () => '' };
  };
  const t = createTwilio({ accountSid: 'AC1', authToken: 'tok', from: '+17069552075', messagingServiceSid: 'MG1', fetchImpl });
  assert.equal((await t.service()).sid, 'MG1');
  assert.equal((await t.serviceNumbers())[0].phone_number, '+17069552075');
  assert.equal((await t.campaigns())[0].campaign_status, 'VERIFIED');
  await t.setInbound('https://api.test/sms/inbound');
  await t.addNumber('+17069552075');
  const posts = reqs.filter(r => r.method === 'POST');
  assert.equal(posts.length, 2);
  assert.equal(posts[0].url, 'https://messaging.twilio.com/v1/Services/MG1');
  assert.match(posts[0].body, /InboundRequestUrl=https%3A%2F%2Fapi.test%2Fsms%2Finbound&InboundMethod=POST&UseInboundWebhookOnNumber=false/);
  assert.equal(posts[1].url, 'https://messaging.twilio.com/v1/Services/MG1/PhoneNumbers'); assert.equal(posts[1].body, 'PhoneNumberSid=PN1');
  assert.ok(reqs.some(r => r.url === 'https://api.twilio.com/2010-04-01/Accounts/AC1/IncomingPhoneNumbers.json?PhoneNumber=%2B17069552075'));
});

test('diagnose: knows its own address when PUBLIC_API_URL is not set (no false webhook alarm)', async () => {
  const deps = await testDeps(); deps.config.publicApiUrl = null; deps.sf.describe = async o => fakeDescribes()[o];
  deps.twilio.svc.inbound_request_url = 'https://abc123.execute-api.us-east-1.amazonaws.com/sms/inbound';
  const h = createHandler(async () => deps), owner = signToken({ sub: 'owner', phone: '+17065550001' }, deps.secrets.jwt);
  const r = await h({ requestContext: { http: { method: 'POST' }, domainName: 'abc123.execute-api.us-east-1.amazonaws.com' }, rawPath: '/admin/run',
    headers: { authorization: `Bearer ${owner}` }, body: JSON.stringify({ job: 'diagnose' }), isBase64Encoded: false });
  const hook = JSON.parse(r.body).areas.flatMap(a => a.items).find(i => i.name === 'Incoming texts reach Vista');
  assert.equal(hook.status, 'ok', hook.detail);
});

test('permission set: adds Field Service Access when asked, sorted with the API permissions', async () => {
  const D = fakeDescribes(), plan = await planAccess({ describe: async o => D[o] });
  const xml = permissionSetXml(plan, { apiOnly: true, userPerms: ['FieldServiceAccess'] });
  const names = [...xml.matchAll(/<userPermissions>\s*<enabled>true<\/enabled>\s*<name>(\w+)<\/name>/g)].map(m => m[1]);
  assert.deepEqual(names, ['ApiEnabled', 'ApiUserOnly', 'FieldServiceAccess']);
  assert.doesNotMatch(permissionSetXml(plan), /userPermissions/);
});

test('demo text line: an owner plays a sample crew or PM on sample jobs; nothing reaches Salesforce; others are refused', async () => {
  const deps = await testDeps(), h = createHandler(async () => deps);
  let n = 0;
  const text = (from, body) => {
    const form = { From: from, Body: body, MessageSid: `SMD${++n}`, NumMedia: '0' };
    return call(h, 'POST', '/sms/inbound', { form, headers: { 'x-twilio-signature': twilioSignature('twilio-token', 'https://api.test/sms/inbound', form) } });
  };
  const owner = '+17065550001', last = () => deps.twilio.sent.filter(m => m.to === owner).at(-1).body;
  await text(owner, 'START');
  const writes = () => deps.sf.log.creates.length + deps.sf.log.updates.length;
  const before = writes();
  await text(owner, 'demo');
  assert.match(last(), /you're now Dwayne Tucker/);
  await text(owner, 'today');
  assert.match(last(), /Patricia Simmons/);
  assert.match(last(), /8:00\s?AM/, 'sample jobs fall on Eastern hours even though the API runs in UTC');
  await text(owner, 'start 1');
  await text(owner, 'pay 1');
  assert.equal(writes(), before, 'demo never writes to Salesforce');
  await text(owner, 'demo pm');
  assert.match(last(), /you're now Mike/);
  await text(owner, 'today');
  assert.match(last(), /Gerald & Tina Whitfield|Yolanda Pierce/, 'the PM sees pay waiting for review');
  await text(owner, 'demo es');
  await text(owner, 'hoy');
  assert.match(last(), /Tus trabajos/);
  // Texts meant for someone else come back to the demo phone, labelled; nobody else gets a text.
  const others = deps.twilio.sent.filter(m => m.to !== owner).length;
  await text(owner, 'demo off');
  assert.match(last(), /demo ended/);
  await text(owner, 'today');
  assert.doesNotMatch(last(), /Patricia Simmons/, 'back on the real line');
  assert.equal(deps.twilio.sent.filter(m => m.to !== owner).length, others);
  // A crew member texting DEMO gets the normal line, not a demo.
  await text(PEOPLE.tucker.phone, 'demo');
  assert.doesNotMatch(deps.twilio.sent.filter(m => m.to === PEOPLE.tucker.phone).at(-1)?.body || '', /you're now/);
});

test('text engine shows Eastern times wherever it runs', async () => {
  const { createEngine, strings } = await import('../src/lib/shared.mjs');
  const { demoWorld } = await import('../src/lib/demotext.mjs');
  const w = demoWorld('crew-12', '+15555550000', new Date());
  const e = createEngine({ store: { ...w, rollout: { defaultMode: 'on' }, drawRules: {}, checklists: {} }, strings });
  const { replies } = await e.handle('+15555550000', 'today');
  assert.match(replies[0].text, /8:00\s?AM/);
});
