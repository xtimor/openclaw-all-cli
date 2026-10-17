import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJsonObject, writeJsonAtomic } from "./files.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oac-files-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeJsonAtomic", () => {
  it("creates parent directories and writes the JSON", async () => {
    const file = join(dir, "a", "b", "c.json");
    await writeJsonAtomic(file, { x: 1 });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ x: 1 });
  });

  it("leaves no temp file behind", async () => {
    const file = join(dir, "c.json");
    await writeJsonAtomic(file, { x: 1 });
    await writeJsonAtomic(file, { x: 2 });
    expect(readdirSync(dir)).toEqual(["c.json"]);
  });

  it("cleans up its temp file when the rename fails", async () => {
    // The target is a non-empty directory, so rename cannot replace it.
    const file = join(dir, "target");
    await writeJsonAtomic(join(file, "inner.json"), {});
    await expect(writeJsonAtomic(file, { x: 1 })).rejects.toThrow();
    expect(readdirSync(dir)).toEqual(["target"]);
  });

  it("never exposes a partial file to parallel writers and readers", async () => {
    const file = join(dir, "c.json");
    const big = (n: number) => ({ n, pad: "x".repeat(200_000) });
    let stop = false;
    const reads: Array<Record<string, unknown> | undefined> = [];
    const reader = (async () => {
      while (!stop) {
        const raw = (() => {
          try {
            return readFileSync(file, "utf8");
          } catch {
            return undefined;
          }
        })();
        if (raw !== undefined) reads.push(JSON.parse(raw) as Record<string, unknown>);
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    await Promise.all(Array.from({ length: 20 }, (_, n) => writeJsonAtomic(file, big(n))));
    stop = true;
    await reader;
    expect(reads.length).toBeGreaterThan(0);
    expect(readdirSync(dir)).toEqual(["c.json"]);
    expect((JSON.parse(readFileSync(file, "utf8")) as { pad: string }).pad).toHaveLength(200_000);
  });
});

describe("readJsonObject", () => {
  it("reads an object", async () => {
    const file = join(dir, "o.json");
    writeFileSync(file, '{"a":1}');
    await expect(readJsonObject(file)).resolves.toEqual({ a: 1 });
  });

  it.each([["missing", undefined], ["invalid", "{nope"], ["an array", "[1]"], ["a string", '"x"'], ["null", "null"]])(
    "reads %s as undefined",
    async (_name, content) => {
      const file = join(dir, "o.json");
      if (content !== undefined) writeFileSync(file, content);
      await expect(readJsonObject(file)).resolves.toBeUndefined();
    },
  );
});
