// IndexedDB wrapper. Offline-first: the phone always reads from here.
// Demo mode on the live app (demo.js) keeps its sample jobs in a separate database, so live data is never touched.
const NAME = globalThis.VISTA_DEMO ? 'vista-demo' : 'vista', VER = 2;
// photos: job photos taken in the app, kept on the phone until uploaded (Id = storage key).
const STORES = ['jobs', 'draws', 'cases', 'checklist', 'outbox', 'meta', 'photos'];
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) {
        db.createObjectStore(s, s === 'outbox' ? { keyPath: 'seq', autoIncrement: true } : { keyPath: 'Id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted')); // never leave a screen waiting forever
  }));
}
export const db = {
  all: store => tx(store, 'readonly', s => s.getAll()),
  get: (store, id) => tx(store, 'readonly', s => s.get(id)),
  put: (store, obj) => tx(store, 'readwrite', s => s.put(obj)),
  putAll: (store, arr) => tx(store, 'readwrite', s => { arr.forEach(o => s.put(o)); }),
  del: (store, id) => tx(store, 'readwrite', s => s.delete(id)),
  clear: store => tx(store, 'readwrite', s => s.clear()),
  count: store => tx(store, 'readonly', s => s.count()),
  meta: async (k, v) => (v === undefined ? (await db.get('meta', k))?.v : db.put('meta', { Id: k, v })),
  wipe: () => Promise.all(STORES.map(s => tx(s, 'readwrite', st => st.clear())))
};
