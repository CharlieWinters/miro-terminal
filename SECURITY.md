# Security

This project runs a shell on your machine and puts a window onto it inside a
shared document. Please read this before running it, and especially before
changing where anything is served from.

## The threat model in one line

The terminal server has no meaningful authentication of its own. Its safety
comes from being **unreachable** — it binds `127.0.0.1` only, and a page served
from the internet is forbidden by the browser from talking to `localhost`. Every
other control here is secondary to that one.

Both halves matter, and they fail differently. The bind is what keeps other
machines out, and it is absolute. The browser rule is what keeps public *pages*
out, and it is a browser behaviour rather than something this server enforces:
`/api/pty/start` is unauthenticated, so anything that does reach it can create
a session and is handed a token for it. Do not rely on the browser rule alone
where you would not rely on an open port.

So: **do not bind the terminal server to a public interface, and do not put it
behind a tunnel.** Doing either hands a shell to the internet. If you need
remote access, put an authenticating proxy in front and understand that you are
now the one responsible for the authentication.

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

The residual weakness, stated plainly and less comfortably than it used to be
stated here: the relay cannot cryptographically bind a frame to a board widget,
and nothing else in the chain makes up for it.

- It is not a matter of *guessing* a session id. A request to open an unknown
  session id does not get refused; it creates a new session. So a frame needs
  no prior knowledge of anything.
- Session ids are not secret anyway. They travel in the embed's URL, which is
  board content, readable by anyone with board access and over the REST API.
- The `EMBED_ORIGINS` check is an origin-string comparison, and a frame with an
  opaque origin is let through it by design, so that sandboxed embeds work. Any
  page can arrange to have an opaque origin.
- The frames that can reach the relay are every frame on the board page, which
  includes any embed widget an editor has added, pointing anywhere.

Taken together: on a board where people you do not trust have edit access,
having the relay app installed while the board is open is close to handing them
a shell, and switching Live mode off in your embed does not change that. Until
that binding exists, treat "the relay app is installed and this board is open"
as the security decision, and make it per board rather than once.

## Reporting something

Open an issue for anything that is not itself exploitable. For something that
is, please report it privately to the repository owner rather than in a public
issue.
