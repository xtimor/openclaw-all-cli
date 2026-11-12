import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ManagedInstallSpec } from "../../src/core/ports.ts";
import { buildTar, buildTarGz } from "./tar-builder.ts";
import { gzipSync } from "node:zlib";

/** The pinned origin the test specs use; `stubFetch` sends it to the local stub. */
export const TEST_ORIGIN = "https://pkg.test";
export const TEST_VERSION = "1.2.3-test";

/**
 * A launcher like a CLI's: `--version` prints the pinned version, `about` answers like a key check
 * (`TEST_ABOUT=ok|invalid|unknown`, only with `TEST_KEY_VAR`'s variable set), `status` reports a login.
 */
export function launcherScript(options: { version?: string; versionExit?: number } = {}): string {
  return [
    "#!/bin/sh",
    'case "$1" in',
    `  --version) echo "${options.version ?? TEST_VERSION}"; exit ${options.versionExit ?? 0} ;;`,
    '  status) if [ "$TEST_LOGGED_IN" = "1" ]; then echo "Logged in as t@example.com"; else echo "Not logged in"; exit 1; fi ;;',
    '  about)',
    '    if [ -z "$CURSOR_API_KEY" ]; then echo "Not logged in"; exit 1; fi',
    '    case "${TEST_ABOUT:-ok}" in',
    '      ok) echo "User Email          t@example.com" ;;',
    '      invalid) echo "The provided API key is invalid." >&2; exit 1 ;;',
    '      *) echo "User Email          Not logged in" ;;',
    "    esac ;;",
    '  *) echo "unsupported: $*" >&2; exit 2 ;;',
    "esac",
    "",
  ].join("\n");
}

/** A small package shaped like a real one: one top folder, the launcher, and a data file. */
export function testPackage(options: { version?: string; versionExit?: number; launcher?: string } = {}): Buffer {
  return buildTarGz([
    { name: "dist-package/", type: "5" },
    { name: `dist-package/${options.launcher ?? "tool"}`, data: launcherScript(options), mode: 0o755 },
    { name: "dist-package/lib/", type: "5" },
    { name: "dist-package/lib/data.txt", data: "payload ".repeat(400) },
  ]);
}

/** A package whose tar stream is cut short, still valid gzip. */
export function truncatedPackage(): Buffer {
  const tar = buildTar([{ name: "dist-package/tool", data: "x".repeat(4000), mode: 0o755 }]);
  return gzipSync(tar.subarray(0, 2048));
}

export const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** The sum of the file sizes in `testPackage`. */
export function unpackedSize(options: { version?: string; versionExit?: number } = {}): number {
  return Buffer.byteLength(launcherScript(options)) + Buffer.byteLength("payload ".repeat(400));
}

export function testSpec(pkg: Buffer, overrides: Partial<ManagedInstallSpec> & { url?: string; unpackedBytes?: number; sha?: string; bytes?: number } = {}): ManagedInstallSpec {
  const { url, unpackedBytes, sha, bytes, ...rest } = overrides;
  return {
    version: TEST_VERSION,
    origin: TEST_ORIGIN,
    platforms: {
      "linux-x64": {
        url: url ?? `${TEST_ORIGIN}/lab/${TEST_VERSION}/linux/x64/pkg.tar.gz`,
        sha256: sha ?? sha256(pkg),
        bytes: bytes ?? pkg.length,
        unpackedBytes: unpackedBytes ?? unpackedSize(),
      },
    },
    stripComponents: 1,
    launcher: "tool",
    docsUrl: "https://docs.test/setup.md#install-the-requirements",
    ...rest,
  };
}

/** What the stub answers for one request. */
export type StubAnswer =
  | { kind: "body"; body: Buffer; status?: number; headers?: Record<string, string>; chunked?: boolean }
  | { kind: "slow"; body: Buffer; chunk: number; delayMs: number }
  | { kind: "redirect"; location: string }
  | { kind: "status"; status: number };

export type PackageStub = {
  url: string;
  requests: string[];
  answer: (answer: StubAnswer) => void;
  /** `fetch` that sends the test origin to the stub, keeping every option (such as `redirect`). */
  fetch: typeof fetch;
  close: () => Promise<void>;
};

export async function startPackageStub(): Promise<PackageStub> {
  let current: StubAnswer = { kind: "status", status: 404 };
  const requests: string[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requests.push(`${req.method} ${req.url}`);
    const answer = current;
    if (answer.kind === "status") {
      res.writeHead(answer.status).end();
    } else if (answer.kind === "redirect") {
      res.writeHead(302, { location: answer.location }).end();
    } else if (answer.kind === "body") {
      const headers: Record<string, string> = { "content-type": "application/x-tar", ...answer.headers };
      if (!answer.chunked && !headers["content-length"]) headers["content-length"] = String(answer.body.length);
      res.writeHead(answer.status ?? 200, headers);
      res.end(answer.body);
    } else {
      res.writeHead(200, { "content-length": String(answer.body.length) });
      let at = 0;
      const timer = setInterval(() => {
        if (res.destroyed || at >= answer.body.length) {
          clearInterval(timer);
          res.end();
          return;
        }
        res.write(answer.body.subarray(at, at + answer.chunk));
        at += answer.chunk;
      }, answer.delayMs);
      res.on("close", () => clearInterval(timer));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const stubFetch = ((input: string | URL | Request, init?: RequestInit) => {
    const target = String(input instanceof Request ? input.url : input);
    return fetch(target.startsWith(TEST_ORIGIN) ? url + target.slice(TEST_ORIGIN.length) : target, init);
  }) as typeof fetch;
  return {
    url,
    requests,
    answer: (answer) => {
      current = answer;
    },
    fetch: stubFetch,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
