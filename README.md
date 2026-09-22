# Miro Terminal

A real terminal, live on a Miro board. Several at once if you like — each its
own shell, sized to its own widget.

Everyone on the board sees each terminal's recent command history, read from
the board itself. Only the person whose machine is running it can type into it.
That asymmetry is not a policy the app enforces; it is a consequence of how
browsers work, which is the most reliable kind.

![Creating a terminal on a board, allowing it to go live, and running an agent
in it](docs/tutorial.gif)

*Opening the panel, creating a terminal, allowing it from the relay's
permissions panel, and then running an agent inside the embed — 55 seconds,
unedited.*

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
  cd backend
  mkcert -install
  mkcert localhost 127.0.0.1 ::1
  ```
  That writes `localhost+2.pem` and `localhost+2-key.pem` into whatever
  directory you ran it in. **Generating them is not the last step** — the server
  only uses them if you point `SSL_KEY_PATH` and `SSL_CERT_PATH` at them, which
  step 1 does.

  This is not optional and the failure is silent: a certificate warning cannot
  render inside a board modal, so an untrusted cert looks exactly like a server
  that is not running.
- Somewhere to publish static files. GitHub Pages works and is what the scripts
  assume. (Pages cannot host a Miro app for the Marketplace, but it is fine for
  a private or self-hosted one.)

## Install the published apps, or host your own

There are two apps and you can either install the ones published from this
repo or create your own. Installing skips steps 2 and 3 below entirely.

| | Install | Who needs it |
| --- | --- | --- |
| **Miro Terminal** | [install](https://miro.com/app-install/?response_type=code&client_id=3458764683927525948&redirect_uri=%2Fapp-install%2Fconfirm%2F) | anyone who wants to read a terminal's history |
| **Miro Terminal relay** | [install](https://miro.com/app-install/?response_type=code&client_id=3458764684032768431&redirect_uri=%2Fapp-install%2Fconfirm%2F) | only someone running a terminal of their own |

**If you only want to read the terminals on a board someone else is running**,
install the first one and stop — no server, no certificates, no second app, and
nothing below this line. History is read from the board itself.

Three things to know before installing rather than forking.

The first app is served from `charliewinters.github.io`, so you are trusting
that hosting with the board scopes it asks for.

The relay's App URL points at `localhost:3001`, which resolves to **your**
machine, not to anyone else's. That is the whole design — the relay has to be
local to reach your shell — but it means step 1 is not optional either way, and
the port and the TLS have to match.

And the embed those apps load is published at `charliewinters.github.io`, so
your relay has to accept that origin. If live mode says the relay refuses it,
put this in your own `backend/.env` and restart:

```
EMBED_ORIGINS=https://charliewinters.github.io
```

That is the one place installing rather than forking needs a line of
configuration that forking would not.

**Host your own** instead if you would rather nothing depended on someone
else's hosting: fork, publish to your own Pages, and create your own two apps.
That is what steps 2 and 3 are for.

## Setup

### 1. Run the terminal server

```bash
cd backend
npm install
```

Now write `backend/.env`. TLS is the one thing you cannot defer — the app is
loaded from an `https://` board page, and a browser will not let it talk to a
plain-`http://` server:

```
SSL_KEY_PATH=localhost+2-key.pem
SSL_CERT_PATH=localhost+2.pem
```

Both are resolved relative to `backend/`, so those are the filenames `mkcert`
gave you in Requirements. Then:

```bash
npm start
```

It should say `Terminal server running on https://localhost:3001`. If it says
`http://` instead, the two variables above are missing or misspelled, and it
will warn you so on the same line — keep going only once it says `https`.

Confirm it: `curl -k https://localhost:3001/health` returns
`{"status":"ok",...}`. Everything else here assumes `https` on this port.

