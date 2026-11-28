import { inflateSync } from "node:zlib";

/**
 * A PNG decoded to 8-bit RGBA in Node (no browser, no dependency): enough for the plugin icon check, which compares the
 * icon the Gateway serves (re-encoded by the host, so its bytes differ) with the packaged `assets/icon.png` pixel by
 * pixel. Non-interlaced 8-bit grayscale, RGB, palette, gray+alpha, and RGBA; anything else throws with what it found.
 */
export type DecodedPng = { width: number; height: number; rgba: Buffer };

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function decodePng(bytes: Buffer): DecodedPng {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(SIGNATURE)) throw new Error(`not a PNG (${bytes.length} bytes, starts ${bytes.subarray(0, 8).toString("hex")})`);
  let width = 0;
  let height = 0;
  let depth = 0;
  let color = -1;
  let interlace = 0;
  let palette: Buffer | undefined;
  let alpha: Buffer | undefined;
  const data: Buffer[] = [];
  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString("latin1", at + 4, at + 8);
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (body.length !== length) throw new Error(`PNG chunk ${type} cut short (${body.length} of ${length} bytes)`);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8]!;
      color = body[9]!;
      interlace = body[12]!;
    } else if (type === "PLTE") palette = body;
    else if (type === "tRNS") alpha = body;
    else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  const channels = CHANNELS[color];
  if (depth !== 8 || channels === undefined || interlace !== 0) throw new Error(`unsupported PNG: depth ${depth}, color type ${color}, interlace ${interlace}`);
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  if (raw.length !== height * (stride + 1)) throw new Error(`PNG image data is ${raw.length} bytes, expected ${height * (stride + 1)}`);
  // Undo the per-row filters (none, sub, up, average, Paeth).
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? pixels[y * stride + x - channels]! : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
      const upLeft = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels]! : 0;
      let value = row[x]!;
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      } else if (filter !== 0) throw new Error(`PNG row ${y} has unknown filter ${filter}`);
      pixels[y * stride + x] = value & 0xff;
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const p = pixels.subarray(i * channels, (i + 1) * channels);
    let [r, g, b, a] = [0, 0, 0, 255];
    if (color === 0) [r, g, b] = [p[0]!, p[0]!, p[0]!];
    else if (color === 2) [r, g, b] = [p[0]!, p[1]!, p[2]!];
    else if (color === 4) [r, g, b, a] = [p[0]!, p[0]!, p[0]!, p[1]!];
    else if (color === 6) [r, g, b, a] = [p[0]!, p[1]!, p[2]!, p[3]!];
    else {
      if (!palette || p[0]! * 3 + 2 >= palette.length) throw new Error(`PNG palette index ${p[0]} out of range`);
      [r, g, b, a] = [palette[p[0]! * 3]!, palette[p[0]! * 3 + 1]!, palette[p[0]! * 3 + 2]!, alpha?.[p[0]!] ?? 255];
    }
    rgba.set([r, g, b, a], i * 4);
  }
  return { width, height, rgba };
}

/** Whether two PNGs decode to the same size and RGBA pixels, with each one's size (or why it did not decode). */
export function samePngPixels(a: Buffer, b: Buffer): { same: boolean; sizes: string[] } {
  const read = (bytes: Buffer) => {
    try {
      const png = decodePng(bytes);
      return { png, size: `${png.width}x${png.height}` };
    } catch (error) {
      return { png: undefined, size: `undecodable: ${error instanceof Error ? error.message : String(error)}` };
    }
  };
  const [x, y] = [read(a), read(b)];
  const same = x.png !== undefined && y.png !== undefined && x.png.width === y.png.width && x.png.height === y.png.height && x.png.rgba.equals(y.png.rgba);
  return { same, sizes: [x.size, y.size] };
}
