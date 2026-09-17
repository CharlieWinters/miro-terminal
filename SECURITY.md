# Security

This project runs a shell on your machine and puts a window onto it inside a
shared document. Please read this before running it, and especially before
changing where anything is served from.

## The threat model in one line

The terminal server has no meaningful authentication of its own. Its safety
comes from being **unreachable** — it listens on `localhost`, and a page served
from the internet is forbidden by the browser from talking to `localhost`. Every
other control here is secondary to that one.

So: **do not bind the terminal server to a public interface, and do not put it
behind a tunnel.** Doing either hands a shell to the internet. If you need
remote access, put an authenticating proxy in front and understand that you are
now the one responsible for the authentication.

## What each participant can do

| | Read history | Type into a terminal |
| --- | --- | --- |
| Board viewer, no app installed | no | no |
| Board viewer with the app installed | **yes** | no |
| You, on the machine running the server | yes | yes |

A collaborator installing the app gains no access to anyone's machine. They gain
the ability to read what a terminal wrote, because that is stored on the board.

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

- **off by default**, and per-browser rather than per-board
- shown with a switch that stays visible the whole time it is on
- authorised by a nonce the relay issues over `postMessage`, never through a
  URL, so nothing secret is written into board content
- restricted to origins you list in the relay app's own App URL

The residual weakness, stated plainly: the relay cannot cryptographically bind
a frame to a board widget. A frame on the same page that guessed a session id
and received a nonce could impersonate an embed. On a trusted team board this
is fine. On a board where untrusted people can add embeds, leave Live mode off.

## Reporting something

Open an issue for anything that is not itself exploitable. For something that
is, please report it privately to the repository owner rather than in a public
issue.
