// Program admin (payroll): Lisa's screens. She oversees the program and gets PMs to approve before the 10 AM
// cutoff; PMs handle crews and pay decisions.
//   #/admin          Pay run: every Vista pay request by stage, grouped by PM, with "Text the PM"
//   #/admin/people   People: find, add, change or turn off crews and PMs
//   #/admin/rollout  Rollout: Vista off / pilot / on per location, pilot accounts, opt-outs
//   #/admin/health   Health: the 2-hour check, language requests, who to call
// Live: the /admin API as a signed-in admin. Demo: the same screens on the sample data.
import { t, fmtMoney, fmtDate, fmtTime } from '../i18n.js';
import { db } from '../db.js';
import { apiMode, api } from '../api.js';
import { adapter, boardRow, boardByPm, cutoffInfo } from '../data.js';
import { allPrefs } from '../prefs.js';
import { esc, icons, toast, confirmSheet } from '../ui.js';
import { header } from '../app.js';

const hoursText = h => (h == null ? '' : h < 1 ? t('admin.justNow') : h < 24 ? t('admin.hours', { n: h }) : t('admin.days', { n: Math.floor(h / 24) }));
export function cutoffLine(now = new Date()) {
  const c = cutoffInfo(now);
  if (c.open) return { open: true, text: t('admin.cutoffLeft', { time: c.minutesLeft >= 60 ? `${Math.floor(c.minutesLeft / 60)} h ${c.minutesLeft % 60} min` : `${c.minutesLeft} min` }) };
  return { open: false, text: t(c.next === 'monday' ? 'admin.cutoffPassedMonday' : 'admin.cutoffPassed') };
}

// ---- Data: live API or the demo's sample data -----------------------------------------------------
const demo = {
  async board() {
    const [draws, jobs] = await Promise.all([db.all('draws'), db.all('jobs')]);
    const items = draws.filter(d => d.Type__c === 'Vista' && !d.TEST_SA__c).map(d => {
      const w = jobs.find(j => j.Id === d.Work_Order__c);
      return boardRow(d, { wo: w?.WorkOrderNumber || '', homeowner: w?.Account?.Name || '', office: w?.Job_Number__r?.Office__r?.Name || '', crew: w?._crewName || '',
        pmUserId: w?.Job_Number__r?.Production_Manager__c || 'pm', pmName: w?.Job_Number__r?.Production_Manager__r?.Name || 'PM' });
    }).sort((a, b) => String(b.since).localeCompare(String(a.since)));
    return { items, byPm: boardByPm(items), at: new Date().toISOString() };
  },
  async nudge(pmUserId, from) {
    const { items } = await demo.board(), waiting = items.filter(r => r.stage === 'withPm' && r.pmUserId === pmUserId);
    if (!waiting.length) return { sent: false, reason: 'nothing-waiting' };
    const last = await db.meta('demoNudge:' + pmUserId);
    if (last && Date.now() - Date.parse(last) < 3600e3) return { sent: false, reason: 'recently', at: last, name: waiting[0].pmName };
    await db.meta('demoNudge:' + pmUserId, new Date().toISOString());
    return { sent: true, n: waiting.length, name: waiting[0].pmName, demo: true, preview: t('txt.notice.nudge', { from, n: waiting.length, amount: fmtMoney(waiting.reduce((s, r) => s + r.amount, 0)) }) };
  },
  async people() {
    const crews = await adapter.crews(), edits = (await db.meta('demoPeople')) || {}, prefs = allPrefs();
    const base = crews.map(c => ({ textOptIn: 'in', id: c.id, name: c.lead.name, phone: c.lead.phone, role: c.role || 'installer', lang: prefs[c.id]?.lang || c.lang, channel: prefs[c.id]?.channel || 'both', account: c.account || null, requested: prefs[c.id]?.requested || null }));
    const merged = base.map(p => ({ ...p, ...(edits[p.phone] || {}) }));
    for (const [phone, p] of Object.entries(edits)) if (!merged.some(x => x.phone === phone)) merged.push(p);
    return merged;
  },
  async savePerson(p) { const edits = (await db.meta('demoPeople')) || {}; edits[p.phone] = { ...(edits[p.phone] || {}), ...p }; await db.meta('demoPeople', edits); return p; },
  async rollout() { return adapter.rollout(); },
  async setRollout(r) { await db.meta('rolloutOverride', r); return r; },
  async health() { return (await db.meta('demoHealth')) || { lastOk: new Date(Date.now() - 83 * 60e3).toISOString(), failing: null }; },
  async runHeartbeat() { const h = { lastOk: new Date().toISOString(), failing: null }; await db.meta('demoHealth', h); return { ok: true }; },
  async languageRequests() { return (await demo.people()).filter(p => p.requested).map(p => ({ person: p.name, phone: p.phone, language: p.requested })); }
};
const live = {
  board: () => api.admin.board(), nudge: (id) => api.admin.nudge(id), people: async () => (await api.admin.people()).people,
  savePerson: async p => (await api.admin.savePerson(p)).person, rollout: async () => (await api.admin.rollout()).rollout,
  setRollout: async r => (await api.admin.setRollout(r)).rollout, health: () => api.admin.health(), runHeartbeat: () => api.admin.runHeartbeat(),
  languageRequests: async () => (await api.admin.languageRequests()).requests
};
const src = () => (apiMode ? live : demo);

