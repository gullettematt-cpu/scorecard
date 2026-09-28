// Ask Vi: a short conversation about one job (or a general question). Vi answers from the job record,
// its line items, open problems, pay status and the trade checklist, in the person's language. When the
// person describes something wrong, Vi offers a problem report, pre-filled; the person decides whether
// to send it. Live: POST /vi/ask. Demo: sample answers built from the job data, clearly marked.
import { t, lang, pick, fmtMoney } from '../i18n.js';
import { db } from '../db.js';
import { apiMode, api } from '../api.js';
import { visibleFor, visit, checklistFor, tradeKey, pmOf, drawsFor, drawStatus, isDraw, casesFor, WOLI_DONE } from '../data.js';
import { esc, icons } from '../ui.js';
import { header } from '../app.js';

const KEEP = 20;           // turns kept on the phone per job
const HISTORY = 6;         // turns sent with each question
const storeKey = jobId => `vi:${jobId || 'general'}`;

export async function renderVi(root, ctx, jobId) {
  const jobs = (await db.all('jobs')).filter(visibleFor(ctx));
  if (jobId === undefined || jobId === null) {
    const guess = jobs.find(j => j.Id === ctx.lastJob) || jobs.find(j => visit(j)?.Status === 'In Progress') || jobs[0];
    jobId = guess?.Id || '';
  }
  const w = jobs.find(j => j.Id === jobId) || null;
  let turns = (await db.meta(storeKey(w?.Id))) || [];
  let pending = null, error = '';
  const cl = w ? await checklistFor(tradeKey(w)) : null;

  const suggestions = () => {
    if (!w) return [t('vi.s.general1'), t('vi.s.general2')];
    const trade = tradeKey(w);
    return ctx.role === 'pm'
      ? [t('vi.s.pmStatus'), t('vi.s.pmPay'), t('vi.s.left')]
      : [t('vi.s.photos'), t('vi.s.left'), t('vi.s.pm'), t(trade === 'siding' ? 'vi.s.howSiding' : 'vi.s.howWindows')];
  };
  const bubble = (who, text, extra = '') => `<div class="bubble ${who}"><p>${esc(text)}</p>${extra}</div>`;

  function draw() {
    const online = navigator.onLine || !apiMode;
    root.innerHTML = `${header(ctx, `
      <div class="jobhead"><h1>${esc(t('vi.title'))}</h1></div>
      <label class="vi-job"><span>${esc(t('vi.about'))}</span>
        <select id="viJob"><option value="">${esc(t('vi.general'))}</option>
          ${jobs.map(j => `<option value="${esc(j.Id)}" ${w?.Id === j.Id ? 'selected' : ''}>${esc(j.Account?.Name || '')} · WO ${esc(j.WorkOrderNumber)}</option>`).join('')}</select></label>`)}
      <section class="sec vi">
        ${!apiMode ? `<div class="hint demo">${esc(t('vi.demoNote'))}</div>` : ''}
        <div class="vi-thread" id="viThread" aria-live="polite">
          ${turns.length || pending ? '' : `<div class="vi-empty"><p>${esc(t(w ? 'vi.emptyJob' : 'vi.emptyGeneral'))}</p>
            <div class="vi-suggest">${suggestions().map(s => `<button type="button" class="suggest" data-q="${esc(s)}">${esc(s)}</button>`).join('')}</div></div>`}
          ${turns.map(tn => bubble('me', tn.q) + bubble('vi', tn.a, `${tn.demo ? `<small class="tag">${esc(t('vi.sample'))}</small>` : ''}${tn.problem && w ? `<a class="act problem-offer" href="#/problem?job=${esc(w.Id)}&subject=${encodeURIComponent(tn.problem.summary)}">${icons.alert} ${esc(t('vi.reportIt'))}<small>${esc(tn.problem.summary)}</small></a>` : ''}`)).join('')}
          ${pending ? bubble('me', pending) + `<div class="bubble vi thinking"><p>${esc(t('vi.thinking'))}</p></div>` : ''}
          ${error ? `<div class="blockers vi-error">${esc(error)}</div>` : ''}
        </div>
        ${turns.length ? `<button type="button" class="linkbtn" id="viClear">${esc(t('vi.newChat'))}</button>` : ''}
        <p class="hint vi-fine">${esc(t('vi.fine'))}</p>
      </section>
      <form class="vi-compose" id="viForm">
        <textarea id="viQ" rows="1" maxlength="2000" placeholder="${esc(t(online ? 'vi.placeholder' : 'vi.offline'))}" ${pending ? 'disabled' : ''}></textarea>
        <button class="act primary" id="viSend" ${pending || !online ? 'disabled' : ''} aria-label="${esc(t('vi.send'))}">${icons.vi}</button>
      </form>`;
    const q = root.querySelector('#viQ');
    q.value = draftText;
    q.oninput = () => { draftText = q.value; q.style.height = 'auto'; q.style.height = Math.min(q.scrollHeight, 140) + 'px'; };
    q.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); root.querySelector('#viForm').requestSubmit(); } };
    root.querySelector('#viForm').onsubmit = e => { e.preventDefault(); send(q.value); };
    root.querySelectorAll('.suggest').forEach(b => b.onclick = () => send(b.dataset.q));
    root.querySelector('#viJob').onchange = e => { location.hash = `#/vi?job=${e.target.value}`; };
    root.querySelector('#viClear')?.addEventListener('click', async () => { turns = []; await db.meta(storeKey(w?.Id), []); draw(); });
    const thread = root.querySelector('#viThread'); thread.lastElementChild?.scrollIntoView({ block: 'end' });
  }
  let draftText = '';

  async function send(text) {
    const question = String(text || '').trim();
    if (!question || pending) return;
    const here = location.hash; // if they leave while Vi answers, save the answer but don't draw over the new screen
    pending = question; draftText = ''; error = ''; draw();
    try {
      const res = apiMode
        ? await api.ask(w?.Id || null, question, turns.slice(-HISTORY).map(({ q, a }) => ({ q, a })))
        : await sampleAnswer({ ctx, w, cl, question });
      turns = [...turns, { q: question, a: res.answer, problem: res.problem || null, demo: !apiMode, at: new Date().toISOString() }].slice(-KEEP);
      await db.meta(storeKey(w?.Id), turns);
    } catch (e) {
      draftText = question; // keep what they typed
      error = t(e.status === 429 ? 'vi.limit' : e.status === 403 ? 'vi.notYourJob' : 'vi.error');
    }
    pending = null;
    if (location.hash !== here) return;
    draw();
    root.querySelector('#viQ')?.focus();
  }
  draw();
}

