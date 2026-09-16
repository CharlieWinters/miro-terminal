/** Headless entry point. Runs on the board, keeps running if the panel is closed. */

import { initTerminalContextSync } from './terminalEmbed';
import { initHostBridge, openSpawnerPanel } from './hostBridge';
import { getBackendConfig } from './backendConfig';

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

  // Resumes the connected-item context relay for every terminal embed
  // already on the board — independent of whether the panel is open. See
  // initTerminalContextSync's doc comment in terminalEmbed.ts.
  initTerminalContextSync().catch(console.error);

  // Answers the public embed wrapper over postMessage: reports whether this
  // browser can reach the terminal server, and opens the developer modal on
  // request. See hostBridge.ts for why the embed cannot answer this itself.
  initHostBridge();
}

init().catch(console.error);
