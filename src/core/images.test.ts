import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { IMAGE_FRESHNESS_MS, sniffImageMime, takeHostImages } from "./images.ts";

const scratch = mkdtempSync(join(tmpdir(), "oac-images-"));
const uid = process.getuid!();
// The host's real rule: `<tmp>/openclaw-<uid>/openclaw-cli-images`. Created here only when it is missing.
const hostRoot = join(tmpdir(), `openclaw-${uid}`);
const createdHostRoot = !existsSync(hostRoot);
const defaultDir = join(hostRoot, "openclaw-cli-images");
mkdirSync(defaultDir, { recursive: true, mode: 0o700 });
const injected = join(scratch, "openclaw", "openclaw-cli-images");
mkdirSync(injected, { recursive: true, mode: 0o700 });
chmodSync(join(scratch, "openclaw"), 0o700);
const made: string[] = [];
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  for (const file of made) rmSync(file, { force: true });
  if (createdHostRoot) rmSync(hostRoot, { recursive: true, force: true });
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png-body")]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg-body")]);
const GIF = Buffer.from("GIF89a-gif-body");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBPVP8 body")]);
const BMP = Buffer.concat([Buffer.from("BM"), Buffer.alloc(40, 1)]);
const MiB = 1024 * 1024;
const pngOfSize = (bytes: number) => Buffer.concat([PNG, Buffer.alloc(Math.max(0, bytes - PNG.length), 3)]);

let counter = 0;
const nameFor = () => `${createHash("sha256").update(`${counter++}`).digest("hex")}.png`;
/** A file named like the host's cache entries in `dir` (default: the injected root); returns its path. */
function put(bytes: Buffer, ext = "png", dir = injected): string {
  const file = join(dir, nameFor().replace(/\.png$/, `.${ext}`));
  writeFileSync(file, bytes, { mode: 0o600 });
  if (dir === defaultDir) made.push(file);
  return file;
}
const putDefault = (bytes: Buffer = PNG) => put(bytes, "png", defaultDir);
const base = (file: string) => file.split("/").at(-1)!;
const withText = (text: string, ...paths: string[]) => `${text}\n\n${paths.join("\n")}`;
const take = (prompt: string, extra: Parameters<typeof takeHostImages>[1] = {}) => takeHostImages(prompt, { roots: [injected], ...extra });
const takeDefault = (prompt: string, extra: Parameters<typeof takeHostImages>[1] = {}) => takeHostImages(prompt, extra);
const NOTE = "[OpenClaw] An attached image was not passed to the model: ";
const TELL = " Tell the user it could not be used.";
const unchangedOf = (prompt: string) => ({ text: prompt, images: [] });

