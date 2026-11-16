import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Plan 27: the backend once imported a method ID from the auth methods, which import the backend.
// Shared constants live in leaf modules (`src/core/auth-ids.ts`); no runtime import cycle in `src/`.

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}

/** Relative imports that load a module at run time: `import type` and all-type named imports do not. */
function runtimeImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const found: string[] = [];
  for (const match of text.matchAll(/^(import|export)\s+(type\s+)?([^;]*?)\s+from\s+"(\.[^"]+)"/gms)) {
    if (match[2]) continue;
    const named = /^\{([^}]*)\}$/.exec(match[3]!.trim());
    if (named && named[1]!.split(",").every((part) => !part.trim() || part.trim().startsWith("type "))) continue;
    found.push(normalize(join(dirname(file), match[4]!)));
  }
  return found;
}

function cycles(graph: Map<string, string[]>): string[][] {
  const found: string[][] = [];
  const state = new Map<string, "open" | "done">();
  const visit = (node: string, path: string[]) => {
    state.set(node, "open");
    for (const next of graph.get(node) ?? []) {
      if (state.get(next) === "open") found.push([...path.slice(path.indexOf(next)), next]);
      else if (!state.has(next)) visit(next, [...path, next]);
    }
    state.set(node, "done");
  };
  for (const node of graph.keys()) if (!state.has(node)) visit(node, [node]);
  return found;
}

describe("module imports in src/", () => {
  it("form no runtime cycle", () => {
    const graph = new Map(sources(SRC).map((file) => [normalize(file), runtimeImports(file)] as const));
    expect(graph.size).toBeGreaterThan(20);
    expect(cycles(graph).map((cycle) => cycle.map((file) => relative(SRC, file)).join(" -> "))).toEqual([]);
  });

  it("would see the old backend <-> provider-auth cycle", () => {
    const graph = new Map([
      ["backend.ts", ["provider-auth.ts"]],
      ["provider-auth.ts", ["backend.ts"]],
    ]);
    expect(cycles(graph)).toEqual([["backend.ts", "provider-auth.ts", "backend.ts"]]);
  });
});
