// Terms (Matt, 2026-09-27):
//   Pay request  = the installer's "Submit for pay" when their job is complete (SA_Expense__c at New, Did_you_complete = Yes).
//                  The PM reviews it and submits it once in Vista -> Approved.
//   Draw         = a payment BEFORE the job is complete. The installer asks the PM directly (outside the app);
//                  the PM issues it in Vista, created already Approved with Did_you_complete = No.
// The PM's confirmed submit IS the approval: Vista writes Status__c = Approved + Approver__c (what the Titan
// approval process's final approval writes). Vista records never enter an approval process.
// Both are SA_Expense__c records with Type__c = Vista. In code, `draws` is the store of all of them.
//
// The only module that knows where data comes from.
// Step 1: fixtures. Step 2: swap `adapter` for one that calls /sf/* — same shapes, same API names.
// Field names below are confirmed against docs/describe/SUMMARY.md (myorg, 2026-09-27).
import { db } from './db.js';
import { vistaOn } from './rollout.js';
import { apiMode, api, deviceId } from './api.js';

export const MANIFEST_FIELD = 'Additional_Work_Performed_Description__c';
export const MANIFEST_MARK = '<!--vista-manifest-->';

// Southern Industries works in Eastern time; the API runs in UTC, so days are counted in Eastern everywhere.
export const TIME_ZONE = 'America/New_York';
export const easternDay = d => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date(d)); // YYYY-MM-DD
// `dayOffset` days from today at an Eastern wall-clock hour, as an ISO string (sample jobs, on a phone or the API).
export function easternAt(dayOffset, hour, now = new Date()) {
  const ymd = easternDay(new Date(now.getTime() + dayOffset * 864e5));
  const guess = new Date(`${ymd}T${String(hour).padStart(2, '0')}:00:00Z`);
  const shown = Number(new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: 'numeric', hourCycle: 'h23' }).format(guess));
  let diff = shown - hour; if (diff > 12) diff -= 24; if (diff < -12) diff += 24;
  return new Date(guess.getTime() - diff * 3600e3).toISOString();
}

const dayAt = (offset, hour) => easternAt(offset, hour);
const dayOff = offset => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toISOString(); };

// Fixture files -> the jobs, pay requests and problems the screens use. Also the API's demo text line,
// which passes its own clock (`at`, `dayOff`) so the sample jobs fall on today's Eastern hours.
export function fixtureWorld(crews, crew, files, { at = dayAt, off = dayOff } = {}) {
  const out = { jobs: [], draws: [], cases: [] };
  for (const [file, fx] of Object.entries(files)) {
    const owner = crews.find(c => c.fixture === file) || crew;
    out.jobs.push(...fx.workOrders.map(w => ({
      ...w,
      StartDate: at(w._schedule.dayOffset, w._schedule.startHour),
      EndDate: at(w._schedule.dayOffset, w._schedule.endHour),
      LastModifiedDate: new Date().toISOString(),
      _crew: owner.id, _crewName: owner.name, _trade: owner.trade, _lang: owner.lang, _account: owner.account || null,
      Job_Number__r: fx.jobs.find(j => j.Id === w.Job_Number__c) || null
    })));
    out.draws.push(...fx.draws.map(d => ({ ...d, CreatedDate: off(d.CreatedDate_dayOffset || 0), Date__c: off(d.CreatedDate_dayOffset || 0).slice(0, 10), _crew: owner.id, _lang: owner.lang })));
    out.cases.push(...fx.cases.map(c => ({ ...c, CreatedDate: off(c.CreatedDate_dayOffset || 0), _crew: owner.id })));
  }
  return out;
}

