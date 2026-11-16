import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testPackage, unpackedSize } from "./fixtures/package-stub.ts";

/** AC 9 of story 27: the pin script reads Cursor's install script and `.sha256` files (here a local stub). */
const SCRIPT = fileURLToPath(new URL("../scripts/pin-cursor-agent.mjs", import.meta.url));
const VERSION = "2026.11.11-abc1234";
const PKG = testPackage();
const SHA = createHash("sha256").update(PKG).digest("hex");

let server: Server;
let base = "";
const state = { sha: SHA, missing: "" };
const dir = mkdtempSync(join(tmpdir(), "oac-pin-"));
const out = join(dir, "install.ts");

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "";
    if (url === "/install") {
      res.end(`#!/usr/bin/env bash\nDOWNLOAD_URL="https://downloads.cursor.com/lab/${VERSION}/\${OS}/\${ARCH}/agent-cli-package.tar.gz"\n`);
    } else if (state.missing && url.startsWith(state.missing)) {
      res.writeHead(404).end();
    } else if (url.endsWith(".tar.gz.sha256")) {
      res.end(`${state.sha}  agent-cli-package.tar.gz\n`);
    } else if (url.endsWith(".tar.gz")) {
      res.writeHead(200, { "content-length": String(PKG.length) });
      res.end(req.method === "HEAD" ? undefined : PKG);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

/** Runs the script in a child process (never synchronously while the stub serves). */
function run(args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { PATH: process.env.PATH, PIN_CURSOR_INSTALL_URL: `${base}/install`, PIN_CURSOR_ORIGIN: base, PIN_CURSOR_OUT: out },
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => resolve({ code, output }));
  });
}

describe("scripts/pin-cursor-agent.mjs", () => {
  it("writes the version, the four platforms' sha256, size, and unpacked size as adapter data", async () => {
    const { code, output } = await run([]);
    expect(output).toContain(VERSION);
    expect(code).toBe(0);
    const written = readFileSync(out, "utf8");
    expect(written).toContain(`version: "${VERSION}"`);
    expect(written).toContain('origin: "https://downloads.cursor.com"');
    for (const platform of ["linux/x64", "linux/arm64", "darwin/x64", "darwin/arm64"]) {
      expect(written).toContain(`https://downloads.cursor.com/lab/${VERSION}/${platform}/agent-cli-package.tar.gz`);
    }
    expect(written.split(`sha256: "${SHA}"`)).toHaveLength(5);
    expect(written).toContain(`bytes: ${PKG.length},`);
    expect(written).toContain(`unpackedBytes: ${unpackedSize()},`);
  });

  it("--check passes while the .sha256 files match, and fails when one changed or does not answer", async () => {
    expect((await run(["--check"])).code).toBe(0);
    state.sha = "f".repeat(64);
    const changed = await run(["--check"]);
    expect(changed.code).toBe(1);
    expect(changed.output).toMatch(/now says f{64}/);
    state.sha = SHA;
    state.missing = `/lab/${VERSION}/darwin/arm64/`;
    const gone = await run(["--check"]);
    expect(gone.code).toBe(1);
    expect(gone.output).toMatch(/darwin-arm64: .*HTTP 404/);
    state.missing = "";
  });

  it("refuses a package whose download does not match its .sha256 file", async () => {
    state.sha = "0".repeat(64);
    const { code, output } = await run([]);
    state.sha = SHA;
    expect(code).toBe(1);
    expect(output).toMatch(/but its \.sha256 file says 0{64}/);
  });
});
