# Architecture — Miro Terminal

Read the README first for what this is and how to run it. This file is about
**why each piece is where it is**, because almost every structural decision here
follows from one browser rule, and none of it looks reasonable without that.

## The rule everything follows from

A page served from the internet may not talk to `localhost`. Chrome's Local
Network Access gates `fetch`, `XHR`, WebSocket **and iframe navigation**, and
the permission cannot be granted to a page nested inside another site's iframe,
because the top-level page — Miro's, not ours — would have to delegate it.

That was established the hard way. An earlier version of this app tried to have
a publicly served wrapper detect the host by navigating a nested iframe at
`localhost` and waiting for a ping, on the theory that navigation was not gated
the way `fetch` is. That was true of the older Private Network Access behaviour
and is not true of LNA. The result was that the host got the same "runs on
another machine" card as everybody else, with no way to tell the cases apart.

There is a second, less obvious half. A Miro app surface served from an origin
the app is **not registered at** loads `miro.js` and even exposes
`window.miro.board` — but the SDK never completes its connection handshake, so
every board call throws (`SdkConnectionError: SDK version fetching timeout`).
Measured, not assumed; the object existing is not evidence the SDK works.

Put together: **a surface can reach your machine, or it can use the board, never
both.**

## Which is why there are five surfaces

| Surface | Origin | Has the SDK | Can reach the PTY |
| --- | --- | --- | --- |
| Headless iframe (`index.html`) | public | yes | no |
| Settings panel (`app.html`) | public | yes | no |
| Embed wrapper (`terminal-wrapper/`) | public | no | no |
| `spawner.html`, `relay.html` | your machine | relay only¹ | yes |
| `terminal.html` | either² | no | in `ws` mode |

¹ The relay is served at its *own* app's registered origin, so its SDK does
connect — though it never uses it for anything but the toolbar icon.
² Served by the terminal server for the modal, and published publicly for live
embeds. One file, two modes, chosen by a `transport` query parameter.

They talk to each other with `postMessage`, which is not a network request and
so is subject to none of the above. An earlier comment in `terminalEmbed.ts`
claimed postMessage between these frames does not work, and an entire HTTP relay
was built around that claim. It was wrong: no frame has a *reference* to any
other, but `length` and indexed access are on the cross-origin property
allowlist, so any frame can walk the tree from `window.top` and post to every
frame it finds. Verified both same-origin and cross-origin.

Discovery posts with a wildcard target origin and every **reply** is checked
against an allowlist. The reverse — exact target origins on the way out — makes
the browser log an error per non-matching frame, which on a board with several
apps installed buried everything worth reading. Outbound discovery carries
nothing secret, so the asymmetry costs nothing: ask loudly, listen selectively.

Stated as a rule, that is not quite what the code does, and the exceptions are
worth knowing before relying on it:

- `hostBridge.ts`'s `broadcast` uses **exact** origins, one post per allowed
  origin — not a wildcard. The rule above describes `relay.html`'s `announce`,
  `terminal.html`'s transport discovery and the wrapper's, but not this one.
- The reply direction is wildcarded when the *requester* had an opaque origin
  (`relay.html`'s `post`, `hostBridge.ts`'s `reply`). Those replies are not
  discovery and do carry payload — the relay nonce, and board context
  respectively. See SECURITY.md on opaque origins.
- `terminal.html`'s `post` is one function for discovery *and* for keystroke
  envelopes. Its wildcard branch is unreachable for the latter only because of
  the order in which relayWindow gets set.

Every inbound allowlist on the embed side (`appOrigins`, `relayOrigins`) is read
from the surface's own **URL**, and an embed's URL is board content. So those
allowlists are configured by the channel they are meant to guard: they stop
accidents and unrelated apps, not someone with board edit access.

## The two things that cross a boundary

**Creating a terminal** needs a localhost call (`/api/pty/start`) and a board
write (`createEmbed`). So `spawner.html` does the first and hands the started
session to the headless iframe, which does the second.

**A live terminal in an embed** needs a socket to the PTY from a public page,
which is impossible. So `relay.html` — a second Miro app, served from your
machine, whose iframe is loaded with the board and stays for the session — holds
the sockets and forwards envelopes by `postMessage`. It is a separate app
because an app has one `sdkUri` and this one has to be local; it stores nothing,
so nothing is lost by keeping it apart.

Every PTY exchange was already a JSON envelope (`{type:'input'|'resize'}` out,
`{type:'data'}` in), so this was a transport swap rather than a protocol change:
one interface, two implementations, and the handlers cannot tell which they are
on.

## Tokens and nonces

