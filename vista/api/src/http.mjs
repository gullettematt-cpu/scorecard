// HTTPS API (API Gateway HTTP API -> Lambda). Routes: see api/README.md.
import { createServices } from './lib/services.mjs';
import { createAuth, signToken, verifyToken, normalizePhone } from './lib/auth.mjs';
import { validTwilioSignature } from './lib/twilio.mjs';
import { asCrew } from './lib/people.mjs';
import { photoKey } from './lib/photos.mjs';

import { timingSafeEqual, createHash } from 'node:crypto';

const sameSecret = (a, b) => { const h = x => createHash('sha256').update(String(x ?? '')).digest(); return !!a && !!b && timingSafeEqual(h(a), h(b)); };
const ADMIN_JOBS = ['heartbeat', 'morning', 'pmDigest', 'cutoff', 'dispatchPoll'];
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
        const msg = { from: params.From, body: params.Body || '', messageId: params.MessageSid,
          media: Array.from({ length: Number(params.NumMedia || 0) }, (_, i) => params[`MediaUrl${i}`]).filter(Boolean) };
        if (deps.invokeWorker) await deps.invokeWorker({ job: 'sms', msg }); else await svc.handleText(msg);
        return { statusCode: 200, headers: { 'content-type': 'text/xml' }, body: '<Response></Response>' };
      }

      // ---- Admin (x-admin-token) ---------------------------------------------------------------
      if (path.startsWith('/admin/')) {
        if (!sameSecret(header('x-admin-token'), deps.secrets.admin)) return json(403, { error: 'forbidden' });
        if (method === 'POST' && path === '/admin/people') {
          const b = body(); const phone = normalizePhone(b.phone);
          if (!phone || !['installer', 'measure', 'pm'].includes(b.role) || !b.name) return json(422, { error: 'phone, name and role (installer|measure|pm) are required' });
          const existing = await deps.people.byPhone(phone).catch(() => null);
          const p = await deps.people.save({ ...(existing || {}), id: b.id || existing?.id || `${b.role}:${phone}`, phone, name: b.name, role: b.role,
            userId: b.userId ?? existing?.userId, serviceResourceIds: b.serviceResourceIds ?? existing?.serviceResourceIds ?? [], account: b.account ?? existing?.account ?? null,
            lang: b.lang ?? existing?.lang ?? 'en', channel: b.channel ?? existing?.channel ?? 'both', disabled: !!b.disabled, source: 'admin' });
          return json(200, { person: p });
        }
        if (method === 'GET' && path === '/admin/people') return json(200, { people: await deps.people.list() });
        if (method === 'GET' && path === '/admin/rollout') return json(200, { rollout: await svc.getRollout() });
        if (method === 'PUT' && path === '/admin/rollout') return json(200, { rollout: await svc.setRollout(body()) });
        if (method === 'GET' && path === '/admin/language-requests') return json(200, { requests: await deps.store.query('LANGREQ') });
        if (method === 'POST' && path === '/admin/run') return ADMIN_JOBS.includes(body().job) ? json(200, (await svc[body().job]()) ?? { ok: true }) : json(422, { error: `job must be one of ${ADMIN_JOBS.join(', ')}` });
        return json(404, { error: 'not found' });
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
        const count = Math.min(Math.max(1, Number(b.count) || 1), 20), at = new Date();
        const uploads = await Promise.all(Array.from({ length: count }, async (_, i) => {
          const key = photoKey({ workOrderId: w.Id, serviceAppointmentId: w.ServiceAppointment?.Id, kind: String(b.kind || 'photo').replace(/\W/g, ''), n: i + 1, at });
          return { key, url: await deps.photos.signPut(key, b.contentType || 'image/jpeg') };
        }));
        return json(200, { uploads }, origin);
      }
      if (method === 'POST' && path === '/translate') {
        const texts = (body().texts || []).slice(0, 100).map(String);
        return json(200, { pairs: await deps.translations.pairsFor(texts) }, origin);
      }
      if (method === 'POST' && path === '/vi/ask') {
        const b = body(), snap = b.workOrderId ? await svc.snapshotFor(person, { translate: false }) : null;
        const job = snap?.jobs.find(j => j.Id === b.workOrderId) || null;
        const { checklists, domain } = await import('./lib/shared.mjs');
        const answer = await deps.vi.ask({ lang: person.lang, viLanguage: person.requested || null, job, checklist: job ? checklists[domain.tradeKey(job)] : null, question: String(b.question || '').slice(0, 2000) });
        return json(200, { answer }, origin);
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
