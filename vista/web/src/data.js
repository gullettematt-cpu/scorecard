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
    const fx = await (await fetch(`./fixtures/${crew.fixture}`)).json();
    const jobs = fx.workOrders.map(w => ({
      ...w,
      StartDate: dayAt(w._schedule.dayOffset, w._schedule.startHour),
      EndDate: dayAt(w._schedule.dayOffset, w._schedule.endHour),
      LastModifiedDate: new Date().toISOString(),
      _crew: crew.id, _trade: crew.trade,
      Job_Number__r: fx.jobs.find(j => j.Id === w.Job_Number__c) || null
    }));
    const draws = fx.draws.map(d => ({ ...d, CreatedDate: dayOff(d.CreatedDate_dayOffset || 0), Date__c: dayOff(d.CreatedDate_dayOffset || 0).slice(0, 10), _crew: crew.id }));
    const cases = fx.cases.map(c => ({ ...c, CreatedDate: dayOff(c.CreatedDate_dayOffset || 0), _crew: crew.id }));
    return { jobs, draws, cases };
  },
  // Outbox entries are just logged in fixture mode. Step 2 posts them to /sf/*.
  async push(entry) { console.info('[vista:fixture] would sync', entry); return { ok: true }; }
};

export const adapter = fixtureAdapter;

export async function seedIfNeeded(crew) {
  const seeded = await db.meta('seeded');
  if (seeded === crew.id + ':v2') return;
  const { jobs, draws, cases } = await adapter.load(crew);
  await Promise.all([db.clear('jobs'), db.clear('draws'), db.clear('cases'), db.clear('checklist'), db.clear('outbox')]);
  await db.putAll('jobs', jobs); await db.putAll('draws', draws); await db.putAll('cases', cases);
  await db.meta('seeded', crew.id + ':v2');
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

// WorkOrder.Status values installers act on (confirmed picklist; there is no "In Progress").
export const WO_SCHEDULED = 'Installation Scheduled';
export const WO_INSTALLED = 'Installation Completed';
export const WO_HIDDEN = new Set(['Completed', 'Canceled']);
