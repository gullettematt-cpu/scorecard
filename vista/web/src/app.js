// Vista — router, shell, crew picker. Five screens: today, job, draw, approve, vi.
import { loadLang, lang, t } from './i18n.js';
import { db } from './db.js';
import { adapter, seedIfNeeded } from './data.js';
import { pendingCount, onSync, flush, enqueue, rejected } from './sync.js';
import { getPrefs, setPrefs } from './prefs.js';
import { makeTranslator } from './translate.js';
import { esc, icons, languageSheet, LANG_LABEL, toast } from './ui.js';
import { renderToday } from './screens/today.js';
import { renderJob } from './screens/job.js';
import { renderApprove } from './screens/approve.js';
import { renderPay } from './screens/pay.js';
import { renderProblem } from './screens/problem.js';
import { renderVi } from './screens/vi.js';
import { renderAdmin, ADMIN_NAV } from './screens/admin.js';
import { apiMode, api, session, SignInNeeded } from './api.js';

const root = document.getElementById('app');
const nav = document.getElementById('nav');
const ctx = { crew: null, role: 'installer', pending: 0, switchCrew };
// Demo mode on the live app (demo.js): sample jobs, no sign-in. A bar on every screen says so and leads back out.
const liveDemo = !!globalThis.VISTA_DEMO;
const demoBar = () => liveDemo ? `<div class="demo-bar"><span>${esc(t('demo.banner'))}</span><button type="button" data-leave-demo>${esc(t('demo.leave'))}</button></div>` : '';
function leaveDemo() { localStorage.removeItem('vista.demoMode'); localStorage.removeItem('vista.crew'); location.replace('./'); }
document.addEventListener('click', e => { if (e.target.closest('[data-leave-demo]')) leaveDemo(); });

// Shared header. Screens pass their own body (greeting, job title...).
export function header(ctx, body) {
  return `<header class="hdr">${demoBar()}
    <div class="hdr-row">
      <div class="brand">${icons.logo}<div><b>${esc(t('app.name'))}</b><small>${esc(t('app.tagline'))}</small></div></div>
      <div class="hdr-meta">
        <span class="pill ${navigator.onLine ? '' : 'offline'}" id="netPill"><i class="dot"></i>${esc(navigator.onLine ? t('app.online') : t('app.offline'))}</span>
        ${ctx.pending ? `<span class="pill pending">${esc(t('app.pendingSync', { n: ctx.pending }))}</span>` : ''}
        <button class="pill btn" id="langBtn" aria-label="${esc(t('lang.title'))}">🌐 ${esc(LANG_LABEL[lang()])}</button>
      </div>
    </div>
    ${body}
  </header>`;
}

// Bilingual labels stack in two lines so the bottom bar stays readable.
const navLabel = s => { const [a, b] = s.split(' / '); return b ? `<span>${esc(a)}</span><span class="alt">${esc(b)}</span>` : `<span>${esc(s)}</span>`; };

function renderNav(route) {
  if (ctx.role === 'admin') {
    nav.innerHTML = ADMIN_NAV.map(([k, key, ic, href]) => `<a href="${href}" class="${route === k ? 'on' : ''}">${icons[ic]}${navLabel(t(key))}</a>`).join('');
    return;
  }
  const items = [
    ['today', 'nav.today', icons.today, '#/today'],
    ['job', 'nav.job', icons.job, ctx.lastJob ? `#/job/${ctx.lastJob}` : '#/today'],
    ['draw', 'nav.draw', icons.draw, '#/draw'],
    ['approve', 'nav.approve', icons.approve, '#/approve'],
    ['vi', 'nav.vi', icons.vi, '#/vi']
  ];
  nav.innerHTML = items.map(([k, key, ic, href]) =>
    `<a href="${href}" class="${route === k ? 'on' : ''}" ${(k === 'approve' && ctx.role !== 'pm') || (k === 'draw' && ctx.role === 'measure') ? 'aria-disabled="true"' : ''}>${ic}${navLabel(t(key))}</a>`).join('');
}

const LANG_NAME = { en: 'English', es: 'Español', bi: 'English + Español' };

// Language picker, used from the header and from sign-in. Returns true if the language changed.
async function openLanguage() {
  const r = await languageSheet({ current: lang(), title: t('lang.title'), bothHint: t('lang.biHint'), requestLabel: t('lang.request'),
    requestPlaceholder: t('lang.requestPlaceholder'), requestSend: t('lang.requestSend'), cancel: t('confirm.no') });
  if (!r) return false;
  if (r.lang) {
    await loadLang(r.lang);
    ctx.pickedLang = r.lang;
    if (ctx.crew) { setPrefs(ctx.crew.id, { lang: r.lang }); await enqueue('person.prefs', { personId: ctx.crew.id, lang: r.lang }); }
    return true;
  }
  if (ctx.crew) { setPrefs(ctx.crew.id, { requested: r.request }); await enqueue('language.request', { personId: ctx.crew.id, name: ctx.crew.lead.name, language: r.request }); }
  else ctx.pendingRequest = r.request;
  toast(t('lang.requested', { language: r.request }));
  return false;
}

