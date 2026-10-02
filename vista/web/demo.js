// Demo mode on the live app. "Try the demo" on the sign-in screen, or a link with ?demo, runs Vista on the sample
// jobs instead of Salesforce: no sign-in, its own storage on the phone, nothing sent anywhere. The live sign-in and
// data are left as they are. ?demo=installer|es|measure|pm|admin opens straight as that person; ?demo=off ends it.
// Runs before the app (a classic script after config.js), so the app simply starts without an API address.
(() => {
  const PEOPLE = { installer: 'crew-12', crew: 'crew-12', es: 'crew-7', measure: 'measure-3', pm: 'pm-mike', manager: 'pm-mike', admin: 'admin-lisa' };
  const ls = (() => { try { return window.localStorage; } catch { return null; } })();
  const url = new URL(location.href), q = url.searchParams.get('demo');
  if (q !== null && ls) {
    if (q === 'off') { ls.removeItem('vista.demoMode'); ls.removeItem('vista.crew'); }
    else { ls.setItem('vista.demoMode', '1'); if (PEOPLE[q]) ls.setItem('vista.crew', PEOPLE[q]); }
    url.searchParams.delete('demo');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
  const cfg = window.VISTA_CONFIG || {};
  if (cfg.apiUrl && ls?.getItem('vista.demoMode') === '1') {
    window.VISTA_DEMO = { liveApiUrl: cfg.apiUrl };
    window.VISTA_CONFIG = { ...cfg, apiUrl: null };
  }
})();
