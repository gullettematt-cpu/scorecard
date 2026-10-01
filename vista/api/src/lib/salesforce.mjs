// Salesforce REST client: OAuth 2.0 JWT bearer flow as the dedicated, company-owned integration user.
import crypto from 'node:crypto';

export class SalesforceError extends Error {
  constructor(step, status, body) { super(`Salesforce ${step} failed (${status}): ${String(body).slice(0, 300)}`); this.step = step; this.status = status; }
}

const b64url = x => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');
export function jwtAssertion({ clientId, username, audience, privateKey, now = Date.now() }) {
  const unsigned = `${b64url({ alg: 'RS256' })}.${b64url({ iss: clientId, sub: username, aud: audience, exp: Math.floor(now / 1000) + 180 })}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(privateKey).toString('base64url');
  return `${unsigned}.${sig}`;
}

// The JWT "aud" is Salesforce's generic login host, even when the token request goes to the org's My Domain
// (e.g. https://southernsiding.my.salesforce.com): login.salesforce.com for production, test.salesforce.com for
// sandboxes. So SF_LOGIN_URL can be either login.salesforce.com or the My Domain address.
export function jwtAudience(loginUrl) {
  const host = (() => { try { return new URL(loginUrl).hostname; } catch { return ''; } })();
  return /(^|\.)test\.salesforce\.com$|\.sandbox\.my\.salesforce\.com$|--[a-z0-9]+\.(cs\d+\.)?my\.salesforce\.com$/i.test(host)
    ? 'https://test.salesforce.com' : 'https://login.salesforce.com';
}

// SOQL literal (quotes and backslashes escaped) and IN lists.
export const lit = s => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
export const inList = xs => `(${(xs.length ? xs : ['']).map(lit).join(',')})`;

// `token` ({ access_token, instance_url }) skips the JWT login: scripts/check-salesforce.mjs uses the sf CLI's session.
export function createSalesforce({ loginUrl, clientId, username, privateKey, token = null, apiVersion = 'v62.0', fetchImpl = fetch }) {
  let tok = token;
  const base = `/services/data/${apiVersion}`;
  async function auth() {
    if (!privateKey && tok) return tok; // a session from the sf CLI
    const res = await fetchImpl(`${loginUrl}/services/oauth2/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwtAssertion({ clientId, username, audience: jwtAudience(loginUrl), privateKey }) })
    });
    if (!res.ok) throw new SalesforceError('login', res.status, await res.text());
    tok = await res.json();
    return tok;
  }
  async function call(method, path, body, retry = true) {
    if (!tok) await auth();
    const res = await fetchImpl(`${tok.instance_url}${path}`, {
      method, headers: { authorization: `Bearer ${tok.access_token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (res.status === 401 && retry && privateKey) { tok = null; return call(method, path, body, false); }
    if (!res.ok) throw new SalesforceError(`${method} ${path.split('?')[0]}`, res.status, await res.text());
    return res.status === 204 ? null : res.json();
  }
  return {
    auth,
    async query(soql) {
      let r = await call('GET', `${base}/query?q=${encodeURIComponent(soql)}`);
      const out = [...r.records];
      while (!r.done && r.nextRecordsUrl) { r = await call('GET', r.nextRecordsUrl); out.push(...r.records); }
      return out;
    },
    describe: sobject => call('GET', `${base}/sobjects/${sobject}/describe`),
    async search(sosl) { return (await call('GET', `${base}/search?q=${encodeURIComponent(sosl)}`))?.searchRecords || []; },
    async create(sobject, fields) { return (await call('POST', `${base}/sobjects/${sobject}`, fields)).id; },
    update: (sobject, id, fields) => call('PATCH', `${base}/sobjects/${sobject}/${id}`, fields),
    del: (sobject, id) => call('DELETE', `${base}/sobjects/${sobject}/${id}`)
  };
}
