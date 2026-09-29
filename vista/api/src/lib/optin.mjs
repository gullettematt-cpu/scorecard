// Carrier opt-in for the Vista texting campaign (Account Notifications, registered by Donald).
// - A phone opts in only by texting START or UNSTOP to the Vista number. YES is NOT an opt-in keyword:
//   Vista uses YES to confirm approvals and checklists.
// - STOP (and the other standard opt-out words) opts out until the phone texts START again.
// - Twilio answers START, STOP and HELP itself (the Messaging Service's opt-out management), so Vista only
//   records the change and doesn't reply to those.
// Every automatic text goes through gatedTwilio(): opted-in phones only, branded, opt-out wording on the first
// message to each phone, and at most DAILY_CAP automatic texts per phone per day (the registered frequency).
// Sign-in codes don't go through the gate: the person asks for them in the app.
export const OPT_IN = ['start', 'unstop'];
export const OPT_OUT = ['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke', 'optout'];
export const HELP = ['help', 'info'];
export const BRAND = 'Vista (Southern Industries):';
export const DAILY_CAP = 10;

const FIRST_NOTICE = { en: 'Reply HELP for help, STOP to opt out.', es: 'Responda HELP para ayuda, STOP para cancelar.' };
export const OPT_IN_PROMPT = `${BRAND} To get Vista job and pay texts, reply START. Msg & data rates may apply. Reply STOP to opt out. / Para recibir textos de Vista, responda START. Responda STOP para cancelar.`;

// Which carrier keyword a message is, if any. Twilio passes OptOutType (START/STOP/HELP) when its opt-out
// management handled the message; otherwise match the whole message (Twilio only treats a message as a
// keyword when the keyword is all it says, so "START 1" is a Vista command, not an opt-in).
export function keywordOf(body, optOutType) {
  const t = String(optOutType || '').toUpperCase();
  if (t === 'START') return 'in';
  if (t === 'STOP') return 'out';
  if (t === 'HELP') return 'help';
  const w = String(body || '').trim().toLowerCase().replace(/[.!]+$/, '');
  if (OPT_IN.includes(w)) return 'in';
  if (OPT_OUT.includes(w)) return 'out';
  if (HELP.includes(w)) return 'help';
  return null;
}

export const branded = body => {
  const b = String(body || '').trim();
  if (b.startsWith(BRAND)) return b;
  return `${BRAND} ${b.replace(/^Vista:\s*/, '')}`;
};

const day = now => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now); // YYYY-MM-DD Eastern

export function createOptIns({ store, now = () => new Date() }) {
  const key = phone => ({ pk: `OPTIN#${phone}`, sk: 'STATE' });
  return {
    async get(phone) { return phone ? store.get(key(phone).pk, 'STATE') : null; },
    async set(phone, status, via = 'keyword') {
      const prev = await store.get(key(phone).pk, 'STATE');
      const item = { ...key(phone), status, via, at: now().toISOString(), noticed: status === 'in' ? !!prev?.noticed && prev.status === 'in' : false };
      await store.put(item);
      await store.put({ pk: 'OPTINS', sk: phone, status, at: item.at });
      return item;
    },
    async markNoticed(phone) { const s = await store.get(key(phone).pk, 'STATE'); if (s) await store.put({ ...s, noticed: true }); },
    async all() { return Object.fromEntries((await store.query('OPTINS')).map(x => [x.sk, { status: x.status, at: x.at }])); }
  };
}

// The one way services and actions send texts. { reply: true } = answering a text that phone just sent
// (still needs opt-in, but doesn't count toward the daily cap). Returns the message SID, or null if held back.
export function gatedTwilio({ twilio, optIns, people, store, now = () => new Date(), cap = DAILY_CAP, log = console }) {
  const langOf = async phone => (await people?.byPhone(phone).catch(() => null))?.lang || 'en';
  return {
    async canText(phone) { return (await optIns.get(phone))?.status === 'in'; },
    async send(to, body, { reply = false } = {}) {
      const st = await optIns.get(to);
      if (st?.status !== 'in') { log.info?.(`text held: ${to} has not opted in`); return null; }
      if (!reply) {
        const k = { pk: `SENT#${to}`, sk: day(now()) };
        const n = (await store.get(k.pk, k.sk))?.n || 0;
        if (n >= cap) { log.warn?.(`text held: ${to} reached ${cap} automatic texts today`); return null; }
        await store.put({ ...k, n: n + 1, ttl: Math.floor(now().getTime() / 1000) + 3 * 86400 });
      }
      let text = branded(body);
      if (!st.noticed) {
        const l = await langOf(to);
        text += ' ' + (l === 'es' ? FIRST_NOTICE.es : l === 'bi' ? `${FIRST_NOTICE.en} / ${FIRST_NOTICE.es}` : FIRST_NOTICE.en);
        await optIns.markNoticed(to);
      }
      return twilio.send(to, text);
    },
    fetchMedia: (...a) => twilio.fetchMedia(...a),
    deleteMedia: (...a) => twilio.deleteMedia?.(...a)
  };
}
