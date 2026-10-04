/**
 * Minimal asar extractor — dev-only helper, NOT part of the plugin payload.
 *
 * The host plugin imports `@deepseek-ai/dsh-home-paths` and
 * `@deepseek-ai/dsh-tools`, which live inside `app.asar`. Plain Node cannot read
 * through an asar (only Electron patches fs for that), so an integration test
 * of `index.js` needs those packages on a real filesystem. This script pulls
 * selected entries out of the archive so `tests/host-integration.test.mjs` can
 * import the plugin for real.
 *
 * asar layout (verified against this build): the JSON header begins at byte 16
 * and is `UInt32LE(12)` bytes long, so the concatenated file data starts at
 * `16 + UInt32LE(12)`. (`8 + UInt32LE(4)` is the same number here.) Entry
 * `offset` is relative to that data start.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const ASAR = process.argv[2];
const OUT = process.argv[3];
// Each prefix is `strip=want`: `strip` is removed from the archive path and
// `want` is where the remainder lands under the output directory.
const PREFIXES = process.argv.slice(4).map((spec) => {
  const eq = spec.indexOf("=");
  if (eq < 0) return { strip: spec, want: spec };
  return { strip: spec.slice(0, eq), want: spec.slice(eq + 1) };
});

if (!ASAR || !OUT || PREFIXES.length === 0) {
  console.error("usage: node extract-asar.mjs <app.asar> <outDir> [<strip>=<want>]...");
  process.exit(2);
}

const buf = await readFile(ASAR);
const headerJsonSize = buf.readUInt32LE(12);
const header = JSON.parse(buf.subarray(16, 16 + headerJsonSize).toString("utf8"));
const dataStart = 16 + headerJsonSize;

/** Depth-first walk of the asar header tree. */
function* walk(node, prefix = "") {
  for (const [key, value] of Object.entries(node.files ?? {})) {
    const path = prefix ? `${prefix}/${key}` : key;
    if (value.files) yield* walk(value, path);
    else yield { path, ...value };
  }
}

let written = 0;
for (const entry of walk(header)) {
  const hit = PREFIXES.find((p) => entry.path === p.strip || entry.path.startsWith(`${p.strip}/`));
  if (hit === undefined) continue;
  const rel = entry.path.slice(hit.strip.length).replace(/^\//, "");
  const target = join(OUT, hit.want, rel);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, buf.subarray(dataStart + Number(entry.offset), dataStart + Number(entry.offset) + entry.size));
  written += 1;
}
console.log(`extracted ${written} file(s) into ${resolve(OUT)}`);
