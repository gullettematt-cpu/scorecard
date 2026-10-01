// Job photos taken in the app. Each photo is shrunk on the phone (long side 1600 px, JPEG), kept in
// IndexedDB under its storage key, and uploaded by the outbox ('photo.upload') before the pay request
// that lists it. "No photos, no pay": the server checks every key arrived before writing Salesforce.
import { db } from './db.js';

const MAX = 1600, QUALITY = 0.8;

// Same key scheme as the API (api/src/lib/photos.mjs): vista/<WorkOrder>/<ServiceAppointment>/<time>-<kind>-<n>.jpg
export function photoKey({ workOrderId, serviceAppointmentId, kind, n, at = new Date() }) {
  const ts = at.toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  return `vista/${workOrderId}/${serviceAppointmentId || 'job'}/${ts}-${String(kind).replace(/\W/g, '')}-${n}.jpg`;
}

export async function shrink(file) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    return await new Promise(res => c.toBlob(b => res(b || file), 'image/jpeg', QUALITY));
  } catch { return file; } // a format the browser can't decode: keep the original
}

// draft = taken but not submitted yet (it survives closing the app). purpose = 'pay' or 'problem'.
export async function savePhoto({ key, blob, kind, workOrderId, draft = true, purpose = 'pay' }) {
  await db.put('photos', { Id: key, blob, kind, workOrderId, draft, purpose, takenAt: new Date().toISOString(), uploaded: false });
}
export const dropPhoto = key => db.del('photos', key);
export const photosFor = async (workOrderId, purpose = 'pay') => (await db.all('photos')).filter(p => p.workOrderId === workOrderId && (p.purpose || 'pay') === purpose);

// Where to show a photo: the copy on this phone if there is one, else a short-lived link from the API.
const urls = new Map();
export async function photoSrc(key, remote = {}) {
  if (urls.has(key)) return urls.get(key);
  const local = await db.get('photos', key);
  const src = local?.blob ? URL.createObjectURL(local.blob) : remote[key] || null;
  if (src) urls.set(key, src);
  return src;
}
