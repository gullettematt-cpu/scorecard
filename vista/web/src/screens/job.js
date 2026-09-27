import { t, pick, fmtDate, fmtTime, fmtMoney, lang } from '../i18n.js';
import { db } from '../db.js';
import { drawsFor, casesFor, drawStatus, drawAmount, checklistFor, contractAmount, laborDrawn, pmOf, photoCount, tradeKey, visit, visibleFor, manifestOf, WOLI_DONE, visitKind, isDraw, drawRules, drawEligible, remaining, MANIFEST_FIELD, MANIFEST_MARK } from '../data.js';
import { enqueue } from '../sync.js';
import { esc, icons, drawTone, mapsUrl, toast, confirmSheet } from '../ui.js';
import { header } from '../app.js';

export async function renderJob(root, ctx, id) {
  const [w, draws, cases] = await Promise.all([db.get('jobs', id), db.all('draws'), db.all('cases')]);
  if (!w || !visibleFor(ctx)(w)) { root.innerHTML = `${header(ctx, '')}<div class="empty">${esc(t(w ? 'job.notDispatched' : 'job.notFound'))}</div>`; return; }
  const sa = visit(w);
  const trade = tradeKey(w);
  const [cl, saved] = await Promise.all([checklistFor(trade), db.get('checklist', id)]);
  const done = new Set(saved?.done || []);
  const ds = drawsFor(draws, w.Id), cs = casesFor(cases, w);
  const contract = contractAmount(w);
  const pm = pmOf(w) || ctx.crew.pm;
  // Start sets ServiceAppointment.Status = In Progress. There is no Finish: submitting the draw
  // completes the visit and closes the WorkOrder (Flow A, docs/approval-flow.md).
  const isMeasure = ctx.role === 'measure';
  const isInstaller = ctx.role === 'installer';
  const isField = isMeasure || isInstaller;
  const canStart = isField && sa.Status === 'Dispatched';
  const canSubmit = isInstaller && sa.Status === 'In Progress';
  // Line items: the installer (installation visits) or measure tech (measurement visits) marks them complete.
  const doneStatus = WOLI_DONE[visitKind(w)];
  const canMarkItems = isField && sa.Status === 'In Progress';
  // Measure techs finish the visit themselves once every line item is measured (no pay in Vista).
  const openItems = (w.WorkOrderLineItems || []).filter(li => li.Status !== 'Canceled' && li.Status !== WOLI_DONE.Measurement);
  const canFinishMeasure = isMeasure && sa.Status === 'In Progress';
  // Draws: payment before completion. PM-only, PM judgment (optionally narrowed by content/draw-rules.json).
  const rules = ctx.role === 'pm' ? await drawRules() : {};
  const elig = ctx.role === 'pm' ? drawEligible(w, rules) : { ok: false };
  const progress = w._progressPhotos || 0;
  const needPhotos = rules.requireProgressPhotos ?? 1;

  root.innerHTML = `
    ${header(ctx, `
      <a class="back" href="#/today">${icons.back}${esc(t('job.back'))}</a>
      <div class="jobhead">
        <h1>${esc(w.Subject)}</h1>
        <div class="sub">WO ${esc(w.WorkOrderNumber)}${w.Job_Number__r ? ` · ${esc(w.Job_Number__r.Name)}` : ''} · ${esc(fmtDate(w.StartDate, { weekday: 'short', month: 'short', day: 'numeric' }))} ${esc(fmtTime(w.StartDate))}–${esc(fmtTime(w.EndDate))}</div>
        <div class="chips"><span class="chip" style="background:rgba(255,255,255,.14);color:#fff">${esc(t('sa.' + sa.Status))}</span>${w.RecordType?.Name === 'Service' ? `<span class="chip" style="background:rgba(255,255,255,.14);color:#fff">${esc(t('wo.service'))}</span>` : ''}<span class="chip" style="background:rgba(255,255,255,.14);color:#fff">${esc(t('trade.' + trade))}</span></div>
      </div>`)}

    <section class="sec">
      <h2>${esc(t('job.homeowner'))}</h2>
      <div class="card">
        <h3>${esc(w.Account?.Name || '')}</h3>
        <div class="addr" style="margin-top:6px">${esc(w.Street)}<br>${esc(w.City)}, ${esc(w.State)} ${esc(w.PostalCode)}</div>
        <div class="actions">
          <a class="act dark" href="${mapsUrl(w)}" target="_blank" rel="noopener">${icons.nav} ${esc(t('today.navigate'))}</a>
          ${w.Contact?.Phone ? `<a class="act" href="tel:${esc(w.Contact.Phone)}">${icons.phone} ${esc(t('today.call'))}</a>` : ''}
        </div>
      </div>
    </section>

    <section class="sec">
      <h2>${esc(t('job.scope'))}</h2>
      <div class="card">
        <p class="scope">${esc(w.Description || '')}</p>
        ${w.WorkOrderLineItems?.length ? `<h2 style="margin-top:14px">${esc(t('job.lineItems'))}</h2>
        <ul class="lines woli" style="margin-top:6px">${w.WorkOrderLineItems.map(li => {
          const doneLi = li.Status === doneStatus;
          return `<li class="${doneLi ? 'done' : ''}">
            ${canMarkItems && li.Status !== 'Canceled' ? `<input type="checkbox" data-woli="${esc(li.Id)}" ${doneLi ? 'checked' : ''} aria-label="${esc(t('job.markDone'))}">` : ''}
            <span class="d">${esc(li.Description)}<small>${esc(t('woli.' + li.Status))}</small></span><span class="q">×${esc(li.Quantity)}</span></li>`; }).join('')}</ul>
        ${canMarkItems ? `<div class="hint">${esc(t(visitKind(w) === 'Measurement' ? 'job.markHintMeasure' : 'job.markHint'))}</div>` : ''}` : ''}
      </div>
    </section>

    ${cl && !isMeasure ? `<section class="sec">
      <h2>${esc(t('job.checklist'))} <span id="clProgress">${esc(t('job.checklistProgress', { done: done.size, total: cl.steps.length }))}</span></h2>
      <div class="card">
        <div class="progress"><i id="clBar" style="width:${Math.round(100 * done.size / cl.steps.length)}%"></i></div>
        <ul class="check" style="margin-top:8px">
          ${cl.steps.map(s => `<li class="${done.has(s.id) ? 'done' : ''}"><input type="checkbox" id="st-${esc(s.id)}" data-step="${esc(s.id)}" ${done.has(s.id) ? 'checked' : ''}><label for="st-${esc(s.id)}">${esc(pick(s))}</label></li>`).join('')}
        </ul>
        <div class="hint">${esc(t('app.savedLocal'))}</div>
      </div>
    </section>

    <section class="sec">
      <h2>${esc(t('job.photos'))}</h2>
      <div class="card">
        <ul class="photos">${cl.photos.map(p => `<li><span>${esc(pick(p))}</span><span class="chip ${p.min ? 'warn' : 'muted'}">${p.min ? esc(t('job.photosMin', { n: p.min })) : '—'}</span></li>`).join('')}</ul>
        <div class="hint">${esc(t('job.photosHint'))}</div>
      </div>
    </section>` : ''}

    ${isMeasure ? '' : `<section class="sec">
      <h2>${esc(t('job.pay'))} ${contract ? `<span>${esc(t('job.contract'))} ${esc(fmtMoney(contract))} · ${esc(t('job.remaining', { amount: fmtMoney(remaining(w)) }))}</span>` : ''}</h2>
      <div class="card">
        ${ds.length ? `<ul class="draws">${ds.map(d => `<li>
            <div><div class="amt">${esc(fmtMoney(drawAmount(d)))}</div><div class="hint" style="margin-top:0">${esc(d.Name)} · ${esc(fmtDate(d.CreatedDate, { month: 'short', day: 'numeric' }))}${photoCount(d) ? ` · ${photoCount(d)} 📷` : ''}</div></div>
            <span class="chips" style="margin:0;justify-content:flex-end">${isDraw(d) ? `<span class="chip muted">${esc(t('pay.draw'))}</span>` : ''}<span class="chip ${drawTone(drawStatus(d))}">${esc(t('draw.' + drawStatus(d)))}</span></span></li>
            ${drawStatus(d) === 'SentBack' && manifestOf(d)?.approval?.missed?.length ? `<li class="missed"><b>${esc(t('draw.missedTitle'))}</b><ul>${manifestOf(d).approval.missed.map(x => `<li>${esc(x.text)}</li>`).join('')}</ul></li>` : ''}`).join('')}</ul>` : `<div class="hint" style="margin:0">${esc(t('draw.none'))}</div>`}
        <div class="stack">
          ${isInstaller ? (canSubmit ? `<a class="act primary" href="#/draw?job=${esc(w.Id)}">${icons.draw} ${esc(t('job.submitPay'))}</a>` : `<button class="act" disabled style="opacity:.5">${icons.draw} ${esc(t('job.submitPay'))}</button><div class="hint" style="margin-top:0">${esc(t('job.startFirst'))}</div>`) : ''}
          ${isInstaller ? `<div class="hint" style="margin-top:0">${esc(t('job.askForDraw'))}</div>` : ''}
        </div>
        ${ctx.role === 'pm' ? (elig.ok ? `
        <form class="drawform" id="drawForm">
          <h2 style="margin-top:14px">${esc(t('draw.issueTitle'))}</h2>
          <label>${esc(t('draw.amount'))}<input type="number" inputmode="decimal" min="1" max="${esc(remaining(w))}" step="1" name="amount" required placeholder="${esc(t('draw.upTo', { amount: fmtMoney(remaining(w)) }))}"></label>
          <label>${esc(t('draw.covers'))}<textarea name="covers" rows="2" required placeholder="${esc(t('draw.coversHint'))}"></textarea></label>
          <label>${esc(t('draw.requestedBy'))}<input name="requestedBy" value="${esc(sa.Lead_Installer || '')}" required></label>
          <div class="hint ${progress >= needPhotos ? '' : 'bad'}">${esc(t(progress >= needPhotos ? 'draw.photosOk' : 'draw.photosNeeded', { n: progress, need: needPhotos }))}</div>
          <button class="act primary" type="submit" ${progress >= needPhotos ? '' : 'disabled'}>${esc(t('draw.issue'))}</button>
        </form>` : `<div class="hint">${esc(t('draw.notEligible.' + elig.why))}</div>`) : ''}
      </div>
    </section>`}

    ${cs.length ? `<section class="sec">
      <h2>${esc(t('job.problems'))}</h2>
      ${cs.map(c => `<div class="card"><div class="card-top"><div><h3 style="font-size:16px">${esc(c.Subject)}</h3><div class="sub">Case ${esc(c.CaseNumber)} · ${esc(fmtDate(c.CreatedDate, { month: 'short', day: 'numeric' }))}</div></div><span class="chip warn">${esc((k => t(k) === k ? c.Status : t(k))('case.' + c.Status))}</span></div></div>`).join('')}
    </section>` : ''}

    <section class="sec" style="padding-bottom:28px">
      <div class="stack">
        ${canStart ? `<button class="act dark" id="startJob">${esc(t(isMeasure ? 'job.startMeasure' : 'job.start'))}</button>` : ''}
        ${canFinishMeasure ? `<button class="act primary" id="finishMeasure" ${openItems.length ? 'disabled' : ''}>${esc(t('job.finishMeasure'))}</button>
          ${openItems.length ? `<div class="hint" style="margin-top:0;text-align:center">${esc(t('job.finishMeasureHint', { n: openItems.length }))}</div>` : ''}` : ''}
        <a class="act" href="#/problem?job=${esc(w.Id)}">${icons.alert} ${esc(t('job.problem'))}</a>
        <a class="act" href="#/vi?job=${esc(w.Id)}">${icons.vi} ${esc(t('job.askVi'))}</a>
        ${pm ? `<div class="hint" style="text-align:center">${esc(t('job.pm'))}: ${esc(pm.Name || pm.name)} · <a href="tel:${esc(pm.MobilePhone || pm.phone)}" style="text-decoration:underline">${esc(pm.MobilePhone || pm.phone)}</a></div>` : ''}
      </div>
    </section>`;

  // Checklist: local save + outbox entry (Step 2 folds this into the draw manifest).
  root.querySelectorAll('input[data-step]').forEach(cb => cb.onchange = async () => {
    cb.checked ? done.add(cb.dataset.step) : done.delete(cb.dataset.step);
    cb.closest('li').classList.toggle('done', cb.checked);
    await db.put('checklist', { Id: id, checklistId: cl.id, done: [...done], updatedAt: new Date().toISOString() });
    await enqueue('checklist', { workOrderId: id, checklistId: cl.id, done: [...done], lang: lang() });
    root.querySelector('#clProgress').textContent = t('job.checklistProgress', { done: done.size, total: cl.steps.length });
    root.querySelector('#clBar').style.width = `${Math.round(100 * done.size / cl.steps.length)}%`;
  });

  // PM issues a draw: after "Are you sure you want to submit this draw?", created already Approved
  // (Did_you_complete = No, Approver__c = PM). Salesforce emails Mike Duncan about every draw.
  root.querySelector('#drawForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const amount = Math.round(Number(f.get('amount')));
    if (!(amount > 0 && amount <= remaining(w))) { toast(t('draw.upTo', { amount: fmtMoney(remaining(w)) })); return; }
    const ok = await confirmSheet({
      title: t('confirm.drawTitle'),
      lines: [[t('confirm.amount'), fmtMoney(amount)], [t('confirm.job'), `${w.Account?.Name || ''} · WO ${w.WorkOrderNumber}`], [t('confirm.requestedBy'), String(f.get('requestedBy'))], [t('confirm.covers'), String(f.get('covers'))]],
      note: t('confirm.drawNote'), yes: t('confirm.yesDraw'), no: t('confirm.no')
    });
    if (!ok) return;
    const at = new Date().toISOString();
    const manifest = { v: 1, app: 'vista', kind: 'draw', lang: w._lang || 'en', issued_by: ctx.crew.lead.name, requested_by: String(f.get('requestedBy')), issued_at: at,
      photos: Array.from({ length: progress }, () => ({ kind: 'progress' })) };
    const d = { Id: 'local-' + Date.now(), Name: t('draw.pendingName'), CreatedDate: at, Date__c: at.slice(0, 10), _crew: w._crew, _lang: w._lang,
      Type__c: 'Vista', Status__c: 'Approved', Approver__c: ctx.crew.lead.name, Expense_Type__c: 'Labour', Amount__c: amount, Work_Order__c: w.Id, Job__c: w.Job_Number__c,
      Service_Appointment__c: sa.Id, Did_you_complete_the_job_or_service__c: 'No', TEST_SA__c: false,
      Description_of_Work_Performed__c: String(f.get('covers')), [MANIFEST_FIELD]: MANIFEST_MARK + JSON.stringify(manifest) };
    await db.put('draws', d);
    if (w.Job_Number__r) { w.Job_Number__r.Total_SA_Expense_Labor__c = laborDrawn(w) + amount; await db.put('jobs', w); }
    await enqueue('draw.issue', { workOrderId: w.Id, serviceAppointmentId: sa.Id, Amount__c: amount, covers: d.Description_of_Work_Performed__c, requested_by: manifest.requested_by, submitter: ctx.crew.lead.name });
    toast(t('draw.issued'));
    renderJob(root, ctx, id);
  });

  root.querySelectorAll('input[data-woli]').forEach(cb => cb.onchange = async () => {
    const li = w.WorkOrderLineItems.find(x => x.Id === cb.dataset.woli);
    li._prev ??= li.Status;
    li.Status = cb.checked ? doneStatus : li._prev;
    await db.put('jobs', w);
    await enqueue('woli.status', { workOrderLineItemId: li.Id, Status: li.Status });
    cb.closest('li').classList.toggle('done', cb.checked);
    cb.closest('li').querySelector('small').textContent = t('woli.' + li.Status);
    if (isMeasure) renderJob(root, ctx, id);
  });

  // Measure tech finishes the visit: ServiceAppointment.Status = Completed + ActualEndTime.
  root.querySelector('#finishMeasure')?.addEventListener('click', async () => {
    const at = new Date().toISOString();
    sa.Status = 'Completed'; sa.ActualEndTime = at; w.LastModifiedDate = at;
    await db.put('jobs', w);
    await enqueue('serviceappointment.complete', { serviceAppointmentId: sa.Id, Status: 'Completed', ActualEndTime: at });
    toast(t('app.savedLocal'));
    renderJob(root, ctx, id);
  });

  // Start: ServiceAppointment.Status = In Progress + ActualStartTime.
  root.querySelector('#startJob')?.addEventListener('click', async () => {
    const at = new Date().toISOString();
    sa.Status = 'In Progress'; sa.ActualStartTime = at; w.LastModifiedDate = at;
    await db.put('jobs', w);
    await enqueue('serviceappointment.start', { serviceAppointmentId: sa.Id, Status: 'In Progress', ActualStartTime: at });
    toast(t('app.savedLocal'));
    renderJob(root, ctx, id);
  });
}
