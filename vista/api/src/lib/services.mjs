// Vista's use cases, shared by the HTTPS API (api/src/http.mjs) and the worker (api/src/worker.mjs).
// `deps` = { sf, store, people, photos, twilio, vi, translations, config } — real in AWS, fakes in tests.
import { strings, checklists, rollout as fileRollout, drawRules, createEngine, makeTranslator, domain, readManifest, vistaOn } from './shared.mjs';
import { loadSnapshot, freeTexts, EXPENSE_FIELDS } from './snapshot.mjs';
import { createActions, ActionError } from './actions.mjs';
import { asCrew } from './people.mjs';
import { lit, inList } from './salesforce.mjs';
import { createOptIns, gatedTwilio, keywordOf, OPT_IN_PROMPT } from './optin.mjs';

const fill = (lang, key, vars = {}) => {
  const one = l => Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), strings[l]?.[key] ?? strings.en[key] ?? key);
  return lang === 'bi' ? `${one('en')} / ${one('es')}` : one(lang === 'es' ? 'es' : 'en');
};
const money = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0);

export function createServices(deps) {
  const { sf, store, people, photos, vi, translations, config = {} } = deps;
  // Every automatic text goes through the opt-in gate (lib/optin.mjs). The raw client is only for answering an
  // incoming text from a phone that hasn't opted in yet with how to opt in.
  const optIns = createOptIns({ store });
  const twilio = gatedTwilio({ twilio: deps.twilio, optIns, people, store });
  const perform = createActions({ sf, store, photos, twilio, people, adminPhones: config.adminPhones || [], now: deps.now });
  // The rollout switch: set with PUT /admin/rollout (no redeploy); config/rollout.json is the starting default.
  const getRollout = async () => (await store.get('CONFIG', 'ROLLOUT'))?.rollout || fileRollout;

  async function snapshotFor(person, { translate = true } = {}) {
    const snap = await loadSnapshot({ sf, people, store, person });
    const pairs = translate && translations ? await translations.pairsFor(freeTexts(snap)) : [];
    return { ...snap, rollout: await getRollout(), drawRules, translations: { pairs }, photoUrls: translate ? await photoUrls(snap) : {} };
  }
  // One-hour view links for every photo on the pay requests and draws this person can see (PM review, job screen).
  async function photoUrls(snap) {
    const keys = [...new Set([...snap.draws.flatMap(d => (readManifest(d[domain.MANIFEST_FIELD])?.photos || []).map(p => p.key).filter(Boolean)), ...snap.cases.flatMap(c => c._photos || [])])];
    return Object.fromEntries(await Promise.all(keys.map(async k => [k, await photos.signGet(k)])));
  }

  // App outbox -> Salesforce. Idempotent per entry id.
  async function sync(person, entries) {
    const snap = await loadSnapshot({ sf, people, store, person });
    const results = [];
    for (const e of entries) {
      const key = { pk: `SYNC#${person.id}`, sk: String(e.id), ttl: Math.floor(Date.now() / 1000) + 30 * 86400 };
      if (e.id != null && !(await store.putIfAbsent({ ...key, at: new Date().toISOString() }))) { results.push({ id: e.id, ok: true, duplicate: true }); continue; }
      try { results.push({ id: e.id, ...(await perform(person, snap, e)) }); }
      catch (err) {
        if (e.id != null) await store.del(key.pk, key.sk);
        results.push({ id: e.id, ok: false, status: err instanceof ActionError ? err.status : 500, error: err.message });
      }
    }
    return results;
  }

  // One incoming text: run the conversation engine, perform what it decided, send the replies.
  async function handleText({ from, body = '', media = [], messageId = null, optOutType = null }) {
    if (messageId && !(await store.putIfAbsent({ pk: `SMSMSG#${messageId}`, sk: 'SEEN', ttl: Math.floor(Date.now() / 1000) + 86400 }))) return { duplicate: true };
    // Carrier keywords first. Twilio already answered START / STOP / HELP; Vista records opt-in and opt-out.
    const kw = keywordOf(body, optOutType);
    if (kw === 'in' || kw === 'out') { await optIns.set(from, kw); return { optIn: kw }; }
    if (kw === 'help') return { help: true };
    const st = await optIns.get(from);
    if (st?.status === 'out') return { optedOut: true };
    if (st?.status !== 'in') {
      // Not opted in: at most one reply a day, saying how to opt in. Nothing else happens.
      if (await store.putIfAbsent({ pk: `OPTINPROMPT#${from}`, sk: new Date().toISOString().slice(0, 10), ttl: Math.floor(Date.now() / 1000) + 2 * 86400 })) await deps.twilio.send(from, OPT_IN_PROMPT);
      return { notOptedIn: true };
    }
    const person = await people.byPhone(from);
    const snap = person ? await snapshotFor(person) : { jobs: [], draws: [], cases: [], people: [], translations: { pairs: [] } };
    const world = structuredClone({ people: snap.people, jobs: snap.jobs, draws: snap.draws }); // the engine edits its own copy
    const engine = createEngine({
      store: { ...world, rollout: snap.rollout || await getRollout(), drawRules, checklists },
      strings, tr: makeTranslator(snap.translations),
      links: { photos: d => `${config.appUrl || ''}/#/approve/${d.Id}` },
      askVi: vi ? ({ lang, viLanguage, job, question }) => vi.ask({ lang, viLanguage, job, question, checklist: job ? checklists[domain.tradeKey(job)] : null }) : null
    });
    if (person) { const saved = await store.get(`SMS#${person.id}`, 'SESSION'); if (saved?.session) engine.sessions.set(person.id, { ...saved.session, lang: person.lang || saved.session.lang }); }
    const out = await engine.handle(from, body, media);

    let failed = false;
    for (const a of out.actions) {
      try { await perform(person, snap, a); }
      catch (err) { failed = true; console.warn('text action failed', a.kind, err.message); }
    }
    if (person) await store.put({ pk: `SMS#${person.id}`, sk: 'SESSION', session: engine.sessions.get(person.id), ttl: Math.floor(Date.now() / 1000) + 14 * 86400 });
    const replies = failed ? [{ to: from, text: fill(person?.lang, 'txt.saveFailed') }, ...out.replies.filter(r => r.to !== from)] : out.replies;
    for (const r of replies) await twilio.send(r.to, r.text, { reply: r.to === from });
    return { replies, actions: out.actions, failed };
  }

  // ---- Scheduled texts ----------------------------------------------------------------------
  async function textPeople(filter, compose) {
    let sent = 0;
    for (const p of (await people.list()).filter(filter)) {
      try {
        const snap = await snapshotFor(p, { translate: false });
        const engine = createEngine({ store: { people: snap.people, jobs: snap.jobs, draws: snap.draws, rollout: snap.rollout, drawRules, checklists }, strings });
        const text = compose(engine, asCrew(p));
        if (text) { await twilio.send(p.phone, text); sent++; }
      } catch (err) { console.warn('scheduled text failed', p.id, err.message); }
    }
    return { sent };
  }
  const morning = () => textPeople(p => p.role !== 'pm' && (p.channel || 'both') !== 'app' && !p.disabled, (e, p) => e.morningDigest(p));
  const pmDigest = () => textPeople(p => p.role === 'pm' && (p.channel || 'both') !== 'app' && !p.disabled, (e, p) => e.pmDigest(p));

  // 10:00 AM: every Vista pay request still at New misses today's run.
  async function cutoff({ day = new Date().toISOString().slice(0, 10) } = {}) {
    const pending = await sf.query(`SELECT ${EXPENSE_FIELDS}, Work_Order__r.WorkOrderNumber, Work_Order__r.Account.Name, Service_Appointment__r.SMS_Opt_out__c
      FROM SA_Expense__c WHERE Type__c = 'Vista' AND Status__c = 'New' AND TEST_SA__c = false AND Did_you_complete_the_job_or_service__c = 'Yes'`);
    if (!pending.length) return { subs: 0, pms: 0 };
    const assigned = await sf.query(`SELECT ServiceAppointmentId, ServiceResourceId, Lead_Installer__c FROM AssignedResource WHERE ServiceAppointmentId IN ${inList([...new Set(pending.map(d => d.Service_Appointment__c).filter(Boolean))])}`);
    let subs = 0; const perPm = new Map();
    for (const d of pending) {
      if (!(await store.putIfAbsent({ pk: `NOTICE#${day}`, sk: d.Id, ttl: Math.floor(Date.now() / 1000) + 7 * 86400 }))) continue;
      const m = readManifest(d.Additional_Work_Performed_Description__c);
      const sentBack = m.approval?.decision === 'sent_back' && !(m.resubmitted_at > m.approval.at);
      if (!sentBack && d.Production_Manager__c) perPm.set(d.Production_Manager__c, (perPm.get(d.Production_Manager__c) || 0) + 1);
      if (d.Service_Appointment__r?.SMS_Opt_out__c) continue;
      const ar = assigned.filter(a => a.ServiceAppointmentId === d.Service_Appointment__c).sort((a, b) => Number(b.Lead_Installer__c) - Number(a.Lead_Installer__c))[0];
      const crew = ar && await people.byResource(ar.ServiceResourceId);
      if (!crew || crew.channel === 'app') continue;
      const vars = { wo: d.Work_Order__r?.WorkOrderNumber, who: d.Work_Order__r?.Account?.Name || '', street: '', items: (m.approval?.missed || []).map(x => x.text).join('; ') };
      await twilio.send(crew.phone, sentBack ? fill(crew.lang, 'sms.sentBack', vars) : fill(crew.lang, 'txt.notice.stillWithPm', vars));
      subs++;
    }
    let pms = 0;
    for (const [userId, n] of perPm) {
      const pm = await people.byUser(userId);
      if (pm && pm.channel !== 'app') { await twilio.send(pm.phone, fill(pm.lang, 'txt.notice.pmMissedCutoff', { n })); pms++; }
    }
    return { subs, pms };
  }

  // Every few minutes: tell crews about newly dispatched visits.
  async function dispatchPoll() {
    const state = await store.get('POLL', 'DISPATCH');
    const since = state?.at || new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const nowIso = new Date().toISOString();
    const sas = await sf.query(`SELECT Id, SchedStartTime, Work_Order__r.Account.Name, Work_Order__r.Street, Work_Order__r.Job_Number__r.Office__c, Work_Order__r.Job_Number__r.Office__r.Name, (SELECT ServiceResourceId FROM ServiceResources)
      FROM ServiceAppointment WHERE Status = 'Dispatched' AND LastModifiedDate > ${since.replace(/\.\d+Z$/, 'Z')} AND Test_SA__c = false`);
    let sent = 0; const rollout = await getRollout();
    for (const sa of sas) {
      if (!(await store.putIfAbsent({ pk: `DISPATCHED#${sa.Id}`, sk: 'SENT', ttl: Math.floor(Date.now() / 1000) + 30 * 86400 }))) continue;
      for (const ar of sa.ServiceResources?.records || []) {
        const p = await people.byResource(ar.ServiceResourceId);
        if (!p || p.channel === 'app' || p.disabled) continue;
        // Only where Vista is switched on for this location and the person's account.
        const jn = sa.Work_Order__r?.Job_Number__r;
        if (!vistaOn(rollout, jn && { Id: jn.Office__c, Name: jn.Office__r?.Name }, p.account)) continue;
        const when = new Intl.DateTimeFormat(p.lang === 'es' ? 'es-US' : 'en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(sa.SchedStartTime));
        await twilio.send(p.phone, fill(p.lang, 'txt.notice.dispatched', { when, who: sa.Work_Order__r?.Account?.Name || '', street: sa.Work_Order__r?.Street || '' }));
        sent++;
      }
    }
    await store.put({ pk: 'POLL', sk: 'DISPATCH', at: nowIso });
    return { sent };
  }

  // Every 2 hours: log in, read a job, write a test SA Expense, store a photo. Text Matt and Mike on failure.
  async function heartbeat() {
    const state = (await store.get('HEARTBEAT', 'STATE')) || {};
    let step = 'login';
    try {
      await sf.auth();
      step = 'read';
      const wo = (await sf.query(`SELECT Id FROM WorkOrder WHERE Test_WO__c = true ORDER BY LastModifiedDate DESC LIMIT 1`))[0]
        || (await sf.query(`SELECT Id FROM WorkOrder ORDER BY LastModifiedDate DESC LIMIT 1`))[0];
      if (!wo) throw new Error('no work order readable');
      step = 'write';
      const id = await sf.create('SA_Expense__c', { Type__c: 'Vista', Status__c: 'New', TEST_SA__c: true, Amount__c: 0.01, Expense_Type__c: 'Labour',
        Date__c: new Date().toISOString().slice(0, 10), Work_Order__c: wo.Id, Additional_Work_Performed_Description__c: '{"v":1,"app":"vista-heartbeat"}' });
      if (state.lastRecord) await sf.del('SA_Expense__c', state.lastRecord).catch(() => {});
      step = 'upload';
      const key = `vista/heartbeat/${Date.now()}.png`;
      await photos.put(key, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'), 'image/png');
      await photos.head(key);
      if (state.failing) for (const to of config.alertPhones || []) await twilio.send(to, fill('en', 'txt.notice.heartbeatOk', { step: state.failing }));
      await store.put({ pk: 'HEARTBEAT', sk: 'STATE', lastRecord: id, lastOk: new Date().toISOString(), failing: null });
      return { ok: true };
    } catch (err) {
      if (state.failing !== step) for (const to of config.alertPhones || []) await twilio.send(to, fill('en', 'txt.notice.heartbeatFail', { step, error: String(err.message).slice(0, 120) })).catch(() => {});
      await store.put({ ...state, pk: 'HEARTBEAT', sk: 'STATE', failing: step, failedAt: new Date().toISOString(), error: String(err.message).slice(0, 500) });
      return { ok: false, step, error: err.message };
    }
  }

  // ---- Program admin (payroll) ---------------------------------------------------------------
  // Every Vista pay request and draw: open ones, plus the last 30 days, sorted into stages.
  async function board() {
    const rows = await sf.query(`SELECT ${EXPENSE_FIELDS}, Production_Manager__c, Production_Manager__r.Name, Account__r.Name,
      Work_Order__r.WorkOrderNumber, Work_Order__r.Account.Name, Work_Order__r.Job_Number__r.Office__r.Name
      FROM SA_Expense__c WHERE Type__c = 'Vista' AND TEST_SA__c = false AND (Status__c = 'New' OR CreatedDate = LAST_N_DAYS:30)
      ORDER BY CreatedDate DESC LIMIT 500`);
    const items = rows.map(d => domain.boardRow(d, { wo: d.Work_Order__r?.WorkOrderNumber || '', homeowner: d.Work_Order__r?.Account?.Name || '',
      office: d.Work_Order__r?.Job_Number__r?.Office__r?.Name || '', crew: d.Account__r?.Name || '', pmUserId: d.Production_Manager__c || null, pmName: d.Production_Manager__r?.Name || '' }));
    return { items, byPm: domain.boardByPm(items), at: new Date().toISOString() };
  }
  // Payroll asks a PM to review what's waiting on them. Once an hour per PM at most.
  async function nudgePm({ pmUserId, from }) {
    const { items } = await board();
    const waiting = items.filter(r => r.stage === 'withPm' && r.pmUserId === pmUserId);
    if (!waiting.length) return { sent: false, reason: 'nothing-waiting' };
    const pm = await people.byUser(pmUserId).catch(() => null);
    if (!pm || pm.disabled) return { sent: false, reason: 'not-enrolled' };
    if ((pm.channel || 'both') === 'app') return { sent: false, reason: 'app-only', phone: pm.phone, name: pm.name };
    if (!(await twilio.canText(pm.phone))) return { sent: false, reason: 'not-opted-in', phone: pm.phone, name: pm.name };
    const last = await store.get(`NUDGE#${pmUserId}`, 'LAST');
    if (last && Date.now() - Date.parse(last.at) < 3600e3) return { sent: false, reason: 'recently', at: last.at, phone: pm.phone, name: pm.name };
    await twilio.send(pm.phone, fill(pm.lang, 'txt.notice.nudge', { from, n: waiting.length, amount: money(waiting.reduce((s, r) => s + r.amount, 0)) }));
    await store.put({ pk: `NUDGE#${pmUserId}`, sk: 'LAST', at: new Date().toISOString(), by: from, ttl: Math.floor(Date.now() / 1000) + 86400 });
    return { sent: true, n: waiting.length, phone: pm.phone, name: pm.name };
  }
  async function health() {
    const s = (await store.get('HEARTBEAT', 'STATE')) || {};
    return { lastOk: s.lastOk || null, failing: s.failing || null, failedAt: s.failedAt || null, error: s.error || null };
  }

  return { snapshotFor, sync, handleText, morning, pmDigest, cutoff, dispatchPoll, heartbeat, perform, getRollout, board, nudgePm, health, optIns,
    async setRollout(r) {
      const ok = r && typeof r === 'object' && Object.values(r.locations || {}).every(l => ['off', 'pilot', 'on'].includes(l.mode));
      if (!ok) throw Object.assign(new Error('each location needs mode off, pilot or on'), { status: 422 });
      await store.put({ pk: 'CONFIG', sk: 'ROLLOUT', rollout: { defaultMode: 'off', ...r }, at: new Date().toISOString() });
      return getRollout();
    } };
}
