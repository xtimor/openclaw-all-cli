/**
 * State shared by every copy of the plugin that one Node thread has loaded. OpenClaw can load the plugin more than
 * once in one Gateway (each copy its own module instance, from its own captured build), so a module-level value is
 * per copy; state that must reach all of them hangs on `globalThis` under a `Symbol.for` key instead. This is the
 * plugin's one write to `globalThis` (OpenClaw's runtime-compatibility check lists it as `host-patch`): a new
 * property under the plugin's own symbol, never a change to an existing global.
 *
 * Copies of other plugin versions may share a key, so what hangs on it must keep its shape across versions.
 */
export function processGlobal<T>(key: symbol, create: () => T): T {
  const place = globalThis as unknown as Record<symbol, T | undefined>;
  return (place[key] ??= create());
}
