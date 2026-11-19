// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://owntrade.co.uk',
  // WordPress URLs end in a slash; pages build as /path/index.html.
  trailingSlash: 'ignore',
  build: { format: 'directory' },
  // Collapses whitespace like HTML does (Astro 7's default 'jsx' whitespace handling eats spaces the Breakdance markup needs).
  compressHTML: true,
  output: 'static',
  devToolbar: { enabled: false },
});
