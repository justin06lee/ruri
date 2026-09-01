/**
 * Run the component sweep against a project and print what it would name —
 * without writing a single entry.
 *
 *   bun run sweep-test [path/to/project]
 *
 * Two things worth watching in the output. The names: they should read like
 * something a person would say, and they should be things you could point
 * at. And the selectors: those decide whether the picture pass has anything
 * to photograph, and they have to be classes the source actually sets.
 *
 * With --open it goes on to start the project the way the picture pass does
 * and prints the address it found, then stops it again — which is the other
 * half that can fail on its own.
 */
import * as path from "node:path";
import { sweepCandidates, sweepProject } from "../server/sweep.js";
import { devCommand, withProjectRunning } from "../server/shots.js";

const args = process.argv.slice(2).filter((arg) => arg !== "--open");
const wantOpen = process.argv.includes("--open");
const dir = path.resolve(args[0] ?? ".");
const name = path.basename(dir);

const candidates = sweepCandidates(dir);
console.log(`${name} — ${candidates.length} files worth reading`);
for (const rel of candidates.slice(0, 12)) console.log(`  ${rel}`);
if (candidates.length > 12) console.log(`  … and ${candidates.length - 12} more`);

console.log(`\ndev command: ${JSON.stringify(devCommand(dir)) ?? "none — no pictures for this one"}`);

const started = Date.now();
const { found, read } = await sweepProject({ name, path: dir }, [], (note) =>
  console.log(`  · ${note}`),
);
console.log(`\nread ${read} files in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`found ${found.length}:\n`);
for (const part of found) {
  console.log(`  ${part.name}`);
  console.log(`    files:    ${part.files.join(", ") || "(none)"}`);
  console.log(`    selector: ${part.selector ?? "(none — no picture)"}`);
  if (part.route) console.log(`    route:    ${part.route}`);
  if (part.clicks?.length) console.log(`    clicks:   ${part.clicks.join(" → ")}`);
  console.log(`    note:     ${part.note}`);
}
const withSelector = found.filter((part) => part.selector).length;
console.log(`\n${withSelector} of ${found.length} could be photographed`);

if (wantOpen) {
  console.log("\nstarting it the way the picture pass does…");
  await withProjectRunning(
    dir,
    (note) => console.log(`  · ${note}`),
    async (url) => {
      console.log(`  page at ${url}`);
    },
  );
}
process.exit(0);
