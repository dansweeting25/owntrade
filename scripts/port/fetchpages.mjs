// node fetchpages.mjs <origin> <outdir> <extra paths...>  — fetch sitemap URLs + extras + a 404 page
import fs from 'node:fs/promises'; import path from 'node:path';
const [origin, out, ...extra] = process.argv.slice(2);

import { get as g, sleep } from './httpget.mjs';
const get = async (u) => { await sleep(1100); const r = g(u); return { ...r, body: r.body.toString('utf8') }; };
const LIST = process.env.URL_LIST;
const sm = LIST ? { body: '' } : await get(origin + '/sitemap_index.xml');
let locs = [...sm.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
const nested = locs.filter(l => /\.xml$/.test(l));
for (const n of nested) { const s = await get(n); locs.push(...[...s.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1])); }
const listed = LIST ? (await fs.readFile(LIST, 'utf8')).split('\n').filter(Boolean) : [];
const paths = [...new Set([...listed, ...locs.filter(l => !/\.xml$/.test(l)).map(l => new URL(l).pathname), ...extra])];
await fs.mkdir(out, { recursive: true });
const manifest = [];
for (const p of paths) {
  const file = path.join(out, 'pages', p === '/' ? 'index.html' : p.replace(/^\//, '').replace(/\/$/, '') + '/index.html');
  try { const st = await fs.stat(file); if (st.size > 5000) { manifest.push({ path: p, status: 200, cached: true }); continue; } } catch {}
  const r = await get(origin + p);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, r.body);
  manifest.push({ path: p, status: r.status, loc: r.loc, bytes: r.body.length });
  console.log(r.status, p, r.loc || '', r.body.length);
}
const nf = await get(origin + '/zz-not-a-page-404/');
await fs.writeFile(path.join(out, 'pages', '404.html'), nf.body);
console.log('404 page', nf.status, nf.body.length);
if (LIST) process.exit(0);
// sitemap + robots files as-is
for (const f of ['sitemap_index.xml', 'sitemap.xml', 'sitemap.xsl', 'sitemap.css', 'robots.txt', ...nested.map(n => new URL(n).pathname.slice(1))]) {
  const r = await get(origin + '/' + f); if (r.status === 200) { await fs.mkdir(path.join(out, 'files'), { recursive: true }); await fs.writeFile(path.join(out, 'files', f), r.body); console.log('file', f, r.ct); }
}
await fs.writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 1));
