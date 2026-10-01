// Sets up Vista's Salesforce integration user. Run it through salesforce/integration-user.sh, which adds the
// sandbox/production guard. Without --go it changes nothing: it shows the plan and validates the permission set.
//   1. Permission set "Vista Integration", built from your org's describe (lib/sfaccess.mjs): Read on every field
//      Vista reads, Edit on every field it writes, View All / Modify All only where sharing requires it.
//   2. User "Vista Integration" (license Salesforce Integration, profile Salesforce API Only System Integrations).
//   3. Its permission set licenses (Salesforce API Integration, Field Service Integration) and the permission set.
// Each step is skipped if it's already done, so it's safe to run again.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSalesforce, lit } from '../api/src/lib/salesforce.mjs';
import { planAccess, permissionSetXml, summarize, OBJECTS, PERMSET } from '../api/src/lib/sfaccess.mjs';

const args = process.argv.slice(2);
const opt = k => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const org = opt('--org') || 'DevSandi', GO = args.includes('--go');
const here = path.dirname(fileURLToPath(import.meta.url));
const sfcli = (a, inherit = false) => execFileSync('sf', a, { encoding: 'utf8', stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });

let info;
try { info = JSON.parse(sfcli(['org', 'display', '-o', org, '--json'])).result; }
catch { console.error(`No sf CLI session for "${org}". Log in with: sf org login web -a ${org}`); process.exit(2); }
const sf = createSalesforce({ token: { access_token: info.accessToken, instance_url: info.instanceUrl }, apiVersion: `v${info.apiVersion || '62.0'}` });
const one = async q => (await sf.query(q))[0];

const isSandbox = (await one('SELECT IsSandbox FROM Organization'))?.IsSandbox;
const username = opt('--username') || (isSandbox ? `vista@southernindustries.com.${org.toLowerCase()}` : 'vista@southernindustries.com.prod');
console.log(`Vista integration user · ${org} (${isSandbox ? 'sandbox' : 'PRODUCTION'}) · as ${info.username}\n${GO ? '' : 'Dry run: nothing will change.\n'}`);

// ---- 1. Permission set -----------------------------------------------------------------------------------
const cache = new Map();
const describe = obj => cache.get(obj) || cache.set(obj, sf.describe(obj)).get(obj);
let sharing = null;
try {
  const rows = await sf.query(`SELECT QualifiedApiName, InternalSharingModel FROM EntityDefinition WHERE QualifiedApiName IN ('${OBJECTS.join("','")}')`);
  sharing = Object.fromEntries(rows.map(r => [r.QualifiedApiName, r.InternalSharingModel]));
} catch (err) { console.log(`(Couldn't read sharing settings, so View All goes on every object: ${String(err.message).slice(0, 120)})`); }
const plan = await planAccess({ describe, sharing });
const xml = permissionSetXml(plan);

