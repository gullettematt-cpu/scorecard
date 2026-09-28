// Report a problem: a Service Case on the job (docs/data-contract.md, "Writes — Case"). The crew says what's
// wrong in their own words, adds photos, and answers the three questions dispatch needs (work type, who
// pays, which warranty) in plain language; Salesforce gets the exact picklist values. "Work is stopped"
// makes it High priority. Works offline like everything else: photos upload first, then the Case.
import { t, lang } from '../i18n.js';
import { db } from '../db.js';
import { enqueue } from '../sync.js';
import { visibleFor, visit, tradeKey, pmOf, casesFor } from '../data.js';
import { photoKey, shrink, savePhoto, dropPhoto, photosFor, photoSrc } from '../photos.js';
import { esc, icons, toast, confirmSheet } from '../ui.js';
import { header } from '../app.js';

// Salesforce picklist values (unchanged) → what people see.
export const WORK_TYPES = ['Window', 'Door', 'Siding', 'Roofing', 'Gutters', 'Baths', 'Cover', 'Insulation', 'Cabinet', 'Rainsoft'];
const SERVICE_TYPES = ['Warranty', 'Paid Service'];
const WARRANTY_TYPES = ['Installer Warranty', 'Company Warranty', 'Sales/Service', 'Customer Accommodation'];
const slug = v => v.replace(/\W+/g, '');
const tradeToWorkType = { windows: 'Window', siding: 'Siding', roofing: 'Roofing', gutters: 'Gutters', bath: 'Baths' };
export const workTypeFor = w => (/^door/i.test(w.WorkType?.Name || w.Work_Type_Name__c || '') ? 'Door' : tradeToWorkType[tradeKey(w)] || 'Window');
const MAX_PHOTOS = 6;