const fixtureAdapter = {
  name: 'fixture',
  async crews() { return (await fetch('./fixtures/crews.json')).json(); },
  // Demo: the admin's Rollout screen saves an override on this phone, so switching a location off shows.
  async rollout() { return (await db.meta('rolloutOverride')) || (await fetch('./fixtures/rollout.json')).json(); },
  async translations() { return (await fetch('./fixtures/translations.json')).json(); },
  async load(crew) {
    const crews = await this.crews();
    const files = {};
    for (const file of crew.fixtures || [crew.fixture]) files[file] = await (await fetch(`./fixtures/${file}`)).json();
    return fixtureWorld(crews, crew, files);
  },
  // Outbox entries are just logged in fixture mode. Step 2 posts them to /sf/*.
  async push(entry) { console.info('[vista:fixture] would sync', entry); return { ok: true }; }
};

// Live mode: the Vista API (same shapes as the fixtures, so the screens don't change).
const apiAdapter = {
  name: 'api', snap: null,
  async crews() { return []; },
  async load() { const s = await api.snapshot(); apiAdapter.snap = s; return { jobs: s.jobs, draws: s.draws, cases: s.cases }; },
  async rollout() { return apiAdapter.snap?.rollout || (await db.meta('rollout')) || { defaultMode: 'off' }; },
  async translations() { return apiAdapter.snap?.translations || (await db.meta('translations')) || { pairs: [] }; },
  // One outbox entry -> POST /sync. Rule refusals (4xx) are dropped and reported; network/5xx retry later.
  async push(entry) {
    if (entry.kind === 'photo.upload') return uploadPhoto(entry.payload);
    try {
      const [r] = (await api.sync([{ id: `${deviceId()}:${entry.seq}`, kind: entry.kind, payload: entry.payload }])).results;
      if (r.ok) return { ok: true };
      if (r.status && r.status < 500) return { ok: true, rejected: r.error };
      return { ok: false };
    } catch (e) { return { ok: false, error: e }; }
  }
};

// Outbox 'photo.upload': sign, PUT to storage, mark done. Runs before the pay request that lists the photo.
async function uploadPhoto({ key, workOrderId }) {
  const p = await db.get('photos', key);
  if (!p || p.uploaded) return { ok: true };
  try {
    const { uploads } = await api.signPhotos(workOrderId, [key]);
    await api.putPhoto(uploads[0].url, p.blob);
    await db.put('photos', { ...p, uploaded: true });
    return { ok: true };
  } catch (e) { return e.status && e.status < 500 && e.status !== 401 ? { ok: true, rejected: e.message } : { ok: false, error: e }; }
}

export const adapter = apiMode ? apiAdapter : fixtureAdapter;

export async function seedIfNeeded(crew) {
  if (adapter.name === 'api') {
    // Live: refresh from Salesforce whenever online; keep the outbox and local checklist progress.
    if (!navigator.onLine) return;
    const { jobs, draws, cases } = await adapter.load(crew);
    // Pay requests made on this phone that haven't reached Salesforce yet stay on screen until they do.
    const waiting = new Set((await db.all('outbox')).map(e => e.payload?.localId).filter(Boolean));
    const local = (await db.all('draws')).filter(d => d._local && waiting.has(d.Id));
    const localCases = (await db.all('cases')).filter(c => c._local && waiting.has(c.Id));
    await Promise.all([db.clear('jobs'), db.clear('draws'), db.clear('cases')]);
    await db.putAll('jobs', jobs); await db.putAll('draws', [...local, ...draws]); await db.putAll('cases', [...localCases, ...cases]);
    await db.meta('rollout', adapter.snap.rollout); await db.meta('translations', adapter.snap.translations);
    await db.meta('photoUrls', adapter.snap.photoUrls || {});
    return;
  }
  const seeded = await db.meta('seeded');
  if (seeded === crew.id + ':v3') return;
  const { jobs, draws, cases } = await adapter.load(crew);
  await Promise.all([db.clear('jobs'), db.clear('draws'), db.clear('cases'), db.clear('checklist'), db.clear('outbox')]);
  await db.putAll('jobs', jobs); await db.putAll('draws', draws); await db.putAll('cases', cases);
  // Demo: what the last person did (started jobs, ticked items, submitted pay) carries over to the next one,
  // so switching from an installer to Mike shows the request waiting for review.
  const carry = await db.meta('demoCarry');
  if (carry) {
    const ids = new Set(jobs.map(j => j.Id));
    await db.putAll('jobs', carry.jobs.filter(j => ids.has(j.Id)));
    await db.putAll('draws', carry.draws.filter(d => ids.has(d.Work_Order__c)));
    const jobNos = new Set(jobs.map(j => j.Job_Number__c));
    await db.putAll('cases', (carry.cases || []).filter(c => jobNos.has(c.Job__c)));
    await db.putAll('checklist', carry.checklist);
    await db.meta('demoCarry', null);
  }
  await db.meta('seeded', crew.id + ':v3');
}

