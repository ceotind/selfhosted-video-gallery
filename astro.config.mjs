import { defineConfig } from 'astro/config';

// Static output. No adapter, no server runtime, no client framework.
export default defineConfig({
  output: 'static',
  site: process.env.SITE_URL || 'http://localhost:8080',
  build: { inlineStylesheets: 'auto' },
  compressHTML: true,
  // Development only. Production serves these paths from nginx.
  vite: {
    server: {
      proxy: {
        '/api/': 'http://127.0.0.1:9000',
        '/login': 'http://127.0.0.1:9000',
        '/account': 'http://127.0.0.1:9000',
        '/admin': 'http://127.0.0.1:9000',
        '/v/': 'http://127.0.0.1:4322',
        '/p/': 'http://127.0.0.1:4322',
        // The folder list is built per person, so the login service serves it.
        '/m/': 'http://127.0.0.1:9000',
      },
    },
  },
});
