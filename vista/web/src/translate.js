// Free-text translation (job descriptions, line items, notes, what installers type).
// Salesforce always keeps the original; Vista shows a translation with "Show original" one tap away.
// In production the Vista API asks Vi to translate each text once per language and caches it;
// in fixture mode the cache is web/fixtures/translations.json.

const ES_HINTS = /[ñáéíóú¿¡]|\b(el|la|los|las|de|del|y|con|para|que|en|una?|día|puerta|ventana|trabajo)\b/gi;
const EN_HINTS = /\b(the|and|with|for|on|of|to|door|window|day|replace|install)\b/gi;
export function detectLang(text) {
  const es = (String(text).match(ES_HINTS) || []).length, en = (String(text).match(EN_HINTS) || []).length;
  return es > en ? 'es' : 'en';
}

// makeTranslator(cache) -> tr(text, target) = { text, original, src, translated, pending }
//   target: 'en' | 'es' | 'bi'.  For 'bi', `text` is the other language and `original` the source.
export function makeTranslator(cache = { pairs: [] }) {
  const byText = new Map();
  for (const p of cache.pairs || []) { byText.set(p.en, { ...p, from: 'en' }); byText.set(p.es, { ...p, from: 'es' }); }
  return function tr(text, target) {
    if (!text) return { text: text || '', original: text || '', src: target, translated: false, pending: false };
    const hit = byText.get(text);
    const src = hit ? (hit.src || hit.from) : detectLang(text);
    const want = target === 'bi' ? (src === 'es' ? 'en' : 'es') : target;
    if (want === src) return { text, original: text, src, translated: false, pending: false };
    if (hit && hit[want]) return { text: hit[want], original: text, src, translated: true, pending: false };
    return { text, original: text, src, translated: false, pending: true }; // API would translate and cache
  };
}
