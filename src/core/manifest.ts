import type { CapabilityManifest, ParityRowId } from "./ports.ts";

/** Backend flags the core derives from a manifest, and nothing else (AD-10). */
export type DerivedFlags = {
  /** P4: the adapter keeps one warm process per conversation. */
  liveSession: boolean;
  /** P5: the adapter resumes a native session. */
  resume: boolean;
  /** P18: a side question runs without OpenClaw's tools and is rejected every permission request. */
  sideQuestion: boolean;
  /** P7: OpenClaw's tools reach the CLI through the MCP proxy. */
  mcp: boolean;
  /** P10: the host may select the run's native tools; the backend enforces what it can (AD-9). */
  toolPolicy: boolean;
  /** P13: the adapter sends images to the CLI. */
  images: boolean;
  /** P15: the host may reseed a fresh chat from its own transcript, and the first prompt points to `sessions_history`. */
  history: boolean;
};

function decided(manifest: CapabilityManifest, id: ParityRowId): boolean {
  const status = manifest.rows[id].status;
  return status === "match" || status === "approx";
}

export function deriveFlags(manifest: CapabilityManifest): DerivedFlags {
  return {
    liveSession: decided(manifest, "P4"), resume: decided(manifest, "P5"), mcp: decided(manifest, "P7"),
    toolPolicy: decided(manifest, "P10"), images: decided(manifest, "P13"), history: decided(manifest, "P15"), sideQuestion: decided(manifest, "P18"),
  };
}
