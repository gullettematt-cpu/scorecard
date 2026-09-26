// Zero-dependency static server for local dev.
// Serves web/ at / and ../i18n at /i18n so the app sees the same paths as the CDN build.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(root, 'web');
const I18N = path.join(root, 'i18n');
const PORT = Number(process.env.PORT || 4173);

const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2'
};

http.createServer((req, res) => {
  let url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = url.startsWith('/i18n/') ? path.join(I18N, url.slice(6)) : path.join(WEB, url);
  if (url === '/' || !path.extname(file)) file = path.join(WEB, 'index.html');
  if (!file.startsWith(WEB) && !file.startsWith(I18N)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'content-type': types[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
      'service-worker-allowed': '/'
    });
    res.end(buf);
  });
}).listen(PORT, () => console.log(`Vista dev → http://localhost:${PORT}`));
