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
  error: 'mt:error',
  appReady: 'mt:app-ready',
} as const;

interface BridgeRequest {
  type?: string;
  v?: number;
  embedId?: string;
}

interface EmbedWidget {
  id: string;
  type: string;
  url?: string;
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

export interface BridgeState {
  hasApp: true;
  backendConfigured: boolean;
  backendReachable: boolean;
  hasThisSession: boolean;
  terminalBase: string | null;
  embedOnBoard: boolean;
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
  };
  if (!backend?.terminalBase) return state;

  try {
    const health = await fetchWithTimeout(`${backend.terminalBase}/health`);
    state.backendReachable = health.ok;
  } catch {
    return state; // nothing else is knowable if the server is not answering
  }

  const embed = await findEmbedByEmbedId(embedId);
  state.embedOnBoard = Boolean(embed);
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

  await miro.board.ui.openModal({
    url: `${backend.terminalBase}${url}`,
    fullscreen: true,
  });
}

function reply(event: MessageEvent, payload: Record<string, unknown>): void {
  const target = event.origin === OPAQUE_ORIGIN ? '*' : event.origin;
  (event.source as Window | null)?.postMessage(payload, { targetOrigin: target });
}

async function handle(event: MessageEvent): Promise<void> {
  const data = event.data as BridgeRequest | null;
  if (!data || typeof data !== 'object') return;
  if (data.type !== MSG.hello && data.type !== MSG.openDev) return;
  if (event.origin !== OPAQUE_ORIGIN && !ALLOWED_EMBED_ORIGINS.includes(event.origin)) {
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

/** Posts an unsolicited hello to every frame, covering the case where this
 * iframe finishes loading after an embed has already stopped asking. Cannot
 * reach a sandboxed embed (an exact targetOrigin never matches "null"), so the
 * embed's own retry loop remains the path that has to work. */
function announce(): void {
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
    for (const origin of ALLOWED_EMBED_ORIGINS) {
      try {
        win.postMessage({ type: MSG.appReady, v: 1 }, origin);
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
  announce();
  console.log('[bridge] listening at', window.location.origin);
}
