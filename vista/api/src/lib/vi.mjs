// Vi: the assistant inside Vista, and the free-text translator. Claude API, model claude-sonnet-5.
import Anthropic from '@anthropic-ai/sdk';
import crypto from 'node:crypto';

export const VI_MODEL = 'claude-sonnet-5';

const VI_SYSTEM = `You are Vi, the assistant inside Vista, the field app for Southern Industries installers, measure techs and project managers (windows, doors, siding, gutters, baths, roofing).

How to answer:
- Answer the question about the job in focus, using the job record, its line items, the trade checklist and any trade documents provided. If the answer isn't in them and isn't standard good practice for the trade, say you don't know and suggest calling the PM.
- Be brief: people read you on a phone on a job site, often by text message. Two to four short sentences, or a short numbered list for steps.
- Never invent prices, dates, warranty terms, Salesforce values or pay amounts.
- You can't change anything in Salesforce, approve pay, or issue draws. For a problem on site, suggest "Report a problem" in Vista; for money, the PM.
- Safety first: for anything involving electrical, structural, asbestos/lead (homes built before 1978), or working at height without proper equipment, tell them to stop and call the PM.
- Answer in the language you are told to use.

Facts about Vista you can rely on:
- Pay: an installer submits for pay in Vista (app or text) with every required photo ("no photos, no pay"). The PM reviews and submits it as approved. Anything approved by 10:00 AM Eastern on a weekday goes in that day's ACH pay run; later, the next business day's.
- If the PM sends a request back, it says exactly what's missing; add it in Vista and it goes back to the PM.
- Draws (pay before the job is done) are issued by the PM. The installer asks the PM directly.
- The 🌐 button at the top of the app changes the language: English, Spanish or both. By text, reply ESPAÑOL, ENGLISH or BILINGUAL.
- "Report a problem" on the job screen sends a Service case to the office and texts the PM.
- By text: TODAY (or HOY) for the job list, PAY to submit for pay, HELP (or AYUDA) for the commands.`;

// Only for the app (structured reply): when to offer a problem report.
const VI_CHAT_ADDENDUM = `Reply as JSON with answer, suggest_problem_report and problem_summary.
- If the person describes something wrong on this job that the office should hear about (damage, rot, wrong or missing material, a defect, a homeowner complaint, work they can't finish) and it isn't already in the job's open problems, suggest a problem report: set suggest_problem_report to true and write problem_summary as one line (under 100 characters) in the person's language, e.g. "Rot in the sill at the picture window". Otherwise false and an empty problem_summary.`;

// Structured reply for the app: the answer, plus an optional problem report to offer (the person decides; Vi never files it).
const CHAT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['answer', 'suggest_problem_report', 'problem_summary'],
  properties: { answer: { type: 'string' }, suggest_problem_report: { type: 'boolean' }, problem_summary: { type: 'string' } }
};
const CHAT_TIMEOUT_MS = 25000; // API Gateway gives up at 29 s
const MAX_TURNS = 6, MAX_CHARS = 2000;
const clip = s => String(s || '').slice(0, MAX_CHARS);

const TR_SYSTEM = `You translate short job notes for a US home-improvement company between English and Latin American Spanish as used by construction crews in the US Southeast.
Rules: keep product names, colors (e.g. Pewter, Harbor Blue), model and size codes (36x60, D4, OSB, IGU, low-E), numbers, measurements, addresses, names and gate codes exactly as written. Use the trade words crews use (e.g. "house wrap" = "membrana", "double-hung" = "guillotina doble", "soffit" = "plafón"). Translate meaning, not word for word. Return every item, in order.`;

const TR_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['source_language', 'english', 'spanish'],
    properties: { source_language: { type: 'string', enum: ['en', 'es'] }, english: { type: 'string' }, spanish: { type: 'string' } } } } }
};

const textOf = res => res.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();

export function jobContext(job, checklist, { problems = null, pay = null } = {}) {
  if (!job) return null;
  return {
    ...(problems ? { open_problems: problems } : {}), ...(pay ? { pay_requests_and_draws: pay } : {}),
    work_order: job.WorkOrderNumber, subject: job.Subject, status: job.ServiceAppointment?.Status, trade: job.Work_Type_Name__c || job.WorkType?.Name,
    address: `${job.Street}, ${job.City}, ${job.State} ${job.PostalCode}`, scope: job.Description,
    line_items: (job.WorkOrderLineItems || []).map(li => ({ item: li.Description, qty: li.Quantity, status: li.Status })),
    job_number: job.Job_Number__r?.Name, pm: job.Job_Number__r?.Production_Manager__r?.Name,
    checklist: checklist ? { steps: checklist.steps.map(s => s.en), photos_required: checklist.photos.filter(p => p.min).map(p => `${p.en} (min ${p.min})`) } : null
  };
}

const languageFor = (lang, viLanguage) => viLanguage || (lang === 'es' ? 'Spanish' : lang === 'bi' ? 'English, followed by the same answer in Spanish' : 'English');
const fallback = (lang, kind) => ({
  refused: { en: "I can't help with that one. Please call your PM.", es: 'No puedo ayudar con eso. Llame a su PM.' },
  none: { en: "I don't have an answer for that. Please call your PM.", es: 'No tengo una respuesta. Llame a su PM.' }
}[kind][lang === 'es' ? 'es' : 'en']);

