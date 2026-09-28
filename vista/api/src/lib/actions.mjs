// Performs the actions the app's outbox and the text engine produce, as Salesforce writes.
// The server re-checks every rule; nothing from the phone is trusted blindly:
//   - you can only touch visits assigned to you (installers, measure techs) or jobs you're PM on (PMs)
//   - approval is refused while any deliverable is short (photo minimums, checklist, line items)
//   - amounts can't exceed the contract minus labor already paid; draws follow draw-rules.json
//   - Vista only ever writes the statuses the design allows (see docs/approval-flow.md)
import { domain, checklists, drawRules, readManifest, writeManifest, MANIFEST_FIELD } from './shared.mjs';
import { photoKey } from './photos.mjs';

export class ActionError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now); // YYYY-MM-DD, Eastern

export function createActions({ sf, store, photos, twilio, people, adminPhones = [], now = () => new Date() }) {
  const need = (cond, msg, status = 403) => { if (!cond) throw new ActionError(msg, status); };

  async function importPhotos(list, job, sa, imported) {
    const out = [];
    for (const [i, p] of (list || []).entries()) {
      if (p.key) { need(p.key.startsWith(`vista/${job.Id}/`), 'photo belongs to another job'); out.push({ kind: p.kind, key: p.key, taken_at: p.taken_at }); continue; }
      if (p.source && twilio) {
        const media = await twilio.fetchMedia(p.source);
        const key = photoKey({ workOrderId: job.Id, serviceAppointmentId: sa?.Id, kind: p.kind, n: i + 1, at: now() });
        await photos.put(key, media.body, media.contentType);
        out.push({ kind: p.kind, key, bytes: media.body.length, channel: 'sms' });
        imported.push(p.source);
        continue;
      }
      out.push({ kind: p.kind });
    }
    return out;
  }

  // snapshot: this person's loadSnapshot() result; person: from people.byPhone / token
  return async function perform(person, snap, action) {
    // Picture messages are copied to S3 first; once Salesforce has the record, they're deleted from Twilio
    // so homeowners' photos don't sit with the text provider. If the write fails they stay for the retry.
    const imported = [];
    const result = await run(person, snap, action, imported);
    for (const url of imported) await twilio.deleteMedia?.(url).catch(err => console.warn('twilio media delete failed', err.message));
    return result;
  };

  async function run(person, snap, action, imported) {
    const { kind, payload: p = {} } = action;
    const job = id => snap.jobs.find(j => j.Id === id);
    const jobOfVisit = id => snap.jobs.find(j => j.ServiceAppointment?.Id === id);
    const expense = id => snap.draws.find(d => d.Id === id);
    const field = person.role === 'installer' || person.role === 'measure';
    const pm = person.role === 'pm';

    switch (kind) {
      case 'serviceappointment.start': {
        const w = jobOfVisit(p.serviceAppointmentId); need(field && w, 'not your visit');
        need(w.ServiceAppointment.Status === 'Dispatched', 'visit is not dispatched', 409);
        await sf.update('ServiceAppointment', w.ServiceAppointment.Id, { Status: 'In Progress', ActualStartTime: now().toISOString() });
        w.ServiceAppointment.Status = 'In Progress'; // later actions in the same batch see it
        return { ok: true };
      }
      case 'serviceappointment.complete': {
        const w = jobOfVisit(p.serviceAppointmentId); need(person.role === 'measure' && w, 'not your visit');
        const open = (w.WorkOrderLineItems || []).filter(li => li.Status !== 'Canceled' && li.Status !== domain.WOLI_DONE.Measurement);
        need(!open.length, 'line items still to measure', 409);
        await sf.update('ServiceAppointment', w.ServiceAppointment.Id, { Status: 'Completed', ActualEndTime: now().toISOString() });
        w.ServiceAppointment.Status = 'Completed';
        return { ok: true };
      }
      case 'woli.status': {
        const w = snap.jobs.find(j => (j.WorkOrderLineItems || []).some(li => li.Id === p.workOrderLineItemId));
        need(field && w, 'not your line item');
        const allowed = person.role === 'measure' ? domain.WOLI_DONE.Measurement : domain.WOLI_DONE.Installation;
        const li = w.WorkOrderLineItems.find(x => x.Id === p.workOrderLineItemId);
        const target = p.Status === allowed ? allowed : null;
        need(target || p.Status === li.Status, `line items can only be set to ${allowed} here`);
        if (target) { await sf.update('WorkOrderLineItem', li.Id, { Status: target }); li.Status = target; }
        return { ok: true };
      }
      case 'payrequest.create': {
        const w = job(p.workOrderId); need(person.role === 'installer' && w, 'not your job');
        const sa = w.ServiceAppointment; need(sa.Status === 'In Progress' || sa.Status === 'Completed', 'start the visit first', 409);
        const amount = Math.round(Number(p.Amount__c));
        need(amount > 0 && (!domain.contractAmount(w) || amount <= domain.remaining(w)), 'amount over the contract', 422);
        const m = { ...(p.manifest || {}), v: 1, app: 'vista', kind: 'completion', submitted_at: now().toISOString(), submitted_by: { phone: person.phone, name: person.name } };
        m.photos = await importPhotos(m.photos, w, sa, imported);
        const cl = checklists[domain.tradeKey(w)];
        for (const req of (cl?.photos || []).filter(x => x.min > 0)) need(m.photos.filter(x => x.kind === req.kind).length >= req.min, `no photos, no pay: ${req.en}`, 422);
        const id = await sf.create('SA_Expense__c', {
          Type__c: 'Vista', Status__c: 'New', Expense_Type__c: 'Labour', Amount__c: amount, Date__c: today(now()), Work_Performed_Date__c: today(now()),
          Work_Order__c: w.Id, Job__c: w.Job_Number__c, Service_Appointment__c: sa.Id, Account__c: w._account?.Id || person.account?.Id,
          Production_Manager__c: w.Job_Number__r?.Production_Manager__c, Did_you_complete_the_job_or_service__c: 'Yes', Additional_Work_Performed__c: m.additional_work?.performed ? 'Yes' : 'No',
          Description_of_Work_Performed__c: String(p.description || p.Description_of_Work_Performed__c || '').slice(0, 32000),
          [MANIFEST_FIELD]: writeManifest(m, m.additional_work?.note || ''), TEST_SA__c: false
        });
        snap.draws.unshift({ Id: id, Type__c: 'Vista', Status__c: 'New', Amount__c: amount, Work_Order__c: w.Id, Did_you_complete_the_job_or_service__c: 'Yes', [MANIFEST_FIELD]: writeManifest(m) });
        return { ok: true, id };
      }
      case 'payrequest.resubmit': {
        const d = expense(p.expenseId); need(person.role === 'installer' && d && job(d.Work_Order__c), 'not your pay request');
        need(d.Status__c === 'New', 'already submitted', 409);
        const w = job(d.Work_Order__c), m = readManifest(d[MANIFEST_FIELD]);
        const added = await importPhotos((p.manifest?.photos || []).filter(x => !(m.photos || []).some(y => y.key && y.key === x.key)), w, w.ServiceAppointment, imported);
        const next = { ...m, ...(p.manifest?.checklist ? { checklist: p.manifest.checklist } : {}), photos: [...(m.photos || []), ...added], resubmitted_at: now().toISOString() };
        await sf.update('SA_Expense__c', d.Id, { [MANIFEST_FIELD]: writeManifest(next), ...(p.description ? { Description_of_Work_Performed__c: String(p.description).slice(0, 32000) } : {}) });
        return { ok: true };
      }
      case 'payrequest.approve': {
        const d = expense(p.expenseId); need(pm && d, 'not your job');
        need(d.Type__c === 'Vista' && d.Status__c === 'New' && d.Did_you_complete_the_job_or_service__c === 'Yes', 'not a pay request waiting for review', 409);
        const w = job(d.Work_Order__c);
        const short = domain.reviewLines(d, w, checklists[domain.tradeKey(w)]).filter(l => !l.ok);
        need(!short.length, `can't approve: ${short.map(l => l.id).join(', ')} short`, 422);
        const m = readManifest(d[MANIFEST_FIELD]);
        const approval = { ...(p.approval || {}), by: person.name, at: now().toISOString(), decision: 'submitted', missed: [] };
        // Same result as the Titan approval process's final approval: Approved + Approver (First Last).
        await sf.update('SA_Expense__c', d.Id, { Status__c: 'Approved', Approver__c: person.name, [MANIFEST_FIELD]: writeManifest({ ...m, approval }) });
        return { ok: true };
      }
      case 'payrequest.sendBack': {
        const d = expense(p.expenseId); need(pm && d && d.Status__c === 'New', 'not a pay request waiting for review');
        const m = readManifest(d[MANIFEST_FIELD]);
        const approval = { ...(p.approval || {}), by: person.name, at: now().toISOString(), decision: 'sent_back' };
        need((approval.missed || []).length, 'say what is missing');
        await sf.update('SA_Expense__c', d.Id, { [MANIFEST_FIELD]: writeManifest({ ...m, approval }) });
        return { ok: true };
      }
      case 'draw.issue': {
        const w = job(p.workOrderId); need(pm && w, 'not your job');
        const elig = domain.drawEligible(w, drawRules); need(elig.ok, `no draw: ${elig.why}`, 422);
        const needPhotos = drawRules.requireProgressPhotos ?? 1; need((w._progressPhotos || 0) >= needPhotos, 'no draw without progress photos', 422);
        const amount = Math.round(Number(p.Amount__c)); need(amount > 0 && amount <= domain.remaining(w), 'amount over the contract', 422);
        const m = { v: 1, app: 'vista', kind: 'draw', issued_by: person.name, requested_by: String(p.requested_by || ''), issued_at: now().toISOString(),
          photos: (w._progressKeys || []).map(key => ({ kind: 'progress', key })) };
        const id = await sf.create('SA_Expense__c', {
          Type__c: 'Vista', Status__c: 'Approved', Approver__c: person.name, Expense_Type__c: 'Labour', Amount__c: amount, Date__c: today(now()),
          Work_Order__c: w.Id, Job__c: w.Job_Number__c, Service_Appointment__c: w.ServiceAppointment?.Id, Account__c: w._account?.Id,
          Production_Manager__c: w.Job_Number__r?.Production_Manager__c, Did_you_complete_the_job_or_service__c: 'No',
          Description_of_Work_Performed__c: String(p.covers || '').slice(0, 32000), [MANIFEST_FIELD]: writeManifest(m), TEST_SA__c: false
        });
        return { ok: true, id }; // Salesforce flow "Vista - Draw Issued Notice" emails Mike Duncan
      }
      case 'checklist':
        need(field && job(p.workOrderId), 'not your job');
        await store.put({ pk: `CHECKLIST#${p.workOrderId}`, sk: 'DONE', checklistId: p.checklistId, done: p.done || [], by: person.id, at: now().toISOString() });
        return { ok: true };
      case 'progress.photo': {
        const w = job(p.workOrderId); need(field && w, 'not your job'); need(String(p.key || '').startsWith(`vista/${w.Id}/`), 'bad photo key');
        await store.put({ pk: `PROGRESS#${w.Id}`, sk: `PHOTO#${p.key}`, key: p.key, by: person.id, at: now().toISOString() });
        return { ok: true };
      }
      case 'person.prefs':
      case 'person.channel': {
        const patch = {};
        if (['en', 'es', 'bi'].includes(p.lang)) patch.lang = p.lang;
        if (['app', 'text', 'both'].includes(p.channel)) patch.channel = p.channel;
        await people.update(person, patch);
        return { ok: true };
      }
      case 'language.request': {
        const language = String(p.language || '').slice(0, 60);
        need(language, 'which language?', 422);
        await people.update(person, { requested: language });
        await store.put({ pk: 'LANGREQ', sk: `${now().toISOString()}#${person.id}`, person: person.name, phone: person.phone, language });
        for (const a of adminPhones) await twilio?.send(a, `Vista: ${person.name} (${person.phone}) asked for Vista in ${language}.`).catch(() => {});
        return { ok: true };
      }
      case 'vi.ask':
        return { ok: true }; // answered in the conversation; nothing to write
      default:
        throw new ActionError(`unknown action ${kind}`);
    }
  }
}