export async function checklistFor(trade) {
  const res = await fetch(`./content/checklists/${trade}.json`);
  return res.ok ? res.json() : null;
}

// --- Salesforce shapes → what the screens need -------------------------------------------
export const drawsFor = (draws, workOrderId) =>
  draws.filter(d => d.Work_Order__c === workOrderId && !d.TEST_SA__c).sort((a, b) => b.CreatedDate.localeCompare(a.CreatedDate));
export const casesFor = (cases, w) => cases.filter(c => c.Job__c && c.Job__c === w.Job_Number__c);

// What the phone shows. Salesforce statuses are unchanged from today:
//   New (installer submitted, waiting on PM) -> Submitted (PM submitted) -> Approved -> payable invoice linked (Paid).
// A PM send-back keeps the record at New; the decision lives in the manifest.
// Sent back and not yet resubmitted. A resubmit can only follow the send-back it answers, so the same timestamp
// (two steps in one millisecond) counts as resubmitted.
export const isSentBack = m => m?.approval?.decision === 'sent_back' && !(m.resubmitted_at >= m.approval.at);
export function drawStatus(d) {
  if (d.Payable_Invoice_New__c || d.Paycheck_Period__c) return 'Paid';
  if ((d.Status__c || 'New') === 'New') {
    const m = manifestOf(d);
    return isSentBack(m) ? 'SentBack' : 'WithPM';
  }
  return d.Status__c;
}
export const drawAmount = d => d.Amount__c || 0;
export function manifestOf(d) {
  const raw = d[MANIFEST_FIELD] || '';
  const i = raw.indexOf(MANIFEST_MARK);
  if (i < 0) return null;
  try { return JSON.parse(raw.slice(i + MANIFEST_MARK.length)); } catch { return null; }
}
export const photoCount = d => manifestOf(d)?.photos?.length || 0;
export const isDraw = d => d.Did_you_complete_the_job_or_service__c === 'No' || manifestOf(d)?.kind === 'draw';

