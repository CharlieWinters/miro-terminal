/**
 * Per-person backend config, stored in this browser's localStorage — not board
 * appData. Different people collaborating on the same board each run their own
 * local terminal-server, so a board-level setting would wrongly force everyone
 * onto one person's machine. Mirrors fal-miro's `fal:backendConfig` pattern.
 */

const STORAGE_KEY = 'miro-terminal:backendConfig';

export interface BackendConfig {
  /** Base URL of the terminal-server running on THIS person's machine, e.g. https://localhost:3001 */
  terminalBase: string;
}

/**
 * Can code running on THIS origin reach a loopback address?
 *
 * Only a loopback origin can. From anywhere else Chrome's Local Network Access
 * blocks the request before it is even a CORS question — "Permission was denied
 * for this request to access the loopback address space".
 *
 * This matters because the app is now served publicly. Every fetch at the
 * terminal server from an app surface has to be behind this, or it becomes a
 * stream of blocked requests. It is also the difference between knowing the
 * server is down and merely being unable to look, which are not the same thing
 * and must not be reported as if they were.
 */
export function canReachLoopback(): boolean {
  const host = window.location.hostname;
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host === '::1' ||
    host.endsWith('.localhost')
  );
}

export function getBackendConfig(): BackendConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.terminalBase === 'string' && parsed.terminalBase) {
      return { terminalBase: parsed.terminalBase.replace(/\/$/, '') };
    }
    return null;
  } catch {
    return null;
  }
}

export function setBackendConfig(config: BackendConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export function clearBackendConfig(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/**
 * The public wrapper page every board viewer loads inside a terminal embed.
 *
 * DERIVED rather than hardcoded, so a fork works without editing this file.
 * The published layout puts the app at `<base>/app/index.html` and the wrapper
 * at `<base>/terminal-wrapper/`; the dev server serves `/index.html` and
 * `/terminal-wrapper/`. Both are reachable from wherever this page is, so the
 * host name never has to be written down.
 *
 * Override with VITE_WRAPPER_URL if you host the two somewhere unrelated.
 */
function deriveWrapperUrl(): string {
  const override = (import.meta as { env?: Record<string, string> }).env?.VITE_WRAPPER_URL;
  if (override) return override.replace(/\/?$/, '/');
  const here = new URL('.', window.location.href);
  const base = here.pathname.endsWith('/app/') ? new URL('../', here) : here;
  return new URL('terminal-wrapper/', base).toString();
}

export const WRAPPER_URL = deriveWrapperUrl();
