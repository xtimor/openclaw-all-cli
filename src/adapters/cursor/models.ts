import type { CliModel } from "../../core/ports.ts";

/** A model as Cursor's ACP session reports it: the exact ID (brackets and commas included) and a name. */
export type CursorModelEntry = { id: string; name: string };

/** The model name that means "let Cursor choose". Cursor's own ID for it is `default[]`. */
const AUTO_MODEL = "auto";
const CURSOR_AUTO_BASE = "default";

type ParsedId = { base: string; params: Array<[key: string, value: string]> };

/** Splits `grok-4.7[context=256k,fast=true]` into the base model and its parameters. */
function parseId(id: string): ParsedId {
  const match = /^([^[]*)\[(.*)\]$/s.exec(id);
  if (!match) return { base: id, params: [] };
  const params = (match[2] ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part): [string, string] => {
      const at = part.indexOf("=");
      return at < 0 ? ["", part] : [part.slice(0, at).trim(), part.slice(at + 1).trim()];
    });
  return { base: match[1] ?? id, params };
}

/** A name safe in a model ref: lowercase letters, digits, dots, dashes, underscores. */
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Names Cursor's models for `cursor-cli/<name>`. A model's name is its base ID without the
 * parameter list (`grok-4.7`), so it stays the same while Cursor keeps the base name and changes
 * the defaults. When several IDs share a base, the first in Cursor's list keeps the bare name and
 * the others get their parameter values as a suffix, then `key-value` pairs, then a number, so
 * names stay unique. That makes names depend on Cursor's list order: a variant appended after the
 * first leaves every name alone, but a variant added ahead of the first, a reorder, or the removal
 * of the first moves the bare name (and the suffixed names that follow it) to another variant. The
 * exact ID stays the source of truth. Every variant of a shared base is labelled with its
 * parameters, the bare-named one included, so `/model` tells them apart.
 */
export function buildCursorCatalog(entries: readonly CursorModelEntry[]): CliModel[] {
  const parsed = entries.map((entry) => {
    const id = parseId(entry.id);
    return { entry, params: id.params, base: id.base === CURSOR_AUTO_BASE ? AUTO_MODEL : slug(id.base || entry.name) };
  });

  // Bare names first, so a suffixed name can never take one.
  const bareOwner = new Map<string, number>();
  parsed.forEach((item, index) => {
    if (item.base && !bareOwner.has(item.base)) bareOwner.set(item.base, index);
  });
  const taken = new Set(bareOwner.keys());
  const variants = new Map<string, number>();
  for (const item of parsed) variants.set(item.base, (variants.get(item.base) ?? 0) + 1);

  const catalog: CliModel[] = [];
  parsed.forEach((item, index) => {
    if (!item.base) return;
    let name: string | undefined;
    if (bareOwner.get(item.base) === index) {
      name = item.base;
    } else {
      const candidates = [
        slug([item.base, ...item.params.map(([, value]) => value)].join("-")),
        slug([item.base, ...item.params.map(([key, value]) => `${key}-${value}`)].join("-")),
      ];
      name = candidates.find((candidate) => candidate && !taken.has(candidate));
      for (let number = 2; !name; number += 1) {
        const numbered = `${item.base}-${number}`;
        if (!taken.has(numbered)) name = numbered;
      }
      taken.add(name);
    }
    const shared = (variants.get(item.base) ?? 0) > 1 && item.params.length > 0;
    const suffix = shared ? ` (${item.params.map(([key, value]) => (key ? `${key}=${value}` : value)).join(", ")})` : "";
    catalog.push({ name, label: `${item.entry.name || item.base}${suffix}`, id: item.entry.id });
  });
  return catalog;
}

/**
 * Finds the exact Cursor ID for a requested model: the readable name, Cursor's exact ID, or
 * Cursor's own spelling of Auto. Case is ignored. `undefined` means the account has no such model.
 */
export function resolveCursorModel(requested: string, catalog: readonly CliModel[]): CliModel | undefined {
  const wanted = requested.trim();
  const lower = wanted.toLowerCase();
  const wantsAuto = lower === AUTO_MODEL || lower === CURSOR_AUTO_BASE || lower === `${CURSOR_AUTO_BASE}[]`;
  return (
    catalog.find((model) => model.name === lower) ??
    catalog.find((model) => model.id === wanted) ??
    catalog.find((model) => model.id.toLowerCase() === lower) ??
    (wantsAuto ? catalog.find((model) => model.name === AUTO_MODEL) : undefined)
  );
}

/**
 * The model choice for an ACP session (the transport's `selectModel`): the exact ID to switch to,
 * `null` to keep the session's model, `undefined` for a model the account lacks.
 *
 * Cursor remembers the last model in the config directory, so a session can start on another
 * model than Auto. `auto` therefore switches back unless the session is already on Auto.
 */
export function selectCursorModel(
  requested: string,
  offered: readonly CursorModelEntry[],
): string | null | undefined {
  const catalog = buildCursorCatalog(offered);
  const found = resolveCursorModel(requested, catalog);
  if (found) return found.id;
  // An agent whose list has no Auto entry cannot be switched to it: keep what it runs.
  return requested.trim().toLowerCase() === AUTO_MODEL ? null : undefined;
}
