/**
 * Host bridge — the app-iframe half of the embed↔app channel.
 *
 * The problem this solves: the embed is a public page (GitHub Pages) loaded by
 * every board viewer, and it cannot tell whether the person looking at it is
 * the developer running the terminal. It used to guess, by navigating a nested
 * iframe at localhost and waiting 4 seconds for a ready ping. Chrome's Local
 * Network Access closed that route — it gates every request from a public
 * origin to a loopback address, iframe navigation included, and a nested
 * cross-origin iframe cannot be granted the permission.
 *
 * So the embed stops guessing and asks. This module runs in the app's headless
 * iframe, which is served from localhost and can therefore reach the PTY server
 * freely (loopback to loopback — LNA never applies). It answers over
 * postMessage, which is not a network request and so is not gated either.
 *
 * The embed has no window reference to this frame, but it does not need one:
 * `length` and indexed access are on the cross-origin property allowlist, so it
 * walks the frame tree from window.top and posts to each frame. Verified live.
 *
 * Only two things cross this channel: a state report, and "please open the
 * modal". No keystrokes and no terminal output — those stay between the modal
 * (also localhost-origin) and the PTY server, so a public page never carries
 * anything privileged.
 */

import { getBackendConfig, canReachLoopback, WRAPPER_URL } from './backendConfig';
import { METADATA_KEY, placeTerminalEmbed } from './terminalEmbed';


/**
 * Origins allowed to talk to this bridge.
 *
 * The wrapper's origin is taken from WRAPPER_URL, which is itself derived from
 * where this app is served — so a fork needs no edit here. The localhost
 * entries cover running the wrapper from a dev server.
 */
const ALLOWED_EMBED_ORIGINS = Array.from(
  new Set([
    new URL(WRAPPER_URL).origin,
    window.location.origin,
    'http://localhost:5173',
    'https://localhost:5173',
    'http://localhost:4173',
  ])
);

/** The modal is served BY the terminal server, so its origin is whatever the
 * user configured as the backend. Added dynamically rather than hardcoded,
 * because the port is theirs to choose. */
function allowedOrigins(): string[] {
  const backend = getBackendConfig();
  if (!backend?.terminalBase) return ALLOWED_EMBED_ORIGINS;
  try {
    return ALLOWED_EMBED_ORIGINS.concat(new URL(backend.terminalBase).origin);
  } catch {
    return ALLOWED_EMBED_ORIGINS;
  }
}

/** A sandboxed iframe has an opaque origin and arrives as the literal "null".
 *
 * NOT removed here, unlike the equivalent in relay.html. The embed was measured
 * on 18 Sep 2026 and is not opaque-origin — Miro renders it with
 * allow-same-origin — which is what allowed the relay's carve-out to go. The
 * other callers of this bridge are the modal and the spawner, opened through
 * openModal/openPanel, and those have NOT been measured. Removing this before
 * measuring them risks breaking both.
 *
 * So read it as an open hole of known shape rather than a justified exception:
 * any page that sandboxes itself skips the origin check below, and what it
 * reaches is board reads and metadata writes. Measure the modal, then delete
 * this. */
const OPAQUE_ORIGIN = 'null';

/** Long enough for a loopback round trip, short enough that a stopped server
 * reads as "not running" rather than hanging the embed's spinner. */
const PROBE_TIMEOUT_MS = 2500;

const MSG = {
  hello: 'mt:hello',
  state: 'mt:state',
  openDev: 'mt:open-dev',
  opened: 'mt:opened',
  ctxRequest: 'mt:ctx-request',
  ctx: 'mt:ctx',
  historyWrite: 'mt:history-write',
  historyOk: 'mt:history-ok',
  historyChanged: 'mt:history-changed',
  spawn: 'mt:spawn',
  spawned: 'mt:spawned',
  openSpawner: 'mt:open-spawner',
  openSettings: 'mt:open-settings',
  error: 'mt:error',
  appReady: 'mt:app-ready',
} as const;

interface BridgeRequest {
  type?: string;
  v?: number;
  embedId?: string;
  history?: TerminalHistory;
  /** Spawn payload: the session the spawner already started on its own origin. */
  ptyUrl?: string;
  sessionName?: string;
  cwd?: string;
}

interface ConnectedContext {
  input: string;
  named: Record<string, string>;
  viewport: unknown;
}

interface EmbedWidget {
  id: string;
  type: string;
  url?: string;
  connectorIds?: string[];
  getMetadata?: <T>(key: string) => Promise<T>;
}

