import { t, fmtDate, fmtTime } from '../i18n.js';
import { db } from '../db.js';
import { drawsFor, drawStatus, tradeKey, visibleFor, visit, pendingReview } from '../data.js';
import { esc, icons, visitTone, drawTone, mapsUrl, sameDay } from '../ui.js';
import { header } from '../app.js';

function greetingKey() { const h = new Date().getHours(); return h < 12 ? 'today.greeting.morning' : h < 17 ? 'today.greeting.afternoon' : 'today.greeting.evening'; }

function card(w, draws, ctx) {
  const ds = drawsFor(draws, w.Id);
  const latest = ds[0];
  const drawChip = latest ? `<span class="chip ${drawTone(drawStatus(latest))}">${esc(t('draw.' + drawStatus(latest)))}</span>` : `<span class="chip muted">${esc(t('draw.none'))}</span>`;
  const sentBack = latest && drawStatus(latest) === 'SentBack';
  return `
  <a class="card" href="#/job/${esc(w.Id)}">
    <div class="card-top">
      <div>
        <h3>${esc(w.Account?.Name || w.Subject)}</h3>
        <div class="sub">${esc(w.Street)} · ${esc(w.City)}${ctx.role === 'pm' ? ` · ${esc(w._crewName)}` : ''}</div>
      </div>
      <div class="when">${sameDay(w.StartDate) ? `${fmtTime(w.StartDate)}` : fmtDate(w.StartDate, { weekday: 'short', day: 'numeric' })}</div>
    </div>
    <div class="chips">
      <span class="chip ${visitTone(visit(w).Status)}">${esc(t('sa.' + visit(w).Status))}</span>
      <span class="chip muted">${esc(t('trade.' + tradeKey(w)))}</span>
      ${w.RecordType?.Name === 'Service' ? `<span class="chip warn">${esc(t('wo.service'))}</span>` : ''}
      ${ctx.role === 'measure' ? `<span class="chip">${esc(t('wo.measure'))}</span>` : drawChip}
      ${sentBack ? `<span class="chip bad">${esc(t('draw.fixIt'))}</span>` : ''}
    </div>
  </a>`;
}

export async function renderToday(root, ctx) {
  const [jobs, draws] = await Promise.all([db.all('jobs'), db.all('draws')]);
  jobs.sort((a, b) => a.StartDate.localeCompare(b.StartDate));
  // Dispatch is the gate: only Dispatched / In Progress visits (and today's completed ones) show.
  const visible = jobs.filter(visibleFor(ctx.role));
  const today = visible.filter(j => sameDay(j.StartDate));
  const later = visible.filter(j => new Date(j.StartDate) > new Date() && !sameDay(j.StartDate));
  const toReview = ctx.role === 'pm' ? pendingReview(draws).length : 0;
  const first = today[0];

  root.innerHTML = `
    ${header(ctx, `
      <div class="greet">${esc(t(greetingKey(), { name: ctx.crew.lead.name.split(' ')[0] }))}</div>
      <div class="date">${esc(fmtDate(new Date()))} · ${esc(ctx.crew.name)}</div>`)}
    ${toReview ? `<section class="sec"><a class="act primary" href="#/approve" style="width:100%">${icons.approve} ${esc(t('approve.queue', { n: toReview }))}</a></section>` : ''}
    <section class="sec">
      <h2>${esc(t('today.title'))} <span>${esc(t(today.length === 1 ? 'today.jobCount' : 'today.jobsCount', { n: today.length }))}</span></h2>
      ${today.length ? today.map(w => card(w, draws, ctx)).join('') : `<div class="empty">${esc(t('today.none'))}</div>`}
      ${first ? `<div class="actions">
        <a class="act dark" href="${mapsUrl(first)}" target="_blank" rel="noopener">${icons.nav} ${esc(t('today.navigate'))}</a>
        ${first.Contact?.Phone ? `<a class="act" href="tel:${esc(first.Contact.Phone)}">${icons.phone} ${esc(t('today.call'))}</a>` : ''}
      </div>` : ''}
    </section>
    ${later.length ? `<section class="sec">
      <h2>${esc(t('today.thisWeek'))} <span>${esc(t(later.length === 1 ? 'today.jobCount' : 'today.jobsCount', { n: later.length }))}</span></h2>
      ${later.map(w => card(w, draws, ctx)).join('')}
    </section>` : ''}
    <section class="sec" style="padding-bottom:24px">
      <button class="act" id="switchCrew" style="width:100%">${esc(t('app.switchCrew'))}</button>
    </section>`;
  root.querySelector('#switchCrew').onclick = ctx.switchCrew;
}
