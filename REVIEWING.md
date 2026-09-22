# Reviewing this repo

How to do a security review of this project, written after doing one. The
findings from that review are on the board linked at the bottom; this file is
the method, which is the part that would otherwise have to be rediscovered.

Most of it is ordinary. The parts worth reading are [what to
distrust](#four-things-to-distrust), because each one cost real time.

## Start from the diff, not the top

A re-review is not a repeat: the surface moves, and it moves most where the last
review touched. The remediation for the first review added roughly 1,400 lines
across `relay.html`, `terminal.html` and a new `approve.html` — and three of the
four bugs found afterwards were *caused* by that remediation. New code written
in response to a review deserves more suspicion than the code it replaced, not
less.

```bash
git log --oneline <last-review-tag>..HEAD
git diff --stat <last-review-tag>..HEAD
```

## Set up so you do not manufacture findings

```bash
git clone <repo> /tmp/review && cd /tmp/review/backend && npm install
env -i PATH="$PATH" HOME="$HOME" PORT=3999 node server.js
```

**Always `env -i`.** The first onboarding finding of the last review was fake: a
shell profile exported `SSL_KEY_PATH`, so a clean clone appeared to fail on a
missing certificate. Ten minutes spent on the reviewer's own environment.

**Never test against the server on 3001.** Crash tests kill live shells.

## Attack in this order

1. **Reachability.** Everything else is secondary, because the whole threat
   model rests on this one property.
   ```bash
   lsof -nP -iTCP:3001 -sTCP:LISTEN     # expect 127.0.0.1, not *
   curl http://<your-lan-ip>:3001/health # expect refused
   ```
   That pair of lines found the worst issue in the first review: the server was
   binding every interface, so anything on the same network had a shell.

2. **Unauthenticated endpoints.** `/health`, `/api/browse`, `/api/pty/:sid`,
   `/api/pty/:sid/attach`, `/api/relay-config`, `/api/context/*`. For each, ask
   what a caller who has nothing at all gets.

3. **Every postMessage handler**, in `relay.html`, `hostBridge.ts`,
   `terminal.html`, `spawner.html` and `approve.html`. Any frame on the board
   page can reach all of them. For each handler: what does an unauthenticated
   frame achieve?

4. **The board-content-to-shell path.** Board content is untrusted input that
   reaches a command line. Two of the three criticals lived here.

## Build a hostile origin, do not read the code

The pattern that found everything real: a page on an origin you control,
iframing the surface under test, impersonating the app iframe by answering
`mt:ctx-request` with a malicious payload, driven by Playwright. Use a marker
file as the proof — `touch /tmp/PWNED` — so success is unambiguous rather than a
judgement about what a string might do.

**Make the harness lie in a specific direction.** The board-token bug only
surfaced because the harness was given a deliberately *stale* URL value and the
test asserted the live one won. A harness that checks "a value appears" passes
while the feature is broken.

## Reproduce before believing the fix

For every bug: demonstrate it, fix it, demonstrate it is gone. `git stash` the
fix and re-run if that is what it takes. Eight sockets before and one after is
evidence; one socket after, alone, is a hope.

## Four things to distrust

**Code comments.** Three separate comments asserted that Miro renders embeds
sandboxed, so their origin arrives as `null`. That belief was the stated reason
for a carve-out that let any page skip an origin check. Measuring the live board
showed `allow-same-origin`: the comments were wrong, and they were specific and
confident enough that they nearly overrode a correct recommendation. Comments
are hypotheses with good PR.

**Your own verification.** Checks produced false results three times in one
review: `zsh` does not word-split unquoted variables, so a file list iterated as
one bogus path and reported seven consecutive failures; a bundle hash was
hardcoded and went stale; `grep -c` against a large command substitution
returned blank rather than a number. When a check fails, first ask whether the
check is wrong.

**The deploy.** `gh-pages` prints `Published` either way. The bundle-hash rule
is not sufficient: `terminal.html` and `styles.css` are published but unhashed,
so three separate deploys changed live files with no hash movement at all, and
one deploy changed the hash while the check looked for the old one. Byte-compare
every published file against `.pages/`, and poll — propagation takes up to a
minute.

```bash
npm --prefix frontend run pages:stage
# then diff each live URL against frontend/.pages/<same path>
```

**"It works."** Token substitution worked at a shell prompt and silently failed
inside any full-screen program, because every control sequence — including an
arrow key — discarded the line buffer it depends on. It failed only in the case
people actually use. Test the path that is used, not the path that is easy to
drive.

## Known-open, deliberately

- The opaque-origin carve-out in `hostBridge.ts`. Only the embed was measured;
  the modal and spawner also call that bridge and have not been. Marked in the
  source. Measure them, then it can go.
- `*.miro.com` remains a CORS wildcard, unexamined.

## Where the artefacts are

Findings, decisions and the post-review history live on the build plan board:
https://miro.com/app/board/uXjVHmMHqHk=/

`SECURITY.md` is the threat model and was corrected to match reality during the
last review. Treat any divergence between it and the code as a finding in its
own right — three of the first review's results were the documentation being
confidently wrong.
