/**
 * Settings panel, on the app's own origin.
 *
 * It owns the backend URL and nothing else. Everything that needs to TALK to
 * the terminal server — starting a session, browsing folders — lives in the
 * spawner panel, which the server itself serves (backend/public/spawner.html),
 * because a page on the app's origin cannot reach localhost once the app is
 * publicly hosted.
 *
 * The setting has to live here rather than in the spawner: localStorage does
 * not cross origins, and this is the origin that reads it when building spawner
 * and modal URLs.
 */

import { getBackendConfig, setBackendConfig, clearBackendConfig } from './backendConfig';

const backendUrlEl = document.getElementById('backend-url') as HTMLInputElement | null;
const backendStatusEl = document.getElementById('backend-status') as HTMLParagraphElement | null;
const spawnStatusEl = document.getElementById('spawn-status') as HTMLParagraphElement | null;

function setBackendStatus(text: string, kind: 'ok' | 'error' | '' = ''): void {
  if (!backendStatusEl) return;
  backendStatusEl.textContent = text;
  backendStatusEl.className = kind;
}

function refreshBackendStatus(): void {
  const existing = getBackendConfig();
  // The viewer note is only true for somebody who is NOT running terminals, so
  // it goes once a server is configured.
  document.getElementById('viewer-note')?.toggleAttribute('hidden', Boolean(existing));
  if (existing) {
    if (backendUrlEl) backendUrlEl.value = existing.terminalBase;
    setBackendStatus(`Currently using ${existing.terminalBase}`, 'ok');
  } else {
    if (backendUrlEl) backendUrlEl.value = '';
    setBackendStatus('Not set — only needed if you want to run terminals of your own.', '');
  }
  const configured = Boolean(existing);
  const btn = document.getElementById('open-spawner-btn') as HTMLButtonElement | null;
  if (btn) btn.disabled = !configured;
  if (spawnStatusEl && !configured) {
    spawnStatusEl.textContent = 'Save a backend URL first.';
  }
}

document.getElementById('save-backend-btn')?.addEventListener('click', () => {
  const value = backendUrlEl?.value.trim();
  if (!value) {
    setBackendStatus('Enter a URL first, e.g. https://localhost:3001', 'error');
    return;
  }
  setBackendConfig({ terminalBase: value.replace(/\/$/, '') });
  if (spawnStatusEl) spawnStatusEl.textContent = '';
  refreshBackendStatus();
});

document.getElementById('clear-backend-btn')?.addEventListener('click', () => {
  clearBackendConfig();
  refreshBackendStatus();
});

/**
 * Asks the headless iframe to swap this panel for the spawner.
 *
 * Routed rather than calling openPanel here, because the SDK documents panel
 * opening as belonging to the headless iframe — and a panel asking for its own
 * replacement is exactly the case where that matters. Same frame-walk as the
 * embed uses: `length` and indexed access are on the cross-origin property
 * allowlist, so a window reference is discoverable without one being handed
 * over.
 */
function askHeadless(type: string): void {
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
        /* cross-origin child */
      }
    }
  };
  try {
    collect(window.top ?? window.parent, 0);
  } catch {
    return;
  }
  for (const win of targets) {
    try {
      win.postMessage({ type, v: 1 }, window.location.origin);
    } catch {
      /* not the app's frame */
    }
  }
}

document.getElementById('open-spawner-btn')?.addEventListener('click', () => {
  if (spawnStatusEl) spawnStatusEl.textContent = 'Opening…';
  askHeadless('mt:open-spawner');
});

refreshBackendStatus();