export async function renderProblem(root, ctx, jobId) {
  const jobs = await db.all('jobs');
  const w = jobs.filter(visibleFor(ctx)).find(j => j.Id === jobId);
  if (!w) { location.hash = '#/today'; return; }
  const sa = visit(w), pm = pmOf(w)?.Name || 'PM';
  const form = { subject: '', details: '', workType: workTypeFor(w), serviceType: '', warrantyType: '', blocking: false };
  const head = `<a class="back" href="#/job/${esc(w.Id)}">${icons.back}${esc(t('nav.job'))}</a>
    <div class="jobhead"><h1>${esc(t('problem.title'))}</h1><div class="sub">${esc(w.Account?.Name || '')} · WO ${esc(w.WorkOrderNumber)}</div></div>`;

  const blockersNow = () => [
    ...(form.subject.trim().length >= 3 ? [] : [t('problem.needSubject')]),
    ...(form.serviceType ? [] : [t('problem.needServiceType')]),
    ...(form.warrantyType ? [] : [t('problem.needWarrantyType')])
  ];
  const blockersHtml = b => b.length ? `<ul class="blockers">${b.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : `<div class="hint" style="margin-top:0">${esc(t('problem.goesTo', { pm }))}</div>`;
  const choice = (name, value, label, hint) => `<label class="choice"><input type="radio" name="${name}" value="${esc(value)}" ${form[name] === value ? 'checked' : ''}>
    <span><b>${esc(label)}</b>${hint ? `<small>${esc(hint)}</small>` : ''}</span></label>`;

  async function draw() {
    const photos = (await photosFor(w.Id, 'problem')).filter(p => p.draft);
    const src = Object.fromEntries(await Promise.all(photos.map(async p => [p.Id, await photoSrc(p.Id)])));
    const open = casesFor(await db.all('cases'), w);
    const b = blockersNow();
    root.innerHTML = `${header(ctx, head)}
      ${open.length ? `<section class="sec"><div class="card"><div class="hint" style="margin:0">${esc(t('problem.alreadyOpen', { n: open.length }))}</div>
        <ul class="openlist">${open.map(c => `<li>${esc(c.Subject.replace(/^\[Vista\]\s*/, ''))} <small>· ${esc(t('case.' + c.Status) === 'case.' + c.Status ? c.Status : t('case.' + c.Status))}</small></li>`).join('')}</ul></div></section>` : ''}
      <section class="sec">
        <h2>${esc(t('problem.what'))}</h2>
        <div class="card drawform">
          <label>${esc(t('problem.subject'))}<input id="pbSubject" maxlength="200" value="${esc(form.subject)}" placeholder="${esc(t('problem.subjectHint'))}" autocomplete="off"></label>
          <label>${esc(t('problem.details'))}<textarea id="pbDetails" rows="4" placeholder="${esc(t('problem.detailsHint'))}">${esc(form.details)}</textarea></label>
          <label class="choice stop"><input type="checkbox" id="pbBlocking" ${form.blocking ? 'checked' : ''}><span><b>${esc(t('problem.blocking'))}</b><small>${esc(t('problem.blockingHint'))}</small></span></label>
        </div>
      </section>
      <section class="sec">
        <h2>${esc(t('pay.photos'))} <span>${esc(t('pay.optional'))} · ${photos.length} / ${MAX_PHOTOS}</span></h2>
        <div class="card shot">
          ${photos.length ? `<div class="thumbs">${photos.map(p => `<figure><img src="${esc(src[p.Id] || '')}" alt="${esc(t('problem.photoAlt'))}"><button type="button" class="rm" data-rm="${esc(p.Id)}" aria-label="${esc(t('pay.remove'))}">×</button></figure>`).join('')}</div>` : `<div class="hint" style="margin:0">${esc(t('problem.photoHint'))}</div>`}
          ${photos.length < MAX_PHOTOS ? `<label class="act cam">${icons.draw} ${esc(t(photos.length ? 'pay.addPhoto' : 'pay.takePhoto'))}<input type="file" accept="image/*" capture="environment" multiple id="pbPhoto" hidden></label>` : ''}
        </div>
      </section>
      <section class="sec">
        <h2>${esc(t('problem.workType'))}</h2>
        <div class="card drawform"><label>${esc(t('problem.workTypeLabel'))}<select id="pbWorkType">${WORK_TYPES.map(v => `<option value="${esc(v)}" ${form.workType === v ? 'selected' : ''}>${esc(t('wt.' + slug(v)))}</option>`).join('')}</select></label></div>
      </section>
      <section class="sec">
        <h2>${esc(t('problem.whoPays'))}</h2>
        <div class="card choices" data-group="serviceType">${SERVICE_TYPES.map(v => choice('serviceType', v, t('st.' + slug(v)), t('st.' + slug(v) + '.hint'))).join('')}</div>
      </section>
      <section class="sec">
        <h2>${esc(t('problem.warrantyType'))}</h2>
        <div class="card choices" data-group="warrantyType">${WARRANTY_TYPES.map(v => choice('warrantyType', v, t('wy.' + slug(v)), t('wy.' + slug(v) + '.hint'))).join('')}</div>
        <div class="hint">${esc(t('problem.pmCanChange', { pm }))}</div>
      </section>
      <section class="sec" style="padding-bottom:28px">
        <div class="stack">
          <button class="act primary" id="pbSend" ${b.length ? 'disabled' : ''}>${icons.alert} ${esc(t('problem.send'))}</button>
          <div id="blockers">${blockersHtml(b)}</div>
        </div>
      </section>`;

    const update = () => {
      form.subject = root.querySelector('#pbSubject').value; form.details = root.querySelector('#pbDetails').value;
      const bl = blockersNow(); root.querySelector('#pbSend').disabled = bl.length > 0; root.querySelector('#blockers').innerHTML = blockersHtml(bl);
    };
    root.querySelector('#pbSubject').oninput = update; root.querySelector('#pbDetails').oninput = update;
    root.querySelector('#pbBlocking').onchange = e => { form.blocking = e.target.checked; };
    root.querySelector('#pbWorkType').onchange = e => { form.workType = e.target.value; };
    root.querySelectorAll('input[type=radio]').forEach(r => r.onchange = () => { form[r.name] = r.value; update(); });
    root.querySelector('#pbPhoto')?.addEventListener('change', async e => {
      update();
      const files = [...e.target.files].slice(0, MAX_PHOTOS - photos.length);
      let n = (await photosFor(w.Id, 'problem')).length;
      for (const f of files) await savePhoto({ key: photoKey({ workOrderId: w.Id, serviceAppointmentId: sa?.Id, kind: 'problem', n: ++n }), blob: await shrink(f), kind: 'problem', workOrderId: w.Id, purpose: 'problem' });
      draw();
    });
    root.querySelectorAll('[data-rm]').forEach(bt => bt.onclick = async () => { update(); await dropPhoto(bt.dataset.rm); draw(); });

    root.querySelector('#pbSend').onclick = async () => {
      update();
      const photosNow = (await photosFor(w.Id, 'problem')).filter(p => p.draft);
      const ok = await confirmSheet({
        title: t('problem.confirmTitle'),
        lines: [[t('confirm.job'), `${w.Account?.Name || ''} · WO ${w.WorkOrderNumber}`], [t('problem.subject'), form.subject.trim()],
          [t('problem.workTypeLabel'), t('wt.' + slug(form.workType))], [t('problem.whoPays'), t('st.' + slug(form.serviceType))],
          [t('problem.warrantyType'), t('wy.' + slug(form.warrantyType))], [t('pay.photos'), String(photosNow.length)],
          ...(form.blocking ? [[t('problem.priority'), t('problem.high')]] : [])],
        note: t('problem.confirmNote', { pm }), yes: t('problem.yesSend'), no: t('confirm.no')
      });
      if (!ok) return;
      const where = await position();
      for (const p of photosNow) { await db.put('photos', { ...p, draft: false }); await enqueue('photo.upload', { key: p.Id, workOrderId: w.Id }); }
      const at = new Date().toISOString(), localId = 'local-case-' + Date.now(), keys = photosNow.map(p => p.Id);
      await db.put('cases', { Id: localId, _local: true, CaseNumber: '…', Subject: `[Vista] ${form.subject.trim()}`, Status: 'New', CreatedDate: at, Job__c: w.Job_Number__c,
        Work_Type__c: form.workType, Service_Type__c: form.serviceType, Warranty_Type__c: form.warrantyType, Priority: form.blocking ? 'High' : 'Medium', _photos: keys });
      await enqueue('case.create', { workOrderId: w.Id, serviceAppointmentId: sa?.Id, subject: form.subject.trim(), description: form.details.trim(),
        Work_Type__c: form.workType, Service_Type__c: form.serviceType, Warranty_Type__c: form.warrantyType, blocking: form.blocking,
        photos: photosNow.map(p => ({ kind: 'problem', key: p.Id })), lang: lang() === 'es' ? 'es' : 'en', ...where, localId });
      toast(t('problem.sent', { pm }));
      location.hash = `#/job/${w.Id}`;
    };
  }
  await draw();
}

// Where the crew is standing, if the phone allows it (goes in the Case footer). Never blocks sending.
function position() {
  return new Promise(res => {
    if (!navigator.geolocation) return res({});
    const done = v => { clearTimeout(timer); res(v); }, timer = setTimeout(() => done({}), 4000);
    try { navigator.geolocation.getCurrentPosition(p => done({ lat: p.coords.latitude, lng: p.coords.longitude }), () => done({}), { timeout: 4000, maximumAge: 600000 }); }
    catch { done({}); }
  });
}
