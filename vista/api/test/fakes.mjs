// Test doubles: a Salesforce that answers the API's queries from the app's fixture data, plus
// fake texting, photo storage and Claude. Everything the API does can run offline.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { memoryStore } from '../src/lib/store.mjs';
import { createPeople } from '../src/lib/people.mjs';
import { createTranslations } from '../src/lib/vi.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const J = f => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const at = (day, hour) => { const d = new Date(); d.setHours(hour, 0, 0, 0); d.setDate(d.getDate() + day); return d.toISOString(); };

export const PEOPLE = {
  tucker: { id: 'res:0HnTUCK', phone: '+17065550112', name: 'Dwayne Tucker', role: 'installer', userId: '005TUCK', serviceResourceIds: ['0HnTUCK'], account: { Id: '0015e00000TUCK1', Name: 'Tucker Installs LLC' }, lang: 'en', channel: 'both' },
  luis: { id: 'res:0HnHERN', phone: '+17065550107', name: 'Luis Hernández', role: 'installer', userId: '005HERN', serviceResourceIds: ['0HnHERN'], account: { Id: '0015e00000HERN7', Name: 'Hernández Siding' }, lang: 'es', channel: 'both' },
  rafael: { id: 'res:0HnORTE', phone: '+17065550133', name: 'Rafael Ortega', role: 'measure', userId: '005ORTE', serviceResourceIds: ['0HnORTE'], account: { Id: '0015e00000ORTE3', Name: 'Rafael Ortega' }, lang: 'es', channel: 'both' },
  mike: { id: 'user:005MIKE', phone: '+17065550100', name: 'Mike Duncan', role: 'pm', userId: '005MIKE', serviceResourceIds: [], account: null, lang: 'en', channel: 'both' }
};
const RES = { 'crew-12.json': PEOPLE.tucker, 'crew-7.json': PEOPLE.luis, 'measure-3.json': PEOPLE.rafael };

// Salesforce-shaped records built from web/fixtures.
export function salesforceWorld() {
  const w = { ServiceAppointment: [], WorkOrder: [], WorkOrderLineItem: [], SA_Expense__c: [], Case: [], AssignedResource: [] };
  for (const [file, crew] of Object.entries(RES)) {
    const fx = J(`web/fixtures/${file}`);
    for (const wo of fx.workOrders) {
      const job = fx.jobs.find(j => j.Id === wo.Job_Number__c);
      const sa = wo.ServiceAppointment;
      w.ServiceAppointment.push({ Id: sa.Id, AppointmentNumber: sa.AppointmentNumber, Status: sa.Status, SchedStartTime: at(wo._schedule.dayOffset, wo._schedule.startHour), SchedEndTime: at(wo._schedule.dayOffset, wo._schedule.endHour),
        SS_Service_Appointment_Type__c: sa.SS_Service_Appointment_Type__c, PulseM_Bio_Sent__c: sa.PulseM_Bio_Sent__c, SMS_Opt_out__c: false, Work_Order__c: wo.Id, Job__c: job.Id, Test_SA__c: false,
        ServiceResources: { records: [{ ServiceResourceId: crew.serviceResourceIds[0], ServiceResource: { Name: crew.name, AccountId: crew.account.Id, Account: { Name: crew.account.Name } }, Lead_Installer__c: true }] } });
      w.AssignedResource.push({ ServiceAppointmentId: sa.Id, ServiceResourceId: crew.serviceResourceIds[0], Lead_Installer__c: true });
      const lines = wo.WorkOrderLineItems.map(li => ({ ...li, WorkOrderId: wo.Id }));
      w.WorkOrderLineItem.push(...lines);
      w.WorkOrder.push({ Id: wo.Id, WorkOrderNumber: wo.WorkOrderNumber, Subject: wo.Subject, Status: wo.Status, Priority: wo.Priority, Street: wo.Street, City: wo.City, State: wo.State, PostalCode: wo.PostalCode,
        Latitude: wo.Latitude, Longitude: wo.Longitude, Description: wo.Description, CaseId: wo.CaseId, RecordType: wo.RecordType, Account: wo.Account, Contact: wo.Contact, AccountId: wo.Account?.Id, ContactId: wo.Contact?.Id, WorkType: wo.WorkType,
        Work_Type_Name__c: wo.Work_Type_Name__c, Job_Number__c: job.Id,
        Job_Number__r: { Name: job.Name, Sales_Price__c: job.Sales_Price__c, Total_SA_Expense_Labor__c: job.Total_SA_Expense_Labor__c, Product_type__c: job.Product_type__c,
          Office__c: job.Office__r.Id, Office__r: job.Office__r, Production_Manager__c: PEOPLE.mike.userId, Production_Manager__r: { Name: PEOPLE.mike.name, MobilePhone: PEOPLE.mike.phone } } });
    }
    for (const d of fx.draws) {
      const { CreatedDate_dayOffset, _crew, _lang, ...rest } = d;
      w.SA_Expense__c.push({ ...rest, CreatedDate: at(CreatedDate_dayOffset || 0, 9), Production_Manager__c: PEOPLE.mike.userId, Service_Appointment__c: rest.Service_Appointment__c || fx.workOrders.find(x => x.Id === d.Work_Order__c)?.ServiceAppointment.Id });
    }
    for (const c of fx.cases) { const { CreatedDate_dayOffset, ...rest } = c; w.Case.push({ ...rest, CreatedDate: at(0, 9) }); }
  }
  return w;
}

