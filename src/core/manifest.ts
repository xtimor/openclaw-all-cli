import { CliError, type CapabilityManifest, type CliCapability, type ParityRowId } from "./ports.ts";

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
  /** P8: the host's own exec tools are served instead of the CLI's (`hostOwnedTools`). */
  hostTools: boolean;
  /** P9: the CLI's permission requests go to the host for a decision; undecided, they are rejected. */
  approvals: boolean;
  /** P10: the host may select the run's native tools; the backend enforces what it can (AD-9). */
  toolPolicy: boolean;
  /** P13: the adapter sends images to the CLI. */
  images: boolean;
  /** P15: the host may reseed a fresh chat from its own transcript, and the first prompt points to `sessions_history`. */
  history: boolean;
  /** P16: the adapter reads a turn's usage when the CLI reports none. */
  usage: boolean;
  /** P17: the backend drops the adapter's `clearEnv` keys from the turn's env and the probes' env. */
  cleanEnv: boolean;
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
  images: "P13",
  history: "P15",
  usage: "P16",
  cleanEnv: "P17",
  sideQuestion: "P18",
  liveTest: "P19",
};

/**
 * Rows that set no flag, each with the reason. These have no core mechanism to switch, so an
 * adapter must not decide them (a `match` or `approx` there would promise nothing).
 */
export const NO_FLAG_ROWS: Partial<Record<ParityRowId, string>> = {
  P3: "streaming is the AD-3 seam itself: every adapter streams, so there is nothing to switch",
  P6: "the core has no fork or checkpoint mechanism",
  P11: "the core has no skills or plugin-directory mechanism",
  P12: "the core has no system-prompt mechanism",
  P14: "the core has no mechanism for it",
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

const CAPABILITY_LABELS: Record<CliCapability, string> = {
  resumeSession: "session resume",
  httpMcp: "HTTP MCP servers",
  imagePrompts: "image prompts",
};

export type MissingCapability = { row: ParityRowId; capability: CliCapability };

/** The capabilities a decided row needs and the CLI did not report. Undecided rows are never checked. */
export function missingCapabilities(manifest: CapabilityManifest, reported: ReadonlySet<CliCapability>): MissingCapability[] {
  const missing: MissingCapability[] = [];
  for (const [id, row] of Object.entries(manifest.rows) as Array<[ParityRowId, CapabilityManifest["rows"][ParityRowId]]>) {
    if (!decided(manifest, id)) continue;
    for (const capability of row.requires ?? []) if (!reported.has(capability)) missing.push({ row: id, capability });
  }
  return missing;
}

export function capabilityMismatch(displayName: string, missing: readonly MissingCapability[]): CliError {
  const what = missing.map((item) => `${CAPABILITY_LABELS[item.capability]} (parity row ${item.row})`).join(" and ");
  return new CliError({
    code: "capability_mismatch",
    message: `Capability mismatch: ${displayName} does not report ${what}, which the plugin's manifest needs. Update the CLI.`,
  });
}
