// Diagnose: one run that checks every link Vista depends on and says, for each problem, the cause and the fix.
//   Salesforce login · Salesforce access (lib/sfcheck.mjs) · Twilio (Messaging Service, webhook, number, campaign)
//   · AWS (secrets, photo storage) · Claude (Vi) · texting opt-in for the alert and owner phones · the health check.
// It never changes Salesforce. The only things it can repair (`fix`, owners only, one click each) are inside Vista's
// own integrations: the Twilio webhook and sender pool, and re-running the health check.
import { checkSalesforce } from './sfcheck.mjs';

const MAC = 'On your Mac, in the vista folder:';

// Salesforce login errors -> cause and fix. Matched on the error text Salesforce returns.
export const LOGIN_CAUSES = [
  { re: /refresh_token scope is required|hasn'?t approved this consumer|not admin.?approved|user is not admin approved/i,
    cause: "Salesforce doesn't treat the Vista integration user as pre-approved for the Vista app.",
    fix: 'Setup → External Client App Manager → Vista → Policies → Edit: Permitted Users = "Admin approved users are pre-authorized", and select the "Vista Integration" permission set under App Policies. On the Settings tab, OAuth scopes include api and refresh_token/offline_access. Save, wait 10 minutes, run again.' },
  { re: /invalid[_ ]client|client identifier invalid|invalid_client_id/i,
    cause: "SF_CLIENT_ID doesn't match the Vista app's Consumer Key.",
    fix: 'Copy the Consumer Key from Setup → External Client App Manager → Vista → Settings → Consumer Key and Secret into the GitHub variable SF_CLIENT_ID (environment vista-prod), then re-run the deploy.' },
  { re: /audience|invalid.?aud/i,
    cause: 'The login address and the Salesforce login host disagree.',
    fix: 'Set the GitHub variable SF_LOGIN_URL to https://login.salesforce.com (or your My Domain address), then re-run the deploy.' },
  { re: /authentication failure/i,
    cause: "Salesforce couldn't log in the user named in SF_USERNAME: it doesn't exist under that username, is inactive, isn't API-enabled, or doesn't have the Vista Integration permission set (which is what pre-authorizes it for the Vista app).",
    fix: 'Setup → Users: the user whose username equals SF_USERNAME (GitHub → vista-prod) must be Active, have the Vista Integration permission set and, on a Salesforce license, the Field Service Standard permission set license. If the user has a different username, change SF_USERNAME and re-run the deploy.' },
  { re: /inactive|user.*(frozen|not active|deactivated)|account.*locked/i,
    cause: 'The Vista integration user is inactive, frozen or locked.',
    fix: 'Setup → Users → Vista Integration: make sure Active is ticked and the user isn\'t frozen.' },
  { re: /ip.?restrict|login hours/i,
    cause: 'Salesforce is blocking the login by IP address or login hours.',
    fix: 'Setup → External Client App Manager → Vista → Policies → IP Relaxation = "Relax IP restrictions"; check the profile has no login-hour limits.' },
  { re: /invalid[_ ]grant|invalid assertion|signature|expired|certificate/i,
    cause: "Salesforce rejected Vista's signed login: the certificate in the Vista app doesn't match Vista's private key, the certificate expired, or the username is wrong.",
    fix: "Check the Vista app (Settings → OAuth Settings) has Donald's current vista-sf.crt with JWT Bearer Flow ticked, and that SF_USERNAME is vista@southernindustries.com.prod. If Donald made a new key pair, upload the new certificate." },
  { re: /missing secret/i,
    cause: 'A secret is missing from AWS Parameter Store.',
    fix: 'Donald: load it under /vista/prod with scripts/aws-secrets.sh, then re-run the deploy.' }
];
export function explainLogin(text) {
  const t = String(text || '');
  return LOGIN_CAUSES.find(c => c.re.test(t)) || null;
}

