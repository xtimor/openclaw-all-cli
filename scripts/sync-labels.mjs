#!/usr/bin/env node
// Syncs the repository's GitHub labels with .github/labels.yml: creates missing labels and
// updates color/description of existing ones. An entry with `renamed_from` renames the old label in place when only the old one
// exists (issues keep it). Never deletes; a label that is not in the file is left alone.
// Agent-neutral and dependency-free (Node 24 `fetch`). Used by .github/workflows/labels.yml, runnable by hand.
//
//   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo node scripts/sync-labels.mjs [--dry-run] [--file <path>]
//
// SYNC_LABELS_API overrides the API base (default https://api.github.com), for tests.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".github", "labels.yml");
const KEYS = ["name", "color", "description"];
const OPTIONAL_KEYS = ["renamed_from"];
const MAX_DESCRIPTION = 100; // GitHub's limit
const PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 30_000;

/** Fails the run with a message that names the problem. */
class SyncError extends Error {}

/**
 * Parses the restricted format of .github/labels.yml: a flat list of `- name:` entries with
 * `color:` and `description:` lines (and an optional `renamed_from:`), values as double-quoted JSON strings. Comments and blank lines are ignored.
 */
export function parseLabels(text) {
  const entries = [];
  let current = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
    const match = /^(- |  )([a-z_]+):[ \t]*(.*?)[ \t]*$/.exec(raw);
    if (!match) throw new SyncError(`labels file line ${i + 1}: cannot parse ${JSON.stringify(raw)}`);
    const [, lead, key, rawValue] = match;
    if (lead === "- ") {
      current = { line: i + 1 };
      entries.push(current);
    } else if (!current) {
      throw new SyncError(`labels file line ${i + 1}: a key outside an entry`);
    }
    if (!KEYS.includes(key) && !OPTIONAL_KEYS.includes(key)) throw new SyncError(`labels file line ${i + 1}: unknown key "${key}"`);
    if (Object.hasOwn(current, key)) throw new SyncError(`labels file line ${i + 1}: duplicate key "${key}" in ${describe(current)}`);
    let value;
    try {
      value = JSON.parse(rawValue);
    } catch {
      throw new SyncError(`labels file line ${i + 1}: the value of "${key}" must be a double-quoted string`);
    }
    if (typeof value !== "string") throw new SyncError(`labels file line ${i + 1}: the value of "${key}" must be a string`);
    current[key] = value;
  }
  return validateLabels(entries);
}

function describe(entry) {
  return typeof entry.name === "string" && entry.name !== "" ? `label "${entry.name}"` : `the entry at line ${entry.line}`;
}

function validateLabels(entries) {
  if (entries.length === 0) throw new SyncError("labels file has no entries");
  const seen = new Map();
  const labels = [];
  const renames = [];
  for (const entry of entries) {
    for (const key of KEYS) {
      if (typeof entry[key] !== "string") throw new SyncError(`${describe(entry)} (line ${entry.line}): missing "${key}"`);
    }
    const name = entry.name.trim();
    if (name === "") throw new SyncError(`the entry at line ${entry.line}: empty name`);
    if (!/^[0-9a-fA-F]{6}$/.test(entry.color)) {
      throw new SyncError(`label "${name}" (line ${entry.line}): color must be six hex digits without "#", got ${JSON.stringify(entry.color)}`);
    }
    if (entry.description.trim() === "") throw new SyncError(`label "${name}" (line ${entry.line}): empty description`);
    if (entry.description.length > MAX_DESCRIPTION) {
      throw new SyncError(`label "${name}" (line ${entry.line}): description is longer than ${MAX_DESCRIPTION} characters`);
    }
    const key = name.toLowerCase(); // GitHub compares label names case-insensitively
    if (seen.has(key)) throw new SyncError(`duplicate label "${name}" (lines ${seen.get(key)} and ${entry.line})`);
    seen.set(key, entry.line);
    const label = { name, color: entry.color.toLowerCase(), description: entry.description };
    if (Object.hasOwn(entry, "renamed_from")) {
      const from = entry.renamed_from.trim();
      if (from === "") throw new SyncError(`label "${name}" (line ${entry.line}): empty renamed_from`);
      if (from.toLowerCase() === key) throw new SyncError(`label "${name}" (line ${entry.line}): renamed_from is the label's own name`);
      label.renamedFrom = from;
      renames.push({ name, from, line: entry.line });
    }
    labels.push(label);
  }
  // A former name that is another entry's current name would rename a label the file still wants.
  for (const { name, from, line } of renames) {
    if (seen.has(from.toLowerCase())) throw new SyncError(`label "${name}" (line ${line}): renamed_from "${from}" is also an entry of the file (line ${seen.get(from.toLowerCase())})`);
  }
  return labels;
}

/**
 * What to do for each wanted label, given the labels the repository has. A label with a former name (`renamedFrom`) that the
 * repository still has under the old name only is renamed in place (`rename`: issues keep it); when the repository has both
 * names nothing is written for it and the result is a `conflict` (the run fails; someone merges the two by hand). Nothing is deleted.
 */
