import { constants as fsConstants } from "node:fs";
import * as fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PromptImage } from "./ports.ts";

/**
 * Images a user attached to a turn (parity row P13, AD-16). A backend without an image argument gets
 * the host's cache paths as a block of lines at the end of the prompt. This module takes that block off
 * the text and reads the files, so the CLI gets the pixels through its protocol instead of a path it
 * could open itself. It writes, copies, and deletes nothing: the files belong to the host.
 *
 * It reads local files named in a prompt, so every step is strict. The block counts only when every
 * line has the host's exact path shape and every file is fresh (the host writes the files at turn time,
 * so a path typed by a user or a channel for an older cache file is left as text). Each file must then be
 * a regular file with one link that the process owns, in a directory the process owns that others cannot
 * write, of an allowed type by its first bytes, within the size caps. It never logs or puts in an
 * error a path, image bytes, or base64.
 */

export type ImageLimits = {
  /** Largest single image, in bytes. */
  maxBytes: number;
  /** Most images in one turn. */
  maxCount: number;
  /** Most bytes of images in one turn. */
  maxTotalBytes: number;
};

export const DEFAULT_IMAGE_LIMITS: ImageLimits = {
  maxBytes: 10 * 1024 * 1024,
  maxCount: 10,
  maxTotalBytes: 20 * 1024 * 1024,
};

/**
 * How long before the turn began a cache file may have been written and still count as this turn's (ms).
 * The host writes the files before it waits in its own per-session queue, so a turn that waited behind a
 * long run on the same session finds them minutes old: that wait is the only legitimate delay.
 */
export const IMAGE_FRESHNESS_MS = 15 * 60_000;

/** A block longer than the count limit plus this is not the host's (it would be refused anyway): nothing is read. */
const COUNT_MARGIN = 8;
/** Lines of a trailing run that are looked at; a longer run is not the host's block. */
const MAX_SCAN_LINES = 1000;
/** No cache path is this long. */
const MAX_LINE = 1024;

export type TakeHostImagesOptions = {
  /** Aborts the reads; the abort propagates. */
  signal?: AbortSignal;
  /** Receives one short line per image that was not sent. Never holds a path or data. */
  warn?: (message: string) => void;
  /**
   * The allowed `openclaw-cli-images` directories. Default: the host's cache under `/tmp` or
   * `os.tmpdir()`. Tests inject their own.
   */
  roots?: readonly string[];
  /** The owner every directory must have. Default: `uid`. Tests inject another to reach the directory check alone. */
  dirUid?: number;
  /** The owner every file and directory must have. Default: this process's uid. Without one (Windows) the prompt is left as it is. */
  uid?: number | undefined;
  limits?: Partial<ImageLimits>;
  /** Epoch ms. A file written before it is not this turn's: the block is left as text (with a note when it was the host's, only too old). Absent: no freshness check. */
  notBefore?: number;
  /** Test seams, called between the steps that a swapped file could exploit. */
  hooks?: {
    afterLstat?: (file: string) => void | Promise<void>;
    afterStat?: (file: string) => void | Promise<void>;
  };
};

export type TakenImages = {
  /** The prompt without the path block, plus one note line per image that was not sent. */
  text: string;
  images: PromptImage[];
};

const CACHE_DIR_NAME = "openclaw-cli-images";
const FILE_NAME = /^[0-9a-f]{64}\.[a-z0-9]+$/;

