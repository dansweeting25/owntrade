// WordPress/Breakdance snapshot -> Astro project.
// node wp2astro.mjs <rawDir> <origin> <projectDir>
//   rawDir: output of fetchpages.mjs (pages/**/index.html, pages/404.html)
// Writes src/layouts/Base.astro, src/components/*.astro, src/pages/**, public/** (assets downloaded from origin),
// and scripts/port-snapshot/<page>.html (the cleaned original, used by verify.mjs).
//
// EXTERNALIZE=1: inline <style>/<script> blocks of 1KB+ that repeat (across pages or within one) are moved to
// /_ported/<hash>.css|js and referenced from the same position, so the cascade and script order are unchanged.
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as cheerio from 'cheerio';
import { get, sleep } from './httpget.mjs';

const [RAW, ORIGIN, OUT] = process.argv.slice(2);
const EXTERNALIZE = process.env.EXTERNALIZE === '1';
// PATCHES=<json file>: [[find, replace], ...] applied to every cleaned page (site-specific fixes, kept in the site repo)
const PATCHES = process.env.PATCHES ? JSON.parse(fss.readFileSync(process.env.PATCHES, 'utf8')) : [];
const MIN_EXTERNAL = 1000;
const HOST = new URL(ORIGIN).host.replace(/^www\./, '');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// https://host/... and https:\/\/host\/... (JSON-escaped) -> root-relative
const HOST_RE = new RegExp(`https?:(?:\\\\?/){2}(?:www\\.)?${esc(HOST)}(?=\\\\?/)`, 'g');
const relink = (s) => s.replace(HOST_RE, '');
const hasHost = (s) => { HOST_RE.lastIndex = 0; const r = HOST_RE.test(s); HOST_RE.lastIndex = 0; return r; };

// ---------- pages ----------
const walk = (d) => fss.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const pages = [];
for (const f of walk(path.join(RAW, 'pages'))) {
  const rel = path.relative(path.join(RAW, 'pages'), f);
  pages.push({ file: f, urlPath: rel === '404.html' ? null : '/' + rel.replace(/index\.html$/, ''), is404: rel === '404.html' });
}
pages.sort((a, b) => (a.is404 - b.is404) || a.urlPath.localeCompare(b.urlPath));

// ---------- clean one page ----------
const cfDecode = (h) => { const k = parseInt(h.slice(0, 2), 16); let s = ''; for (let i = 2; i < h.length; i += 2) s += String.fromCharCode(parseInt(h.slice(i, i + 2), 16) ^ k); return s; };
const KEEP_ABSOLUTE = 'link[rel="canonical"], meta[property^="og:"], meta[name^="twitter:"], link[rel="alternate"][hreflang]';

