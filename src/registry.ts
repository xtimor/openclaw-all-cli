import { cursorAdapter } from "./adapters/cursor/index.ts";
import type { CliAdapter } from "./core/ports.ts";

/** Every adapter the plugin ships. A new CLI is one line here. */
export const ADAPTERS: readonly CliAdapter[] = [cursorAdapter];
