/**
 * Terminal embed creation + connected-doc/viewport context relay.
 *
 * Ported from miro-ide's terminal-embed module, with the module/EventBus
 * plumbing stripped out (this frontend has exactly one job, unlike the
 * multi-module miro-ide app it was extracted from).
 *
 * Supports [INPUT]/[LABEL]/<viewport>/etc. variable expansion in terminal.html for
 * items connected to the terminal embed via connectors — see ARCHITECTURE.md.
 */

import { getBackendConfig, canReachLoopback } from './backendConfig';

/** Metadata key used to tag every terminal embed on the board, so the
 * headless iframe can rediscover them (and resume pushing context for them)
 * on every board load — independent of whichever panel session created them. */
export const METADATA_KEY = 'miro-terminal';

/** Build the URL stored on the Miro embed widget.
 *
 * Two shapes. With no wrapperUrl it points straight at the terminal server —
 * the solo local-dev path, where the embed IS a live terminal because a
 * localhost page framing localhost never crosses an address-space boundary.
 * With a wrapperUrl it points at the public wrapper, which is what every OTHER
 * board viewer loads; that page cannot reach localhost at all (Local Network
 * Access), so it asks the app iframe over postMessage instead. */
export function buildMiroEmbedUrl(
  wrapperUrl: string,
  terminalBase: string,
  terminalUrlFromApi: string,
  extraParams: Record<string, string>
): string {
  if (!wrapperUrl) {
    const u = new URL(terminalBase + terminalUrlFromApi);
    for (const [k, v] of Object.entries(extraParams)) u.searchParams.set(k, v);
    return u.toString();
  }
  const inner = new URL(terminalUrlFromApi, 'http://miro-terminal.invalid');
  const wrapBase = wrapperUrl.endsWith('/') ? wrapperUrl : `${wrapperUrl}/`;
  const wrapper = new URL(wrapBase);
  // Deliberately NOT forwarding `token`, and no longer forwarding
  // `terminalBase` either. The wrapper is a public page whose URL is stored as
  // board content — readable by anyone with board access, and by the REST API —
  // so a PTY token has no business being in it. It also has no use for one:
  // the wrapper never talks to the terminal server. It asks the app iframe,
  // which mints a fresh token at the moment the modal opens (see
  // hostBridge.ts — the board URL outlives TOKEN_TTL, a token does not).
  inner.searchParams.forEach((v, k) => {
    if (k === 'token') return;
    wrapper.searchParams.set(k, v);
  });
  for (const [k, v] of Object.entries(extraParams)) wrapper.searchParams.set(k, v);
  return wrapper.toString();
}

/** input: joined text for the [INPUT] token (unlabelled connectors only).
 * named: per-item bracket-token replacements, e.g. typing [FRONTEND_PROMPT]
 * or [LINK_1] in the terminal — see ARCHITECTURE.md for the labelling rule. */
interface ConnectedContext {
  input: string;
  named: Record<string, string>;
  boardName: string;
  boardUrl: string;
}

/** Map of embedId → Miro widget ID for looking up which embed sent a message */
const embedIdToWidgetId = new Map<string, string>();

let contextRequestPollInterval: ReturnType<typeof setInterval> | null = null;
const CONTEXT_REQUEST_POLL_MS = 2_000;

/** Board identity does not change for the life of this frame, and it was being
 * re-fetched once per embed per refresh. The SDK bills per call against an
 * hourly credit budget, so a constant read in a loop is worth caching. */
let boardInfoCache: { id: string } | null = null;
async function getBoardInfoCached(): Promise<{ id: string }> {
  if (!boardInfoCache) boardInfoCache = (await miro.board.getInfo()) as { id: string };
  return boardInfoCache;
}

/** One entry per connector attached to the embed, carrying that connector's
 * own caption (the label lives on the line, not the sticky — so the sticky's
 * content stays exactly what it is, never a "LABEL: " prefix to strip). */
interface Connection {
  itemId: string;
  label: string | null;
}

async function getConnectedItems(widgetId: string): Promise<Connection[]> {
  const embedItems = await miro.board.get({ id: widgetId });
  if (!embedItems.length) return [];

  const embedWidget = embedItems[0] as { id: string; type: string; connectorIds?: string[] };
  const connectorIds = embedWidget.connectorIds || [];
  if (!connectorIds.length) return [];

  const connectorItems = await miro.board.get({ id: connectorIds });
  const connectors = connectorItems as Array<{
    start?: { item?: string };
    end?: { item?: string };
    captions?: Array<{ content?: string }>;
  }>;

  const connections: Connection[] = [];
  for (const connector of connectors) {
    const startItem = connector.start?.item;
    const endItem = connector.end?.item;
    const otherItemId = startItem === widgetId ? endItem : endItem === widgetId ? startItem : undefined;
    if (!otherItemId) continue;

    // Captions come back HTML-wrapped (e.g. "<p>STRING</p>"), same as sticky
    // content — strip it or the label never matches what you typed on the line.
    const rawLabel = stripHtml(connector.captions?.[0]?.content ?? '');
    connections.push({ itemId: otherItemId, label: rawLabel.length ? rawLabel : null });
  }
  return connections;
}

