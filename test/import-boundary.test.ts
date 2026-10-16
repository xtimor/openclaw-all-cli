import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** AD-2: dependency direction. Reads the source tree and checks every import. */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const files = walk(SRC).filter((file) => file.endsWith(".ts"));
const rel = (file: string) => relative(SRC, file).split("\\").join("/");
const isTest = (file: string) => file.endsWith(".test.ts");

const IMPORT_PATTERNS = [
  /\bimport\s+(?:type\s+)?(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/g,
  /\bexport\s+(?:type\s+)?[^"'()]*?\s+from\s+["']([^"']+)["']/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
];

function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const found = new Set<string>();
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of text.matchAll(pattern)) found.add(match[1]!);
  }
  return [...found];
}

/** The `src/`-relative path an import points at, or undefined for a package import. */
function target(file: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  return rel(resolve(dirname(file), specifier)).replace(/\.(ts|js)$/, "");
}

const adapterDirs = readdirSync(join(SRC, "adapters")).filter((name) => statSync(join(SRC, "adapters", name)).isDirectory());
const layerOf = (file: string): "core" | "transports" | "adapters" | "root" => {
  const path = rel(file);
  if (path.startsWith("core/")) return "core";
  if (path.startsWith("transports/")) return "transports";
  if (path.startsWith("adapters/")) return "adapters";
  return "root";
};

const productionFiles = files.filter((file) => !isTest(file));

describe("import boundaries (AD-2)", () => {
  it("sees the source tree", () => {
    expect(adapterDirs).toContain("cursor");
    expect(productionFiles.length).toBeGreaterThan(5);
  });

  it("lets only src/plugin.ts and src/core/ import the OpenClaw SDK", () => {
    const offenders = productionFiles
      .filter((file) => importsOf(file).some((spec) => spec === "openclaw" || spec.startsWith("openclaw/")))
      .map(rel)
      .filter((path) => path !== "plugin.ts" && !path.startsWith("core/"));
    expect(offenders).toEqual([]);
  });

  it("keeps the core free of adapters, transports, and composition roots", () => {
    const offenders = productionFiles
      .filter((file) => layerOf(file) === "core")
      .flatMap((file) =>
        importsOf(file)
          .map((spec) => ({ file: rel(file), to: target(file, spec) }))
          .filter(({ to }) => to !== undefined && !to.startsWith("core/")),
      );
    expect(offenders).toEqual([]);
  });

  it("lets transports import only core ports and other transports", () => {
    const offenders = productionFiles
      .filter((file) => layerOf(file) === "transports")
      .flatMap((file) =>
        importsOf(file)
          .map((spec) => ({ file: rel(file), to: target(file, spec) }))
          .filter(({ to }) => to !== undefined && to !== "core/ports" && !to.startsWith("transports/")),
      );
    expect(offenders).toEqual([]);
  });

  it("lets adapters import only core ports, transports, and their own files", () => {
    const offenders = productionFiles
      .filter((file) => layerOf(file) === "adapters")
      .flatMap((file) => {
        const own = `adapters/${rel(file).split("/")[1]}/`;
        return importsOf(file)
          .map((spec) => ({ file: rel(file), to: target(file, spec) }))
          .filter(
            ({ to }) =>
              to !== undefined && to !== "core/ports" && !to.startsWith("transports/") && !to.startsWith(own),
          );
      });
    expect(offenders).toEqual([]);
  });

  it("keeps adapters, transports, and the core off the OpenClaw SDK and each other's packages", () => {
    const offenders = productionFiles
      .filter((file) => layerOf(file) === "adapters" || layerOf(file) === "transports")
      .flatMap((file) =>
        importsOf(file)
          .filter((spec) => !spec.startsWith(".") && !spec.startsWith("node:"))
          .filter((spec) => !spec.startsWith("@agentclientprotocol/") && !spec.startsWith("@modelcontextprotocol/"))
          .map((spec) => `${rel(file)} -> ${spec}`),
      );
    expect(offenders).toEqual([]);
  });

  it("lets nothing import a composition root", () => {
    const roots = new Set(["plugin", "provider-discovery", "registry"]);
    const offenders = productionFiles.flatMap((file) =>
      importsOf(file)
        .map((spec) => ({ file: rel(file), to: target(file, spec) }))
        .filter(({ to }) => to !== undefined && roots.has(to))
        .filter(({ file: from }) => layerOf(resolve(SRC, from)) !== "root"),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps the core and the transports from naming any CLI (tests may use a CLI's fixtures)", () => {
    const names = [...adapterDirs, "cursor", "antigravity"];
    const pattern = new RegExp(`\\b(${[...new Set(names)].join("|")})`, "i");
    const offenders = productionFiles
      .filter((file) => layerOf(file) === "core" || layerOf(file) === "transports")
      .filter((file) => pattern.test(readFileSync(file, "utf8")))
      .map(rel);
    expect(offenders).toEqual([]);
  });
});