// A failed Check Salesforce line -> the fix.
export function fixForCheck(row) {
  const d = `${row.name} ${row.detail}`;
  if (row.section === 'login') return explainLogin(row.detail)?.fix || 'See the Salesforce login line above.';
  if (/Field Service permission set license/.test(d)) return `${MAC} bash salesforce/integration-user.sh --prod --license=salesforce, then the same with --go.`;
  if (/picklist value "Vista"/.test(d)) return `${MAC} bash salesforce/add-vista-type.sh --prod --go`;
  if (/picklist value/.test(d)) return 'Add the missing picklist value to that field in Setup → Object Manager, or ask Matt.';
  if (/Flow .*deployed but not active/.test(d)) return 'Setup → Flows → open the flow → Activate.';
  if (/Flow .*not deployed|List view .*not deployed/.test(d)) return `${MAC} bash salesforce/deploy.sh --prod --go`;
  if (/record type/.test(d)) return 'Give the Vista Integration permission set the Service record type on Case (Setup → Permission Sets → Vista Integration → Object Settings → Cases).';
  if (/field-level security|missing \(or not visible|can't see|not settable|not editable|can't create|can't edit|can't delete|can't follow/.test(d))
    return `${MAC} bash salesforce/integration-user.sh --prod (dry run), then --go. It rebuilds the Vista Integration permission set from what Vista uses.`;
  return 'Send this line to Matt.';
}

const item = (name, status, detail = '', fix = '', action = null) => ({ name, status, detail, fix, action });
const safe = async (fn, onError) => { try { return await fn(); } catch (err) { return onError(err); } };
const msg = err => String(err?.message || err).replace(/\s+/g, ' ').slice(0, 300);

export function createDiagnose({ deps, optIns, rerunHealth }) {
  const { sf, store, photos, vi, config = {} } = deps;
  const twilio = deps.twilio; // the raw client: Diagnose reads settings, it doesn't send texts
  const inboundUrl = () => (config.publicApiUrl ? `${config.publicApiUrl.replace(/\/$/, '')}/sms/inbound` : null);

  async function salesforce() {
    const items = [];
    const login = await safe(async () => { await sf.auth(); return null; }, err => err);
    if (login) {
      const why = explainLogin(login.message);
      items.push(item('Salesforce login', 'fail', why ? why.cause : msg(login), why ? why.fix : 'Send this to Matt.'));
      return { area: 'salesforce', items };
    }
    items.push(item('Salesforce login', 'ok', 'Vista signs in as its integration user.'));
    const r = await safe(() => checkSalesforce({ sf }), err => ({ ok: false, results: [{ section: 'login', name: 'Check', status: 'fail', detail: msg(err) }] }));
    const bad = r.results.filter(x => x.status !== 'ok');
    // One license problem shows up on every query: say it once.
    const license = bad.filter(x => /Field Service permission set license/.test(x.detail));
    const rest = bad.filter(x => !license.includes(x));
    if (license.length) items.push(item(`Field Service access (${license.length} checks)`, 'fail',
      "The integration user can't see Service Appointments, Assigned Resources or Work Types, so nobody would see their visits.", fixForCheck(license[0])));
    for (const x of rest) items.push(item(x.name, x.status, x.detail, fixForCheck(x)));
    const passed = r.results.filter(x => x.status === 'ok').length;
    items.push(item('Queries and fields', bad.length ? (license.length || rest.some(x => x.status === 'fail') ? 'fail' : 'warn') : 'ok', `${passed} of ${r.results.length} checks passed.`));
    return { area: 'salesforce', items };
  }

  async function texting() {
    const items = [];
    if (!twilio?.service || !twilio.info?.messagingServiceSid) {
      items.push(item('Messaging Service', 'warn', 'Vista sends from a single number (no TWILIO_MESSAGING_SERVICE_SID), so it can\'t check the Twilio setup.', 'Set TWILIO_MESSAGING_SERVICE_SID in GitHub (vista-prod) to the Vista Messaging Service (MG…).'));
      return { area: 'twilio', items };
    }
    const svc = await safe(() => twilio.service(), err => err);
    if (svc instanceof Error) {
      items.push(item('Messaging Service', 'fail', msg(svc), /401|403|authenticat/i.test(svc.message)
        ? 'The Twilio Auth Token in AWS (/vista/prod/TWILIO_AUTH_TOKEN) or TWILIO_ACCOUNT_SID is wrong. Donald: reload it with scripts/aws-secrets.sh.'
        : 'Check TWILIO_MESSAGING_SERVICE_SID in GitHub (vista-prod) is the Vista Messaging Service (MG…).'));
      return { area: 'twilio', items };
    }
    items.push(item('Messaging Service', 'ok', `"${svc.friendly_name || svc.sid}" is reachable.`));
    const want = inboundUrl();
    const hookOk = want && svc.inbound_request_url === want && String(svc.inbound_method || 'POST').toUpperCase() === 'POST' && !svc.use_inbound_webhook_on_number;
    items.push(hookOk
      ? item('Incoming texts reach Vista', 'ok', want)
      : item('Incoming texts reach Vista', 'fail',
        svc.use_inbound_webhook_on_number ? 'The service lets each number use its own webhook, so texts may skip Vista.' : `The service sends incoming texts to ${svc.inbound_request_url || 'nowhere'}${svc.inbound_request_url ? ` (${svc.inbound_method})` : ''}, not ${want}.`,
        'Fix it: Vista points the Messaging Service\'s incoming-text webhook at itself (POST).', want ? 'twilio.webhook' : null));
    const from = twilio.info.from;
    const nums = await safe(() => twilio.serviceNumbers(), err => err);
    if (nums instanceof Error) items.push(item('Vista number in the service', 'warn', msg(nums), 'Check in Twilio → Messaging → Services → Vista → Sender Pool.'));
    else if (from && !nums.some(n => n.phone_number === from)) items.push(item('Vista number in the service', 'fail', `${from} isn't in the Messaging Service's sender pool.`, `Fix it: Vista adds ${from} to the sender pool.`, 'twilio.addNumber'));
    else items.push(item('Vista number in the service', 'ok', nums.map(n => n.phone_number).join(', ') || 'Sender pool has numbers.'));
    const camps = await safe(() => twilio.campaigns(), () => null);
    if (camps) {
      const c = camps[0];
      const st = String(c?.campaign_status || '').toUpperCase();
      items.push(!c ? item('Texting campaign (A2P 10DLC)', 'fail', 'No campaign is attached to the Messaging Service, so carriers will block texts.', 'Donald: attach the approved Vista campaign to the Messaging Service in Twilio → Trust Hub.')
        : /VERIFIED|APPROVED|ACTIVE/.test(st) ? item('Texting campaign (A2P 10DLC)', 'ok', `Campaign ${c.campaign_id || c.sid || ''} is ${c.campaign_status}.`)
        : item('Texting campaign (A2P 10DLC)', 'warn', `Campaign status: ${c.campaign_status || 'unknown'}.`, 'Donald: check the campaign in Twilio → Trust Hub.'));
    }
    return { area: 'twilio', items };
  }

  async function aws() {
    const items = [item('Secrets', 'ok', 'All secrets load from Parameter Store (Vista wouldn\'t be running otherwise).')];
    const key = `vista/diagnose/${Date.now()}.txt`;
    const r = await safe(async () => { await photos.put(key, Buffer.from('vista diagnose'), 'text/plain'); await photos.head(key); return null; }, err => err);
    items.push(r ? item('Photo storage', 'fail', msg(r), 'Donald: check the Vista photo bucket and the API function\'s S3 permissions (vista stack).') : item('Photo storage', 'ok', 'Vista can store and read photos.'));
    return { area: 'aws', items };
  }

  async function claude() {
    if (!vi?.ping) return { area: 'vi', items: [item('Claude (Vi)', 'warn', 'Not checked.')] };
    const r = await safe(() => vi.ping(), err => err);
    const items = [r instanceof Error
      ? item('Claude (Vi)', 'fail', msg(r), /401|authentication|api.?key/i.test(r.message)
        ? 'The Anthropic key in AWS (/vista/prod/ANTHROPIC_API_KEY) is invalid or revoked. Make a new key and have Donald load it.'
        : /credit|billing|429|rate/i.test(r.message) ? 'Check the Anthropic account\'s credit and spend limit at console.anthropic.com.' : 'Try again in a few minutes; if it persists, check status.anthropic.com.')
      : item('Claude (Vi)', 'ok', `Vi answers (${r.model || 'model ok'}).`)];
    return { area: 'vi', items };
  }

  async function optIn() {
    const items = [];
    const all = optIns ? await optIns.all() : {};
    const label = { in: 'texted START', out: 'texted STOP', none: "hasn't texted START" };
    for (const [who, phones] of [['Alert phone', config.alertPhones || []], ['Owner phone', config.adminPhones || []]]) {
      for (const phone of phones) {
        const st = all[phone]?.status || 'none';
        items.push(st === 'in' ? item(`${who} ${phone}`, 'ok', label.in)
          : item(`${who} ${phone}`, 'warn', `${label[st]}: Vista won't text this phone (alerts, notices).`, `From ${phone}, text START to the Vista number${twilio?.info?.from ? ` ${twilio.info.from}` : ''}.`));
      }
    }
    const counts = Object.values(all).reduce((c, x) => ({ ...c, [x.status]: (c[x.status] || 0) + 1 }), {});
    items.push(item('Phones signed up for texts', 'ok', `${counts.in || 0} texted START, ${counts.out || 0} texted STOP.`));
    return { area: 'optin', items };
  }

  async function health() {
    const s = (await store.get('HEARTBEAT', 'STATE')) || {};
    const why = s.failing ? explainLogin(s.error) : null;
    return { area: 'health', items: [s.failing
      ? item('2-hour health check', 'fail', `Failing at ${s.failing}${why ? `: ${why.cause}` : `: ${String(s.error || '').slice(0, 200)}`}`, why ? why.fix : 'Fix it: run the health check again now.', 'health.rerun')
      : item('2-hour health check', s.lastOk ? 'ok' : 'warn', s.lastOk ? `Last good check ${s.lastOk}.` : 'Hasn\'t run yet.', s.lastOk ? '' : 'Fix it: run it now.', s.lastOk ? null : 'health.rerun')] };
  }

  async function run() {
    const areas = await Promise.all([salesforce(), texting(), aws(), claude(), optIn(), health()]);
    const all = areas.flatMap(a => a.items);
    const report = { at: new Date().toISOString(), ok: !all.some(x => x.status === 'fail'),
      failed: all.filter(x => x.status === 'fail').length, warnings: all.filter(x => x.status === 'warn').length, areas };
    await store.put({ pk: 'DIAGNOSE', sk: 'LAST', report });
    return report;
  }

  // One-click repairs. Each is inside Vista's own integrations; nothing here touches Salesforce.
  const FIXES = {
    'twilio.webhook': async () => { const url = inboundUrl(); if (!url) throw new Error('PUBLIC_API_URL is not set'); await twilio.setInbound(url); return `Incoming texts now go to ${url}.`; },
    'twilio.addNumber': async () => { await twilio.addNumber(twilio.info.from); return `${twilio.info.from} added to the sender pool.`; },
    'health.rerun': async () => { const r = await rerunHealth(); return r.ok ? 'Health check passed.' : `Health check still failing at ${r.step}.`; }
  };
  async function fix(action, by = 'admin token') {
    if (!FIXES[action]) throw Object.assign(new Error(`unknown fix ${action}`), { status: 422 });
    const result = await FIXES[action]();
    await store.put({ pk: 'FIXLOG', sk: `${new Date().toISOString()}#${action}`, action, by, result, ttl: Math.floor(Date.now() / 1000) + 90 * 86400 });
    return { ok: true, action, result };
  }
  return { run, fix, FIXES: Object.keys(FIXES) };
}
