// Sign-in by text-message code, then a signed app token (HS256).
import crypto from 'node:crypto';

const b64 = x => Buffer.from(JSON.stringify(x)).toString('base64url');
export function signToken(claims, secret, ttlSeconds = 30 * 24 * 3600, now = Date.now()) {
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ ...claims, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + ttlSeconds })}`;
  return `${body}.${crypto.createHmac('sha256', secret).update(body).digest('base64url')}`;
}
export function verifyToken(token, secret, now = Date.now()) {
  const [h, p, s] = String(token || '').split('.');
  if (!h || !p || !s) return null;
  const expect = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  if (expect.length !== s.length || !crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(s))) return null;
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  return claims.exp * 1000 > now ? claims : null;
}

// US numbers only for now: "706-555-0112", "(706) 555 0112", "+1 706…" -> "+17065550112".
export function normalizePhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return null;
}

const hashCode = (phone, code, secret) => crypto.createHmac('sha256', secret).update(`${phone}:${code}`).digest('hex');
export function createAuth({ store, secret, sendText, now = () => Date.now() }) {
  return {
    // Always answers the same way, whether or not the number is enrolled, so numbers can't be probed.
    async start(phone, person, lang) {
      if (!person || person.disabled) return;
      // At most one code per 30 seconds and 5 per hour per number, so nobody can flood a phone.
      const prev = await store.get(`OTP#${phone}`, 'RATE');
      const sends = (prev?.sends || []).filter(t => t > now() - 3600e3);
      if (sends.length >= 5 || (sends.length && sends.at(-1) > now() - 30e3)) return;
      await store.put({ pk: `OTP#${phone}`, sk: 'RATE', sends: [...sends, now()], ttl: Math.floor(now() / 1000) + 3600 });
      const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
      await store.put({ pk: `OTP#${phone}`, sk: 'CODE', hash: hashCode(phone, code, secret), tries: 0, ttl: Math.floor(now() / 1000) + 600 });
      const en = `Vista: your code is ${code}. It expires in 10 minutes.`, es = `Vista: su código es ${code}. Vence en 10 minutos.`;
      const l = ['en', 'es', 'bi'].includes(lang) ? lang : person.lang || 'en';
      await sendText(phone, l === 'es' ? es : l === 'bi' ? `${en}\n${es}` : en);
    },
    async verify(phone, code) {
      const item = await store.get(`OTP#${phone}`, 'CODE');
      if (!item || item.ttl * 1000 < now()) return false;
      if (item.tries >= 5) { await store.del(`OTP#${phone}`, 'CODE'); return false; }
      const ok = item.hash === hashCode(phone, String(code).trim(), secret);
      if (ok) await store.del(`OTP#${phone}`, 'CODE'); else await store.put({ ...item, tries: item.tries + 1 });
      return ok;
    }
  };
}
