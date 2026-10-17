/**
 * Warns through OpenClaw's subsystem logger when it can be loaded, and drops the message
 * otherwise. For code that runs before the plugin runtime (the provider-catalog entry), where
 * `api.logger` does not exist yet. Never pass it a key, a header, or prompt text.
 */
export function warnBeforeRuntime(message: string): void {
  void (async () => {
    try {
      const { createSubsystemLogger } = await import("openclaw/plugin-sdk/logging-core");
      createSubsystemLogger("openclaw-all-cli").warn(message);
    } catch {
      // No logger to write to: the convention allows no other output.
    }
  })();
}
