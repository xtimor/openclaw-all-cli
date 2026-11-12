import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  diskNeed,
  hostFacts,
  hostSupport,
  installManaged,
  isInside,
  ManagedInstallError,
  managedRoot,
  readManaged,
  removeManaged,
  type InstallOptions,
} from "../src/core/managed-install.ts";
import type { ManagedInstallSpec } from "../src/core/ports.ts";
import { startPackageStub, testPackage, testSpec, truncatedPackage, TEST_VERSION, unpackedSize, type PackageStub } from "./fixtures/package-stub.ts";

let stub: PackageStub;
beforeAll(async () => {
  stub = await startPackageStub();
});
afterAll(async () => {
  await stub.close();
});

const dirs: string[] = [];
const stateDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "oac-managed-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  stub.requests.length = 0;
});

const PKG = testPackage();
const PLENTY = async () => 1024 * 1024 * 1024 * 1024;

function install(spec: ManagedInstallSpec, root: string, extra: Partial<InstallOptions> = {}) {
  return installManaged({ spec, platform: "linux-x64", root, fetch: stub.fetch, freeBytes: PLENTY, ...extra });
}

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ManagedInstallError) return error.reason;
    throw error;
  }
  return "ok";
}

/** An earlier install of another version, to show a failure leaves it alone. */
function earlierInstall(root: string) {
  mkdirSync(join(root, "1.0.0"), { recursive: true });
  writeFileSync(join(root, "1.0.0", "tool"), "#!/bin/sh\necho 1.0.0\n", { mode: 0o755 });
}

/** Nothing but the earlier install is left in the root: no temporary folder, no new version. */
const onlyEarlier = (root: string) => expect(readdirSync(root)).toEqual(["1.0.0"]);

