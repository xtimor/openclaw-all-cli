import { capabilityMismatch, type CapabilityManifest, type CliCapability, type ParityRowId, type RequiredCapability } from "./ports.ts";

export { capabilityMismatch };
export type MissingCapability = RequiredCapability;

/**
 * Backend flags the core derives from a manifest, and nothing else (AD-10). Each flag comes from
 * exactly one parity row (`FLAG_ROWS`); a row without a flag is listed in `NO_FLAG_ROWS`.
 */
export type DerivedFlags = {
  /** P1: the backend publishes the CLI's model list and aliases (`modelAliases`, the provider catalog). */
  models: boolean;
  /** P2: a CLI login or key counts as auth (synthetic auth). */
  auth: boolean;
  /** P4: the adapter keeps one warm process per conversation. */
  liveSession: boolean;
  /** P5: the adapter resumes a native session. */
  resume: boolean;
  /** P7: OpenClaw's tools reach the CLI through the MCP proxy. */
  mcp: boolean;
  /** P8: the host's own exec tools are served instead of the CLI's (`hostOwnedTools`); the backend sets it only together with P7 (the MCP path) and P10 (`execution-args`). */
  hostTools: boolean;
  /** P9: the CLI's permission requests go to the host for a decision; undecided, they are rejected. */
  approvals: boolean;
  /** P10: the host may select the run's native tools; the backend enforces what it can (AD-9). */
  toolPolicy: boolean;
  /** P12: the core sends the host's system prompt to the CLI as a marked block at the start of the prompt (AD-15). */
  systemPrompt: boolean;
  /** P13: the adapter sends images to the CLI. */
  images: boolean;
  /** P15: the host may reseed a fresh chat from its own transcript, and the first prompt points to `sessions_history`. */
  history: boolean;
  /** P16: the adapter reads a turn's usage when the CLI reports none. */
  usage: boolean;
  /** P18: a side question runs without OpenClaw's tools and is rejected every permission request. */
  sideQuestion: boolean;
  /** P19: the backend declares the host's live-test defaults. */
  liveTest: boolean;
};

/** The one parity row each derived flag comes from. */
export const FLAG_ROWS: Record<keyof DerivedFlags, ParityRowId> = {
  models: "P1",
  auth: "P2",
  liveSession: "P4",
  resume: "P5",
  mcp: "P7",
  hostTools: "P8",
  approvals: "P9",
  toolPolicy: "P10",
  systemPrompt: "P12",
  images: "P13",
  history: "P15",
  usage: "P16",
  sideQuestion: "P18",
  liveTest: "P19",
};

/**
 * Rows that set no flag, each with the reason. P6 and P14 have no core mechanism, so an
 * adapter must not decide them (a `match` or `approx` would promise nothing). P11 rides on P12:
 * the host's skills catalog is part of the system prompt, so an adapter that decides P11 decides P12. P3 and P17 describe
 * what the core does for every adapter (streaming; the `clearEnv` safety list, the host's timers,
 * the caps and the pid locks): an adapter documents them but cannot switch them.
 */
export const NO_FLAG_ROWS: Partial<Record<ParityRowId, string>> = {
  P3: "streaming is the AD-3 seam itself: every adapter streams, so there is nothing to switch",
  P6: "the core has no fork or checkpoint mechanism",
  P11: "the host puts its skills catalog into the system prompt for every backend but claude-cli; P12 delivers it, so P11 sets no flag",
  P14: "the CLI offers no compaction the plugin can drive; a backend that does not own native compaction gets OpenClaw's transcript compaction, so P14 sets no flag",
  P17: "clearEnv is a safety list the core applies whenever the adapter declares one; timers belong to the host; caps and pid locks apply to every adapter",
};

function decided(manifest: CapabilityManifest, id: ParityRowId): boolean {
  const status = manifest.rows[id].status;
  return status === "match" || status === "approx";
}

export function deriveFlags(manifest: CapabilityManifest): DerivedFlags {
  return Object.fromEntries(
    (Object.entries(FLAG_ROWS) as Array<[keyof DerivedFlags, ParityRowId]>).map(([flag, row]) => [flag, decided(manifest, row)]),
  ) as DerivedFlags;
}

/** What the decided rows need from the CLI, in row order. Undecided rows need nothing. */
export function requiredCapabilities(manifest: CapabilityManifest): RequiredCapability[] {
  const required: RequiredCapability[] = [];
  for (const [id, row] of Object.entries(manifest.rows) as Array<[ParityRowId, CapabilityManifest["rows"][ParityRowId]]>) {
    if (!decided(manifest, id)) continue;
    for (const capability of row.requires ?? []) required.push({ row: id, capability });
  }
  return required;
}

/** The capabilities a decided row needs and the CLI did not report. */
export function missingCapabilities(manifest: CapabilityManifest, reported: ReadonlySet<CliCapability>): MissingCapability[] {
  return requiredCapabilities(manifest).filter((item) => !reported.has(item.capability));
}
