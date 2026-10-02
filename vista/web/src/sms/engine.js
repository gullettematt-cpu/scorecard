// Vista by text message. One engine for installers, measure techs and PMs, in English or Spanish.
// It uses the same rules as the app (dispatch gating, rollout, photo minimums, the PM checklist,
// "Are you sure?" before money moves) and emits the same actions the app's outbox sends to the API.
//
//   const engine = createEngine({ store, strings, links, askVi });
//   const { replies, actions } = await engine.handle(fromPhone, body, mediaUrls);
//
// store   : { people, jobs, draws, rollout, checklists: { windows, siding, … }, drawRules }  (a working snapshot)
// tr      : free-text translator (web/src/translate.js makeTranslator); the API warms its cache before calling.
// Languages: 'en', 'es', or 'bi' (every line in English and Spanish).
// strings : { en: {...}, es: {...} }  (i18n/en.json, i18n/es.json)
// replies : [{ to, text }]  — the sender's reply plus any notices to other people
// actions : [{ kind, payload }]  — Salesforce writes for the API to perform
// See docs/sms.md.
import {
  visibleFor, visit, drawsFor, drawStatus, drawAmount, remaining, contractAmount, reviewLines, pendingReview,
  tradeKey, WOLI_DONE, visitKind, isDraw, drawEligible, manifestOf, MANIFEST_FIELD, MANIFEST_MARK, pmOf, onVista, assignedTo, TIME_ZONE, easternDay
} from '../data.js';

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const WORDS = {
  today: ['today', 'hoy', 'jobs', 'trabajos', 'list', 'lista', 'menu', 'reviews', 'revisiones'],
  help: ['help', 'ayuda', '?', 'info'],
  start: ['start', 'empezar', 'iniciar', 'inicio', 'comenzar'],
  done: ['done', 'listo', 'hecho', 'terminado', 'instalado', 'medido'],
  finish: ['finish', 'terminar', 'fin'],
  pay: ['pay', 'cobrar', 'pago', 'cobro'],
  draw: ['draw', 'adelanto'],
  review: ['review', 'revisar', 'ver'],
  approve: ['approve', 'aprobar'],
  fix: ['fix', 'back', 'devolver', 'corregir'],
  yes: ['yes', 'y', 'si', 'ok', 'send', 'enviar', 'confirm', 'confirmar'],
  no: ['no', 'cancel', 'cancelar', 'stop', 'alto'],
  next: ['next', 'siguiente', 'sig', 'listo'],
  steps: ['steps', 'pasos'],
  all: ['all', 'todas', 'todos', 'todo'],
  en: ['english', 'ingles'],
  es: ['espanol', 'spanish'],
  bi: ['bilingual', 'bilingue', 'dual'],
  langReq: ['language', 'idioma', 'lang'],
  original: ['original'],
  chApp: ['app'], chText: ['text', 'texto', 'sms'], chBoth: ['both', 'ambos', 'las dos']
};
const is = (w, k) => WORDS[k].includes(w);
const REASONS = { blurry: 'unclear', borrosa: 'unclear', borroso: 'unclear', unclear: 'unclear', wrong: 'mismatch', incorrecta: 'mismatch', incorrecto: 'mismatch', incomplete: 'incomplete', incompleto: 'incomplete', incompleta: 'incomplete', missing: 'missing', falta: 'missing' };