export function planSync(wanted, existing) {
  const byName = new Map(existing.map((label) => [label.name.toLowerCase(), label]));
  const actions = [];
  for (const label of wanted) {
    const have = byName.get(label.name.toLowerCase());
    const former = label.renamedFrom ? byName.get(label.renamedFrom.toLowerCase()) : undefined;
    if (former && have) {
      actions.push({ op: "conflict", label, current: former.name, message: `both "${former.name}" and "${have.name}" exist; the file renames the first to the second. Move the issues to "${have.name}" and delete "${former.name}" by hand, then run the sync again` });
      continue;
    }
    if (former) {
      actions.push({ op: "rename", label, current: former.name, changes: ["name"] });
      continue;
    }
    if (!have) {
      actions.push({ op: "create", label });
      continue;
    }
    const changes = [];
    if (have.name !== label.name) changes.push("name");
    if (String(have.color ?? "").toLowerCase() !== label.color) changes.push("color");
    if ((have.description ?? "") !== label.description) changes.push("description");
    actions.push(changes.length > 0 ? { op: "update", label, current: have.name, changes } : { op: "unchanged", label });
  }
  return actions;
}

function parseArgs(argv) {
  const options = { dryRun: false, file: DEFAULT_FILE };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--file") {
      const value = argv[(i += 1)];
      if (!value) throw new SyncError("--file needs a path");
      options.file = resolve(value);
    } else throw new SyncError(`unknown argument "${arg}" (usage: sync-labels.mjs [--dry-run] [--file <path>])`);
  }
  return options;
}

async function api(base, token, method, path, body) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "openclaw-all-cli-sync-labels",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = text.trim();
    try {
      detail = JSON.parse(text).message ?? detail;
    } catch {
      /* keep the raw text */
    }
    throw new Error(`${method} ${path} -> HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  }
  return text === "" ? null : JSON.parse(text);
}

async function listLabels(base, token, repo) {
  const all = [];
  for (let page = 1; ; page += 1) {
    const rows = await api(base, token, "GET", `/repos/${repo}/labels?per_page=${PAGE_SIZE}&page=${page}`);
    if (!Array.isArray(rows)) throw new Error(`GET labels page ${page}: the answer is not a list`);
    all.push(...rows);
    if (rows.length < PAGE_SIZE) return all;
  }
}

export async function main(argv, env, out = console) {
  const options = parseArgs(argv);
  let text;
  try {
    text = readFileSync(options.file, "utf8");
  } catch (error) {
    throw new SyncError(`cannot read the labels file ${options.file}: ${error.message}`);
  }
  const wanted = parseLabels(text); // validated before any API call

  const repo = env.GITHUB_REPOSITORY ?? "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new SyncError("GITHUB_REPOSITORY must be set to owner/repo");
  const token = env.GITHUB_TOKEN ?? "";
  if (!token && !options.dryRun) throw new SyncError("GITHUB_TOKEN is not set");
  const base = (env.SYNC_LABELS_API || "https://api.github.com").replace(/\/+$/, "");

  const existing = await listLabels(base, token, repo);
  const actions = planSync(wanted, existing);

  const failures = [];
  for (const action of actions) {
    const { label } = action;
    if (action.op === "unchanged") {
      out.log(`ok       ${label.name}`);
      continue;
    }
    if (action.op === "conflict") {
      // A setup problem, not an API error: reported in a dry run too, nothing is written for this label.
      failures.push(label.name);
      out.error(`FAILED   ${label.name}: ${action.message}`);
      continue;
    }
    const verb = action.op === "create" ? "create" : action.op === "rename" ? `rename from ${action.current}` : `update (${action.changes.join(", ")})`;
    if (options.dryRun) {
      out.log(`would ${verb}: ${label.name}`);
      continue;
    }
    try {
      if (action.op === "create") {
        await api(base, token, "POST", `/repos/${repo}/labels`, { name: label.name, color: label.color, description: label.description });
      } else {
        const patch = { color: label.color, description: label.description };
        if (action.changes.includes("name")) patch.new_name = label.name; // a rename always carries it
        await api(base, token, "PATCH", `/repos/${repo}/labels/${encodeURIComponent(action.current)}`, patch);
      }
      out.log(`${action.op === "create" ? "created " : action.op === "rename" ? "renamed " : "updated "} ${label.name}${action.op === "rename" ? ` (was ${action.current})` : ""}`);
    } catch (error) {
      failures.push(label.name);
      out.error(`FAILED   ${label.name}: ${error.message}`);
    }
  }

  const count = (op) => actions.filter((action) => action.op === op).length;
  const renames = count("rename") > 0 ? `${count("rename")} to rename, ` : "";
  out.log(`${options.dryRun ? "dry run: " : ""}${count("create")} to create, ${renames}${count("update")} to update, ${count("unchanged")} unchanged (${wanted.length} in the file)`);
  if (failures.length > 0) throw new SyncError(`${failures.length} label(s) failed: ${failures.join(", ")}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env).catch((error) => {
    console.error(`sync-labels: ${error.message}`);
    process.exit(1);
  });
}
