import { expect, it } from "vitest";
import { registerAdapters } from "../src/core/register.ts";
import { ADAPTERS } from "../src/registry.ts";

it("registers a session_end hook, so a finished conversation releases its process", () => {
  const hooks: string[] = [];
  registerAdapters(
    {
      pluginConfig: {},
      registerProvider: () => {},
      registerCliBackend: () => {},
      logger: { warn: () => {} },
      on: (name: string) => void hooks.push(name),
    } as never,
    ADAPTERS,
  );
  expect(hooks).toContain("session_end");
});
