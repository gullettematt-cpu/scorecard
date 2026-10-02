// UI strings. Content (checklists) carries its own en/es; this is for chrome.
let dict = {};
let current = 'en';
const cache = {};
async function fetchDict(l) { return cache[l] ||= (await fetch(`./i18n/${l}.json`)).json(); }

let dictEs = {};
// 'en', 'es', or 'bi' (English + Español: every string shown in both languages).
export async function loadLang(lang) {
  current = lang === 'es' || lang === 'bi' ? lang : 'en';
  dict = await fetchDict(current === 'bi' ? 'en' : current);
  if (current === 'bi') dictEs = await fetchDict('es');
  document.documentElement.lang = current === 'es' ? 'es' : 'en';
  try { localStorage.setItem('vista.lang', current); } catch {}
  return current;
}
export function lang() { return current; }
const fill = (s, vars) => { for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v)); return s; };
export const both = (en, es) => (!es || en === es ? en : `${en} / ${es}`);
export function t(key, vars = {}) {
  const en = fill(dict[key] ?? key, vars);
  return current === 'bi' ? both(en, fill(dictEs[key] ?? dict[key] ?? key, vars)) : en;
}
export function pick(obj) {
  if (current === 'bi') return both(obj?.en ?? '', obj?.es ?? '');
  return obj?.[current] ?? obj?.en ?? '';
}
export const locale = () => (current === 'es' ? 'es-US' : 'en-US');
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
// Dates and times are Eastern (Southern Industries' time), the same as the texts, whatever the phone is set to.
const TZ = 'America/New_York';
export const fmtDate = (d, opts = { weekday: 'long', month: 'long', day: 'numeric' }) => cap(new Intl.DateTimeFormat(locale(), { timeZone: TZ, ...opts }).format(new Date(d)));
export const fmtTime = d => new Intl.DateTimeFormat(locale(), { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(d));
export const fmtMoney = n => new Intl.NumberFormat(locale(), { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0);

// Strings in a language other than the UI's (e.g. a PM composing the installer's message).
export async function tIn(l, key, vars = {}) {
  const en = fill((await fetchDict('en'))[key] ?? key, vars);
  if (l === 'es') return fill((await fetchDict('es'))[key] ?? key, vars);
  if (l === 'bi') return both(en, fill((await fetchDict('es'))[key] ?? key, vars));
  return en;
}
export const moneyIn = (l, n) => new Intl.NumberFormat(l === 'es' ? 'es-US' : 'en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0);