describe("installManaged (criteria 3 and 4)", () => {
  it("downloads the pinned package, checks it, unpacks it, verifies the launcher, renames it into place, and removes older versions", async () => {
    const root = managedRoot(stateDir(), "tool");
    earlierInstall(root);
    stub.answer({ kind: "body", body: PKG });
    const progress: string[] = [];
    const result = await install(testSpec(PKG), root, { onProgress: (step) => progress.push(step.phase) });
    expect(result.dir).toBe(join(root, TEST_VERSION));
    expect(result.launcher).toBe(join(root, TEST_VERSION, "tool"));
    expect(result.removed).toEqual(["1.0.0"]);
    expect(readdirSync(root)).toEqual([TEST_VERSION]);
    expect(statSync(result.launcher).mode & 0o111).not.toBe(0);
    expect(execFileSync(result.launcher, ["--version"], { encoding: "utf8" }).trim()).toBe(TEST_VERSION);
    expect(readFileSync(join(result.dir, "lib/data.txt"), "utf8")).toContain("payload");
    expect(stub.requests).toEqual([`GET /lab/${TEST_VERSION}/linux/x64/pkg.tar.gz`]);
    expect(progress[0]).toBe("download");
    expect(progress.slice(-2)).toEqual(["unpack", "verify"]);
  });

  it("replaces a broken folder of the same version", async () => {
    const root = managedRoot(stateDir(), "tool");
    mkdirSync(join(root, TEST_VERSION), { recursive: true });
    writeFileSync(join(root, TEST_VERSION, "stale"), "x");
    stub.answer({ kind: "body", body: PKG });
    const result = await install(testSpec(PKG), root);
    expect(readdirSync(result.dir).toSorted()).toEqual(["lib", "tool"]);
    expect(readdirSync(root)).toEqual([TEST_VERSION]);
  });

  it.each([
    ["a hash mismatch", "hash", () => ({ answer: { kind: "body" as const, body: PKG }, spec: testSpec(PKG, { sha: "0".repeat(64) }) })],
    [
      "a truncated download",
      "size",
      () => ({ answer: { kind: "body" as const, body: PKG.subarray(0, PKG.length - 10), chunked: true }, spec: testSpec(PKG) }),
    ],
    [
      "an oversized download",
      "size",
      () => ({ answer: { kind: "body" as const, body: Buffer.concat([PKG, Buffer.alloc(100)]), chunked: true }, spec: testSpec(PKG) }),
    ],
    [
      "a size the server announces that differs from the pin",
      "size",
      () => ({ answer: { kind: "body" as const, body: Buffer.concat([PKG, Buffer.alloc(100)]) }, spec: testSpec(PKG) }),
    ],
    ["an HTTP error", "download", () => ({ answer: { kind: "status" as const, status: 500 }, spec: testSpec(PKG) })],
    ["a proxy refusal", "download", () => ({ answer: { kind: "status" as const, status: 407 }, spec: testSpec(PKG) })],
    ["a redirect", "origin", () => ({ answer: { kind: "redirect" as const, location: "https://elsewhere.test/pkg.tar.gz" }, spec: testSpec(PKG) })],
    ["an unpack limit", "unpack", () => ({ answer: { kind: "body" as const, body: PKG }, spec: testSpec(PKG, { unpackedBytes: 100 }) })],
    [
      "a damaged archive with a matching pin",
      "unpack",
      () => {
        const body = truncatedPackage();
        return { answer: { kind: "body" as const, body }, spec: testSpec(body) };
      },
    ],
    [
      "a launcher whose --version fails",
      "launcher",
      () => {
        const body = testPackage({ versionExit: 3 });
        return { answer: { kind: "body" as const, body }, spec: testSpec(body, { unpackedBytes: unpackedSize({ versionExit: 3 }) }) };
      },
    ],
    [
      "a launcher that reports another version",
      "launcher",
      () => {
        const body = testPackage({ version: "9.9.9-other" });
        return { answer: { kind: "body" as const, body }, spec: testSpec(body, { unpackedBytes: unpackedSize({ version: "9.9.9-other" }) }) };
      },
    ],
    [
      "a package without the launcher",
      "launcher",
      () => {
        const body = testPackage({ launcher: "other" });
        return { answer: { kind: "body" as const, body }, spec: testSpec(body) };
      },
    ],
  ])("stops on %s: names the cause, removes the temporary folder, and leaves an earlier install", async (_label, reason, setup) => {
    const root = managedRoot(stateDir(), "tool");
    earlierInstall(root);
    const { answer, spec } = setup();
    stub.answer(answer);
    const failed = install(spec, root);
    expect(await reasonOf(failed)).toBe(reason);
    onlyEarlier(root);
    expect(readFileSync(join(root, "1.0.0", "tool"), "utf8")).toContain("1.0.0");
  });

  it("says a proxy refused the download", async () => {
    stub.answer({ kind: "status", status: 407 });
    await expect(install(testSpec(PKG), managedRoot(stateDir(), "tool"))).rejects.toThrow(/proxy.*NODE_USE_ENV_PROXY=1/);
  });

  it("refuses a package outside the pinned origin, or a plain-HTTP origin, before any request", async () => {
    const root = managedRoot(stateDir(), "tool");
    stub.answer({ kind: "body", body: PKG });
    expect(await reasonOf(install(testSpec(PKG, { url: "https://evil.test/pkg.tar.gz" }), root))).toBe("origin");
    expect(await reasonOf(install(testSpec(PKG, { url: "http://pkg.test/lab/pkg.tar.gz" }), root))).toBe("origin");
    expect(await reasonOf(install(testSpec(PKG, { origin: "http://pkg.test" }), root))).toBe("origin");
    expect(await reasonOf(install(testSpec(PKG, { url: "https://user:pw@pkg.test/pkg.tar.gz" }), root))).toBe("origin");
    expect(await reasonOf(install(testSpec(PKG, { version: "../escape" }), root))).toBe("origin");
    expect(await reasonOf(install(testSpec(PKG, { launcher: "../../bin/sh" }), root))).toBe("origin");
    expect(stub.requests).toEqual([]);
    expect(existsSync(root)).toBe(false);
  });

  it("refuses when the disk has too little space, before any request", async () => {
    const root = managedRoot(stateDir(), "tool");
    stub.answer({ kind: "body", body: PKG });
    const failed = install(testSpec(PKG), root, { freeBytes: async () => 10 });
    await expect(failed).rejects.toThrow(/Not enough disk space/);
    expect(stub.requests).toEqual([]);
  });

  it("stops on a cancel during the download and removes the temporary folder", async () => {
    const root = managedRoot(stateDir(), "tool");
    earlierInstall(root);
    const big = Buffer.concat([PKG, Buffer.alloc(64 * 1024)]);
    stub.answer({ kind: "slow", body: big, chunk: 1024, delayMs: 5 });
    const controller = new AbortController();
    const failed = install(testSpec(big), root, {
      signal: controller.signal,
      onProgress: (step) => {
        if (step.phase === "download" && step.done === 0) setTimeout(() => controller.abort(new Error("stop")), 30);
      },
    });
    expect(await reasonOf(failed)).toBe("cancelled");
    onlyEarlier(root);
  });

  it("checks the free space against the package, what it unpacks to, and a margin", () => {
    const pkg = testSpec(PKG).platforms["linux-x64"]!;
    expect(diskNeed(pkg)).toBeGreaterThan(pkg.bytes + pkg.unpackedBytes);
  });
});

