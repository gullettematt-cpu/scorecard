// HTTPS API (API Gateway HTTP API -> Lambda). Routes: see api/README.md.
import { createServices } from './lib/services.mjs';
import { createAuth, signToken, verifyToken, normalizePhone } from './lib/auth.mjs';
import { validTwilioSignature } from './lib/twilio.mjs';
import { asCrew } from './lib/people.mjs';
import { photoKey } from './lib/photos.mjs';

import { timingSafeEqual, createHash } from 'node:crypto';

const sameSecret = (a, b) => { const h = x => createHash('sha256').update(String(x ?? '')).digest(); return !!a && !!b && timingSafeEqual(h(a), h(b)); };
const ADMIN_JOBS = ['heartbeat', 'morning', 'pmDigest', 'cutoff', 'dispatchPoll', 'checkSalesforce'];
const VI_DAILY_LIMIT = 60;
const json = (status, body, origin) => ({ statusCode: status, headers: { 'content-type': 'application/json', ...(origin ? { 'access-control-allow-origin': origin, vary: 'origin' } : {}) }, body: JSON.stringify(body) });

export function createHandler(getDeps) {
  return async function handler(event) {
    const deps = await getDeps();
    const svc = createServices(deps);
    const origin = deps.config.appUrl;
    const method = event.requestContext?.http?.method || event.httpMethod;
    const path = event.rawPath || event.path;
    const raw = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body) : '';
    const header = n => event.headers?.[n] ?? event.headers?.[n.toLowerCase()];
    const body = () => { try { return raw ? JSON.parse(raw) : {}; } catch { return {}; } };
    const auth = createAuth({ store: deps.store, secret: deps.secrets.jwt, sendText: (to, t) => deps.twilio.send(to, t) });

    try {
      if (method === 'GET' && path === '/health') return json(200, { ok: true }, origin);

      // ---- Sign-in by text code ------------------------------------------------------------
      if (method === 'POST' && path === '/auth/start') {
        const phone = normalizePhone(body().phone);
        if (phone) await auth.start(phone, await deps.people.byPhone(phone).catch(() => null), body().lang);
        return json(200, { ok: true }, origin); // same answer whether or not the number is enrolled
      }
      if (method === 'POST' && path === '/auth/verify') {
        const phone = normalizePhone(body().phone);
        if (!phone || !(await auth.verify(phone, body().code))) return json(401, { error: 'code' }, origin);
        const person = await deps.people.byPhone(phone);
        if (!person || person.disabled) return json(401, { error: 'code' }, origin);
        return json(200, { token: signToken({ sub: person.id, phone }, deps.secrets.jwt), person: asCrew(person) }, origin);
      }

      // ---- Text messages (Twilio webhook) -----------------------------------------------------
      if (method === 'POST' && path === '/sms/inbound') {
        const params = Object.fromEntries(new URLSearchParams(raw));
        if (!validTwilioSignature({ authToken: deps.secrets.twilioAuthToken, url: `${deps.config.publicApiUrl || `https://${event.requestContext?.domainName}`}/sms/inbound`, params, signature: header('X-Twilio-Signature') })) return { statusCode: 403, body: 'bad signature' };
        const msg = { from: params.From, body: params.Body || '', messageId: params.MessageSid, optOutType: params.OptOutType || null,
          media: Array.from({ length: Number(params.NumMedia || 0) }, (_, i) => params[`MediaUrl${i}`]).filter(Boolean) };
        if (deps.invokeWorker) await deps.invokeWorker({ job: 'sms', msg }); else await svc.handleText(msg);
        return { statusCode: 200, headers: { 'content-type': 'text/xml' }, body: '<Response></Response>' };
      }

      // ---- Admin: the admin token (Donald's scripts) or a signed-in person with the admin role (Lisa, payroll) ----
      if (path.startsWith('/admin/')) {
        let actor = null; // null = the admin token
        if (!sameSecret(header('x-admin-token'), deps.secrets.admin)) {
          const c = verifyToken(String(header('authorization') || '').replace(/^Bearer /, ''), deps.secrets.jwt);
          const p = c && await deps.people.byPhone(c.phone).catch(() => null);
          if (!p || p.disabled || p.role !== 'admin') return json(403, { error: 'forbidden' }, origin);
          actor = p;
        }
        if (method === 'POST' && path === '/admin/people') {
          const b = body(); const phone = normalizePhone(b.phone);
          const roles = actor ? ['installer', 'measure', 'pm'] : ['installer', 'measure', 'pm', 'admin']; // only the token makes admins
          if (!phone || !roles.includes(b.role) || !b.name) return json(422, { error: `phone, name and role (${roles.join('|')}) are required` }, origin);
          const existing = await deps.people.byPhone(phone).catch(() => null);
          if (actor && existing?.role === 'admin') return json(403, { error: 'admins are managed by the IT admin' }, origin);
          if (actor && existing?.id === actor.id) return json(422, { error: "you can't change your own access" }, origin);
          const p = await deps.people.save({ ...(existing || {}), id: b.id || existing?.id || `${b.role}:${phone}`, phone, name: b.name, role: b.role,
            userId: b.userId ?? existing?.userId, serviceResourceIds: b.serviceResourceIds ?? existing?.serviceResourceIds ?? [], account: b.account ?? existing?.account ?? null,
            lang: b.lang ?? existing?.lang ?? 'en', channel: b.channel ?? existing?.channel ?? 'both', disabled: !!b.disabled, source: actor ? `admin:${actor.name}` : 'admin' });
          return json(200, { person: p }, origin);
        }
        if (method === 'GET' && path === '/admin/people') {
          const [list, opt] = await Promise.all([deps.people.list(), svc.optIns.all()]);
          return json(200, { people: list.map(p => ({ ...p, textOptIn: opt[p.phone]?.status || 'none' })) }, origin);
        }
        if (method === 'GET' && path === '/admin/rollout') return json(200, { rollout: await svc.getRollout() }, origin);
        if (method === 'PUT' && path === '/admin/rollout') return json(200, { rollout: await svc.setRollout(body()) }, origin);
        if (method === 'GET' && path === '/admin/language-requests') return json(200, { requests: await deps.store.query('LANGREQ') }, origin);
        if (method === 'GET' && path === '/admin/board') return json(200, await svc.board(), origin);
        if (method === 'POST' && path === '/admin/nudge') {
          const b = body(); if (!b.pmUserId) return json(422, { error: 'pmUserId is required' }, origin);
          return json(200, await svc.nudgePm({ pmUserId: String(b.pmUserId), from: actor?.name || 'Payroll' }), origin);
        }
        if (method === 'GET' && path === '/admin/health') return json(200, await svc.health(), origin);
        if (method === 'POST' && path === '/admin/run') {
          const jobs = actor ? ['heartbeat'] : ADMIN_JOBS; // people can re-run the health check; mass texts stay on the schedule
          return jobs.includes(body().job) ? json(200, (await svc[body().job]()) ?? { ok: true }, origin) : json(422, { error: `job must be one of ${jobs.join(', ')}` }, origin);
        }
        return json(404, { error: 'not found' }, origin);
      }

      // ---- Everything below needs a signed-in person ------------------------------------------
      const claims = verifyToken(String(header('authorization') || '').replace(/^Bearer /, ''), deps.secrets.jwt);
      const person = claims && await deps.people.byPhone(claims.phone);
      if (!person || person.disabled) return json(401, { error: 'sign in' }, origin);

      if (method === 'GET' && path === '/me') return json(200, { person: asCrew(person) }, origin);
      if (method === 'PATCH' && path === '/me/prefs') {
        const b = body(), patch = {};
        if (['en', 'es', 'bi'].includes(b.lang)) patch.lang = b.lang;
        if (['app', 'text', 'both'].includes(b.channel)) patch.channel = b.channel;
        return json(200, { person: asCrew(await deps.people.update(person, patch)) }, origin);
      }
      if (method === 'GET' && path === '/snapshot') {
        const snap = await svc.snapshotFor(person);
        return json(200, { person: asCrew(person), ...snap }, origin);
      }
      if (method === 'POST' && path === '/sync') {
        const entries = (body().entries || []).slice(0, 50);
        return json(200, { results: await svc.sync(person, entries) }, origin);
      }
      if (method === 'POST' && path === '/photos/sign') {
        const b = body(), snap = await svc.snapshotFor(person, { translate: false });
        const w = snap.jobs.find(j => j.Id === b.workOrderId);
        if (!w || person.role === 'pm') return json(403, { error: 'not your job' }, origin);
        // Keys named by the phone (it saves photos offline under their final key), or generated here.
        let keys;
        if (Array.isArray(b.keys)) {
          const ok = new RegExp(`^vista/${w.Id}/[A-Za-z0-9]+/\\d{8}T\\d{6}-[A-Za-z0-9]+-\\d{1,3}\\.jpg$`);
          if (!b.keys.length || b.keys.length > 20 || !b.keys.every(k => typeof k === 'string' && ok.test(k))) return json(422, { error: 'bad photo keys' }, origin);
          keys = b.keys;
        } else {
          const count = Math.min(Math.max(1, Number(b.count) || 1), 20), at = new Date();
          keys = Array.from({ length: count }, (_, i) => photoKey({ workOrderId: w.Id, serviceAppointmentId: w.ServiceAppointment?.Id, kind: String(b.kind || 'photo').replace(/\W/g, ''), n: i + 1, at }));
        }
        const uploads = await Promise.all(keys.map(async key => ({ key, url: await deps.photos.signPut(key, 'image/jpeg') })));
        return json(200, { uploads }, origin);
      }
      if (method === 'POST' && path === '/translate') {
        const texts = (body().texts || []).slice(0, 100).map(String);
        return json(200, { pairs: await deps.translations.pairsFor(texts) }, origin);
      }
      if (method === 'POST' && path === '/vi/ask') {
        const b = body(), question = String(b.question || '').trim().slice(0, 2000);
        if (!question) return json(422, { error: 'ask a question' }, origin);
        // A daily cap per person keeps a stuck phone or a long chat from running up the bill.
        const day = new Date().toISOString().slice(0, 10), rate = (await deps.store.get(`VIRATE#${person.id}`, day)) || { pk: `VIRATE#${person.id}`, sk: day, n: 0, ttl: Math.floor(Date.now() / 1000) + 2 * 86400 };
        if (rate.n >= VI_DAILY_LIMIT) return json(429, { error: 'daily limit', limit: VI_DAILY_LIMIT }, origin);
        await deps.store.put({ ...rate, n: rate.n + 1 });
        const snap = b.workOrderId ? await svc.snapshotFor(person, { translate: false }) : null;
        const job = snap?.jobs.find(j => j.Id === b.workOrderId) || null;
        if (b.workOrderId && !job) return json(403, { error: 'not your job' }, origin);
        const { checklists, domain } = await import('./lib/shared.mjs');
        // What Vi may know about the job beyond the record: open problems and where pay stands (status and amount only).
        const extras = job ? {
          problems: domain.casesFor(snap.cases, job).map(c => ({ subject: c.Subject, status: c.Status, priority: c.Priority })),
          pay: domain.drawsFor(snap.draws, job.Id).map(d => ({ kind: domain.isDraw(d) ? 'draw' : 'completion pay', amount: d.Amount__c, status: domain.drawStatus(d) }))
        } : {};
        const history = (Array.isArray(b.history) ? b.history : []).map(h => ({ q: String(h?.q || ''), a: String(h?.a || '') }));
        const out = await deps.vi.chat({ lang: person.lang, viLanguage: person.requested || null, job, checklist: job ? checklists[domain.tradeKey(job)] : null, extras, history, question });
        return json(200, { answer: out.answer, problem: out.problem || null, left: VI_DAILY_LIMIT - rate.n - 1 }, origin);
      }
      return json(404, { error: 'not found' }, origin);
    } catch (err) {
      console.error(err);
      return json(err.status || 500, { error: err.status ? err.message : 'server error' }, origin);
    }
  };
}

// Lambda entry point.
import { realDeps } from './lib/deps.mjs';
let invoker;
async function awsDeps() {
  const deps = await realDeps();
  if (deps.config.workerFunction && !invoker) {
    const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
    const lambda = new LambdaClient({});
    invoker = payload => lambda.send(new InvokeCommand({ FunctionName: deps.config.workerFunction, InvocationType: 'Event', Payload: Buffer.from(JSON.stringify(payload)) }));
  }
  return { ...deps, invokeWorker: invoker };
}
export const handler = createHandler(awsDeps);
