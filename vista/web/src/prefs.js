// One set of preferences per person, shared by the app and text messages:
//   lang: 'en' | 'es' | 'bi' (English + Español)   channel: 'app' | 'text' | 'both'   requested: another language asked for
// Production: stored by the Vista API (GET/PATCH /me/prefs), not in Salesforce.
// Fixture mode: localStorage, which the app and the text simulator (/dev/sms.html) share on the same origin.
const KEY = 'vista.prefs';
const readAll = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };
export function getPrefs(personId) { return readAll()[personId] || {}; }
export function setPrefs(personId, patch) {
  const all = readAll(); all[personId] = { ...(all[personId] || {}), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch {}
  return all[personId];
}
export const allPrefs = readAll;
