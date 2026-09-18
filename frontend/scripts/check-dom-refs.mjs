/**
 * Every getElementById in a hand-written page must resolve against that page's
 * own markup.
 *
 * These pages have no build step and no framework, so a lookup for an id that
 * was renamed or removed is only discovered by running it — and it fails in the
 * worst way available: the throw happens at load, before any listener is
 * attached, so every control on the page goes dead at once with a single
 * easily-missed console line. That is exactly how the spawner's three buttons
 * broke, after a footer element lost its id in one edit while the line reading
 * it survived in another.
 */
import { readFileSync } from 'node:fs';

const FILES = [
  '../backend/public/spawner.html',
  '../backend/public/relay.html',
  '../backend/public/terminal.html',
  'terminal-wrapper/index.html',
  'app.html',
  'index.html',
];

let failed = false;

for (const file of FILES) {
  const src = readFileSync(new URL(file, import.meta.url.replace(/scripts\/[^/]+$/, '')), 'utf8');
  const ids = new Set([...src.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...src.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]));
  const missing = [...used].filter((id) => !ids.has(id)).sort();
  if (missing.length) {
    failed = true;
    console.error(`FAIL ${file}: getElementById for ids not in this page: ${missing.join(', ')}`);
  } else {
    console.log(`ok   ${file} (${used.size} lookups)`);
  }
}

if (failed) {
  console.error('\nA lookup that returns null throws at load and kills every listener below it.');
  process.exit(1);
}
