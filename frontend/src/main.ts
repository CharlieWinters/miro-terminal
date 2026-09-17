/** Headless entry point. Runs on the board, keeps running if the panel is closed. */

import { initTerminalContextSync } from './terminalEmbed';
import { initHostBridge, openSpawnerPanel } from './hostBridge';
import { getBackendConfig, canReachLoopback } from './backendConfig';

/**
 * The bridge goes up FIRST, synchronously, before anything is awaited.
 *
 * It used to be the last statement of an async init(), after
 * `await miro.board.ui.on('icon:click', ...)`. That await does not merely take
 * a moment — outside a completed SDK handshake it never settles at all, which
 * is observable by loading this page on its own: the SDK posts its handshake at
 * miro.com, gets no answer, and the function after the await never runs. So the
 * one thing every embed on the board depends on was sequenced behind an
 * unrelated SDK call, and any hesitation in that call presented as "this
 * terminal runs on someone else's computer" on every embed.
 *
 * It needs nothing from the SDK to start listening, so it should not wait for
 * it. The board calls it makes later happen inside message handlers, by which
 * point the SDK has long since connected — and if one fails it fails as one
 * reply, not as the whole bridge.
 */
initHostBridge();

/**
 * The toolbar icon. Registered independently, so failing to register it cannot
 * take the bridge down with it — they have nothing to do with each other beyond
 * living in the same iframe.
 */
async function registerIcon(): Promise<void> {
  await miro.board.ui.on('icon:click', async () => {
    // Straight to the spawner when this browser already knows where its
    // terminal server is — that is the thing people click the icon to do. The
    // settings panel is only the first-run stop, and the spawner has a way
    // back to it.
    if (getBackendConfig()?.terminalBase) {
      try {
        await openSpawnerPanel();
        return;
      } catch (error) {
        console.warn('[Terminal] spawner would not open, falling back to settings:', error);
      }
    }
    await miro.board.ui.openPanel({ url: 'app.html' });
  });
}

/**
 * The HTTP context relay pushes board content to the terminal server over
 * fetch, so it can only run when this iframe is itself on a loopback origin —
 * i.e. the solo local-dev setup. Served publicly it would be a stream of
 * blocked public-to-loopback requests.
 *
 * Nothing is lost by skipping it: the terminal gets its board context by asking
 * this iframe over postMessage instead (mt:ctx-request in hostBridge.ts), which
 * needs no network at all.
 */
function startContextRelayIfLocal(): void {
  if (canReachLoopback()) {
    initTerminalContextSync().catch((error) =>
      console.error('[Terminal] context relay failed:', error)
    );
  } else {
    console.log('[Terminal] public origin — board context is served over postMessage, not HTTP');
  }
}

registerIcon().catch((error) => console.error('[Terminal] icon handler failed to register:', error));
startContextRelayIfLocal();
