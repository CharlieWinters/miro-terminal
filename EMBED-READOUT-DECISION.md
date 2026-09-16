# Decision board: what does the embed actually show?

Source content for the Miro board. Frames below map 1:1 to board frames.

---

## Frame 1 — The constraint (settled, not up for debate)

Chrome's Local Network Access permission gates **every** request to loopback,
including iframe navigation, and a nested cross-origin iframe can't be granted
it unless the top frame (miro.com) delegates via `Permissions-Policy`. It
doesn't.

- Verified 2026-09-07: PTY server healthy on `https://localhost:3001`, mkcert CA
  trusted, no frame-blocking headers, `miro-terminal:ready` ping present in
  `terminal.html`. Chrome 152. It still fails.
- `ARCHITECTURE.md` claims "navigation isn't gated by PNA the way fetch is."
  That was true of PNA. LNA superseded it and closed the loophole.
- **Therefore: public page -> localhost is permanently dead.** No wrapper patch
  reopens it.

## Frame 2 — The reframe

"Can this browser reach 127.0.0.1?" was being used as a proxy for "is this
person the developer?" Those correlate but are different questions. The first is
network topology, which browsers are actively taking away. The second is
authorization.

Two problems, and they are **separable**:

- **P1 — How does the developer interact?** SETTLED: a Miro modal served from
  `localhost:5173`, talking to `localhost:3001`. Loopback->loopback, LNA never
  applies. Capability = "has this app installed against my own machine", which
  nobody else can forge. No token to distribute, no inbound exposure.
- **P2 — What does everyone else see in the embed?** OPEN. This is the whole
  board below.

## Frame 3 — P2: the spectrum

| Option | Fidelity | Infra | Exposure | Notes |
| --- | --- | --- | --- | --- |
| A. Static message (today) | none | none | none | Current State A. Zero value; also lies ("start your server") |
| B. **Stored snapshot** | last-N-lines, delayed | small | **durable** | The new idea. Embed becomes a readout, not a terminal |
| C. Live read-only mirror | full, real-time | relay + DO | ephemeral | Prior design. Highest fidelity, highest cost |
| D. Board item as readout | last-N-lines, delayed | **none** | inside Miro ACL | The app writes output into a shape/text item |
| E. B or C, host's choice | both | both | both | Snapshot default, live when broadcasting |

## Frame 4 — What "stored snapshot" actually buys (B)

It's not a cheaper mirror. It's a different object. The embed stops being a
terminal and becomes a **readout**.

- **Read-only becomes free.** A static file cannot accept input. Read-only stops
  being a rule enforced in a Durable Object and becomes a property of the
  medium. The entire host/viewer role split disappears.
- **Detection becomes free.** The payload carries `active` + `lastSeen`, so the
  embed always knows what to say. Today's State A/B guessing game — and the 4s
  timeout — both delete.
- **It works when the host's laptop is shut.** A board is usually read async.
  Arguably the *correct* behaviour, not a degraded one.
- **No relay, no WS, no fan-out, no DO, no reconnect/backpressure logic.**

What you give up:

- Real-time. Snapshot cadence becomes a tuning knob (per-line = chatty;
  5-10s debounced = probably right; on-exit only = simplest, loses "what's it
  doing now").
- Full-screen TUI fidelity. A snapshot of vim or Claude's TUI mid-redraw is
  garbage. **So strip ANSI and store plain last-N-lines** — a log, not a screen.
  Accepting this is what makes B coherent; fighting it turns B into C.

## Frame 5 — Where would stored output live?

- **Cloudflare R2/KV behind a tiny Worker** — public GET, ~free, host PUTs with a
  key. Best general fit for B.
- **Gist** — public URL, trivial API, no repo pollution. Rate limits are
  survivable at 5-10s cadence. Decent zero-new-infra option.
- **Commit into the GitHub Pages repo** — Pages already serves the embed, so
  literally no new service. But: GH token on the host, ~1min CDN propagation,
  git history pollution, Pages caching works against you. Cute, wrong.
- **The Miro board item itself (D)** — the app iframe (on localhost, has the SDK)
  writes last-N-lines into a shape/text item. **No store, no service, no public
  data** — Miro's own sync does the fan-out, inside Miro's existing permissions.
  Costs: item version churn, undo-history noise, write rate limits, ugly for
  long output.
  - NOTE this inverts an earlier constraint. The embed can't read board items
    (no SDK in an embed) — but if the readout *is* a board item, nothing needs
    to read it. There may be no embed at all in this design.
- **Always-on Node + SQLite (Fly/Render)** — most control, most ops. Only if you
  want history/search later.

## Frame 6 — The new risk B introduces

**Exposure becomes durable.** A live stream is ephemeral and needs a concurrent
viewer. A stored snapshot sits on the internet at a URL until something deletes
it. Terminal output contains tokens CLIs echo, `env` dumps, `git remote` URLs
with creds, internal hostnames.

- Needs an explicit TTL / retention answer, not just an opt-in toggle.
- `generateEmbedId()` is `Date.now() + Math.random()`. Under B it is the *only*
  thing protecting a persisted file. Must become `crypto.randomUUID()`.
  (Change this regardless of which option wins.)
- **This is the strongest argument for D**: the data never leaves Miro's
  permission model, so there's no public URL to guess and no retention policy to
  design.

## Frame 7 — Non-negotiables, whichever way this lands

- Publishing output is **opt-in**, per session, default off.
- Session ids are high-entropy (`crypto.randomUUID()`).
- Visible indicator in the readout when it's live/publishing.
- If live (C): viewers instantiate xterm at the host's `cols`/`rows` from a
  hello frame and CSS-scale. Never `FitAddon` on the viewer side.
- P1's modal is independent of all of this. It can ship first, on its own.

## Frame 8 — Open questions (the actual decision)

1. **Who is the embed for?** Teammates watching you work live, or someone
   opening the board next Tuesday? Live-vs-stored follows entirely from this.
   Everything else on this board is downstream of this one question.
2. Is a stripped plain-text log acceptable, or does the demo need the terminal
   to *look* like a terminal?
3. Is durable public storage acceptable at all — or does that alone push you to
   D (board item)?
4. Does the readout need to survive the session, or only reflect the live one?
5. If D: is board-item churn tolerable, or does it wreck the board's undo
   history in practice? (Untested. Cheap to spike.)

## Frame 9 — Free simplification, already banked

Moving the interactive surface into a **modal** (P1) means it's a real app
iframe with `miro.board` available. It reads connected items and viewport
directly via the SDK — which deletes `/api/context/:embedId`,
`/api/context/requests`, the 10s push loop and the 2s poll. That HTTP relay only
ever existed because `terminal.html` was SDK-less.
