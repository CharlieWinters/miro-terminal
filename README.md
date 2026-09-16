# Miro Terminal

A persistent terminal, embedded on a Miro board.

**The app is hosted publicly (GitHub Pages) and anyone on a board can install
it.** Doing so is what lets a collaborator read a terminal's recent command
history — that history lives in the embed's board metadata, and metadata is
scoped per item *per app*, so only an iframe of this app can see it. Installing
the app does not let anyone run anything: it has no way to reach your machine.

The surfaces that *do* need your terminal server are served **by** that server,
from your own machine:

| Surface | Served from | Does |
| --- | --- | --- |
| headless + settings panel | GitHub Pages | reads and writes the board, opens the others |
| `spawner.html` | your machine | starts sessions, browses your folders |
| `terminal.html` | your machine | the terminal itself, opened as a modal |
| `terminal-wrapper/` | GitHub Pages | what every board viewer sees in the embed |

They are opened with absolute `http(s)://localhost` URLs — both `openModal` and
`openPanel` accept them — and they hand board work back to the app over
`postMessage`. They have to: a Miro surface on a foreign origin loads the Web
SDK but never completes its connection handshake, so board calls from there
throw. Conversely nothing on the app's public origin can reach `localhost`;
Chrome's Local Network Access blocks it, including iframe navigation. Board
work on the app origin, terminal work on your machine, `postMessage` between —
that split is the whole architecture, and it is not optional.

## Prerequisites

- **The terminal server must be HTTPS, with a trusted certificate.** Use
  [mkcert](https://github.com/FiloSottile/mkcert) and install its CA. A cert
  warning cannot show an interstitial inside a board modal — it just fails
  silently, with nothing in the console to explain it.
- Plain `http://localhost:3001` will refuse the connection outright once
  `SSL_KEY_PATH`/`SSL_CERT_PATH` are set. Always `https` for that port.
- Your backend URL is stored in `localStorage` on the **app's** origin. It does
  not follow you across browsers, profiles, or an app that changes origin.

## Layout

```
miro-terminal/
  frontend/            Miro Web SDK app (Vite + TS)
    src/
      main.ts          headless entry — icon:click → openPanel
      panel.ts         panel UI — session name/cwd, "Create terminal"
      terminalEmbed.ts  embed creation + connected-doc/viewport context relay
      backendConfig.ts  per-person backend URL, stored in this browser's localStorage
    terminal-wrapper/  the only publicly-hosted piece — State A/B fallback page (see below)
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

`app-manifest.yaml`'s `sdkUri`/`redirectUris` already point at
`http://localhost:5173/` — Vite's default. This has to stay a `localhost`
URL, not a hosted one; see the note at the top of this file and
`ARCHITECTURE.md` for why.

## Deploy your own backend, permanently

The `backend/` server is a plain Node process — deploy it anywhere that gives
you a long-running process (your own machine, a VM, a container host). It is
**not** deployable to Cloudflare Workers: `node-pty` spawns real OS processes,
which Workers' V8 isolates can't do. (Contrast with `fal-miro`, whose Hono
backend deploys to either Node or Workers unchanged — that trick doesn't
transfer here.)

## The shared wrapper (State A/B) — deployed

`frontend/terminal-wrapper/` is the **only** publicly-hosted piece of this
app — a static page that decides, per-viewer, what to show for the embed
widget every board visitor loads the same URL for:

- **You're the host**: it navigates a nested iframe to your real
  `terminal.html` and shows it once that page confirms it actually loaded
  (a `postMessage` ping — see below).
- **You're not**: nothing confirms within a few seconds, so it shows "a
  collaborator started this session on their computer" instead of a broken
  iframe.

It's live at **https://charliewinters.github.io/miro-terminal/terminal-wrapper/**.
`WRAPPER_URL` in `frontend/src/backendConfig.ts` already points at it.

**Why it navigates instead of fetching a health-check endpoint** (which is
what it used to do): a `fetch()` from this public page straight to your
`localhost` backend is exactly the pattern Chrome's Private Network Access
policy blocks — and did, live, when this app was briefly hosted publicly too
(see `ARCHITECTURE.md`). Navigating a nested `<iframe>` isn't gated the same
way, so detection instead relies on `terminal.html` itself `postMessage`-ing
`{ type: 'miro-terminal:ready' }` to its parent as soon as it loads (before
the PTY/WS connection even completes — this only needs to prove "a real
backend served this page," not that everything downstream works). No message
within `READY_TIMEOUT_MS` (4s) and the wrapper falls back to the "someone
else's machine" message — which also naturally covers connection-refused,
untrusted-cert interstitials, and anything else that isn't our own page,
since none of those run this script at all.

To redeploy after any change to `terminal-wrapper/index.html`:

```bash
cd frontend
npm run pages:publish
```

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
State A/B is built and **deployed**, using navigate+`postMessage` detection
rather than a health-check fetch (see above — the fetch version hit a real
Chrome Private Network Access block once tested against the public
deployment); the connected-doc/variable-expansion context relay is built;
State C (opt-in Cloudflare relay streaming, with optional history) is
designed but not built.
