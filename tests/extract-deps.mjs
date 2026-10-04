/**
 * Dev-only: extract a curated subset of `app.asar`'s node_modules so the host
 * half of this plugin can be imported for real in a test.
 *
 * Plain Node cannot read through an asar (only Electron patches `fs`), so
 * `import "../index.js"` fails on `@deepseek-ai/dsh-home-paths` without this.
 * Nothing here ships in the plugin tarball.
 *
 * Usage:
 *   node tests/extract-deps.mjs <app.asar> <outDir> [--max-mb N]
 *
 * Extracts every `**\/node_modules/**` package whose extracted size is at or
 * below the cap, mapped to a flat `<outDir>/node_modules/<name>`. The archive
 * has TWO package trees (`dsh/node_modules` for the host, `node_modules` for
 * the Electron shell) and both are needed, so the prefix is not hard-coded. The
 * cap keeps the 186 MB `libreoffice-kit-win32-x64` and the multi-MB browser
 * bundles out.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const [, , ASAR, OUT, ...rest] = process.argv;
const capIdx = rest.indexOf("--max-mb");
const MAX_BYTES = (capIdx >= 0 ? Number(rest[capIdx + 1]) : 4) * 1024 * 1024;

if (!ASAR || !OUT) {
  console.error("usage: node tests/extract-deps.mjs <app.asar> <outDir> [--max-mb N]");
  process.exit(2);
}

const buf = await readFile(ASAR);
const headerJsonSize = buf.readUInt32LE(12);
const header = JSON.parse(buf.subarray(16, 16 + headerJsonSize).toString("utf8"));
const dataStart = 16 + headerJsonSize;

function* walk(node, prefix = "") {
  for (const [key, value] of Object.entries(node.files ?? {})) {
    const path = prefix ? `${prefix}/${key}` : key;
    if (value.files) yield* walk(value, path);
    else yield { path, size: value.size, offset: Number(value.offset) };
  }
}

// Group every file under any `<...>/node_modules/<pkg>/`, keyed by package name.
// Both trees are walked. Where a package exists in both, the host tree
// (`dsh/node_modules/...`) wins: it is the resolution root the plugin actually
// runs under, and the shell tree is only a fallback for shared vendor deps.
const PKG_RE = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\/(.+)$/;
const groups = new Map();
for (const entry of walk(header)) {
  const m = PKG_RE.exec(entry.path);
  if (m === null) continue;
  const [, pkg, rel] = m;
  const hostTree = entry.path.startsWith("dsh/node_modules/");
  const list = groups.get(pkg) ?? new Map();
  const seen = list.get(rel);
  if (seen === undefined || (hostTree && !seen.hostTree)) list.set(rel, { entry, hostTree });
  groups.set(pkg, list);
}

let packages = 0;
let files = 0;
for (const [pkg, entries] of groups) {
  const total = [...entries.values()].reduce((sum, v) => sum + v.entry.size, 0);
  if (total > MAX_BYTES) continue;
  for (const [rel, { entry }] of entries) {
    const target = join(OUT, "node_modules", pkg, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, buf.subarray(dataStart + entry.offset, dataStart + entry.offset + entry.size));
    files += 1;
  }
  packages += 1;
}
console.log(`extracted ${packages} package(s), ${files} file(s) into ${resolve(OUT)}`);