async function pickCrew() {
  const crews = await adapter.crews();
  root.innerHTML = `<div class="picker">
    <div class="hdr-row"><div class="brand" style="color:var(--ink)">${icons.logo}<div><b>${esc(t('app.name'))}</b><small style="color:var(--muted)">${esc(t('app.tagline'))}</small></div></div>
      <button class="act" id="pickLang" style="flex:none;min-height:40px;padding:0 12px" aria-label="${esc(t('lang.title'))}">🌐 ${esc(LANG_LABEL[lang()])}</button></div>
    <h1>${esc(t('app.pickCrew'))}</h1><p>${esc(t(liveDemo ? 'demo.pickHint' : 'app.pickCrewHint'))}</p>
    ${crews.map(c => `<button class="card" data-crew="${esc(c.id)}"><h3>${esc(c.name)}</h3><div class="sub">${esc(c.branch)} · ${c.role === 'pm' ? esc(t('app.pmRole')) + ' · ' : c.role === 'measure' ? esc(t('app.measureRole')) + ' · ' : c.role === 'admin' ? esc(t('app.adminRole')) + ' · ' : ''}${esc(c.members.join(', '))} · ${esc(LANG_NAME[getPrefs(c.id).lang || c.lang])}</div></button>`).join('')}
    ${liveDemo ? `<div class="stack" style="margin-top:16px"><button class="act" data-leave-demo>${esc(t('demo.leave'))}</button></div>` : ''}
  </div>`;
  nav.innerHTML = '';
  return new Promise(resolve => {
    root.querySelector('#pickLang').onclick = async () => { if (await openLanguage()) resolve(pickCrew()); };
    root.querySelectorAll('[data-crew]').forEach(b => b.onclick = () => resolve(crews.find(c => c.id === b.dataset.crew)));
  });
}

// Live mode: sign in with a code texted to the number on file. Resolves with the person (crew shape).
async function signIn() {
  let phone = '';
  const draw = (step, msg = '') => {
    root.innerHTML = `<div class="picker">
      <div class="hdr-row"><div class="brand" style="color:var(--ink)">${icons.logo}<div><b>${esc(t('app.name'))}</b><small style="color:var(--muted)">${esc(t('app.tagline'))}</small></div></div>
        <button class="act" id="pickLang" style="flex:none;min-height:40px;padding:0 12px" aria-label="${esc(t('lang.title'))}">🌐 ${esc(LANG_LABEL[lang()])}</button></div>
      <h1>${esc(t('signin.title'))}</h1><p>${esc(msg || t('signin.hint'))}</p>
      <form id="signin" class="card" style="display:grid;gap:12px">
        ${step === 'phone'
          ? `<label>${esc(t('signin.phone'))}<input name="v" type="tel" inputmode="tel" autocomplete="tel" required value="${esc(phone)}" style="width:100%;font-size:20px;padding:10px"></label>
             <button class="act primary">${esc(t('signin.send'))}</button>`
          : `<label>${esc(t('signin.code'))}<input name="v" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required style="width:100%;font-size:24px;letter-spacing:6px;padding:10px"></label>
             <button class="act primary">${esc(t('signin.verify'))}</button>
             <button type="button" class="act" id="again">${esc(t('signin.resend'))}</button>`}
      </form>
      <div class="stack" style="margin-top:16px"><a class="act" href="./?demo">${esc(t('signin.demo'))}</a><p class="hint" style="text-align:center">${esc(t('signin.demoHint'))}</p></div></div>`;
    nav.innerHTML = '';
  };
  return new Promise(resolve => {
    const wire = (step, msg) => {
      draw(step, msg);
      root.querySelector('#pickLang').onclick = async () => { if (await openLanguage()) wire(step, msg); };
      root.querySelector('#again')?.addEventListener('click', () => wire('phone'));
      root.querySelector('#signin').onsubmit = async e => {
        e.preventDefault();
        const v = e.target.v.value.trim();
        if (!navigator.onLine) return wire(step, t('signin.offline'));
        try {
          if (step === 'phone') { phone = v; await api.start(phone, ctx.pickedLang || lang()); wire('code', t('signin.sent')); }
          else resolve(await api.verify(phone, v));
        } catch { wire(step, step === 'code' ? t('signin.bad') : t('signin.offline')); }
      };
    };
    wire('phone');
  });
}

async function switchCrew() {
  if (apiMode) session.clear();
  localStorage.removeItem('vista.crew'); localStorage.removeItem('vista.lang');
  ctx.pickedLang = null; ctx.pendingRequest = null;
  const carry = apiMode ? null : { jobs: await db.all('jobs'), draws: await db.all('draws'), cases: await db.all('cases'), checklist: await db.all('checklist') };
  const photos = apiMode ? [] : await db.all('photos');
  // Demo: the admin's changes (rollout, people, reminders, health) stay when switching people.
  const keepMeta = apiMode ? [] : (await db.all('meta')).filter(m => /^(rolloutOverride|demoPeople|demoHealth|demoNudge:)/.test(m.Id));
  await db.wipe();
  if (carry) { await db.meta('demoCarry', carry); await db.putAll('photos', photos); await db.putAll('meta', keepMeta); }
  location.hash = '#/today'; boot();
}

