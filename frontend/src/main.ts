/** Headless entry point. Runs on the board, keeps running if the panel is closed. */

import { initTerminalContextSync } from './terminalEmbed';
import { initHostBridge, openSpawnerPanel } from './hostBridge';
import { getBackendConfig, canReachLoopback } from './backendConfig';

async function init(): Promise<void> {
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

  // The HTTP context relay pushes board content to the terminal server over
  // fetch, so it can only run when this iframe is itself on a loopback origin —
  // i.e. the solo local-dev setup. Served publicly it would be a stream of
  // blocked public-to-loopback requests, which is exactly what it was before
  // this guard existed.
  //
  // Nothing is lost by skipping it: the terminal gets its board context by
  // asking this iframe over postMessage instead (mt:ctx-request in
  // hostBridge.ts), which needs no network at all.
  if (canReachLoopback()) {
    initTerminalContextSync().catch(console.error);
  } else {
    console.log('[Terminal] public origin — board context is served over postMessage, not HTTP');
  }

  // Answers the public embed wrapper over postMessage: reports whether this
  // browser can reach the terminal server, and opens the developer modal on
  // request. See hostBridge.ts for why the embed cannot answer this itself.
  initHostBridge();
}

init().catch(console.error);
