// Text messages (Twilio): send, verify inbound webhooks, download picture messages.
import crypto from 'node:crypto';

export function twilioSignature(authToken, url, params) {
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join('');
  return crypto.createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}
export function validTwilioSignature({ authToken, url, params, signature }) {
  const a = Buffer.from(twilioSignature(authToken, url, params)), b = Buffer.from(String(signature || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Sends from a Messaging Service when one is given (the usual way to hold an A2P 10DLC campaign and a
// number pool), otherwise from the single number in `from`.
export function createTwilio({ accountSid, authToken, from, messagingServiceSid, fetchImpl = fetch }) {
  const auth = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const call = async (url, form) => {
    const res = await fetchImpl(url, form ? { method: 'POST', headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) } : { headers: { authorization: auth } });
    if (!res.ok) throw new Error(`Twilio ${form ? 'update' : 'read'} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    return res.json();
  };
  const messaging = (path, form) => call(`https://messaging.twilio.com/v1${path}`, form);
  const rest = (path, form) => call(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}${path}`, form);
  return {
    async send(to, body) {
      const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
        method: 'POST', headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: to, Body: body, ...(messagingServiceSid ? { MessagingServiceSid: messagingServiceSid } : { From: from }) })
      });
      if (!res.ok) throw new Error(`Twilio send failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
      return (await res.json()).sid;
    },
    async fetchMedia(url) {
      const res = await fetchImpl(url, { headers: { authorization: auth }, redirect: 'follow' });
      if (!res.ok) throw new Error(`Twilio media fetch failed (${res.status})`);
      return { body: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || 'image/jpeg' };
    },
    // ---- Read-only checks and the two self-repairs Diagnose may make (lib/diagnose.mjs) -----------------
    info: { accountSid, from, messagingServiceSid },
    async service() { return messaging(`/Services/${messagingServiceSid}`); },
    async serviceNumbers() { return (await messaging(`/Services/${messagingServiceSid}/PhoneNumbers?PageSize=50`)).phone_numbers || []; },
    async campaigns() { return (await messaging(`/Services/${messagingServiceSid}/Compliance/Usa2p?PageSize=20`)).compliance || []; },
    // Point the Messaging Service's incoming texts at Vista (and stop numbers overriding it with their own webhook).
    async setInbound(url) {
      return messaging(`/Services/${messagingServiceSid}`, { InboundRequestUrl: url, InboundMethod: 'POST', UseInboundWebhookOnNumber: 'false' });
    },
    // Put the Vista number into the Messaging Service's sender pool.
    async addNumber(e164) {
      const r = await rest(`/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(e164)}`);
      const pn = r.incoming_phone_numbers?.[0];
      if (!pn) throw new Error(`${e164} isn't a number on this Twilio account`);
      return messaging(`/Services/${messagingServiceSid}/PhoneNumbers`, { PhoneNumberSid: pn.sid });
    },
    // Only Twilio media URLs on this account are ever deleted.
    async deleteMedia(url) {
      const u = new URL(url);
      if (u.hostname !== 'api.twilio.com' || !u.pathname.startsWith(`/2010-04-01/Accounts/${accountSid}/Messages/`) || !/\/Media\/ME\w+$/.test(u.pathname)) return false;
      const res = await fetchImpl(`${u.origin}${u.pathname}.json`, { method: 'DELETE', headers: { authorization: auth } });
      if (!res.ok && res.status !== 404) throw new Error(`Twilio media delete failed (${res.status})`);
      return true;
    }
  };
}
