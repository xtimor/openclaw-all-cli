import { gzipSync } from "node:zlib";

/** One entry of a test archive. `type` is the tar typeflag; data defaults to empty. */
export type TarEntry = {
  name: string;
  type?: string;
  data?: string | Buffer;
  mode?: number;
  linkname?: string;
  /** Put the name into the ustar `prefix` field (it must hold a `/`). */
  usePrefix?: boolean;
  /** Write the name as a GNU long-name (`L`) entry before this one. */
  gnuLongName?: boolean;
  /** Write the name as a pax `path` record (`x`) before this one. */
  paxPath?: boolean;
  /** Overrides the size written into the header (a lying header). */
  headerSize?: number;
};

const BLOCK = 512;

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function header(name: string, options: { type: string; size: number; mode: number; linkname?: string; prefix?: string }): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(name.slice(0, 100), 0, "utf8");
  block.write(octal(options.mode, 8), 100, "ascii");
  block.write(octal(0, 8), 108, "ascii");
  block.write(octal(0, 8), 116, "ascii");
  block.write(octal(options.size, 12), 124, "ascii");
  block.write(octal(0, 12), 136, "ascii");
  block.write("        ", 148, "ascii");
  block.write(options.type, 156, "ascii");
  if (options.linkname) block.write(options.linkname, 157, "utf8");
  block.write("ustar\0", 257, "ascii");
  block.write("00", 263, "ascii");
  if (options.prefix) block.write(options.prefix, 345, "utf8");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return block;
}

const padded = (data: Buffer) => Buffer.concat([data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK)]);

/** A plain (uncompressed) tar with the two end blocks. */
export function buildTar(entries: readonly TarEntry[], options: { end?: boolean } = {}): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? "");
    const type = entry.type ?? "0";
    let name = entry.name;
    let prefix: string | undefined;
    if (entry.gnuLongName) {
      const long = Buffer.from(`${entry.name}\0`);
      parts.push(header("././@LongLink", { type: "L", size: long.length, mode: 0o644 }), padded(long));
      name = entry.name.slice(0, 99);
    }
    if (entry.paxPath) {
      const body = ` path=${entry.name}\n`;
      let length = body.length;
      length += String(length + String(length).length).length;
      const record = Buffer.from(`${length}${body}`);
      parts.push(header("PaxHeader", { type: "x", size: record.length, mode: 0o644 }), padded(record));
      name = "placeholder";
    }
    if (entry.usePrefix) {
      const cut = entry.name.lastIndexOf("/");
      prefix = entry.name.slice(0, cut);
      name = entry.name.slice(cut + 1);
    }
    parts.push(
      header(name, {
        type,
        size: entry.headerSize ?? data.length,
        mode: entry.mode ?? (type === "5" ? 0o755 : 0o644),
        ...(entry.linkname ? { linkname: entry.linkname } : {}),
        ...(prefix ? { prefix } : {}),
      }),
    );
    if (data.length > 0) parts.push(padded(data));
  }
  if (options.end !== false) parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

/** `buildTar`, gzip-compressed. */
export function buildTarGz(entries: readonly TarEntry[], options: { end?: boolean } = {}): Buffer {
  return gzipSync(buildTar(entries, options));
}
