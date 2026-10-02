// The Vista Integration permission set, worked out from what Vista actually does: every field named in
// lib/soql.mjs (selected, filtered on, or reached through a relationship) gets Read, and every field in
// sfcheck's WRITES gets Edit. Built against the org's own describe, so it only lists fields that exist and
// can carry field-level security (required and system fields are always visible and can't be listed).
// Used by scripts/sf-integration-user.mjs. Nothing here talks to Salesforce directly.
import { SOQL, SOSL, SAMPLES } from './soql.mjs';
import { WRITES } from './sfcheck.mjs';

// Objects the permission set grants. Anything else a query passes through (RecordType, User) needs no grant.
export const OBJECTS = ['SA_Expense__c', 'Case', 'ServiceAppointment', 'WorkOrderLineItem', 'WorkOrder', 'AssignedResource',
  'ServiceResource', 'Job__c', 'Account', 'Contact', 'Location', 'WorkType'];
export const PERMSET = { name: 'Vista_Integration', label: 'Vista Integration' };

// The master object of a detail object (master-detail field), e.g. Job__c -> Opportunity. Salesforce requires Read on
// the master to read the detail, and the detail's visibility follows the master's sharing.
export const masterOf = desc => desc?.fields.find(f => f.type === 'reference' && f.relationshipOrder != null)?.referenceTo?.[0] || null;

const KEYWORDS = new Set(('SELECT FROM WHERE AND OR NOT IN LIMIT ORDER BY ASC DESC NULLS FIRST LAST TRUE FALSE NULL LIKE ' +
  'YESTERDAY TODAY TOMORROW NEXT_N_DAYS LAST_N_DAYS FIND RETURNING PHONE FIELDS ALL').split(' '));

// One SOQL statement -> [{ from, child?, tokens }]: the object (or child relationship) and every field path it names.
export function soqlRefs(soql) {
  const out = [];
  let text = String(soql), i;
  // Pull out subqueries "(SELECT ... FROM ChildRelationship)" first.
  while ((i = text.search(/\(\s*SELECT\b/i)) >= 0) {
    let depth = 0, j = i;
    for (; j < text.length; j++) { if (text[j] === '(') depth++; else if (text[j] === ')' && --depth === 0) break; }
    const inner = text.slice(i + 1, j);
    for (const r of soqlRefs(inner)) out.push({ ...r, child: true });
    text = text.slice(0, i) + text.slice(j + 1);
  }
  const clean = text.replace(/'(?:\\.|[^'\\])*'/g, ' ').replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, ' ');
  const from = clean.match(/\bFROM\s+(\w+)/i)?.[1];
  const tokens = (clean.match(/[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/g) || [])
    .filter(t => !KEYWORDS.has(t.toUpperCase()) && t !== from);
  out.unshift({ from, tokens: [...new Set(tokens)] });
  return out;
}

// Every read Vista makes, as [{ from, child?, tokens }], plus the SOSL User lookup.
export function vistaReads() {
  const reads = Object.keys(SOQL).flatMap(name => {
    const refs = soqlRefs(SOQL[name](...SAMPLES[name]));
    // A subquery's FROM is a child relationship of the outer object.
    return refs.map(r => r.child ? { ...r, parent: refs[0].from } : r);
  });
  const sosl = SOSL.userByPhone(...SAMPLES.userByPhone).match(/RETURNING\s+(\w+)\(([^)]*)\)/);
  if (sosl) reads.push({ from: sosl[1], tokens: (sosl[2].match(/[A-Za-z_]\w*/g) || []).filter(t => !KEYWORDS.has(t.toUpperCase())) });
  return reads;
}