// Demo mode: answers built from the job data for the common questions, so the screen can be tried without
// the live API. Marked "Sample answer" on screen.
async function sampleAnswer({ ctx, w, cl, question }) {
  await new Promise(r => setTimeout(r, 500));
  const q = question.toLowerCase(), L = lang();
  const both = (en, es) => (L === 'es' ? es : L === 'bi' ? `${en}\n\n${es}` : en);
  const has = (...words) => words.some(x => q.includes(x));
  if (has('cutoff', 'corte')) return { answer: both('Pay approved by your PM by 10:00 AM Eastern on a weekday goes in that day\'s ACH run. After that, it\'s the next business day.', 'El pago que su PM apruebe antes de las 10:00 a.m. (hora del Este) en un día de semana va en el pago ACH de ese día. Después, al siguiente día hábil.') };
  if (has('language', 'idioma', 'spanish', 'español')) return { answer: both('Tap 🌐 at the top of the screen and pick English, Español or both. Your texts follow the same choice.', 'Toque 🌐 arriba en la pantalla y escoja English, Español o ambos. Sus textos siguen la misma opción.') };
  if (!w) return { answer: both('Pick a job at the top and I can answer from its record, line items and checklist. For anything about money or safety, call your PM.', 'Elija un trabajo arriba y le contesto con su registro, partidas y lista. Para dinero o seguridad, llame a su PM.') };
  const pm = pmOf(w);
  if (has('rot', 'podrid', 'damage', 'daño', 'broken', 'roto', 'leak', 'fuga', 'crack', 'grieta', 'soft', 'blando')) {
    return { answer: both('Stop work on that spot and take photos before you cover anything. Don\'t close it up until the PM has seen it. Send a problem report so the office can plan the fix.', 'Pare el trabajo en ese lugar y tome fotos antes de cubrir nada. No lo cierre hasta que el PM lo vea. Envíe un reporte de problema para que la oficina planee el arreglo.'),
      problem: { summary: question.replace(/[?¿!¡.]+$/, '').slice(0, 100) } };
  }
  if (has('photo', 'foto', 'picture', 'paid', 'pago', 'cobr')) {
    const shots = (cl?.photos || []).filter(p => p.min).map(p => `• ${L === 'es' ? p.es : p.en}: ${p.min}+`).join('\n');
    return { answer: both(`To get paid on this job you need:\n${shots}\nTake them in Pay; Submit unlocks when every one is in.`, `Para cobrar este trabajo necesita:\n${shots}\nTómelas en Cobrar; Enviar se desbloquea cuando estén todas.`) };
  }
  if (has('left', 'falta', 'finish', 'terminar', 'line item', 'partida', 'remaining', 'pendiente')) {
    const done = WOLI_DONE[visit(w)?.SS_Service_Appointment_Type__c === 'Measurement' ? 'Measurement' : 'Installation'];
    const open = (w.WorkOrderLineItems || []).filter(li => li.Status !== done && li.Status !== 'Canceled');
    const list = open.map(li => `• ${li.Description} ×${li.Quantity}`).join('\n');
    return { answer: open.length ? both(`Still open on WO ${w.WorkOrderNumber}:\n${list}`, `Todavía abierto en WO ${w.WorkOrderNumber}:\n${list}`) : both('Every line item is marked done. Next step is Submit for pay.', 'Todas las partidas están listas. Lo siguiente es Enviar para cobro.') };
  }
  if (has('pm', 'manager', 'who', 'quién', 'call', 'llam')) {
    return { answer: pm ? both(`Your PM on this job is ${pm.Name}${pm.MobilePhone ? `, ${pm.MobilePhone}` : ''}.`, `Su PM en este trabajo es ${pm.Name}${pm.MobilePhone ? `, ${pm.MobilePhone}` : ''}.`) : both('There\'s no PM on this job record. Ask the office.', 'Este trabajo no tiene PM en el registro. Pregunte en la oficina.') };
  }
  if (has('status', 'estado', 'waiting', 'espera')) {
    const pays = drawsFor(await db.all('draws'), w.Id);
    const cases = casesFor(await db.all('cases'), w);
    const payLine = pays.length ? pays.map(d => `${isDraw(d) ? 'Draw' : 'Pay'} ${fmtMoney(d.Amount__c)}: ${t('draw.' + drawStatus(d))}`).join('; ') : t('draw.none');
    return { answer: both(`Visit: ${visit(w)?.Status}. Pay: ${payLine}. Open problems: ${cases.length}.`, `Visita: ${visit(w)?.Status}. Pago: ${payLine}. Problemas abiertos: ${cases.length}.`) };
  }
  if (has('flash', 'sell', 'wrap', 'membrana', 'how', 'cómo', 'como')) {
    const steps = (cl?.steps || []).slice(0, 5).map((s, i) => `${i + 1}. ${pick(s)}`).join('\n');
    return { answer: both(`From the ${tradeKey(w)} checklist:\n${steps}\nFollow the manufacturer's sequence for the product on this order.`, `De la lista de ${tradeKey(w) === 'siding' ? 'revestimiento' : 'ventanas'}:\n${steps}\nSiga la secuencia del fabricante para el producto de esta orden.`) };
  }
  return { answer: both('In the live app, Vi answers this from the job record, the checklist and the trade documents. Try asking what photos you need, what\'s left, or who your PM is.', 'En la app real, Vi contesta esto con el registro del trabajo, la lista y los documentos del oficio. Pruebe preguntar qué fotos necesita, qué falta o quién es su PM.') };
}
