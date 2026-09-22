# Security

This project runs a shell on your machine and puts a window onto it inside a
shared document. Please read this before running it, and especially before
changing where anything is served from.

## The threat model in one line

The terminal server has no meaningful authentication of its own. Its safety
comes from being **unreachable** — it binds `127.0.0.1` only, and on Chrome a
page served from the internet is forbidden from talking to `localhost`. Every
other control here is secondary to that one.

Say "on Chrome" precisely: that rule is Chrome's Local Network Access. Safari
does not implement it at all, and Firefox's support is partial. On those
browsers there is no such barrier, and a public page can address `localhost`
like any other host.

Both halves matter, and they fail differently. The bind is what keeps other
machines out, and it is absolute. The browser rule, where a browser has it, is
what keeps public *pages* out — and even on Chrome it is a browser behaviour
rather than something this server used to enforce on its own. That has
changed: the server now checks the Host header on every request and the
WebSocket upgrade, and refuses one that isn't its own — which is what stops
DNS rebinding, where an attacker's domain resolves to `127.0.0.1` after the
browser's same-origin checks have already passed and the request then arrives
with whatever Host the attacker chose. It also refuses a state-changing
request or a WebSocket upgrade whose Origin header is set and not on the
allowlist, which is what stops another page already running on your machine
— a different local dev server, some other tool on the same box — from using
this API just because it can also reach loopback. That is what these checks
buy: rebinding and other-local-page access are closed. What they do not do is
replace the loopback bind or add authentication — `/api/pty/start` is still
unauthenticated, so anything that does reach it (a request with no Origin
header, such as curl, or one from a browser without LNA) can create a session
and is handed a token for it. Do not rely on Host/Origin checks alone where
you would not rely on an open port.

So: **do not bind the terminal server to a public interface, and do not put it
behind a tunnel.** Doing either hands a shell to the internet. If you need
remote access, put an authenticating proxy in front, list the host it forwards
as `ALLOWED_HOSTS` so the Host check doesn't reject it, and understand that you
are now the one responsible for the authentication.

## What each participant can do

| | Read history | Type into a terminal |
| --- | --- | --- |
| Board viewer, no app installed | no | no |
| Board viewer with the app installed | **yes** | no |
| Board **editor**, with the app installed | **yes** | see "Live mode" below |
| You, on the machine running the server | yes | yes |

A collaborator installing the app gains no access to anyone's machine. They gain
the ability to read what a terminal wrote, because that is stored on the board.

Edit access is a different matter, and the row above is deliberately not a
"no". Board content is an input to this app: the embed's own URL configures it,
and connected items are expanded into commands. Someone who can change board
content can therefore influence what a terminal does. **Only put a terminal on
a board whose editors you would give a shell to.**

## What ends up on the board

Terminal history is written into the embed widget's app metadata: roughly the
last 50 lines, ANSI stripped, plus who ran it and when. It is scoped to this
app, so only somebody with the app installed can read it — but that includes
everyone you have shared the board with.

**Anything on screen goes with it**: tokens a CLI echoes back, `env` output,
`git remote` URLs containing credentials, internal hostnames, customer names in
file paths. Treat a board with a terminal on it as being as sensitive as the
terminal.

Session ids are `crypto.randomUUID()`. PTY tokens are never written into board
content at all — the modal and the relay each mint their own, on the machine
that owns the session.

## Live mode

Live mode makes an embed an interactive terminal, which means keystrokes travel
through a publicly served page. It is therefore:

- **off by default** in the embed UI, and per-browser rather than per-board
- shown with a switch that stays visible the whole time it is on
- authorised by a nonce the relay issues over `postMessage`, never through a
  URL, so nothing secret is written into board content
- restricted to the origins you list in `EMBED_ORIGINS` in `backend/.env`

Read that first bullet precisely. The switch is a property of the embed page in
your browser; it is not a lock on the relay. While the relay app is installed
and the board is open, the relay frame is loaded and will answer a request to
open a session whether or not any embed is showing the switch as on. Turning
Live mode off stops *your embed* sending keystrokes. It does not withdraw the
capability from the page.

An approval prompt itself is scoped to the board tab that asked for it: the
relay in one tab no longer answers to, or is answered by, an approve panel
acting on a different tab's relay, so clicking allow for a session on one
board does not also grant one you were never asked about on another board open
in a different tab.

The residual weakness, stated plainly and less comfortably than it used to be
stated here: the relay cannot cryptographically bind a frame to a board widget,
and nothing else in the chain makes up for it.

- It is not a matter of *guessing* a session id. A request to open an unknown
  session id does not get refused; it creates a new session. So a frame needs
  no prior knowledge of anything.
- Session ids are not secret anyway. They travel in the embed's URL, which is
  board content, readable by anyone with board access and over the REST API.
- The `EMBED_ORIGINS` check is still an origin-string comparison, but the
  relay itself no longer has an opaque-origin carve-out: that was removed from
  `relay.html` on 18 Sep 2026 after measuring that Miro renders the embed
  iframe with `allow-same-origin`, so a genuine embed always reports a real
  origin and a sandboxed frame gets nothing by pretending otherwise. The
  equivalent carve-out is still open in the APP iframe's bridge
  (`frontend/src/hostBridge.ts`) — it is marked there as known-open pending
  measurement of the modal and the spawner, which are opened through
  `openModal`/`openPanel` and haven't been checked the way the embed has. A
  sandboxed frame reaching that bridge can read the connected-item context for
  any embed on the board, write a history snapshot into any terminal's
  metadata (stamped with the host's own name, since the bridge fills in the
  `by` field from the host's own identity), open the host's terminal modal,
  and ask the app to place a new embed.
- The frames that can reach the relay used to be every frame on the board
  page, including any embed widget an editor had added, pointing anywhere.
  That is no longer so for the relay: only a frame running on an allowlisted
  origin gets past the check above. The equivalent is not yet true of the app
  iframe's bridge, for the reason in the previous bullet.

Taken together: the relay's own origin check is no longer the weak link it
was, but the residual weakness stated above still holds through the bridge,
and the underlying gap it stands in for hasn't closed — the relay still
cannot cryptographically bind a frame to a board widget, and approval is
granted per session id, not per widget, so approving one session's request
does not tell you which widget on the board actually asked for it. On a board
where people you do not trust have edit access, having the relay app
installed while the board is open, or having the app iframe's bridge reachable
by an untrusted sandboxed frame, is close to handing them a shell, and
switching Live mode off in your embed does not change that. Until the bridge
gets the same treatment the relay did, treat "the relay app is installed and
this board is open" as the security decision, and make it per board rather
than once.

## Reporting something

Open an issue for anything that is not itself exploitable. For something that
is, please report it privately to the repository owner rather than in a public
issue.
