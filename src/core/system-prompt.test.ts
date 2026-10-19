import { describe, expect, it } from "vitest";
import { DeliveredPrompts, SYSTEM_PROMPT_HEADER, SYSTEM_PROMPT_TRANSPORT_MARKER, systemPromptBlock } from "./system-prompt.ts";

describe("systemPromptBlock", () => {
  it("wraps the text verbatim between the header and a closing tag", () => {
    const text = "  line one\n\n<b>line</b> two  \n";
    expect(systemPromptBlock(text)).toBe(`${SYSTEM_PROMPT_HEADER}\n<openclaw_system_prompt>\n${text}\n</openclaw_system_prompt>`);
  });

  it("names OpenClaw only (AD-2) and says a later block replaces an earlier one", () => {
    expect(SYSTEM_PROMPT_HEADER).not.toMatch(/cursor/i);
    expect(SYSTEM_PROMPT_HEADER).toContain("OpenClaw");
    expect(SYSTEM_PROMPT_HEADER).toContain("replace any earlier OpenClaw system instructions");
    expect(SYSTEM_PROMPT_TRANSPORT_MARKER).not.toMatch(/cursor/i);
  });
});

describe("DeliveredPrompts", () => {
  it("needs a text until it is recorded, and again once the text changes", () => {
    const ledger = new DeliveredPrompts();
    expect(ledger.needs("a", "one")).toBe(true);
    ledger.record("a", "one");
    expect(ledger.needs("a", "one")).toBe(false);
    expect(ledger.needs("a", "two")).toBe(true);
    ledger.record("a", "two");
    expect(ledger.needs("a", "two")).toBe(false);
    expect(ledger.needs("a", "one")).toBe(true);
  });

  it("keeps a separate entry per key, so two homes never share a delivery", () => {
    const ledger = new DeliveredPrompts();
    ledger.record(JSON.stringify(["/home/a", "s1"]), "text");
    expect(ledger.needs(JSON.stringify(["/home/a", "s1"]), "text")).toBe(false);
    expect(ledger.needs(JSON.stringify(["/home/b", "s1"]), "text")).toBe(true);
  });

  it("evicts the oldest entry at the cap, and a read does not refresh it", () => {
    const ledger = new DeliveredPrompts(2);
    ledger.record("a", "t");
    ledger.record("b", "t");
    ledger.record("a", "t");
    ledger.record("c", "t");
    expect(ledger.needs("b", "t")).toBe(true);
    expect(ledger.needs("a", "t")).toBe(false);
    expect(ledger.needs("c", "t")).toBe(false);
  });
});
