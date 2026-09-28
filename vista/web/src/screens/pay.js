// Submit for pay (installers). Photos for each shot the trade requires, the checklist and line items,
// amount and description, then "Are you sure?". No photos, no pay: Submit stays locked until every
// required shot is in. Works offline: photos wait on the phone and upload before the pay request syncs.
// After a send-back the same screen asks only for what the PM said was missing.
import { t, pick, lang, fmtMoney } from '../i18n.js';
import { db } from '../db.js';
import { enqueue } from '../sync.js';
import { drawsFor, drawStatus, isDraw, checklistFor, tradeKey, visit, visibleFor, manifestOf, contractAmount, remaining, pmOf, WOLI_DONE, MANIFEST_FIELD, MANIFEST_MARK } from '../data.js';
import { photoKey, shrink, savePhoto, dropPhoto, photosFor, photoSrc } from '../photos.js';
import { esc, icons, toast, confirmSheet } from '../ui.js';
import { header } from '../app.js';

const payRequestOf = (draws, w) => drawsFor(draws, w.Id).find(d => d.Type__c === 'Vista' && !isDraw(d));

export async function renderPay(root, ctx, jobId) {
  if (ctx.role !== 'installer') {
    root.innerHTML = `${header(ctx, `<div class="jobhead"><h1>${esc(t('pay.title'))}</h1></div>`)}
      <section class="sec"><div class="card"><p>${esc(t(ctx.role === 'pm' ? 'pay.pmHint' : 'pay.measureHint'))}</p>
      ${ctx.role === 'pm' ? `<div class="stack" style="margin-top:12px"><a class="act primary" href="#/approve">${icons.approve} ${esc(t('nav.approve'))}</a></div>` : ''}</div></section>`;
    return;
  }
  const [jobs, draws] = await Promise.all([db.all('jobs'), db.all('draws')]);
  const mine = jobs.filter(visibleFor(ctx));
  const stateOf = w => { const d = payRequestOf(draws, w); return d ? drawStatus(d) : visit(w)?.Status === 'In Progress' ? 'Ready' : 'NotStarted'; };

  // No job picked: the jobs that can be submitted (or fixed after a send-back).
  if (!jobId) {
    const open = mine.filter(w => ['Ready', 'SentBack'].includes(stateOf(w)));
    if (open.length === 1) { location.replace(`#/draw?job=${open[0].Id}`); return; }
    root.innerHTML = `${header(ctx, `<div class="jobhead"><h1>${esc(t('pay.title'))}</h1><div class="sub">${esc(t('pay.pickJob'))}</div></div>`)}
      <section class="sec">${open.length ? open.map(w => `<a class="card" href="#/draw?job=${esc(w.Id)}"><div class="card-top"><div><h3>${esc(w.Account?.Name || '')}</h3>
        <div class="sub">${esc(w.Street || '')} · WO ${esc(w.WorkOrderNumber)}</div></div></div>
        <div class="chips"><span class="chip ${stateOf(w) === 'SentBack' ? 'bad' : 'ok'}">${esc(t(stateOf(w) === 'SentBack' ? 'pay.fixIt' : 'pay.ready'))}</span></div></a>`).join('')
        : `<div class="card"><p>${esc(t('pay.nothingOpen'))}</p></div>`}</section>`;
    return;
  }

  const w = mine.find(j => j.Id === jobId);
  if (!w) { location.hash = '#/draw'; return; }
  const sa = visit(w), existing = payRequestOf(draws, w), status = existing ? drawStatus(existing) : null;
  const resubmit = status === 'SentBack';
  const back = `<a class="back" href="#/job/${esc(w.Id)}">${icons.back}${esc(t('nav.job'))}</a>`;
  const head = `${back}<div class="jobhead"><h1>${esc(t(resubmit ? 'pay.fixTitle' : 'pay.title'))}</h1>
    <div class="sub">${esc(w.Account?.Name || '')} · WO ${esc(w.WorkOrderNumber)}${contractAmount(w) ? ` · ${esc(t('job.contract'))} ${esc(fmtMoney(contractAmount(w)))} · ${esc(t('job.remaining', { amount: fmtMoney(remaining(w)) }))}` : ''}</div></div>`;

  if (existing && !resubmit) {
    root.innerHTML = `${header(ctx, head)}<section class="sec"><div class="card"><div class="card-top"><h3>${esc(fmtMoney(existing.Amount__c))}</h3>
      <span class="chip ${status === 'WithPM' ? 'warn' : 'ok'}">${esc(t('draw.' + status))}</span></div>
      <p style="margin-top:8px">${esc(t(status === 'WithPM' ? 'pay.withPm' : 'pay.alreadyDone', { pm: pmOf(w)?.Name || 'PM' }))}</p></div></section>`;
    return;
  }
  if (!resubmit && sa?.Status !== 'In Progress') {
    root.innerHTML = `${header(ctx, head)}<section class="sec"><div class="card"><p>${esc(t('job.startFirst'))}</p>
      <div class="stack" style="margin-top:12px"><a class="act dark" href="#/job/${esc(w.Id)}">${esc(t('nav.job'))}</a></div></div></section>`;
    return;
  }

  const cl = await checklistFor(tradeKey(w));
  const prevM = resubmit ? manifestOf(existing) || {} : {};
  const missed = resubmit ? prevM.approval?.missed || [] : [];
  const had = kind => (prevM.photos || []).filter(p => p.kind === kind).length;
  // Photos per shot: the trade minimum. On a resubmit, only the shots the PM named, at least one new photo
  // each (the PM may have had enough photos but not usable ones).
  const missedIds = new Set(missed.map(x => x.item));
  const shots = (cl?.photos || []).map(p => ({ ...p, need: !resubmit ? p.min : missedIds.has('photo:' + p.kind) ? Math.max(1, p.min - had(p.kind)) : 0 }))
    .filter(p => !resubmit || p.need > 0);
  const doneStatus = WOLI_DONE.Installation;
  const items = (w.WorkOrderLineItems || []).filter(li => li.Status !== 'Canceled');
  let saved = await db.get('checklist', w.Id);
  const draft = { amount: '', desc: resubmit ? '' : '' };

  async function draw() {
    const photos = (await photosFor(w.Id)).filter(p => p.draft);
    const byKind = k => photos.filter(p => p.kind === k);
    const done = new Set(saved?.done || prevM.checklist?.done || []);
    const itemsDone = items.filter(li => li.Status === doneStatus).length;
    const room = contractAmount(w) ? remaining(w) : null;
    // What still stands between the installer and Submit, in plain words.
    const blockersNow = () => {
      const amount = Number(draft.amount);
      const amountOk = resubmit || (amount > 0 && (room == null || amount <= room));
      return [
        ...shots.filter(s => byKind(s.kind).length < s.need).map(s => t('pay.needShot', { label: pick(s), n: s.need - byKind(s.kind).length })),
        ...(amountOk ? [] : [amount > 0 ? t('pay.overContract', { amount: fmtMoney(room) }) : t('pay.needAmount')]),
        ...(resubmit || draft.desc.trim().length > 2 ? [] : [t('pay.needDesc')])
      ];
    };
    const blockersHtml = b => b.length ? `<ul class="blockers">${b.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : `<div class="hint" style="margin-top:0">${esc(t('pay.cutoffHint'))}</div>`;
    const blockers = blockersNow();
    const thumbs = await Promise.all(photos.map(async p => [p.Id, await photoSrc(p.Id)]));
    const src = Object.fromEntries(thumbs);

    root.innerHTML = `${header(ctx, head)}
      ${resubmit ? `<section class="sec"><div class="card missedcard"><b>${esc(t('pay.pmNeeds', { pm: pmOf(w)?.Name || 'PM' }))}</b>
        <ul>${missed.map(x => `<li>${esc(x.text)}</li>`).join('')}</ul></div></section>` : ''}
      <section class="sec">
        <h2>${esc(t('pay.photos'))} <span>${esc(t('pay.noPhotosNoPay'))}</span></h2>
        ${shots.map(s => { const have = byKind(s.kind); const ok = have.length >= s.need; return `<div class="card shot">
          <div class="card-top"><div><h3>${esc(pick(s))}</h3>
            <div class="sub">${esc(s.need ? t('pay.shotNeed', { n: s.need }) : t('pay.optional'))}</div></div>
            <span class="chip ${ok ? 'ok' : 'warn'}">${esc(s.need ? `${have.length} / ${s.need}` : String(have.length))}</span></div>
          ${have.length ? `<div class="thumbs">${have.map(p => `<figure><img src="${esc(src[p.Id] || '')}" alt="${esc(pick(s))}"><button type="button" class="rm" data-rm="${esc(p.Id)}" aria-label="${esc(t('pay.remove'))}">×</button></figure>`).join('')}</div>` : ''}
          <label class="act ${ok ? '' : 'primary'} cam">${icons.draw} ${esc(t(have.length ? 'pay.addPhoto' : 'pay.takePhoto'))}
            <input type="file" accept="image/*" capture="environment" multiple data-kind="${esc(s.kind)}" hidden></label>
        </div>`; }).join('') || `<div class="card"><p>${esc(t('pay.photosComplete'))}</p></div>`}
      </section>
      ${cl && (!resubmit || done.size < cl.steps.length) ? `<section class="sec">
        <h2>${esc(t('job.checklist'))} <span>${esc(t('job.checklistProgress', { done: done.size, total: cl.steps.length }))}</span></h2>
        <div class="card">${done.size >= cl.steps.length ? `<p>${esc(t('pay.checklistDone'))}</p>` : `<ul class="check">${cl.steps.filter(st => !done.has(st.id)).map(st => `<li><input type="checkbox" data-step="${esc(st.id)}" id="st-${esc(st.id)}"><label for="st-${esc(st.id)}">${esc(pick(st))}</label></li>`).join('')}</ul>
          <div class="hint">${esc(t('pay.checklistHint'))}</div>`}</div>
      </section>` : ''}
      ${items.length && (!resubmit || itemsDone < items.length) ? `<section class="sec">
        <h2>${esc(t('job.lineItems'))} <span>${esc(`${itemsDone} / ${items.length}`)}</span></h2>
        <div class="card">${itemsDone === items.length ? `<p>${esc(t('pay.itemsDone'))}</p>` : `<ul class="check">${items.filter(li => li.Status !== doneStatus).map(li => `<li><input type="checkbox" data-woli="${esc(li.Id)}" id="li-${esc(li.Id)}"><label for="li-${esc(li.Id)}">${esc(li.Description)} ×${esc(li.Quantity)}</label></li>`).join('')}</ul>
          <div class="hint">${esc(t('txt.pay.itemsWarn'))}</div>`}</div>
      </section>` : ''}
      <section class="sec">
        <h2>${esc(t(resubmit ? 'pay.noteTitle' : 'pay.details'))}</h2>
        <div class="card drawform">
          ${resubmit ? '' : `<label>${esc(t('pay.amount'))}<input type="number" inputmode="decimal" min="1" ${room != null ? `max="${esc(room)}"` : ''} step="1" id="payAmount" value="${esc(draft.amount)}" placeholder="${esc(room != null ? t('draw.upTo', { amount: fmtMoney(room) }) : '')}"></label>`}
          <label>${esc(t(resubmit ? 'pay.note' : 'pay.desc'))}<textarea id="payDesc" rows="3" placeholder="${esc(t(resubmit ? 'pay.noteHint' : 'pay.descHint'))}">${esc(draft.desc)}</textarea></label>
        </div>
      </section>
      <section class="sec" style="padding-bottom:28px">
        <div class="stack">
          <button class="act primary" id="paySubmit" ${blockers.length ? 'disabled' : ''}>${icons.draw} ${esc(t(resubmit ? 'pay.resend' : 'pay.submit'))}</button>
          <div id="blockers">${blockersHtml(blockers)}</div>
        </div>
      </section>`;

    // Camera / photo library. Each photo is shrunk and saved on the phone right away.
    root.querySelectorAll('input[type=file][data-kind]').forEach(inp => inp.onchange = async () => {
      const kind = inp.dataset.kind, files = [...inp.files];
      let n = (await photosFor(w.Id)).filter(p => p.kind === kind).length + had(kind);
      for (const f of files) {
        n++;
        await savePhoto({ key: photoKey({ workOrderId: w.Id, serviceAppointmentId: sa?.Id, kind, n }), blob: await shrink(f), kind, workOrderId: w.Id, draft: true });
      }
      draw();
    });
    root.querySelectorAll('[data-rm]').forEach(b => b.onclick = async () => { await dropPhoto(b.dataset.rm); draw(); });
    root.querySelectorAll('input[data-step]').forEach(cb => cb.onchange = async () => {
      const next = new Set(saved?.done || prevM.checklist?.done || []); cb.checked ? next.add(cb.dataset.step) : next.delete(cb.dataset.step);
      saved = { Id: w.Id, checklistId: cl.id, done: [...next], updatedAt: new Date().toISOString() };
      await db.put('checklist', saved);
      await enqueue('checklist', { workOrderId: w.Id, checklistId: cl.id, done: saved.done, lang: lang() });
      draw();
    });
    root.querySelectorAll('input[data-woli]').forEach(cb => cb.onchange = async () => {
      const li = w.WorkOrderLineItems.find(x => x.Id === cb.dataset.woli);
      li.Status = doneStatus; await db.put('jobs', w);
      await enqueue('woli.status', { workOrderLineItemId: li.Id, Status: doneStatus });
      draw();
    });
    // Typing updates the button and the "still needed" list in place (no redraw, so focus and taps survive).
    const amt = root.querySelector('#payAmount'), desc = root.querySelector('#payDesc');
    const update = () => {
      if (amt) draft.amount = amt.value; draft.desc = desc.value;
      const b = blockersNow();
      root.querySelector('#paySubmit').disabled = b.length > 0;
      root.querySelector('#blockers').innerHTML = blockersHtml(b);
    };
    if (amt) amt.oninput = update; desc.oninput = update;

    root.querySelector('#paySubmit').onclick = async () => {
      if (amt) draft.amount = amt.value; draft.desc = desc.value;
      const photosNow = (await photosFor(w.Id)).filter(p => p.draft);
      const doneNow = saved?.done || prevM.checklist?.done || [];
      const itemsNow = items.filter(li => li.Status === doneStatus).length;
      const ok = await confirmSheet({
        title: t(resubmit ? 'pay.confirmResendTitle' : 'pay.confirmTitle'),
        lines: [
          ...(resubmit ? [] : [[t('confirm.amount'), fmtMoney(Number(draft.amount))]]),
          [t('confirm.job'), `${w.Account?.Name || ''} · WO ${w.WorkOrderNumber}`],
          [t('pay.photos'), String(photosNow.length + (prevM.photos?.length || 0))],
          ...(cl ? [[t('job.checklist'), `${doneNow.length} / ${cl.steps.length}`]] : []),
          ...(items.length ? [[t('job.lineItems'), `${itemsNow} / ${items.length}`]] : [])
        ],
        note: t('pay.confirmNote', { pm: pmOf(w)?.Name || 'PM' }), yes: t(resubmit ? 'pay.yesResend' : 'pay.yesSubmit'), no: t('confirm.no')
      });
      if (!ok) return;
      const at = new Date().toISOString();
      // Uploads go first in the outbox; the pay request waits behind them.
      for (const p of photosNow) { await db.put('photos', { ...p, draft: false }); await enqueue('photo.upload', { key: p.Id, workOrderId: w.Id }); }
      const newPhotos = photosNow.map(p => ({ kind: p.kind, key: p.Id, taken_at: p.takenAt }));
      const checklist = cl ? { id: cl.id, done: doneNow } : undefined;
      if (resubmit) {
        const m = { ...prevM, photos: [...(prevM.photos || []), ...newPhotos], ...(checklist ? { checklist } : {}), resubmitted_at: at };
        existing[MANIFEST_FIELD] = MANIFEST_MARK + JSON.stringify(m);
        if (draft.desc.trim()) existing.Description_of_Work_Performed__c = `${existing.Description_of_Work_Performed__c || ''}\n${draft.desc.trim()}`.trim();
        await db.put('draws', existing);
        await enqueue('payrequest.resubmit', { expenseId: existing.Id, manifest: { photos: newPhotos, ...(checklist ? { checklist } : {}) }, ...(draft.desc.trim() ? { description: existing.Description_of_Work_Performed__c } : {}), channel: 'app' });
        toast(t('pay.resent', { pm: pmOf(w)?.Name || 'PM' }));
      } else {
        const manifest = { v: 1, app: 'vista', kind: 'completion', channel: 'app', lang: lang(), submitted_at: at,
          submitted_by: { phone: ctx.crew.lead.phone, name: ctx.crew.lead.name }, ...(checklist ? { checklist } : {}), photos: newPhotos };
        const localId = 'local-' + Date.now();
        await db.put('draws', { Id: localId, _local: true, Name: '…', CreatedDate: at, Date__c: at.slice(0, 10), _crew: w._crew, _lang: lang(),
          Type__c: 'Vista', Status__c: 'New', Expense_Type__c: 'Labour', Amount__c: Math.round(Number(draft.amount)), Work_Order__c: w.Id, Job__c: w.Job_Number__c,
          Service_Appointment__c: sa?.Id, Did_you_complete_the_job_or_service__c: 'Yes', Additional_Work_Performed__c: 'No', TEST_SA__c: false,
          Description_of_Work_Performed__c: draft.desc.trim(), [MANIFEST_FIELD]: MANIFEST_MARK + JSON.stringify(manifest) });
        await enqueue('payrequest.create', { workOrderId: w.Id, serviceAppointmentId: sa?.Id, Amount__c: Math.round(Number(draft.amount)), description: draft.desc.trim(), manifest, channel: 'app', localId });
        toast(t('pay.sentToast', { pm: pmOf(w)?.Name || 'PM' }));
      }
      location.hash = `#/job/${w.Id}`;
    };
  }
  await draw();
}