function buildItemLink(boardId: string, itemId: string): string {
  const params = new URLSearchParams({ moveToWidget: itemId, cot: '14' });
  return `https://miro.com/app/board/${boardId}/?${params.toString()}`;
}

/** A connector with a caption makes the item it connects individually
 * addressable as [CAPTION] — e.g. label the line "FRONTEND_PROMPT" and type
 * [FRONTEND_PROMPT] in the terminal to get that sticky's content. A caption
 * starting with "link" (case-insensitive, e.g. LINK_1) resolves to the item's
 * board link instead of its content — an explicit per-connector opt-in, since
 * connector order isn't a reliable way to auto-number links. Connectors with
 * no caption still feed the flat [INPUT] token, as content if readable or
 * as a link if not (documents/images/etc. — the Web SDK returns type
 * "unsupported" for those, so there's never content to read). */
const LINK_LABEL_PATTERN = /^link/i;

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
}

/** Only sticky_note/text/shape items expose readable text via the Web SDK. */
function getReadableText(item: { type: string; content?: string }): string | null {
  if (
    (item.type === 'sticky_note' || item.type === 'text' || item.type === 'shape') &&
    typeof item.content === 'string'
  ) {
    const text = stripHtml(item.content);
    return text.length ? text : null;
  }
  return null;
}

async function fetchConnectedContext(widgetId: string): Promise<ConnectedContext> {
  const [connections, boardInfo] = await Promise.all([
    getConnectedItems(widgetId),
    getBoardInfoCached(),
  ]);
  const boardId = boardInfo.id;

  const items = connections.length
    ? await miro.board.get({ id: connections.map((c) => c.itemId) })
    : [];
  const itemById = new Map(
    (items as Array<{ id: string; type: string; content?: string }>).map((item) => [item.id, item])
  );

  const inputParts: string[] = [];
  const named: Record<string, string> = {};

  for (const { itemId, label } of connections) {
    const item = itemById.get(itemId);
    if (!item) continue;

    const link = buildItemLink(boardId, itemId);
    const text = getReadableText(item);

    if (label) {
      named[label] = LINK_LABEL_PATTERN.test(label) ? link : text ?? link;
    } else {
      inputParts.push(text ?? link);
    }
  }

  const boardName = (boardInfo as { id: string; title?: string }).title || boardId;
  return {
    input: inputParts.join('\n'),
    named,
    boardName,
    boardUrl: `https://miro.com/app/board/${boardId}/`,
  };
}

/** The terminal iframe and this panel/headless app live in separate Miro
 * iframes, so postMessage between them doesn't work — the terminal-server
 * relays connected-doc context over HTTP instead. */