/**
 * Refuses, loudly and immediately, any request this origin cannot legally make.
 *
 * This has now been the same bug three times: a fetch at the terminal server
 * left behind in an app surface that moved to public hosting. The browser's
 * version of the complaint — "blocked by CORS policy: Permission was denied for
 * this request to access the loopback address space" — names neither the caller
 * nor the reason, and arrives as an unhandled rejection somewhere else entirely.
 *
 * Failing here instead makes the mistake self-describing at the call site.
 */
async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    /* relative or malformed — nothing to check */
  }
  const targetsLoopback =
    host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
  if (targetsLoopback && !canReachLoopback()) {
    throw new Error(
      `refusing to fetch ${url} from ${window.location.origin}: a public origin cannot ` +
        'reach a loopback address. This work belongs on a surface served by the terminal ' +
        'server, which then talks to this iframe over postMessage.'
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Locates the terminal embed this message is about, by the metadata key
 * `terminalEmbed.ts` stamps at creation. Matched on metadata rather than on
 * anything in the message, so the modal URL below is built from board state
 * and never from attacker-controllable input. */
const embedCache = new Map<string, { embed: EmbedWidget; at: number }>();
/** Long enough that a burst of messages costs one lookup, short enough that a
 * deleted or recreated embed heals itself without any invalidation plumbing. */
const EMBED_CACHE_TTL_MS = 30_000;

async function findEmbedByEmbedId(embedId: string): Promise<EmbedWidget | null> {
  // This is a scan: one call for the board's embeds, then one metadata read per
  // embed until a match. It runs on every bridge message — hello, ctx-request,
  // history-write, open-dev — and embeds re-announce themselves constantly,
  // because Miro resets offscreen app iframes. Uncached, on a board with four
  // terminals, that is five SDK calls per message against an hourly credit
  // budget. Cache the result; the scan is only for a miss.
  const hit = embedCache.get(embedId);
  if (hit && Date.now() - hit.at < EMBED_CACHE_TTL_MS) return hit.embed;

  const embeds = (await miro.board.get({ type: 'embed' })) as unknown as EmbedWidget[];
  for (const embed of embeds) {
    try {
      const meta = await embed.getMetadata?.<{ embedId?: string }>(METADATA_KEY);
      if (meta?.embedId) {
        // Every embed this scan identifies goes in, not just the one asked
        // for: the next message is usually about a sibling, and the scan
        // already paid for the answer.
        embedCache.set(meta.embedId, { embed, at: Date.now() });
      }
      if (meta?.embedId === embedId) return embed;
    } catch {
      // Not one of ours — no metadata under this key.
    }
  }
  embedCache.delete(embedId);
  return null;
}

/** The sid lives in the embed widget's own URL on the board (put there by
 * buildMiroEmbedUrl). Read it from the widget, not from the message. */
function sidFromEmbedUrl(embed: EmbedWidget): string | null {
  if (typeof embed.url !== 'string') return null;
  try {
    return new URL(embed.url).searchParams.get('sid');
  } catch {
    return null;
  }
}

/** Written by the terminal itself, from inside the modal — see the history
 * section of backend/public/terminal.html. Lives in the embed widget's own
 * metadata: invisible, deleted with the terminal, and it never lands in a
 * collaborator's undo stack the way editing item content would. */
const HISTORY_METADATA_KEY = 'miro-terminal-history';

export interface TerminalHistory {
  lines: string;
  sessionName: string | null;
  updatedAt: string | null;
  by: string | null;
}

function stripHtml(html: unknown): string {
  return String(html ?? '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
}

/** Cards keep their text in title/description, not content. Anything
 * unreadable falls back to a board link, the only useful thing left to give. */
function readItemText(item: Record<string, string | undefined> & { type: string }): string | null {
  if (item.type === 'sticky_note' || item.type === 'text' || item.type === 'shape') {
    return stripHtml(item.content) || null;
  }
  if (item.type === 'card' || item.type === 'app_card') {
    const parts = [stripHtml(item.title), stripHtml(item.description)].filter(Boolean);
    return parts.length ? parts.join('\n') : null;
  }
  if (item.type === 'frame') return stripHtml(item.title) || null;
  return null;
}

/**
 * Reads the items connected to a terminal embed, for the modal.
 *
 * This lives here rather than in terminal.html because the modal is served by
 * the terminal server, on a different origin from the app — and a Miro app
 * surface on a foreign origin loads the SDK but never completes its connection
 * handshake ("SDK is not connected / version fetching timeout"), so board calls
 * from there throw. This iframe is the app's own origin, so its SDK works.
 *
 * That split is permanent, not a workaround: once sdkUri is publicly hosted, no
 * single surface can hold both a working SDK and access to localhost. Board
 * work belongs on the app origin; PTY work belongs on the machine.
 *
 * Labelling rule unchanged: the label is the CONNECTOR's caption, never the
 * item's content, and a caption starting with "link" resolves to a board link.
 */
async function readConnectedContext(embed: EmbedWidget): Promise<ConnectedContext> {
  const [boardInfo, viewport] = await Promise.all([
    miro.board.getInfo(),
    miro.board.viewport.get(),
  ]);
  const boardId = (boardInfo as unknown as { id: string }).id;

  const connectorIds = embed.connectorIds ?? [];
  const connectors = connectorIds.length
    ? ((await miro.board.get({ id: connectorIds })) as unknown as Array<{
        start?: { item?: string };
        end?: { item?: string };
        captions?: Array<{ content?: string }>;
      }>)
    : [];

  const pairs: Array<{ itemId: string; label: string | null }> = [];
  for (const c of connectors) {
    const startItem = c.start?.item;
    const endItem = c.end?.item;
    const other = startItem === embed.id ? endItem : endItem === embed.id ? startItem : undefined;
    if (!other) continue;
    pairs.push({ itemId: other, label: stripHtml(c.captions?.[0]?.content) || null });
  }

  const items = pairs.length
    ? ((await miro.board.get({ id: pairs.map((p) => p.itemId) })) as unknown as Array<
        Record<string, string | undefined> & { id: string; type: string }
      >)
    : [];
  const byId = new Map(items.map((i) => [i.id, i]));

  const inputParts: string[] = [];
  const named: Record<string, string> = {};
  for (const { itemId, label } of pairs) {
    const item = byId.get(itemId);
    if (!item) continue;
    const link = `https://miro.com/app/board/${boardId}/?moveToWidget=${itemId}&cot=14`;
    const text = readItemText(item);
    if (label) named[label] = /^link/i.test(label) ? link : text ?? link;
    else inputParts.push(text ?? link);
  }
  return { input: inputParts.join('\n'), named, viewport };
}

export interface BridgeState {
  hasApp: true;
  backendConfigured: boolean;
  /** Whether this iframe is even ABLE to look. False once the app is served
   * publicly, because a public origin may not reach loopback at all. When this
   * is false the two fields below are null, meaning unknown — which is a
   * different thing from false and must not be rendered as if it were. */
  canProbeBackend: boolean;
  backendReachable: boolean | null;
  hasThisSession: boolean | null;
  terminalBase: string | null;
  embedOnBoard: boolean;
  history: TerminalHistory | null;
}

/**
 * Everything the embed needs to decide what to render, gathered from the one
 * place that can gather it. `backendReachable` and `hasThisSession` are only
 * answerable from a loopback origin — which is exactly why this lives here and
 * not in the wrapper.
 */
async function collectState(embedId: string): Promise<BridgeState> {
  const backend = getBackendConfig();
  const canProbe = canReachLoopback();
  const state: BridgeState = {
    hasApp: true,
    backendConfigured: Boolean(backend?.terminalBase),
    canProbeBackend: canProbe,
    backendReachable: canProbe ? false : null,
    hasThisSession: canProbe ? false : null,
    terminalBase: backend?.terminalBase ?? null,
    embedOnBoard: false,
    history: null,
  };

  // Read history before anything else, and independently of the server: it is
  // board data, so it survives the terminal being stopped and the machine being
  // shut. It is the one useful thing to show a viewer who has no server at all,
  // which is the whole point of keeping it on the board.
  const embed = await findEmbedByEmbedId(embedId);
  state.embedOnBoard = Boolean(embed);
  if (embed) {
    try {
      const history = await embed.getMetadata?.<TerminalHistory>(HISTORY_METADATA_KEY);
      if (history?.lines) state.history = history;
    } catch {
      // No history written yet.
    }
  }

  if (!backend?.terminalBase) return state;

  // Served publicly there is nothing to probe with. The modal and the relay are
  // on the machine that owns the server, so they find out for themselves and
  // report accurately; guessing from here would only produce a confident wrong
  // answer.
  if (!canProbe) return state;

  try {
    const health = await fetchWithTimeout(`${backend.terminalBase}/health`);
    state.backendReachable = health.ok;
  } catch {
    return state; // nothing else is knowable if the server is not answering
  }

  const sid = embed ? sidFromEmbedUrl(embed) : null;
  if (!sid) return state;

  try {
    const res = await fetchWithTimeout(
      `${backend.terminalBase}/api/pty/${encodeURIComponent(sid)}`
    );
    if (res.ok) {
      const body = (await res.json()) as { exists?: boolean };
      state.hasThisSession = Boolean(body.exists);
    }
  } catch {
    // Reachable but this probe failed — leave hasThisSession false.
  }
  return state;
}

/**
 * Opens the real terminal for the developer.
 *
 * Hands over the sid and nothing else. This used to POST /api/pty/start first,
 * to mint a fresh token — the one in the embed's URL expires (TOKEN_TTL) while
 * the board URL does not. But that fetch cannot happen from here any more, and
 * it never needed to: the modal is served BY the terminal server, and its own
 * startSession already mints a fresh token for whatever sid it is given. Doing
 * it there is both the only place it works and one less place a token exists.
 *
 * The embedId matters: it is the key terminal.html looks board context up
 * under, so without it the [INPUT] / [LABEL] / [LINK_x] tokens silently stop
 * expanding — it logs "No embedId" and carries on. It also keys per-terminal
 * local state, so passing it keeps this modal continuous with the same terminal
 * opened any other way.
 */
async function openDeveloperModal(embedId: string): Promise<void> {
  const backend = getBackendConfig();
  if (!backend?.terminalBase) throw new Error('No backend configured in this browser.');

  const embed = await findEmbedByEmbedId(embedId);
  if (!embed) throw new Error('That terminal embed is not on this board.');
  const sid = sidFromEmbedUrl(embed);
  if (!sid) throw new Error('That embed has no session id in its URL.');

  const modalUrl = new URL(`${backend.terminalBase}/terminal.html`);
  modalUrl.searchParams.set('sid', sid);
  modalUrl.searchParams.set('embedId', embedId);
  // Where to send board work: the modal's own SDK never connects, being on a
  // foreign origin, so it asks this iframe instead.
  modalUrl.searchParams.set('appOrigins', window.location.origin);

  await miro.board.ui.openModal({
    url: modalUrl.toString(),
    fullscreen: true,
  });
}

/** The spawner is served BY the terminal server, so /api/browse and
 * /api/pty/start are same-origin calls from there — which is the whole point,
 * since nothing on the app's own origin can reach localhost. */
export async function openSpawnerPanel(): Promise<void> {
  const backend = getBackendConfig();
  if (!backend?.terminalBase) throw new Error('No backend configured in this browser.');
  const url = new URL(`${backend.terminalBase}/spawner.html`);
  url.searchParams.set('appOrigins', window.location.origin);
  await miro.board.ui.openPanel({ url: url.toString() });
}

/** Back to the app's own panel, which owns the backend URL — it has to live on
 * the app origin, because that is the origin whose localStorage is read when
 * building spawner and modal URLs. */
async function openSettingsPanel(): Promise<void> {
  await miro.board.ui.openPanel({ url: 'app.html' });
}

function reply(event: MessageEvent, payload: Record<string, unknown>): void {
  const target = event.origin === OPAQUE_ORIGIN ? '*' : event.origin;
  (event.source as Window | null)?.postMessage(payload, { targetOrigin: target });
}

const HANDLED = [
  MSG.hello,
  MSG.openDev,
  MSG.ctxRequest,
  MSG.historyWrite,
  MSG.spawn,
  MSG.openSpawner,
  MSG.openSettings,
] as string[];

/** Requests that are about a surface rather than a specific embed, so they
 * carry no embedId. */
const EMBEDLESS = [MSG.spawn, MSG.openSpawner, MSG.openSettings] as string[];

async function handle(event: MessageEvent): Promise<void> {
  const data = event.data as BridgeRequest | null;
  if (!data || typeof data !== 'object') return;
  if (!data.type || !HANDLED.includes(data.type)) return;
  if (event.origin !== OPAQUE_ORIGIN && !allowedOrigins().includes(event.origin)) {
    console.warn('[bridge] ignoring message from unexpected origin', event.origin);
    return;
  }
  // Panel plumbing and spawning are not about an existing embed.
  if (EMBEDLESS.includes(data.type)) {
    try {
      if (data.type === MSG.openSpawner) {
        await openSpawnerPanel();
      } else if (data.type === MSG.openSettings) {
        await openSettingsPanel();
      } else {
        const backend = getBackendConfig();
        if (!backend?.terminalBase) throw new Error('No backend configured in this browser.');
        if (!data.ptyUrl) throw new Error('Spawn request carried no session URL.');
        // The spawner already started the session on its own origin; this side
        // only does the board half, which is the half it cannot do.
        const placed = await placeTerminalEmbed(backend.terminalBase, WRAPPER_URL, data.ptyUrl, {
          sessionName: data.sessionName,
          cwd: data.cwd,
        });
        reply(event, { type: MSG.spawned, v: 1, ok: true, ...placed });
        return;
      }
      reply(event, { type: MSG.spawned, v: 1, ok: true });
    } catch (error) {
      reply(event, {
        type: MSG.spawned,
        v: 1,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  const embedId = data.embedId;
  if (!embedId) return;

  if (data.type === MSG.hello) {
    const state = await collectState(embedId);
    reply(event, { type: MSG.state, v: 1, embedId, ...state });
    return;
  }

  // The modal asking for board context, because it cannot read the board
  // itself (foreign origin, SDK never connects).
  if (data.type === MSG.ctxRequest) {
    const embed = await findEmbedByEmbedId(embedId);
    if (!embed) {
      reply(event, { type: MSG.ctx, v: 1, embedId, input: '', named: {}, viewport: null });
      return;
    }
    const ctx = await readConnectedContext(embed);
    reply(event, { type: MSG.ctx, v: 1, embedId, ...ctx });
    return;
  }

  // The modal handing over a history snapshot to be written to board metadata.
  if (data.type === MSG.historyWrite) {
    const embed = await findEmbedByEmbedId(embedId);
    if (!embed || !data.history) {
      reply(event, { type: MSG.historyOk, v: 1, embedId, ok: false });
      return;
    }
    let by = data.history.by ?? null;
    if (!by) {
      try {
        const user = (await miro.board.getUserInfo()) as unknown as { name?: string; id?: string };
        by = user?.name ?? user?.id ?? null;
      } catch {
        /* identity scope may not be granted */
      }
    }
    await (embed as unknown as {
      setMetadata: (k: string, v: unknown) => Promise<void>;
    }).setMetadata(HISTORY_METADATA_KEY, { ...data.history, by });
    reply(event, { type: MSG.historyOk, v: 1, embedId, ok: true });
    // Nudge the embed so it picks this up without the board being reloaded.
    // Pushed rather than polled: the wrapper has no way to know a write
    // happened, and polling every embed's metadata on a timer to find out
    // would be wasteful for an event we already know about here.
    broadcast({ type: MSG.historyChanged, v: 1, embedId });
    return;
  }

  try {
    await openDeveloperModal(embedId);
    reply(event, { type: MSG.opened, v: 1, embedId });
  } catch (error) {
    reply(event, {
      type: MSG.error,
      v: 1,
      embedId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Posts a message to every frame on the page, at each allowed origin. Used
 * for the unsolicited hello and for history-changed nudges — neither has a
 * known recipient window, so both have to go wide. An embed's own retry loop
 * remains the path that has to work regardless. (This used to add that a
 * sandboxed embed can never be reached with an exact targetOrigin. Measured
 * false on 18 Sep 2026: the embed is not opaque-origin.) */
function broadcast(message: Record<string, unknown>): void {
  const targets: Window[] = [];
  const collect = (win: Window, depth: number): void => {
    if (depth > 8 || targets.length > 200) return;
    if (win !== window) targets.push(win);
    let n = 0;
    try {
      n = win.length;
    } catch {
      return;
    }
    for (let i = 0; i < n; i++) {
      try {
        collect(win[i] as Window, depth + 1);
      } catch {
        /* cross-origin child we cannot descend into */
      }
    }
  };
  try {
    collect(window.top ?? window.parent, 0);
  } catch {
    return;
  }
  for (const win of targets) {
    for (const origin of allowedOrigins()) {
      try {
        win.postMessage(message, origin);
      } catch {
        /* ignore */
      }
    }
  }
}

export function initHostBridge(): void {
  window.addEventListener('message', (event) => {
    handle(event).catch((err) => console.error('[bridge] handler error:', err));
  });
  broadcast({ type: MSG.appReady, v: 1 });
  console.log('[bridge] listening at', window.location.origin);
}
