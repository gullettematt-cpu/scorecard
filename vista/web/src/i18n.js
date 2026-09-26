// UI strings. Content (checklists) carries its own en/es; this is for chrome.
let dict = {};
let current = 'en';

export async function loadLang(lang) {
  current = lang === 'es' ? 'es' : 'en';
  const res = await fetch(`./i18n/${current}.json`);
  dict = await res.json();
  document.documentElement.lang = current;
  try { localStorage.setItem('vista.lang', current); } catch {}
  return current;
}
export function lang() { return current; }
export function t(key, vars = {}) {
  let s = dict[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}
export function pick(obj) { return obj?.[current] ?? obj?.en ?? ''; }
export const locale = () => (current === 'es' ? 'es-US' : 'en-US');
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
export const fmtDate = (d, opts = { weekday: 'long', month: 'long', day: 'numeric' }) => cap(new Intl.DateTimeFormat(locale(), opts).format(new Date(d)));
export const fmtTime = d => new Intl.DateTimeFormat(locale(), { hour: 'numeric', minute: '2-digit' }).format(new Date(d));
export const fmtMoney = n => new Intl.NumberFormat(locale(), { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0);
