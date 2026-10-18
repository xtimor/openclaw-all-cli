import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ADAPTERS } from "../registry.ts";
import { FLAG_ROWS, NO_FLAG_ROWS, capabilityMismatch, deriveFlags, missingCapabilities } from "./manifest.ts";
import { PARITY_ROWS, createManifest, type ParityRowId } from "./ports.ts";

describe("manifest", () => {
  it("starts every row undecided", () => {
    const manifest = createManifest("1", {});
    expect(Object.keys(manifest.rows)).toEqual([...PARITY_ROWS]);
    expect(Object.values(manifest.rows).every((row) => row.status === "tbd")).toBe(true);
  });

  const NO_FLAGS = Object.fromEntries(Object.keys(FLAG_ROWS).map((flag) => [flag, false]));

  it("derives no flag from an all-undecided manifest", () => {
    expect(deriveFlags(createManifest("1", {}))).toEqual(NO_FLAGS);
  });

  it.each(Object.entries(FLAG_ROWS))("derives %s from %s alone", (flag, row) => {
    for (const status of ["match", "approx"] as const) {
      expect(deriveFlags(createManifest("1", { [row]: { status, note: "" } }))).toEqual({ ...NO_FLAGS, [flag]: true });
    }
    for (const status of ["gap", "spike", "tbd"] as const) {
      expect(deriveFlags(createManifest("1", { [row]: { status, note: "" } }))).toEqual(NO_FLAGS);
    }
  });

  it("gives every parity row exactly one place: one flag, or a reason it has none", () => {
    const flagged = Object.values(FLAG_ROWS);
    const unflagged = Object.keys(NO_FLAG_ROWS);
    expect([...flagged, ...unflagged].sort()).toEqual([...PARITY_ROWS].sort());
    expect(new Set(flagged).size).toBe(flagged.length);
    expect(Object.values(NO_FLAG_ROWS).every((reason) => reason.trim().length > 0)).toBe(true);
  });

  describe.each(ADAPTERS.map((adapter) => [adapter.id, adapter] as const))("%s manifest", (_id, adapter) => {
    const matrix = readFileSync(
      new URL("../../_bmad-output/initiative-openclaw-all-cli/spec-cursor-cli-provider/claude-cli-parity.md", import.meta.url),
      "utf8",
    );
    // The matrix columns: row, feature, mechanism, then one column per provider.
    const cell = (row: string) => matrix.split("\n").find((line) => line.startsWith(`| ${row} |`))!.split(" | ")[3]!;

    it("states a reason for every gap row, and the matrix says the same", () => {
      for (const [id, row] of Object.entries(adapter.manifest.rows)) {
        if (row.status !== "gap") continue;
        expect(row.note.trim().length, id).toBeGreaterThan(20);
        expect(cell(id), id).toMatch(/^gap: \S/);
      }
    });

    it("leaves the rows the core has no mechanism for undecided (P3 is the streaming seam, which every adapter has)", () => {
      for (const id of Object.keys(NO_FLAG_ROWS).filter((row) => row !== "P3") as ParityRowId[]) {
        expect(["match", "approx"], id).not.toContain(adapter.manifest.rows[id].status);
      }
    });
  });

  describe("capability check", () => {
    const manifest = createManifest("1", {
      P5: { status: "match", note: "", requires: ["resumeSession"] },
      P7: { status: "approx", note: "", requires: ["httpMcp"] },
      P13: { status: "spike", note: "", requires: ["imagePrompts"] },
    });

    it("passes when everything a decided row needs is reported, and ignores extras", () => {
      expect(missingCapabilities(manifest, new Set(["resumeSession", "httpMcp"]))).toEqual([]);
      expect(missingCapabilities(manifest, new Set(["resumeSession", "httpMcp", "imagePrompts"]))).toEqual([]);
    });

    it("names the row of each missing capability", () => {
      expect(missingCapabilities(manifest, new Set(["resumeSession"]))).toEqual([{ row: "P7", capability: "httpMcp" }]);
      expect(missingCapabilities(manifest, new Set())).toEqual([
        { row: "P5", capability: "resumeSession" },
        { row: "P7", capability: "httpMcp" },
      ]);
    });

    it("does not check an undecided row", () => {
      expect(missingCapabilities(manifest, new Set(["resumeSession", "httpMcp"])).some((item) => item.row === "P13")).toBe(false);
      const decidedImages = createManifest("1", { P13: { status: "match", note: "", requires: ["imagePrompts"] } });
      expect(missingCapabilities(decidedImages, new Set())).toEqual([{ row: "P13", capability: "imagePrompts" }]);
    });

    it("builds one non-retryable capability_mismatch error that lists every missing row", () => {
      const error = capabilityMismatch("Acme", missingCapabilities(manifest, new Set()));
      expect(error).toMatchObject({ code: "capability_mismatch", retryable: false });
      expect(error.message).toBe(
        "Capability mismatch: Acme does not report session resume (parity row P5) and HTTP MCP servers (parity row P7), which the plugin's manifest needs. Update the CLI.",
      );
    });
  });

  it("keeps PARITY_ROWS in step with the parity matrix", () => {
    const matrix = readFileSync(
      new URL(
        "../../_bmad-output/initiative-openclaw-all-cli/spec-cursor-cli-provider/claude-cli-parity.md",
        import.meta.url,
      ),
      "utf8",
    );
    const ids = [...matrix.matchAll(/^\| (P\d+) \|/gm)].map((match) => match[1]);
    expect(ids).toEqual([...PARITY_ROWS]);
  });
});