function clean(html) {
  // Site-specific fixes first, so they also reach blocks that EXTERNALIZE moves into shared files.
  for (const [a, b] of PATCHES) html = html.split(a).join(b);
  const $ = cheerio.load(html);
  // WordPress plumbing that has no meaning without WordPress
  $('link[rel="https://api.w.org/"], link[rel="EditURI"], link[rel="shortlink"], link[rel="alternate"][type="application/json"], link[rel="alternate"][type="application/json+oembed"], link[rel="alternate"][type="text/xml+oembed"], link[rel="pingback"]').remove();
  $('meta[name="generator"]').remove();
  $('script#breeze-prefetch-js, script#breeze-prefetch-js-extra, script#wp-emoji-settings, style#wp-emoji-styles-inline-css').remove();
  $('script[src*="email-decode.min.js"]').remove();
  // Cloudflare Web Analytics beacon: Cloudflare injects it at the edge on proxied zones, so a copy would load twice.
  $('script[src*="static.cloudflareinsights.com/beacon"]').remove();
  $('script[type="module"]').each((_, el) => { if (/wp-emoji|emoji-settings/.test($(el).html() || '')) $(el).remove(); });
  // Cloudflare email obfuscation (re-applied by Cloudflare at the edge if the zone has it on)
  $('a[href^="/cdn-cgi/l/email-protection"]').each((_, el) => { const h = ($(el).attr('href') || '').split('#')[1]; if (h) $(el).attr('href', 'mailto:' + cfDecode(h)); });
  $('[data-cfemail]').each((_, el) => { $(el).replaceWith(cfDecode($(el).attr('data-cfemail'))); });
  // Root-relative URLs everywhere except SEO tags (which must stay absolute)
  $('*').each((_, el) => {
    if ($(el).is(KEEP_ABSOLUTE)) return;
    for (const [k, v] of Object.entries(el.attribs || {})) if (hasHost(v)) el.attribs[k] = relink(v);
  });
  $('script:not([type="application/ld+json"]), style').each((_, el) => {
    const t = $(el).html(); if (t && hasHost(t)) { $(el).text(''); $(el).append(relink(t)); }
  });
  // Breakdance forms post to the Worker instead of admin-ajax
  $('form[data-options]').each((_, el) => { el.attribs['data-options'] = el.attribs['data-options'].replace(/"ajaxUrl":"[^"]*"/, '"ajaxUrl":"\\/api\\/forms"'); });
  return $;
}

// inline blocks that can move to a shared file
const extKind = (el) => {
  if (el.tagName === 'style') return Object.keys(el.attribs).every((a) => ['id', 'type', 'media'].includes(a)) && !el.attribs.media ? 'css' : null;
  if (el.tagName === 'script') { const t = el.attribs.type; return !el.attribs.src && (!t || t === 'text/javascript') && Object.keys(el.attribs).every((a) => ['id', 'type'].includes(a)) ? 'js' : null; }
  return null;
};
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

// ---------- assets ----------
const ASSET_RE = /(?:\/|\\\/)(?:wp-content|wp-includes)(?:\/|\\\/)[^"'()\s<>,]+?\.(?:css|js|mjs|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|pdf|json|txt|xml)(?=[?#"'()\s<>,&]|$)/gi;
const assets = new Set();
const collect = (s) => { for (const m of s.matchAll(ASSET_RE)) { let p = m[0].replace(/\\\//g, '/'); try { p = decodeURI(p); } catch {} assets.add(p); } };

// ---------- astro serialisation ----------
const ACTIVE_CLASSES = ['is-active', 'current-menu-item', 'current_page_item', 'current-menu-ancestor', 'current-menu-parent', 'current_page_parent', 'current_page_ancestor'];
const normKey = (s) => s.replace(new RegExp(`\\s(?:${ACTIVE_CLASSES.join('|')})(?=[\\s"])`, 'g'), '').replace(/\s+aria-current="page"/g, '').replace(/\s+/g, ' ').trim();
// keyed per element (its first class, e.g. the Breakdance node class) + href: Breakdance only marks some link types
const linkKey = (el) => ((el.attribs.class || '').split(/\s+/).filter((c) => c && !ACTIVE_CLASSES.includes(c))[0] || '') + '|' + el.attribs.href;

// Serialize an item (outer HTML string) as Astro template markup.
// activeHrefs: <a> tags that carry an "active" class on some pages get class:list bound to the current path.
function toAstro(html, activeHrefs) {
  const w = cheerio.load(html, null, false);
  w('script, style').each((_, el) => { el.attribs['is:inline'] = ''; });
  if (activeHrefs) {
    w('a[href]').each((_, el) => {
      if (!activeHrefs.has(linkKey(el))) return;
      const cls = (el.attribs.class || '').split(/\s+/).filter((c) => c && !ACTIVE_CLASSES.includes(c));
      delete el.attribs.class;
      el.attribs['__CLASSLIST__'] = JSON.stringify([cls.join(' '), el.attribs.href]);
    });
  }
  // escape { } in text nodes (Astro expressions)
  const escText = (el) => {
    for (const c of el.children || []) {
      if (c.type === 'text') c.data = c.data.replace(/[{}]/g, (m) => (m === '{' ? '\u0000LB' : '\u0000RB'));
      else if (c.type === 'tag' && !['script', 'style'].includes(c.name)) escText(c);
    }
  };
  escText(w.root()[0]);
  let out = w.html();
  out = out.replace(/\u0000LB/g, '&#123;').replace(/\u0000RB/g, '&#125;');
  out = out.replace(/is:inline=""/g, 'is:inline');
  out = out.replace(/__CLASSLIST__="([^"]*)"/g, (_, j) => {
    const [cls, href] = JSON.parse(j.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    return `class:list={[${JSON.stringify(cls)}, { 'is-active': path === ${JSON.stringify(href)} }]}`;
  });
  return out;
}

const w = async (f, s) => { await fs.mkdir(path.dirname(path.join(OUT, f)), { recursive: true }); await fs.writeFile(path.join(OUT, f), s); };
const snapName = (p) => (p.is404 ? '404' : p.urlPath === '/' ? 'index' : p.urlPath.slice(1, -1).replace(/\//g, '__'));

// ---------- pass 1: which inline blocks repeat ----------
const blockPages = new Map(); // hash -> count of (page, occurrence)
if (EXTERNALIZE) {
  for (const p of pages) {
    const $ = clean(await fs.readFile(p.file, 'utf8'));
    $('style, script').each((_, el) => { if (!extKind(el)) return; const t = $(el).html() || ''; if (t.length < MIN_EXTERNAL) return; const h = hash(t); blockPages.set(h, (blockPages.get(h) || 0) + 1); });
  }
}

// ---------- pass 2: clean, externalize, split into items ----------
const activeHrefs = new Set();
const written = new Set();
let extCount = 0;
for (const p of pages) {
  const $ = clean(await fs.readFile(p.file, 'utf8'));
  if (EXTERNALIZE) {
    for (const el of $('style, script').toArray()) {
      const kind = extKind(el); if (!kind) continue;
      const t = $(el).html() || ''; if (t.length < MIN_EXTERNAL) continue;
      const h = hash(t); if ((blockPages.get(h) || 0) < 2) continue;
      const href = `/_ported/${h}.${kind}`;
      if (!written.has(h)) { written.add(h); await w('public' + href, t); }
      const id = el.attribs.id ? ` id="${el.attribs.id}"` : '';
      $(el).replaceWith(kind === 'css' ? `<link rel="stylesheet"${id} href="${href}">` : `<script${id} src="${href}"></script>`);
      extCount++;
    }
  }
  const full = $.html();
  collect(full);
  await w(`scripts/port-snapshot/${snapName(p)}.html`, full);
  $('a[href]').each((_, el) => { const c = (el.attribs.class || '').split(/\s+/); if (c.some((x) => ACTIVE_CLASSES.includes(x)) || el.attribs['aria-current']) activeHrefs.add(linkKey(el)); });
  p.head = $('head').children().toArray().map((n) => $.html(n));
  p.body = $('body').children().toArray().map((n) => $.html(n));
  p.bodyTags = $('body').children().toArray().map((n) => n.tagName);
  p.headKeys = p.head.map(normKey);
  p.bodyKeys = p.body.map(normKey);
  p.bodyClass = $('body').attr('class') || '';
  p.htmlAttrs = $('html').attr() || {};
}

// common items = present in every page, in the same relative order as page 0
function commonSeq(keyLists) {
  const sets = keyLists.slice(1).map((k) => new Set(k));
  let seq = keyLists[0].filter((k) => sets.every((s) => s.has(k)));
  seq = [...new Set(seq)];
  for (const kl of keyLists) {
    const idx = seq.map((k) => kl.indexOf(k));
    const keep = []; let last = -1;
    seq.forEach((k, i) => { if (idx[i] > last) { keep.push(k); last = idx[i]; } });
    seq = keep;
  }
  return seq;
}
const headCommon = commonSeq(pages.map((p) => p.headKeys));
const bodyCommon = commonSeq(pages.map((p) => p.bodyKeys));

// gaps: for each page, which items fall after common item k (k = -1 .. n-1)
function gaps(keys, common) {
  const g = new Map(); let k = -1;
  keys.forEach((key, i) => { const ci = common.indexOf(key); if (ci !== -1 && ci === k + 1) { k = ci; return; } if (!g.has(k)) g.set(k, []); g.get(k).push(i); });
  return g;
}
for (const p of pages) { p.headGaps = gaps(p.headKeys, headCommon); p.bodyGaps = gaps(p.bodyKeys, bodyCommon); }
const usedHeadGaps = [...new Set(pages.flatMap((p) => [...p.headGaps.keys()]))].sort((a, b) => a - b);
const usedBodyGaps = [...new Set(pages.flatMap((p) => [...p.bodyGaps.keys()]))].sort((a, b) => a - b);
const p0 = pages[0];
let mainGap = null;
for (const [k, idxs] of p0.bodyGaps) if (idxs.some((i) => p0.bodyTags[i] === 'main')) mainGap = k;
if (mainGap === null) mainGap = [...p0.bodyGaps.entries()].sort((a, b) => b[1].reduce((s, i) => s + p0.body[i].length, 0) - a[1].reduce((s, i) => s + p0.body[i].length, 0))[0]?.[0] ?? null;
const headSlot = (k) => `head-${k + 1}`;
const bodySlot = (k) => (k === mainGap ? null : `body-${k + 1}`);

// ---------- write project ----------
const pascal = (s) => s.replace(/(^|[-_\s]+)(\w)/g, (_, __, c) => c.toUpperCase()).replace(/[^A-Za-z0-9]/g, '');
const components = [];
const compNames = new Set();
const layoutBody = [];
bodyCommon.forEach((key, ci) => {
  const i = p0.bodyKeys.indexOf(key);
  const tag = p0.bodyTags[i];
  const html = toAstro(p0.body[i], activeHrefs);
  if (['header', 'footer'].includes(tag) || html.length > 1500) {
    const attribs = cheerio.load(p0.body[i], null, false).root().children().first().attr() || {};
    const cls = (attribs.class || '').split(/\s+/).filter((c) => c && !/^bde-|^breakdance/.test(c))[0];
    let name = tag === 'header' ? 'Header' : tag === 'footer' ? 'Footer' : pascal(cls || attribs.id || tag);
    while (compNames.has(name)) name += '2';
    compNames.add(name);
    const usesPath = html.includes('path ===');
    components.push({ name, html, usesPath });
    layoutBody.push({ ci, out: usesPath ? `<${name} path={path} />` : `<${name} />` });
  } else layoutBody.push({ ci, out: html });
});
for (const c of components) await w(`src/components/${c.name}.astro`, `---\n${c.usesPath ? 'interface Props { path: string }\nconst { path } = Astro.props;\n' : ''}---\n${c.html}\n`);

const htmlAttrs = Object.entries(p0.htmlAttrs).map(([k, v]) => ` ${k}="${v.replace(/"/g, '&quot;')}"`).join('');
let layout = `---\n// Shared page shell, ported from the WordPress/Breakdance output. Pages fill the named slots.\n`;
layout += components.map((c) => `import ${c.name} from '../components/${c.name}.astro';\n`).join('');
layout += `interface Props { path: string; bodyClass: string }\nconst { path, bodyClass } = Astro.props;\n---\n<!DOCTYPE html>\n<html${htmlAttrs}>\n<head>\n`;
const headLines = [];
if (usedHeadGaps.includes(-1)) headLines.push(`<slot name="${headSlot(-1)}" />`);
headCommon.forEach((key, ci) => { headLines.push(toAstro(p0.head[p0.headKeys.indexOf(key)])); if (usedHeadGaps.includes(ci)) headLines.push(`<slot name="${headSlot(ci)}" />`); });
layout += headLines.join('\n') + `\n</head>\n<body class={bodyClass}>\n`;
const bodyLines = [];
const pushGap = (k) => { if (usedBodyGaps.includes(k)) bodyLines.push(bodySlot(k) ? `<slot name="${bodySlot(k)}" />` : '<slot />'); };
pushGap(-1);
layoutBody.forEach(({ ci, out }) => { bodyLines.push(out); pushGap(ci); });
layout += bodyLines.join('\n') + `\n</body>\n</html>\n`;
await w('src/layouts/Base.astro', layout);

for (const p of pages) {
  const file = p.is404 ? 'src/pages/404.astro' : `src/pages/${p.urlPath === '/' ? 'index' : p.urlPath.slice(1, -1) + '/index'}.astro`;
  const depth = file.split('/').length - 3;
  const imp = '../'.repeat(depth + 1) + 'layouts/Base.astro';
  let s = `---\nimport Base from '${imp}';\n---\n<Base path=${JSON.stringify(p.is404 ? '/404/' : p.urlPath)} bodyClass=${JSON.stringify(p.bodyClass)}>\n`;
  for (const [k, idxs] of [...p.headGaps].sort((a, b) => a[0] - b[0])) s += `<Fragment slot="${headSlot(k)}">\n${idxs.map((i) => toAstro(p.head[i])).join('\n')}\n</Fragment>\n`;
  for (const [k, idxs] of [...p.bodyGaps].sort((a, b) => a[0] - b[0])) {
    const inner = idxs.map((i) => toAstro(p.body[i])).join('\n');
    s += bodySlot(k) ? `<Fragment slot="${bodySlot(k)}">\n${inner}\n</Fragment>\n` : inner + '\n';
  }
  s += `</Base>\n`;
  await w(file, s);
  p.head = p.body = null; // free memory
}

// ---------- download assets ----------
const done = new Set();
const queue = [...assets];
let ok = 0;
const fail = [];
while (queue.length) {
  const a = queue.shift();
  if (done.has(a)) continue; done.add(a);
  const dest = path.join(OUT, 'public', a);
  if (fss.existsSync(dest)) continue;
  let r;
  try { await sleep(120); r = get(ORIGIN + encodeURI(a)); } catch (e) { fail.push(a + ' ' + e.message); continue; }
  if (r.status !== 200) { fail.push(`${r.status} ${a}`); continue; }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  let body = r.body;
  if (/\.css$/i.test(a)) {
    const css = relink(body.toString('utf8'));
    for (const m of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)|@import\s+['"]([^'"]+)['"]/g)) {
      const u = (m[1] || m[2]).trim();
      if (/^(data:|#|https?:|\/\/)/.test(u)) continue;
      const abs = new URL(u, 'https://x' + a).pathname;
      try { queue.push(decodeURI(abs)); } catch { queue.push(abs); }
    }
    body = Buffer.from(css);
  } else if (/\.js$/i.test(a)) {
    const js = body.toString('utf8');
    if (hasHost(js)) body = Buffer.from(relink(js));
  }
  await fs.writeFile(dest, body);
  ok++;
}
console.log(`pages: ${pages.length}${EXTERNALIZE ? `, externalized blocks: ${extCount} (${written.size} files)` : ''}`);
console.log(`assets: ${ok} downloaded, ${done.size} referenced, ${fail.length} failed`);
if (fail.length) console.log(fail.join('\n'));
console.log('head common', headCommon.length, 'gaps', usedHeadGaps.map(headSlot).join(','));
console.log('body common', bodyCommon.length, 'gaps', usedBodyGaps.map((k) => bodySlot(k) || 'default').join(','));
console.log('components', components.map((c) => c.name + (c.usesPath ? '(path)' : '')).join(', '));
