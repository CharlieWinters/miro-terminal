# Miro Terminal

A real terminal, live on a Miro board. Several at once if you like — each its
own shell, sized to its own widget.

Everyone on the board sees each terminal's recent command history, read from
the board itself. Only the person whose machine is running it can type into it.
That asymmetry is not a policy the app enforces; it is a consequence of how
browsers work, which is the most reliable kind.

![no screenshot yet](#)

## The one thing to understand first

A page served from the internet **may not** talk to `localhost`. Chrome's Local
Network Access blocks it — `fetch`, WebSocket, even navigating an iframe — and
a page nested inside another site's iframe can never be granted permission.

Since a board embed is loaded by every viewer, it has to be served publicly,
which means it can never reach your terminal server. And anything served from
your machine, conversely, gets no working Miro SDK: the SDK loads but never
completes its handshake from an origin the app is not registered at.

So every surface here sits on exactly one side of that line, and they talk to
each other with `postMessage` — which is not a network request, so none of the
above applies to it.

| Surface | Served from | Can do | Cannot do |
| --- | --- | --- | --- |
| Headless iframe + settings panel | public host | board reads and writes | reach your machine |
| `terminal-wrapper/` (the embed) | public host | show history, host a live terminal | reach your machine |
| `spawner.html` | your machine | start sessions, browse folders | touch the board |
| `terminal.html` (modal or live embed) | either | be a terminal | — |
| `relay.html` | your machine | hold the PTY sockets | touch the board |

Once that shape is clear, the rest of the repo reads straightforwardly. If you
change it, `ARCHITECTURE.md` explains why each piece is where it is.

## Requirements

- Node 18+
- A Miro **developer team** (any plan) — you install unpublished apps there
- **HTTPS on the terminal server**, with a certificate your browser trusts.
  [mkcert](https://github.com/FiloSottile/mkcert) is the easy route:
  ```bash
  mkcert -install
  mkcert localhost 127.0.0.1 ::1
  ```
  This is not optional and the failure is silent: a certificate warning cannot
  render inside a board modal, so an untrusted cert looks exactly like a server
  that is not running.
- Somewhere to publish static files. GitHub Pages works and is what the scripts
  assume. (Pages cannot host a Miro app for the Marketplace, but it is fine for
  a private or self-hosted one.)

## Setup

### 1. Run the terminal server

```bash
cd backend
npm install
npm start
```

Configuration is optional to start with — see [Configuration](#configuration)
for `backend/.env`. You will come back to it in step 3 to set `EMBED_ORIGINS`,
which live terminals need.

Confirm it: `curl -k https://localhost:3001/health` should return
`{"status":"ok",...}`. Note `http://localhost:3001` will refuse outright once
TLS is on — always `https` for that port.

### 2. Publish the frontend

```bash
cd frontend
npm install
npm run pages:publish
```

That builds the app, assembles everything Pages should serve into one
directory, and pushes it to the `gh-pages` branch in a single commit. Your app
then lives at `https://YOUR-USER.github.io/miro-terminal/app/index.html`.

> Check the bundle hash actually changed before believing a publish. `gh-pages`
> will happily report success having shipped nothing.

### 3. Set up the two Miro apps

**There are two, and live terminals need both.** This is the step people miss.

| | App URL | Scopes | Who installs it | Its icon opens |
| --- | --- | --- | --- | --- |
| **Miro Terminal** | `https://YOUR-USER.github.io/miro-terminal/app/index.html` | `boards:read`, `boards:write`, `identity:read` | anyone who wants to see history | the panel: what this is, setup, your server address |
| **Miro Terminal relay** | `https://localhost:3001/relay.html` | none | only you | the spawner: create a terminal |

The division is deliberate. The first app is the front door — it explains itself
to somebody who just wants to read a terminal's history, which is most people.
The second is the developer's tool, served from your own machine, and its icon
does the developer's job.

In order:

1. Paste `app-manifest.yaml` and `app-manifest-relay.yaml` into the two apps
   respectively, replacing `YOUR-USER`. Install both on your developer team.

2. Tell the relay where you published the embed. In `backend/.env`:

   ```
   EMBED_ORIGINS=https://YOUR-USER.github.io
   ```

   **Then restart the terminal server** — `.env` is read at startup, so an
   unrestarted server still knows nothing about it. Check it took:

   ```bash
   curl -k https://localhost:3001/api/relay-config
   ```

   That should list your origin. `{"embedOrigins":[]}` means live terminals will
   be refused.

   This cannot go on the relay app's App URL, which is where you would expect
   it: Miro normalises `sdkUri` and drops query parameters from it, so the
   setting never arrives. The relay page states which origins it accepts, and a
   refused embed shows the reason rather than timing out.

3. **Click the relay app's icon once.** A second app's headless iframe is only
   reliably loaded on a cold board load after the user has opened it at least
   once, so without that click live terminals work only sporadically. The icon
   opens the terminal spawner.

### 4. Point the app at your server

Open a board, click the **Miro Terminal** icon, and save
`https://localhost:3001` in the panel. It is stored in `localStorage` on the
app's origin, so it is per-browser — which is deliberate, since every
collaborator runs their own server — and it does not survive the app changing
origin.

## Using it

**Create a terminal.** Click the *relay* app's icon — or the New terminal button
in the Miro Terminal panel. Either opens the spawner, served from your own
machine, which is what lets it browse your folders and start a session. Name it,
pick a working directory, hit create.

**Type into it.** Either flip **Live** at the top of the embed and type on the
board, or open it in a full-screen modal. Live mode is per-browser and off by
default — see [Security](#security) for why.

**Pull board content into commands.** Connect a card, sticky or text item to the
terminal embed with a connector, then use it as a variable:

| You type | You get |
| --- | --- |
| `[INPUT]` | every uncaptioned connector's item, newline-joined |
| `[LABEL]` | the item whose connector caption is `LABEL` |
| `[LINK_1]` | that item's board link rather than its content |
| `viewport`, `board_id`, `board_name` | board context |

The label lives on the **connector's caption** — double-click the line to add
one — never on the item, so an item's own text is never parsed or rewritten.
Substitution recurses up to five passes, so a sticky whose text mentions
another token resolves too.

**When an embed resets.** Miro and Chrome reload offscreen app iframes, so
scrolling away from a live terminal and back will reconnect it. The shell itself
lives on the server and its scrollback is replayed, so it comes back where you
left it. If the session had idled out server-side (`SESSION_TIMEOUT`, an hour by
default) you get a fresh shell under the same name, and the status bar says so —
a clean prompt where there used to be work otherwise reads as lost work.

**What others see.** Anyone with the Miro Terminal app installed sees the last
~50 lines the terminal wrote, plus who ran it and when, read from the embed's
board metadata. It survives your machine being off. Anyone without the app is
told what to install.

## Security

This app runs a shell. Read this bit.

- **Do not expose the terminal server beyond `localhost`.** It has no
  authentication of its own worth the name; its safety comes from being
  unreachable. Binding it to a public interface hands anyone a shell.
- **Keystrokes only ever travel between surfaces on your own machine**, unless
  you turn on Live mode. Live mode routes them through the public embed page, so
  it is off by default and per-browser, and the switch stays visible while it is
  on. The relay authorises input with a nonce it issues over `postMessage`, never
  through a URL, so nothing secret is ever written into board content.
- **The relay only accepts session requests from origins you list** in its App
  URL. The default is localhost only.
- **Terminal history goes onto the board.** Anything on screen goes with it:
  tokens a CLI echoes, `env` output, `git remote` URLs with credentials. It is
  in app metadata, so only people with the app installed can read it — but that
  is everyone you have shared the board with who bothers to install it.
- Installing the app grants nobody any access to your machine. A public origin
  cannot reach `localhost`, which is the constraint this whole design is built
  around, doing useful duty as a boundary.

## Configuration

`backend/.env` — there is deliberately no `.env.example`, so that nothing here
is ever copy-pasted with real values in it.

| Var | Default | Notes |
| --- | --- | --- |
| `PORT` | `3001` | |
| `SSL_KEY_PATH` / `SSL_CERT_PATH` | unset | Set both. See Requirements. |
| `SIGN_SECRET` | dev-only fallback | **Required** once `NODE_ENV=production`. |
| `SESSION_TIMEOUT` | `3600000` | Idle PTY cleanup, ms. |
| `TOKEN_TTL` | `900000` | PTY token lifetime, ms. |
| `SCROLLBACK_BYTES` | `204800` | Replayed to any client that connects, so a reopened embed shows recent history rather than a blank cursor. |
| `ALLOWED_ROOT` | your home dir | `cwd` requests are confined here, path-traversal checked. |
| `TRUST_PROXY` | unset | `1` if TLS terminates at a proxy in front. |
| `CORS_ALLOWED_ORIGINS` | unset | Extra allowed origins, comma-separated. |
| `EMBED_ORIGINS` | unset | Where you published the embed, e.g. `https://you.github.io`. Required for live terminals; no default, because opening a session is what authorises keystrokes. |

Frontend: `VITE_WRAPPER_URL` if you host the app and the wrapper somewhere
unrelated to each other. Otherwise the wrapper URL is derived from wherever the
app is served, so a fork needs no edits.

## Layout

```
miro-terminal/
  frontend/
    index.html            headless entry — answers embeds, opens surfaces
    app.html              settings panel (the backend URL, and only that)
    src/hostBridge.ts     the embed-to-app channel: state, history, board reads
    src/terminalEmbed.ts  embed creation and the connector-variable reader
    terminal-wrapper/     THE PUBLIC PAGE — what every viewer loads in an embed
    scripts/stage-pages.mjs  assembles everything Pages serves, in one commit
  backend/
    server.js             Express + node-pty + ws
    public/terminal.html  the terminal UI, served here AND published publicly
    public/spawner.html   starts sessions, browses folders
    public/relay.html     the second app: holds sockets for live embeds
  app-manifest.yaml       app one
  app-manifest-relay.yaml app two
  ARCHITECTURE.md         why each piece is where it is
```

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Embed says it runs on another machine, but it's yours | Dev server not running, or the app's origin changed and the saved backend URL was lost with it |
| Live mode says the relay refuses this origin | `EMBED_ORIGINS` is unset or wrong in `backend/.env` — restart the server after changing it. The relay page lists what it accepts |
| Live mode never connects at all | Relay app not installed, or installed but never opened once |
| Terminal opens but shows nothing | Certificate not trusted. A cert warning cannot render in a modal, so it fails silently |
| `[INPUT]` and friends stop expanding | The embed URL lost its `embedId`, which is the key board context is looked up under |
| A publish seems to have no effect | Check the bundle hash actually changed |

## Licence

MIT — see [LICENSE](LICENSE).
