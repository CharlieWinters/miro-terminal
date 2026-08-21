import { getBackendConfig, setBackendConfig, clearBackendConfig, WRAPPER_URL } from './backendConfig';
import { createTerminalEmbed } from './terminalEmbed';

const backendUrlEl = document.getElementById('backend-url') as HTMLInputElement | null;
const backendStatusEl = document.getElementById('backend-status') as HTMLParagraphElement | null;

function setBackendStatus(text: string, kind: 'ok' | 'error' | '' = ''): void {
  if (!backendStatusEl) return;
  backendStatusEl.textContent = text;
  backendStatusEl.className = kind;
}

function refreshBackendStatus(): void {
  const existing = getBackendConfig();
  if (existing) {
    if (backendUrlEl) backendUrlEl.value = existing.terminalBase;
    setBackendStatus(`Currently using ${existing.terminalBase}`, 'ok');
  } else {
    if (backendUrlEl) backendUrlEl.value = '';
    setBackendStatus('Not set yet — enter your terminal-server URL above and save.', 'error');
  }
}

document.getElementById('save-backend-btn')?.addEventListener('click', () => {
  const value = backendUrlEl?.value.trim();
  if (!value) {
    setBackendStatus('Enter a URL first, e.g. https://localhost:3001', 'error');
    return;
  }
  setBackendConfig({ terminalBase: value.replace(/\/$/, '') });
  refreshBackendStatus();
});

document.getElementById('clear-backend-btn')?.addEventListener('click', () => {
  clearBackendConfig();
  refreshBackendStatus();
});

refreshBackendStatus();

function getConfiguredBackend(): { terminalBase: string } {
  const config = getBackendConfig();
  if (!config) {
    throw new Error('Set your backend URL in the Backend section above first.');
  }
  return config;
}

// ── Working-directory browser ──────────────────────────────────────────
// Backed by the backend's GET /api/browse (scoped to ALLOWED_ROOT) — a
// browser page can never learn a real filesystem path on its own, so this
// has to be a real request to the local backend, not a native file picker.

interface BrowseEntry {
  name: string;
  path: string;
}

interface BrowseResponse {
  root: string;
  path: string;
  parent: string | null;
  entries: BrowseEntry[];
}

const cwdInputEl = document.getElementById('terminal-opt-cwd') as HTMLInputElement | null;
const cwdBrowserEl = document.getElementById('cwd-browser');
const cwdBreadcrumbEl = document.getElementById('cwd-breadcrumb');
const cwdEntriesEl = document.getElementById('cwd-entries');

let currentBrowsePath: string | null = null;

async function loadBrowsePath(path?: string): Promise<void> {
  const backend = getConfiguredBackend();
  const url = new URL(`${backend.terminalBase}/api/browse`);
  if (path) url.searchParams.set('path', path);

  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as { error?: string });
    throw new Error(body.error || `Failed to browse: ${res.status}`);
  }
  renderBrowse((await res.json()) as BrowseResponse);
}

function renderBrowse(data: BrowseResponse): void {
  currentBrowsePath = data.path;
  if (cwdBreadcrumbEl) cwdBreadcrumbEl.textContent = data.path;
  if (!cwdEntriesEl) return;

  cwdEntriesEl.innerHTML = '';

  if (data.parent !== null) {
    cwdEntriesEl.appendChild(makeBrowseRow('.. (up)', () => loadBrowsePath(data.parent ?? undefined)));
  }
  for (const entry of data.entries) {
    cwdEntriesEl.appendChild(makeBrowseRow(entry.name, () => loadBrowsePath(entry.path)));
  }
  if (!data.entries.length) {
    const empty = document.createElement('div');
    empty.className = 'cwd-entry empty';
    empty.textContent = '(no subfolders)';
    cwdEntriesEl.appendChild(empty);
  }
}

function makeBrowseRow(label: string, onClick: () => Promise<void>): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'cwd-entry';
  row.textContent = label;
  row.addEventListener('click', () => {
    onClick().catch(showBrowseError);
  });
  return row;
}

function showBrowseError(error: unknown): void {
  console.error('[Terminal] Browse error:', error);
  if (cwdBreadcrumbEl) {
    cwdBreadcrumbEl.textContent = error instanceof Error ? error.message : 'Failed to browse';
  }
  if (cwdEntriesEl) cwdEntriesEl.innerHTML = '';
}

document.getElementById('browse-cwd-btn')?.addEventListener('click', () => {
  if (!cwdBrowserEl) return;
  const isHidden = cwdBrowserEl.hasAttribute('hidden');
  if (!isHidden) {
    cwdBrowserEl.setAttribute('hidden', '');
    return;
  }
  cwdBrowserEl.removeAttribute('hidden');
  const startPath = cwdInputEl?.value.trim();
  // If whatever's currently typed isn't a real browsable path, fall back to
  // the root (ALLOWED_ROOT) instead of just showing an error immediately.
  loadBrowsePath(startPath || undefined).catch(() => loadBrowsePath().catch(showBrowseError));
});

document.getElementById('cwd-use-btn')?.addEventListener('click', () => {
  if (currentBrowsePath && cwdInputEl) cwdInputEl.value = currentBrowsePath;
  cwdBrowserEl?.setAttribute('hidden', '');
});

document.getElementById('cwd-cancel-btn')?.addEventListener('click', () => {
  cwdBrowserEl?.setAttribute('hidden', '');
});

async function handleCreateTerminal(): Promise<void> {
  const nameEl = document.getElementById('terminal-opt-name') as HTMLInputElement | null;

  try {
    const backend = getConfiguredBackend();
    await createTerminalEmbed(backend, WRAPPER_URL, {
      sessionName: nameEl?.value || undefined,
      cwd: cwdInputEl?.value || undefined,
    });
    await miro.board.notifications.showInfo('Terminal created on board');
  } catch (error) {
    console.error('[Terminal] Failed to create terminal:', error);
    await miro.board.notifications.showError(
      error instanceof Error ? error.message : 'Failed to create terminal'
    );
  }
}

document.getElementById('create-terminal-btn')?.addEventListener('click', () => {
  handleCreateTerminal();
});
