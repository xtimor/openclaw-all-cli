import { describe, expect, it } from "vitest";
import type { CliToolProfile } from "./ports.ts";
import { selectToolProfile, unenforceableNativeTools } from "./permissions.ts";

const DEFAULT: CliToolProfile = { id: "default", nativeTools: ["read", "grep", "glob"] };
const RESTRICTED: CliToolProfile = { id: "restricted", nativeTools: [] };

describe("selectToolProfile", () => {
  it("serves a selection that leaves the native tools out with the profile that closes them", () => {
    expect(selectToolProfile([DEFAULT, RESTRICTED], [])).toEqual(RESTRICTED);
  });

  it("serves a selection that keeps the native tools with the profile that offers them", () => {
    expect(selectToolProfile([DEFAULT, RESTRICTED], ["read", "grep", "glob"])).toEqual(DEFAULT);
  });

  it("prefers the profile that offers more of the selection", () => {
    expect(selectToolProfile([DEFAULT, RESTRICTED], ["read", "grep", "glob", "exec"])).toEqual(DEFAULT);
  });

  it("serves no profile for a selection that takes only part of a group one profile governs", () => {
    // A selection of read alone cannot be served: the profile that closes the group also closes
    // read, and the profile that keeps read keeps the whole group.
    expect(selectToolProfile([DEFAULT, RESTRICTED], ["read"])).toBeUndefined();
  });

  it("serves a selection that names a native tool no profile can deliver", () => {
    // The adapter cannot deliver native read under any of its profiles, so the run is
    // over-restrictive rather than a bypass: it serves instead of refusing.
    expect(selectToolProfile([RESTRICTED], ["read"])).toEqual(RESTRICTED);
  });

  it("refuses a partial selection the adapter could deliver only by over-permitting", () => {
    // The default profile would also offer grep and glob, which the host left out, so it is a
    // bypass; the restricted profile withholds read, which the host asked for. Neither serves.
    expect(selectToolProfile([DEFAULT, RESTRICTED], ["read"])).toBeUndefined();
  });

  it("takes the first profile when the run names no selection", () => {
    expect(selectToolProfile([DEFAULT, RESTRICTED], undefined)).toEqual(DEFAULT);
  });

  it("serves a selection the profiles do not mention", () => {
    // A tool no profile offers is the host's business; the profiles still have to match.
    expect(selectToolProfile([RESTRICTED], ["exec"])).toEqual(RESTRICTED);
  });
});

describe("unenforceableNativeTools", () => {
  it("names the always-on tools the host left out", () => {
    expect(unenforceableNativeTools({ native: [], openClaw: [] }, ["read", "grep"])).toEqual(["read", "grep"]);
  });

  it("names nothing when the host keeps them all", () => {
    expect(unenforceableNativeTools({ native: ["read"], openClaw: [] }, ["read"])).toEqual([]);
  });
});
