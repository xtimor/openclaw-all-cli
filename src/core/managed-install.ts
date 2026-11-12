import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, rename, rm, statfs } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ManagedInstallSpec, ManagedPackage, ManagedPlatform } from "./ports.ts";
import { extractTarGz, TarError } from "./tar.ts";

/**
 * Managed CLI installs (AD-17): a CLI the plugin installs itself, on the user's yes, into
 * `<state dir>/tools/<command>/<version>/`. Only the adapter's pinned package is installed: its
 * origin, version, size, and sha256 are adapter data. The package is checked before it is
 * unpacked, unpacked with limits into a temporary folder, and moved into place with one rename.
 * Nothing here runs a shell or an install script, follows a redirect, or touches `PATH`.
 */

export type HostFacts = {
  os: NodeJS.Platform;
  arch: string;
  /** The glibc version on Linux; absent on a musl Linux and elsewhere. */
  glibc?: string | undefined;
  /** OpenClaw's Nix mode (`OPENCLAW_NIX_MODE=1`), which turns off auto-install flows. */
  nixMode: boolean;
};

export type HostSupport = { platform: ManagedPlatform } | { reason: string };

/** The glibc version Node runs on, from its diagnostic report header. */
function glibcVersion(): string | undefined {
  if (process.platform !== "linux") return undefined;
  // `excludeNetwork` (Node 22+) is missing from the bundled typings.
  const report = process.report as NodeJS.ProcessReport & { excludeNetwork?: boolean };
  const before = report.excludeNetwork;
  try {
    // The report would otherwise collect network details, which is slow and not needed here.
    report.excludeNetwork = true;
    const header = (report.getReport() as { header?: { glibcVersionRuntime?: unknown } }).header;
    return typeof header?.glibcVersionRuntime === "string" ? header.glibcVersionRuntime : undefined;
  } catch {
    return undefined;
  } finally {
    if (before !== undefined) report.excludeNetwork = before;
  }
}

/** The facts of the host the Gateway runs on. */
export function hostFacts(env: Record<string, string | undefined>): HostFacts {
  return { os: process.platform, arch: process.arch, glibc: glibcVersion(), nixMode: env.OPENCLAW_NIX_MODE === "1" };
}

/** Which pinned package fits the host, or why none does (a sentence part). */
export function hostSupport(spec: ManagedInstallSpec, facts: HostFacts): HostSupport {
  if (facts.nixMode) return { reason: "OpenClaw runs in Nix mode (OPENCLAW_NIX_MODE=1), which turns off installs" };
  if (facts.os === "win32") return { reason: "Windows is not supported by the plugin's install yet" };
  if (facts.os !== "linux" && facts.os !== "darwin") return { reason: `this operating system (${facts.os}) is not supported` };
  if (facts.arch !== "x64" && facts.arch !== "arm64") return { reason: `this processor (${facts.arch}) is not supported` };
  if (facts.os === "linux" && !facts.glibc) return { reason: "this Linux has no glibc (musl, as on Alpine), and there is no build for it" };
  const platform = `${facts.os}-${facts.arch}` as ManagedPlatform;
  if (!spec.platforms[platform]) return { reason: `no package is pinned for ${platform}` };
  return { platform };
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** `<stateDir>/tools/<command>`: the only folder managed installs live in. */
export function managedRoot(stateDir: string, command: string): string {
  if (!SAFE_NAME.test(command)) throw new Error(`Cannot keep a managed install for the command "${command}".`);
  return join(resolve(stateDir), "tools", command);
}

/** True when `path` is inside `root` (not `root` itself). */
export function isInside(root: string, path: string): boolean {
  return resolve(path).startsWith(resolve(root) + sep);
}

/** What the plugin needs on disk for an install: the package, what it unpacks to, and a margin. */
export function diskNeed(pkg: ManagedPackage): number {
  return pkg.bytes + pkg.unpackedBytes + 32 * 1024 * 1024;
}

/** Bytes as `169 MiB`. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

async function sizeOf(path: string): Promise<number> {
  const info = await lstat(path).catch(() => undefined);
  if (!info) return 0;
  if (!info.isDirectory()) return info.size;
  const names = await readdir(path).catch(() => [] as string[]);
  let total = 0;
  for (const name of names) total += await sizeOf(join(path, name));
  return total;
}

export type ManagedState = {
  /** Installed version folders. */
  versions: string[];
  /** Everything under the root, temporary folders included. */
  bytes: number;
  /** True when the root holds anything at all. */
  present: boolean;
};

