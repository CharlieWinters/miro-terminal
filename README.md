# Miro Terminal

A persistent terminal, embedded on a Miro board. Extracted from `miro-ide` into
its own repo so the frontend/backend split matches `fal-miro`: the frontend is
hosted once (by whoever owns this repo's deployment); everyone else who wants
to *run* a terminal deploys their own backend. See `ARCHITECTURE.md` for the
full design and the linked Miro board for the decision history.

## Layout

```
miro-terminal/
  frontend/            Miro Web SDK app (Vite + TS)
    src/
      main.ts          headless entry — icon:click → openPanel
      panel.ts         panel UI — session name/cwd, "Create terminal"
      terminalEmbed.ts  embed creation + connected-doc/viewport context relay
      backendConfig.ts  per-person backend URL, stored in this browser's localStorage
    terminal-wrapper/  static health-probe + fallback page (deploy separately, see below)
  backend/             PTY server — YOU deploy this, on a machine YOU control
    server.js          Express + node-pty + ws
    public/
      terminal.html     the actual terminal UI + [INPUT]/[LABEL]/<viewport>/etc. variable expansion
      styles.css
  app-manifest.yaml    paste into Miro's app settings once frontend/ is hosted
```

## Run the backend (everyone who wants their own terminal does this)

```bash
cd backend
npm install
```

Create a `.env` file (never commit it) with whatever you need to change from
these defaults:

| Var | Default | Notes |
| --- | --- | --- |
| `PORT` | `3001` | |
| `SSL_KEY_PATH` / `SSL_CERT_PATH` | unset (plain HTTP) | Set both for HTTPS — needed if the board is https and must reach you over wss. Use [mkcert](https://github.com/FiloSottile/mkcert) for local certs. |
| `SIGN_SECRET` | dev-only fallback | **Required** once `NODE_ENV=production`. |
| `SESSION_TIMEOUT` | `3600000` (1h) | Idle PTY session cleanup. |
| `TOKEN_TTL` | `900000` (15m) | PTY start-token lifetime. |
| `SCROLLBACK_BYTES` | `204800` (200 KB) | Per-session output buffer, replayed to any newly-connecting client so reopening the embed shows recent history instead of a blank cursor. |
| `ALLOWED_ROOT` | your home dir | `cwd` requests are confined under this (path-traversal-checked). |
| `TRUST_PROXY` | unset | Set to `1` if TLS terminates at a reverse proxy in front of this. |
| `CORS_ALLOWED_ORIGINS` | unset | Extra allowed origins, comma-separated (localhost/127.0.0.1/miro.com/github.io are already allowed). |

```bash
npm start        # or: npm run dev (auto-restart)
```

Then open the Miro Terminal panel's **Backend** section, enter your
`https://localhost:3001` (or wherever you're running it), and hit **Save** —
this is stored per-browser (`localStorage`), not on the board, since every
collaborator runs their own. **Clear** resets it if you need to point at a
different backend later.

## Run the frontend

```bash
cd frontend
npm install
npm run dev
```

Point the app's `sdkUri` (see `app-manifest.yaml`) at your dev server, or build
and host it:

```bash
npm run build
```

## Deploy your own backend, permanently

The `backend/` server is a plain Node process — deploy it anywhere that gives
you a long-running process (your own machine, a VM, a container host). It is
**not** deployable to Cloudflare Workers: `node-pty` spawns real OS processes,
which Workers' V8 isolates can't do. (Contrast with `fal-miro`, whose Hono
backend deploys to either Node or Workers unchanged — that trick doesn't
transfer here.)

## Turn on the shared wrapper (State A/B)

`frontend/terminal-wrapper/` is a static page: it health-checks
`localhost`/`127.0.0.1`/`[::1]` from the *viewer's own browser*, and either
iframes their local terminal (if they're the host) or shows "a collaborator
started this session on their computer" (if they're not). Deploy it once,
publicly, and every board gets the same experience:

```bash
cd frontend
npm run pages:publish
```

This pushes `frontend/terminal-wrapper/` to the `gh-pages` branch (via the
[`gh-pages`](https://github.com/tschaub/gh-pages) package) at path
`terminal-wrapper/`. Enable it under the repo's **Settings → Pages** (deploy
from the `gh-pages` branch), then set `WRAPPER_URL` in
`frontend/src/backendConfig.ts` to the resulting
`https://YOUR_USER.github.io/YOUR_REPO/terminal-wrapper/` URL and rebuild.

## Troubleshooting

**`Error: posix_spawnp failed` when creating a terminal.** `node-pty`'s
prebuilt `spawn-helper` binary (under
`backend/node_modules/node-pty/prebuilds/<platform>-<arch>/`) has shipped
without its executable bit set before — npm's pack/unpack can drop it, and
`pty.spawn()` then fails at the OS level instead of giving a clear permission
error. `backend`'s `postinstall` script (`scripts/fix-node-pty-permissions.js`)
`chmod +x`'s it automatically after every `npm install`, so this should be
self-healing. If you still hit it (e.g. you ran `npm install --ignore-scripts`,
or restored `node_modules` from a cache/tarball that skipped scripts), fix it
by hand:

```bash
cd backend
node scripts/fix-node-pty-permissions.js
# or directly:
chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper
```

No server restart needed — the helper is exec'd fresh on every PTY spawn, not
cached at startup.

**`ERR_SSL_PROTOCOL_ERROR` fetching the backend.** You're using `https://` in
the Backend settings but the server is running plain HTTP (no `SSL_KEY_PATH`/
`SSL_CERT_PATH` set — see the env var table above). Either set those two vars
and restart, or use `http://` for local-only testing (note the embed widget
itself will still need `https://` once it's actually sitting inside the
`https://` Miro board — mixed content gets blocked there).

## Status

See the kanban on the Miro plan board for current phase status. Short version:
State A/B is built and ready to turn on; the connected-doc/variable-expansion
context relay is built; State C (opt-in Cloudflare relay streaming, with
optional history) is designed but not built.
