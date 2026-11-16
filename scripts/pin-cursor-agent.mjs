#!/usr/bin/env node
// Pins the cursor-agent package that the cursor-cli Connect methods may install (AD-17, story 27).
//
//   node scripts/pin-cursor-agent.mjs           Reads the current version from Cursor's install script
//                                               (https://cursor.com/install), then for each supported platform
//                                               (linux x64/arm64, darwin x64/arm64) reads the package's `.sha256`
//                                               file and size, downloads the package once to check that hash and
//                                               measure what it unpacks to, and rewrites src/adapters/cursor/install.ts.
//   node scripts/pin-cursor-agent.mjs --check   Compares the pin with Cursor's `.sha256` files. Downloads no package.
//                                               Exits 1 when a pinned `.sha256` file does not answer or no longer
//                                               matches the pin. A newer version in the install script is only reported.
//
// The script reads Cursor's install script as text; it never runs it. Behind a proxy run Node with
// NODE_USE_ENV_PROXY=1. Test hooks: PIN_CURSOR_INSTALL_URL (the install script's address),
// PIN_CURSOR_ORIGIN (fetches go there instead of https://downloads.cursor.com; the pin keeps the real
// origin), PIN_CURSOR_OUT (the file to write instead of install.ts).
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const ORIGIN = "https://downloads.cursor.com";
const INSTALL_URL = process.env.PIN_CURSOR_INSTALL_URL || "https://cursor.com/install";
const FETCH_ORIGIN = process.env.PIN_CURSOR_ORIGIN || ORIGIN;
const OUT = process.env.PIN_CURSOR_OUT || fileURLToPath(new URL("../src/adapters/cursor/install.ts", import.meta.url));
const PLATFORMS = [
  ["linux-x64", "linux/x64"],
  ["linux-arm64", "linux/arm64"],
  ["darwin-x64", "darwin/x64"],
  ["darwin-arm64", "darwin/arm64"],
];
const STRIP_COMPONENTS = 1;
const LAUNCHER = "cursor-agent";
const DOCS_URL = "https://github.com/xtimor/openclaw-all-cli/blob/main/docs/setup.md#install-the-requirements";
/** Measuring limits: far above a real package, only there to stop a runaway stream. */
const MEASURE_LIMITS = { maxBytes: 8 * 1024 * 1024 * 1024, maxEntries: 200_000 };

const packageUrl = (version, path) => `${ORIGIN}/lab/${version}/${path}/agent-cli-package.tar.gz`;
const fetchUrl = (url) => (url.startsWith(ORIGIN) ? FETCH_ORIGIN + url.slice(ORIGIN.length) : url);

async function get(url, init = {}) {
  const response = await fetch(fetchUrl(url), { redirect: "error", ...init });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return response;
}

/** The hex digest of a `<hex>  <file>` line. */
async function readSha256(url) {
  const text = (await (await get(`${url}.sha256`)).text()).trim();
  const match = /^([0-9a-f]{64})\b/i.exec(text);
  if (!match) throw new Error(`${url}.sha256 does not hold a sha256`);
  return match[1].toLowerCase();
}

async function readVersion() {
  const script = await (await get(INSTALL_URL)).text();
  const match = /https:\/\/downloads\.cursor\.com\/lab\/([0-9]{4}\.[0-9]{2}\.[0-9]{2}-[0-9a-f]+)\//.exec(script);
  if (!match) throw new Error(`Could not find the version in ${INSTALL_URL}`);
  return match[1];
}

/** Downloads the package once: its size, sha256, and the bytes it unpacks to (with the plugin's own reader). */
async function measure(url, expectedSha) {
  const { extractTarGz } = await import(pathToFileURL(fileURLToPath(new URL("../src/core/tar.ts", import.meta.url))).href);
  const response = await get(url);
  const hash = createHash("sha256");
  let bytes = 0;
  const counted = Readable.fromWeb(response.body).map((chunk) => {
    bytes += chunk.length;
    hash.update(chunk);
    return chunk;
  });
  const summary = await extractTarGz(counted, { stripComponents: STRIP_COMPONENTS, limits: MEASURE_LIMITS });
  const sha256 = hash.digest("hex");
  if (sha256 !== expectedSha) throw new Error(`${url} has sha256 ${sha256}, but its .sha256 file says ${expectedSha}`);
  return { bytes, unpackedBytes: summary.bytes, entries: summary.entries };
}

