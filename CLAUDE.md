# owntrade.co.uk

Read README.md first. Rules:

1. URLs never change (trailing slashes, same paths as WordPress). Redirects go in `public/_redirects`.
2. Keep the design: markup and class names were ported 1:1 from Breakdance. Edit text and content, don't restyle
   unless asked.
3. Inline `<script>`/`<style>` in `.astro` files carry `is:inline`, and `{` `}` in text are written `&#123;` `&#125;`
   (Astro would read them as expressions). Keep it that way when editing.
4. Shared things belong in `src/layouts/Base.astro` or `src/components/`, not copied into every page.
5. Run `npm run build` after changes. `npm run verify` compares against the original WordPress HTML: expect
   differences on pages you changed on purpose, none elsewhere.
6. Form recipient addresses are Cloudflare variables, never committed.
