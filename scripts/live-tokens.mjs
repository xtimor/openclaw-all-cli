#!/usr/bin/env node
// The Cursor tokens one live tier run spent (epic-regression-gate ticket 4.5), from Cursor's usage ledger.
//
//   node scripts/live-tokens.mjs --turns <turn meter log> --since <epoch ms> [--out <file>] [--wait-ms <ms>]
//
// The conversations are the ACP session ids the turn meter (test/live/turn-meter.mjs) logged for the run's prompts:
// only those count, because the key is the owner's and the account-wide ledger also holds his own use. The reader
// exchanges CURSOR_API_KEY for an access token (the same calls as src/adapters/cursor/usage.ts, whose
// `matchTurnEvents` sums the counts), reads `GetFilteredUsageEvents` newest first back to --since, and sums every
// event of those conversations stamped at or after it. Ledger events appear 2 to 6.2 s late, so it reads again every
// 5 s until every conversation with a finished turn has an event, at most --wait-ms (default 60000). Writes
// {input, output, cacheRead, cacheWrite, total, conversations, matched, missing, events} as JSON to --out (and stdout);
// when a finished turn's conversation still has no event, or nothing matched, `total` is null: the tokens are unknown,
// never 0. The key, the token and response bodies are never printed. Behind a proxy run Node with NODE_USE_ENV_PROXY=1.
// Exit 1: the ledger could not be read (an unknown total is still written); 2: usage.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const BASE = process.env.OPENCLAW_ALL_CLI_CURSOR_USAGE_URL?.trim() || "https://api2.cursor.sh";
const EVENTS_PATH = "/aiserver.v1.DashboardService/GetFilteredUsageEvents";
const PAGE_SIZE = 100;
const MAX_PAGES = 200;

/**
 * The meter log's conversations: every session id a prompt went to, and those with a finished (not refused) turn.
 * A turn a test failed on purpose (an `unbilled` window it wrote with `markUnbilled` in test/live/harness.ts, such as
 * the refused model host of test/live/errors.live.test.ts) leaves no ledger event, so a turn that ended inside such a
 * window does not count as finished.
 */
export function conversationsOf(text) {
  const all = new Set();
  const finished = new Set();
  const entries = [];
  const windows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.kind === "unbilled" && Number.isFinite(entry.from) && Number.isFinite(entry.to)) windows.push([entry.from, entry.to]);
      else entries.push(entry);
    } catch {
      // Not a log line.
    }
  }
  const unbilled = (at) => Number.isFinite(at) && windows.some(([from, to]) => at >= from && at <= to);
  for (const entry of entries) {
    if (typeof entry?.sessionId !== "string" || !entry.sessionId) continue;
    if (entry.kind === "prompt") all.add(entry.sessionId);
    // A cancelled turn may leave no ledger event; any other answered turn does.
    if (entry.kind === "done" && entry.stopReason !== undefined && entry.stopReason !== "cancelled" && !entry.error && !unbilled(entry.at)) finished.add(entry.sessionId);
  }
  return { all, finished };
}

/**
 * The run's totals over `events` (the ledger rows read so far). `missing` counts the conversations with a finished
 * turn and no event; `total` is null when any is missing or nothing matched.
 */
export function sumRun(events, conversations, since, matchTurnEvents) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let matched = 0;
  let eventCount = 0;
  for (const sessionId of conversations.all) {
    const mine = events.filter((event) => event?.conversationId === sessionId);
    const { usage, latest } = matchTurnEvents(mine, { sessionId, notBefore: since });
    if (latest === undefined) continue;
    matched += 1;
    eventCount += mine.filter((event) => Number(event.timestamp) >= since).length;
    if (!usage) continue;
    for (const key of Object.keys(totals)) totals[key] += usage[key];
  }
  const seen = new Set(events.filter((event) => Number(event?.timestamp) >= since).map((event) => event?.conversationId));
  const missingIds = [...conversations.finished].filter((id) => !seen.has(id));
  const missing = missingIds.length;
  const sum = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
  return {
    ...totals,
    total: missing === 0 && matched > 0 && sum > 0 ? sum : null,
    conversations: conversations.all.size,
    matched,
    missing,
    events: eventCount,
    // The ACP session ids of the missing conversations (no key, token or account id), to look them up in the turn log.
    ...(missing > 0 ? { missingConversations: missingIds } : {}),
  };
}

async function post(path, bearer, body, headers = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}`, ...headers },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`${path}: HTTP ${response.status}`);
  }
  return response.json();
}

/** Every ledger event stamped at or after `since`, newest first. */
async function readLedger(key, since, exchangePath) {
  const exchange = await post(exchangePath, key, "{}");
  const token = exchange?.accessToken;
  if (typeof token !== "string" || !token) throw new Error(`${exchangePath}: no access token in the answer`);
  const events = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const json = await post(EVENTS_PATH, token, JSON.stringify({ page, pageSize: PAGE_SIZE }), { "Connect-Protocol-Version": "1" });
    const batch = Array.isArray(json?.usageEventsDisplay) ? json.usageEventsDisplay : [];
    events.push(...batch);
    const stamps = batch.map((event) => Number(event?.timestamp)).filter(Number.isFinite);
    if (batch.length < PAGE_SIZE || stamps.length === 0 || Math.min(...stamps) < since) break;
  }
  return events;
}

function parseArgs(argv) {
  const options = { waitMs: 60_000 };
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing value for ${argv[i]}`);
    if (argv[i] === "--turns") options.turns = value;
    else if (argv[i] === "--since") options.since = Number(value);
    else if (argv[i] === "--out") options.out = value;
    else if (argv[i] === "--wait-ms") options.waitMs = Number(value);
    else throw new Error(`unknown argument ${JSON.stringify(argv[i])}`);
  }
  if (!options.turns || !Number.isFinite(options.since) || !Number.isFinite(options.waitMs)) throw new Error("--turns and a numeric --since are required");
  return options;
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`live-tokens: ${error.message}\nusage: node scripts/live-tokens.mjs --turns <file> --since <epoch ms> [--out <file>] [--wait-ms <ms>]\n`);
    return 2;
  }
  const { matchTurnEvents, EXCHANGE_PATH } = await import(new URL("../src/adapters/cursor/usage.ts", import.meta.url).href);
  const write = (result) => {
    const text = `${JSON.stringify(result, null, 2)}\n`;
    if (options.out) writeFileSync(options.out, text);
    process.stdout.write(text);
  };
  let text = "";
  try {
    text = readFileSync(options.turns, "utf8");
  } catch {
    // No log: no turn ran.
  }
  const conversations = conversationsOf(text);
  const key = process.env.CURSOR_API_KEY?.trim();
  if (conversations.all.size === 0 || !key) {
    write({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: null, conversations: conversations.all.size, matched: 0, missing: conversations.finished.size, events: 0, ...(key ? {} : { note: "CURSOR_API_KEY is not set" }) });
    return key ? 0 : 1;
  }
  const deadline = Date.now() + options.waitMs;
  let result;
  let failure;
  for (;;) {
    try {
      result = sumRun(await readLedger(key, options.since, EXCHANGE_PATH), conversations, options.since, matchTurnEvents);
      failure = undefined;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (result && result.missing === 0) break;
    if (Date.now() + 5_000 > deadline) break;
    await new Promise((done) => setTimeout(done, 5_000));
  }
  if (!result) {
    write({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: null, conversations: conversations.all.size, matched: 0, missing: conversations.finished.size, events: 0, error: failure });
    process.stderr.write(`live-tokens: the usage ledger could not be read (${failure})\n`);
    return 1;
  }
  write(result);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
