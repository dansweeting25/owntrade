// Compare the built pages (dist/) with the cleaned WordPress snapshots (scripts/port-snapshot/).
// node verify.mjs <projectDir>   — exits 1 if any page differs.
import fs from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';

const dir = path.resolve(process.argv[2] || '.');
const snapDir = path.join(dir, 'scripts/port-snapshot');

// Serialize to a canonical form: whitespace collapsed, attributes sorted, class lists normalised.
function canon(html) {
  const $ = cheerio.load(html);
  const out = [];
  const walk = (n, depth) => {
    for (const c of n.children || []) {
      if (c.type === 'text') { const t = c.data.replace(/\s+/g, ' ').trim(); if (t) out.push('  '.repeat(depth) + '#' + t); }
      else if (c.type === 'tag' || c.type === 'script' || c.type === 'style') {
        const attrs = Object.entries(c.attribs || {}).map(([k, v]) => [k, k === 'class' ? v.split(/\s+/).filter(Boolean).join(' ') : v.replace(/\s+/g, ' ').trim()]).sort(([a], [b]) => a.localeCompare(b));
        out.push('  '.repeat(depth) + '<' + c.name + attrs.map(([k, v]) => ` ${k}="${v}"`).join('') + '>');
        walk(c, depth + 1);
      }
    }
  };
  walk($.root()[0], 0);
  return out;
}

let bad = 0;
for (const f of fs.readdirSync(snapDir).filter((f) => f.endsWith('.html')).sort()) {
  const name = f.replace(/\.html$/, '');
  const built = name === '404' ? path.join(dir, 'dist/404.html') : name === 'index' ? path.join(dir, 'dist/index.html') : path.join(dir, 'dist', name.replace(/__/g, '/'), 'index.html');
  if (!fs.existsSync(built)) { console.log('MISSING', built); bad++; continue; }
  const a = canon(fs.readFileSync(path.join(snapDir, f), 'utf8'));
  const b = canon(fs.readFileSync(built, 'utf8'));
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === a.length && i === b.length) { console.log('ok  ', name); continue; }
  bad++;
  console.log('DIFF', name, `(line ${i} of ${a.length}/${b.length})`);
  console.log('   want:', (a[i] || '<end>').slice(0, 300));
  console.log('   got: ', (b[i] || '<end>').slice(0, 300));
}
process.exit(bad ? 1 : 0);
