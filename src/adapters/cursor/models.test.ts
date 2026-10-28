import { describe, expect, it } from "vitest";
import { buildCursorCatalog, cursorContextCeiling, resolveCursorModel, selectCursorModel } from "./models.ts";

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
      reasoning: true,
      contextWindow: 256_000,
    });
  });

  it("gives a row its own context window, else its family's, else none", () => {
    const windows = Object.fromEntries(buildCursorCatalog(REAL).map((model) => [model.name, model.contextWindow]));
    expect(windows).toEqual({
      auto: undefined,
      "grok-4.7": 256_000,
      "composer-2.5": undefined,
      "claude-opus-5-5": 300_000,
      "claude-opus-5": 300_000,
      "gemini-3.1-pro": undefined,
      "gemini-3-flash": undefined,
    });
    // A row without the parameter takes its family's window, a row with it keeps its own.
    const rows = buildCursorCatalog([
      { id: "grok-4.7[reasoning_effort=high]", name: "grok-4.7" },
      { id: "grok-4.7[Context=1m,fast=true]", name: "grok-4.7" },
      { id: "claude-opus-5-5[effort=low]", name: "claude-opus-5-5" },
      { id: "mystery[context=64k]", name: "mystery" },
      { id: "mystery-2[fast=true]", name: "mystery-2" },
    ]);
    expect(rows.map((model) => model.contextWindow)).toEqual([256_000, 1_000_000, 300_000, 64_000, undefined]);
    // The row object holds no window key at all when unknown, so nothing undefined is published.
    expect("contextWindow" in rows[4]!).toBe(false);
  });

  it("reads k and m as 1 000 and 1 000 000, and ignores a value that is not a window", () => {
    const of = (value: string, base = "mystery") => buildCursorCatalog([{ id: `${base}[context=${value}]`, name: base }])[0]?.contextWindow;
    expect([of("256k"), of("1m"), of("1M"), of("1.5m"), of("200000")]).toEqual([256_000, 1_000_000, 1_000_000, 1_500_000, 200_000]);
    expect([of("max"), of("0"), of("0k"), of(""), of("-5k"), of("1e3")]).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    // A bad value falls back to the family, never throws.
    expect(of("max", "grok-4.7")).toBe(256_000);
    expect(buildCursorCatalog([{ id: "constructor[]", name: "constructor" }])[0]?.contextWindow).toBeUndefined();
  });

  it("marks a model reasoning when its ID carries an effort parameter, and no other", () => {
    const rows = Object.fromEntries(buildCursorCatalog(REAL).map((model) => [model.name, model.reasoning]));
    expect(rows).toEqual({
      auto: undefined,
      "grok-4.7": true,
      "composer-2.5": undefined,
      "claude-opus-5-5": true,
      "claude-opus-5": true,
      "gemini-3.1-pro": undefined,
      "gemini-3-flash": undefined,
    });
    const twins = buildCursorCatalog([
      { id: "twin[effort=low]", name: "twin" },
      { id: "twin[Reasoning_Effort=high]", name: "twin" },
    ]);
    expect(twins.map((model) => model.reasoning)).toEqual([true, true]);
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

describe("selectCursorModel with a thinking level", () => {
  const LISTING = [
    { id: "default[]", name: "Auto" },
    { id: "x[reasoning_effort=high,fast=true]", name: "x" },
    { id: "x[reasoning_effort=low,fast=true]", name: "x" },
    { id: "x[reasoning_effort=medium,fast=true]", name: "x" },
    { id: "x[reasoning_effort=none,fast=true]", name: "x" },
    { id: "x[reasoning_effort=high,fast=false]", name: "x" },
    { id: "composer-2.5[fast=true]", name: "composer-2.5" },
    { id: "solo[effort=high]", name: "solo" },
  ];

  it("picks the listed variant with the matching effort and the same other parameters", () => {
    expect(selectCursorModel("x", LISTING, "low")).toBe("x[reasoning_effort=low,fast=true]");
    expect(selectCursorModel("x", LISTING, "MEDIUM")).toBe("x[reasoning_effort=medium,fast=true]");
    expect(selectCursorModel("x", LISTING, "off")).toBe("x[reasoning_effort=none,fast=true]");
    // From a suffixed row too: the choice depends on the base and the other parameters, not on the row's own effort.
    expect(selectCursorModel("x[reasoning_effort=low,fast=true]", LISTING, "high")).toBe("x[reasoning_effort=high,fast=true]");
    expect(selectCursorModel("x[reasoning_effort=high,fast=false]", LISTING, "low")).toBe("x[reasoning_effort=high,fast=false]");
  });

  it("keeps the row's own ID for no level, a level without a variant, adaptive, or a model without effort", () => {
    expect(selectCursorModel("x", LISTING)).toBe("x[reasoning_effort=high,fast=true]");
    expect(selectCursorModel("x", LISTING, "xhigh")).toBe("x[reasoning_effort=high,fast=true]");
    expect(selectCursorModel("x", LISTING, "adaptive")).toBe("x[reasoning_effort=high,fast=true]");
    expect(selectCursorModel("solo", LISTING, "low")).toBe("solo[effort=high]");
    expect(selectCursorModel("composer-2.5", LISTING, "high")).toBe("composer-2.5[fast=true]");
    expect(selectCursorModel("auto", LISTING, "high")).toBe("default[]");
  });

  it("never returns an ID Cursor did not list, and leaves unknown models and null unchanged", () => {
    expect(selectCursorModel("nope", LISTING, "low")).toBeUndefined();
    expect(selectCursorModel("auto", [], "low")).toBeNull();
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max", "weird"]) {
      expect(LISTING.map((entry) => entry.id)).toContain(selectCursorModel("x", LISTING, level));
    }
  });
});

describe("cursorContextCeiling (issue #40)", () => {
  it("is the model's own window", () => {
    expect(cursorContextCeiling("grok-4.7[context=256k,reasoning_effort=high,fast=true]", REAL)).toBe(256_000);
    expect(cursorContextCeiling("claude-opus-5-5[context=300k,effort=medium,fast=false]", REAL)).toBe(300_000);
  });

  it("is the largest listed window for Auto, a model without a window, or an unnamed model", () => {
    expect(cursorContextCeiling("default[]", REAL)).toBe(300_000);
    expect(cursorContextCeiling("composer-2.5[fast=true]", REAL)).toBe(300_000);
    expect(cursorContextCeiling(undefined, REAL)).toBe(300_000);
    expect(cursorContextCeiling("default[]", [...REAL, { id: "grok-4.7[context=1m]", name: "grok-4.7" }])).toBe(1_000_000);
  });

  it("is none when no listed model has a window", () => {
    expect(cursorContextCeiling("default[]", [{ id: "default[]", name: "Auto" }, { id: "composer-2.5[fast=true]", name: "composer-2.5" }])).toBeUndefined();
    expect(cursorContextCeiling("default[]", [])).toBeUndefined();
  });
});

// Issue #46. Probed live 2026-10-28 (cursor-agent 2026.10.22): the ACP session lists only 300k rows for the
// Opus family, and `session/set_model` / `session/set_config_option` answer `Invalid model value` for every
// `context=1m` spelling (also for the listed row's own ID with `context=1m`). `cursor-agent -p --model` accepts
// the 1M ID, so the refusal is ACP's. The plugin therefore lists no 1M variant of its own making.
describe("1M variants (issue #46)", () => {
  const OPUS_300K = "claude-opus-5-5[context=300k,effort=medium,fast=false]";
  const OPUS_1M = "claude-opus-5-5[context=1m,effort=medium,fast=false]";

  it("does not invent a 1M row: a 1M name or ID Cursor did not list resolves to nothing", () => {
    const catalog = buildCursorCatalog(REAL);
    expect(catalog.map((model) => model.id)).not.toContain(OPUS_1M);
    expect(catalog.some((model) => model.name.includes("1m"))).toBe(false);
    for (const asked of ["claude-opus-5-5-1m", OPUS_1M, "claude-opus-5-5[context=1m]"]) {
      expect(resolveCursorModel(asked, catalog)).toBeUndefined();
      expect(selectCursorModel(asked, REAL)).toBeUndefined();
    }
    // The existing name keeps running the listed 300k row.
    expect(selectCursorModel("claude-opus-5-5", REAL)).toBe(OPUS_300K);
  });

  it("uses the window in a listed 1M ID, never the family's, and keeps every existing name", () => {
    const listed = [...REAL, { id: OPUS_1M, name: "claude-opus-5-5" }];
    const before = buildCursorCatalog(REAL);
    const after = buildCursorCatalog(listed);
    // A variant appended after the first leaves every earlier name, ID, and window alone.
    expect(after.slice(0, before.length).map(({ name, id, contextWindow }) => ({ name, id, contextWindow }))).toEqual(
      before.map(({ name, id, contextWindow }) => ({ name, id, contextWindow })),
    );
    const variant = after[after.length - 1]!;
    expect(variant.id).toBe(OPUS_1M);
    expect(variant.name).not.toBe("claude-opus-5-5");
    expect(variant.contextWindow).toBe(1_000_000);
    expect(after.find((model) => model.name === "claude-opus-5-5")?.contextWindow).toBe(300_000);
  });

  it("gives a 1M row a 1,000,000 ceiling and leaves the 300k row at 300,000", () => {
    const listed = [...REAL, { id: OPUS_1M, name: "claude-opus-5-5" }];
    expect(cursorContextCeiling(OPUS_1M, listed)).toBe(1_000_000);
    expect(cursorContextCeiling(OPUS_300K, listed)).toBe(300_000);
  });
});
