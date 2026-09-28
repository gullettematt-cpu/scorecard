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

export function createTwilio({ accountSid, authToken, from, fetchImpl = fetch }) {
  const auth = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  return {
    async send(to, body) {
      const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
        method: 'POST', headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: to, From: from, Body: body })
      });
      if (!res.ok) throw new Error(`Twilio send failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
      return (await res.json()).sid;
    },
    async fetchMedia(url) {
      const res = await fetchImpl(url, { headers: { authorization: auth }, redirect: 'follow' });
      if (!res.ok) throw new Error(`Twilio media fetch failed (${res.status})`);
      return { body: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || 'image/jpeg' };
    }
  };
}
