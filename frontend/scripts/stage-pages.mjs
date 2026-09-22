/**
 * Assembles everything GitHub Pages should serve into one directory.
 *
 * Deliberately ONE directory published by ONE gh-pages call. Publishing the app
 * and the wrapper as two calls raced: gh-pages clones the branch, commits and
 * pushes, so the second clone could start before the first push landed and its
 * commit would quietly revert the other's files. Both runs printed "Published"
 * and the live bundle stayed stale through several rounds of verification —
 * which is the worst shape a deploy bug can take.
 *
 * One call also means no --add, so the branch ends up containing exactly what
 * is here and nothing else. Earlier attempts left an index.html, app.html and
 * assets/ stranded at the branch root; those go away.
 */
import { cp, mkdir, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const OUT = '.pages';

await rm(OUT, { recursive: true, force: true });
await mkdir(`${OUT}/app`, { recursive: true });
await mkdir(`${OUT}/terminal-wrapper`, { recursive: true });

// The built app: headless iframe and settings panel, on the public origin.
await cp('dist', `${OUT}/app`, { recursive: true });

// The wrapper: what every board viewer loads inside a terminal embed.
await cp('terminal-wrapper', `${OUT}/terminal-wrapper`, { recursive: true });

// The terminal UI, whose only source is backend/public — it is served both by
// the terminal server (as the modal) and from here (as a live embed).
for (const file of ['terminal.html', 'styles.css']) {
  const from = `../backend/public/${file}`;
  if (!existsSync(from)) throw new Error(`missing ${from}`);
  await cp(from, `${OUT}/terminal-wrapper/${file}`);
}

// App icons. These have to be here even though one of the two apps is served
// from localhost: Miro renders the toolbar on its own origin, so it fetches the
// icon from there, and a public page may not read a loopback address. An icon
// hosted next to the relay would simply never load.
await cp('../icons', `${OUT}/icons`, { recursive: true });

const app = await readdir(`${OUT}/app`);
const wrapper = await readdir(`${OUT}/terminal-wrapper`);
console.log(`staged ${OUT}/`);
console.log(`  app/             ${app.join(', ')}`);
console.log(`  terminal-wrapper/ ${wrapper.join(', ')}`);
console.log(`  icons/           ${(await readdir(`${OUT}/icons`)).join(', ')}`);
