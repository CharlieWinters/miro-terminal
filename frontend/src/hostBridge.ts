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

import { getBackendConfig } from './backendConfig';
import { METADATA_KEY } from './terminalEmbed';

/** Origins allowed to talk to this bridge. The embed is the Pages one; the
 * localhost entries are for running the wrapper from a dev server. */
const ALLOWED_EMBED_ORIGINS = [
  'https://charliewinters.github.io',
  'http://localhost:5173',
  'https://localhost:5173',
  'http://localhost:4173',
];

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
 * Allowed through, because the embedId check below is what actually
 * authorises — origin is unusable as a check in that case. */
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
  error: 'mt:error',
  appReady: 'mt:app-ready',
} as const;

interface BridgeRequest {
  type?: string;
  v?: number;
  embedId?: string;
  history?: TerminalHistory;
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

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
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
async function findEmbedByEmbedId(embedId: string): Promise<EmbedWidget | null> {
  const embeds = (await miro.board.get({ type: 'embed' })) as unknown as EmbedWidget[];
  for (const embed of embeds) {
    try {
      const meta = await embed.getMetadata?.<{ embedId?: string }>(METADATA_KEY);
      if (meta?.embedId && meta.embedId === embedId) return embed;
    } catch {
      // Not one of ours — no metadata under this key.
    }
  }
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
  backendReachable: boolean;
  hasThisSession: boolean;
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
  const state: BridgeState = {
    hasApp: true,
    backendConfigured: Boolean(backend?.terminalBase),
    backendReachable: false,
    hasThisSession: false,
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
 * Deliberately re-runs /api/pty/start with the existing sid rather than reusing
 * the token sitting in the embed's URL: that token expires (TOKEN_TTL, 15
 * minutes by default) while the board URL does not, so a board opened an hour
 * later would hand the modal a dead token. Passing a known sid reuses the live
 * session and mints a fresh token — and if the session has since timed out, it
 * revives one under the same id, which is the behaviour you want anyway.
 */
async function openDeveloperModal(embedId: string): Promise<void> {
  const backend = getBackendConfig();
  if (!backend?.terminalBase) throw new Error('No backend configured in this browser.');

  const embed = await findEmbedByEmbedId(embedId);
  if (!embed) throw new Error('That terminal embed is not on this board.');
  const sid = sidFromEmbedUrl(embed);
  if (!sid) throw new Error('That embed has no session id in its URL.');

  const res = await fetchWithTimeout(`${backend.terminalBase}/api/pty/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sid }),
  });
  if (!res.ok) {
    throw new Error(`Terminal server refused to start a session: ${res.status}`);
  }
  const { url } = (await res.json()) as { url: string };

  // /api/pty/start returns only sid and token, but terminal.html needs the
  // embedId too: that is the key it looks board context up under, so without it
  // the [INPUT] / [LABEL] / [LINK_x] tokens silently stop expanding (it logs
  // "No embedId - cannot fetch context" and carries on). It also keys its local
  // per-terminal state off embedId, so passing it keeps the modal continuous
  // with the same terminal opened any other way.
  const modalUrl = new URL(`${backend.terminalBase}${url}`);
  modalUrl.searchParams.set('embedId', embedId);
  // Where to send board work. The modal cannot use the SDK from its own
  // origin, so it posts here instead; exact origin, never '*'.
  modalUrl.searchParams.set('appOrigins', window.location.origin);

  await miro.board.ui.openModal({
    url: modalUrl.toString(),
    fullscreen: true,
  });
}

function reply(event: MessageEvent, payload: Record<string, unknown>): void {
  const target = event.origin === OPAQUE_ORIGIN ? '*' : event.origin;
  (event.source as Window | null)?.postMessage(payload, { targetOrigin: target });
}

const HANDLED = [MSG.hello, MSG.openDev, MSG.ctxRequest, MSG.historyWrite] as string[];

async function handle(event: MessageEvent): Promise<void> {
  const data = event.data as BridgeRequest | null;
  if (!data || typeof data !== 'object') return;
  if (!data.type || !HANDLED.includes(data.type)) return;
  if (event.origin !== OPAQUE_ORIGIN && !allowedOrigins().includes(event.origin)) {
    console.warn('[bridge] ignoring message from unexpected origin', event.origin);
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
 * known recipient window, so both have to go wide. Cannot reach a sandboxed
 * embed (an exact targetOrigin never matches "null"), so an embed's own retry
 * loop remains the path that has to work. */
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
