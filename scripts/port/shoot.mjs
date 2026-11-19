// Visual check: serve <projectDir>/dist locally, load each page in Chromium, report failed requests,
// and (optionally) screenshot it next to the live page.
// node shoot.mjs <projectDir> <liveOrigin|-> <outDir> [paths...]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const [dir, live, outDir, ...only] = process.argv.slice(2);
const dist = path.resolve(dir, 'dist');
fs.mkdirSync(outDir, { recursive: true });
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.json': 'application/json', '.xml': 'application/xml', '.gif': 'image/gif', '.mp4': 'video/mp4' };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(dist, p);
  if (!f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'content-type': types[path.extname(f).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(0);
const port = srv.address().port;
const base = `http://127.0.0.1:${port}`;

const pages = only.length ? only : fs.readdirSync(path.join(dir, 'scripts/port-snapshot')).map((f) => f.replace(/\.html$/, '')).filter((n) => n !== '404').map((n) => (n === 'index' ? '/' : '/' + n.replace(/__/g, '/') + '/'));
const browser = await chromium.launch(true ? { proxy: { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } } : {});
const widths = [1440, 393];
let failures = 0;
for (const p of pages) {
  for (const width of widths) {
    for (const [label, origin] of [['new', base], ...(live !== '-' ? [['live', live]] : [])]) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 }});
      const page = await ctx.newPage();
      const failed = [];
      page.on('response', (r) => { if (r.status() >= 400 && r.url().startsWith(base)) failed.push(r.status() + ' ' + r.url().slice(base.length)); });
      page.on('requestfailed', (r) => { if (r.url().startsWith(base)) failed.push('ERR ' + r.url().slice(base.length)); });
      try {
        await page.goto(origin + p, { waitUntil: 'networkidle', timeout: 60000 });
        await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); } window.scrollTo(0, 0); });
        await page.waitForTimeout(800);
        const name = (p === '/' ? 'home' : p.replace(/^\/|\/$/g, '').replace(/\//g, '_')) + `-${width}-${label}.png`;
        await page.screenshot({ path: path.join(outDir, name), fullPage: true });
        const h = await page.evaluate(() => [document.documentElement.scrollHeight, document.documentElement.scrollWidth]);
        console.log(label.padEnd(4), String(width).padEnd(5), p, 'height', h[0], 'width', h[1], failed.length ? 'FAILED: ' + failed.join(', ') : '');
        if (label === 'new' && failed.length) failures++;
      } catch (e) { console.log(label, width, p, 'ERROR', e.message.split('\n')[0]); }
      await ctx.close();
    }
  }
}
await browser.close();
srv.close();
process.exit(failures ? 1 : 0);
