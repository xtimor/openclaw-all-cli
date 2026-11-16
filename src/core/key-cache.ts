import { chmod, lstat, mkdir, mkdtemp, readdir, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError, type CliAdapter, type HomeEnv } from "./ports.ts";

/**
 * Where a CLI caches a key the plugin gave it (plan 27). A CLI that runs with an API key may keep a
 * copy of it and its tokens in the user's own config (`CliAdapter.keyCopyPath` names it); a
 * removed key then keeps working and reads as the CLI's own login. So every run with a key from the
 * plugin (an auth profile or the plugin config) caches into a folder of the agent's home, and that
 * folder goes when the plugin has no key for the home any more. Keyless runs use the user's config.
 */

/** `<home>/key-cache`: the cache of a home's keyed runs. */
export const KEY_CACHE_DIR = "key-cache";

export function keyCacheDirFor(home: string): string {
  return join(home, KEY_CACHE_DIR);
}

async function privateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

/**
 * The env that points the CLI's key cache at `<home>/key-cache` (created, mode 0700). Empty for an
 * adapter that names no cache env. Throws a `CliError` when the folder cannot be made: a keyed run
 * must not fall back to the user's config.
 */
export async function keyCacheEnvFor(adapter: CliAdapter, home: string): Promise<HomeEnv> {
  if (!adapter.keyCacheEnv) return {};
  const dir = keyCacheDirFor(home);
  try {
    await privateDir(dir);
  } catch (error) {
    throw new CliError(
      {
        code: "unclassified",
        message: `Could not prepare the key cache folder "${dir}": ${error instanceof Error ? error.message : String(error)}`,
      },
      { cause: error },
    );
  }
  return adapter.keyCacheEnv(dir);
}

/** Prefix of a one-off process's throwaway cache under `<home>/key-cache/`. */
const THROWAWAY_PREFIX = "once-";

/**
 * Age after which a throwaway cache is a crash's leftover: no listing or probe runs that long. A
 * younger one may belong to a listing or probe running now, so it stays.
 */
export const THROWAWAY_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Deletes a home's key cache, and with it any copy of a key the CLI kept there, except a throwaway
 * cache (`once-*`) younger than `THROWAWAY_MAX_AGE_MS`, which a concurrent listing or probe of the
 * same home may be using; it deletes its own when it ends. Never throws.
 */
export async function dropKeyCache(home: string, now: number = Date.now()): Promise<void> {
  const dir = keyCacheDirFor(home);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    // Nothing there, or not a folder: a file in its place goes.
    await rm(dir, { force: true }).catch(() => {});
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    if (name.startsWith(THROWAWAY_PREFIX)) {
      const info = await lstat(path).catch(() => undefined);
      if (info && now - info.mtimeMs < THROWAWAY_MAX_AGE_MS) continue;
    }
    await rm(path, { recursive: true, force: true }).catch(() => {});
  }
  // Left when a throwaway cache is still in use.
  await rmdir(dir).catch(() => {});
}

/**
 * Runs `work` with the env of a throwaway key cache, deleted afterwards: for a one-off keyed process
 * (a model listing, a login probe). Under `<home>/key-cache/` when a home is known, so a crash's
 * leftover goes with the home's cache; else in the system temp folder.
 */
export async function withThrowawayKeyCache<T>(adapter: CliAdapter, home: string | undefined, work: (env: HomeEnv) => Promise<T>): Promise<T> {
  if (!adapter.keyCacheEnv) return work({});
  let dir: string;
  try {
    const parent = home ? keyCacheDirFor(home) : tmpdir();
    if (home) await privateDir(parent);
    dir = await mkdtemp(join(parent, home ? THROWAWAY_PREFIX : "oac-key-cache-"));
    await chmod(dir, 0o700);
  } catch (error) {
    throw new CliError(
      {
        code: "unclassified",
        message: `Could not prepare a key cache folder for ${adapter.displayName}: ${error instanceof Error ? error.message : String(error)}`,
      },
      { cause: error },
    );
  }
  try {
    return await work(adapter.keyCacheEnv(dir));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