// --- Program board (payroll's view of every Vista pay request) -----------------------------------
// Stages, in the order money moves: withPm -> (sentBack -> withPm) -> approved -> paid. Draws are issued
// already approved by a PM, so they go straight to approved/paid. ctx carries what the caller resolved:
// { wo, homeowner, office, crew, pmUserId, pmName }.
export function boardRow(d, ctx = {}, now = new Date()) {
  const m = manifestOf(d) || {}, status = drawStatus(d);
  const stage = status === 'Paid' ? 'paid' : isDraw(d) ? 'approved' : ({ WithPM: 'withPm', SentBack: 'sentBack', Approved: 'approved' }[status] || 'other');
  const since = (stage === 'withPm' && m.resubmitted_at) || (stage === 'sentBack' && m.approval?.at) || m.submitted_at || d.CreatedDate;
  return {
    id: d.Id, name: d.Name, amount: drawAmount(d), kind: isDraw(d) ? 'draw' : 'pay', stage,
    since, hours: since ? Math.max(0, Math.round((now - new Date(since)) / 36e5)) : null,
    approvedAt: stage === 'approved' || stage === 'paid' ? (m.approval?.decision === 'submitted' ? m.approval.at : m.issued_at || m.submitted_at || d.CreatedDate) : null,
    approver: d.Approver__c || m.approval?.by || null, missed: (m.approval?.decision === 'sent_back' ? m.approval.missed || [] : []).map(x => x.text),
    photos: (m.photos || []).length, channel: m.channel || 'app', ...ctx
  };
}
// The daily ACH cutoff: 10:00 AM Eastern, Monday to Friday. Anything approved before it is on that day's run.
// -> { open: true, minutesLeft } before the cutoff on a weekday, else { open: false, next: 'tomorrow'|'monday' }.
export function cutoffInfo(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .formatToParts(now).map(x => [x.type, x.value]));
  const mins = Number(p.hour) * 60 + Number(p.minute), weekend = p.weekday === 'Sat' || p.weekday === 'Sun';
  if (!weekend && mins < 600) return { open: true, minutesLeft: 600 - mins };
  return { open: false, next: weekend || p.weekday === 'Fri' ? 'monday' : 'tomorrow' };
}
// Per PM: how many requests wait on them, the total, and the oldest (for nudges before the 10 AM cutoff).
export function boardByPm(rows) {
  const out = new Map();
  for (const r of rows.filter(x => x.stage === 'withPm')) {
    const k = r.pmUserId || r.pmName || '?';
    const e = out.get(k) || { pmUserId: r.pmUserId, pmName: r.pmName, count: 0, total: 0, oldestHours: 0 };
    e.count++; e.total += r.amount; e.oldestHours = Math.max(e.oldestHours, r.hours || 0); out.set(k, e);
  }
  return [...out.values()].sort((a, b) => b.oldestHours - a.oldestHours);
}

// Draw eligibility: PM judgment, optionally narrowed by content/draw-rules.json.
export async function drawRules() {
  try { return await (await fetch('./content/draw-rules.json')).json(); } catch { return {}; }
}
export function drawEligible(w, rules = {}) {
  const v = w.ServiceAppointment;
  if (!v || !['Dispatched', 'In Progress'].includes(v.Status)) return { ok: false, why: 'notActive' };
  if (rules.minContract && contractAmount(w) < rules.minContract) return { ok: false, why: 'contract' };
  if (rules.trades?.length && !rules.trades.includes(tradeKey(w))) return { ok: false, why: 'trade' };
  if (remaining(w) <= 0) return { ok: false, why: 'nothingLeft' };
  return { ok: true };
}
export const remaining = w => contractAmount(w) - laborDrawn(w);

export const contractAmount = w => w.Job_Number__r?.Sales_Price__c || 0;
export const laborDrawn = w => w.Job_Number__r?.Total_SA_Expense_Labor__c || 0;
export const pmOf = w => w.Job_Number__r?.Production_Manager__r || null;

// Trade key for checklists, from WorkType.Name / Work_Type_Name__c / Job Product_type__c.
export function tradeKey(w) {
  const n = (w.WorkType?.Name || w.Work_Type_Name__c || w.Job_Number__r?.Product_type__c || w._trade || '').toLowerCase();
  if (n.startsWith('window') || n.startsWith('door')) return 'windows';
  if (n.startsWith('siding')) return 'siding';
  if (n.startsWith('gutter')) return 'gutters';
  if (n.startsWith('bath')) return 'bath';
  if (n.startsWith('roof')) return 'roofing';
  return w._trade || 'windows';
}

