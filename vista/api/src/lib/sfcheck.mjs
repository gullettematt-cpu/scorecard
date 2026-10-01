// Check Salesforce: a read-only test that Vista's Salesforce side is ready, run before a pilot and after any
// Salesforce change. It never creates, changes or deletes a record.
//   1. Every query Vista runs (lib/soql.mjs), with Ids that match nothing: proves every field and relationship
//      name exists and the user running it can read them.
//   2. Every field Vista writes (WRITES below): exists, and the user can create/edit it; every picklist value
//      Vista writes is in the picklist; the Service Case record type is available.
//   3. Setup: the two Vista flows exist and are active; the Vista list views exist.
// Run as the integration user in AWS (`vista-admin.sh check-salesforce`) or with the sf CLI
// (`node scripts/check-salesforce.mjs`, as whoever that alias is).
import { SOQL, SOSL, SAMPLES, PURPOSE } from './soql.mjs';
import { domain, MANIFEST_FIELD, CASE_PICKLISTS, SERVICE_RECORD_TYPE } from './shared.mjs';

// Every Salesforce write in lib/actions.mjs and the heartbeat. The fake Salesforce in the tests refuses any
// field not listed here, so this list can't fall behind the code.
export const WRITES = {
  ServiceAppointment: { update: ['Status', 'ActualStartTime', 'ActualEndTime'], values: { Status: ['In Progress', 'Completed'] } },
  WorkOrderLineItem: { update: ['Status'], values: { Status: Object.values(domain.WOLI_DONE) } },
  SA_Expense__c: {
    create: ['Type__c', 'Status__c', 'Expense_Type__c', 'Amount__c', 'Date__c', 'Work_Performed_Date__c', 'Work_Order__c', 'Job__c',
      'Service_Appointment__c', 'Account__c', 'Production_Manager__c', 'Did_you_complete_the_job_or_service__c', 'Additional_Work_Performed__c',
      'Description_of_Work_Performed__c', MANIFEST_FIELD, 'TEST_SA__c', 'Approver__c'],
    update: [MANIFEST_FIELD, 'Description_of_Work_Performed__c', 'Status__c', 'Approver__c'],
    delete: true, // the heartbeat removes its previous test record
    values: { Type__c: ['Vista'], Status__c: ['New', 'Approved'], Expense_Type__c: ['Labour'],
      Did_you_complete_the_job_or_service__c: ['Yes', 'No'], Additional_Work_Performed__c: ['Yes', 'No'] }
  },
  Case: {
    create: ['RecordTypeId', 'Status', 'Origin', 'Priority', 'Job__c', 'Service_Appointment__c', 'AccountId', 'ContactId', 'Subject', 'Description',
      'Service_Issue__c', 'Work_Type__c', 'Service_Type__c', 'Warranty_Type__c', 'Language', 'Original_Installer__c', 'Test_record__c'],
    values: { Status: ['New'], Origin: ['In-Person'], Priority: ['High', 'Medium'], Language: ['en_US', 'es_MX'], ...CASE_PICKLISTS },
    recordType: SERVICE_RECORD_TYPE
  }
};
export const FLOWS = ['Vista_Pay_Request_Submitted', 'Vista_Draw_Issued_Notice'];
export const LIST_VIEWS = ['Vista_Waiting_on_PM', 'Vista_Draws', 'Vista_Submitted_Not_Invoiced'];

// "fail" = Vista will break; "warn" = a setup step still to do, or worth a look.
// Salesforce's error, made readable: the message out of its JSON, with the usual causes named.
const FIELD_SERVICE = ['ServiceAppointment', 'AssignedResource', 'ServiceResource', 'WorkType', 'WorkOrderLineItem', 'WorkOrder'];
export function short(err) {
  let s = String(err?.message || err).replace(/^Salesforce [^:]+ failed \(\d+\): /, '').replace(/^Salesforce [^:]+: /, '');
  try { const j = JSON.parse(s); const m = Array.isArray(j) ? j[0]?.message : j?.message || j?.error_description; if (m) s = m; } catch {}
  s = s.replace(/\s+/g, ' ').trim();
  const obj = s.match(/sObject type '(\w+)' is not supported/)?.[1];
  if (obj) return `the integration user can't see ${obj}${FIELD_SERVICE.includes(obj) ? ' (needs a Field Service permission set license)' : ' (object access or license)'}`;
  const col = s.match(/No such column '(\w+)' on entity '(\w+)'/);
  if (col) return `the integration user can't see ${col[2]}.${col[1]}${/Service_Appointment__c|ServiceAppointment/.test(col[1]) ? ' (it points to Service Appointment: needs a Field Service permission set license)' : ' (field-level security, or the field is missing)'}`;
  const rel = s.match(/Didn't understand relationship '(\w+)'/)?.[1];
  if (rel) return `the integration user can't follow ${rel}${FIELD_SERVICE.includes(rel) ? ' (needs a Field Service permission set license)' : ' (field-level security on the lookup)'}`;
  return s.slice(0, 300);
}
const limitOne = q => q.replace(/\s+LIMIT \d+\s*$/, '') + ' LIMIT 1';
const pool = async (items, n, fn) => { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } })); return out; };

