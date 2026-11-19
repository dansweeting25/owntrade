// curl-based GET (Cloudways' bot protection challenges Node's fetch). Returns {status, loc, ct, body(Buffer)}.
// Keeps a cookie jar and retries with a pause when the "One moment, please" challenge page comes back.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-'));
const jar = path.join(tmp, 'jar');
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function get(url, tries = 6) {
  const bodyFile = path.join(tmp, 'b');
  for (let i = 0; i < tries; i++) {
    const meta = execFileSync('curl', ['-sS', '-m', '60', '-A', UA, '-b', jar, '-c', jar, '-H', 'Accept: text/html,application/xhtml+xml,*/*', '-H', 'Accept-Language: en-GB,en;q=0.9', '-o', bodyFile, '-w', '%{http_code}\t%{redirect_url}\t%{content_type}', url], { encoding: 'utf8' });
    const [status, loc, ct] = meta.split('\t');
    const body = fs.readFileSync(bodyFile);
    if (body.toString('utf8', 0, 2000).includes('One moment, please')) { wait(8000 * (i + 1)); continue; }
    return { status: Number(status), loc, ct, body };
  }
  throw new Error('bot challenge on ' + url);
}
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