export function createVi({ apiKey, client = new Anthropic({ apiKey }), model = VI_MODEL }) {
  return {
    // The app's Ask Vi screen: a conversation about one job. history = earlier [{ q, a }] on this job (newest last).
    async chat({ lang, viLanguage = null, job = null, checklist = null, extras = {}, docs = '', history = [], question }) {
      const ctx = jobContext(job, checklist, extras);
      const turns = history.slice(-MAX_TURNS).filter(h => h?.q && h?.a);
      const reply = `Reply in ${languageFor(lang, viLanguage)}.\n\nQuestion: ${clip(question)}`;
      // The job context opens the conversation and carries the cache breakpoint, so follow-ups reuse it.
      const contextBlock = { type: 'text', text: `Job in focus:\n${ctx ? JSON.stringify(ctx, null, 1) : '(none selected: a general question)'}${docs ? `\n\nTrade documents:\n${docs}` : ''}`, cache_control: { type: 'ephemeral' } };
      const messages = [];
      turns.forEach((h, i) => {
        messages.push({ role: 'user', content: i === 0 ? [contextBlock, { type: 'text', text: clip(h.q) }] : clip(h.q) });
        messages.push({ role: 'assistant', content: clip(h.a) });
      });
      messages.push({ role: 'user', content: turns.length ? reply : [contextBlock, { type: 'text', text: reply }] });
      const res = await client.messages.create({
        model, max_tokens: 2000,
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: CHAT_SCHEMA } },
        system: [{ type: 'text', text: VI_SYSTEM }, { type: 'text', text: VI_CHAT_ADDENDUM, cache_control: { type: 'ephemeral' } }],
        messages
      }, { timeout: CHAT_TIMEOUT_MS });
      if (res.stop_reason === 'refusal') return { answer: fallback(lang, 'refused'), problem: null };
      let out; try { out = JSON.parse(textOf(res)); } catch { return { answer: fallback(lang, 'none'), problem: null }; }
      const summary = String(out.problem_summary || '').trim().slice(0, 200);
      return { answer: String(out.answer || '').trim() || fallback(lang, 'none'), problem: out.suggest_problem_report && summary ? { summary } : null };
    },

    // Texts: one question, one plain answer.
    async ask({ lang, viLanguage = null, job = null, checklist = null, docs = '', question }) {
      const language = languageFor(lang, viLanguage);
      const ctx = jobContext(job, checklist);
      const res = await client.messages.create({
        model, max_tokens: 2000,
        output_config: { effort: 'medium' },
        system: [{ type: 'text', text: VI_SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: [
          { type: 'text', text: `Job in focus:\n${ctx ? JSON.stringify(ctx, null, 1) : '(none selected)'}${docs ? `\n\nTrade documents:\n${docs}` : ''}`, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: `Reply in ${language}.\n\nQuestion: ${question}` }
        ] }]
      });
      if (res.stop_reason === 'refusal') return fallback(lang, 'refused');
      return textOf(res) || fallback(lang, 'none');
    },

    // texts -> [{ en, es, src }] in the same order.
    async translate(texts) {
      if (!texts.length) return [];
      const res = await client.messages.create({
        model, max_tokens: 8000,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: TR_SCHEMA } },
        system: TR_SYSTEM,
        messages: [{ role: 'user', content: `Give each note in both English and Spanish, and say which language it was written in.\n${JSON.stringify(texts.map((text, i) => ({ i, text })))}` }]
      });
      if (res.stop_reason !== 'end_turn') throw new Error(`translation stopped: ${res.stop_reason}`);
      const items = JSON.parse(textOf(res)).items;
      if (items.length !== texts.length) throw new Error('translation count mismatch');
      return items.map((it, i) => ({ src: it.source_language, en: it.source_language === 'en' ? texts[i] : it.english, es: it.source_language === 'es' ? texts[i] : it.spanish }));
    }
  };
}

// Translation cache: each text is translated once and stored under both languages' text.
const h = s => crypto.createHash('sha1').update(s).digest('hex');
export function createTranslations({ store, vi }) {
  return {
    async pairsFor(texts) {
      const uniq = [...new Set(texts.filter(t => t && t.trim()))];
      const found = [], missing = [];
      for (const t of uniq) { const hit = await store.get(`TR#${h(t)}`, 'PAIR'); hit ? found.push(hit.pair) : missing.push(t); }
      for (let i = 0; i < missing.length; i += 40) {
        const batch = missing.slice(i, i + 40);
        let pairs = [];
        try { pairs = await vi.translate(batch); } catch (e) { console.warn('translate failed', e.message); continue; } // app shows "translation on its way"
        for (const pair of pairs) {
          found.push(pair);
          await store.put({ pk: `TR#${h(pair.en)}`, sk: 'PAIR', pair });
          await store.put({ pk: `TR#${h(pair.es)}`, sk: 'PAIR', pair });
        }
      }
      return found;
    }
  };
}
