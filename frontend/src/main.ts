/** Headless entry point. Runs on the board, keeps running if the panel is closed. */

import { initTerminalContextSync } from './terminalEmbed';

async function init(): Promise<void> {
  await miro.board.ui.on('icon:click', async () => {
    await miro.board.ui.openPanel({ url: 'app.html' });
  });

  // Resumes the connected-item context relay for every terminal embed
  // already on the board — independent of whether the panel is open. See
  // initTerminalContextSync's doc comment in terminalEmbed.ts.
  initTerminalContextSync().catch(console.error);
}

init().catch(console.error);
