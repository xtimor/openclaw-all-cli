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
 * It reads local files named in a prompt, so every step is strict: the path must have the host's exact
 * shape, and the file must be a regular file the process owns, in the host's own directory, of an
 * allowed type by its first bytes, within the size caps. It never logs or puts in an error a path,
 * image bytes, or base64.
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
  /** The owner every file must have. Default: this process's uid; without one nothing is sent. */
  uid?: number | undefined;
  limits?: Partial<ImageLimits>;
};

export type TakenImages = {
  /** The prompt without the path block, plus one note line per image that was not sent. */
  text: string;
  images: PromptImage[];
};

const CACHE_DIR_NAME = "openclaw-cli-images";
const FILE_NAME = /^[0-9a-f]{64}\.[a-z0-9]+$/;
const ROOT_NAME = /^openclaw(?:-\d+)?$/;

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

/**
 * The trailing run of non-empty lines, when it follows an empty line or is the whole prompt.
 * `body` is the text before it.
 */
function trailingBlock(prompt: string): { body: string; lines: string[] } | undefined {
  const all = prompt.split("\n");
  let end = all.length;
  while (end > 0 && all[end - 1]!.trim() === "") end--;
  let start = end;
  while (start > 0 && all[start - 1]!.trim() !== "") start--;
  if (start === end) return undefined;
  return { body: all.slice(0, start).join("\n").replace(/\s+$/, ""), lines: all.slice(start, end) };
}

/**
 * Path shape only, no file is opened. Returns the directory the file must really sit in, with its
 * parent resolved: the last component itself must not be a link.
 */
async function checkedDirectory(line: string, roots: readonly string[] | undefined): Promise<string | undefined> {
  if (!path.isAbsolute(line) || path.normalize(line) !== line) return undefined;
  const dir = path.dirname(line);
  if (path.basename(dir) !== CACHE_DIR_NAME || !FILE_NAME.test(path.basename(line))) return undefined;
  if (roots) {
    if (!roots.some((root) => path.normalize(root) === dir)) return undefined;
    const parent = await realOrUndefined(path.dirname(dir));
    return parent && path.join(parent, CACHE_DIR_NAME);
  }
  const hostRoot = path.dirname(dir);
  if (!ROOT_NAME.test(path.basename(hostRoot))) return undefined;
  const base = await realOrUndefined(path.dirname(hostRoot));
  if (!base) return undefined;
  const temps = await Promise.all(["/tmp", os.tmpdir()].map(realOrUndefined));
  if (!temps.includes(base)) return undefined;
  return path.join(base, path.basename(hostRoot), CACHE_DIR_NAME);
}

type Failure = "unsupported" | "large" | "gone" | "unreadable";

const FAILURE_TEXT: Record<Failure, string> = {
  unsupported: "unsupported type",
  large: "too large",
  gone: "no longer available",
  unreadable: "could not be read",
};

type Loaded = { image: PromptImage; bytes: number } | { failure: Failure; bytes?: number };

async function loadOne(
  file: string,
  directory: string,
  uid: number | undefined,
  limits: ImageLimits,
  budget: number,
  signal: AbortSignal | undefined,
): Promise<Loaded | "overflow-size"> {
  let handle: fsp.FileHandle | undefined;
  try {
    const link = await fsp.lstat(file);
    if (!link.isFile() || link.isSymbolicLink()) return { failure: "unreadable" };
    if (uid === undefined || link.uid !== uid) return { failure: "unreadable" };
    if ((await realOrUndefined(path.dirname(file))) !== directory) return { failure: "unreadable" };
    // O_NOFOLLOW and a check on the open descriptor close the window between lstat and read.
    handle = await fsp.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const st = await handle.stat();
    if (!st.isFile() || st.uid !== uid || st.ino !== link.ino || st.dev !== link.dev) return { failure: "unreadable" };
    if (st.size > limits.maxBytes) return { failure: "large" };
    if (st.size > budget) return "overflow-size";
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
  } catch (error) {
    if (signal?.aborted) throw error;
    return { failure: (error as NodeJS.ErrnoException).code === "ENOENT" ? "gone" : "unreadable" };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Takes the host's image block off the end of `prompt` and reads the images. Anything that is not
 * exactly that block leaves the prompt unchanged and reads nothing. An image that cannot be sent
 * becomes a one-line note in the text (it names OpenClaw and holds no path).
 */
export async function takeHostImages(prompt: string, options: TakeHostImagesOptions = {}): Promise<TakenImages> {
  const { signal, warn, roots } = options;
  const uid = "uid" in options ? options.uid : process.getuid?.();
  const limits: ImageLimits = { ...DEFAULT_IMAGE_LIMITS, ...options.limits };
  const unchanged: TakenImages = { text: prompt, images: [] };

  const block = trailingBlock(prompt);
  if (!block) return unchanged;
  const directories: string[] = [];
  for (const line of block.lines) {
    const directory = await checkedDirectory(line, roots);
    if (!directory) return unchanged;
    directories.push(directory);
  }

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
    const loaded = await loadOne(block.lines[i]!, directories[i]!, uid, limits, limits.maxTotalBytes - total, signal);
    if (loaded === "overflow-size") {
      notes.push(overflowNote(left, `total size over ${limits.maxTotalBytes / (1024 * 1024)} MiB`));
      warn?.(`${left} image(s) not sent: total size over the limit`);
      break;
    }
    if ("failure" in loaded) {
      notes.push(`[OpenClaw] An attached image was not passed to the model: ${FAILURE_TEXT[loaded.failure]}.`);
      warn?.(`image not sent: ${FAILURE_TEXT[loaded.failure]}`);
      continue;
    }
    images.push(loaded.image);
    total += loaded.bytes;
  }
  const text = [block.body, notes.join("\n")].filter(Boolean).join("\n\n");
  return { text, images };
}

function overflowNote(count: number, reason: string): string {
  return `[OpenClaw] ${count === 1 ? "An attached image was" : `${count} attached images were`} not passed to the model: ${reason}.`;
}
