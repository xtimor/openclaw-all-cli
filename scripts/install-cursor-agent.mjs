#!/usr/bin/env node
// Installs the cursor-agent build the plugin pins, for the live regression tier (epic-regression-gate ticket 4.5).
//
//   node scripts/install-cursor-agent.mjs <dir>
//
// Reads the pin (version, URL, size, sha256 per platform) from src/adapters/cursor/install.ts, the same object the
// plugin's managed install uses (loaded through Node's type stripping, Node 22.18 or later), downloads the package for
// this host, checks its size and sha256 before anything is unpacked, unpacks it with the system `tar` into
// <dir>/<version>, checks that the launcher reports the pinned version, and prints the launcher's absolute path as the
// only line on stdout. An install of the same version that an earlier run verified is reused (its recorded sha256 must
// be the pinned one and its launcher must still report the version). Progress goes to stderr.
//
// The managed install itself (`offerInstall` in src/core/provider-auth.ts) needs a yes from a prompter, so CI cannot
// drive it; this script installs the same bytes without it. Behind an HTTP proxy run Node with NODE_USE_ENV_PROXY=1.
// Exit 1: the download, the size or hash check, the unpack, or the launcher failed; 2: usage.
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PIN_FILE = fileURLToPath(new URL("../src/adapters/cursor/install.ts", import.meta.url));
/** Written next to the launcher once the package's hash matched the pin. */
export const VERIFIED_FILE = ".pinned-sha256";

/** The pinned install spec (`CURSOR_MANAGED_INSTALL`) from install.ts, checked for the fields this script uses. */
export async function loadPin(file = PIN_FILE) {
  const module = await import(pathToFileURL(file).href);
  const pin = module.CURSOR_MANAGED_INSTALL;
  if (!pin || typeof pin.version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pin.version)) {
    throw new Error(`${file} has no CURSOR_MANAGED_INSTALL with a plain version`);
  }
  if (typeof pin.launcher !== "string" || pin.launcher.split("/").some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))) {
    throw new Error(`${file}: the pinned launcher is not a plain path`);
  }
  if (!pin.platforms || typeof pin.platforms !== "object") throw new Error(`${file}: the pin has no platforms`);
  return pin;
}

/** The pin's platform key for a host, such as `linux-x64`. */
export function platformKey(os = process.platform, arch = process.arch) {
  return `${os}-${arch}`;
}

/** The pinned package for `platform`, checked: an https URL on the pinned origin, a byte count, and a sha256. */
export function pinnedPackage(pin, platform) {
  const pkg = pin.platforms[platform];
  if (!pkg) throw new Error(`no cursor-agent package is pinned for ${platform} (pinned: ${Object.keys(pin.platforms).join(", ")})`);
  const url = new URL(pkg.url);
  if (url.protocol !== "https:" || (pin.origin && url.origin !== new URL(pin.origin).origin)) {
    throw new Error(`the pinned package address for ${platform} is not an https address on ${pin.origin}`);
  }
  if (!/^[0-9a-f]{64}$/i.test(String(pkg.sha256))) throw new Error(`the pinned sha256 for ${platform} is not a sha256`);
  if (!Number.isSafeInteger(pkg.bytes) || pkg.bytes <= 0) throw new Error(`the pinned size for ${platform} is not a byte count`);
  return { url: pkg.url, sha256: String(pkg.sha256).toLowerCase(), bytes: pkg.bytes };
}

/** Streams `response` to `file` and returns its byte count and sha256; stops once it is larger than `limit`. */
export async function saveAndHash(response, file, limit) {
  const hash = createHash("sha256");
  let bytes = 0;
  await pipeline(
    Readable.fromWeb(response.body),
    async function* (source) {
      for await (const chunk of source) {
        bytes += chunk.length;
        if (bytes > limit) throw new Error(`the download is larger than the pinned ${limit} bytes`);
        hash.update(chunk);
        yield chunk;
      }
    },
    createWriteStream(file, { flags: "wx", mode: 0o600 }),
  );
  return { bytes, sha256: hash.digest("hex") };
}

