// One person's working set, loaded live from Salesforce and shaped exactly like the app's fixtures,
// so the app screens and the text engine run unchanged:
//   jobs  = WorkOrders, each with the visit (ServiceAppointment) that concerns this person
//   draws = SA_Expense__c on those WorkOrders (pay requests and draws)
//   cases = open Cases on their Jobs
//   people = this person plus the PMs and crews on those jobs (for notices)
import { lit, inList } from './salesforce.mjs';
import { asCrew } from './people.mjs';

const SA_FIELDS = `Id, AppointmentNumber, Status, SchedStartTime, SchedEndTime, ActualStartTime, SS_Service_Appointment_Type__c,
  PulseM_Bio_Sent__c, SMS_Opt_out__c, Work_Order__c, Job__c,
  (SELECT ServiceResourceId, ServiceResource.Name, ServiceResource.AccountId, ServiceResource.Account.Name, Lead_Installer__c FROM ServiceResources)`;
const WO_FIELDS = `Id, WorkOrderNumber, Subject, Status, Priority, Street, City, State, PostalCode, Latitude, Longitude, Description, CaseId, AccountId, ContactId,
  RecordType.Name, Account.Name, Contact.Phone, Contact.MobilePhone, WorkType.Name, Work_Type_Name__c, Job_Number__c,
  Job_Number__r.Name, Job_Number__r.Sales_Price__c, Job_Number__r.Total_SA_Expense_Labor__c, Job_Number__r.Product_type__c,
  Job_Number__r.Office__c, Job_Number__r.Office__r.Name, Job_Number__r.Production_Manager__c,
  Job_Number__r.Production_Manager__r.Name, Job_Number__r.Production_Manager__r.MobilePhone,
  (SELECT Id, LineItemNumber, Description, Quantity, Status FROM WorkOrderLineItems ORDER BY LineItemNumber)`;
export const EXPENSE_FIELDS = `Id, Name, CreatedDate, Date__c, Type__c, Status__c, Amount__c, Work_Order__c, Job__c, Service_Appointment__c,
  Did_you_complete_the_job_or_service__c, Additional_Work_Performed__c, Description_of_Work_Performed__c,
  Additional_Work_Performed_Description__c, Approver__c, TEST_SA__c, Paycheck_Period__c, Payable_Invoice_New__c`;
const WINDOW = 'SchedStartTime >= YESTERDAY AND SchedStartTime <= NEXT_N_DAYS:7';

// The visit that matters for a work order: in progress, then today's dispatched, then the earliest.
function pickVisit(sas) {
  const rank = s => (s.Status === 'In Progress' ? 0 : s.Status === 'Dispatched' ? 1 : s.Status === 'Completed' ? 2 : 3);
  return [...sas].sort((a, b) => rank(a) - rank(b) || String(a.SchedStartTime).localeCompare(String(b.SchedStartTime)))[0];
}
const strip = r => { if (!r || typeof r !== 'object') return r; const { attributes, ...rest } = r; for (const k of Object.keys(rest)) if (rest[k] && typeof rest[k] === 'object' && !Array.isArray(rest[k])) rest[k] = strip(rest[k]); return rest; };

