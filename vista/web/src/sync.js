// Outbox: every local write lands here and drains when online.
import { db } from './db.js';
import { adapter } from './data.js';

const listeners = new Set();
export const onSync = fn => (listeners.add(fn), () => listeners.delete(fn));
const emit = () => listeners.forEach(fn => fn());

export async function enqueue(kind, payload) {
  // A checklist save replaces the one still waiting for the same job (only the latest ticks matter).
  if (kind === 'checklist') for (const e of await db.all('outbox')) if (e.kind === 'checklist' && e.payload?.workOrderId === payload.workOrderId) await db.del('outbox', e.seq);
  await db.put('outbox', { kind, payload, at: new Date().toISOString() });
  emit();
  if (navigator.onLine) flush();
}
let flushing = false;
export const rejected = []; // server refusals, shown to the person once
export async function flush() {
  if (flushing || !navigator.onLine) return;
  flushing = true;
  try {
    for (const entry of await db.all('outbox')) {
      const res = await adapter.push(entry);
      if (res?.rejected) rejected.push({ kind: entry.kind, error: res.rejected });
      if (res?.ok) await db.del('outbox', entry.seq); else break;
    }
  } finally { flushing = false; emit(); }
}
export const pendingCount = () => db.count('outbox');
window.addEventListener('online', flush);
window.addEventListener('focus', flush);
