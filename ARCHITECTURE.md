# Architecture — Miro Terminal

Extracted from `miro-ide`'s `terminal-embed` + `terminal-server` + `terminal-wrapper`
into its own repo, following the same hosted-frontend / self-hosted-backend split
as `fal-miro`. This file is the repo-local copy of the board's plan
(https://miro.com/app/board/uXjVHw91nj0=/) — read that board for the full
decision history; this is just the settled shape.

## Two iframes

| Iframe   | Entry HTML     | Entry script       | Job |
| -------- | -------------- | ------------------- | --- |
| Headless | `index.html`   | `src/main.ts`        | Owns the Miro SDK, listens for `icon:click`, opens the panel. |
| Panel    | `app.html`     | `src/panel.ts`       | Backend URL settings (save/clear, per-browser), session name / cwd fields, "Create terminal" button. |

There's no modal and no `RUN_AGENT`-style cross-frame message bus — unlike
fal-miro this app has exactly one job, so the panel calls `createTerminalEmbed`
(`src/terminalEmbed.ts`) directly.

### The embed — a third, Miro-SDK-free surface

The widget created by `board.createEmbed` points at either the terminal server
directly, or (once the shared wrapper is turned on) at `terminal-wrapper/index.html`
— a static page with **no Miro SDK and no backend of its own**. Same principle as
fal-miro's `embed-*.html` pages: every board viewer's browser loads it straight
from wherever it's hosted (GitHub Pages), and it decides for itself what to show.

## Why this backend can't be Hono/Workers like fal-miro's

fal-miro's backend is Hono specifically so the same code deploys to a plain Node
host *or* Cloudflare Workers with only a different entrypoint. `backend/server.js`
here uses `node-pty` to spawn a real OS process (your shell) — that cannot run in
a Workers V8 isolate, full stop. So:

- The PTY backend (`backend/`) only ever deploys to a Node host or container
  **you** control (your laptop, a VM, a container). It is never Workers-deployable.
  There's no dual-entrypoint trick available here.
- A Cloudflare Worker is still the right tool for the **opt-in streaming relay**
  (state C below) — it's a thin WebSocket fan-out, not a PTY host.

## Three states for a viewer opening the terminal embed

**State A — nobody's terminal is reachable from your browser.** The wrapper's
health probe against `terminalBase` (restricted to `localhost`/`127.0.0.1`/`[::1]`)
fails, so it shows: *"A collaborator started this session on their computer."*
No connection attempt, no broken iframe.

**State B — you are the host.** The health probe succeeds (you're on the same
machine as the PTY server), so the wrapper iframes `terminal.html` directly —
you get your own live terminal.

**State C — opt-in streaming to everyone else (not built yet).** The host's
local `backend/server.js` opens an outbound WebSocket to a small Cloudflare
Worker relay; the Worker fans out **read-only** terminal output to any other
viewer's embed. No input path back — matches "no control over the terminal."
Opt-in is an **explicit toggle in the corner of the embed**, host-controlled,
not always-on. Optional history: check Cloudflare's free tier (KV / D1 /
Durable Objects) before reaching for a real database.

## Backend (`backend/server.js`)

Express + `node-pty` + `ws`, unchanged from `miro-ide`'s `terminal-server`:

| Method | Path                          | What |
| ------ | ----------------------------- | --- |
| POST   | `/api/pty/start`              | `{ sid?, cwd?, name? }` → creates/reuses a PTY session, returns `{ sid, url, wsUrl }` with a short-lived HMAC token. |
| DELETE | `/api/pty/close`              | `?sid=…` — kills the session. |
| GET    | `/health`                     | Liveness + session count. Unauthenticated — this is what the wrapper probes. |
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

## Board content → terminal ("MCP" note on the board is a misnomer)

The board sticky that called this "MCP" is **not** the Model Context Protocol.
It's a bespoke HTTP push/poll relay, kept as-is:

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
   | `viewport` | Current viewport `{x, y, width, height}` as JSON |
   | `board_id` / `board_name` / `current_board` | Board identity |
   | `selected_items` | Placeholder only — selection isn't available inside an embed |

   `[INPUT]` used to be the angle-bracket `<input>` — replaced with the
   bracket syntax so every connected-item variable uses one consistent form
   (`[INPUT]`, `[LABEL]`, `[LINK_x]`), rather than special-casing the
   unlabelled-items blob as the odd one out. `INPUT` is a built-in token name;
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
