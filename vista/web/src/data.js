// The only module that knows where data comes from.
// Step 1: fixtures. Step 2: swap `adapter` for one that calls /sf/* — same shapes, same API names.
import { db } from './db.js';

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
      _job: fx.jobs.find(j => j.Id === w._assumed?.Job__c) || null
    }));
    const draws = fx.draws.map(d => ({ ...d, CreatedDate: dayOff(d.CreatedDate_dayOffset || 0), _crew: crew.id }));
    const cases = fx.cases.map(c => ({ ...c, CreatedDate: dayOff(c.CreatedDate_dayOffset || 0), _crew: crew.id }));
    return { jobs, draws, cases };
  },
  // Outbox entries are just logged in fixture mode. Step 2 posts them to /sf/*.
  async push(entry) { console.info('[vista:fixture] would sync', entry); return { ok: true }; }
};

export const adapter = fixtureAdapter;

export async function seedIfNeeded(crew) {
  const seeded = await db.meta('seeded');
  if (seeded === crew.id) return;
  const { jobs, draws, cases } = await adapter.load(crew);
  await Promise.all([db.clear('jobs'), db.clear('draws'), db.clear('cases'), db.clear('checklist'), db.clear('outbox')]);
  await db.putAll('jobs', jobs); await db.putAll('draws', draws); await db.putAll('cases', cases);
  await db.meta('seeded', crew.id);
}

export async function checklistFor(trade) {
  const res = await fetch(`./content/checklists/${trade}.json`);
  return res.ok ? res.json() : null;
}

// Draws for a job. Uses the assumed link field; the salesforce adapter will normalize whichever exists.
export const drawsFor = (draws, jobId) => draws.filter(d => d._assumed?.Work_Order__c === jobId).sort((a, b) => b.CreatedDate.localeCompare(a.CreatedDate));
export const casesFor = (cases, jobId) => cases.filter(c => c._assumed?.Work_Order__c === jobId);
export const drawStatus = d => d._assumed?.Status__c || 'Submitted';
export const drawAmount = d => d._assumed?.Amount__c || 0;
export const jobLink = w => w._assumed?.Job__c || null;
export const contractAmount = w => w._job?._assumed?.Contract_Amount__c || 0;