export async function checkSalesforce({ sf }) {
  const results = [];
  const add = (section, name, status, detail = '') => results.push({ section, name, status, detail });

  try { await sf.auth?.(); } catch (err) { add('login', 'Log in', 'fail', short(err)); return summarize(results); }

  // 1. Reads
  await pool(Object.keys(SOQL), 4, async name => {
    const label = `${PURPOSE[name] || name} (${name})`;
    try { await sf.query(limitOne(SOQL[name](...SAMPLES[name]))); add('reads', label, 'ok'); } catch (err) { add('reads', label, 'fail', short(err)); }
  });
  const who = `${PURPOSE.userByPhone} (userByPhone)`;
  try { await sf.search(SOSL.userByPhone(...SAMPLES.userByPhone)); add('reads', who, 'ok'); } catch (err) { add('reads', who, 'fail', short(err)); }

  // 2. Writes (describe only)
  await pool(Object.entries(WRITES), 4, async ([obj, spec]) => {
    let d; try { d = await sf.describe(obj); } catch (err) { add('writes', obj, 'fail', `can't describe: ${short(err)}`); return; }
    const byName = new Map(d.fields.map(f => [f.name, f]));
    const problems = [], warnings = [];
    if (spec.create && !d.createable) problems.push('user can\'t create records');
    if (spec.update && !d.updateable) problems.push('user can\'t edit records');
    if (spec.delete && !d.deletable) warnings.push('user can\'t delete records (the health check leaves its test records behind)');
    for (const [need, list] of [['createable', spec.create || []], ['updateable', spec.update || []]]) {
      for (const f of list) {
        const field = byName.get(f);
        if (!field) problems.push(`${f} missing (or not visible to this user${/Service_Appointment/.test(f) ? ': it points to Service Appointment, which needs a Field Service permission set license' : ''})`);
        else if (!field[need]) problems.push(`${f} not ${need === 'createable' ? 'settable on create' : 'editable'}`);
      }
    }
    for (const [f, values] of Object.entries(spec.values || {})) {
      const field = byName.get(f);
      if (!field || !['picklist', 'multipicklist'].includes(field.type)) continue;
      const active = new Set((field.picklistValues || []).filter(v => v.active).map(v => v.value));
      const missing = values.filter(v => !active.has(v));
      if (missing.length) (field.restrictedPicklist ? problems : warnings).push(`${f} has no picklist value ${missing.map(v => `"${v}"`).join(', ')}`);
    }
    if (spec.recordType) {
      const rt = (d.recordTypeInfos || []).find(r => String(r.recordTypeId).slice(0, 15) === spec.recordType.slice(0, 15));
      if (!rt) problems.push(`record type ${spec.recordType} not found`);
      else if (!rt.available) problems.push(`record type "${rt.name}" not available to this user`);
    }
    add('writes', obj, problems.length ? 'fail' : warnings.length ? 'warn' : 'ok', [...problems, ...warnings].join('; '));
  });

  // 3. Setup
  try {
    const flows = await sf.query(`SELECT ApiName, IsActive FROM FlowDefinitionView WHERE ApiName IN ('${FLOWS.join("','")}')`);
    for (const f of FLOWS) {
      const row = flows.find(x => x.ApiName === f);
      add('setup', `Flow ${f}`, row?.IsActive ? 'ok' : 'warn', !row ? 'not deployed' : row.IsActive ? '' : 'deployed but not active');
    }
  } catch (err) { add('setup', 'Flows', 'warn', `couldn't read flows (${short(err)}); check them in Setup`); }
  try {
    const views = await sf.query(`SELECT DeveloperName FROM ListView WHERE SobjectType = 'SA_Expense__c' AND DeveloperName IN ('${LIST_VIEWS.join("','")}')`);
    for (const v of LIST_VIEWS) add('setup', `List view ${v}`, views.some(x => x.DeveloperName === v) ? 'ok' : 'warn', views.some(x => x.DeveloperName === v) ? '' : 'not deployed');
  } catch (err) { add('setup', 'List views', 'warn', `couldn't read list views (${short(err)})`); }

  return summarize(results);
}

const ORDER = { login: 0, reads: 1, writes: 2, setup: 3 };
function summarize(results) {
  results.sort((a, b) => ORDER[a.section] - ORDER[b.section] || a.name.localeCompare(b.name));
  const count = s => results.filter(r => r.status === s).length;
  return { ok: !count('fail'), failed: count('fail'), warnings: count('warn'), passed: count('ok'), results, at: new Date().toISOString() };
}

// Plain-text report for the terminal.
export function formatReport(r) {
  const mark = { ok: '✓', warn: '!', fail: '✗' };
  const title = { login: 'Log in', reads: 'Queries Vista runs', writes: 'Fields Vista writes', setup: 'Salesforce setup' };
  const lines = [];
  for (const section of Object.keys(ORDER)) {
    const rows = r.results.filter(x => x.section === section);
    if (!rows.length) continue;
    lines.push('', title[section]);
    for (const x of rows) lines.push(`  ${mark[x.status]} ${x.name}${x.detail ? ` — ${x.detail}` : ''}`);
  }
  lines.push('', r.ok ? `Ready: ${r.passed} passed, ${r.warnings} to look at.` : `NOT ready: ${r.failed} failed, ${r.warnings} to look at, ${r.passed} passed.`);
  return lines.join('\n');
}
