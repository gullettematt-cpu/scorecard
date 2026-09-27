// The only module that knows where data comes from.
// Step 1: fixtures. Step 2: swap `adapter` for one that calls /sf/* — same shapes, same API names.
// Field names below are confirmed against docs/describe/SUMMARY.md (myorg, 2026-09-27).
import { db } from './db.js';

export const MANIFEST_FIELD = 'Additional_Work_Performed_Description__c';
export const MANIFEST_MARK = '<!--vista-manifest-->';

const dayAt = (offset, hour) => { const d = new Date(); d.setHours(hour, 0, 0, 0); d.setDate(d.getDate() + offset); return d.toISOString(); };
const dayOff = offset => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toISOString(); };

const fixtureAdapter = {
  name: 'fixture',
  async crews() { return (await fetch('./fixtures/crews.json')).json(); },
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
        _crew: owner.id, _crewName: owner.name, _trade: owner.trade, _lang: owner.lang,
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

// Status__c has no "Paid"; paid is derived (open decision #2 in the data contract).
export const drawStatus = d => (d.Paycheck_Period__c || d.Payable_Invoice_New__c) ? 'Paid' : (d.Status__c || 'New');
export const drawAmount = d => d.Amount__c || 0;
export function manifestOf(d) {
  const raw = d[MANIFEST_FIELD] || '';
  const i = raw.indexOf(MANIFEST_MARK);
  if (i < 0) return null;
  try { return JSON.parse(raw.slice(i + MANIFEST_MARK.length)); } catch { return null; }
}
export const photoCount = d => manifestOf(d)?.photos?.length || 0;

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
  const room = contractAmount(w) ? contractAmount(w) - laborDrawn(w) : null;
  lines.push({ id: 'amount', kind: 'amount', amount: drawAmount(draw), room, ok: room == null || drawAmount(draw) <= room, required: true });
  if (draw.Additional_Work_Performed__c === 'Yes') lines.push({ id: 'additional', kind: 'additional', ok: !!m.additional_work?.note, required: true });
  return lines;
}
export const pendingReview = draws => draws.filter(d => d.Type__c === 'Vista' && d.Status__c === 'Submitted' && !d.TEST_SA__c);