const ids = (soql, field) => { const m = soql.match(new RegExp(`${field} IN \\(([^)]*)\\)`)); return m ? m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')) : []; };
const val = (soql, field) => soql.match(new RegExp(`${field} = '([^']*)'`))?.[1];

export function fakeSalesforce(world = salesforceWorld()) {
  const log = { creates: [], updates: [], deletes: [], queries: [] };
  let n = 0, authFail = false;
  const withLines = wo => ({ ...wo, WorkOrderLineItems: { records: world.WorkOrderLineItem.filter(li => li.WorkOrderId === wo.Id) } });
  const withRel = d => ({ ...d, Work_Order__r: (wo => wo && { WorkOrderNumber: wo.WorkOrderNumber, Account: wo.Account, Street: wo.Street })(world.WorkOrder.find(x => x.Id === d.Work_Order__c)),
    Service_Appointment__r: { SMS_Opt_out__c: false } });
  const sf = {
    world, log, failAuth: v => { authFail = v; },
    async auth() { if (authFail) throw new Error('invalid_grant'); return { access_token: 't', instance_url: 'https://x' }; },
    async search() { return []; },
    async query(soql) {
      if (authFail) throw new Error('invalid_grant');
      log.queries.push(soql);
      if (/FROM AssignedResource WHERE ServiceResourceId IN/.test(soql)) { const r = ids(soql, 'ServiceResourceId'); return world.AssignedResource.filter(a => r.includes(a.ServiceResourceId)); }
      if (/FROM AssignedResource WHERE ServiceAppointmentId IN/.test(soql)) { const s = ids(soql, 'ServiceAppointmentId'); return world.AssignedResource.filter(a => s.includes(a.ServiceAppointmentId)); }
      if (/FROM ServiceAppointment WHERE Id IN/.test(soql)) { const s = ids(soql, 'Id'); return world.ServiceAppointment.filter(x => s.includes(x.Id)); }
      if (/FROM ServiceAppointment WHERE Work_Order__r.Job_Number__r.Production_Manager__c/.test(soql)) return world.ServiceAppointment.filter(() => val(soql, 'Production_Manager__c') === PEOPLE.mike.userId);
      if (/FROM ServiceAppointment WHERE Status = 'Dispatched'/.test(soql)) return world.ServiceAppointment.filter(x => x.Status === 'Dispatched').map(x => ({ ...x, Work_Order__r: world.WorkOrder.find(w => w.Id === x.Work_Order__c) }));
      if (/FROM WorkOrder WHERE Id IN/.test(soql)) { const s = ids(soql, 'Id'); return world.WorkOrder.filter(x => s.includes(x.Id)).map(withLines); }
      if (/FROM WorkOrder/.test(soql)) return world.WorkOrder.slice(0, 1);
      if (/FROM SA_Expense__c WHERE Work_Order__c IN/.test(soql)) { const s = ids(soql, 'Work_Order__c'); return world.SA_Expense__c.filter(x => s.includes(x.Work_Order__c) && !x.TEST_SA__c); }
      if (/FROM SA_Expense__c WHERE Type__c = 'Vista' AND Status__c = 'New'/.test(soql)) return world.SA_Expense__c.filter(x => x.Type__c === 'Vista' && x.Status__c === 'New' && !x.TEST_SA__c && x.Did_you_complete_the_job_or_service__c === 'Yes').map(withRel);
      if (/FROM Case WHERE Job__c IN/.test(soql)) { const s = ids(soql, 'Job__c'); return world.Case.filter(x => s.includes(x.Job__c)); }
      throw new Error(`fake Salesforce has no answer for: ${soql.slice(0, 120)}`);
    },
    async create(sobject, fields) {
      if (authFail) throw new Error('invalid_grant');
      const id = `a0X${String(++n).padStart(12, '0')}`; log.creates.push({ sobject, id, fields });
      (world[sobject] ||= []).push({ Id: id, Name: `SA-${9200 + n}`, CreatedDate: new Date().toISOString(), ...fields });
      return id;
    },
    async update(sobject, id, fields) {
      log.updates.push({ sobject, id, fields });
      const rec = (world[sobject] || []).find(r => r.Id === id); if (!rec) throw Object.assign(new Error(`no ${sobject} ${id}`), { status: 404 });
      Object.assign(rec, fields);
    },
    async del(sobject, id) { log.deletes.push({ sobject, id }); world[sobject] = (world[sobject] || []).filter(r => r.Id !== id); }
  };
  return sf;
}

export function fakeTwilio() { const sent = [], deleted = []; return { sent, deleted, async send(to, body) { sent.push({ to, body }); return 'SM' + sent.length; }, async fetchMedia(url) { return { body: Buffer.from('jpeg:' + url), contentType: 'image/jpeg' }; }, async deleteMedia(url) { deleted.push(url); return true; } }; }
export function fakePhotos() { const objects = new Map(); return { objects, bucket: 'test', async signPut(key) { return `https://s3.test/${key}?sig`; }, async signGet(key) { return `https://s3.test/${key}?get`; }, async put(key, body) { objects.set(key, body); }, async head(key) { if (!objects.has(key)) throw new Error('404'); } }; }
export function fakeVi() {
  const calls = { ask: [], translate: [] };
  const pairs = new Map(J('web/fixtures/translations.json').pairs.flatMap(p => [[p.en, p], [p.es, p]]));
  return { calls,
    async ask(a) { calls.ask.push(a); return a.viLanguage ? `(Vi in ${a.viLanguage})` : a.lang === 'es' ? '(respuesta de Vi)' : '(Vi answer)'; },
    async translate(texts) { calls.translate.push(texts); return texts.map(t => pairs.get(t) || { en: t, es: `[es] ${t}`, src: 'en' }); } };
}

export async function testDeps({ now } = {}) {
  const store = memoryStore(), sf = fakeSalesforce(), twilio = fakeTwilio(), photos = fakePhotos(), vi = fakeVi();
  const people = createPeople({ store, sf: null });
  for (const p of Object.values(PEOPLE)) await people.save(p);
  await store.put({ pk: 'CONFIG', sk: 'ROLLOUT', rollout: { defaultMode: 'off', locations: { Augusta: { mode: 'on', pilotAccounts: [], optOutAccounts: [] } } } });
  return { sf, store, people, twilio, photos, vi, translations: createTranslations({ store, vi }), now,
    secrets: { jwt: 'test-jwt-secret', admin: 'test-admin', twilioAuthToken: 'twilio-token' },
    config: { appUrl: 'https://vista.test', publicApiUrl: 'https://api.test', alertPhones: ['+17065550001', '+17065550100'], adminPhones: ['+17065550001'] } };
}
