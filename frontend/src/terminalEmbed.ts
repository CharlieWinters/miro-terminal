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

import { getBackendConfig, type BackendConfig } from './backendConfig';

/** Metadata key used to tag every terminal embed on the board, so the
 * headless iframe can rediscover them (and resume pushing context for them)
 * on every board load — independent of whichever panel session created them. */
const METADATA_KEY = 'miro-terminal';

/** Build the URL stored on the Miro embed widget: either the terminal server
 * directly, or the shared wrapper (with terminalBase + session query params)
 * that health-checks this viewer's own machine before deciding what to show. */
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
  wrapper.searchParams.set('terminalBase', terminalBase);
  inner.searchParams.forEach((v, k) => wrapper.searchParams.set(k, v));
  for (const [k, v] of Object.entries(extraParams)) wrapper.searchParams.set(k, v);
  return wrapper.toString();
}

interface PtyStartResponse {
  sid: string;
  url: string;
  wsUrl?: string;
}

/** input: joined text for the [INPUT] token (unlabelled connectors only).
 * named: per-item bracket-token replacements, e.g. typing [FRONTEND_PROMPT]
 * or [LINK_1] in the terminal — see ARCHITECTURE.md for the labelling rule. */
interface ConnectedContext {
  input: string;
  named: Record<string, string>;
}

/** Map of embedId → Miro widget ID for looking up which embed sent a message */
const embedIdToWidgetId = new Map<string, string>();

let contextRefreshInterval: ReturnType<typeof setInterval> | null = null;
const CONTEXT_REFRESH_MS = 10_000;
let contextRequestPollInterval: ReturnType<typeof setInterval> | null = null;
const CONTEXT_REQUEST_POLL_MS = 2_000;

/** Deliberately no `sid` in the request — the backend reuses an existing
 * session when one is passed, which used to mean every terminal on a board
 * shared one PTY (and one cwd) since `sid` used to just be the board id.
 * Each "Create terminal" click should be its own independent shell; the
 * backend mints a fresh sid whenever one isn't supplied. */
async function startTerminalSession(terminalBase: string, cwd?: string): Promise<PtyStartResponse> {
  const response = await fetch(`${terminalBase}/api/pty/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd }),
  });
  if (!response.ok) {
    throw new Error(`Failed to start terminal session: ${response.status} ${await response.text()}`);
  }
  return response.json();
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
    miro.board.getInfo(),
  ]);
  const boardId = (boardInfo as { id: string }).id;

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

  return { input: inputParts.join('\n'), named };
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
      body: JSON.stringify({ input: context.input, named: context.named, viewport }),
    });
  } catch (error) {
    console.error('[Terminal] Error pushing context to server:', error);
  }
}

async function pollContextRequests(terminalBase: string): Promise<void> {
  if (embedIdToWidgetId.size === 0) return;
  try {
    const res = await fetch(`${terminalBase}/api/context/requests`);
    if (!res.ok) return;
    const { embedIds } = (await res.json()) as { embedIds: string[] };
    for (const embId of embedIds || []) {
      const widId = embedIdToWidgetId.get(embId);
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
  if (contextRefreshInterval !== null) {
    clearInterval(contextRefreshInterval);
    contextRefreshInterval = null;
  }
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
  contextRefreshInterval = setInterval(async () => {
    const backend = getBackendConfig();
    if (!backend) return;
    await discoverTerminalEmbeds();
    for (const [embId, widId] of embedIdToWidgetId.entries()) {
      pushContextToServer(backend.terminalBase, embId, widId).catch((err) =>
        console.error('[Terminal] Context refresh error:', err)
      );
    }
  }, CONTEXT_REFRESH_MS);
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
  const backend = getBackendConfig();
  if (!backend) return;
  await discoverTerminalEmbeds();
  for (const [embId, widId] of embedIdToWidgetId.entries()) {
    await pushContextToServer(backend.terminalBase, embId, widId);
  }
  startContextRefresh();
}

function generateEmbedId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 9)}`;
}

export interface TerminalEmbedOptions {
  sessionName?: string;
  cwd?: string;
}

export async function createTerminalEmbed(
  backend: BackendConfig,
  wrapperUrl: string,
  embedOptions?: TerminalEmbedOptions
): Promise<void> {
  const boardInfo = await miro.board.getInfo();
  const boardId = boardInfo.id;
  const boardName = (boardInfo as { id: string; title?: string }).title || boardId;

  const ptyResponse = await startTerminalSession(backend.terminalBase, embedOptions?.cwd);

  const embedId = generateEmbedId();
  const extraParams: Record<string, string> = { embedId, boardId, boardName };
  if (embedOptions?.sessionName) extraParams.name = embedOptions.sessionName;
  if (embedOptions?.cwd) extraParams.cwd = embedOptions.cwd;

  const fullUrl = buildMiroEmbedUrl(wrapperUrl, backend.terminalBase, ptyResponse.url, extraParams);

  // Center of the current viewport, not the board origin — otherwise every
  // terminal piles up at (0, 0) regardless of where you're actually looking.
  const viewport = await miro.board.viewport.get();
  const centerX = viewport.x + viewport.width / 2;
  const centerY = viewport.y + viewport.height / 2;

  const embed = await miro.board.createEmbed({
    url: fullUrl,
    x: centerX,
    y: centerY,
    origin: 'center',
    width: 800,
    height: 600,
  });
  embedIdToWidgetId.set(embedId, embed.id);
  await embed.setMetadata(METADATA_KEY, { embedId });

  await pushContextToServer(backend.terminalBase, embedId, embed.id);
  startContextRefresh();

  await miro.board.viewport.zoomTo(embed);
}
