import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseAst } from "vite";

/**
 * Loads OpenClaw's own code for the host-contract tests, by function name. The host ships its code
 * in hashed chunks and exports most functions under one-letter aliases, so neither a chunk name nor
 * an alias is stable; the function name is. Nothing here copies or patches host code: a function is
 * either imported through its chunk's export list, or (when the host keeps it private) its source is
 * cut out of the chunk and run against the chunk's own imports.
 *
 * A host version that renames or moves a function fails the lookup loudly, which is what these
 * tests are for: they are the recheck of the host contracts the backend shape relies on.
 */

/** The host's `dist` directory: `OPENCLAW_ALL_CLI_HOST_DIST`, else the isolated OpenClaw under `.spike/`. */
export const HOST_DIST =
  process.env.OPENCLAW_ALL_CLI_HOST_DIST ||
  fileURLToPath(new URL("../../.spike/openclaw/node_modules/openclaw/dist", import.meta.url));

export const hostAvailable = existsSync(HOST_DIST);

type Chunk = { file: string; source: string };

const chunkCache = new Map<string, Chunk>();

/** The one top-level chunk that declares `function <name>(`. */
function findChunk(name: string): Chunk {
  const cached = chunkCache.get(name);
  if (cached) return cached;
  const declaration = new RegExp(`^(?:async )?function ${name.replace(/[$]/g, "\\$&")}\\(`, "m");
  const found: Chunk[] = [];
  for (const entry of readdirSync(HOST_DIST)) {
    if (!entry.endsWith(".mjs") && !entry.endsWith(".js")) continue;
    const file = join(HOST_DIST, entry);
    const source = readFileSync(file, "utf8");
    if (source.includes(`function ${name}(`) && declaration.test(source)) found.push({ file, source });
  }
  if (found.length !== 1) {
    throw new Error(
      `Host function ${name} was declared in ${found.length} chunks of ${HOST_DIST} (need exactly 1). ` +
        "The host moved or renamed it: recheck the contract this test pins.",
    );
  }
  chunkCache.set(name, found[0]!);
  return found[0]!;
}

type Node = { type: string; start: number; end: number; [key: string]: any };

const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && typeof (value as Node).type === "string";

/** The names a binding pattern declares. */
function patternNames(pattern: Node | null | undefined, into: Set<string>): void {
  if (!pattern) return;
  switch (pattern.type) {
    case "Identifier":
      into.add(pattern.name);
      break;
    case "ObjectPattern":
      for (const property of pattern.properties) patternNames(property.type === "RestElement" ? property.argument : property.value, into);
      break;
    case "ArrayPattern":
      for (const element of pattern.elements) patternNames(element, into);
      break;
    case "RestElement":
      patternNames(pattern.argument, into);
      break;
    case "AssignmentPattern":
      patternNames(pattern.left, into);
      break;
  }
}

/** Walks every node under `root`, calling `visit` with the node and the key it hangs under in its parent. */
function walk(root: Node, visit: (node: Node, parent: Node | undefined, key: string) => void): void {
  const step = (node: Node, parent: Node | undefined, key: string) => {
    visit(node, parent, key);
    for (const [childKey, child] of Object.entries(node)) {
      if (Array.isArray(child)) {
        for (const item of child) if (isNode(item)) step(item, node, childKey);
      } else if (isNode(child)) {
        step(child, node, childKey);
      }
    }
  };
  step(root, undefined, "");
}