/** What is in the managed root. */
export async function readManaged(root: string): Promise<ManagedState> {
  const names = await readdir(root).catch(() => [] as string[]);
  const versions: string[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    if ((await lstat(join(root, name)).catch(() => undefined))?.isDirectory()) versions.push(name);
  }
  return { versions: versions.toSorted(), bytes: await sizeOf(root), present: names.length > 0 };
}

/** Removes the managed root and everything in it. Refuses any folder that is not `<stateDir>/tools/<name>`. */
export async function removeManaged(stateDir: string, root: string): Promise<void> {
  const tools = join(resolve(stateDir), "tools");
  if (dirname(resolve(root)) !== tools || !SAFE_NAME.test(resolve(root).slice(tools.length + 1))) {
    throw new Error("Refusing to remove a folder outside the plugin's managed tools folder.");
  }
  await rm(resolve(root), { recursive: true, force: true });
}

export type ManagedInstallReason = "origin" | "download" | "size" | "hash" | "disk" | "unpack" | "launcher" | "cancelled";

/** Why an install stopped. The message names the cause; it holds no secret. */
export class ManagedInstallError extends Error {
  constructor(
    readonly reason: ManagedInstallReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ManagedInstallError";
  }
}

export type InstallProgress = { phase: "download"; done: number; total: number } | { phase: "unpack" } | { phase: "verify" };

export type InstallOptions = {
  spec: ManagedInstallSpec;
  platform: ManagedPlatform;
  /** `managedRoot(...)`. */
  root: string;
  fetch: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (progress: InstallProgress) => void;
  /** Free bytes for the folder (tests). Default: `statfs` of the nearest existing folder. */
  freeBytes?: (dir: string) => Promise<number>;
  /** The env the launcher's `--version` runs with. */
  env?: Record<string, string | undefined>;
  /** Longest the launcher's `--version` may take. */
  launcherTimeoutMs?: number;
};

export type InstallResult = {
  /** Absolute path of the installed launcher. */
  launcher: string;
  /** The version folder. */
  dir: string;
  /** Older managed folders that were removed after the switch. */
  removed: string[];
};

/** At most this many files and folders in a package. */
const MAX_ENTRIES = 20_000;
const LAUNCHER_TIMEOUT_MS = 60_000;
/** A temporary folder left by a killed install is removed by a later one after a day. */
const STALE_TEMP_MS = 24 * 60 * 60 * 1000;

function checkOrigin(spec: ManagedInstallSpec, pkg: ManagedPackage): void {
  let origin: URL;
  let url: URL;
  try {
    origin = new URL(spec.origin);
    url = new URL(pkg.url);
  } catch {
    throw new ManagedInstallError("origin", "The pinned download address is not a valid URL.");
  }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/") {
    throw new ManagedInstallError("origin", "The pinned download origin is not a plain HTTPS origin.");
  }
  if (url.protocol !== "https:" || url.origin !== origin.origin || url.username || url.password) {
    throw new ManagedInstallError("origin", `The package address is not on the pinned origin ${origin.host}; nothing was downloaded.`);
  }
}

const reachHint = (pkg: ManagedPackage) =>
  `Check that the Gateway host can reach ${new URL(pkg.url).host}; behind an HTTP proxy, allow that host and start the Gateway with NODE_USE_ENV_PROXY=1.`;

async function defaultFreeBytes(dir: string): Promise<number> {
  let at = resolve(dir);
  for (;;) {
    try {
      const info = await statfs(at);
      return info.bavail * info.bsize;
    } catch (error) {
      const parent = dirname(at);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === at) throw error;
      at = parent;
    }
  }
}