function render(version, platforms) {
  const rows = platforms
    .map(
      ([key, pkg]) =>
        `    "${key}": {\n      url: "${pkg.url}",\n      sha256: "${pkg.sha256}",\n      bytes: ${pkg.bytes},\n      unpackedBytes: ${pkg.unpackedBytes},\n    },`,
    )
    .join("\n");
  return `import type { ManagedInstallSpec } from "../../core/ports.ts";

// Written by scripts/pin-cursor-agent.mjs from Cursor's install script and its \`.sha256\` files; rerun it to move the pin.
/**
 * The cursor-agent package the cursor-cli Connect methods may install (AD-17). The version moves with
 * plugin releases, never on its own. \`bytes\` is the package size, \`unpackedBytes\` the size of the files it
 * unpacks to (measured from the package).
 */
export const CURSOR_MANAGED_INSTALL: ManagedInstallSpec = {
  version: "${version}",
  origin: "${ORIGIN}",
  platforms: {
${rows}
  },
  stripComponents: ${STRIP_COMPONENTS},
  launcher: "${LAUNCHER}",
  docsUrl: "${DOCS_URL}",
};
`;
}

async function pin() {
  const version = await readVersion();
  console.log(`Cursor's install script names ${version}.`);
  const platforms = [];
  for (const [key, path] of PLATFORMS) {
    const url = packageUrl(version, path);
    const sha256 = await readSha256(url);
    const head = await get(url, { method: "HEAD" });
    // A HEAD answer without Content-Length says nothing about the size: the comparison is skipped.
    const length = head.headers.get("content-length");
    const announced = length === null ? NaN : Number(length);
    const measured = await measure(url, sha256);
    if (Number.isFinite(announced) && announced !== measured.bytes) {
      throw new Error(`${url}: HEAD says ${announced} bytes, the download had ${measured.bytes}`);
    }
    console.log(`${key}: ${measured.bytes} bytes, unpacks to ${measured.unpackedBytes} bytes in ${measured.entries} entries, sha256 ${sha256}`);
    platforms.push([key, { url, sha256, bytes: measured.bytes, unpackedBytes: measured.unpackedBytes }]);
  }
  writeFileSync(OUT, render(version, platforms));
  console.log(`Wrote ${OUT}.`);
}

async function check() {
  const { CURSOR_MANAGED_INSTALL: spec } = await import(pathToFileURL(OUT).href);
  const problems = [];
  for (const [key] of PLATFORMS) {
    const pkg = spec.platforms[key];
    if (!pkg) {
      problems.push(`${key}: no package is pinned`);
      continue;
    }
    try {
      const sha256 = await readSha256(pkg.url);
      if (sha256 !== pkg.sha256) problems.push(`${key}: ${pkg.url}.sha256 now says ${sha256}, the pin has ${pkg.sha256}`);
      else console.log(`${key}: ${spec.version} matches ${pkg.url}.sha256`);
    } catch (error) {
      problems.push(`${key}: ${error.message}`);
    }
  }
  try {
    const latest = await readVersion();
    if (latest !== spec.version) console.log(`Note: Cursor's install script now names ${latest}; the pin is ${spec.version}. Move it with a plugin release.`);
  } catch (error) {
    console.log(`Note: could not read the current version (${error.message}).`);
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exitCode = 1;
  }
}

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--check")) {
  console.error("Usage: node scripts/pin-cursor-agent.mjs [--check]");
  process.exit(2);
}
await (args.includes("--check") ? check() : pin()).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