const head = (ctx, title, sub = '') => header(ctx, `<div class="jobhead"><h1>${esc(title)}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`);
const loading = (root, ctx, title) => { root.innerHTML = `${head(ctx, title)}<section class="sec"><div class="hint">${esc(t('admin.loading'))}</div></section>`; };
const failed = (root, ctx, title, retry) => {
  root.innerHTML = `${head(ctx, title)}<section class="sec"><div class="blockers">${esc(t(navigator.onLine ? 'admin.loadFailed' : 'admin.offline'))}</div>
    <div class="stack" style="margin-top:12px"><button class="act" id="retry">${esc(t('admin.retry'))}</button></div></section>`;
  root.querySelector('#retry').onclick = retry;
};

export async function renderAdmin(root, ctx, section) {
  if (ctx.role !== 'admin') { location.hash = '#/today'; return; }
  if (section === 'people') return renderPeople(root, ctx);
  if (section === 'rollout') return renderRollout(root, ctx);
  if (section === 'health') return renderHealth(root, ctx);
  return renderBoard(root, ctx);
}

// ---- Pay run ------------------------------------------------------------------------------------
async function renderBoard(root, ctx) {
  const title = t('admin.payRun');
  loading(root, ctx, title);
  let data; try { data = await src().board(); } catch { return failed(root, ctx, title, () => renderBoard(root, ctx)); }
  const cut = cutoffLine();
  const by = s => data.items.filter(r => r.stage === s);
  const sum = rows => rows.reduce((s, r) => s + r.amount, 0);
  const [withPm, sentBack, approved, paid] = ['withPm', 'sentBack', 'approved', 'paid'].map(by);
  const row = r => `<li class="brow">
      <div><b>${esc(r.homeowner || r.name)}</b> <span class="muted">· WO ${esc(r.wo)}</span>
        <div class="sub">${esc(r.crew || '')}${r.kind === 'draw' ? ` · <span class="chip muted">${esc(t('pay.draw'))}</span>` : ''}${r.photos ? ` · ${r.photos} 📷` : ''}${r.channel === 'sms' ? ` · ${esc(t('admin.byText'))}` : ''}</div>
        ${r.missed?.length ? `<div class="sub bad">${esc(t('admin.missing'))}: ${esc(r.missed.join('; '))}</div>` : ''}</div>
      <div class="amt">${esc(fmtMoney(r.amount))}<small class="${(r.stage === 'withPm' && r.hours >= 24) || (r.stage === 'sentBack' && r.hours >= 48) ? 'late' : ''}">${esc(r.stage === 'approved' || r.stage === 'paid' ? (r.approvedAt ? fmtDate(r.approvedAt, { month: 'short', day: 'numeric' }) : '') : hoursText(r.hours))}</small></div></li>`;
  root.innerHTML = `${head(ctx, title, `<span class="cutoff ${cut.open ? 'open' : ''}">${esc(cut.text)}</span>`)}
    <section class="sec">
      <div class="tiles">
        <a class="tile warn" href="#pm-list"><b>${withPm.length}</b><span>${esc(t('admin.tWithPm'))}</span><small>${esc(fmtMoney(sum(withPm)))}</small></a>
        <a class="tile bad" href="#sent-back"><b>${sentBack.length}</b><span>${esc(t('admin.tSentBack'))}</span><small>${esc(fmtMoney(sum(sentBack)))}</small></a>
        <a class="tile ok" href="#approved"><b>${approved.length}</b><span>${esc(t('admin.tApproved'))}</span><small>${esc(fmtMoney(sum(approved)))}</small></a>
      </div>
    </section>
    <section class="sec" id="pm-list">
      <h2>${esc(t('admin.waitingOnPms'))} <span>${esc(t('admin.nudgeHint'))}</span></h2>
      ${data.byPm.length ? data.byPm.map(pm => `<div class="card pmcard">
        <div class="card-top"><div><h3>${esc(pm.pmName || t('admin.noPm'))}</h3>
          <div class="sub">${esc(t('admin.pmLine', { n: pm.count, amount: fmtMoney(pm.total) }))} · ${esc(t('admin.oldest', { age: hoursText(pm.oldestHours) }))}</div></div>
          ${pm.oldestHours >= 24 ? `<span class="chip bad">${esc(t('admin.overADay'))}</span>` : ''}</div>
        <ul class="blist">${withPm.filter(r => (r.pmUserId || r.pmName) === (pm.pmUserId || pm.pmName)).map(row).join('')}</ul>
        ${pm.pmUserId ? `<button class="act primary nudge" data-pm="${esc(pm.pmUserId)}">${icons.phone} ${esc(t('admin.nudge', { pm: (pm.pmName || 'PM').split(' ')[0] }))}</button>` : ''}
        <div class="nudge-result" data-for="${esc(pm.pmUserId || '')}"></div>
      </div>`).join('') : `<div class="card"><p>${esc(t('admin.noneWaiting'))}</p></div>`}
    </section>
    <section class="sec" id="sent-back">
      <h2>${esc(t('admin.sentBackTitle'))} <span>${esc(t('admin.sentBackHint'))}</span></h2>
      <div class="card">${sentBack.length ? `<ul class="blist">${sentBack.map(row).join('')}</ul>` : `<p class="hint" style="margin:0">${esc(t('admin.none'))}</p>`}</div>
    </section>
    <section class="sec" id="approved">
      <h2>${esc(t('admin.approvedTitle'))} <span>${esc(fmtMoney(sum(approved)))}</span></h2>
      <div class="card">${approved.length ? `<ul class="blist">${approved.map(row).join('')}</ul>` : `<p class="hint" style="margin:0">${esc(t('admin.none'))}</p>`}
        <div class="hint">${esc(t('admin.approvedHint'))}</div></div>
    </section>
    <section class="sec">
      <h2>${esc(t('admin.paidTitle'))} <span>${paid.length} · ${esc(fmtMoney(sum(paid)))}</span></h2>
      <div class="hint">${esc(t('admin.updated', { time: fmtTime(data.at) }))}</div>
      <div class="stack" style="margin:12px 0 28px"><button class="act" id="refresh">${esc(t('admin.refresh'))}</button></div>
    </section>`;
  root.querySelector('#refresh').onclick = () => renderBoard(root, ctx);
  root.querySelectorAll('.tile').forEach(a => a.onclick = e => { e.preventDefault(); root.querySelector(a.getAttribute('href'))?.scrollIntoView({ behavior: 'smooth' }); });
  root.querySelectorAll('.nudge').forEach(b => b.onclick = async () => {
    const out = root.querySelector(`.nudge-result[data-for="${CSS.escape(b.dataset.pm)}"]`);
    b.disabled = true;
    let r; try { r = await src().nudge(b.dataset.pm, ctx.crew?.lead?.name || 'Payroll'); } catch { out.innerHTML = `<div class="blockers">${esc(t('admin.loadFailed'))}</div>`; b.disabled = false; return; }
    const who = (r.name || 'PM').split(' ')[0];
    out.innerHTML = r.sent
      ? `<div class="hint ok">${esc(t('admin.nudged', { pm: who, n: r.n }))}</div>${r.preview ? `<div class="bubble vi"><p>${esc(r.preview)}</p><small class="tag">${esc(t('admin.demoText', { pm: who }))}</small></div>` : ''}`
      : `<div class="hint">${esc({ 'app-only': t('admin.nudgeAppOnly', { pm: who, phone: r.phone || '' }), recently: t('admin.nudgeRecently', { pm: who, time: r.at ? fmtTime(r.at) : '' }), 'not-enrolled': t('admin.nudgeNoPhone', { pm: who }), 'not-opted-in': t('admin.nudgeNotOptedIn', { pm: who, phone: r.phone || '' }), 'nothing-waiting': t('admin.noneWaiting') }[r.reason] || r.reason)}</div>`;
    if (r.sent) toast(t('admin.nudged', { pm: who, n: r.n })); else b.disabled = false;
  });
}

