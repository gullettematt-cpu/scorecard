// Vista — router, shell, crew picker. Five screens: today, job, draw, approve, vi.
import { loadLang, lang, t } from './i18n.js';
import { db } from './db.js';
import { adapter, seedIfNeeded } from './data.js';
import { pendingCount, onSync, flush } from './sync.js';
import { esc, icons } from './ui.js';
import { renderToday } from './screens/today.js';
import { renderJob } from './screens/job.js';
import { renderSoon } from './screens/soon.js';
import { renderApprove } from './screens/approve.js';

const root = document.getElementById('app');
const nav = document.getElementById('nav');
const ctx = { crew: null, role: 'installer', pending: 0, switchCrew };

// Shared header. Screens pass their own body (greeting, job title...).
export function header(ctx, body) {
  return `<header class="hdr">
    <div class="hdr-row">
      <div class="brand">${icons.logo}<div><b>${esc(t('app.name'))}</b><small>${esc(t('app.tagline'))}</small></div></div>
      <div class="hdr-meta">
        <span class="pill ${navigator.onLine ? '' : 'offline'}" id="netPill"><i class="dot"></i>${esc(navigator.onLine ? t('app.online') : t('app.offline'))}</span>
        ${ctx.pending ? `<span class="pill pending">${esc(t('app.pendingSync', { n: ctx.pending }))}</span>` : ''}
        <button class="pill btn" id="langBtn">${esc(t('app.switchLang'))}</button>
      </div>
    </div>
    ${body}
  </header>`;
}

function renderNav(route) {
  const items = [
    ['today', 'nav.today', icons.today, '#/today'],
    ['job', 'nav.job', icons.job, ctx.lastJob ? `#/job/${ctx.lastJob}` : '#/today'],
    ['draw', 'nav.draw', icons.draw, '#/draw'],
    ['approve', 'nav.approve', icons.approve, '#/approve'],
    ['vi', 'nav.vi', icons.vi, '#/vi']
  ];
  nav.innerHTML = items.map(([k, key, ic, href]) =>
    `<a href="${href}" class="${route === k ? 'on' : ''}" ${k === 'approve' && ctx.role !== 'pm' ? 'aria-disabled="true"' : ''}>${ic}<span>${esc(t(key))}</span></a>`).join('');
}

async function pickCrew() {
  const crews = await adapter.crews();
  root.innerHTML = `<div class="picker">
    <div class="brand" style="color:var(--ink)">${icons.logo}<div><b>${esc(t('app.name'))}</b><small style="color:var(--muted)">${esc(t('app.tagline'))}</small></div></div>
    <h1>${esc(t('app.pickCrew'))}</h1><p>${esc(t('app.pickCrewHint'))}</p>
    ${crews.map(c => `<button class="card" data-crew="${esc(c.id)}"><h3>${esc(c.name)}</h3><div class="sub">${esc(c.branch)} · ${c.role === 'pm' ? esc(t('app.pmRole')) + ' · ' : ''}${esc(c.members.join(', '))} · ${c.lang === 'es' ? 'Español' : 'English'}</div></button>`).join('')}
  </div>`;
  nav.innerHTML = '';
  return new Promise(resolve => root.querySelectorAll('[data-crew]').forEach(b => b.onclick = () => resolve(crews.find(c => c.id === b.dataset.crew))));
}

async function switchCrew() {
  localStorage.removeItem('vista.crew'); localStorage.removeItem('vista.lang');
  await db.wipe();
  location.hash = '#/today'; boot();
}

async function route() {
  const hash = location.hash || '#/today';
  const [path, query] = hash.slice(2).split('?');
  const [screen, id] = path.split('/');
  const q = new URLSearchParams(query || '');
  ctx.pending = await pendingCount();
  if (screen === 'job' && id) { ctx.lastJob = id; await renderJob(root, ctx, id); }
  else if (screen === 'approve') await renderApprove(root, ctx, id);
  else if (['draw', 'vi', 'problem'].includes(screen)) renderSoon(root, ctx, screen);
  else await renderToday(root, ctx);
  renderNav(screen === 'problem' ? 'job' : screen || 'today');
  window.scrollTo(0, 0);
  root.querySelector('#langBtn')?.addEventListener('click', async () => { await loadLang(lang() === 'en' ? 'es' : 'en'); route(); });
  if (q.get('job')) ctx.lastJob = q.get('job');
}

async function boot() {
  let crewId = localStorage.getItem('vista.crew');
  let crews = await adapter.crews();
  let crew = crews.find(c => c.id === crewId);
  await loadLang(localStorage.getItem('vista.lang') || crew?.lang || (navigator.language.startsWith('es') ? 'es' : 'en'));
  if (!crew) { crew = await pickCrew(); localStorage.setItem('vista.crew', crew.id); await loadLang(crew.lang); }
  ctx.crew = crew;
  ctx.role = crew.role || 'installer';
  await seedIfNeeded(crew);
  await route();
  flush();
}

window.addEventListener('hashchange', route);
window.addEventListener('online', route);
window.addEventListener('offline', route);
onSync(async () => { const n = await pendingCount(); if (n !== ctx.pending) route(); });
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js').catch(() => {});
boot();
