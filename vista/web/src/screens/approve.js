// Approve (PMs): review each Vista draw as a deliverables checklist.
// Submit to accounting only when every required line is ticked; unticked lines become "what was missed",
// sent to the installer in their language at the daily cutoff. See docs/approval-flow.md.
import { t, tIn, pick, fmtDate, fmtMoney, moneyIn, lang } from '../i18n.js';
import { db } from '../db.js';
import { pendingReview, reviewLines, checklistFor, tradeKey, manifestOf, photoCount, drawAmount, MANIFEST_FIELD, MANIFEST_MARK } from '../data.js';
import { enqueue } from '../sync.js';
import { esc, icons, toast } from '../ui.js';
import { header } from '../app.js';

const REASONS = ['missing', 'unclear', 'mismatch', 'incomplete'];

async function lineText(l, line, w, reason) {
  const base = {
    photo: () => tIn(l, 'review.photo', { label: line.label[l] || line.label.en, have: line.have, need: line.need }),
    checklist: () => tIn(l, 'review.checklist', { have: line.have, need: line.need }),
    scope: () => tIn(l, 'review.scope'),
    complete: () => tIn(l, 'review.complete'),
    amount: () => tIn(l, 'review.amount', { amount: moneyIn(l, line.amount), room: moneyIn(l, line.room) }),
    lineItems: () => tIn(l, 'review.lineItems', { have: line.have, need: line.need }),
    additional: () => tIn(l, 'review.additional')
  }[line.kind]();
  const txt = await base;
  return reason ? `${txt} — ${await tIn(l, 'reason.' + reason)}` : txt;
}

