import { chmod, mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable, pipeline } from "node:stream";
import { createGunzip } from "node:zlib";

/**
 * A bounded, streaming reader for `.tar.gz` packages. It knows the ustar format with its `prefix`
 * field, GNU long names (`L`), and pax `path` and `size` records; it unpacks regular files and
 * directories only. Links, devices, absolute paths, and `..` are refused, so nothing it writes can
 * land outside the target folder. Executable bits are kept (0755 or 0644). No npm dependency.
 */

export type TarLimits = {
  /** Total bytes of file data. */
  maxBytes: number;
  /** Files and directories. */
  maxEntries: number;
  /** Path parts after `stripComponents`. Default 32. */
  maxDepth?: number;
};

export type TarErrorReason = "corrupt" | "truncated" | "limit" | "unsafe-path" | "unsupported-entry" | "duplicate";

export class TarError extends Error {
  // A plain field, not a parameter property: scripts load this file with Node's type stripping.
  readonly reason: TarErrorReason;

  constructor(reason: TarErrorReason, message: string) {
    super(message);
    this.name = "TarError";
    this.reason = reason;
  }
}

export type TarOptions = {
  /** Where to unpack. Without it the archive is only read and counted (nothing is written). */
  dest?: string;
  /** Leading path parts to drop from every entry, like `tar --strip-components`. */
  stripComponents?: number;
  limits: TarLimits;
  signal?: AbortSignal;
};

export type TarSummary = { entries: number; bytes: number };

const BLOCK = 512;
const DEFAULT_MAX_DEPTH = 32;
/** Long names and pax records: one at most 64 KiB, all of them at most 1 MiB. */
const MAX_META_ENTRY = 64 * 1024;
const MAX_META_TOTAL = 1024 * 1024;

const text = (block: Buffer, start: number, end: number) => {
  const field = block.subarray(start, end);
  const nul = field.indexOf(0);
  return field.subarray(0, nul === -1 ? field.length : nul).toString("utf8");
};

/** An octal number field, or GNU's base-256 form for large values. */
function numberField(block: Buffer, start: number, end: number): number {
  const field = block.subarray(start, end);
  if (field[0]! & 0x80) {
    let value = field[0]! & 0x7f;
    for (let i = 1; i < field.length; i += 1) value = value * 256 + field[i]!;
    return value;
  }
  const digits = text(block, start, end).trim();
  if (digits === "") return 0;
  if (!/^[0-7]+$/.test(digits)) throw new TarError("corrupt", "The package has a damaged entry header.");
  return parseInt(digits, 8);
}

function checksumOk(block: Buffer): boolean {
  const stored = numberField(block, 148, 156);
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : block[i]!;
  return sum === stored;
}

/** `<length> <key>=<value>\n` records. */
function paxRecords(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space === -1) break;
    const length = Number(data.subarray(at, space).toString("ascii"));
    if (!Number.isInteger(length) || length <= 0 || at + length > data.length) {
      throw new TarError("corrupt", "The package has a damaged pax header.");
    }
    const record = data.subarray(space + 1, at + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0) records.set(record.slice(0, equals), record.slice(equals + 1));
    at += length;
  }
  return records;
}

/** The entry's path relative to the target, `undefined` when stripping leaves nothing. */
function safeRelative(raw: string, strip: number, maxDepth: number): string | undefined {
  if (raw.includes("\0") || raw.includes("\\") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
    throw new TarError("unsafe-path", "The package has an entry with an absolute or unsafe path.");
  }
  const parts = raw.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) throw new TarError("unsafe-path", "The package has an entry whose path leaves its folder (`..`).");
  const kept = parts.slice(strip);
  if (kept.length === 0) return undefined;
  if (kept.length > maxDepth) throw new TarError("limit", `The package has a path deeper than ${maxDepth} folders.`);
  return kept.join("/");
}

type Pending = {
  kind: "file" | "skip" | "meta";
  /** Data bytes still to come. */
  left: number;
  /** Padding after the data. */
  pad: number;
  handle?: FileHandle;
  path?: string;
  mode?: number;
  meta?: Buffer[];
  metaType?: string;
};

/**
 * Reads a gzip-compressed tar stream and unpacks it into `dest` (or only counts it). Throws
 * `TarError` for a damaged, unsafe, or oversized package, and the signal's reason on abort. On a
 * throw the caller removes whatever was written; this function writes only under `dest`.
 */