describe("takeHostImages", () => {
  it("takes one image off the end and keeps the text", async () => {
    const result = await take(withText("What is this?", put(PNG)));
    expect(result.text).toBe("What is this?");
    expect(result.images).toEqual([{ mimeType: "image/png", data: PNG.toString("base64") }]);
  });

  it("takes many images in path order", async () => {
    const result = await take(withText("Compare", put(PNG), put(JPEG, "jpg"), put(GIF, "gif")));
    expect(result.text).toBe("Compare");
    expect(result.images.map((image) => image.mimeType)).toEqual(["image/png", "image/jpeg", "image/gif"]);
  });

  it("takes a prompt that is only the block", async () => {
    const result = await take([put(PNG), put(JPEG, "jpg")].join("\n"));
    expect(result.text).toBe("");
    expect(result.images).toHaveLength(2);
  });

  it("ignores trailing blank lines after the block", async () => {
    const result = await take(`${withText("Hi", put(PNG))}\n\n  \n`);
    expect(result.text).toBe("Hi");
    expect(result.images).toHaveLength(1);
  });

  it("needs an empty line before the block unless the block is the whole prompt", async () => {
    const prompt = `Look at this\n${put(PNG)}`;
    expect(await take(prompt)).toEqual(unchangedOf(prompt));
  });

  it("leaves a cache path in the middle of the text alone", async () => {
    const prompt = `Is ${put(PNG)} a good file?\n\nAnd this is the end.`;
    expect(await take(prompt)).toEqual(unchangedOf(prompt));
    const midway = `${put(PNG)}\n\nMore text after it`;
    expect(await take(midway)).toEqual(unchangedOf(midway));
  });

  describe("the host's own rule (no injected roots)", () => {
    it("takes a block under <tmp>/openclaw-<uid>", async () => {
      const result = await takeDefault(withText("Hi", putDefault()));
      expect(result.text).toBe("Hi");
      expect(result.images).toHaveLength(1);
    });

    // A prompt that is not the host's block reads nothing: not even the first step on a file runs.
    const unchanged = async (prompt: string) => {
      const touched: string[] = [];
      expect(await takeDefault(prompt, { hooks: { afterLstat: (f) => void touched.push(f) } })).toEqual(unchangedOf(prompt));
      expect(touched).toEqual([]);
    };
    const sub = (...parts: string[]) => join(tmpdir(), ...parts);

    it("rejects a '..', a '.', and a doubled slash", async () => {
      const name = base(putDefault());
      await unchanged(withText("x", `${hostRoot}/../openclaw-${uid}/openclaw-cli-images/${name}`));
      await unchanged(withText("x", `${hostRoot}/./openclaw-cli-images/${name}`));
      await unchanged(withText("x", `${hostRoot}//openclaw-cli-images/${name}`));
    });
    it("rejects a relative path", async () => {
      const name = base(putDefault());
      await unchanged(withText("x", `openclaw-cli-images/${name}`));
      await unchanged(withText("x", name));
    });
    it("rejects a workspace .openclaw-cli-images", async () => {
      const dir = join(scratch, "workspace", ".openclaw-cli-images");
      mkdirSync(dir, { recursive: true });
      await unchanged(withText("x", put(PNG, "png", dir)));
    });
    it("rejects a cache directory under a root that is not openclaw or openclaw-<uid>", async () => {
      const dir = sub("evil-oac", "openclaw-cli-images");
      mkdirSync(dir, { recursive: true });
      try {
        await unchanged(withText("x", put(PNG, "png", dir)));
      } finally {
        rmSync(sub("evil-oac"), { recursive: true, force: true });
      }
    });
    it("rejects openclaw-<other uid>, and openclaw-<uid> with extra digits", async () => {
      for (const name of [`openclaw-${uid + 1}`, `openclaw-${uid}0`]) {
        const dir = sub(name, "openclaw-cli-images");
        mkdirSync(dir, { recursive: true });
        try {
          await unchanged(withText("x", put(PNG, "png", dir)));
        } finally {
          rmSync(sub(name), { recursive: true, force: true });
        }
      }
    });
    it("rejects a root that is not directly under the temp dir", async () => {
      const dir = join(scratch, `openclaw-${uid}`, "openclaw-cli-images");
      mkdirSync(dir, { recursive: true });
      await unchanged(withText("x", put(PNG, "png", dir)));
    });
    it("rejects a directory of another name", async () => {
      const dir = join(hostRoot, "other-images");
      mkdirSync(dir, { recursive: true });
      try {
        await unchanged(withText("x", put(PNG, "png", dir)));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
    it("rejects a bad file name", async () => {
      for (const name of ["photo.png", `${"a".repeat(63)}.png`, `${"A".repeat(64)}.png`, "a".repeat(64), `${"a".repeat(64)}.png.exe`]) {
        const file = join(defaultDir, name);
        writeFileSync(file, PNG);
        made.push(file);
        await unchanged(withText("x", file));
      }
    });
    it("takes nothing when one line of the block fails", async () => {
      await unchanged(withText("x", putDefault(), `${hostRoot}/../x.png`, putDefault()));
      await unchanged(withText("x", putDefault(), "also a sentence"));
    });
  });

  describe("this turn's files (freshness)", () => {
    const now = Date.now();
    it("takes a file written within the window", async () => {
      const result = await take(withText("x", put(PNG)), { notBefore: now - IMAGE_FRESHNESS_MS });
      expect(result.images).toHaveLength(1);
    });
    it("leaves a typed path to an older cache file as text", async () => {
      const file = put(PNG);
      const old = new Date(now - 10 * 60_000);
      utimesSync(file, old, old);
      const prompt = withText("Look at this", file);
      expect(await take(prompt, { notBefore: now - IMAGE_FRESHNESS_MS })).toEqual(unchangedOf(prompt));
    });
    it("leaves a typed path to a file that does not exist as text, with no note", async () => {
      const prompt = withText("Look at this", join(injected, nameFor()));
      expect(await take(prompt, { notBefore: now - IMAGE_FRESHNESS_MS })).toEqual(unchangedOf(prompt));
    });
    it("takes nothing when one file of the block is stale", async () => {
      const stale = put(PNG);
      const old = new Date(now - 10 * 60_000);
      utimesSync(stale, old, old);
      const prompt = withText("x", put(PNG), stale);
      expect(await take(prompt, { notBefore: now - IMAGE_FRESHNESS_MS })).toEqual(unchangedOf(prompt));
    });
  });

  describe("no process uid (Windows)", () => {
    it("leaves the prompt as it is, reads nothing, and warns once", async () => {
      const prompt = withText("x", put(PNG));
      const warns: string[] = [];
      expect(await take(prompt, { uid: undefined, warn: (m) => warns.push(m) })).toEqual(unchangedOf(prompt));
      expect(warns).toHaveLength(1);
      expect(warns[0]).not.toContain(injected);
    });
    it("does not warn for a prompt that is not a host block", async () => {
      const warns: string[] = [];
      await take("just text", { uid: undefined, warn: (m) => warns.push(m) });
      expect(warns).toEqual([]);
    });
  });

  describe("delivery: a member that fails becomes a note", () => {
    it("refuses a symlink before it opens it, also one to a real image", async () => {
      const target = join(scratch, "secret.png");
      writeFileSync(target, PNG);
      const link = join(injected, nameFor());
      symlinkSync(target, link);
      const opened: string[] = [];
      const warns: string[] = [];
      const result = await take(withText("x", link), { warn: (m) => warns.push(m), hooks: { afterLstat: (f) => void opened.push(f) } });
      expect(result.images).toEqual([]);
      expect(result.text).toBe(`x\n\n${NOTE}could not be read.${TELL}`);
      expect(warns).toHaveLength(1);
      // The lstat guard stopped it: the step after a passed lstat never ran.
      expect(opened).toEqual([]);
    });

    it("refuses a link swapped in after the lstat (O_NOFOLLOW)", async () => {
      const target = join(scratch, "other-secret.png");
      writeFileSync(target, PNG);
      const file = put(PNG);
      const result = await take(withText("x", file), {
        hooks: {
          afterLstat: (f) => {
            rmSync(f);
            symlinkSync(target, f);
          },
        },
      });
      expect(result.images).toEqual([]);
      expect(result.text).toContain("could not be read");
    });

    it("retries once when the host rewrote the file between the steps, and reads the new file", async () => {
      const file = put(PNG);
      let swaps = 0;
      const result = await take(withText("x", file), {
        hooks: {
          afterLstat: (f) => {
            if (swaps++ > 0) return;
            writeFileSync(`${f}.tmp`, JPEG, { mode: 0o600 });
            renameSync(`${f}.tmp`, f);
          },
        },
      });
      expect(swaps).toBe(2);
      expect(result.images.map((image) => image.mimeType)).toEqual(["image/jpeg"]);
    });

    it("fails when the file keeps changing under the read (descriptor check)", async () => {
      const file = put(PNG);
      const result = await take(withText("x", file), {
        hooks: {
          afterLstat: (f) => {
            writeFileSync(`${f}.tmp`, JPEG, { mode: 0o600 });
            renameSync(`${f}.tmp`, f);
          },
        },
      });
      expect(result.images).toEqual([]);
      expect(result.text).toContain("could not be read");
    });

    it("refuses a file owned by another uid", async () => {
      const result = await take(withText("x", put(PNG)), { uid: uid + 1 });
      expect(result.images).toEqual([]);
      expect(result.text).toBe(`x\n\n${NOTE}could not be read.${TELL}`);
    });

    it("refuses a file with a second hard link", async () => {
      const file = put(PNG);
      linkSync(file, join(scratch, "hardlink.png"));
      const result = await take(withText("x", file));
      expect(result.images).toEqual([]);
      expect(result.text).toContain("could not be read");
    });

    it("refuses a cache directory that is a link elsewhere", async () => {
      const real = join(scratch, "real-dir");
      mkdirSync(real);
      const linked = join(scratch, "linked", "openclaw-cli-images");
      mkdirSync(join(scratch, "linked"));
      symlinkSync(real, linked);
      const file = put(PNG, "png", real);
      const result = await takeHostImages(withText("x", join(linked, base(file))), { roots: [linked] });
      expect(result.images).toEqual([]);
      expect(result.text).toBe(`x\n\n${NOTE}could not be read.${TELL}`);
    });

    it("refuses a cache directory others can write to, and one the process does not own", async () => {
      const open = join(scratch, "open-root", "openclaw-cli-images");
      mkdirSync(open, { recursive: true });
      chmodSync(open, 0o777);
      const a = await takeHostImages(withText("x", put(PNG, "png", open)), { roots: [open] });
      expect(a.images).toEqual([]);
      expect(a.text).toContain("could not be read");
      const parent = join(scratch, "open-parent", "openclaw-cli-images");
      mkdirSync(parent, { recursive: true });
      chmodSync(join(scratch, "open-parent"), 0o777);
      const b = await takeHostImages(withText("x", put(PNG, "png", parent)), { roots: [parent] });
      expect(b.images).toEqual([]);
      const c = await take(withText("x", put(PNG)), { uid: uid + 1 });
      expect(c.images).toEqual([]);
    });

    it("refuses a directory entry that is not a regular file, and a FIFO swapped in after the lstat without hanging", async () => {
      const dirAsFile = join(injected, nameFor());
      mkdirSync(dirAsFile);
      expect((await take(withText("x", dirAsFile))).text).toContain("could not be read");
      const file = put(PNG);
      const result = await take(withText("x", file), {
        hooks: {
          afterLstat: (f) => {
            rmSync(f);
            execFileSync("mkfifo", [f]);
          },
        },
      });
      expect(result.images).toEqual([]);
      expect(result.text).toContain("could not be read");
    });

    it("sends the other images of the block", async () => {
      const result = await take(withText("x", put(Buffer.from("not an image at all")), put(PNG)));
      expect(result.images).toHaveLength(1);
      expect(result.text).toBe(`x\n\n${NOTE}unsupported type.${TELL}`);
    });

    it("reports a file that vanishes between the checks", async () => {
      const file = put(PNG);
      const result = await take(withText("x", file), { hooks: { afterLstat: (f) => rmSync(f) } });
      expect(result.text).toBe(`x\n\n${NOTE}no longer available.${TELL}`);
    });

    it("reports a file truncated between the stat and the read", async () => {
      const file = put(pngOfSize(5000));
      const result = await take(withText("x", file), { hooks: { afterStat: (f) => truncateSync(f, 10) } });
      expect(result.images).toEqual([]);
      expect(result.text).toBe(`x\n\n${NOTE}could not be read.${TELL}`);
    });

    it("gives only notes when the prompt had no text", async () => {
      const result = await take(put(Buffer.from("junk")));
      expect(result.text).toBe(`${NOTE}unsupported type.${TELL}`);
    });

    it("gives a zero-byte file its own note", async () => {
      const result = await take(withText("x", put(Buffer.alloc(0))));
      expect(result.text).toBe(`x\n\n${NOTE}empty file.${TELL}`);
    });
  });

  describe("type by magic bytes", () => {
    it.each([
      ["png", PNG, "image/png"],
      ["jpeg", JPEG, "image/jpeg"],
      ["gif", GIF, "image/gif"],
      ["webp", WEBP, "image/webp"],
      ["bmp", BMP, "image/bmp"],
    ])("recognizes %s", async (_name, bytes, mime) => {
      expect(sniffImageMime(bytes)).toBe(mime);
      expect((await take(withText("x", put(bytes)))).images[0]?.mimeType).toBe(mime);
    });

    it("uses the bytes, not the extension", async () => {
      expect((await take(withText("x", put(JPEG, "png")))).images[0]?.mimeType).toBe("image/jpeg");
      expect((await take(withText("x", put(PNG, "jpg")))).images[0]?.mimeType).toBe("image/png");
    });

    it.each([
      ["heic", Buffer.concat([Buffer.alloc(4), Buffer.from("ftypheic"), Buffer.alloc(20)])],
      ["avif", Buffer.concat([Buffer.alloc(4), Buffer.from("ftypavif"), Buffer.alloc(20)])],
      ["svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
      ["tiff", Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), Buffer.alloc(20)])],
      ["text", Buffer.from("plain text, not an image")],
    ])("does not send %s", async (_name, bytes) => {
      const warns: string[] = [];
      const result = await take(withText("x", put(bytes, "png")), { warn: (m) => warns.push(m) });
      expect(result.images).toEqual([]);
      expect(result.text).toBe(`x\n\n${NOTE}unsupported type.${TELL}`);
      expect(warns).toEqual(["image not sent: unsupported type"]);
    });
  });

  describe("size caps", () => {
    it("does not send an image over the per-image cap", async () => {
      const result = await take(withText("x", put(pngOfSize(200))), { limits: { maxBytes: 100 } });
      expect(result.images).toEqual([]);
      expect(result.text).toBe(`x\n\n${NOTE}too large.${TELL}`);
    });

    it("applies 10 MiB by default", async () => {
      const result = await take(withText("x", put(pngOfSize(10 * MiB + 1))));
      expect(result.images).toEqual([]);
      expect(result.text).toContain("too large");
      expect((await take(withText("x", put(pngOfSize(10 * MiB))))).images).toHaveLength(1);
    });

    it("applies 10 images by default and notes the rest", async () => {
      const files = Array.from({ length: 12 }, () => put(PNG));
      const result = await take(withText("x", ...files));
      expect(result.images).toHaveLength(10);
      expect(result.text).toBe(`x\n\n[OpenClaw] 2 attached images were not passed to the model: too many images (limit 10).${TELL}`);
    });

    it("applies 20 MiB in all by default", async () => {
      const files = [put(pngOfSize(9 * MiB)), put(pngOfSize(9 * MiB)), put(pngOfSize(9 * MiB))];
      const result = await take(withText("x", ...files));
      expect(result.images).toHaveLength(2);
      expect(result.text).toBe(`x\n\n${NOTE}over the total size limit.${TELL}`);
    });

    it("names a single image that is left out for the count", async () => {
      const result = await take(withText("x", put(PNG), put(PNG)), { limits: { maxCount: 1 } });
      expect(result.text).toBe(`x\n\n[OpenClaw] An attached image was not passed to the model: too many images (limit 1).${TELL}`);
    });

    it("does not let one image that is too big for the rest of the budget drop the smaller ones after it", async () => {
      const files = [9, 9, 3, 0.1, 0.1].map((mib) => put(pngOfSize(Math.round(mib * MiB))));
      const result = await take(withText("x", ...files));
      expect(result.images).toHaveLength(4);
      expect(result.text).toBe(`x\n\n${NOTE}over the total size limit.${TELL}`);
    });

    it("does not count a failed image toward the count", async () => {
      const result = await take(withText("x", put(Buffer.from("junk")), put(PNG), put(PNG)), { limits: { maxCount: 2 } });
      expect(result.images).toHaveLength(2);
      expect(result.text).toBe(`x\n\n${NOTE}unsupported type.${TELL}`);
    });

    it("leaves a block longer than the count limit plus a margin as text, reading nothing", async () => {
      const prompt = withText("x", ...Array.from({ length: 30 }, () => put(PNG)));
      expect(await take(prompt)).toEqual(unchangedOf(prompt));
    });
  });

  describe("abort", () => {
    it("throws when the signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(take(withText("x", put(PNG)), { signal: controller.signal })).rejects.toThrow();
    });

    it("throws when the signal fires between files", async () => {
      const controller = new AbortController();
      const result = take(withText("x", put(Buffer.from("junk")), put(PNG)), { signal: controller.signal, warn: () => controller.abort() });
      await expect(result).rejects.toThrow();
    });

    it("throws when the signal fires during a read", async () => {
      const controller = new AbortController();
      const result = take(withText("x", put(PNG)), { signal: controller.signal, hooks: { afterStat: () => controller.abort() } });
      await expect(result).rejects.toThrow();
    });
  });

  describe("speed", () => {
    it("handles a huge whitespace prompt in linear time", async () => {
      for (const prompt of [" ".repeat(200_000), `text${" ".repeat(200_000)}`, `${" \n".repeat(100_000)}x`, `a\n\n${" ".repeat(200_000)}\n\nb`, `a\n\n${" ".repeat(200_000)}x\n\nb`, `${" ".repeat(200_000)}x\n\nb`, "x\n".repeat(200_000)]) {
        const start = performance.now();
        await take(prompt);
        expect(performance.now() - start).toBeLessThan(100);
      }
    });
  });

  describe("logs and notes", () => {
    it("hold no path, no file name, and no base64, for every kind of failure", async () => {
      const target = join(scratch, "log-target.png");
      writeFileSync(target, PNG);
      const link = join(injected, nameFor());
      symlinkSync(target, link);
      const vanishing = put(PNG);
      const files = [
        link,
        put(Buffer.from("junk")),
        put(Buffer.alloc(0)),
        put(pngOfSize(600)),
        vanishing,
        put(PNG),
        put(pngOfSize(300)),
      ];
      const warns: string[] = [];
      const result = await take(withText("hello", ...files), {
        limits: { maxBytes: 500, maxTotalBytes: PNG.length + 400, maxCount: 2 },
        warn: (m) => warns.push(m),
        hooks: { afterLstat: (f) => (f === vanishing ? rmSync(f) : undefined) },
      });
      const kinds = ["could not be read", "unsupported type", "empty file", "too large", "no longer available", "over the total size limit", "too many images"];
      expect(result.images.length).toBeGreaterThan(0);
      for (const kind of kinds.slice(0, 5)) expect(result.text, kind).toContain(kind);
      expect(warns.length).toBeGreaterThanOrEqual(5);
      for (const line of [...result.text.split("\n"), ...warns]) {
        expect(line).not.toContain(injected);
        expect(line).not.toContain(scratch);
        expect(line).not.toMatch(/[0-9a-f]{40}/);
        expect(line).not.toMatch(/[A-Za-z0-9+/]{30,}={0,2}/);
        for (const image of result.images) expect(line).not.toContain(image.data);
      }
      // The total-size and count notes: a separate run, same rule.
      const more = [put(pngOfSize(400)), put(pngOfSize(400)), put(PNG), put(PNG), put(PNG)];
      const second = await take(withText("hello", ...more), { limits: { maxTotalBytes: 600, maxCount: 2 }, warn: (m) => warns.push(m) });
      expect(second.text).toContain("over the total size limit");
      expect(second.text).toContain("too many images");
      expect(`${second.text}\n${warns.join("\n")}`).not.toContain(injected);
    });

    it("keeps errors free of paths too", async () => {
      const controller = new AbortController();
      controller.abort();
      const error = await take(withText("x", put(PNG)), { signal: controller.signal }).catch((e: Error) => e);
      expect(String((error as Error).message)).not.toContain(injected);
    });
  });
});
