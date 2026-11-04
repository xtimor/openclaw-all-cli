import { describe, expect, it } from "vitest";
import { selectNativeProfile } from "./permissions.ts";

const ON = ["read", "grep", "glob"];
const pick = (native: string[], restricted?: string) => selectNativeProfile({ native, openClaw: [] }, ON, restricted);

describe("selectNativeProfile", () => {
  it("picks the default profile for a full selection and for no availability", () => {
    expect(pick(["read", "grep", "glob", "exec"], "restricted")).toEqual({ blocked: [] });
    expect(selectNativeProfile(undefined, ON, "restricted")).toEqual({ blocked: [] });
  });

  it("picks the restricted profile for an empty selection", () => {
    expect(pick([], "restricted")).toEqual({ profile: "restricted", blocked: [] });
    expect(pick(["exec"], "restricted")).toEqual({ profile: "restricted", blocked: [] });
  });

  it("blocks a partial selection, naming the tools that stayed on", () => {
    expect(pick(["read"], "restricted")).toEqual({ blocked: ["grep", "glob"] });
    expect(pick(["grep", "glob"], "restricted")).toEqual({ blocked: ["read"] });
  });

  it("blocks an empty selection when the adapter has no restricted profile", () => {
    expect(pick([])).toEqual({ blocked: ON });
  });
});