export async function extractTarGz(input: Readable | AsyncIterable<Uint8Array>, options: TarOptions): Promise<TarSummary> {
  const { limits } = options;
  const strip = options.stripComponents ?? 0;
  const maxDepth = limits.maxDepth ?? DEFAULT_MAX_DEPTH;
  const dest = options.dest === undefined ? undefined : resolve(options.dest);
  const gunzip = createGunzip();
  const source = input instanceof Readable ? input : Readable.from(input);
  pipeline(source, gunzip, () => {});

  let entries = 0;
  let bytes = 0;
  let metaBytes = 0;
  let ended = false;
  let header = Buffer.alloc(0);
  let pending: Pending | undefined;
  let longName: string | undefined;
  let pax: Map<string, string> | undefined;

  const closePending = async () => {
    const done = pending;
    pending = undefined;
    if (done?.handle) {
      await done.handle.close();
      // The process umask may have narrowed the mode `open` was given.
      await chmod(done.path!, done.mode!);
    }
    if (done?.kind === "meta") {
      const data = Buffer.concat(done.meta!);
      if (done.metaType === "L") longName = text(data, 0, data.length);
      else if (done.metaType === "x") pax = paxRecords(data);
    }
  };

  const startEntry = async (block: Buffer) => {
    if (!checksumOk(block)) throw new TarError("corrupt", "The package has a damaged entry header.");
    const type = String.fromCharCode(block[156]!);
    const ustar = text(block, 257, 263) === "ustar";
    const prefix = ustar ? text(block, 345, 500) : "";
    let size = numberField(block, 124, 136);
    if (type === "L" || type === "x" || type === "g") {
      const pad = (BLOCK - (size % BLOCK)) % BLOCK;
      metaBytes += BLOCK + size;
      if (size > MAX_META_ENTRY || metaBytes > MAX_META_TOTAL) throw new TarError("limit", "The package has oversized metadata.");
      pending = type === "g" ? { kind: "skip", left: size, pad } : { kind: "meta", left: size, pad, meta: [], metaType: type };
      return;
    }
    const name = pax?.get("path") ?? longName ?? (prefix ? `${prefix}/${text(block, 0, 100)}` : text(block, 0, 100));
    const paxSize = pax?.get("size");
    if (paxSize !== undefined) {
      if (!/^\d+$/.test(paxSize)) throw new TarError("corrupt", "The package has a damaged pax header.");
      size = Number(paxSize);
    }
    longName = undefined;
    pax = undefined;
    const isFile = type === "0" || type === "\0" || type === "7";
    const isDir = type === "5";
    if (!isFile && !isDir) {
      const what = type === "1" || type === "2" || type === "K" ? "a link" : `an entry of type "${type}"`;
      throw new TarError("unsupported-entry", `The package has ${what}, which is not unpacked.`);
    }
    entries += 1;
    if (entries > limits.maxEntries) throw new TarError("limit", `The package has more than ${limits.maxEntries} entries.`);
    const relative = safeRelative(name, strip, maxDepth);
    const dataPad = (BLOCK - (size % BLOCK)) % BLOCK;
    if (isDir) {
      if (dest && relative) await mkdir(join(dest, relative), { recursive: true, mode: 0o755 });
      // A directory has no data; a size on one is skipped.
      if (size > 0) pending = { kind: "skip", left: size, pad: dataPad };
      return;
    }
    bytes += size;
    if (bytes > limits.maxBytes) throw new TarError("limit", `The package unpacks to more than ${limits.maxBytes} bytes.`);
    if (!dest || relative === undefined) {
      pending = { kind: "skip", left: size, pad: dataPad };
      return;
    }
    const target = join(dest, relative);
    if (!target.startsWith(dest + sep)) throw new TarError("unsafe-path", "The package has an entry whose path leaves its folder.");
    const mode = numberField(block, 100, 108) & 0o111 ? 0o755 : 0o644;
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    let handle: FileHandle;
    try {
      handle = await open(target, "wx", mode);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new TarError("duplicate", "The package names one path twice.");
      throw error;
    }
    pending = { kind: "file", left: size, pad: dataPad, handle, path: target, mode };
  };

  try {
    for await (const raw of gunzip as AsyncIterable<Buffer>) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error("Aborted.");
      let chunk = raw;
      while (chunk.length > 0 && !ended) {
        if (pending) {
          if (pending.left > 0) {
            const take = chunk.subarray(0, Math.min(pending.left, chunk.length));
            if (pending.handle) await pending.handle.write(take);
            else if (pending.meta) pending.meta.push(Buffer.from(take));
            pending.left -= take.length;
            chunk = chunk.subarray(take.length);
            continue;
          }
          if (pending.pad > 0) {
            const skip = Math.min(pending.pad, chunk.length);
            pending.pad -= skip;
            chunk = chunk.subarray(skip);
            continue;
          }
          await closePending();
          continue;
        }
        const need = BLOCK - header.length;
        header = Buffer.concat([header, chunk.subarray(0, need)]);
        chunk = chunk.subarray(need);
        if (header.length < BLOCK) continue;
        const block = header;
        header = Buffer.alloc(0);
        if (block.every((byte) => byte === 0)) {
          ended = true;
          break;
        }
        await startEntry(block);
      }
      if (ended) break;
    }
    if (!ended) throw new TarError("truncated", "The package ends early (truncated download).");
  } catch (error) {
    await pending?.handle?.close().catch(() => {});
    pending = undefined;
    if (error instanceof TarError) throw error;
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "Z_BUF_ERROR") throw new TarError("truncated", "The package ends early (truncated download).");
    if (code === "Z_DATA_ERROR" || code === "Z_STREAM_ERROR") throw new TarError("corrupt", "The package is not a valid gzip archive.");
    throw error;
  } finally {
    source.destroy();
    gunzip.destroy();
  }
  return { entries, bytes };
}
