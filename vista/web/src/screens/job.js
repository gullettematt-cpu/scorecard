import { t, pick, fmtDate, fmtTime, fmtMoney, lang } from '../i18n.js';
import { db } from '../db.js';
import { drawsFor, casesFor, drawStatus, drawAmount, checklistFor, contractAmount, laborDrawn, pmOf, photoCount, tradeKey, WO_SCHEDULED, WO_INSTALLED } from '../data.js';
import { enqueue } from '../sync.js';
import { esc, icons, statusTone, drawTone, mapsUrl, toast } from '../ui.js';
import { header } from '../app.js';

export async function renderJob(root, ctx, id) {
  const [w, draws, cases] = await Promise.all([db.get('jobs', id), db.all('draws'), db.all('cases')]);
  if (!w) { root.innerHTML = `${header(ctx, '')}<div class="empty">${esc(t('job.notFound'))}</div>`; return; }
  const trade = tradeKey(w);
  const [cl, saved] = await Promise.all([checklistFor(trade), db.get('checklist', id)]);
  const done = new Set(saved?.done || []);
  const ds = drawsFor(draws, w.Id), cs = casesFor(cases, w);
  const contract = contractAmount(w);
  const pm = pmOf(w) || ctx.crew.pm;
  // WorkOrder.Status has no "In Progress": Start is phone-only (kept for the draw manifest);
  // Finish writes Installation Completed (open decision #3 in docs/data-contract.md).
  const startedAt = (await db.get('meta', 'started:' + id))?.v;
  const canStart = w.Status === WO_SCHEDULED && !startedAt;
  const canFinish = w.Status === WO_SCHEDULED && !!startedAt;

  root.innerHTML = `
    ${header(ctx, `
      <a class="back" href="#/today">${icons.back}${esc(t('job.back'))}</a>
      <div class="jobhead">
        <h1>${esc(w.Subject)}</h1>
        <div class="sub">WO ${esc(w.WorkOrderNumber)}${w.Job_Number__r ? ` · ${esc(w.Job_Number__r.Name)}` : ''} · ${esc(fmtDate(w.StartDate, { weekday: 'short', month: 'short', day: 'numeric' }))} ${esc(fmtTime(w.StartDate))}–${esc(fmtTime(w.EndDate))}</div>
        <div class="chips"><span class="chip" style="background:rgba(255,255,255,.14);color:#fff">${esc(startedAt && w.Status === WO_SCHEDULED ? t('wo.started') : t('status.' + w.Status))}</span>${w.RecordType?.Name === 'Service' ? `<span class="chip" style="background:rgba(255,255,255,.14);color:#fff">${esc(t('wo.service'))}</span>` : ''}<span class="chip" style="background:rgba(255,255,255,.14);color:#fff">${esc(t('trade.' + trade))}</span></div>
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
        <ul class="lines" style="margin-top:6px">${w.WorkOrderLineItems.map(li => `<li><span>${esc(li.Description)}</span><span class="q">×${esc(li.Quantity)}</span></li>`).join('')}</ul>` : ''}
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
            <span class="chips" style="margin:0;justify-content:flex-end"><span class="chip ${drawTone(drawStatus(d))}">${esc(t('draw.' + drawStatus(d)))}</span>${drawStatus(d) === 'Submitted' && !photoCount(d) ? `<span class="chip bad">${esc(t('draw.needsPhotos'))}</span>` : ''}</span></li>`).join('')}</ul>` : `<div class="hint" style="margin:0">${esc(t('draw.none'))}</div>`}
        <div class="stack">
          <a class="act primary" href="#/draw?job=${esc(w.Id)}">${icons.draw} ${esc(t('job.submitDraw'))}</a>
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
        ${canFinish ? `<button class="act dark" id="finishJob">${esc(t('job.finish'))}</button>` : ''}
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

  // Start: phone-only timestamp (no WorkOrder status for it). Finish: WorkOrder.Status = Installation Completed.
  root.querySelector('#startJob')?.addEventListener('click', async () => {
    await db.meta('started:' + id, new Date().toISOString());
    toast(t('app.savedLocal'));
    renderJob(root, ctx, id);
  });
  root.querySelector('#finishJob')?.addEventListener('click', async () => {
    w.Status = WO_INSTALLED; w.LastModifiedDate = new Date().toISOString();
    await db.put('jobs', w);
    await enqueue('workorder.status', { workOrderId: id, Status: WO_INSTALLED });
    toast(t('app.savedLocal'));
    renderJob(root, ctx, id);
  });
}