// Build the plan. `describe(obj)` returns a Salesforce describe (cached by the caller); `sharing` maps object ->
// InternalSharingModel ('Private', 'Read', 'ReadWrite', 'ControlledByParent', ...), or null if unknown.
export async function planAccess({ describe, sharing = null }) {
  const read = new Map(), objects = new Set(), unresolved = [];
  const markRead = (obj, field) => { objects.add(obj); if (field) (read.get(obj) || read.set(obj, new Set()).get(obj)).add(field); };
  const d = async obj => { try { return await describe(obj); } catch { return null; } };

  for (const r of vistaReads()) {
    let base = r.from;
    if (r.parent) {
      const pd = await d(r.parent);
      base = pd?.childRelationships?.find(c => c.relationshipName === r.from)?.childSObject;
      if (!base) { unresolved.push(`${r.parent}.${r.from}`); continue; }
    }
    markRead(base);
    for (const path of r.tokens) {
      const parts = path.split('.');
      let obj = base, ok = true;
      for (const rel of parts.slice(0, -1)) {
        const f = (await d(obj))?.fields.find(x => x.relationshipName === rel);
        if (!f) { ok = false; break; }
        markRead(obj, f.name);
        obj = f.referenceTo?.[0];
        if (!obj) { ok = false; break; }
      }
      const last = parts[parts.length - 1];
      const f = ok && (await d(obj))?.fields.find(x => x.name === last);
      if (f) markRead(obj, f.name); else if (ok) unresolved.push(`${obj}.${last}`);
    }
  }

  // Masters of detail objects Vista uses: Read (and View All when private), no fields.
  const masters = new Map();
  for (const obj of [...OBJECTS]) { const m = masterOf(await d(obj)); if (m && !OBJECTS.includes(m) && (objects.has(obj) || WRITES[obj])) masters.set(m, obj); }

  const fieldPerms = new Map(); // "Obj.Field" -> { readable, editable }
  const objectPerms = new Map();
  const notes = [];
  for (const obj of OBJECTS) {
    const desc = await d(obj);
    const spec = WRITES[obj] || {};
    if (!desc) { if (objects.has(obj) || WRITES[obj]) notes.push(`${obj}: not found in this org, skipped`); continue; }
    if (!objects.has(obj) && !WRITES[obj]) continue;
    const model = sharing?.[obj] ?? null;
    const childOfParent = model === 'ControlledByParent';
    const p = { allowRead: true, allowCreate: !!spec.create, allowEdit: !!spec.update || !!spec.delete, allowDelete: !!spec.delete,
      viewAllRecords: !childOfParent && (model == null || /Private|None/i.test(model)), modifyAllRecords: false };
    objectPerms.set(obj, p);
    const byName = new Map(desc.fields.map(f => [f.name, f]));
    const writes = new Set([...(spec.create || []), ...(spec.update || [])]);
    for (const name of new Set([...(read.get(obj) || []), ...writes])) {
      // Parts of a compound field (Street, City, ... of Address) take their access from the compound field.
      const part = byName.get(name), f = part?.compoundFieldName ? byName.get(part.compoundFieldName) : part;
      if (!f || f.permissionable === false) continue;
      const editable = writes.has(name) && !f.calculated && !f.autoNumber && (f.createable || f.updateable);
      const key = `${obj}.${f.name}`, prev = fieldPerms.get(key);
      fieldPerms.set(key, { readable: true, editable: !!editable || !!prev?.editable });
    }
  }

  for (const [m, detail] of masters) {
    const model = sharing?.[m] ?? null;
    objectPerms.set(m, { allowRead: true, allowCreate: false, allowEdit: false, allowDelete: false, modifyAllRecords: false,
      viewAllRecords: model !== 'ControlledByParent' && (model == null || /Private|None/i.test(model)) });
    notes.push(`${m}: Read${objectPerms.get(m).viewAllRecords ? ' + View All' : ''}, because ${detail} is its detail record (no ${m} fields)`);
  }

  // Vista edits records it didn't create: visits (start, complete) and line items (their access follows the work
  // order). If sharing doesn't already allow that, Modify All is the only permission-set way to grant it.
  const needsEditAll = { ServiceAppointment: 'ServiceAppointment', WorkOrderLineItem: 'WorkOrder' };
  for (const [edited, holder] of Object.entries(needsEditAll)) {
    const model = sharing?.[holder];
    const p = objectPerms.get(holder);
    if (!p || model === 'ReadWrite' || model === 'FullAccess') continue;
    Object.assign(p, { allowRead: true, allowEdit: true, allowDelete: true, viewAllRecords: true, modifyAllRecords: true });
    notes.push(`${holder}: Modify All, because ${model ? `its sharing is "${model}"` : 'its sharing setting could not be read'} and Vista updates ${edited === holder ? 'visits' : 'line items'} other users own`);
  }
  // Record types Vista creates records with (Case: Service). A full-license user on a minimal profile only gets
  // them through the permission set.
  const recordTypes = [];
  for (const [obj, spec] of Object.entries(WRITES)) {
    if (!spec.recordType) continue;
    const rt = (await d(obj))?.recordTypeInfos?.find(r => String(r.recordTypeId).slice(0, 15) === spec.recordType.slice(0, 15));
    if (rt?.developerName) recordTypes.push(`${obj}.${rt.developerName}`);
    else notes.push(`${obj}: record type ${spec.recordType} not found, so it isn't added`);
  }
  return { objectPerms, fieldPerms, recordTypes, notes, unresolved: [...new Set(unresolved)] };
}

