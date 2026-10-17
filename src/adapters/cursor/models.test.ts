import { describe, expect, it } from "vitest";
import { buildCursorCatalog, resolveCursorModel, selectCursorModel } from "./models.ts";

// Shaped like the `session/new` result of cursor-agent 2026.10.16.
const REAL = [
  { id: "default[]", name: "Auto" },
  { id: "grok-4.7[context=256k,reasoning_effort=high,fast=true]", name: "grok-4.7" },
  { id: "composer-2.5[fast=true]", name: "composer-2.5" },
  { id: "claude-opus-5-5[context=300k,effort=medium,fast=false]", name: "claude-opus-5-5" },
  { id: "claude-opus-5[thinking=true,context=300k,effort=high,fast=false]", name: "claude-opus-5" },
  { id: "gemini-3.1-pro[]", name: "gemini-3.1-pro" },
  { id: "gemini-3-flash[]", name: "gemini-3-flash" },
];

describe("buildCursorCatalog", () => {
  it("names a model by its base ID, and Auto as auto", () => {
    const catalog = buildCursorCatalog(REAL);
    expect(catalog.map((model) => model.name)).toEqual([
      "auto",
      "grok-4.7",
      "composer-2.5",
      "claude-opus-5-5",
      "claude-opus-5",
      "gemini-3.1-pro",
      "gemini-3-flash",
    ]);
    expect(catalog[0]).toEqual({ name: "auto", label: "Auto", id: "default[]" });
    expect(catalog[1]).toEqual({
      name: "grok-4.7",
      label: "grok-4.7",
      id: "grok-4.7[context=256k,reasoning_effort=high,fast=true]",
    });
  });

  it("keeps a name while Cursor changes the parameter defaults", () => {
    const before = buildCursorCatalog([{ id: "grok-4.7[context=256k,fast=true]", name: "grok-4.7" }]);
    const after = buildCursorCatalog([{ id: "grok-4.7[context=1m,effort=high,fast=false]", name: "grok-4.7" }]);
    expect(before[0]?.name).toBe("grok-4.7");
    expect(after[0]?.name).toBe(before[0]?.name);
    expect(after[0]?.id).not.toBe(before[0]?.id);
  });

  it("keeps the bare name of the first ID of a base when Cursor adds a variant later", () => {
    const before = buildCursorCatalog([{ id: "grok-4.7[effort=high]", name: "grok-4.7" }]);
    const after = buildCursorCatalog([
      { id: "grok-4.7[effort=high]", name: "grok-4.7" },
      { id: "grok-4.7[effort=low]", name: "grok-4.7" },
    ]);
    expect(before[0]?.name).toBe("grok-4.7");
    expect(after.map((model) => [model.name, model.id])).toEqual([
      ["grok-4.7", "grok-4.7[effort=high]"],
      ["grok-4.7-low", "grok-4.7[effort=low]"],
    ]);
  });

  it("makes names unique when IDs share a base, by parameter values and then key-value pairs", () => {
    const catalog = buildCursorCatalog([
      { id: "twin[effort=low]", name: "twin" },
      { id: "twin[effort=high]", name: "twin" },
      { id: "pair[a=x,b=y]", name: "pair" },
      { id: "pair[a=y,b=x]", name: "pair" },
      { id: "same[a=0]", name: "same" },
      { id: "same[a=1]", name: "same" },
      { id: "same[b=1]", name: "same" },
    ]);
    expect(catalog.map((model) => model.name)).toEqual(["twin", "twin-high", "pair", "pair-y-x", "same", "same-1", "same-b-1"]);
    expect(new Set(catalog.map((model) => model.name)).size).toBe(catalog.length);
    expect(catalog[0]?.label).toBe("twin (effort=low)");
    expect(catalog[1]?.label).toBe("twin (effort=high)");
  });

  it("numbers names that collide even after the key-value suffix", () => {
    const catalog = buildCursorCatalog([
      { id: "tri[a=1]", name: "tri" },
      { id: "tri[a=1]", name: "tri" },
      { id: "tri[a=1]", name: "tri" },
      { id: "tri[a=1]", name: "tri" },
    ]);
    expect(catalog.map((model) => model.name)).toEqual(["tri", "tri-1", "tri-a-1", "tri-2"]);
  });

  it("labels every variant of a shared base with its parameters, the bare-named one included", () => {
    const catalog = buildCursorCatalog([
      { id: "solo[effort=high]", name: "solo" },
      { id: "twin[effort=low]", name: "twin" },
      { id: "twin[effort=high]", name: "twin" },
    ]);
    expect(catalog.map((model) => model.label)).toEqual(["solo", "twin (effort=low)", "twin (effort=high)"]);
  });

  it("numbers names that still collide and skips entries with no usable name", () => {
    const catalog = buildCursorCatalog([
      { id: "dup[x=1]", name: "dup" },
      { id: "dup[x=1]", name: "dup" },
      { id: "[]", name: "" },
    ]);
    expect(catalog.map((model) => model.name)).toEqual(["dup", "dup-1"]);
    expect(new Set(catalog.map((model) => model.name)).size).toBe(catalog.length);
    expect(catalog).toHaveLength(2);
  });

  it("writes names that are safe in a model ref", () => {
    const [model] = buildCursorCatalog([{ id: "Weird Model/Name:1[x=1]", name: "Weird" }]);
    expect(model?.name).toMatch(/^[a-z0-9._-]+$/);
    expect(model?.id).toBe("Weird Model/Name:1[x=1]");
  });
});

describe("resolveCursorModel", () => {
  const catalog = buildCursorCatalog(REAL);

  it("resolves the readable name, the exact ID, and any case of either", () => {
    const exact = "grok-4.7[context=256k,reasoning_effort=high,fast=true]";
    expect(resolveCursorModel("grok-4.7", catalog)?.id).toBe(exact);
    expect(resolveCursorModel("GROK-4.7", catalog)?.id).toBe(exact);
    expect(resolveCursorModel(exact, catalog)?.id).toBe(exact);
    expect(resolveCursorModel(exact.toUpperCase(), catalog)?.id).toBe(exact);
    expect(resolveCursorModel("  composer-2.5  ", catalog)?.id).toBe("composer-2.5[fast=true]");
  });

  it("resolves Cursor's spellings of Auto", () => {
    for (const name of ["auto", "AUTO", "default", "default[]"]) {
      expect(resolveCursorModel(name, catalog)?.id).toBe("default[]");
    }
  });

  it("returns nothing for a model the account lacks, and the bare base resolves to the first of its variants", () => {
    expect(resolveCursorModel("gpt-9", catalog)).toBeUndefined();
    const twins = buildCursorCatalog([
      { id: "twin[effort=low]", name: "twin" },
      { id: "twin[effort=high]", name: "twin" },
    ]);
    expect(resolveCursorModel("twin", twins)?.id).toBe("twin[effort=low]");
    expect(resolveCursorModel("twin-high", twins)?.id).toBe("twin[effort=high]");
  });
});

describe("selectCursorModel", () => {
  it("returns the exact ID, undefined for an unknown model, and null for auto without an Auto entry", () => {
    expect(selectCursorModel("grok-4.7", REAL)).toBe("grok-4.7[context=256k,reasoning_effort=high,fast=true]");
    expect(selectCursorModel("auto", REAL)).toBe("default[]");
    expect(selectCursorModel("nope", REAL)).toBeUndefined();
    expect(selectCursorModel("auto", [])).toBeNull();
    expect(selectCursorModel("auto", REAL.slice(1))).toBeNull();
    expect(selectCursorModel("grok-4.7", [])).toBeUndefined();
  });
});