export async function loadSnapshot({ sf, people, store, person }) {
  // 1. Visits
  let sas = [];
  if (person.role === 'pm') {
    sas = await sf.query(`SELECT ${SA_FIELDS} FROM ServiceAppointment WHERE Work_Order__r.Job_Number__r.Production_Manager__c = ${lit(person.userId)} AND ${WINDOW} AND Test_SA__c = false`);
  } else if (person.serviceResourceIds?.length) {
    const ars = await sf.query(`SELECT ServiceAppointmentId FROM AssignedResource WHERE ServiceResourceId IN ${inList(person.serviceResourceIds)} AND ServiceAppointment.SchedStartTime >= YESTERDAY AND ServiceAppointment.SchedStartTime <= NEXT_N_DAYS:7`);
    if (ars.length) sas = await sf.query(`SELECT ${SA_FIELDS} FROM ServiceAppointment WHERE Id IN ${inList([...new Set(ars.map(a => a.ServiceAppointmentId))])} AND Test_SA__c = false`);
  }
  const woIds = [...new Set(sas.map(s => s.Work_Order__c).filter(Boolean))];
  if (!woIds.length) return { jobs: [], draws: [], cases: [], people: [asCrew(person)] };

  // 2. Work orders, pay, problems
  const [wos, expenses] = await Promise.all([
    sf.query(`SELECT ${WO_FIELDS} FROM WorkOrder WHERE Id IN ${inList(woIds)}`),
    sf.query(`SELECT ${EXPENSE_FIELDS} FROM SA_Expense__c WHERE Work_Order__c IN ${inList(woIds)} AND TEST_SA__c = false ORDER BY CreatedDate DESC`)
  ]);
  const jobIds = [...new Set(wos.map(w => w.Job_Number__c).filter(Boolean))];
  const cases = jobIds.length ? await sf.query(`SELECT Id, CaseNumber, Subject, Status, CreatedDate, Job__c, Work_Type__c, Service_Type__c, Warranty_Type__c, Priority, Description FROM Case WHERE Job__c IN ${inList(jobIds)} AND IsClosed = false`) : [];

  // 3. Crews and PMs on these jobs (people Vista knows, for notices and their language)
  const peopleOut = new Map([[person.id, asCrew(person)]]);
  const crewFor = async resId => {
    const p = resId && await people.byResource(resId);
    if (p) peopleOut.set(p.id, asCrew(p));
    return p;
  };

  const jobs = [];
  for (const w0 of wos) {
    const w = strip(w0);
    const visit = pickVisit(sas.filter(s => s.Work_Order__c === w.Id));
    const assigned = (visit.ServiceResources?.records || []);
    const lead = assigned.find(a => a.Lead_Installer__c) || assigned[0];
    const crew = person.role === 'pm' ? await crewFor(lead?.ServiceResourceId) : person;
    const pmUser = w.Job_Number__r?.Production_Manager__c;
    if (pmUser && pmUser !== person.userId) { const pm = await people.byUser(pmUser); if (pm) peopleOut.set(pm.id, asCrew(pm)); }
    const progress = await store.query(`PROGRESS#${w.Id}`, 'PHOTO#');
    jobs.push({
      ...w,
      WorkOrderLineItems: (w0.WorkOrderLineItems?.records || []).map(strip),
      ServiceAppointment: { Id: visit.Id, AppointmentNumber: visit.AppointmentNumber, Status: visit.Status, SS_Service_Appointment_Type__c: visit.SS_Service_Appointment_Type__c,
        PulseM_Bio_Sent__c: visit.PulseM_Bio_Sent__c, SMS_Opt_out__c: visit.SMS_Opt_out__c, Lead_Installer: lead?.ServiceResource?.Name || '' },
      StartDate: visit.SchedStartTime, EndDate: visit.SchedEndTime,
      _crew: crew ? crew.id : lead ? `res:${lead.ServiceResourceId}` : null,
      _crewName: crew?.name || lead?.ServiceResource?.Name || '',
      _account: lead?.ServiceResource?.AccountId ? { Id: lead.ServiceResource.AccountId, Name: lead.ServiceResource.Account?.Name || '' } : (person.role !== 'pm' ? person.account : null),
      _lang: crew?.lang || 'en',
      _progressPhotos: progress.length,
      _progressKeys: progress.map(p => p.key)
    });
  }
  const crewOf = woId => jobs.find(j => j.Id === woId);
  const draws = expenses.map(strip).map(d => ({ ...d, _crew: crewOf(d.Work_Order__c)?._crew, _lang: crewOf(d.Work_Order__c)?._lang }));
  // Cases: keep the photo keys from Vista's footer, not the whole description.
  const caseOut = cases.map(strip).map(({ Description, ...c }) => ({ ...c, _photos: (String(Description || '').match(/Vista photos: (.+)/)?.[1] || '').split(' ').filter(Boolean) }));
  return { jobs, draws, cases: caseOut, people: [...peopleOut.values()] };
}

// Every free-text string a person may read in their snapshot (for the translation cache).
export const freeTexts = snap => [
  ...snap.jobs.flatMap(j => [j.Subject, j.Description, ...(j.WorkOrderLineItems || []).map(li => li.Description)]),
  ...snap.draws.map(d => d.Description_of_Work_Performed__c),
  ...snap.cases.map(c => c.Subject)
].filter(Boolean);
