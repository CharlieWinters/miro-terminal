import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs, so the same build works wherever it is served from.
  // The default of '/' emits `/assets/index-abc.js`, which resolves against the
  // DOMAIN ROOT — fine when Vite serves at localhost:5173/, and a 404 the
  // moment the app is published under a path like
  // <your-pages-host>/<repo>/app/. Relative paths work in both,
  // which matters because the same build has to serve local development and
  // GitHub Pages.
  base: './',
  build: {
    rollupOptions: {
      input: {
        index: 'index.html',
        app: 'app.html',
      },
    },
  },
});