const x = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
// apiOnly: for a user on a full Salesforce license, block Salesforce logins (the integration profile already does).
// userPerms: extra system permissions, e.g. FieldServiceAccess (Field Service objects stay hidden without it, even with
// object access and a Field Service permission set license).
export function permissionSetXml({ objectPerms, fieldPerms, recordTypes = [] }, { apiOnly = false, userPerms = [] } = {}) {
  const fields = [...fieldPerms].sort(([a], [b]) => a.localeCompare(b)).map(([field, p]) =>
    `    <fieldPermissions>\n        <editable>${p.editable}</editable>\n        <field>${x(field)}</field>\n        <readable>${p.readable}</readable>\n    </fieldPermissions>`);
  const objs = [...objectPerms].sort(([a], [b]) => a.localeCompare(b)).map(([obj, p]) =>
    `    <objectPermissions>\n        <allowCreate>${p.allowCreate}</allowCreate>\n        <allowDelete>${p.allowDelete}</allowDelete>\n        <allowEdit>${p.allowEdit}</allowEdit>\n        <allowRead>${p.allowRead}</allowRead>\n        <modifyAllRecords>${p.modifyAllRecords}</modifyAllRecords>\n        <object>${x(obj)}</object>\n        <viewAllRecords>${p.viewAllRecords}</viewAllRecords>\n    </objectPermissions>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <description>Vista's integration user: read what Vista reads, write what Vista writes. Generated by scripts/sf-integration-user.mjs from vista/api/src/lib/soql.mjs and WRITES in sfcheck.mjs.</description>
${fields.join('\n')}
    <hasActivationRequired>false</hasActivationRequired>
    <label>${PERMSET.label}</label>
${objs.join('\n')}
${recordTypes.map(rt => `    <recordTypeVisibilities>\n        <recordType>${x(rt)}</recordType>\n        <visible>true</visible>\n    </recordTypeVisibilities>`).join('\n')}${recordTypes.length ? '\n' : ''}${(apiOnly || userPerms.length) ? [...(apiOnly ? ['ApiEnabled', 'ApiUserOnly'] : []), ...userPerms].sort().map(n => `    <userPermissions>\n        <enabled>true</enabled>\n        <name>${n}</name>\n    </userPermissions>`).join('\n') + '\n' : ''}</PermissionSet>
`;
}

export function summarize({ objectPerms, fieldPerms }) {
  const flags = p => ['allowRead', 'allowCreate', 'allowEdit', 'allowDelete', 'viewAllRecords', 'modifyAllRecords']
    .filter(k => p[k]).map(k => ({ allowRead: 'Read', allowCreate: 'Create', allowEdit: 'Edit', allowDelete: 'Delete', viewAllRecords: 'View All', modifyAllRecords: 'Modify All' })[k]).join(', ');
  return [...objectPerms].sort(([a], [b]) => a.localeCompare(b)).map(([obj, p]) => {
    const fs = [...fieldPerms].filter(([k]) => k.startsWith(obj + '.'));
    return `  ${obj.padEnd(20)} ${flags(p).padEnd(48)} ${fs.length} fields (${fs.filter(([, v]) => v.editable).length} editable)`;
  }).join('\n');
}