The PTY token expires (`TOKEN_TTL`) while a board URL does not, so nothing
long-lived may carry one. It is not in the embed URL, not in the modal URL, and
never reaches a public page. Both the modal and the relay mint their own, each
on the machine that owns the session.

Live mode authorises keystrokes with a nonce the relay issues over `postMessage`
and re-issues on every reconnect. Deliberately never through a URL: an embed's
URL is board content, readable by anyone with board access.

## Designed for being reloaded

Miro and Chrome both reset offscreen app iframes. So a reconnect is the normal
path: every relay open mints a fresh token and a fresh socket rather than
reusing one, the PTY replays its scrollback on connect so the screen comes back
correct rather than partial, and nothing is keyed to a frame that may not
outlive the request.

## History on the board

The terminal writes roughly its last 50 lines into the embed widget's app
metadata, debounced. Chosen over a visible board item because metadata is
invisible, is deleted with the item it belongs to, and does not land in every
collaborator's undo stack — at the cost of being readable only by someone with
the app installed.

The snapshot comes from **xterm's own buffer**, not from the PTY stream. A first
attempt stripped ANSI from the stream and rebuilt the text, which produces
plausible nonsense: a terminal positions output with cursor-movement escapes, so
once those are stripped the remainder concatenates in stream order rather than
screen order. It looked populated, timestamped and correct, and was wrong.

Metadata caps around 6 KB, which is about 100 lines of terminal text — measured,
not guessed. `SCROLLBACK_BYTES` is 200 KB, about 3,200 lines, so the board holds
a *readout* and the server keeps the buffer. See the board linked below for the
sizing work behind a fuller archive, which is not built.

## Boards

- Decision history: https://miro.com/app/board/uXjVHqTcS-o=/
- Build plan and phases: https://miro.com/app/board/uXjVHmMHqHk=/

## Backend (`backend/server.js`)

Express + `node-pty` + `ws`, unchanged from `miro-ide`'s `terminal-server`:

| Method | Path                          | What |
| ------ | ----------------------------- | --- |
| POST   | `/api/pty/start`              | `{ sid?, cwd?, name? }` → creates/reuses a PTY session, returns `{ sid, url, wsUrl }` with a short-lived HMAC token. |
| DELETE | `/api/pty/close`              | `?sid=…` — kills the session. |
| GET    | `/health`                     | Liveness + session count. Unauthenticated. No longer what the wrapper uses for detection (see "Two iframes" above) — still useful for manual debugging/curl. |
| GET    | `/api/browse`                 | `?path=…` (optional, defaults to `ALLOWED_ROOT`) — lists subdirectories for the panel's working-directory picker. Same `safeJoin`/`ALLOWED_ROOT` scoping as `cwd`. Unauthenticated, like `/health`. |
| POST   | `/api/pty/:sid/input`         | `{ token, data, pressEnter? }` — writes `data` straight into the session's PTY, as if typed. Always human-triggered from the panel's "Send to terminal"; nothing calls this automatically. |
| POST   | `/api/context/:embedId`       | Pushes `{ input, named, viewport }` for an embed (see below). |
| GET    | `/api/context/:embedId`       | Reads it back. |
| GET    | `/api/context/requests`       | Which `embedId`s the terminal has asked for context for. |
| POST   | `/api/context/:embedId/request` | Terminal signals it wants context now. |
| WS     | `/pty?sid=…&token=…`          | The live PTY stream, HMAC-token authenticated. Replays the session's buffered scrollback (see below) to every newly-connecting client before live output resumes. |

**Scrollback on reconnect.** Each session buffers its raw PTY output (capped
at `SCROLLBACK_BYTES`, default 200 KB) and replays it — ANSI codes and all —
to any client that connects, including a reopened/reloaded embed. `terminal.html`
doesn't need to know the difference; a replay is just another `{type: 'data'}`
WS message, identical to a live one. This only works while the underlying PTY
process is still alive server-side: once a session idles past `SESSION_TIMEOUT`
or the backend process restarts, the shell (and its scrollback) is genuinely
gone — there's nothing to resume, since nothing kept running.

Sessions idle-timeout (`SESSION_TIMEOUT`, default 1h). `cwd` is confined to
`ALLOWED_ROOT` (path-traversal-checked). See the README for full env var docs —
there is deliberately no `.env.example` file in this repo (nothing here should
ever be copy-pasted with real values in it); copy the table from the README
into your own local `.env` instead.

## Working-directory picker (panel)