// ---- People -------------------------------------------------------------------------------------
const ROLES = ['installer', 'measure', 'pm'];
const LANGS = { en: 'English', es: 'Español', bi: 'English + Español' };
async function renderPeople(root, ctx, filter = '') {
  const title = t('admin.people');
  loading(root, ctx, title);
  let people; try { people = (await src().people()).filter(p => p.role !== 'admin' || p.phone === ctx.crew?.lead?.phone); } catch { return failed(root, ctx, title, () => renderPeople(root, ctx)); }
  const draw = () => {
    const q = filter.trim().toLowerCase();
    const shown = people.filter(p => !q || `${p.name} ${p.phone} ${p.account?.Name || ''}`.toLowerCase().includes(q));
    root.innerHTML = `${head(ctx, title, esc(t('admin.peopleSub')))}
      <section class="sec">
        <div class="card drawform"><label>${esc(t('admin.search'))}<input id="pSearch" value="${esc(filter)}" placeholder="${esc(t('admin.searchHint'))}" autocomplete="off"></label></div>
        ${[...ROLES, 'admin'].map(role => { const rows = shown.filter(p => (p.role || 'installer') === role); return rows.length ? `<h2 style="margin-top:16px">${esc(t('admin.role.' + role))} <span>${rows.length}</span></h2>
          <div class="card"><ul class="blist">${rows.map(p => `<li class="brow person ${p.disabled ? 'off' : ''}" ${role === 'admin' ? '' : `data-phone="${esc(p.phone)}" tabindex="0" role="button"`}>
            <div><b>${esc(p.name)}</b>${p.disabled ? ` <span class="chip bad">${esc(t('admin.off'))}</span>` : ''}
              <div class="sub">${esc(p.phone)}${p.account?.Name ? ` · ${esc(p.account.Name)}` : ''}</div>
              <div class="sub">${esc(LANGS[p.lang] || p.lang || '')} · ${esc(t('admin.channel.' + (p.channel || 'both')))}${p.textOptIn ? ` · <span class="optin ${esc(p.textOptIn)}">${esc(t('admin.optin.' + p.textOptIn))}</span>` : ''}${p.requested ? ` · ${esc(t('admin.asked', { language: p.requested }))}` : ''}</div></div>
            ${role === 'admin' ? `<span class="chip muted">${esc(t('admin.you'))}</span>` : '<span class="chev">›</span>'}</li>`).join('')}</ul></div>` : ''; }).join('') || `<div class="card"><p>${esc(t('admin.noMatch'))}</p></div>`}
        <div class="stack" style="margin:16px 0 28px"><button class="act primary" id="pAdd">${esc(t('admin.addPerson'))}</button>
          <div class="hint" style="margin-top:0">${esc(t('admin.addHint'))}</div></div>
      </section>`;
    const s = root.querySelector('#pSearch');
    s.oninput = () => { filter = s.value; const pos = s.selectionStart; draw(); const n = root.querySelector('#pSearch'); n.focus(); n.setSelectionRange(pos, pos); };
    root.querySelectorAll('[data-phone]').forEach(el => { const open = () => editPerson(people.find(p => p.phone === el.dataset.phone)); el.onclick = open; el.onkeydown = e => { if (e.key === 'Enter') open(); }; });
    root.querySelector('#pAdd').onclick = () => editPerson(null);
  };
  const editPerson = p => {
    const isNew = !p; p = p || { name: '', phone: '', role: 'installer', lang: 'en', channel: 'both' };
    root.innerHTML = `${head(ctx, t(isNew ? 'admin.addPerson' : 'admin.editPerson'), isNew ? '' : esc(p.phone))}
      <section class="sec"><form class="card drawform" id="pForm">
        <label>${esc(t('admin.name'))}<input name="name" required value="${esc(p.name)}" autocomplete="off"></label>
        <label>${esc(t('admin.mobile'))}<input name="phone" type="tel" required value="${esc(p.phone)}" ${isNew ? '' : 'readonly'}></label>
        <label>${esc(t('admin.roleLabel'))}<select name="role">${ROLES.map(r => `<option value="${r}" ${p.role === r ? 'selected' : ''}>${esc(t('admin.role.' + r))}</option>`).join('')}</select></label>
        <label>${esc(t('lang.title'))}<select name="lang">${Object.entries(LANGS).map(([k, v]) => `<option value="${k}" ${p.lang === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
        <label>${esc(t('admin.channelLabel'))}<select name="channel">${['both', 'app', 'text'].map(c => `<option value="${c}" ${(p.channel || 'both') === c ? 'selected' : ''}>${esc(t('admin.channel.' + c))}</option>`).join('')}</select></label>
        ${isNew ? `<label>${esc(t('admin.sfId'))}<input name="sfid" placeholder="0Hn… / 005…" autocomplete="off"><small class="hint">${esc(t('admin.sfIdHint'))}</small></label>` : ''}
        ${isNew ? '' : `<label class="choice stop"><input type="checkbox" name="disabled" ${p.disabled ? 'checked' : ''}><span><b>${esc(t('admin.turnOff'))}</b><small>${esc(t('admin.turnOffHint'))}</small></span></label>`}
        <div class="stack"><button class="act primary">${esc(t('admin.save'))}</button><button type="button" class="act" id="pCancel">${esc(t('confirm.no'))}</button></div>
        <div id="pErr"></div>
      </form></section>`;
    root.querySelector('#pCancel').onclick = () => draw();
    root.querySelector('#pForm').onsubmit = async e => {
      e.preventDefault();
      const f = new FormData(e.target), sfid = String(f.get('sfid') || '').trim(), role = String(f.get('role'));
      const next = { ...p, name: String(f.get('name')).trim(), phone: isNew ? String(f.get('phone')).trim() : p.phone, role, lang: String(f.get('lang')), channel: String(f.get('channel')), disabled: f.get('disabled') === 'on',
        ...(sfid ? (role === 'pm' ? { userId: sfid } : { serviceResourceIds: [sfid] }) : {}) };
      if (next.disabled && !p.disabled && !(await confirmSheet({ title: t('admin.turnOffConfirm', { name: next.name }), lines: [], note: t('admin.turnOffHint'), yes: t('admin.turnOff'), no: t('confirm.no') }))) return;
      try { const saved = await src().savePerson(next); people = people.filter(x => x.phone !== p.phone && x.phone !== saved.phone).concat(saved); toast(t('admin.saved', { name: saved.name })); draw(); }
      catch (err) { root.querySelector('#pErr').innerHTML = `<div class="blockers">${esc(err.message || t('admin.loadFailed'))}</div>`; }
    };
  };
  draw();
}

// ---- Rollout ------------------------------------------------------------------------------------
async function renderRollout(root, ctx) {
  const title = t('admin.rollout');
  loading(root, ctx, title);
  let r; try { r = structuredClone(await src().rollout()); } catch { return failed(root, ctx, title, () => renderRollout(root, ctx)); }
  r.locations ||= {};
  const draw = () => {
    root.innerHTML = `${head(ctx, title, esc(t('admin.rolloutSub')))}
      ${Object.entries(r.locations).map(([loc, l]) => `<section class="sec"><h2>${esc(loc)}</h2><div class="card">
        <div class="seg" role="radiogroup" aria-label="${esc(loc)}">${['off', 'pilot', 'on'].map(m => `<button type="button" role="radio" aria-checked="${l.mode === m}" class="${l.mode === m ? 'on' : ''}" data-loc="${esc(loc)}" data-mode="${m}">${esc(t('admin.mode.' + m))}</button>`).join('')}</div>
        <p class="hint">${esc(t('admin.modeHint.' + l.mode))}</p>
        ${l.mode === 'pilot' ? list(loc, 'pilotAccounts', t('admin.pilotAccounts')) : ''}
        ${l.mode === 'on' ? list(loc, 'optOutAccounts', t('admin.optOuts')) : ''}
      </div></section>`).join('')}
      <section class="sec"><div class="card drawform"><label>${esc(t('admin.addLocation'))}<input id="newLoc" placeholder="${esc(t('admin.addLocationHint'))}"></label>
        <button type="button" class="act" id="addLoc">${esc(t('admin.add'))}</button></div>
        <div class="hint">${esc(t('admin.rolloutNote'))}</div>
        <div class="stack" style="margin:12px 0 28px"><button class="act primary" id="saveRoll">${esc(t('admin.save'))}</button></div></section>`;
    root.querySelectorAll('.seg button').forEach(b => b.onclick = () => { r.locations[b.dataset.loc].mode = b.dataset.mode; draw(); });
    root.querySelectorAll('[data-add]').forEach(b => b.onclick = () => {
      const [loc, key] = b.dataset.add.split('|'), inp = root.querySelector(`[data-in="${CSS.escape(b.dataset.add)}"]`), v = inp.value.trim();
      if (v) { (r.locations[loc][key] ||= []).includes(v) || r.locations[loc][key].push(v); draw(); }
    });
    root.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { const [loc, key, i] = b.dataset.rm.split('|'); r.locations[loc][key].splice(Number(i), 1); draw(); });
    root.querySelector('#addLoc').onclick = () => { const v = root.querySelector('#newLoc').value.trim(); if (v && !r.locations[v]) { r.locations[v] = { mode: 'off', pilotAccounts: [], optOutAccounts: [] }; draw(); } };
    root.querySelector('#saveRoll').onclick = async () => {
      const lines = Object.entries(r.locations).map(([loc, l]) => [loc, t('admin.mode.' + l.mode) + (l.mode === 'pilot' ? ` (${(l.pilotAccounts || []).length})` : l.mode === 'on' && l.optOutAccounts?.length ? ` · ${t('admin.optOutsShort', { n: l.optOutAccounts.length })}` : '')]);
      if (!(await confirmSheet({ title: t('admin.rolloutConfirm'), lines, note: t('admin.rolloutConfirmNote'), yes: t('admin.save'), no: t('confirm.no') }))) return;
      try { r = structuredClone(await src().setRollout(r)); ctx.rollout = r; toast(t('admin.rolloutSaved')); draw(); } catch (e) { toast(e.message || t('admin.loadFailed')); }
    };
  };
  const list = (loc, key, label) => { const items = r.locations[loc][key] || []; return `<div class="acct"><b>${esc(label)}</b>
    ${items.length ? `<ul>${items.map((a, i) => `<li>${esc(a)} <button type="button" class="linkbtn" data-rm="${esc(`${loc}|${key}|${i}`)}">${esc(t('admin.remove'))}</button></li>`).join('')}</ul>` : `<p class="hint">${esc(t('admin.noneYet'))}</p>`}
    <div class="acct-add"><input data-in="${esc(`${loc}|${key}`)}" placeholder="${esc(t('admin.accountHint'))}"><button type="button" class="act" data-add="${esc(`${loc}|${key}`)}">${esc(t('admin.add'))}</button></div></div>`; };
  draw();
}

// ---- Health -------------------------------------------------------------------------------------
async function renderHealth(root, ctx) {
  const title = t('admin.health');
  loading(root, ctx, title);
  let h, reqs; try { [h, reqs] = await Promise.all([src().health(), src().languageRequests()]); } catch { return failed(root, ctx, title, () => renderHealth(root, ctx)); }
  const ok = !h.failing;
  root.innerHTML = `${head(ctx, title)}
    <section class="sec"><div class="card health ${ok ? 'ok' : 'bad'}">
      <h3>${esc(t(ok ? 'admin.healthOk' : 'admin.healthBad', { step: h.failing || '' }))}</h3>
      <p class="sub">${h.lastOk ? esc(t('admin.lastOk', { when: `${fmtDate(h.lastOk, { month: 'short', day: 'numeric' })} ${fmtTime(h.lastOk)}` })) : esc(t('admin.neverOk'))}</p>
      ${h.failing ? `<p class="sub">${esc(h.error || '')}</p><p class="hint">${esc(t('admin.whoToCall.' + (['login', 'read', 'write'].includes(h.failing) ? 'sf' : 'aws')))}</p>` : `<p class="hint">${esc(t('admin.healthExplain'))}</p>`}
      <div class="stack"><button class="act" id="runHb">${esc(t('admin.runNow'))}</button></div>
    </div></section>
    <section class="sec"><h2>${esc(t('admin.langRequests'))} <span>${reqs.length}</span></h2>
      <div class="card">${reqs.length ? `<ul class="blist">${reqs.map(q => `<li class="brow"><div><b>${esc(q.person)}</b><div class="sub">${esc(q.phone || '')}</div></div><span class="chip">${esc(q.language)}</span></li>`).join('')}</ul>` : `<p class="hint" style="margin:0">${esc(t('admin.none'))}</p>`}
      <div class="hint">${esc(t('admin.langHint'))}</div></div></section>
    <section class="sec" style="padding-bottom:28px"><h2>${esc(t('admin.whoToCallTitle'))}</h2>
      <div class="card"><ul class="blist">${['pay', 'invoice', 'sf', 'aws', 'crew'].map(k => `<li class="brow"><div><b>${esc(t('admin.call.' + k))}</b><div class="sub">${esc(t('admin.call.' + k + '.who'))}</div></div></li>`).join('')}</ul></div>
      <div class="stack" style="margin-top:24px"><button class="act" id="switchCrew">${esc(t(apiMode ? 'app.signOut' : 'app.switchCrew'))}</button></div></section>`;
  root.querySelector('#switchCrew').onclick = ctx.switchCrew;
  root.querySelector('#runHb').onclick = async e => {
    e.target.disabled = true; e.target.textContent = t('admin.running');
    try { const r = await src().runHeartbeat(); toast(r.ok ? t('admin.healthOk') : t('admin.healthBad', { step: r.step })); } catch { toast(t('admin.loadFailed')); }
    renderHealth(root, ctx);
  };
}

export const ADMIN_NAV = [
  ['admin', 'nav.payRun', 'draw', '#/admin'],
  ['admin/people', 'nav.people', 'people', '#/admin/people'],
  ['admin/rollout', 'nav.rollout', 'toggle', '#/admin/rollout'],
  ['admin/health', 'nav.health', 'pulse', '#/admin/health'],
  ['vi', 'nav.vi', 'vi', '#/vi']
];