async function route() {
  const hash = location.hash || '#/today';
  const [path, query] = hash.slice(2).split('?');
  const [screen, id] = path.split('/');
  const q = new URLSearchParams(query || '');
  ctx.pending = await pendingCount();
  // Payroll/program admin: their own screens; crew and PM screens aren't theirs.
  if (ctx.role === 'admin' && screen !== 'vi') {
    const section = screen === 'admin' ? id || '' : '';
    await renderAdmin(root, ctx, section);
    renderNav(section ? `admin/${section}` : 'admin');
    window.scrollTo(0, 0);
    root.querySelector('#langBtn')?.addEventListener('click', async () => { if (await openLanguage()) route(); });
    return;
  }
  if (screen === 'admin') { location.hash = '#/today'; return; }
  if (screen === 'job' && id) { ctx.lastJob = id; await renderJob(root, ctx, id); }
  else if (screen === 'approve') await renderApprove(root, ctx, id);
  else if (screen === 'draw') await renderPay(root, ctx, q.get('job'));
  else if (screen === 'problem') await renderProblem(root, ctx, q.get('job'), { subject: q.get('subject') || '' });
  else if (screen === 'vi') await renderVi(root, ctx, q.get('job'));
  else await renderToday(root, ctx);
  renderNav(screen === 'problem' ? 'job' : screen || 'today');
  window.scrollTo(0, 0);
  root.querySelector('#langBtn')?.addEventListener('click', async () => { if (await openLanguage()) route(); });
  if (q.get('job')) ctx.lastJob = q.get('job');
}

async function boot() {
  if (apiMode) return bootLive();
  let crewId = localStorage.getItem('vista.crew');
  let crews = await adapter.crews();
  let crew = crews.find(c => c.id === crewId);
  // Language: the person's saved choice (shared with texts) > their record > the phone's language.
  await loadLang(getPrefs(crew?.id).lang || crew?.lang || (navigator.language.startsWith('es') ? 'es' : 'en'));
  if (!crew) {
    crew = await pickCrew(); localStorage.setItem('vista.crew', crew.id);
    // A language picked on the sign-in screen becomes this person's choice.
    if (ctx.pickedLang) { setPrefs(crew.id, { lang: ctx.pickedLang }); await enqueue('person.prefs', { personId: crew.id, lang: ctx.pickedLang }); }
    if (ctx.pendingRequest) { setPrefs(crew.id, { requested: ctx.pendingRequest }); await enqueue('language.request', { personId: crew.id, name: crew.lead.name, language: ctx.pendingRequest }); }
    await loadLang(getPrefs(crew.id).lang || crew.lang);
  }
  ctx.crew = crew;
  ctx.tr = makeTranslator(await adapter.translations());
  ctx.role = crew.role || 'installer';
  ctx.account = crew.account || null;
  ctx.crewId = crew.id;
  ctx.rollout = await adapter.rollout();
  await seedIfNeeded(crew);
  await route();
  flush();
}

// Live mode: same screens, data from the Vista API. Works offline from the last snapshot once signed in.
async function bootLive() {
  let crew = session.token() && session.person();
  await loadLang(ctx.pickedLang || crew?.lang || (navigator.language.startsWith('es') ? 'es' : 'en'));
  if (!crew) {
    await db.wipe();
    crew = await signIn();
    if (ctx.pickedLang && ctx.pickedLang !== crew.lang) { crew.lang = ctx.pickedLang; await enqueue('person.prefs', { personId: crew.id, lang: ctx.pickedLang }); }
    if (ctx.pendingRequest) await enqueue('language.request', { personId: crew.id, name: crew.name, language: ctx.pendingRequest });
    session.savePerson(crew);
  }
  // The server is the source of truth for the language; the phone keeps a copy for texts and offline use.
  setPrefs(crew.id, { lang: getPrefs(crew.id).lang || crew.lang });
  await loadLang(getPrefs(crew.id).lang);
  Object.assign(ctx, { crew, role: crew.role || 'installer', account: crew.account || null, crewId: crew.id });
  if (navigator.onLine) await flush().catch(() => {}); // send waiting work before reloading from Salesforce
  try { await seedIfNeeded(crew); }
  catch (e) { if (e instanceof SignInNeeded) return switchCrew(); /* offline or API down: keep last snapshot */ }
  ctx.tr = makeTranslator(await adapter.translations());
  ctx.rollout = await adapter.rollout();
  await route();
  flush();
}

window.addEventListener('hashchange', route);
window.addEventListener('online', route);
window.addEventListener('offline', route);
onSync(async () => {
  // A change the server refused (e.g. over the contract amount): say so, then reload the truth.
  if (rejected.length) {
    const r = rejected.splice(0); toast(t('app.syncRefused', { error: r.map(x => x.error).join('; ') }));
    if (apiMode && ctx.crew) { try { await seedIfNeeded(ctx.crew); } catch {} return route(); }
  }
  const n = await pendingCount(); if (n !== ctx.pending) route();
});
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js').catch(() => {});
boot();
