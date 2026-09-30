// Who is texting / signing in. A phone number maps to one person:
//   { id, phone, name, role: 'installer'|'measure'|'pm'|'admin' (payroll/program admin), userId?, serviceResourceIds[], account{Id,Name},
//     lang: 'en'|'es'|'bi', channel: 'app'|'text'|'both', requested?, disabled? }
// First looked up in Vista's store (admins can add or correct people there), otherwise found in Salesforce
// by phone and cached. Nothing is written to Salesforce.
import { SOQL, SOSL } from './soql.mjs';

export function createPeople({ store, sf }) {
  const save = async p => {
    await store.put({ pk: `PERSON#${p.phone}`, sk: 'PROFILE', ...p });
    await store.put({ pk: `PERSONID#${p.id}`, sk: 'PHONE', phone: p.phone });
    for (const r of p.serviceResourceIds || []) await store.put({ pk: `RES#${r}`, sk: 'PHONE', phone: p.phone });
    if (p.userId) await store.put({ pk: `USER#${p.userId}`, sk: 'PHONE', phone: p.phone });
    await store.put({ pk: 'PEOPLE', sk: p.phone, id: p.id, role: p.role, channel: p.channel || 'both', name: p.name });
    return p;
  };
  const strip = item => { if (!item) return null; const { pk, sk, ...p } = item; return p; };
  const byPhone = async phone => strip(await store.get(`PERSON#${phone}`, 'PROFILE'));
  const via = async (pk) => { const x = await store.get(pk, 'PHONE'); return x ? byPhone(x.phone) : null; };

  async function fromSalesforce(phone) {
    if (!sf) return null;
    const digits = phone.replace(/^\+1/, '');
    const hits = await sf.search(SOSL.userByPhone(digits));
    const user = hits.find(u => (u.MobilePhone || '').replace(/\D/g, '').endsWith(digits));
    if (!user) return null;
    const resources = await sf.query(SOQL.resourcesOfUser(user.Id));
    const pmJobs = await sf.query(SOQL.pmOpenJob(user.Id));
    let role = pmJobs.length && !resources.length ? 'pm' : 'installer';
    if (pmJobs.length && resources.length) role = 'pm';
    if (role === 'installer' && resources.length) {
      const types = await sf.query(SOQL.recentVisitTypes(resources.map(r => r.Id)));
      if (types.length && types.every(x => x.ServiceAppointment?.SS_Service_Appointment_Type__c === 'Measurement')) role = 'measure';
    }
    return save({
      id: resources[0] ? `res:${resources[0].Id}` : `user:${user.Id}`, phone, name: user.Name, role, userId: user.Id,
      serviceResourceIds: resources.map(r => r.Id), account: resources[0]?.AccountId ? { Id: resources[0].AccountId, Name: resources[0].Account?.Name || resources[0].Name } : null,
      lang: String(user.LanguageLocaleKey || '').startsWith('es') ? 'es' : 'en', channel: 'both', source: 'salesforce'
    });
  }

  return {
    byPhone: async phone => (await byPhone(phone)) || fromSalesforce(phone),
    byId: id => via(`PERSONID#${id}`),
    byResource: id => via(`RES#${id}`),
    byUser: id => via(`USER#${id}`),
    save,
    async update(p, patch) { return save({ ...p, ...patch }); },
    async list() { return Promise.all((await store.query('PEOPLE')).map(x => byPhone(x.sk))).then(xs => xs.filter(Boolean)); }
  };
}

// Shape the engine and the app use for a person (same as the fixture crews).
export const asCrew = p => p && ({ id: p.id, name: p.name, role: p.role, lang: p.lang || 'en', channel: p.channel || 'both', requested: p.requested || null,
  lead: { name: p.name, phone: p.phone }, account: p.account || null, members: [p.name], branch: '' });
