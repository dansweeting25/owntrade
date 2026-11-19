# owntrade.co.uk

Static [Astro](https://astro.build) site on Cloudflare Workers, ported 1:1 from the WordPress/Breakdance site
that ran on Cloudways (same URLs, markup, CSS and images). Pushing to `main` deploys it
(`.github/workflows/deploy.yml`).

2 pages + 404. Sign-up form. Pages are `noindex`, as they were on WordPress.

## Where things are

- `src/pages/**/index.astro`: one file per URL. Page text lives here.
- `src/layouts/Base.astro`: everything every page shares (head tags, scripts, header, footer). Pages fill its
  named slots (`head-N`, `body-N`) with what differs per page (title, meta description, page CSS, ...).
- `src/components/Header.astro`, `Footer.astro`: shared header/footer. The current-page link highlight is
  computed from the page path.
- `public/wp-content/`: images, CSS and scripts, at the same URLs as on WordPress.
- `src/worker.ts`: the Worker. It only runs for the paths in `run_worker_first` (`wrangler.jsonc`); everything else
  is served as static files.
- `migrations/`: D1 table for form submissions.
- `scripts/port/`: the tools used for the port (`fetchpages.mjs` crawl, `wp2astro.mjs` convert, `verify.mjs`
  built HTML vs WordPress HTML, `shoot.mjs` screenshots). `scripts/port-snapshot/` is the cleaned WordPress HTML
  the port was checked against.

## Run locally

```bash
npm install
npm run dev        # Astro dev server
npm run preview    # build + wrangler dev (Worker, forms, local D1)
```

## Forms

Forms post to `/api/forms`, which stores the submission in D1 (table `submissions`) and emails it to `FORM_TO`
when email is set up (Cloudflare Email Sending for the domain + a `send_email` binding named `EMAIL`;
`FORM_TO` is a variable set in the Cloudflare dashboard, not in git). To read submissions:

```bash
npx wrangler d1 execute owntrade --remote --command "select * from submissions order by id desc limit 20"
```

## Going live

1. Check the `owntrade.<subdomain>.workers.dev` preview.
2. Cloudflare dashboard → Workers & Pages → `owntrade` → Settings → Domains & Routes → add `owntrade.co.uk` and
   `www.owntrade.co.uk`. This replaces the DNS records that pointed at Cloudways.
3. Purge the zone's cache; check a few pages, the form, `/sitemap_index.xml`, `/robots.txt`.
4. Rollback: remove the custom domains and restore the A record `207.148.27.53` (proxied).