The panel's "Browse…" button next to the working-directory field is backed by
`/api/browse`, not a native browser file picker. That's not a stylistic
choice — a web page can never learn a real filesystem path from
`<input type="file" webkitdirectory>` or the File System Access API; both
deliberately withhold it as a security boundary. Only the backend, as a real
process on your machine, can see real paths, so it's the only thing that can
answer "what's in this folder" with something usable as a `cwd`. The panel
(`panel.ts`) renders a breadcrumb + clickable subfolder list from
`/api/browse`'s response and writes the chosen absolute path straight into
the working-directory input on "Use this folder" — no new state, it's just
filling in the same field you could type into directly.

## Board content → terminal

Not MCP, despite what an early board sticky called it. Board items connected to
a terminal embed become variables you can type into it.

**How it is read now:** the surface showing the terminal asks the app's headless
iframe over `postMessage` (`mt:ctx-request`), and that iframe — which is the
only one with a working SDK — reads the connectors and answers. No network call
is involved.

**The HTTP push/poll relay below is a fallback**, kept only for the solo
local-dev flow where an embed points straight at `localhost` and no app iframe
is listening. It cannot run from a public origin and refuses to try.

The original mechanism, for reference:

1. `terminalEmbed.ts` finds items connected to the embed via connectors
   (`getConnectedItems`), classifies each one (see the labelling rule below),
   and POSTs the result plus the current viewport to `backend`'s
   `/api/context/:embedId` every 10s.
2. `terminal.html`'s variable expander substitutes them into whatever you type:

   | Variable | Expands to |
   | --- | --- |
   | `[INPUT]` | Content of every connector **with no caption**, newline-joined — the item's text if the Web SDK can read it (sticky/text/shape), otherwise its board link |
   | `[LABEL]` (e.g. `[FRONTEND_PROMPT]`) | The content of whichever connected item's connector is captioned `LABEL` |
   | `[LINK_1]`, `[LINK_2]`, ... (or any caption starting with "link") | That connector's item's board link, not its content — an explicit opt-in per connector |
   | `[VIEWPORT]` | Current viewport `{x, y, width, height}` as JSON |
   | `[BOARD_ID]` / `[BOARD_NAME]` / `[CURRENT_BOARD]` | Board identity |
   | `[SELECTED_ITEMS]` | Placeholder only — selection isn't available inside an embed |

   `[INPUT]` used to be the angle-bracket `<input>` — replaced with the
   bracket syntax so every connected-item variable uses one consistent form
   (`[INPUT]`, `[LABEL]`, `[LINK_x]`), rather than special-casing the
   unlabelled-items blob as the odd one out. The board tokens were missed by
   that change and kept their angle brackets for a while, so which syntax you
   needed depended on which kind of thing you were asking for; they are all
   brackets now, resolved by one lookup in one pass rather than by three
   mechanisms. The old spellings still work, undocumented, because an
   unrecognised `<name>` is not inert at a shell prompt — it is a redirect. `INPUT` is a built-in token name;
   an explicit connector caption literally named `INPUT` overrides it (checked
   in `terminal.html`'s `expandVariables`).

   Token substitution is **recursive up to 5 passes** (`expandNamedTokens`):
   if a sticky's own text references another token — e.g. a prompt sticky
   reading `claude -p "...write it to [LINK_OUTPUT]"` — that nested
   `[LINK_OUTPUT]` gets resolved too, not left as literal text. Capped so a
   token whose value contains itself can't loop forever; after 5 passes
   whatever's left just stays as-is.

   **Labelling rule** (`fetchConnectedContext`/`getConnectedItems` in
   `terminalEmbed.ts`): the label lives on the **connector's caption**, not on
   the sticky's content — double-click a connector line on the board to add a
   caption. A sticky's content is never parsed or modified; it's only ever
   read as-is. Label the connector `FRONTEND_PROMPT` and its sticky (whatever
   it says) becomes typeable in the terminal as `[FRONTEND_PROMPT]`. If the
   caption itself starts with "link" (case-insensitive — a caption, not
   connector order, since connector order isn't reliably readable from the
   Web SDK), the token expands to that item's board link instead of its
   content — the explicit, human-authored way to pull in a link rather than
   content. If a captioned connector points at something the Web SDK can't
   read (documents/images/etc.), the token falls back to the link anyway,
   since there's nothing else to give. Connectors with **no caption** still
   feed `[INPUT]` exactly as before.

`mcp-server`/`mcp-client` in the old `miro-ide` repo are unrelated, unimplemented
stub modules — dead code, intentionally not ported here. Separately, Claude
Code's own Miro MCP server (used to build boards like the plan board above) is
also unrelated — it's how an AI agent reads/writes a board, not a mechanism
this app needs to implement.

## Not built yet

- **State C** — Cloudflare Worker relay + host-side opt-in toggle + optional history.
