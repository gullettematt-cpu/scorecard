// The demo text line. A program owner or admin texts DEMO to the Vista number and, from then on, their own phone
// plays a sample installer, PM or measure tech on the demo app's sample jobs (web/fixtures). It runs the same text
// engine as the real line, so it shows exactly what crews and PMs will get. Nothing reaches Salesforce: the engine's
// Salesforce actions are dropped, and a text it would send someone else comes back to this phone, labelled.
// DEMO PM / DEMO ES / DEMO MEASURE switch who you are, DEMO RESET starts the jobs over, DEMO OFF ends it.
import crews from '../../../web/fixtures/crews.json' with { type: 'json' };
import crew12 from '../../../web/fixtures/crew-12.json' with { type: 'json' };
import crew7 from '../../../web/fixtures/crew-7.json' with { type: 'json' };
import measure3 from '../../../web/fixtures/measure-3.json' with { type: 'json' };
import demoRollout from '../../../web/fixtures/rollout.json' with { type: 'json' };
import demoTranslations from '../../../web/fixtures/translations.json' with { type: 'json' };
import { strings, checklists, drawRules, createEngine, makeTranslator, domain } from './shared.mjs';

const FILES = { 'crew-12.json': crew12, 'crew-7.json': crew7, 'measure-3.json': measure3 };
const ROLES = { installer: 'crew-12', crew: 'crew-12', en: 'crew-12', pm: 'pm-mike', es: 'crew-7', spanish: 'crew-7', espanol: 'crew-7',
  cuadrilla: 'crew-7', measure: 'measure-3', medicion: 'measure-3' };
const OFF = ['off', 'end', 'exit', 'quit', 'salir'];
const HOURS = 12; // a demo ends on its own 12 hours after the last text
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// DEMO [who | RESET | OFF] -> what to do, or null when the text isn't a demo command.
export function demoCommand(body) {
  const [w0, w1, ...rest] = norm(body).split(/\s+/);
  if (w0 !== 'demo' || rest.length) return null;
  if (!w1) return { kind: 'start', persona: 'crew-12' };
  if (OFF.includes(w1)) return { kind: 'off' };
  if (w1 === 'reset') return { kind: 'reset' };
  if (ROLES[w1]) return { kind: 'start', persona: ROLES[w1] };
  return { kind: 'menu' };
}

export const easternAt = domain.easternAt;

// The sample world with `phone` playing `persona`.
export function demoWorld(persona, phone, now = new Date()) {
  const people = structuredClone(crews).filter(p => p.role !== 'admin');
  const me = people.find(p => p.id === persona);
  me.lead.phone = phone;
  const pm = people.find(p => p.role === 'pm');
  const { jobs, draws } = domain.fixtureWorld(people, pm, structuredClone(FILES), {
    at: (d, h) => domain.easternAt(d, h, now), off: d => new Date(now.getTime() + d * 864e5).toISOString() });
  return { persona, people, jobs, draws };
}

const intro = me => [
  `Vista demo: you're now ${me.lead.name} (${me.name}) on sample jobs. Nothing you text here reaches Salesforce, and texts meant for others come back to you, labelled.`,
  me.lang === 'es' ? `${me.lead.name}'s texts are in Spanish. Text HOY to start, or AYUDA.` : `Text ${me.role === 'pm' ? 'TODAY to see pay waiting on you' : 'TODAY to start'}, or HELP.`,
  'DEMO PM, DEMO ES, DEMO MEASURE or DEMO to switch · DEMO RESET to start the jobs over · DEMO OFF to stop.'
].join('\n');
const MENU = 'Vista demo: DEMO (installer), DEMO PM, DEMO ES (Spanish crew), DEMO MEASURE, DEMO RESET, DEMO OFF.';

export function createDemoText({ store, send, askVi = null, now = () => new Date() }) {
  const key = phone => ({ pk: `DEMOTEXT#${phone}`, sk: 'STATE' });
  const ttl = () => Math.floor(now().getTime() / 1000) + HOURS * 3600;
  async function load(phone) {
    const item = await store.get(key(phone).pk, key(phone).sk);
    if (!item || (item.ttl && item.ttl < now().getTime() / 1000)) return null; // DynamoDB removes expired items late
    return JSON.parse(item.state);
  }
  const save = (phone, state) => store.put({ ...key(phone), ttl: ttl(), state: JSON.stringify(state) });

  return {
    // Is this phone in a demo right now?
    async active(phone) { return !!(await load(phone)); },

    async handle({ from, body = '', media = [], cmd = demoCommand(body) }) {
      if (cmd?.kind === 'off') {
        await store.del(key(from).pk, key(from).sk);
        await send(from, 'Vista demo ended. Your phone is back on the real text line.');
        return { demo: 'off' };
      }
      if (cmd?.kind === 'menu') { await send(from, MENU); return { demo: 'menu' }; }
      let state = await load(from);
      if (cmd?.kind === 'start' || cmd?.kind === 'reset') {
        state = { ...demoWorld(cmd.persona || state?.persona || 'crew-12', from, now()), session: null };
        await save(from, state);
        await send(from, intro(state.people.find(p => p.id === state.persona)));
        return { demo: cmd.kind, persona: state.persona };
      }
      if (!state) return null;

      const me = state.people.find(p => p.id === state.persona);
      const engine = createEngine({
        store: { people: state.people, jobs: state.jobs, draws: state.draws, rollout: demoRollout, drawRules, checklists },
        strings, tr: makeTranslator(demoTranslations), now,
        links: { photos: () => '(link to the photos in the app)' },
        askVi: askVi ? ({ lang, viLanguage, job, question }) => askVi({ lang, viLanguage, job, question, checklist: job ? checklists[domain.tradeKey(job)] : null }) : null
      });
      if (state.session) engine.sessions.set(me.id, state.session);
      // Picture messages: the engine only counts them, so nothing is downloaded.
      const out = await engine.handle(from, body, media.map((_, i) => `demo://photo/${i}`));
      state.session = engine.sessions.get(me.id) || null;
      await save(from, state);
      for (const r of out.replies) {
        if (r.to === from) { await send(from, r.text); continue; }
        const who = state.people.find(p => p.lead?.phone === r.to);
        await send(from, `[Demo: ${who ? who.lead.name : 'someone else'} would get]\n${r.text}`);
      }
      return { demo: 'text', replies: out.replies.length, dropped: out.actions.map(a => a.kind) };
    }
  };
}