/** Fails unless the downloaded file is the pinned one. */
export function checkDownload(got, pkg) {
  if (got.bytes !== pkg.bytes) throw new Error(`size mismatch: the pin has ${pkg.bytes} bytes, the download ${got.bytes}`);
  if (got.sha256 !== pkg.sha256) throw new Error(`sha256 mismatch: the pin has ${pkg.sha256}, the download ${got.sha256}; nothing was unpacked`);
}

function launcherVersion(launcher) {
  return new Promise((resolveRun) => {
    execFile(launcher, ["--version"], { timeout: 60_000, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      resolveRun(error ? undefined : `${stdout}\n${stderr}`);
    });
  });
}

/**
 * Installs the pinned package for `platform` into `<dir>/<version>` and returns the launcher's absolute path.
 * `fetch` and `log` are injectable for tests.
 */
export async function installPinned({ dir, pin, platform = platformKey(), fetch = globalThis.fetch, log = (line) => process.stderr.write(`${line}\n`) }) {
  const pkg = pinnedPackage(pin, platform);
  const root = resolve(dir);
  const target = join(root, pin.version);
  const launcher = join(target, ...pin.launcher.split("/"));
  const verified = join(target, VERIFIED_FILE);
  if (existsSync(verified) && readFileSync(verified, "utf8").trim() === pkg.sha256 && (await launcherVersion(launcher))?.includes(pin.version)) {
    log(`cursor-agent ${pin.version} (${platform}) is already installed and verified: ${launcher}`);
    return launcher;
  }
  mkdirSync(root, { recursive: true });
  const temp = mkdtempSync(join(root, `.tmp-${pin.version}-`));
  try {
    log(`Downloading cursor-agent ${pin.version} (${platform}, ${pkg.bytes} bytes) from ${pkg.url}`);
    let response;
    try {
      response = await fetch(pkg.url, { redirect: "error" });
    } catch (error) {
      const cause = error?.cause?.code ?? error?.cause?.message ?? error?.message;
      throw new Error(`the download failed (${cause || "network error"}); behind a proxy set NODE_USE_ENV_PROXY=1 and allow ${new URL(pkg.url).host}`);
    }
    if (!response.ok || !response.body) throw new Error(`the download failed (HTTP ${response.status})`);
    const archive = join(temp, "package.tar.gz");
    checkDownload(await saveAndHash(response, archive, pkg.bytes), pkg);
    log(`sha256 ${pkg.sha256} matches the pin; unpacking`);
    const unpacked = join(temp, "unpacked");
    mkdirSync(unpacked);
    execFileSync("tar", ["-xzf", archive, "-C", unpacked, `--strip-components=${pin.stripComponents ?? 1}`], { stdio: ["ignore", "ignore", "inherit"] });
    rmSync(archive, { force: true });
    const tempLauncher = join(unpacked, ...pin.launcher.split("/"));
    const answer = await launcherVersion(tempLauncher);
    if (answer === undefined) throw new Error(`the unpacked launcher ${pin.launcher} does not run (--version failed)`);
    if (!answer.includes(pin.version)) throw new Error(`the unpacked launcher does not report version ${pin.version}`);
    writeFileSync(join(unpacked, VERIFIED_FILE), `${pkg.sha256}\n`);
    rmSync(target, { recursive: true, force: true });
    renameSync(unpacked, target);
    log(`Installed cursor-agent ${pin.version}: ${launcher}`);
    return launcher;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function main(argv) {
  if (argv.length !== 1 || argv[0].startsWith("-")) {
    process.stderr.write("usage: node scripts/install-cursor-agent.mjs <dir>\n");
    return 2;
  }
  try {
    const launcher = await installPinned({ dir: argv[0], pin: await loadPin() });
    process.stdout.write(`${launcher}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`install-cursor-agent: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