function runVersion(launcher: string, options: InstallOptions): Promise<string> {
  return new Promise((resolveRun, reject) => {
    execFile(
      launcher,
      ["--version"],
      {
        env: (options.env ?? process.env) as NodeJS.ProcessEnv,
        timeout: options.launcherTimeoutMs ?? LAUNCHER_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout, stderr) => {
        if (error) reject(error);
        else resolveRun(`${stdout}\n${stderr}`);
      },
    );
  });
}

const isDiskFull = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOSPC" || code === "EDQUOT";
};

/**
 * Installs the pinned package for `platform` into `<root>/<version>` and removes older managed
 * versions. On any failure the temporary folder is removed and an earlier install is left as it
 * was; the caller changes no config.
 */
export async function installManaged(options: InstallOptions): Promise<InstallResult> {
  const { spec, platform, root, signal } = options;
  const pkg = spec.platforms[platform];
  if (!pkg) throw new ManagedInstallError("origin", `No package is pinned for ${platform}.`);
  checkOrigin(spec, pkg);
  if (!SAFE_NAME.test(spec.version)) throw new ManagedInstallError("origin", "The pinned version is not a plain name.");
  const launcherParts = spec.launcher.split("/");
  if (launcherParts.some((part) => !SAFE_NAME.test(part))) throw new ManagedInstallError("origin", "The pinned launcher path is not a plain path.");
  const cancelled = () => new ManagedInstallError("cancelled", "The install was cancelled.");
  if (signal?.aborted) throw cancelled();

  const need = diskNeed(pkg);
  const free = await (options.freeBytes ?? defaultFreeBytes)(root);
  if (free < need) {
    throw new ManagedInstallError("disk", `Not enough disk space: the install needs ${formatBytes(need)} and ${formatBytes(free)} is free.`);
  }

  await mkdir(root, { recursive: true, mode: 0o755 });
  const temp = await mkdtemp(join(root, `.tmp-${spec.version}-`));
  try {
    // Download, with the size and hash checked before anything is unpacked.
    const archive = join(temp, "package");
    let response: Response;
    try {
      response = await options.fetch(pkg.url, { redirect: "error", ...(signal ? { signal } : {}) });
    } catch (error) {
      if (signal?.aborted) throw cancelled();
      const cause = (error as { cause?: { code?: string; message?: string } }).cause;
      const detail = cause?.code ?? cause?.message ?? (error as Error).message;
      if (/redirect/i.test(`${cause?.message ?? ""} ${(error as Error).message}`)) {
        throw new ManagedInstallError("origin", "The server answered with a redirect, which is refused: only the pinned address is downloaded.", { cause: error });
      }
      throw new ManagedInstallError(
        "download",
        `The download failed (${detail || "a network error without details, as an HTTP proxy refusal gives"}). ${reachHint(pkg)}`,
        { cause: error },
      );
    }
    if (response.status >= 300 && response.status < 400) {
      throw new ManagedInstallError("origin", `The server answered with a redirect (HTTP ${response.status}), which is refused.`);
    }
    if (response.status === 407) {
      throw new ManagedInstallError("download", `The HTTP proxy refused the download (HTTP 407). ${reachHint(pkg)}`);
    }
    if (!response.ok || !response.body) {
      throw new ManagedInstallError("download", `The download failed (HTTP ${response.status}). ${reachHint(pkg)}`);
    }
    const announced = Number(response.headers.get("content-length") ?? NaN);
    if (Number.isFinite(announced) && announced !== pkg.bytes) {
      await response.body.cancel().catch(() => {});
      throw new ManagedInstallError("size", `The server offers ${announced} bytes, but the pinned package has ${pkg.bytes}.`);
    }
    const hash = createHash("sha256");
    let received = 0;
    let reported = 0;
    const step = Math.max(1024 * 1024, Math.floor(pkg.bytes / 100));
    options.onProgress?.({ phase: "download", done: 0, total: pkg.bytes });
    try {
      await pipeline(
        Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>),
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            received += chunk.length;
            if (received > pkg.bytes) {
              throw new ManagedInstallError("size", `The download is larger than the pinned package (${pkg.bytes} bytes).`);
            }
            hash.update(chunk);
            if (received - reported >= step || received === pkg.bytes) {
              reported = received;
              options.onProgress?.({ phase: "download", done: received, total: pkg.bytes });
            }
            yield chunk;
          }
        },
        createWriteStream(archive, { flags: "wx", mode: 0o600 }),
        ...(signal ? [{ signal }] : []),
      );
    } catch (error) {
      if (error instanceof ManagedInstallError) throw error;
      if (signal?.aborted) throw cancelled();
      if (isDiskFull(error)) throw new ManagedInstallError("disk", "The disk filled up during the download.", { cause: error });
      throw new ManagedInstallError("download", `The download broke off after ${received} of ${pkg.bytes} bytes.`, { cause: error });
    }
    if (received < pkg.bytes) {
      throw new ManagedInstallError("size", `The download is truncated: ${received} of ${pkg.bytes} bytes arrived.`);
    }
    if (hash.digest("hex") !== pkg.sha256.toLowerCase()) {
      throw new ManagedInstallError("hash", "The package's sha256 does not match the pinned hash; it was not unpacked.");
    }

    // Unpack with limits into the temporary folder.
    options.onProgress?.({ phase: "unpack" });
    const unpacked = join(temp, "unpacked");
    await mkdir(unpacked, { mode: 0o755 });
    try {
      await extractTarGz(createReadStream(archive), {
        dest: unpacked,
        stripComponents: spec.stripComponents,
        limits: { maxBytes: pkg.unpackedBytes, maxEntries: MAX_ENTRIES },
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw cancelled();
      if (error instanceof TarError) throw new ManagedInstallError("unpack", `Unpacking stopped: ${error.message}`, { cause: error });
      if (isDiskFull(error)) throw new ManagedInstallError("disk", "The disk filled up while unpacking.", { cause: error });
      throw new ManagedInstallError("unpack", `Unpacking failed (${(error as Error).message}).`, { cause: error });
    }
    await rm(archive, { force: true });

    // The launcher must answer with the pinned version before anything points at it.
    options.onProgress?.({ phase: "verify" });
    const tempLauncher = join(unpacked, ...launcherParts);
    const info = await lstat(tempLauncher).catch(() => undefined);
    if (!info?.isFile()) throw new ManagedInstallError("launcher", `The package has no launcher at ${spec.launcher}.`);
    let answer: string;
    try {
      answer = await runVersion(tempLauncher, options);
    } catch (error) {
      if (signal?.aborted) throw cancelled();
      throw new ManagedInstallError("launcher", `The installed launcher does not run (\`--version\` failed: ${(error as Error).message.split("\n")[0]}).`, {
        cause: error,
      });
    }
    if (!answer.includes(spec.version)) {
      throw new ManagedInstallError("launcher", `The installed launcher does not report version ${spec.version}.`);
    }
    if (signal?.aborted) throw cancelled();

    // One rename puts it in place; an earlier folder of the same version moves aside first.
    const dir = join(root, spec.version);
    const aside = join(temp, "previous");
    const hadPrevious = await lstat(dir).then(
      () => true,
      () => false,
    );
    if (hadPrevious) await rename(dir, aside);
    try {
      await rename(unpacked, dir);
    } catch (error) {
      if (hadPrevious) await rename(aside, dir).catch(() => {});
      throw new ManagedInstallError("unpack", `Could not move the install into place (${(error as Error).message}).`, { cause: error });
    }

    // Older versions go after the switch; a temporary folder of an install still running stays.
    const removed: string[] = [];
    for (const name of await readdir(root)) {
      const path = join(root, name);
      if (path === temp || name === spec.version) continue;
      if (name.startsWith(".")) {
        const stale = await lstat(path).then((entry) => Date.now() - entry.mtimeMs > STALE_TEMP_MS, () => false);
        if (!stale) continue;
      } else {
        removed.push(name);
      }
      await rm(path, { recursive: true, force: true }).catch(() => {});
    }
    return { launcher: join(dir, ...launcherParts), dir, removed };
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}