console.log(`1. Permission set "${PERMSET.label}" (${PERMSET.name})`);
console.log(summarize(plan));
for (const n of plan.notes) console.log(`  · ${n}`);
if (plan.unresolved.length) console.log(`  · Not found in this org (left out): ${plan.unresolved.join(', ')}`);
if (sharing) console.log(`  · Sharing: ${Object.entries(sharing).map(([k, v]) => `${k} ${v}`).join(' · ')}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vista-permset-'));
fs.copyFileSync(path.join(here, '../salesforce/sfdx-project.json'), path.join(tmp, 'sfdx-project.json'));
const psDir = path.join(tmp, 'force-app/main/default/permissionsets');
fs.mkdirSync(psDir, { recursive: true });
fs.writeFileSync(path.join(psDir, `${PERMSET.name}.permissionset-meta.xml`), xml);
const keep = path.join(here, '../salesforce/generated');
fs.mkdirSync(keep, { recursive: true });
fs.writeFileSync(path.join(keep, `${PERMSET.name}.permissionset-meta.xml`), xml);
console.log(`  · Full permission set: salesforce/generated/${PERMSET.name}.permissionset-meta.xml\n`);

// ---- 2. Licenses, profile, user --------------------------------------------------------------------------
const lic = await one(`SELECT Name, TotalLicenses, UsedLicenses FROM UserLicense WHERE Name = 'Salesforce Integration'`);
const profiles = await sf.query(`SELECT Id, Name FROM Profile WHERE UserLicense.Name = 'Salesforce Integration'`);
const profile = profiles.find(p => p.Name === 'Salesforce API Only System Integrations') || profiles[0];
const psls = await sf.query(`SELECT Id, MasterLabel, TotalLicenses, UsedLicenses FROM PermissionSetLicense WHERE MasterLabel IN ('Salesforce API Integration', 'Field Service Integration')`);
const me = await one(`SELECT Email FROM User WHERE Username = ${lit(info.username)}`);
let user = await one(`SELECT Id, IsActive, Profile.Name FROM User WHERE Username = ${lit(username)}`);

console.log(`2. User ${username}`);
console.log(`  · License "Salesforce Integration": ${lic ? `${lic.UsedLicenses} of ${lic.TotalLicenses} used` : 'NOT FOUND in this org'}`);
console.log(`  · Profile: ${profile ? profile.Name : 'NOT FOUND (needs the Salesforce Integration license)'}`);
console.log(`  · ${user ? `Already exists (${user.Profile?.Name}${user.IsActive ? '' : ', inactive'}), will be reused` : `Will be created: Vista Integration, email ${me?.Email}, Eastern time`}`);
console.log(`3. Permission set licenses: ${psls.map(p => `${p.MasterLabel} (${p.UsedLicenses}/${p.TotalLicenses} used)`).join(', ') || 'none found'}`);
if (!psls.some(p => p.MasterLabel === 'Field Service Integration')) console.log('  · No "Field Service Integration" license: if the permission set assignment fails on Work Order or Service Appointment, that is why.');
console.log('');

const problems = [];
if (!lic) problems.push('no Salesforce Integration user license');
else if (!user && lic.UsedLicenses >= lic.TotalLicenses) problems.push('no free Salesforce Integration license');
if (!profile) problems.push('no integration profile');

// ---- Validate or apply -----------------------------------------------------------------------------------
console.log(GO ? 'Deploying the permission set…' : 'Validating the permission set (dry run)…');
try { execFileSync('sf', ['project', 'deploy', 'start', '-o', org, '-d', 'force-app', ...(GO ? [] : ['--dry-run'])], { cwd: tmp, stdio: 'inherit', shell: process.platform === 'win32' }); }
catch { console.error('\nThe permission set did not deploy. Paste the error above to Claude; nothing else was changed.'); process.exit(1); }

if (!GO) {
  console.log(problems.length ? `\nFix first: ${problems.join('; ')}.` : '\nDry run OK. Re-run with --go to create it.');
  process.exit(problems.length ? 1 : 0);
}
if (problems.length) { console.error(`\nStopped after the permission set: ${problems.join('; ')}.`); process.exit(1); }

const step = async (label, fn) => { try { const r = await fn(); console.log(`✓ ${label}${r ? ` ${r}` : ''}`); } catch (err) { console.error(`✗ ${label}: ${String(err.message).slice(0, 400)}`); process.exit(1); } };
await step('User', async () => {
  if (user) return '(already there)';
  const id = await sf.create('User', { Username: username, FirstName: 'Vista', LastName: 'Integration', Alias: 'vista', Email: me?.Email,
    ProfileId: profile.Id, TimeZoneSidKey: 'America/New_York', LocaleSidKey: 'en_US', EmailEncodingKey: 'UTF-8', LanguageLocaleKey: 'en_US' });
  user = { Id: id };
  return `created (${id})`;
});
const have = new Set((await sf.query(`SELECT PermissionSetLicenseId FROM PermissionSetLicenseAssign WHERE AssigneeId = ${lit(user.Id)}`)).map(r => r.PermissionSetLicenseId));
for (const p of psls) await step(`License ${p.MasterLabel}`, async () => have.has(p.Id) ? '(already assigned)' : (await sf.create('PermissionSetLicenseAssign', { AssigneeId: user.Id, PermissionSetLicenseId: p.Id }), 'assigned'));
const ps = await one(`SELECT Id FROM PermissionSet WHERE Name = ${lit(PERMSET.name)}`);
await step(`Permission set ${PERMSET.label}`, async () => {
  if (await one(`SELECT Id FROM PermissionSetAssignment WHERE AssigneeId = ${lit(user.Id)} AND PermissionSetId = ${lit(ps.Id)}`)) return '(already assigned)';
  await sf.create('PermissionSetAssignment', { AssigneeId: user.Id, PermissionSetId: ps.Id }); return 'assigned';
});
console.log(`
Done. Next (Setup, about 5 minutes): the Vista External Client App. Upload vista-sf.crt, pre-authorize the
"${PERMSET.label}" permission set, and copy the Consumer Key. GitHub variables:
  SF_USERNAME = ${username}
  SF_LOGIN_URL = ${isSandbox ? 'https://test.salesforce.com' : 'https://login.salesforce.com'}`);
