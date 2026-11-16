#!/usr/bin/env node
/*
 * Static file server for the demo. Zero dependencies (Node >= 18).
 * Serves ./public with byte-range support and prints the LAN URLs.
 *
 *   PORT (default 8080), HOST (default 0.0.0.0)
 *
 * MIT licence, see LICENSE.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = +(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.join(__dirname, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.webm': 'audio/webm', '.svg': 'image/svg+xml',
};

http.createServer((req, res) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Length, Content-Range', 'Cache-Control': 'no-cache' };
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { res.writeHead(400, headers); return res.end(); }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403, headers); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, headers); return res.end('not found'); }
    headers['Content-Type'] = TYPES[path.extname(file)] || 'application/octet-stream';
    headers['Accept-Ranges'] = 'bytes';
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    let start = 0, end = st.size - 1, code = 200;
    if (m && (m[1] || m[2])) {
      start = m[1] ? +m[1] : Math.max(0, st.size - +m[2]);
      end = m[1] && m[2] ? Math.min(+m[2], st.size - 1) : st.size - 1;
      if (start > end) { res.writeHead(416, Object.assign(headers, { 'Content-Range': 'bytes */' + st.size })); return res.end(); }
      code = 206; headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(code, headers);
    if (req.method === 'HEAD' || st.size === 0) return res.end();
    fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
  });
}).listen(PORT, HOST, () => {
  console.log(`Gapless Cast demo on port ${PORT}`);
  console.log(`  this computer:  http://localhost:${PORT}/`);
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) {
    if (a.family === 'IPv4' && !a.internal) console.log(`  receiver URL:   http://${a.address}:${PORT}/receiver.html`);
  }
});