export function createEngine({ store, strings, links = {}, askVi = null, tr = null, now = () => new Date() }) {
  const sessions = new Map();
  const mapsUrl = w => `https://maps.apple.com/?daddr=${w.Latitude && w.Longitude ? `${w.Latitude},${w.Longitude}` : encodeURIComponent(`${w.Street}, ${w.City}, ${w.State} ${w.PostalCode}`)}`;
  const photosLink = d => (links.photos ? links.photos(d) : `https://vista.example/r/${d.Id}`);

  const fill = (s, vars) => { for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v)); return s; };
  const both = (en, es) => (!es || en === es ? en : `${en} / ${es}`);
  const t = (lang, key, vars = {}) => {
    const en = fill(strings.en[key] ?? key, vars);
    if (lang === 'bi') return both(en, fill(strings.es[key] ?? strings.en[key] ?? key, vars));
    return lang === 'es' ? fill(strings.es[key] ?? strings.en[key] ?? key, vars) : en;
  };
  // Free text (job descriptions, line items, what people typed), translated for the reader.
  const trans = (lang, text, raw = false) => {
    if (!text || raw || !tr) return { text: text || '', translated: false };
    const r = tr(text, lang);
    if (!r.translated) return { text, translated: false };
    return { text: lang === 'bi' ? `${r.original} / ${r.text}` : r.text, translated: true };
  };
  const money = (lang, n) => new Intl.NumberFormat(lang === 'es' ? 'es-US' : 'en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0);
  // Times and days are Eastern wherever this runs (the phone, or the API in UTC).
  const time = (lang, iso) => new Intl.DateTimeFormat(lang === 'es' ? 'es-US' : 'en-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  const day = (lang, iso) => new Intl.DateTimeFormat(lang === 'es' ? 'es-US' : 'en-US', { timeZone: TIME_ZONE, weekday: 'short', day: 'numeric' }).format(new Date(iso));
  const sameDay = iso => easternDay(iso) === easternDay(now());
  const pick = (lang, o) => (lang === 'bi' ? both(o?.en ?? '', o?.es ?? '') : o?.[lang] ?? o?.en ?? '');

  const personByPhone = p => store.people.find(x => x.lead?.phone === p);
  const ctxOf = person => ({ role: person.role || 'installer', crewId: person.id, account: person.account || null, rollout: store.rollout });
  const session = person => {
    if (!sessions.has(person.id)) sessions.set(person.id, { lang: person.lang || 'en', list: [], reviews: [], flow: null, confirm: null, lastJob: null });
    else sessions.get(person.id).lang = person.lang || sessions.get(person.id).lang; // follows changes made in the app
    return sessions.get(person.id);
  };
  const wantsText = person => (person.channel || 'both') !== 'app';
  const crewPerson = w => store.people.find(p => p.id === w._crew);
  const pmPeople = () => store.people.filter(p => p.role === 'pm');

  function jobsFor(person) {
    return store.jobs.filter(visibleFor(ctxOf(person))).sort((a, b) => a.StartDate.localeCompare(b.StartDate));
  }
  function resolveJob(person, s, ref) {
    if (!ref) return s.lastJob ? store.jobs.find(j => j.Id === s.lastJob) : null;
    const pool = person.role === 'pm' ? store.jobs.filter(visibleFor(ctxOf(person))) : jobsFor(person);
    if (/^\d{1,2}$/.test(ref) && s.list[Number(ref) - 1]) return store.jobs.find(j => j.Id === s.list[Number(ref) - 1]);
    if (/^\d{4,}$/.test(ref)) return pool.find(j => j.WorkOrderNumber.endsWith(ref.replace(/^0+/, '')) || j.WorkOrderNumber === ref);
    return null;
  }
  const refOf = (s, w) => { const i = s.list.indexOf(w.Id); return i >= 0 ? String(i + 1) : w.WorkOrderNumber; };

  // ---------------------------------------------------------------------------------------- views
  function listText(person, s, heading) {
    const L = s.lang, jobs = jobsFor(person);
    s.list = jobs.map(j => j.Id);
    if (!jobs.length) return t(L, 'txt.none');
    const lines = jobs.map((w, i) => t(L, 'txt.listLine', {
      n: i + 1, when: sameDay(w.StartDate) ? time(L, w.StartDate) : day(L, w.StartDate),
      who: w.Account?.Name || w.Subject, street: w.Street, status: t(L, 'sa.' + visit(w).Status)
    }));
    return [heading || t(L, 'txt.listHead'), ...lines, t(L, person.role === 'measure' ? 'txt.listFootMeasure' : 'txt.listFootInstaller')].join('\n');
  }
  function detailsText(person, s, w, raw = false) {
    const L = s.lang, pm = pmOf(w), doneSt = WOLI_DONE[visitKind(w)];
    s.lastJob = w.Id;
    const subj = trans(L, w.Subject, raw), desc = trans(L, w.Description, raw);
    const lis = (w.WorkOrderLineItems || []).map(li => trans(L, li.Description, raw));
    const items = (w.WorkOrderLineItems || []).map((li, i) => t(L, 'txt.itemLine', { n: i + 1, desc: lis[i].text, q: li.Quantity, mark: li.Status === doneSt ? ' ✔' : '' }));
    const translated = !raw && L !== 'bi' && [subj, desc, ...lis].some(x => x.translated);
    return [
      t(L, 'txt.details', { subject: subj.text, wo: w.WorkOrderNumber, street: w.Street, city: w.City, map: mapsUrl(w), phone: w.Contact?.Phone || '—' }),
      desc.text.slice(0, L === 'bi' ? 560 : 280),
      items.length ? [t(L, 'txt.itemsHead'), ...items].join('\n') : '',
      pm ? t(L, 'txt.pmLine', { name: pm.Name, phone: pm.MobilePhone }) : '',
      translated ? t(L, 'txt.translated', { n: refOf(s, w) }) : ''
    ].filter(Boolean).join('\n');
  }
  function helpText(person, s) { return t(s.lang, 'txt.help.' + (person.role || 'installer')); }

  // ------------------------------------------------------------------------- installer / measure
  function startVisit(person, s, w, out) {
    const L = s.lang, sa = visit(w), ref = refOf(s, w);
    s.lastJob = w.Id;
    if (sa.Status === 'In Progress') return t(L, 'txt.alreadyStarted', { wo: w.WorkOrderNumber });
    if (sa.Status !== 'Dispatched') return t(L, 'txt.notFound', { ref });
    const at = now().toISOString();
    sa.Status = 'In Progress'; sa.ActualStartTime = at;
    out.actions.push({ kind: 'serviceappointment.start', payload: { serviceAppointmentId: sa.Id, Status: 'In Progress', ActualStartTime: at, channel: 'sms' } });
    return t(L, person.role === 'measure' ? 'txt.startedMeasure' : 'txt.started', { wo: w.WorkOrderNumber, n: ref });
  }
  function markItems(person, s, w, args, out) {
    const L = s.lang, sa = visit(w), ref = refOf(s, w), doneSt = WOLI_DONE[visitKind(w)];
    if (sa.Status !== 'In Progress') return t(L, 'txt.startFirst', { n: ref });
    const items = (w.WorkOrderLineItems || []).filter(li => li.Status !== 'Canceled');
    let picks = args.some(a => is(a, 'all')) ? items : args.filter(a => /^\d+$/.test(a)).map(a => items[Number(a) - 1]).filter(Boolean);
    if (!picks.length) return t(L, 'txt.doneWhich', { n: ref });
    for (const li of picks) if (li.Status !== doneSt) {
      li.Status = doneSt;
      out.actions.push({ kind: 'woli.status', payload: { workOrderLineItemId: li.Id, Status: doneSt, channel: 'sms' } });
    }
    const left = items.filter(li => li.Status !== doneSt).length;
    const st = t(L, 'woli.' + doneSt);
    return left ? t(L, 'txt.doneMarked', { items: picks.map(li => items.indexOf(li) + 1).join(', '), status: st, left }) : t(L, 'txt.doneAll', { status: st });
  }
  function finishMeasure(person, s, w, out) {
    const L = s.lang, sa = visit(w), ref = refOf(s, w);
    if (sa.Status !== 'In Progress') return t(L, 'txt.startFirst', { n: ref });
    const left = (w.WorkOrderLineItems || []).filter(li => li.Status !== 'Canceled' && li.Status !== WOLI_DONE.Measurement).length;
    if (left) return t(L, 'txt.finishOpen', { left, n: ref });
    const at = now().toISOString();
    sa.Status = 'Completed'; sa.ActualEndTime = at;
    out.actions.push({ kind: 'serviceappointment.complete', payload: { serviceAppointmentId: sa.Id, Status: 'Completed', ActualEndTime: at, channel: 'sms' } });
    return t(L, 'txt.finished', { wo: w.WorkOrderNumber });
  }

  // Guided "Submit for pay" (and resubmitting what the PM sent back).
  function photoKinds(w) {
    return (store.checklists[tradeKey(w)]?.photos || []).filter(p => p.min > 0);
  }
  function startPay(person, s, w) {
    const L = s.lang, sa = visit(w), ref = refOf(s, w);
    s.lastJob = w.Id;
    const mine = drawsFor(store.draws, w.Id).filter(d => !isDraw(d));
    const back = mine.find(d => drawStatus(d) === 'SentBack');
    // Fixing a sent-back request works even after the visit is done; a new one needs the visit in progress.
    if (!back && sa.Status !== 'In Progress') return t(L, 'txt.startFirst', { n: ref });
    if (!back && mine.some(d => drawStatus(d) === 'WithPM')) return t(L, 'txt.pay.pending', { wo: w.WorkOrderNumber });
    const cl = store.checklists[tradeKey(w)];
    if (back) {
      const missed = manifestOf(back).approval.missed;
      const have = k => (manifestOf(back).photos || []).filter(p => p.kind === k).length;
      const kinds = photoKinds(w).filter(p => missed.some(x => x.item === 'photo:' + p.kind))
        .map(p => ({ ...p, min: Math.max(1, p.min - have(p.kind)) }));
      s.flow = { type: 'pay', w: w.Id, resubmit: back.Id, kinds, k: 0, got: {},
        needChecklist: missed.some(x => x.item === 'checklist'), needDesc: missed.some(x => x.item === 'scope'),
        needItems: missed.some(x => x.item === 'lineItems'), total: cl?.steps?.length || 0 };
      const intro = t(L, 'txt.pay.resubmitIntro', { items: missed.map(x => x.text).join('; ') });
      return intro + '\n' + nextPayPrompt(person, s);
    }
    s.flow = { type: 'pay', w: w.Id, step: 'amount', kinds: photoKinds(w), k: 0, got: {}, skipped: [], total: cl?.steps?.length || 0,
      needChecklist: true, needDesc: true, needItems: true };
    const max = contractAmount(w) ? remaining(w) : 0;
    return max ? t(L, 'txt.pay.amount', { wo: w.WorkOrderNumber, max: money(L, max) }) : t(L, 'txt.pay.amountOpen', { wo: w.WorkOrderNumber });
  }
  function nextPayPrompt(person, s) {
    const f = s.flow, L = s.lang, w = store.jobs.find(j => j.Id === f.w);
    if (!f.resubmit && f.amount == null) { f.step = 'amount'; return t(L, 'txt.pay.amountBad', { max: money(L, remaining(w)) }); }
    if (f.k < f.kinds.length) { f.step = 'photos'; const p = f.kinds[f.k]; return t(L, 'txt.pay.photo', { need: p.min, label: pick(L, p) }); }
    if (f.needChecklist && f.checklistDone == null) { f.step = 'checklist'; return t(L, 'txt.pay.checklist', { n: f.total }); }
    const doneSt = WOLI_DONE.Installation;
    const items = (w.WorkOrderLineItems || []).filter(li => li.Status !== 'Canceled');
    if (f.needItems && !f.itemsAsked && items.some(li => li.Status !== doneSt)) {
      f.step = 'items';
      return t(L, 'txt.pay.items', { items: items.map((li, i) => t(L, 'txt.itemLine', { n: i + 1, desc: li.Description, q: li.Quantity, mark: li.Status === doneSt ? ' ✔' : '' })).join('\n') });
    }
    if (f.needDesc && f.desc == null) { f.step = 'desc'; return t(L, 'txt.pay.desc'); }
    f.step = 'confirm';
    const photos = Object.values(f.got).reduce((a, b) => a + b, 0);
    const itemsDone = items.filter(li => li.Status === doneSt).length;
    return t(L, f.resubmit ? 'txt.pay.confirmResubmit' : 'txt.pay.confirm', {
      amount: money(L, f.amount ?? drawAmount(store.draws.find(d => d.Id === f.resubmit))), who: w.Account?.Name || '', wo: w.WorkOrderNumber,
      photos, done: f.checklistDone ?? f.total, total: f.total, items: items.length ? `${itemsDone}/${items.length}` : '—'
    });
  }
  function payStep(person, s, words, body, media, out) {
    const f = s.flow, L = s.lang, w = store.jobs.find(j => j.Id === f.w);
    const w0 = words[0] || '';
    if (f.step === 'amount') {
      const m = body.replace(/,/g, '').match(/\$?\s*(\d+(?:\.\d+)?)/);
      const amt = m ? Math.round(Number(m[1])) : NaN;
      const max = contractAmount(w) ? remaining(w) : Infinity;
      if (!(amt > 0 && amt <= max)) return t(L, 'txt.pay.amountBad', { max: money(L, remaining(w)) });
      f.amount = amt;
      return nextPayPrompt(person, s);
    }
    if (f.step === 'photos') {
      const p = f.kinds[f.k];
      if (media.length) {
        f.got[p.kind] = (f.got[p.kind] || 0) + media.length;
        (f.media ||= []).push(...media.map(url => ({ kind: p.kind, url })));
        if (f.got[p.kind] >= p.min) { f.k++; return t(L, 'txt.pay.photoGot', { have: f.got[p.kind], need: p.min, label: pick(L, p) }) + '\n' + nextPayPrompt(person, s); }
        return t(L, 'txt.pay.photoGot', { have: f.got[p.kind], need: p.min, label: pick(L, p) });
      }
      if (is(w0, 'next') || is(w0, 'yes')) {
        const more = p.min - (f.got[p.kind] || 0);
        if (more > 0) return t(L, 'txt.pay.photoShort', { more, label: pick(L, p) });
        f.k++; return nextPayPrompt(person, s);
      }
      return t(L, 'txt.pay.photo', { need: p.min, label: pick(L, p) });
    }
    if (f.step === 'checklist') {
      const cl = store.checklists[tradeKey(w)];
      if (is(w0, 'steps')) return cl.steps.map((st, i) => `${i + 1}) ${pick(L, st)}`).join('\n');
      if (is(w0, 'yes')) { f.checklistDone = f.total; f.done = cl.steps.map(x => x.id); return nextPayPrompt(person, s); }
      const skipped = words.filter(x => /^\d+$/.test(x)).map(Number).filter(n => n >= 1 && n <= f.total);
      if (!skipped.length) return t(L, 'txt.pay.checklist', { n: f.total });
      f.done = cl.steps.filter((_, i) => !skipped.includes(i + 1)).map(x => x.id);
      f.checklistDone = f.done.length;
      return t(L, 'txt.pay.checklistShort') + '\n' + nextPayPrompt(person, s);
    }
    if (f.step === 'items') {
      const doneSt = WOLI_DONE.Installation;
      const items = (w.WorkOrderLineItems || []).filter(li => li.Status !== 'Canceled');
      const notDone = is(w0, 'yes') ? [] : words.filter(x => /^\d+$/.test(x)).map(n => items[Number(n) - 1]).filter(Boolean);
      if (!is(w0, 'yes') && !notDone.length) return nextPayPrompt(person, s);
      for (const li of items) if (!notDone.includes(li) && li.Status !== doneSt) {
        li.Status = doneSt; out.actions.push({ kind: 'woli.status', payload: { workOrderLineItemId: li.Id, Status: doneSt, channel: 'sms' } });
      }
      f.itemsAsked = true;
      return (notDone.length ? t(L, 'txt.pay.itemsWarn') + '\n' : '') + nextPayPrompt(person, s);
    }
    if (f.step === 'desc') { f.desc = body.trim(); return nextPayPrompt(person, s); }
    if (f.step === 'confirm') {
      if (!is(w0, 'yes')) return nextPayPrompt(person, s);
      return f.resubmit ? resubmitPay(person, s, w, out) : createPay(person, s, w, out);
    }
    return nextPayPrompt(person, s);
  }
  function createPay(person, s, w, out) {
    const f = s.flow, L = s.lang, sa = visit(w), at = now().toISOString(), pm = pmOf(w);
    const manifest = { v: 1, app: 'vista', kind: 'completion', channel: 'sms', lang: L, submitted_at: at,
      submitted_by: { phone: person.lead.phone, name: person.lead.name }, checklist: { id: store.checklists[tradeKey(w)]?.id, done: f.done || [] },
      photos: (f.media || []).map(m => ({ kind: m.kind, source: m.url })) };
    const d = { Id: 'sms-' + Date.now(), Name: '…', CreatedDate: at, Date__c: at.slice(0, 10), _crew: w._crew, _lang: L,
      Type__c: 'Vista', Status__c: 'New', Expense_Type__c: 'Labour', Amount__c: f.amount, Work_Order__c: w.Id, Job__c: w.Job_Number__c,
      Service_Appointment__c: sa.Id, Did_you_complete_the_job_or_service__c: 'Yes', Additional_Work_Performed__c: 'No', TEST_SA__c: false,
      Description_of_Work_Performed__c: f.desc, [MANIFEST_FIELD]: MANIFEST_MARK + JSON.stringify(manifest) };
    store.draws.push(d);
    out.actions.push({ kind: 'payrequest.create', payload: { workOrderId: w.Id, serviceAppointmentId: sa.Id, Amount__c: f.amount, description: f.desc, manifest, channel: 'sms' } });
    s.flow = null;
    for (const p of pmPeople()) if (wantsText(p)) out.replies.push({ to: p.lead.phone, text: t(session(p).lang, 'txt.notice.newReview', { who: w.Account?.Name || '', amount: money(session(p).lang, f.amount), crew: w._crewName || '' }) });
    return t(L, 'txt.pay.sent', { pm: pm?.Name || 'PM' });
  }
  function resubmitPay(person, s, w, out) {
    const f = s.flow, L = s.lang, at = now().toISOString(), d = store.draws.find(x => x.Id === f.resubmit), m = manifestOf(d);
    m.photos = [...(m.photos || []), ...(f.media || []).map(x => ({ kind: x.kind, source: x.url }))];
    if (f.done) m.checklist = { ...(m.checklist || {}), done: f.done };
    if (f.desc != null) d.Description_of_Work_Performed__c = f.desc;
    m.resubmitted_at = at;
    d[MANIFEST_FIELD] = MANIFEST_MARK + JSON.stringify(m);
    out.actions.push({ kind: 'payrequest.resubmit', payload: { expenseId: d.Id, manifest: m, description: d.Description_of_Work_Performed__c, channel: 'sms' } });
    s.flow = null;
    for (const p of pmPeople()) if (wantsText(p)) out.replies.push({ to: p.lead.phone, text: t(session(p).lang, 'txt.notice.newReview', { who: w.Account?.Name || '', amount: money(session(p).lang, d.Amount__c), crew: w._crewName || '' }) });
    return t(L, 'txt.pay.resent', { pm: pmOf(w)?.Name || 'PM' });
  }

  // ----------------------------------------------------------------------------------------- PM
  function reviewList(person, s) {
    const L = s.lang, q = pendingReview(store.draws);
    s.reviews = q.map(d => d.Id);
    if (!q.length) return t(L, 'txt.pm.none');
    const lines = q.map((d, i) => { const w = store.jobs.find(j => j.Id === d.Work_Order__c); return t(L, 'txt.pm.listLine', { n: i + 1, who: w?.Account?.Name || d.Name, amount: money(L, drawAmount(d)), crew: w?._crewName || '' }); });
    return t(L, 'txt.pm.list', { n: q.length, lines: lines.join('\n') });
  }
  const reviewRef = (s, ref) => { const id = s.reviews[Number(ref || 1) - 1]; return id && store.draws.find(d => d.Id === id); };
  function lineLabel(L, l, d) {
    return {
      photo: () => t(L, 'review.photo', { label: pick(L, l.label), have: l.have, need: l.need }),
      checklist: () => t(L, 'review.checklist', { have: l.have, need: l.need }),
      scope: () => t(L, 'review.scope'),
      complete: () => t(L, 'review.complete') + ` · ${t(L, l.value === 'Yes' ? 'yes' : 'no')}`,
      lineItems: () => t(L, 'review.lineItems', { have: l.have, need: l.need }),
      amount: () => t(L, 'review.amount', { amount: money(L, l.amount), room: money(L, l.room) }),
      additional: () => t(L, 'review.additional')
    }[l.kind]();
  }
  function reviewText(person, s, ref) {
    const L = s.lang, d = reviewRef(s, ref);
    if (!d) return reviewList(person, s);
    const w = store.jobs.find(j => j.Id === d.Work_Order__c), lines = reviewLines(d, w, store.checklists[tradeKey(w)]);
    return t(L, 'txt.pm.review', {
      who: w.Account?.Name || '', wo: w.WorkOrderNumber, amount: money(L, drawAmount(d)), crew: w._crewName || '', n: ref || 1,
      desc: trans(L, d.Description_of_Work_Performed__c || '—').text.slice(0, L === 'bi' ? 400 : 200), link: photosLink(d),
      lines: lines.map((l, i) => `${i + 1}) ${l.ok ? '✔' : '✖'} ${lineLabel(L, l, d)}`).join('\n')
    });
  }
  function askApprove(person, s, ref) {
    const L = s.lang, d = reviewRef(s, ref);
    if (!d) return reviewList(person, s);
    const w = store.jobs.find(j => j.Id === d.Work_Order__c), lines = reviewLines(d, w, store.checklists[tradeKey(w)]);
    const short = lines.map((l, i) => (l.ok ? null : i + 1)).filter(Boolean);
    if (short.length) return t(L, 'txt.pm.blocked', { lines: short.join(' '), n: ref || 1 });
    s.confirm = { kind: 'approve', id: d.Id };
    return [t(L, 'confirm.payTitle'), `${money(L, drawAmount(d))} · ${w.Account?.Name || ''} · WO ${w.WorkOrderNumber}`, t(L, 'txt.pm.replyYesPay', { k: lines.length })].join('\n');
  }
  function approve(person, s, id, out) {
    const L = s.lang, d = store.draws.find(x => x.Id === id), w = store.jobs.find(j => j.Id === d.Work_Order__c);
    const lines = reviewLines(d, w, store.checklists[tradeKey(w)]), at = now().toISOString(), m = manifestOf(d) || {};
    const approval = { by: person.lead.name, at, decision: 'submitted', channel: 'sms', checked: lines.map(l => l.id), missed: [] };
    d.Status__c = 'Approved'; d.Approver__c = person.lead.name; d[MANIFEST_FIELD] = MANIFEST_MARK + JSON.stringify({ ...m, approval });
    out.actions.push({ kind: 'payrequest.approve', payload: { expenseId: d.Id, Status__c: 'Approved', Approver__c: person.lead.name, approval, channel: 'sms' } });
    const crew = crewPerson(w);
    if (crew && wantsText(crew)) { const cl = session(crew).lang; out.replies.push({ to: crew.lead.phone, text: t(cl, 'txt.notice.approved', { amount: money(cl, drawAmount(d)), wo: w.WorkOrderNumber }) }); }
    return t(L, 'txt.pm.approved', { amount: money(L, drawAmount(d)), wo: w.WorkOrderNumber });
  }
  function sendBack(person, s, args, out) {
    const L = s.lang, d = reviewRef(s, args[0]);
    if (!d) return reviewList(person, s);
    const w = store.jobs.find(j => j.Id === d.Work_Order__c), lines = reviewLines(d, w, store.checklists[tradeKey(w)]);
    const reason = Object.entries(REASONS).find(([k]) => args.includes(k))?.[1] || 'missing';
    const picked = new Set(args.slice(1).filter(a => /^\d+$/.test(a)).map(Number));
    lines.forEach((l, i) => { if (!l.ok) picked.add(i + 1); });
    if (!picked.size) return t(L, 'txt.pm.fixWhich', { n: args[0] || 1 });
    const crew = crewPerson(w), il = crew ? session(crew).lang : (w._lang || 'en');
    const pickedLines = [...picked].sort((a, b) => a - b).map(i => lines[i - 1]).filter(Boolean);
    const missed = pickedLines.map(l => ({ item: l.id, reason, text: `${lineLabel(il, l, d)} — ${t(il, 'reason.' + reason)}` }));
    const at = now().toISOString(), m = manifestOf(d) || {};
    const approval = { by: person.lead.name, at, decision: 'sent_back', channel: 'sms', checked: lines.filter((l, i) => !picked.has(i + 1)).map(l => l.id), missed };
    d[MANIFEST_FIELD] = MANIFEST_MARK + JSON.stringify({ ...m, approval });
    out.actions.push({ kind: 'payrequest.sendBack', payload: { expenseId: d.Id, approval, channel: 'sms' } });
    if (crew && wantsText(crew)) out.replies.push({ to: crew.lead.phone, text: t(il, 'txt.notice.sentBack', { wo: w.WorkOrderNumber, items: missed.map(x => x.text).join('; '), ref: w.WorkOrderNumber.slice(-5) }) });
    return t(L, 'txt.pm.sentBack', { crew: w._crewName || '', items: pickedLines.map(l => `${lineLabel(L, l, d)} — ${t(L, 'reason.' + reason)}`).join('; ') });
  }
  function askDraw(person, s, args) {
    const L = s.lang;
    const [ref, amt, ...rest] = args;
    const w = ref && resolveJob(person, s, ref);
    const amount = Math.round(Number(String(amt || '').replace(/[$,]/g, '')));
    if (!w || !(amount > 0) || !rest.length) return t(L, 'txt.pm.drawUsage');
    const rules = store.drawRules || {};
    const elig = drawEligible(w, rules);
    if (!elig.ok) return t(L, 'txt.pm.drawNo', { wo: w.WorkOrderNumber, why: t(L, 'draw.notEligible.' + elig.why) });
    const need = rules.requireProgressPhotos ?? 1, have = w._progressPhotos || 0;
    if (have < need) return t(L, 'txt.pm.drawNo', { wo: w.WorkOrderNumber, why: t(L, 'draw.photosNeeded', { n: have, need }) });
    if (amount > remaining(w)) return t(L, 'draw.upTo', { amount: money(L, remaining(w)) });
    const covers = rest.join(' ');
    s.confirm = { kind: 'draw', w: w.Id, amount, covers };
    return [t(L, 'confirm.drawTitle'), `${money(L, amount)} · ${w.Account?.Name || ''} · WO ${w.WorkOrderNumber}`,
      `${t(L, 'confirm.requestedBy')}: ${visit(w)?.Lead_Installer || '—'}`, `${t(L, 'confirm.covers')}: ${covers}`, t(L, 'txt.pm.replyYesDraw')].join('\n');
  }
  function issueDraw(person, s, c, out) {
    const L = s.lang, w = store.jobs.find(j => j.Id === c.w), sa = visit(w), at = now().toISOString();
    const manifest = { v: 1, app: 'vista', kind: 'draw', channel: 'sms', lang: w._lang || 'en', issued_by: person.lead.name, requested_by: sa?.Lead_Installer || '', issued_at: at,
      photos: Array.from({ length: w._progressPhotos || 0 }, () => ({ kind: 'progress' })) };
    store.draws.push({ Id: 'sms-draw-' + Date.now(), Name: '…', CreatedDate: at, Date__c: at.slice(0, 10), _crew: w._crew, _lang: w._lang,
      Type__c: 'Vista', Status__c: 'Approved', Approver__c: person.lead.name, Expense_Type__c: 'Labour', Amount__c: c.amount, Work_Order__c: w.Id,
      Job__c: w.Job_Number__c, Service_Appointment__c: sa?.Id, Did_you_complete_the_job_or_service__c: 'No', TEST_SA__c: false,
      Description_of_Work_Performed__c: c.covers, [MANIFEST_FIELD]: MANIFEST_MARK + JSON.stringify(manifest) });
    if (w.Job_Number__r) w.Job_Number__r.Total_SA_Expense_Labor__c = (w.Job_Number__r.Total_SA_Expense_Labor__c || 0) + c.amount;
    out.actions.push({ kind: 'draw.issue', payload: { workOrderId: w.Id, serviceAppointmentId: sa?.Id, Amount__c: c.amount, covers: c.covers, requested_by: manifest.requested_by, Approver__c: person.lead.name, channel: 'sms' } });
    return t(L, 'draw.issued');
  }

  // ---------------------------------------------------------------------------------------- entry
  async function handle(from, body = '', media = []) {
    const out = { replies: [], actions: [] };
    const reply = text => out.replies.unshift({ to: from, text });
    const person = personByPhone(from);
    if (!person) { reply(`${t('en', 'txt.unknownNumber')}\n${t('es', 'txt.unknownNumber')}`); return out; }
    const s = session(person), L = () => s.lang;
    const words = norm(body).split(/[\s,]+/).filter(Boolean), w0 = words[0] || '', args = words.slice(1);

    // Language and channel switches work at any time. One setting per person, shared with the app.
    const setLang = lang => { s.lang = lang; person.lang = lang; out.actions.push({ kind: 'person.prefs', payload: { personId: person.id, lang } }); reply(t(lang, lang === 'bi' ? 'txt.langBi' : 'txt.lang')); return out; };
    if (is(w0, 'en') && !args.length) return setLang('en');
    if (is(w0, 'es') && !args.length) return setLang('es');
    if (is(w0, 'bi') || (w0 === 'ambos' && args[0] === 'idiomas') || (w0 === 'both' && args[0] === 'languages')) return setLang('bi');
    if (is(w0, 'langReq')) {
      const language = body.trim().split(/\s+/).slice(1).join(' ');
      if (!language) { reply(t(L(), 'txt.langOptions')); return out; }
      if (['english', 'ingles'].includes(norm(language))) return setLang('en');
      if (['espanol', 'spanish'].includes(norm(language))) return setLang('es');
      person.requested = language;
      out.actions.push({ kind: 'language.request', payload: { personId: person.id, name: person.lead.name, language, channel: 'sms' } });
      reply(t(L(), 'lang.requested', { language })); return out;
    }
    if (words.length === 1 && (is(w0, 'chApp') || is(w0, 'chText') || is(w0, 'chBoth'))) {
      person.channel = is(w0, 'chApp') ? 'app' : is(w0, 'chText') ? 'text' : 'both';
      out.actions.push({ kind: 'person.channel', payload: { phone: from, channel: person.channel } });
      reply(t(L(), 'txt.channel.' + person.channel)); return out;
    }
    if (is(w0, 'help')) { reply(helpText(person, s)); return out; }

    // Rollout: crews that aren't on Vista keep today's process.
    const ctx = ctxOf(person);
    if (ctx.role !== 'pm' && !store.jobs.some(w => assignedTo(ctx, w) && onVista(ctx, w))) { reply(t(L(), 'txt.off')); return out; }

    // Pending "Are you sure?" confirmation.
    if (s.confirm) {
      const c = s.confirm; s.confirm = null;
      if (is(w0, 'yes') && !args.length) { reply(c.kind === 'approve' ? approve(person, s, c.id, out) : issueDraw(person, s, c, out)); return out; }
      if (is(w0, 'no')) { reply(t(L(), 'txt.cancelled')); return out; }
    }
    // Guided pay flow.
    if (s.flow) {
      if (is(w0, 'no') && words.length === 1) { s.flow = null; reply(t(L(), 'txt.cancelled')); return out; }
      reply(payStep(person, s, words, body, media, out)); return out;
    }
    if (media.length) { reply(t(L(), 'txt.photoNoFlow')); return out; }
    if (is(w0, 'yes') && !args.length) { reply(t(L(), 'txt.nothingToConfirm')); return out; }

    if (person.role === 'pm') {
      if (is(w0, 'today') || is(w0, 'review') && !args.length) { reply(reviewList(person, s)); return out; }
      if (is(w0, 'review')) { reply(reviewText(person, s, args[0])); return out; }
      if (is(w0, 'approve')) { reply(askApprove(person, s, args[0])); return out; }
      if (is(w0, 'fix')) { reply(sendBack(person, s, args, out)); return out; }
      if (is(w0, 'draw')) { reply(askDraw(person, s, args)); return out; }
    } else {
      if (is(w0, 'today')) { reply(listText(person, s)); return out; }
      if (/^\d{1,2}$/.test(w0) && !args.length) { const w = resolveJob(person, s, w0); reply(w ? detailsText(person, s, w) : t(L(), 'txt.notFound', { ref: w0 })); return out; }
      if (is(w0, 'original')) { const w = resolveJob(person, s, args[0]); reply(w ? detailsText(person, s, w, true) : t(L(), 'txt.notFound', { ref: args[0] || '' })); return out; }
      if (is(w0, 'draw')) { const w = resolveJob(person, s, args[0]) || jobsFor(person)[0]; const pm = w && pmOf(w); reply(t(L(), 'txt.drawAsk', { name: pm?.Name || 'PM', phone: pm?.MobilePhone || '' })); return out; }
      const verb = ['start', 'done', 'finish', 'pay'].find(k => is(w0, k));
      if (verb) {
        if (verb === 'pay' && person.role === 'measure') { reply(helpText(person, s)); return out; }
        const w = resolveJob(person, s, args[0]);
        if (!w) { reply(args[0] ? t(L(), 'txt.notFound', { ref: args[0] }) : listText(person, s)); return out; }
        if (verb === 'start') reply(startVisit(person, s, w, out));
        else if (verb === 'done') reply(markItems(person, s, w, args.slice(1), out));
        else if (verb === 'finish') reply(finishMeasure(person, s, w, out));
        else reply(startPay(person, s, w));
        return out;
      }
    }
    // Anything else is a question for Vi, about the job in focus.
    const job = s.lastJob ? store.jobs.find(j => j.Id === s.lastJob) : null;
    out.actions.push({ kind: 'vi.ask', payload: { phone: from, lang: L(), viLanguage: person.requested || null, workOrderId: job?.Id || null, question: body } });
    // Vi answers in the person's language, or in a language they asked for that Vista doesn't have yet.
    const answer = askVi ? await askVi({ person, lang: L(), viLanguage: person.requested || null, job, question: body }) : t(L(), 'txt.viSoon');
    reply(`Vi: ${answer}`);
    return out;
  }

  // Scheduled texts (the API's cron calls these).
  function morningDigest(person) {
    const s = session(person);
    if ((person.channel || 'both') === 'app') return null;
    const jobs = jobsFor(person).filter(w => sameDay(w.StartDate));
    if (!jobs.length) return null;
    return listText(person, s, t(s.lang, 'txt.digest', { name: person.lead.name.split(' ')[0] }));
  }
  function pmDigest(person) {
    const s = session(person);
    if ((person.channel || 'both') === 'app' || !pendingReview(store.draws).length) return null;
    return reviewList(person, s);
  }
  return { handle, morningDigest, pmDigest, sessions };
}
