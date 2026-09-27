import { t, pick, fmtDate, fmtTime, fmtMoney, lang } from '../i18n.js';
import { db } from '../db.js';
import { drawsFor, casesFor, drawStatus, drawAmount, checklistFor, contractAmount, laborDrawn, pmOf, photoCount, tradeKey, visit, isVisible, manifestOf, WOLI_DONE, visitKind } from '../data.js';
import { enqueue } from '../sync.js';
import { esc, icons, drawTone, mapsUrl, toast } from '../ui.js';
import { header } from '../app.js';

export async function renderJob(root, ctx, id) {
  const [w, draws, cases] = await Promise.all([db.get('jobs', id), db.all('draws'), db.all('cases')]);
  if (!w || (ctx.role !== 'pm' && !isVisible(w))) { root.innerHTML = `${header(ctx, '')}<div class="empty">${esc(t(w ? 'job.notDispatched' : 'job.notFound'))}</div>`; return; }
  const sa = visit(w);
  const trade = tradeKey(w);
  const [cl, saved] = await Promise.all([checklistFor(trade), db.get('checklist', id)]);
  const done = new Set(saved?.done || []);
  const ds = drawsFor(draws, w.Id), cs = casesFor(cases, w);
  const contract = contractAmount(w);
  const pm = pmOf(w) || ctx.crew.pm;
  // Start sets ServiceAppointment.Status = In Progress. There is no Finish: submitting the draw
  // completes the visit and closes the WorkOrder (Flow A, docs/approval-flow.md).
  const isInstaller = ctx.role !== 'pm';
  const canStart = isInstaller && sa.Status === 'Dispatched';
  const canSubmit = isInstaller && sa.Status === 'In Progress';
  // Line items: the installer (installation visits) or measure tech (measurement visits) marks them complete.
  const doneStatus = WOLI_DONE[visitKind(w)];
  const canMarkItems = isInstaller && sa.Status === 'In Progress';

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

    ${cl ? `<section class="sec">
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

    <section class="sec">
      <h2>${esc(t('job.draws'))} ${contract ? `<span>${esc(t('job.contract'))} ${esc(fmtMoney(contract))} · ${esc(t('job.remaining', { amount: fmtMoney(contract - laborDrawn(w)) }))}</span>` : ''}</h2>
      <div class="card">
        ${ds.length ? `<ul class="draws">${ds.map(d => `<li>
            <div><div class="amt">${esc(fmtMoney(drawAmount(d)))}</div><div class="hint" style="margin-top:0">${esc(d.Name)} · ${esc(fmtDate(d.CreatedDate, { month: 'short', day: 'numeric' }))}${photoCount(d) ? ` · ${photoCount(d)} 📷` : ''}</div></div>
            <span class="chips" style="margin:0;justify-content:flex-end"><span class="chip ${drawTone(drawStatus(d))}">${esc(t('draw.' + drawStatus(d)))}</span></span></li>
            ${drawStatus(d) === 'SentBack' && manifestOf(d)?.approval?.missed?.length ? `<li class="missed"><b>${esc(t('draw.missedTitle'))}</b><ul>${manifestOf(d).approval.missed.map(x => `<li>${esc(x.text)}</li>`).join('')}</ul></li>` : ''}`).join('')}</ul>` : `<div class="hint" style="margin:0">${esc(t('draw.none'))}</div>`}
        <div class="stack">
          ${isInstaller ? (canSubmit ? `<a class="act primary" href="#/draw?job=${esc(w.Id)}">${icons.draw} ${esc(t('job.submitDraw'))}</a>` : `<button class="act" disabled style="opacity:.5">${icons.draw} ${esc(t('job.submitDraw'))}</button><div class="hint" style="margin-top:0">${esc(t('job.startFirst'))}</div>`) : ''}
        </div>
      </div>
    </section>

    ${cs.length ? `<section class="sec">
      <h2>${esc(t('job.problems'))}</h2>
      ${cs.map(c => `<div class="card"><div class="card-top"><div><h3 style="font-size:16px">${esc(c.Subject)}</h3><div class="sub">Case ${esc(c.CaseNumber)} · ${esc(fmtDate(c.CreatedDate, { month: 'short', day: 'numeric' }))}</div></div><span class="chip warn">${esc((k => t(k) === k ? c.Status : t(k))('case.' + c.Status))}</span></div></div>`).join('')}
    </section>` : ''}

    <section class="sec" style="padding-bottom:28px">
      <div class="stack">
        ${canStart ? `<button class="act dark" id="startJob">${esc(t('job.start'))}</button>` : ''}
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

  root.querySelectorAll('input[data-woli]').forEach(cb => cb.onchange = async () => {
    const li = w.WorkOrderLineItems.find(x => x.Id === cb.dataset.woli);
    li._prev ??= li.Status;
    li.Status = cb.checked ? doneStatus : li._prev;
    await db.put('jobs', w);
    await enqueue('woli.status', { workOrderLineItemId: li.Id, Status: li.Status });
    cb.closest('li').classList.toggle('done', cb.checked);
    cb.closest('li').querySelector('small').textContent = t('woli.' + li.Status);
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
