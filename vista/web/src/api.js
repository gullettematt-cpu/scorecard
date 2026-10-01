// Vista API client (live mode). Only used when config.js sets VISTA_CONFIG.apiUrl.
const cfg = globalThis.VISTA_CONFIG || {};
export const apiMode = !!cfg.apiUrl;
const ls = globalThis.localStorage;
export const session = {
  token: () => ls?.getItem('vista.token'),
  set(token, person) { ls?.setItem('vista.token', token); if (person) ls?.setItem('vista.person', JSON.stringify(person)); },
  person: () => { try { return JSON.parse(ls?.getItem('vista.person') || 'null'); } catch { return null; } },
  savePerson: p => ls?.setItem('vista.person', JSON.stringify(p)),
  clear() { ls?.removeItem('vista.token'); ls?.removeItem('vista.person'); }
};
// Stable per-phone id, so outbox entries are applied once even across retries.
export function deviceId() {
  let id = ls?.getItem('vista.device');
  if (!id) { id = crypto.randomUUID(); ls?.setItem('vista.device', id); }
  return id;
}
export class SignInNeeded extends Error {}
async function req(method, path, body) {
  const tok = session.token();
  const res = await fetch(cfg.apiUrl + path, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401 && path !== '/auth/verify') { session.clear(); throw new SignInNeeded(); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}
export const api = {
  start: (phone, lang) => req('POST', '/auth/start', { phone, lang }),
  async verify(phone, code) { const r = await req('POST', '/auth/verify', { phone, code }); session.set(r.token, r.person); return r.person; },
  me: () => req('GET', '/me').then(r => { session.savePerson(r.person); return r.person; }),
  snapshot: () => req('GET', '/snapshot'),
  sync: entries => req('POST', '/sync', { entries }),
  prefs: p => req('PATCH', '/me/prefs', p),
  signPhotos: (workOrderId, keys) => req('POST', '/photos/sign', { workOrderId, keys }),
  // Straight to storage with the signed link; the API never handles the bytes.
  async putPhoto(url, blob) {
    const res = await fetch(url, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: blob });
    if (!res.ok) throw Object.assign(new Error(`upload ${res.status}`), { status: res.status });
  },
  admin: {
    board: () => req('GET', '/admin/board'),
    nudge: pmUserId => req('POST', '/admin/nudge', { pmUserId }),
    people: () => req('GET', '/admin/people'),
    savePerson: p => req('POST', '/admin/people', p),
    rollout: () => req('GET', '/admin/rollout'),
    setRollout: r => req('PUT', '/admin/rollout', r),
    health: () => req('GET', '/admin/health'),
    runHeartbeat: () => req('POST', '/admin/run', { job: 'heartbeat' }),
    checkSalesforce: () => req('POST', '/admin/run', { job: 'checkSalesforce' }),
    diagnose: () => req('POST', '/admin/run', { job: 'diagnose' }),
    lastDiagnosis: () => req('GET', '/admin/diagnose'),
    fix: action => req('POST', '/admin/fix', { action }),
    languageRequests: () => req('GET', '/admin/language-requests')
  },
  ask: (workOrderId, question, history = []) => req('POST', '/vi/ask', { workOrderId, question, history })
};
