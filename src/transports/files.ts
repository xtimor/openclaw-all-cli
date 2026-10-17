import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Reads a JSON object file. A missing file (ENOENT), invalid JSON, or non-object content reads
 * as `undefined`; any other read error (EACCES, EISDIR, EIO) is thrown so nothing is dropped silently.
 */
export async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Writes JSON so a reader, or a parallel writer, never sees a partial file: the data goes to a
 * uniquely named temp file next to the target, then `rename` swaps it in. Creates parent
 * directories with mode 0700 and the file with mode 0600; an existing file's stricter owner bits are kept.
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const existing = await stat(path).then(
    (info) => info.mode,
    () => undefined,
  );
  const mode = existing === undefined ? 0o600 : existing & 0o600 || 0o600;
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode });
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}
