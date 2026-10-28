import type { CliModel } from "../../core/ports.ts";

/** A model as Cursor's ACP session reports it: the exact ID (brackets and commas included) and a name. */
export type CursorModelEntry = { id: string; name: string };

/** The model name that means "let Cursor choose". Cursor's own ID for it is `default[]`. */
const AUTO_MODEL = "auto";
const CURSOR_AUTO_BASE = "default";

type ParsedId = { base: string; params: Array<[key: string, value: string]> };

/** Cursor's parameter names for a model's reasoning effort (`grok-4.7[reasoning_effort=high]`, `claude-opus-5-5[effort=medium]`). */
const EFFORT_KEYS: ReadonlySet<string> = new Set(["reasoning_effort", "effort"]);

function isEffortKey(key: string): boolean {
  return EFFORT_KEYS.has(key.toLowerCase());
}

/**
 * Context windows of model families, for rows whose ID carries no `context` parameter. Only values
 * seen in a Cursor listing (cursor-agent 2026.10.16: `grok-4.7[context=256k,...]`,
 * `claude-opus-5-5[context=300k,...]`, `claude-opus-5[...context=300k...]`) are here. A family that
 * Cursor's listing never gave a window for (Auto, `composer-*`, `gemini-*`) stays out: no guess.
 * These are the ACP session's defaults, not the models' limits: Cursor sells the Opus rows with a 1M
 * window, but ACP refuses a `context=1m` ID (issue #46), so no 1M row is listed or built here. A row
 * whose own ID carries `context` never reads this table.
 */
const FAMILY_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  "grok-4.7": 256_000,
  "claude-opus-5-5": 300_000,
  "claude-opus-5": 300_000,
};

/** `256k` is 256 000 and `1m` is 1 000 000 (the smaller reading, so compaction never comes late). Anything else is not a window. */
function parseWindow(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([km]?)$/i.exec(text.trim());
  if (!match) return undefined;
  const unit = (match[2] ?? "").toLowerCase();
  const value = Math.round(Number(match[1]) * (unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1));
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** The context window of a row: its own `context` parameter, else its family's, else none. */
function contextWindowOf(base: string, params: ParsedId["params"]): number | undefined {
  for (const [key, value] of params) {
    if (key.toLowerCase() !== "context") continue;
    const own = parseWindow(value);
    if (own !== undefined) return own;
  }
  return Object.hasOwn(FAMILY_CONTEXT_WINDOWS, base) ? FAMILY_CONTEXT_WINDOWS[base] : undefined;
}

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
 * parameters, the bare-named one included, so `/model` tells them apart. A model whose ID carries
 * an effort parameter is `reasoning`: Cursor shows it has an effort setting. A model's
 * `contextWindow` is its ID's `context` value, else its family's known window, else absent.
 */
export function buildCursorCatalog(entries: readonly CursorModelEntry[]): CliModel[] {
  const parsed = entries.map((entry) => {
    const id = parseId(entry.id);
    return { entry, params: id.params, rawBase: id.base, base: id.base === CURSOR_AUTO_BASE ? AUTO_MODEL : slug(id.base || entry.name) };
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
    const reasoning = item.params.some(([key]) => isEffortKey(key));
    const contextWindow = contextWindowOf(item.rawBase, item.params);
    catalog.push({
      name,
      label: `${item.entry.name || item.base}${suffix}`,
      id: item.entry.id,
      ...(reasoning ? { reasoning } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
    });
  });
  return catalog;
}

/**
 * The context ceiling of a session on the exact Cursor ID `modelId` (issue #40): the model's own
 * window, else the largest window among the offered models (Auto runs one of them; a model with
 * no known window gets the same bound), else none. Above it a turn's usage is a sum over several
 * requests, not a context size.
 */
export function cursorContextCeiling(modelId: string | undefined, offered: readonly CursorModelEntry[]): number | undefined {
  const catalog = buildCursorCatalog(offered);
  const own = modelId === undefined ? undefined : catalog.find((model) => model.id === modelId)?.contextWindow;
  if (own !== undefined) return own;
  const windows = catalog.map((model) => model.contextWindow).filter((window): window is number => window !== undefined);
  return windows.length > 0 ? Math.max(...windows) : undefined;
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
 * Cursor's effort values for an OpenClaw thinking level, most specific first. `adaptive` (and
 * anything else without a Cursor counterpart) has none, so the row keeps its own effort.
 */
function effortValuesFor(level: string): readonly string[] {
  const lower = level.trim().toLowerCase();
  if (lower === "off") return ["none", "off"];
  if (lower === "adaptive" || lower === "") return [];
  return [lower];
}

/** A model's parameters other than its effort, in a form that compares equal for siblings. */
function fixedParams(id: ParsedId): string {
  return JSON.stringify(id.params.filter(([key]) => !isEffortKey(key)).map(([key, value]) => [key.toLowerCase(), value.toLowerCase()]));
}

/**
 * The ID to run for a row at an OpenClaw thinking level: the listed variant of the same base and the
 * same other parameters whose effort matches the level. Without a level, a row with no effort, no
 * such variant, or a level Cursor has no value for, the row's own ID stays. Only IDs Cursor listed
 * are ever returned: ACP refuses a value it did not offer.
 */
function idForEffort(row: CliModel, offered: readonly CursorModelEntry[], level: string | undefined): string {
  if (!row.reasoning || !level) return row.id;
  const wanted = effortValuesFor(level);
  const own = parseId(row.id);
  const fixed = fixedParams(own);
  const siblings = offered
    .map((entry) => ({ entry, id: parseId(entry.id) }))
    .filter((item) => item.id.base === own.base && fixedParams(item.id) === fixed);
  for (const value of wanted) {
    const match = siblings.find((item) => item.id.params.some(([key, v]) => isEffortKey(key) && v.toLowerCase() === value));
    if (match) return match.entry.id;
  }
  return row.id;
}

/**
 * The model choice for an ACP session (the transport's `selectModel`): the exact ID to switch to,
 * `null` to keep the session's model, `undefined` for a model the account lacks. `level` is
 * OpenClaw's thinking level for the turn; it picks the effort variant of a `reasoning` model.
 *
 * Cursor remembers the last model in the config directory, so a session can start on another
 * model than Auto. `auto` therefore switches back unless the session is already on Auto.
 */
export function selectCursorModel(
  requested: string,
  offered: readonly CursorModelEntry[],
  level?: string,
): string | null | undefined {
  const catalog = buildCursorCatalog(offered);
  const found = resolveCursorModel(requested, catalog);
  if (found) return idForEffort(found, offered, level);
  // An agent whose list has no Auto entry cannot be switched to it: keep what it runs.
  return requested.trim().toLowerCase() === AUTO_MODEL ? null : undefined;
}