export async function renderApprove(root, ctx, id) {
  if (ctx.role !== 'pm') {
    root.innerHTML = `${header(ctx, '')}<div class="soon"><div class="big">✅</div><h1>${esc(t('approve.pmOnly'))}</h1></div>`;
    return;
  }
  const [jobs, draws] = await Promise.all([db.all('jobs'), db.all('draws')]);
  const jobOf = d => jobs.find(j => j.Id === d.Work_Order__c);
  if (!id) return renderQueue(root, ctx, pendingReview(draws), jobOf);

  const d = draws.find(x => x.Id === id);
  const w = d && jobOf(d);
  if (!d || !w) { location.hash = '#/approve'; return; }
  const cl = await checklistFor(tradeKey(w));
  const lines = reviewLines(d, w, cl);
  const m = manifestOf(d) || {};
  const instLang = d._lang || m.lang || 'en';
  const state = new Map(lines.map(l => [l.id, { checked: false, reason: l.ok ? '' : 'missing' }]));

  const photoTiles = (m.photos || []).map((p, i) => `<div class="ph"><span>${esc(t('kind.' + p.kind))}</span><small>#${i + 1}</small></div>`).join('');
  const labelFor = l => ({
    photo: () => t('review.photo', { label: pick(l.label), have: l.have, need: l.need }),
    checklist: () => t('review.checklist', { have: l.have, need: l.need }),
    scope: () => t('review.scope'),
    complete: () => t('review.complete') + ` · ${l.value === 'Yes' ? t('yes') : t('no')}`,
    amount: () => t('review.amount', { amount: fmtMoney(l.amount), room: fmtMoney(l.room) }),
    lineItems: () => t('review.lineItems', { have: l.have, need: l.need }),
    additional: () => t('review.additional')
  }[l.kind]());

  root.innerHTML = `
    ${header(ctx, `
      <a class="back" href="#/approve">${icons.back}${esc(t('approve.title'))}</a>
      <div class="jobhead">
        <h1>${esc(fmtMoney(drawAmount(d)))} · ${esc(w.Account?.Name || '')}</h1>
        <div class="sub">${esc(d.Name)} · WO ${esc(w.WorkOrderNumber)} · ${esc(w._crewName || '')} · ${esc(fmtDate(d.CreatedDate, { weekday: 'short', month: 'short', day: 'numeric' }))}</div>
      </div>`)}
    <section class="sec">
      <h2>${esc(t('review.work'))}</h2>
      <div class="card"><p class="scope">${esc(d.Description_of_Work_Performed__c || '—')}</p>
        <div class="hint">${esc(t('review.scopeRef'))}: ${esc(w.Subject)}</div></div>
    </section>
    <section class="sec">
      <h2>${esc(t('review.photos'))} <span>${esc(String(photoCount(d)))}</span></h2>
      <div class="card">${photoTiles ? `<div class="phgrid">${photoTiles}</div>` : `<div class="hint" style="margin:0">${esc(t('review.noPhotos'))}</div>`}
        <div class="hint">${esc(t('review.photoNote'))}</div></div>
    </section>
    <section class="sec">
      <h2>${esc(t('review.deliverables'))} <span id="tally"></span></h2>
      <div class="card"><ul class="check review">
        ${lines.map(l => `<li data-line="${esc(l.id)}" class="${l.ok ? '' : 'short'}">
          <input type="checkbox" id="ln-${esc(l.id)}" ${l.ok ? '' : 'disabled'}>
          <label for="ln-${esc(l.id)}">${esc(labelFor(l))}${l.ok ? '' : `<small class="flag">${esc(t('review.autoShort'))}</small>`}
            <select class="reason" aria-label="${esc(t('review.reason'))}">${REASONS.map(r => `<option value="${r}">${esc(t('reason.' + r))}</option>`).join('')}</select>
          </label></li>`).join('')}
      </ul></div>
    </section>
    <section class="sec" style="padding-bottom:28px">
      <div class="stack">
        <button class="act primary" id="approveBtn">${icons.approve} ${esc(t('approve.approve'))}</button>
        <button class="act" id="sendBack">${icons.alert} ${esc(t('approve.sendBack'))}</button>
      </div>
      <div class="card smsprev" id="smsPrev" hidden>
        <div class="hint" style="margin-top:0">${esc(t('approve.smsTitle', { lang: instLang === 'es' ? 'Español' : 'English' }))}</div>
        <p id="smsText"></p>
      </div>
    </section>`;

  const refresh = async () => {
    const missed = lines.filter(l => !state.get(l.id).checked);
    root.querySelector('#tally').textContent = t('review.tally', { done: lines.length - missed.length, total: lines.length });
    root.querySelectorAll('li[data-line]').forEach(li => {
      const st = state.get(li.dataset.line);
      li.classList.toggle('done', st.checked);
      const sel = li.querySelector('.reason');
      sel.hidden = st.checked; sel.value = st.reason || 'missing';
    });
    root.querySelector('#approveBtn').disabled = missed.length > 0;
    root.querySelector('#sendBack').disabled = missed.length === 0;
    const prev = root.querySelector('#smsPrev');
    prev.hidden = missed.length === 0;
    if (missed.length) {
      const items = await Promise.all(missed.map(l => lineText(instLang, l, w, state.get(l.id).reason)));
      root.querySelector('#smsText').textContent = await tIn(instLang, 'sms.sentBack', { wo: w.WorkOrderNumber, who: w.Account?.Name || '', street: w.Street, items: items.join('; ') });
    }
  };
  root.querySelectorAll('li[data-line]').forEach(li => {
    const st = state.get(li.dataset.line);
    li.querySelector('input').onchange = e => { st.checked = e.target.checked; refresh(); };
    li.querySelector('.reason').onchange = e => { st.reason = e.target.value; refresh(); };
  });

  const decide = async decision => {
    const at = new Date().toISOString();
    const missed = await Promise.all(lines.filter(l => !state.get(l.id).checked).map(async l =>
      ({ item: l.id, reason: state.get(l.id).reason, text: await lineText(instLang, l, w, state.get(l.id).reason) })));
    const approval = { by: ctx.crew.lead.name, at, decision, checked: lines.filter(l => state.get(l.id).checked).map(l => l.id), missed };
    const manifest = { ...m, approval };
    // Submit = the PM submits the draw into the existing Salesforce process (Status__c New -> Submitted).
    // Send back = stays New; the missed items live in the manifest and go to the installer.
    if (decision === 'submitted') { d.Status__c = 'Submitted'; d.Approver__c = ctx.crew.lead.name; }
    d[MANIFEST_FIELD] = MANIFEST_MARK + JSON.stringify(manifest);
    await db.put('draws', d);
    await enqueue('draw.decision', { drawId: d.Id, Status__c: d.Status__c, Approver__c: d.Approver__c, approval, lang: lang() });
    toast(t(decision === 'submitted' ? 'approve.doneApproved' : 'approve.doneSentBack'));
    location.hash = '#/approve';
  };
  root.querySelector('#approveBtn').onclick = () => decide('submitted');
  root.querySelector('#sendBack').onclick = () => decide('sent_back');
  refresh();
}

function renderQueue(root, ctx, queue, jobOf) {
  root.innerHTML = `
    ${header(ctx, `<div class="greet">${esc(t('approve.title'))}</div><div class="date">${esc(t('approve.cutoff'))}</div>`)}
    <section class="sec">
      <h2>${esc(t('approve.waiting'))} <span>${esc(String(queue.length))}</span></h2>
      ${queue.length ? queue.map(d => {
        const w = jobOf(d);
        return `<a class="card" href="#/approve/${esc(d.Id)}">
          <div class="card-top"><div><h3>${esc(w?.Account?.Name || d.Name)}</h3>
            <div class="sub">${esc(w?._crewName || '')} · WO ${esc(w?.WorkOrderNumber || '')}</div></div>
            <div class="when">${esc(fmtMoney(drawAmount(d)))}</div></div>
          <div class="chips"><span class="chip warn">${esc(t('draw.WithPM'))}</span>
            <span class="chip muted">${esc(String(photoCount(d)))} 📷</span>
            ${d.Did_you_complete_the_job_or_service__c === 'Yes' ? `<span class="chip ok">${esc(t('review.jobDone'))}</span>` : `<span class="chip muted">${esc(t('review.partial'))}</span>`}</div>
        </a>`; }).join('') : `<div class="empty">${esc(t('approve.empty'))}</div>`}
    </section>`;
}
