import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sniffImageMime, takeHostImages } from "./images.ts";

const scratch = mkdtempSync(join(tmpdir(), "oac-images-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const root = join(scratch, "openclaw", "openclaw-cli-images");
mkdirSync(root, { recursive: true, mode: 0o700 });
const uid = process.getuid!();

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png-body")]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg-body")]);
const GIF = Buffer.from("GIF89a-gif-body");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBPVP8 body")]);
const BMP = Buffer.concat([Buffer.from("BM"), Buffer.alloc(40, 1)]);

let counter = 0;
/** A file named like the host's cache entries; returns its path. */
function put(bytes: Buffer, ext = "png", dir = root): string {
  counter += 1;
  const name = `${createHash("sha256").update(`${counter}`).digest("hex")}.${ext}`;
  const file = join(dir, name);
  writeFileSync(file, bytes, { mode: 0o600 });
  return file;
}
const block = (...paths: string[]) => paths.join("\n");
const withText = (text: string, ...paths: string[]) => `${text}\n\n${block(...paths)}`;
const take = (prompt: string, extra: Parameters<typeof takeHostImages>[1] = {}) => takeHostImages(prompt, { roots: [root], ...extra });
const NOTE = "[OpenClaw] An attached image was not passed to the model: ";

describe("takeHostImages", () => {
  it("takes one image off the end and keeps the text", async () => {
    const file = put(PNG);
    const result = await take(withText("What is this?", file));
    expect(result.text).toBe("What is this?");
    expect(result.images).toEqual([{ mimeType: "image/png", data: PNG.toString("base64") }]);
  });

  it("takes many images in path order", async () => {
    const files = [put(PNG), put(JPEG, "jpg"), put(GIF, "gif")];
    const result = await take(withText("Compare", ...files));
    expect(result.text).toBe("Compare");
    expect(result.images.map((image) => image.mimeType)).toEqual(["image/png", "image/jpeg", "image/gif"]);
  });

  it("takes a prompt that is only the block", async () => {
    const result = await take(block(put(PNG), put(JPEG, "jpg")));
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
    expect(await take(prompt)).toEqual({ text: prompt, images: [] });
  });

  it("leaves a cache path in the middle of the text alone", async () => {
    const prompt = `Is ${put(PNG)} a good file?\n\nAnd this is the end.`;
    expect(await take(prompt)).toEqual({ text: prompt, images: [] });
    const midway = `${put(PNG)}\n\nMore text after it`;
    expect(await take(midway)).toEqual({ text: midway, images: [] });
  });

  describe("block membership: not a host block, prompt unchanged", () => {
    const good = () => put(PNG);
    const unchanged = async (prompt: string, options: Parameters<typeof takeHostImages>[1] = {}) => {
      expect(await take(prompt, options)).toEqual({ text: prompt, images: [] });
    };

    it("rejects a '..' segment", async () => {
      const file = good();
      await unchanged(withText("x", `${root}/../openclaw-cli-images/${file.split("/").at(-1)!}`));
    });
    it("rejects a '.' segment and a doubled slash", async () => {
      const name = good().split("/").at(-1)!;
      await unchanged(withText("x", `${root}/./${name}`));
      await unchanged(withText("x", `${root}//${name}`));
    });
    it("rejects a relative path", async () => {
      const name = good().split("/").at(-1)!;
      await unchanged(withText("x", `openclaw-cli-images/${name}`));
      await unchanged(withText("x", name));
    });
    it("rejects another directory", async () => {
      const other = join(scratch, "elsewhere");
      mkdirSync(other, { recursive: true });
      await unchanged(withText("x", put(PNG, "png", other)));
    });
    it("rejects a workspace .openclaw-cli-images", async () => {
      const dir = join(scratch, "workspace", ".openclaw-cli-images");
      mkdirSync(dir, { recursive: true });
      await unchanged(withText("x", put(PNG, "png", dir)));
    });
    it("rejects a directory of the right name under the wrong parent", async () => {
      const dir = join(scratch, "other-root", "openclaw-cli-images");
      mkdirSync(dir, { recursive: true });
      await unchanged(withText("x", put(PNG, "png", dir)));
    });
    it("rejects a bad file name", async () => {
      for (const name of ["photo.png", `${"a".repeat(63)}.png`, `${"A".repeat(64)}.png`, `${"a".repeat(64)}`, `${"a".repeat(64)}.png.exe`]) {
        const file = join(root, name);
        writeFileSync(file, PNG);
        await unchanged(withText("x", file));
      }
    });
    it("takes nothing when one line of the block fails", async () => {
      await unchanged(withText("x", good(), `${root}/../${"e".repeat(64)}.png`, good()));
      await unchanged(withText("x", good(), "also a sentence"));
    });
    it("rejects the default rule for a root outside the temp dir", async () => {
      // No injected roots: the scratch dir's `openclaw` is not directly under /tmp or os.tmpdir().
      const file = good();
      expect(await takeHostImages(withText("x", file))).toEqual({ text: withText("x", file), images: [] });
    });
  });

  it("applies the host's default rule under the temp dir (openclaw-<uid>)", async () => {
    const hostRoot = join(tmpdir(), `openclaw-${uid}${Date.now()}`);
    const dir = join(hostRoot, "openclaw-cli-images");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      const file = put(PNG, "png", dir);
      const result = await takeHostImages(withText("Hi", file));
      expect(result.text).toBe("Hi");
      expect(result.images).toHaveLength(1);
    } finally {
      rmSync(hostRoot, { recursive: true, force: true });
    }
  });

  describe("delivery: a member that fails becomes a note", () => {
    it("refuses a symlink, also one to a real image", async () => {
      const target = join(scratch, "secret.png");
      writeFileSync(target, PNG);
      const link = join(root, `${"b".repeat(64)}.png`);
      symlinkSync(target, link);
      const warns: string[] = [];
      const result = await take(withText("x", link), { warn: (m) => warns.push(m) });
      expect(result.images).toEqual([]);
      expect(result.text).toBe(`x\n\n${NOTE}could not be read.`);
      expect(warns).toHaveLength(1);
    });

    it("refuses a file owned by another uid", async () => {
      const result = await take(withText("x", put(PNG)), { uid: uid + 1 });
      expect(result.images).toEqual([]);
      expect(result.text).toBe(`x\n\n${NOTE}could not be read.`);
    });

    it("sends nothing when the process uid is unknown", async () => {
      const result = await take(withText("x", put(PNG)), { uid: undefined });
      expect(result.images).toEqual([]);
      expect(result.text).toContain("could not be read");
    });

    it("refuses a cache directory that is a link elsewhere", async () => {
      const real = join(scratch, "real-dir");
      mkdirSync(real);
      const fakeRoot = join(scratch, "linked", "openclaw-cli-images");
      mkdirSync(join(scratch, "linked"));
      symlinkSync(real, fakeRoot);
      const file = put(PNG, "png", real);
      const name = file.split("/").at(-1)!;
      const result = await takeHostImages(withText("x", join(fakeRoot, name)), { roots: [fakeRoot] });
      expect(result.images).toEqual([]);
      expect(result.text).toBe(`x\n\n${NOTE}could not be read.`);
    });

    it("refuses a directory entry that is not a regular file", async () => {
      const dirAsFile = join(root, `${"c".repeat(64)}.png`);
      mkdirSync(dirAsFile);
      const result = await take(withText("x", dirAsFile));
      expect(result.images).toEqual([]);
      expect(result.text).toContain("could not be read");
    });

    it("sends the other images of the block", async () => {
      const good = put(PNG);
      const bad = put(Buffer.from("not an image at all"));
      const result = await take(withText("x", bad, good));
      expect(result.images).toHaveLength(1);
      expect(result.text).toBe(`x\n\n${NOTE}unsupported type.`);
    });

    it("reports a file that is gone", async () => {
      const file = put(PNG);
      rmSync(file);
      const result = await take(withText("x", file));
      expect(result.text).toBe(`x\n\n${NOTE}no longer available.`);
    });

    it("gives only notes when the prompt had no text", async () => {
      const result = await take(block(put(Buffer.from("junk"))));
      expect(result.text).toBe(`${NOTE}unsupported type.`);
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
      ["empty", Buffer.alloc(0)],
      ["text", Buffer.from("plain text, not an image")],
    ])("does not send %s", async (_name, bytes) => {
      const warns: string[] = [];
      const result = await take(withText("x", put(bytes, "png")), { warn: (m) => warns.push(m) });
      expect(result.images).toEqual([]);
      expect(result.text).toBe(`x\n\n${NOTE}unsupported type.`);
      expect(warns).toEqual(["image not sent: unsupported type"]);
    });
  });

  describe("size caps", () => {
    it("does not send an image over the per-image cap", async () => {
      const big = put(Buffer.concat([PNG, Buffer.alloc(200)]));
      const result = await take(withText("x", big), { limits: { maxBytes: 100 } });
      expect(result.images).toEqual([]);
      expect(result.text).toBe(`x\n\n${NOTE}too large.`);
    });

    it("applies 10 MiB by default", async () => {
      const big = put(Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]));
      const result = await take(withText("x", big));
      expect(result.images).toEqual([]);
      expect(result.text).toContain("too large");
    });

    it("sends the first images that fit the count and notes the rest", async () => {
      const files = [put(PNG), put(PNG, "png"), put(PNG), put(PNG), put(PNG)];
      const warns: string[] = [];
      const result = await take(withText("x", ...files), { limits: { maxCount: 2 }, warn: (m) => warns.push(m) });
      expect(result.images).toHaveLength(2);
      expect(result.text).toBe("x\n\n[OpenClaw] 3 attached images were not passed to the model: too many images (limit 2).");
      expect(warns).toHaveLength(1);
    });

    it("names a single image that is left out", async () => {
      const result = await take(withText("x", put(PNG), put(PNG)), { limits: { maxCount: 1 } });
      expect(result.text).toBe("x\n\n[OpenClaw] An attached image was not passed to the model: too many images (limit 1).");
    });

    it("stops at the total cap", async () => {
      const each = Buffer.concat([PNG, Buffer.alloc(100)]);
      const files = [put(each), put(each), put(each)];
      const result = await take(withText("x", ...files), { limits: { maxTotalBytes: each.length * 2 + 10 } });
      expect(result.images).toHaveLength(2);
      expect(result.text).toContain("An attached image was not passed");
      expect(result.text).toContain("total size over");
    });

    it("does not count a failed image toward the count", async () => {
      const files = [put(Buffer.from("junk")), put(PNG), put(PNG)];
      const result = await take(withText("x", ...files), { limits: { maxCount: 2 } });
      expect(result.images).toHaveLength(2);
      expect(result.text).toBe(`x\n\n${NOTE}unsupported type.`);
    });
  });

  describe("abort", () => {
    it("throws when the signal is already aborted, reading nothing", async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(take(withText("x", put(PNG)), { signal: controller.signal })).rejects.toThrow();
    });

    it("throws when the signal fires between files", async () => {
      const controller = new AbortController();
      const gone = put(PNG);
      rmSync(gone);
      await expect(
        take(withText("x", gone, put(PNG)), { signal: controller.signal, warn: () => controller.abort() }),
      ).rejects.toThrow();
    });
  });

  describe("logs and notes", () => {
    it("hold no path and no base64", async () => {
      const files = [
        put(PNG),
        put(Buffer.from("junk")),
        put(Buffer.concat([JPEG, Buffer.alloc(300)])),
        join(root, `${"d".repeat(64)}.png`),
        put(PNG),
      ];
      const warns: string[] = [];
      const result = await take(withText("hello", ...files), { limits: { maxBytes: 200, maxCount: 1 }, warn: (m) => warns.push(m) });
      const shown = [result.text, ...warns].join("\n");
      expect(warns.length).toBeGreaterThan(0);
      expect(shown).not.toContain(root);
      expect(shown).not.toContain(scratch);
      expect(shown).not.toMatch(/[0-9a-f]{64}/);
      for (const image of result.images) expect(shown).not.toContain(image.data);
      expect(shown).not.toContain(PNG.toString("base64"));
    });

    it("keeps errors free of paths too", async () => {
      const controller = new AbortController();
      controller.abort();
      const error = await take(withText("x", put(PNG)), { signal: controller.signal }).catch((e: Error) => e);
      expect(String((error as Error).message)).not.toContain(root);
    });
  });
});