describe("hostSupport (criterion 7)", () => {
  const spec = testSpec(PKG, {
    platforms: Object.fromEntries(
      (["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"] as const).map((key) => [key, testSpec(PKG).platforms["linux-x64"]!]),
    ),
  });
  const facts = (over: Partial<Parameters<typeof hostSupport>[1]>) => ({ os: "linux" as NodeJS.Platform, arch: "x64", glibc: "2.39", nixMode: false, ...over });

  it("supports Linux with glibc and macOS, on x64 and arm64", () => {
    expect(hostSupport(spec, facts({}))).toEqual({ platform: "linux-x64" });
    expect(hostSupport(spec, facts({ arch: "arm64" }))).toEqual({ platform: "linux-arm64" });
    expect(hostSupport(spec, facts({ os: "darwin", glibc: undefined }))).toEqual({ platform: "darwin-x64" });
    expect(hostSupport(spec, facts({ os: "darwin", arch: "arm64", glibc: undefined }))).toEqual({ platform: "darwin-arm64" });
  });

  it.each([
    ["Windows", { os: "win32" as NodeJS.Platform }, /Windows/],
    ["musl", { glibc: undefined }, /musl/],
    ["another architecture", { arch: "ia32" }, /ia32/],
    ["Nix mode", { nixMode: true }, /Nix mode/],
    ["FreeBSD", { os: "freebsd" as NodeJS.Platform }, /freebsd/],
  ])("gives the reason on %s", (_label, over, reason) => {
    const answer = hostSupport(spec, facts(over));
    expect("reason" in answer && answer.reason).toMatch(reason);
  });

  it("gives the reason when no package is pinned for the host", () => {
    const answer = hostSupport(testSpec(PKG), facts({ os: "darwin", glibc: undefined }));
    expect("reason" in answer && answer.reason).toMatch(/darwin-x64/);
  });

  it("reads this host's facts and Nix mode from the env", () => {
    const here = hostFacts({ OPENCLAW_NIX_MODE: "1" });
    expect(here).toMatchObject({ os: process.platform, arch: process.arch, nixMode: true });
    expect(hostFacts({}).nixMode).toBe(false);
    if (process.platform === "linux") expect(typeof here.glibc === "string" || here.glibc === undefined).toBe(true);
  });
});

describe("the managed root", () => {
  it("is <state dir>/tools/<command>, and refuses a command that is a path", () => {
    expect(managedRoot("/state", "tool")).toBe("/state/tools/tool");
    expect(() => managedRoot("/state", "../tool")).toThrow();
    expect(() => managedRoot("/state", "/usr/bin/tool")).toThrow();
    expect(isInside("/state/tools/tool", "/state/tools/tool/1/tool")).toBe(true);
    expect(isInside("/state/tools/tool", "/state/tools/tool")).toBe(false);
    expect(isInside("/state/tools/tool", "/state/tools/toolbox/x")).toBe(false);
  });

  it("reports what is installed, and removes only a folder under <state dir>/tools", async () => {
    const state = stateDir();
    const root = managedRoot(state, "tool");
    expect(await readManaged(root)).toEqual({ versions: [], bytes: 0, present: false });
    earlierInstall(root);
    const read = await readManaged(root);
    expect(read).toMatchObject({ versions: ["1.0.0"], present: true });
    expect(read.bytes).toBeGreaterThan(0);
    await expect(removeManaged(state, state)).rejects.toThrow(/outside/);
    await expect(removeManaged(state, join(state, "tools"))).rejects.toThrow(/outside/);
    await expect(removeManaged(state, join(root, "1.0.0"))).rejects.toThrow(/outside/);
    expect(existsSync(root)).toBe(true);
    await removeManaged(state, root);
    expect(existsSync(root)).toBe(false);
  });
});