/** Whether an identifier node is a reference to a binding (not a property name or a label). */
function isReference(node: Node, parent: Node | undefined, key: string): boolean {
  if (!parent) return true;
  if (parent.type === "MemberExpression" && key === "property" && !parent.computed) return false;
  if ((parent.type === "Property" || parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") && key === "key" && !parent.computed) {
    // A shorthand `{ name }` reads the binding through its value node.
    return false;
  }
  if (parent.type === "LabeledStatement" || parent.type === "BreakStatement" || parent.type === "ContinueStatement") return false;
  return true;
}

/** Loads a module by the specifier a chunk used: relative to the chunk, or a bare/`node:` specifier. */
async function importFrom(chunkFile: string, specifier: string): Promise<Record<string, unknown>> {
  const target = specifier.startsWith(".") ? pathToFileURL(resolve(dirname(chunkFile), specifier)).href : specifier;
  return (await import(/* @vite-ignore */ target)) as Record<string, unknown>;
}

/**
 * A function the host exports (under whatever alias), found by its declared name. Imports the
 * function's chunk and returns the export.
 */
export async function hostExport<T = (...args: any[]) => any>(name: string): Promise<T> {
  const chunk = findChunk(name);
  const lists = [...chunk.source.matchAll(/^export \{([^}]*)\}/gm)].flatMap((match) => match[1]!.split(","));
  let alias: string | undefined;
  for (const item of lists) {
    const parts = item.trim().split(/\s+as\s+/);
    if (parts[0] === name) alias = parts[1] ?? parts[0];
  }
  if (!alias) throw new Error(`Host function ${name} is declared in ${chunk.file} but that chunk does not export it. Use hostFunction(${JSON.stringify(name)}).`);
  const loaded = await importFrom(chunk.file, pathToFileURL(chunk.file).href);
  if (typeof loaded[alias] !== "function") throw new Error(`Host chunk ${chunk.file} exports ${alias} for ${name}, which is not a function.`);
  return loaded[alias] as T;
}

/**
 * A function the host keeps private to its chunk. The declaration is cut out with the chunk's own
 * parser output, every import it names is bound from the chunk's own import list, and the host's body
 * runs unchanged. A name it needs that the chunk declares itself (not an import) throws, so a host
 * change that adds one is noticed rather than guessed around.
 */
export async function hostFunction<T = (...args: any[]) => any>(name: string): Promise<T> {
  const chunk = findChunk(name);
  const program = parseAst(chunk.source) as unknown as Node;

  const imports = new Map<string, { specifier: string; imported: string | "*" | "default" }>();
  const declared = new Set<string>();
  let target: Node | undefined;
  for (const statement of program.body as Node[]) {
    if (statement.type === "ImportDeclaration") {
      for (const specifier of statement.specifiers as Node[]) {
        const imported =
          specifier.type === "ImportSpecifier" ? (specifier.imported.name ?? specifier.imported.value) : specifier.type === "ImportDefaultSpecifier" ? "default" : "*";
        imports.set(specifier.local.name, { specifier: statement.source.value, imported });
      }
      continue;
    }
    const declaration = statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration" ? (statement.declaration as Node | null) : statement;
    if (!declaration) continue;
    if (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") {
      if (declaration.id) declared.add(declaration.id.name);
      if (declaration.type === "FunctionDeclaration" && declaration.id?.name === name) target = declaration;
    } else if (declaration.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations as Node[]) patternNames(declarator.id, declared);
    }
  }
  if (!target) throw new Error(`Host function ${name} has no top-level declaration in ${chunk.file}.`);

  // Names the function binds itself (parameters, variables, inner functions, catch clauses).
  const own = new Set<string>([name]);
  const referenced = new Set<string>();
  walk(target, (node, parent, key) => {
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
      for (const param of node.params as Node[]) patternNames(param, own);
      if (node.type !== "ArrowFunctionExpression" && node.id) own.add(node.id.name);
    } else if (node.type === "VariableDeclarator") {
      patternNames(node.id, own);
    } else if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
      if (node.id) own.add(node.id.name);
    } else if (node.type === "CatchClause") {
      patternNames(node.param, own);
    } else if (node.type === "Identifier" && isReference(node, parent, key)) {
      referenced.add(node.name);
    }
  });

  const free = [...referenced].filter((id) => !own.has(id));
  const needsLocal = free.filter((id) => declared.has(id) && !imports.has(id));
  if (needsLocal.length > 0) {
    throw new Error(
      `Host function ${name} (${chunk.file}) needs chunk-local binding(s) ${needsLocal.join(", ")}, which cannot be taken from the chunk's imports. ` +
        "The host changed it: recheck the contract this test pins.",
    );
  }
  const bound = free.filter((id) => imports.has(id));
  const modules = new Map<string, Record<string, unknown>>();
  const values: unknown[] = [];
  for (const id of bound) {
    const { specifier, imported } = imports.get(id)!;
    let loaded = modules.get(specifier);
    if (!loaded) {
      loaded = await importFrom(chunk.file, specifier);
      modules.set(specifier, loaded);
    }
    values.push(imported === "*" ? loaded : loaded[imported]);
  }
  const source = chunk.source.slice(target.start, target.end);
  return new Function(...bound, `return (${source});`)(...values) as T;
}
