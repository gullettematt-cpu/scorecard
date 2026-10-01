// Vista service worker — app shell offline. Bump VERSION on every deploy.
const VERSION = 'vista-0.16.0';
const SHELL = [
  './', './index.html', './styles.css', './manifest.webmanifest', './icons/vista.svg',
  './config.js', './src/app.js', './src/api.js', './src/rollout.js', './src/prefs.js', './src/translate.js', './src/i18n.js', './src/db.js', './src/data.js', './src/sync.js', './src/ui.js',
  './src/screens/today.js', './src/screens/job.js', './src/screens/vi.js', './src/screens/admin.js', './src/screens/approve.js', './src/screens/pay.js', './src/screens/problem.js', './src/photos.js',
  './i18n/en.json', './i18n/es.json',
  './content/checklists/windows.json', './content/checklists/siding.json', './content/draw-rules.json',
  './fixtures/crews.json', './fixtures/crew-12.json', './fixtures/crew-7.json', './fixtures/measure-3.json', './fixtures/rollout.json', './fixtures/translations.json'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // API calls: network first, cache fallback. Shell: cache first, refresh in background.
  const isApi = url.pathname.includes('/api/') || url.pathname.endsWith('/config.js');
  e.respondWith(isApi ? networkFirst(e.request) : cacheFirst(e.request));
});
async function cacheFirst(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req, { ignoreSearch: true });
  const fresh = fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
  return hit || (await fresh) || new Response('offline', { status: 503 });
}
async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  try { const res = await fetch(req); if (res.ok) cache.put(req, res.clone()); return res; }
  catch { return (await cache.match(req)) || new Response('{"offline":true}', { status: 503, headers: { 'content-type': 'application/json' } }); }
}
