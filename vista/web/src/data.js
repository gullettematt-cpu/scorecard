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

export const MANIFEST_FIELD = 'Additional_Work_Performed_Description__c';
export const MANIFEST_MARK = '<!--vista-manifest-->';

const dayAt = (offset, hour) => { const d = new Date(); d.setHours(hour, 0, 0, 0); d.setDate(d.getDate() + offset); return d.toISOString(); };
const dayOff = offset => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toISOString(); };

const fixtureAdapter = {
  name: 'fixture',
  async crews() { return (await fetch('./fixtures/crews.json')).json(); },
  async rollout() { return (await fetch('./fixtures/rollout.json')).json(); },
  async load(crew) {
    const crews = await this.crews();
    const files = crew.fixtures || [crew.fixture];
    const out = { jobs: [], draws: [], cases: [] };
    for (const file of files) {
      const owner = crews.find(c => c.fixture === file) || crew;
      const fx = await (await fetch(`./fixtures/${file}`)).json();
      out.jobs.push(...fx.workOrders.map(w => ({
        ...w,
        StartDate: dayAt(w._schedule.dayOffset, w._schedule.startHour),
        EndDate: dayAt(w._schedule.dayOffset, w._schedule.endHour),
        LastModifiedDate: new Date().toISOString(),
        _crew: owner.id, _crewName: owner.name, _trade: owner.trade, _lang: owner.lang, _account: owner.account || null,
        Job_Number__r: fx.jobs.find(j => j.Id === w.Job_Number__c) || null
      })));
      out.draws.push(...fx.draws.map(d => ({ ...d, CreatedDate: dayOff(d.CreatedDate_dayOffset || 0), Date__c: dayOff(d.CreatedDate_dayOffset || 0).slice(0, 10), _crew: owner.id, _lang: owner.lang })));
      out.cases.push(...fx.cases.map(c => ({ ...c, CreatedDate: dayOff(c.CreatedDate_dayOffset || 0), _crew: owner.id })));
    }
    return out;
  },
  // Outbox entries are just logged in fixture mode. Step 2 posts them to /sf/*.
  async push(entry) { console.info('[vista:fixture] would sync', entry); return { ok: true }; }
};

export const adapter = fixtureAdapter;

export async function seedIfNeeded(crew) {
  const seeded = await db.meta('seeded');
  if (seeded === crew.id + ':v3') return;
  const { jobs, draws, cases } = await adapter.load(crew);
  await Promise.all([db.clear('jobs'), db.clear('draws'), db.clear('cases'), db.clear('checklist'), db.clear('outbox')]);
  await db.putAll('jobs', jobs); await db.putAll('draws', draws); await db.putAll('cases', cases);
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
export function drawStatus(d) {
  if (d.Payable_Invoice_New__c || d.Paycheck_Period__c) return 'Paid';
  if ((d.Status__c || 'New') === 'New') {
    const m = manifestOf(d);
    return m?.approval?.decision === 'sent_back' && !(m.resubmitted_at > m.approval.at) ? 'SentBack' : 'WithPM';
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
const sameLocalDay = iso => new Date(iso).toDateString() === new Date().toDateString();

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