async function pushContextToServer(terminalBase: string, embedId: string, widgetId: string): Promise<void> {
  try {
    const [context, viewport] = await Promise.all([
      fetchConnectedContext(widgetId),
      miro.board.viewport.get(),
    ]);
    await fetch(`${terminalBase}/api/context/${encodeURIComponent(embedId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: context.input,
        named: context.named,
        viewport,
        boardName: context.boardName,
        boardUrl: context.boardUrl,
      }),
    });
  } catch (error) {
    console.error('[Terminal] Error pushing context to server:', error);
  }
}

async function pollContextRequests(terminalBase: string): Promise<void> {
  try {
    const res = await fetch(`${terminalBase}/api/context/requests`);
    if (!res.ok) return;
    const { embedIds } = (await res.json()) as { embedIds: string[] };
    if (!embedIds || embedIds.length === 0) return; // nobody asked: no SDK calls at all
    // An id we have never seen means the map is stale — an embed created in
    // another session, or by a panel that has since closed. Rediscover once per
    // tick at most, and only when something actually needs it.
    let rediscovered = false;
    for (const embId of embedIds) {
      let widId = embedIdToWidgetId.get(embId);
      if (!widId && !rediscovered) {
        await discoverTerminalEmbeds();
        rediscovered = true;
        widId = embedIdToWidgetId.get(embId);
      }
      if (widId) await pushContextToServer(terminalBase, embId, widId);
    }
  } catch (err) {
    console.error('[Terminal] Context request poll error:', err);
  }
}

/** Finds every terminal embed on the board (tagged with METADATA_KEY at
 * creation) and registers it in embedIdToWidgetId — lets a *different* app
 * instance than the one that created an embed (e.g. the headless iframe,
 * after the panel that created it has since closed) resume pushing context
 * for it. Safe to call repeatedly; it only ever adds entries. */
async function discoverTerminalEmbeds(): Promise<void> {
  const embeds = await miro.board.get({ type: 'embed' });
  for (const embed of embeds) {
    try {
      const meta = await embed.getMetadata<{ embedId?: string }>(METADATA_KEY);
      if (meta?.embedId) embedIdToWidgetId.set(meta.embedId, embed.id);
    } catch {
      // Not one of ours — no metadata under this key.
    }
  }
}

export function stopContextRefresh(): void {
  if (contextRequestPollInterval !== null) {
    clearInterval(contextRequestPollInterval);
    contextRequestPollInterval = null;
  }
}

/** Reads the backend URL fresh on every tick (not captured once at start) so
 * a change made in the panel's Backend settings takes effect without needing
 * this loop restarted. */
function startContextRefresh(): void {
  stopContextRefresh();
  // There used to be a second timer here that rebuilt and pushed context for
  // every embed every 10 seconds, whether or not anything wanted it. With four
  // terminals on a board that was roughly 9,000 SDK calls an hour per open tab,
  // which is what exhausted the hourly credit budget. It was also redundant:
  // the poll below already pushes context, for exactly the embeds that asked,
  // and it asks the terminal server over plain HTTP rather than the SDK.
  contextRequestPollInterval = setInterval(() => {
    const backend = getBackendConfig();
    if (backend) pollContextRequests(backend.terminalBase);
  }, CONTEXT_REQUEST_POLL_MS);
}

/** Call once from the headless iframe on board load — resumes context
 * pushing for every terminal embed already on the board (created in this
 * session, a previous one, or from a since-closed panel), independent of
 * whether the panel is open. No-ops quietly if this browser has no backend
 * configured yet. */
export async function initTerminalContextSync(): Promise<void> {
  // Guarded here as well as at the call site. The two remaining fetches in this
  // file are the only ones left that address the terminal server, and from a
  // public origin they are blocked — so this refuses rather than relying on
  // every future caller remembering.
  if (!canReachLoopback()) {
    console.log('[Terminal] context relay skipped: this origin cannot reach loopback');
    return;
  }
  const backend = getBackendConfig();
  if (!backend) return;
  // Seed the id map, but do not push for everything: a terminal that wants
  // context asks for it, and the poll answers within a couple of seconds.
  await discoverTerminalEmbeds();
  startContextRefresh();
}

/**
 * The embed's own id, which ends up in its URL and therefore in board content.
 *
 * crypto.randomUUID rather than Date.now plus Math.random. Math.random is not a
 * CSPRNG and the timestamp half is guessable outright, so the old id was
 * predictable to anyone who knew roughly when a terminal was created. It no
 * longer gates anything on its own — keystrokes are authorised by a nonce the
 * relay issues, and PTY tokens never reach a public page — but an identifier
 * that travels in shared board content should not be guessable, and there is no
 * reason to accept a weak one when a strong one is a function call away.
 */
function generateEmbedId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Secure contexts always have randomUUID; this is for the impossible case.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface TerminalEmbedOptions {
  sessionName?: string;
  cwd?: string;
}

/**
 * Places a terminal embed on the board for an ALREADY-STARTED pty session.
 *
 * Split out from createTerminalEmbed because the two halves of that job can no
 * longer run in the same place. Starting a session is a call to localhost, so
 * it has to happen on a surface served from the developer's machine; creating
 * the widget needs a connected Web SDK, which a foreign-origin surface never
 * gets. So the spawner (localhost) starts the session and hands the result
 * here, to the app iframe, which puts it on the board.
 */
export async function placeTerminalEmbed(
  terminalBase: string,
  wrapperUrl: string,
  ptyUrl: string,
  embedOptions?: TerminalEmbedOptions
): Promise<{ embedId: string; widgetId: string }> {
  const boardInfo = await miro.board.getInfo();
  const boardId = boardInfo.id;
  const boardName = (boardInfo as { id: string; title?: string }).title || boardId;

  const embedId = generateEmbedId();
  // No appOrigins here any more. It went into the embed URL, which is board
  // content, and the wrapper now ignores it for exactly that reason: the app is
  // published to the same origin as the wrapper, so naming it achieved nothing
  // except putting a security-relevant allowlist somewhere editable.
  const extraParams: Record<string, string> = {
    embedId,
    boardId,
    boardName,
  };
  if (embedOptions?.sessionName) extraParams.name = embedOptions.sessionName;
  if (embedOptions?.cwd) extraParams.cwd = embedOptions.cwd;

  const fullUrl = buildMiroEmbedUrl(wrapperUrl, terminalBase, ptyUrl, extraParams);

  const viewport = await miro.board.viewport.get();
  const embed = await miro.board.createEmbed({
    url: fullUrl,
    x: viewport.x + viewport.width / 2,
    y: viewport.y + viewport.height / 2,
    origin: 'center',
    width: 800,
    height: 600,
  });
  embedIdToWidgetId.set(embedId, embed.id);
  await embed.setMetadata(METADATA_KEY, { embedId });
  await miro.board.viewport.zoomTo(embed);
  return { embedId, widgetId: embed.id };
}

/* createTerminalEmbed and startTerminalSession used to live here. They started
 * a pty session over fetch and placed the embed in one call.
 *
 * Both halves can no longer happen in one place: starting a session is a call
 * to localhost, which only a surface served by the terminal server may make,
 * while placing an embed needs a connected Web SDK, which such a surface never
 * gets. So the spawner does the first and placeTerminalEmbed the second, and
 * they talk over postMessage.
 *
 * Deleted rather than left unused. Dead code that fetches localhost is exactly
 * what turned into a live bug three times while this app was moving origin.
 */
