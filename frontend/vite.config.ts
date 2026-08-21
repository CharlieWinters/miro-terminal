import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  // Deployed to https://charliewinters.github.io/miro-terminal/ — a project
  // subpath, not the domain root — so build output needs asset URLs prefixed
  // with the repo name, or every <script src="/assets/..."> 404s against the
  // domain root instead of the actual deploy path. Only for `build`, not
  // `dev` — the local dev server should keep serving from root.
  base: command === 'build' ? '/miro-terminal/' : '/',
  build: {
    rollupOptions: {
      input: {
        index: 'index.html',
        app: 'app.html',
      },
    },
  },
}));