/** The image type from the first bytes, never from the file name. Absent: not an allowed type. */
export function sniffImageMime(buf: Uint8Array): string | undefined {
  const at = (i: number) => buf[i];
  if (buf.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
  if (buf.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (buf.length >= 6 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return "image/gif";
  if (
    buf.length >= 12 &&
    at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 &&
    at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50
  ) {
    return "image/webp";
  }
  if (buf.length >= 26 && at(0) === 0x42 && at(1) === 0x4d) return "image/bmp";
  return undefined;
}

async function realOrUndefined(target: string): Promise<string | undefined> {
  try {
    return await fsp.realpath(target);
  } catch {
    return undefined;
  }
}

const isBlank = (line: string) => line.trim() === "";

/**
 * The trailing run of non-empty lines, when it follows an empty line or is the whole prompt.
 * `body` is the text before it. Linear in the prompt: no backtracking pattern runs over it.
 */
function trailingBlock(prompt: string): { body: string; lines: string[] } | undefined {
  const all = prompt.split("\n");
  let end = all.length;
  while (end > 0 && isBlank(all[end - 1]!)) end--;
  let start = end;
  while (start > 0 && !isBlank(all[start - 1]!)) {
    start--;
    // Stop reading lines of a block that is already too long: it is not the host's.
    if (end - start > MAX_SCAN_LINES) break;
  }
  if (start === end) return undefined;
  return { body: all.slice(0, start).join("\n").trimEnd(), lines: all.slice(start, end) };
}

/** The pure shape of one line: `<root>/openclaw-cli-images/<64 hex>.<ext>`. No file is touched. */
function lineShape(line: string): { dir: string } | undefined {
  if (line.length > MAX_LINE || !path.isAbsolute(line) || path.normalize(line) !== line) return undefined;
  const dir = path.dirname(line);
  if (path.basename(dir) !== CACHE_DIR_NAME || !FILE_NAME.test(path.basename(line))) return undefined;
  return { dir };
}

type Failure = "unsupported" | "large" | "gone" | "unreadable" | "empty" | "budget";

const FAILURE_TEXT: Record<Failure, string> = {
  unsupported: "unsupported type",
  large: "too large",
  gone: "no longer available",
  unreadable: "could not be read",
  empty: "empty file",
  budget: "over the total size limit",
};

const TELL_USER = " Tell the user it could not be used.";

const failureNote = (failure: Failure) => `[OpenClaw] An attached image was not passed to the model: ${FAILURE_TEXT[failure]}.${TELL_USER}`;

function overflowNote(count: number, reason: string): string {
  return `[OpenClaw] ${count === 1 ? "An attached image was" : `${count} attached images were`} not passed to the model: ${reason}.${TELL_USER}`;
}

type Delivery = {
  uid: number;
  limits: ImageLimits;
  signal: AbortSignal | undefined;
  hooks: TakeHostImagesOptions["hooks"];
};

type Loaded = { image: PromptImage; bytes: number } | { failure: Failure };

/** Owned by the process and not writable by group or others. */
async function privateDirectory(dir: string, uid: number): Promise<boolean> {
  try {
    const st = await fsp.lstat(dir);
    return st.isDirectory() && st.uid === uid && (st.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

async function loadOne(file: string, delivery: Delivery, budget: number): Promise<Loaded> {
  const { uid, limits, signal, hooks } = delivery;
  let handle: fsp.FileHandle | undefined;
  try {
    // One retry: the host rewrites a content-addressed file atomically, so the inode may change between the steps.
    for (let attempt = 0; attempt < 2; attempt++) {
      const link = await fsp.lstat(file);
      if (!link.isFile() || link.isSymbolicLink() || link.uid !== uid || link.nlink !== 1) return { failure: "unreadable" };
      await hooks?.afterLstat?.(file);
      // O_NOFOLLOW refuses a link swapped in after the lstat; O_NONBLOCK keeps a FIFO swapped in from blocking the open.
      handle = await fsp.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
      const st = await handle.stat();
      if (st.ino !== link.ino || st.dev !== link.dev) {
        await handle.close().catch(() => {});
        handle = undefined;
        if (attempt === 0) continue;
        return { failure: "unreadable" };
      }
      await hooks?.afterStat?.(file);
      if (!st.isFile() || st.uid !== uid || st.nlink !== 1) return { failure: "unreadable" };
      if (st.size === 0) return { failure: "empty" };
      if (st.size > limits.maxBytes) return { failure: "large" };
      if (st.size > budget) return { failure: "budget" };
      const buf = Buffer.alloc(st.size);
      let read = 0;
      while (read < buf.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(buf, read, buf.length - read, read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      signal?.throwIfAborted();
      if (read !== buf.length) return { failure: "unreadable" };
      const mimeType = sniffImageMime(buf);
      if (!mimeType) return { failure: "unsupported" };
      return { image: { mimeType, data: buf.toString("base64") }, bytes: buf.length };
    }
    return { failure: "unreadable" };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { failure: (error as NodeJS.ErrnoException).code === "ENOENT" ? "gone" : "unreadable" };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Takes the host's image block off the end of `prompt` and reads the images. Anything that is not
 * exactly that block (shape, and with `notBefore`, freshness) leaves the prompt unchanged and reads
 * nothing. An image that cannot be sent becomes a one-line note in the text (it names OpenClaw and
 * holds no path).
 */
export async function takeHostImages(prompt: string, options: TakeHostImagesOptions = {}): Promise<TakenImages> {
  const { signal, warn, roots, notBefore, hooks } = options;
  const uid = "uid" in options ? options.uid : process.getuid?.();
  const limits: ImageLimits = { ...DEFAULT_IMAGE_LIMITS, ...options.limits };
  const unchanged: TakenImages = { text: prompt, images: [] };

  const block = trailingBlock(prompt);
  if (!block || block.lines.length > limits.maxCount + COUNT_MARGIN) return unchanged;
  const shapes = block.lines.map(lineShape);
  if (shapes.some((shape) => !shape)) return unchanged;
  if (uid === undefined) {
    warn?.("images stay in the prompt text: this platform has no process uid to check file owners");
    return unchanged;
  }

  // The directory each member must really sit in, with its parent resolved: the last component itself must not be a link.
  const expected = new Map<string, string | undefined>();
  const temps = roots ? [] : (await Promise.all(["/tmp", os.tmpdir()].map(realOrUndefined))).filter((dir): dir is string => dir !== undefined);
  for (const { dir } of shapes as Array<{ dir: string }>) {
    if (expected.has(dir)) continue;
    const hostRoot = path.dirname(dir);
    let parent: string | undefined;
    if (roots) {
      parent = roots.some((root) => path.normalize(root) === dir) ? await realOrUndefined(hostRoot) : undefined;
    } else if (["openclaw", `openclaw-${uid}`].includes(path.basename(hostRoot))) {
      const base = await realOrUndefined(path.dirname(hostRoot));
      parent = base !== undefined && temps.includes(base) ? path.join(base, path.basename(hostRoot)) : undefined;
    }
    expected.set(dir, parent && path.join(parent, CACHE_DIR_NAME));
  }
  if ([...expected.values()].some((dir) => dir === undefined)) return unchanged;

  const trusted = new Map<string, boolean>();
  const dirOwner = options.dirUid ?? uid;
  const trustedDirectory = async (dir: string): Promise<boolean> => {
    let ok = trusted.get(dir);
    if (ok === undefined) {
      const real = expected.get(dir)!;
      ok = (await realOrUndefined(dir)) === real && (await privateDirectory(real, dirOwner)) && (await privateDirectory(path.dirname(real), dirOwner));
      trusted.set(dir, ok);
    }
    return ok;
  };

  // Correlate with this turn: the host writes each file when it prepares the turn. A file that is gone is a
  // path someone typed. An older file the process owns, in the host's directory, is most likely the host's own
  // block after a long queue wait: say so. Anything else that is older is text.
  let stale = 0;
  for (const [i, line] of block.lines.entries()) {
    signal?.throwIfAborted();
    try {
      const st = await fsp.lstat(line);
      if (notBefore !== undefined && st.mtimeMs < notBefore) {
        if (st.uid !== uid || !st.isFile() || !(await trustedDirectory(shapes[i]!.dir))) return unchanged;
        stale++;
      }
    } catch {
      return unchanged;
    }
  }
  if (stale > 0) {
    warn?.(`${stale} image(s) not sent: too old`);
    return { text: `${prompt.trimEnd()}\n\n${overflowNote(stale, "too old to be read")}`, images: [] };
  }

  const delivery: Delivery = { uid, limits, signal, hooks };

  const images: PromptImage[] = [];
  const notes: string[] = [];
  let total = 0;
  for (let i = 0; i < block.lines.length; i++) {
    signal?.throwIfAborted();
    const left = block.lines.length - i;
    if (images.length >= limits.maxCount) {
      notes.push(overflowNote(left, `too many images (limit ${limits.maxCount})`));
      warn?.(`${left} image(s) not sent: too many images`);
      break;
    }
    const file = block.lines[i]!;
    const loaded = (await trustedDirectory(shapes[i]!.dir)) ? await loadOne(file, delivery, limits.maxTotalBytes - total) : ({ failure: "unreadable" } as const);
    if ("failure" in loaded) {
      notes.push(failureNote(loaded.failure));
      warn?.(`image not sent: ${FAILURE_TEXT[loaded.failure]}`);
      continue;
    }
    images.push(loaded.image);
    total += loaded.bytes;
  }
  const text = [block.body, notes.join("\n")].filter(Boolean).join("\n\n");
  return { text, images };
}
