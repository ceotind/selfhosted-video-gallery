import { defineConfig } from 'astro/config';

// Static output. No adapter, no server runtime, no client framework.
export default defineConfig({
  output: 'static',
  site: process.env.SITE_URL || 'http://localhost:8080',
  build: { inlineStylesheets: 'auto' },
  compressHTML: true,
});