// --- Field Service gating -----------------------------------------------------------------
// Dispatch is the gate: nothing reaches the installer until the ServiceAppointment is Dispatched
// (which is also what fires the PulseM bio). See docs/approval-flow.md.
export const SA_VISIBLE = new Set(['Dispatched', 'In Progress', 'Completed']);
export const visit = w => w.ServiceAppointment || null;
export const isVisible = w => { const v = visit(w); return !!v && SA_VISIBLE.has(v.Status) && (v.Status !== 'Completed' || sameLocalDay(w.StartDate)); };
// Measure techs see measurement visits only; installers never see them. PMs see everything dispatched.
export const isMeasurementVisit = w => visit(w)?.SS_Service_Appointment_Type__c === 'Measurement';
// Rollout: a visit is on Vista only if Vista is on for its job's office (Location) and the crew's account.
export const officeOf = w => w.Job_Number__r?.Office__r || null;
export const onVista = (ctx, w) => vistaOn(ctx.rollout, officeOf(w), ctx.role === 'pm' ? w._account : ctx.account);
// Assignment: installers and measure techs only see visits assigned to them (AssignedResource -> their
// ServiceResource; `_crew` in fixtures). PMs see every visit at their locations.
export const assignedTo = (ctx, w) => ctx.role === 'pm' || !ctx.crewId || w._crew === ctx.crewId;
export const visibleFor = ctx => w => isVisible(w) && assignedTo(ctx, w) && onVista(ctx, w) &&
  (ctx.role === 'pm' || (ctx.role === 'measure') === isMeasurementVisit(w));
const sameLocalDay = iso => easternDay(iso) === easternDay(new Date());

// --- PM review: the deliverables checklist -------------------------------------------------
// Every required line must be ticked to approve. Unticked lines are "what was missed".
export function reviewLines(draw, w, checklist) {
  const m = manifestOf(draw) || {};
  const count = k => (m.photos || []).filter(p => p.kind === k).length;
  const lines = [];
  for (const p of checklist?.photos || []) {
    if (!p.min) continue;
    const have = count(p.kind);
    lines.push({ id: 'photo:' + p.kind, kind: 'photo', label: p, have, need: p.min, ok: have >= p.min, required: true });
  }
  const total = checklist?.steps?.length || 0, done = (m.checklist?.done || []).length;
  lines.push({ id: 'checklist', kind: 'checklist', have: done, need: total, ok: done >= total, required: true });
  lines.push({ id: 'scope', kind: 'scope', ok: true, required: true, text: draw.Description_of_Work_Performed__c || '' });
  lines.push({ id: 'complete', kind: 'complete', ok: true, required: true, value: draw.Did_you_complete_the_job_or_service__c || 'No' });
  const items = (w.WorkOrderLineItems || []).filter(li => li.Status !== 'Canceled');
  if (items.length) {
    const doneItems = items.filter(li => li.Status === WOLI_DONE.Installation).length;
    lines.push({ id: 'lineItems', kind: 'lineItems', have: doneItems, need: items.length, ok: doneItems === items.length, required: true });
  }
  const room = contractAmount(w) ? remaining(w) : null;
  lines.push({ id: 'amount', kind: 'amount', amount: drawAmount(draw), room, ok: room == null || drawAmount(draw) <= room, required: true });
  if (draw.Additional_Work_Performed__c === 'Yes') lines.push({ id: 'additional', kind: 'additional', ok: !!m.additional_work?.note, required: true });
  return lines;
}
// PM queue: installer pay requests at New that the PM hasn't sent back (or that the installer has resubmitted).
// Draws never enter the queue: the PM issues and submits them in one step.
export const pendingReview = draws => draws.filter(d => d.Type__c === 'Vista' && !d.TEST_SA__c && !isDraw(d) && drawStatus(d) === 'WithPM');

// --- Work order line items -----------------------------------------------------------------
// The installer (installation visits) and measure tech (measurement visits) own line-item completion.
export const WOLI_DONE = { Installation: 'Installation Completed', Measurement: 'Measurement Completed' };
export const visitKind = w => (visit(w)?.SS_Service_Appointment_Type__c === 'Measurement' ? 'Measurement' : 'Installation');
