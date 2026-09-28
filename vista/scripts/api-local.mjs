// The Vista API on this computer, with fake Salesforce / Twilio / S3 / Claude (the test doubles).
// Lets you try the app's live mode (text-code sign-in, snapshot, sync) without AWS:
//   node scripts/api-local.mjs          # API on :4174, sign-in codes print here
//   VISTA_API_URL=http://localhost:4174 npm run dev
// Test phones: 706-555-0112 (Tucker), 706-555-0107 (Luis), 706-555-0133 (Rafael), 706-555-0100 (Mike, PM).
import http from 'node:http';
import { createHandler } from '../api/src/http.mjs';
import { testDeps } from '../api/test/fakes.mjs';

const PORT = Number(process.env.API_PORT || 4174);
const APP = process.env.APP_ORIGIN || 'http://localhost:4173';
const deps = await testDeps();
deps.config.appUrl = APP;
const send = deps.twilio.send;
deps.twilio.send = async (to, body) => { console.log(`  text to ${to}: ${body}`); return send(to, body); };
const handler = createHandler(async () => deps);

http.createServer(async (req, res) => {
  const cors = { 'access-control-allow-origin': APP, 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, PUT, PATCH, OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); } // API Gateway answers preflight in AWS
  const chunks = []; for await (const c of req) chunks.push(c);
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const r = await handler({ rawPath: url.pathname, rawQueryString: url.search.slice(1), headers: req.headers, body: Buffer.concat(chunks).toString(),
    requestContext: { http: { method: req.method }, domainName: `localhost:${PORT}` } });
  console.log(`${req.method} ${url.pathname} ${r.statusCode}`);
  res.writeHead(r.statusCode, { ...cors, ...r.headers }); res.end(r.body);
}).listen(PORT, () => console.log(`Vista API (fakes) → http://localhost:${PORT}  app origin ${APP}`));
