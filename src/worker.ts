// Worker for the static site. Only /api/* and /wp-admin/* reach it (see run_worker_first in wrangler.jsonc);
// everything else is served directly from the built assets.
//
// POST /api/forms receives Breakdance form submissions (the same FormData the WordPress admin-ajax handler got),
// stores them in D1 and, when email is configured, emails them to FORM_TO.

interface Env {
  ASSETS: Fetcher;
  DB?: D1Database;
  EMAIL?: { send(msg: Record<string, unknown>): Promise<{ messageId: string }> };
  SITE_NAME: string;
  FORM_FROM?: string;
  FORM_TO?: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

async function handleForm(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== 'POST') return json({ success: false, data: { message: 'Method not allowed' } }, 405);
  let form: FormData;
  try { form = await request.formData(); } catch { return json({ success: false, data: { message: 'Bad request' } }, 400); }

  const action = String(form.get('action') || '');
  // Breakdance sends other admin-ajax actions occasionally; answer them harmlessly.
  if (!action.startsWith('breakdance_form_')) return json({ success: true, data: {} });

  const fields: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    if (typeof v !== 'string') continue;
    const m = k.match(/^fields\[(.+)\]$/);
    if (m) fields[m[1]] = fields[m[1]] ? `${fields[m[1]]}, ${v}` : v;
  }
  // Honeypot / empty submissions
  if (!Object.values(fields).some((v) => v.trim())) return json({ success: false, data: { message: 'Please fill in the form.' } }, 400);

  const formName = String(form.get('form_id') || action);
  const page = request.headers.get('referer') || '';
  const ip = request.headers.get('cf-connecting-ip') || '';
  const ua = request.headers.get('user-agent') || '';

  let id: number | undefined;
  if (env.DB) {
    const r = await env.DB.prepare('INSERT INTO submissions (form, page, fields, ip, user_agent) VALUES (?, ?, ?, ?, ?) RETURNING id')
      .bind(formName, page, JSON.stringify(fields), ip, ua).first<{ id: number }>();
    id = r?.id;
  }

  if (env.EMAIL && env.FORM_TO && env.FORM_FROM) {
    const rows = Object.entries(fields);
    const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n') + `\n\nPage: ${page}`;
    const html = `<table cellpadding="6">${rows.map(([k, v]) => `<tr><th align="left">${escapeHtml(k)}</th><td>${escapeHtml(v).replace(/\n/g, '<br>')}</td></tr>`).join('')}</table><p>Page: ${escapeHtml(page)}</p>`;
    const replyTo = Object.entries(fields).find(([k, v]) => /mail/i.test(k) && /@/.test(v))?.[1];
    ctx.waitUntil(
      env.EMAIL.send({
        from: { email: env.FORM_FROM, name: env.SITE_NAME },
        to: env.FORM_TO,
        ...(replyTo ? { replyTo } : {}),
        subject: `New enquiry from ${env.SITE_NAME}`,
        text,
        html,
      }).then(async () => { if (env.DB && id) await env.DB.prepare('UPDATE submissions SET emailed = 1 WHERE id = ?').bind(id).run(); })
        .catch((e) => console.error('email failed', e)),
    );
  }
  return json({ success: true, data: {} });
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/forms' || url.pathname === '/wp-admin/admin-ajax.php') return handleForm(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
