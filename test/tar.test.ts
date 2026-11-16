import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { extractTarGz, TarError } from "../src/core/tar.ts";
import { buildTar, buildTarGz, type TarEntry } from "./fixtures/tar-builder.ts";

const dirs: string[] = [];
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "oac-tar-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const LIMITS = { maxBytes: 1024 * 1024, maxEntries: 100 };

/** Feeds the archive in small chunks, so entries straddle chunk edges. */
async function* chunks(data: Buffer, size = 97) {
  for (let at = 0; at < data.length; at += size) yield data.subarray(at, at + size);
}

const unpack = (entries: readonly TarEntry[], options: { strip?: number; limits?: typeof LIMITS & { maxDepth?: number } } = {}) => {
  const dest = fresh();
  const result = extractTarGz(chunks(buildTarGz(entries)), {
    dest,
    stripComponents: options.strip ?? 0,
    limits: options.limits ?? LIMITS,
  });
  return { dest, result };
};

const reasonOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TarError) return error.reason;
    throw error;
  }
  return "ok";
};

describe("extractTarGz", () => {
  it("unpacks files and directories, strips the leading folder, and keeps executable bits", async () => {
    const { dest, result } = unpack(
      [
        { name: "pkg/", type: "5" },
        { name: "pkg/bin/", type: "5" },
        { name: "pkg/run", data: "#!/bin/sh\necho hi\n", mode: 0o755 },
        { name: "pkg/bin/tool", data: "x".repeat(1500), mode: 0o700 },
        { name: "pkg/README", data: "read me", mode: 0o600 },
      ],
      { strip: 1 },
    );
    expect(await result).toEqual({ entries: 5, bytes: 18 + 1500 + 7 });
    expect(readFileSync(join(dest, "run"), "utf8")).toContain("echo hi");
    expect(statSync(join(dest, "run")).mode & 0o777).toBe(0o755);
    expect(statSync(join(dest, "bin/tool")).mode & 0o777).toBe(0o755);
    expect(statSync(join(dest, "README")).mode & 0o777).toBe(0o644);
    expect(readFileSync(join(dest, "bin/tool"), "utf8")).toHaveLength(1500);
    expect(readdirSync(dest).toSorted()).toEqual(["README", "bin", "run"]);
  });

  it("reads ustar prefix, GNU long names, and pax paths", async () => {
    const long = `pkg/${"d".repeat(60)}/${"e".repeat(60)}/file.txt`;
    const { dest, result } = unpack(
      [
        { name: "pkg/a/b/prefixed.txt", data: "p", usePrefix: true },
        { name: long, data: "g", gnuLongName: true },
        { name: "pkg/pax/name.txt", data: "x", paxPath: true },
      ],
      { strip: 1 },
    );
    await result;
    expect(readFileSync(join(dest, "a/b/prefixed.txt"), "utf8")).toBe("p");
    expect(readFileSync(join(dest, long.slice(4)), "utf8")).toBe("g");
    expect(readFileSync(join(dest, "pax/name.txt"), "utf8")).toBe("x");
  });

  it("only counts when no destination is given", async () => {
    const data = buildTarGz([{ name: "pkg/a", data: "abc" }, { name: "pkg/b/", type: "5" }]);
    expect(await extractTarGz(chunks(data), { limits: LIMITS })).toEqual({ entries: 2, bytes: 3 });
  });

  it.each([
    ["an absolute path", { name: "/etc/passwd", data: "x" }],
    ["a path with ..", { name: "pkg/../../escape", data: "x" }],
    ["a backslash path", { name: "pkg\\..\\escape", data: "x" }],
  ])("refuses %s and writes nothing outside the target", async (_label, entry) => {
    const { dest, result } = unpack([entry]);
    expect(await reasonOf(result)).toBe("unsafe-path");
    expect(existsSync(join(dest, "..", "escape"))).toBe(false);
  });

  it.each([
    ["a symlink", { name: "pkg/link", type: "2", linkname: "/etc/passwd" }],
    ["a hard link", { name: "pkg/hard", type: "1", linkname: "pkg/run" }],
    ["a device", { name: "pkg/dev", type: "3" }],
    ["a fifo", { name: "pkg/fifo", type: "6" }],
  ])("refuses %s", async (_label, entry) => {
    expect(await reasonOf(unpack([entry]).result)).toBe("unsupported-entry");
  });

  it("refuses a package over the byte, entry, or depth limit", async () => {
    expect(await reasonOf(unpack([{ name: "a", data: "x".repeat(200) }], { limits: { maxBytes: 100, maxEntries: 10 } }).result)).toBe("limit");
    const many = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, data: "x" }));
    expect(await reasonOf(unpack(many, { limits: { maxBytes: 100, maxEntries: 4 } }).result)).toBe("limit");
    expect(await reasonOf(unpack([{ name: "a/b/c/d", data: "x" }], { limits: { ...LIMITS, maxDepth: 3 } }).result)).toBe("limit");
  });

  it("refuses a header that claims more data than the limit before writing it", async () => {
    const dest = fresh();
    const data = buildTarGz([{ name: "big", data: "x", headerSize: 10_000_000 }]);
    expect(await reasonOf(extractTarGz(chunks(data), { dest, limits: LIMITS }))).toBe("limit");
    expect(existsSync(join(dest, "big"))).toBe(false);
  });

  it("refuses a truncated archive, a damaged header, a non-gzip stream, and a duplicate path", async () => {
    const whole = buildTar([{ name: "a", data: "x".repeat(3000) }]);
    const cut = gzipSync(whole.subarray(0, 2048));
    expect(await reasonOf(extractTarGz(chunks(cut), { dest: fresh(), limits: LIMITS }))).toBe("truncated");
    const gz = buildTarGz([{ name: "a", data: "x".repeat(3000) }]);
    expect(await reasonOf(extractTarGz(chunks(gz.subarray(0, gz.length - 20)), { dest: fresh(), limits: LIMITS }))).toBe("truncated");
    const damaged = Buffer.from(whole);
    damaged[10] = 0x41;
    expect(await reasonOf(extractTarGz(chunks(gzipSync(damaged)), { dest: fresh(), limits: LIMITS }))).toBe("corrupt");
    expect(await reasonOf(extractTarGz(chunks(Buffer.from("not gzip at all, just text")), { dest: fresh(), limits: LIMITS }))).toBe("corrupt");
    expect(await reasonOf(unpack([{ name: "a", data: "1" }, { name: "a", data: "2" }]).result)).toBe("duplicate");
    expect(await reasonOf(extractTarGz(chunks(buildTarGz([{ name: "a", data: "x" }], { end: false })), { dest: fresh(), limits: LIMITS }))).toBe(
      "truncated",
    );
  });

  it("stops with the signal's reason on abort", async () => {
    const controller = new AbortController();
    const reason = new Error("stopped");
    controller.abort(reason);
    const data = buildTarGz([{ name: "a", data: "x" }]);
    await expect(extractTarGz(chunks(data), { dest: fresh(), limits: LIMITS, signal: controller.signal })).rejects.toBe(reason);
  });
});
