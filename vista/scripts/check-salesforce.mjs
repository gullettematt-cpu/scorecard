// Check Salesforce from your own machine, with the sf CLI's login. Read-only: it never creates, changes or
// deletes a record, so it's safe against production. Runs as whoever the alias is logged in as, so field
// access reflects that user; `bash scripts/vista-admin.sh check-salesforce` runs it as Vista's integration user.
//   node scripts/check-salesforce.mjs                 # alias "myorg" (production)
//   node scripts/check-salesforce.mjs --org DevSandi  # another alias
//   node scripts/check-salesforce.mjs --json          # raw results
import { execFileSync } from 'node:child_process';
import { createSalesforce } from '../api/src/lib/salesforce.mjs';
import { checkSalesforce, formatReport } from '../api/src/lib/sfcheck.mjs';

const args = process.argv.slice(2);
const org = args.includes('--org') ? args[args.indexOf('--org') + 1] : process.env.ORG || 'myorg';
let info;
try {
  info = JSON.parse(execFileSync('sf', ['org', 'display', '-o', org, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })).result;
} catch (err) {
  console.error(`Couldn't get a session for org alias "${org}" from the sf CLI. Log in with: sf org login web -a ${org}`);
  process.exit(2);
}
const sf = createSalesforce({ token: { access_token: info.accessToken, instance_url: info.instanceUrl }, apiVersion: `v${info.apiVersion || '62.0'}` });
const report = await checkSalesforce({ sf });
if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
else console.log(`Check Salesforce · ${org} · ${info.username} · ${info.instanceUrl}\n(read-only; field access is this user's)\n${formatReport(report)}`);
process.exit(report.ok ? 0 : 1);