The rest of the configuration can wait — see [Configuration](#configuration).
You will come back to it in step 3 to set `EMBED_ORIGINS`, which live terminals
need.

### 2. Publish the frontend

> Skip this if you installed the published apps above.

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

> Skip this too if you installed the published apps — though read point 3, the
> click-the-icon-once one, because it applies however you got the relay.

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

2. Tell the relay where you published the embed. It is already in the relay
   manifest's App URL, so this is just the `YOUR-USER` you replaced in step 1:

   ```
   https://localhost:3001/relay.html?embedOrigins=https://YOUR-USER.github.io
   ```

   No file to edit and no restart. The relay page lists what it accepts, and a
   refused embed says so rather than timing out.

   Setting `EMBED_ORIGINS` in `backend/.env` also still works, and is read on
   top of the App URL — but it is read at startup, so **restart the terminal
   server** if you change it. `curl -k https://localhost:3001/api/relay-config`
   shows what the server knows; an empty list there is fine if the App URL
   carries the value.

   It used to live only in `.env`, on the belief that Miro strips query
   parameters from `sdkUri`. That was measured wrong — the parameter arrives
   intact — and the terminal server never needed the value for itself, so the
   App URL is now the documented home.

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
| `[VIEWPORT]`, `[BOARD_NAME]`, `[BOARD_URL]` | board context, read live from the board |

Every token is `[BRACKETED]`, connected items and board context alike. The
angle-bracket spellings some of these used to have still resolve, but are not
documented and will go. The terminal's **i** button lists what the terminal in
front of you can actually expand, including the labels on its own connectors,
which is the part no fixed list can tell you.

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
- **The relay only accepts session requests from origins you list** in
  `EMBED_ORIGINS` in `backend/.env` (not in its App URL — see step 3). There is
  no default: until you set it, live terminals are refused outright. Treat this
  as configuration, not as a security boundary — it is an origin string check,
  and any frame already running on the board page can work around it.
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
| `SIGN_SECRET` | dev-only fallback | Signs PTY tokens. The fallback is a **constant published in this repo**, so treat it as public knowledge and set your own: `openssl rand -hex 32`. Only enforced when `NODE_ENV=production`, which a local `npm start` is not. |
| `SESSION_TIMEOUT` | `3600000` | Idle PTY cleanup, ms. |
| `TOKEN_TTL` | `900000` | PTY token lifetime, ms. |
| `SCROLLBACK_BYTES` | `204800` | Replayed to any client that connects, so a reopened embed shows recent history rather than a blank cursor. |
| `ALLOWED_ROOT` | your home dir | Which directories `/api/browse` will list, and which a new session may *start* in. Not a sandbox: it is a real login shell, so `cd /` works from the first prompt. |
| `HOST` | `127.0.0.1` | Interface to bind. Leave it alone. Anything reachable that is not loopback gets a shell — see [Security](#security). |
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
  icons/                  both app icons, published to Pages (see below)
  app-manifest.yaml       app one
  app-manifest-relay.yaml app two
  ARCHITECTURE.md         why each piece is where it is
  REVIEWING.md            how to security-review this, and what to distrust
```

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Embed says it runs on another machine, but it's yours | Dev server not running, or the app's origin changed and the saved backend URL was lost with it |
| Live mode refuses the origin, and you installed the published apps | The embed is published at `charliewinters.github.io`; set `EMBED_ORIGINS=https://charliewinters.github.io` in your `backend/.env` and restart |
| Live mode says the relay refuses this origin | The origin is missing from the relay app's App URL (`?embedOrigins=…`), or from `EMBED_ORIGINS` in `backend/.env` if you use that instead — restart the server after changing `.env`. The relay page lists what it accepts |
| Live mode asks permission every time | Expected once per session per browser session. Approving is remembered until you close the tab or hit Revoke on the relay page |
| Live mode says no such session on this machine | The relay can no longer create sessions, only attach to ones you started. Create it from the spawner first |
| Live mode never connects at all | Relay app not installed, or installed but never opened once |
| Terminal opens but shows nothing | Certificate not trusted. A cert warning cannot render in a modal, so it fails silently |
| `curl https://localhost:3001/health` won't connect, and startup said `http://` | `SSL_KEY_PATH`/`SSL_CERT_PATH` unset in `backend/.env`, so the server came up without TLS. See step 1 |
| `[INPUT]` and friends stop expanding | The embed URL lost its `embedId`, which is the key board context is looked up under |
| A publish seems to have no effect | Check the bundle hash actually changed |

## Licence

MIT — see [LICENSE](LICENSE).
