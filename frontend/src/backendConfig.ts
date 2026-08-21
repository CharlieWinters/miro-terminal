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
 * Hosted wrapper page (see ../terminal-wrapper/) that health-checks this
 * person's terminalBase and either iframes the live terminal or shows an
 * informational fallback to everyone else on the board. Empty until deployed
 * (see README "Deploy your own backend" / "Turn on the shared wrapper").
 */
export const WRAPPER_URL = '';
