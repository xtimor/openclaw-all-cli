import { existsSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ISOLATED_STATE_DIR, LIVE_TIMEOUT_MS, describeLive, openclaw } from "./harness.ts";

// Parity row P16: the usage on OpenClaw's transcript is Cursor's own ledger numbers. The test
// reads the ledger with its own code (not the plugin's) and compares field by field. It needs
// CURSOR_API_KEY, and NODE_USE_ENV_PROXY=1 behind an HTTP proxy (`npm run test:live` sets it).
const KEY = process.env.CURSOR_API_KEY?.trim();
const AGENT_DIR = join(ISOLATED_STATE_DIR, "agents", "main", "agent");
const DB_PATH = join(AGENT_DIR, "openclaw-agent.sqlite");
const ACP_SESSIONS = join(AGENT_DIR, "openclaw-all-cli", "cursor-cli", "acp-sessions");

type Counts = { input: number; output: number; cacheRead: number; cacheWrite: number };
type LedgerEvent = { conversationId?: string; timestamp?: string; tokenUsage?: Record<string, number> };

const countsOf = (tokens: Record<string, number> = {}): Counts => ({
  input: tokens.inputTokens ?? 0,
  output: tokens.outputTokens ?? 0,
  cacheRead: tokens.cacheReadTokens ?? 0,
  cacheWrite: tokens.cacheWriteTokens ?? 0,
});

const sum = (events: LedgerEvent[]): Counts =>
  events.reduce<Counts>(
    (acc, event) => {
      const c = countsOf(event.tokenUsage);
      return { input: acc.input + c.input, output: acc.output + c.output, cacheRead: acc.cacheRead + c.cacheRead, cacheWrite: acc.cacheWrite + c.cacheWrite };
    },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );

const BASE = "https://api2.cursor.sh";

async function ledgerEvents(): Promise<LedgerEvent[]> {
  const exchange = await fetch(`${BASE}/auth/exchange_user_api_key`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: "{}",
  });
  expect(exchange.status).toBe(200);
  const { accessToken } = (await exchange.json()) as { accessToken: string };
  const response = await fetch(`${BASE}/aiserver.v1.DashboardService/GetFilteredUsageEvents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Connect-Protocol-Version": "1", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ page: 1, pageSize: 100 }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { usageEventsDisplay?: LedgerEvent[] }).usageEventsDisplay ?? [];
}

/** Events of one conversation newer than `after` (epoch ms), polled until at least one shows up. */
async function eventsFor(conversationId: string, after = 0): Promise<LedgerEvent[]> {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const found = (await ledgerEvents()).filter((event) => event.conversationId === conversationId && Number(event.timestamp) > after);
    if (found.length > 0) return found;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return [];
}

type Entry = { usage: Counts & { totalTokens: number } };

/** The newest `cursor-cli` assistant entry of an OpenClaw session, read-only from the agent's SQLite. */
function lastAssistantEntry(openclawSession: string): Entry {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq DESC")
      .all(openclawSession) as { event_json: string }[];
    for (const row of rows) {
      const message = (JSON.parse(row.event_json) as { message?: { role?: string; provider?: string; usage?: Entry["usage"] } }).message;
      if (message?.role === "assistant" && message.provider === "cursor-cli" && message.usage) return { usage: message.usage };
    }
  } finally {
    db.close();
  }
  throw new Error(`No cursor-cli assistant entry for session ${openclawSession}.`);
}

const acpSessions = () => (existsSync(ACP_SESSIONS) ? new Set(readdirSync(ACP_SESSIONS)) : new Set<string>());

function agentTurn(openclawSession: string, message: string) {
  const run = openclaw(["agent", "--local", "--model", "cursor-cli/auto", "--session-id", openclawSession, "--json", "--message", message], {
    timeoutMs: 280_000,
  });
  expect(run.status).toBe(0);
  expect(run.stderr + run.stdout).not.toMatch(/cli terminal failure/);
}

const equalsEvents = (entry: Entry, events: LedgerEvent[]) => {
  const expected = sum(events);
  expect(entry.usage).toMatchObject(expected);
  expect(entry.usage.totalTokens).toBe(expected.input + expected.output + expected.cacheRead + expected.cacheWrite);
};

describeLive("per-turn usage on the transcript (P16)", () => {
  const openclawSession = `live-usage-${Date.now()}`;
  let acpSession = "";
  let firstEntry: Entry;
  let firstLatest = 0;

  it.skipIf(!KEY)("puts the ledger's numbers for the turn on the assistant entry", async () => {
    const before = acpSessions();
    agentTurn(openclawSession, "Reply with one short sentence about the moon.");
    const fresh = [...acpSessions()].filter((id) => !before.has(id));
    expect(fresh.length).toBeGreaterThan(0);

    // The turn's session id is the one the ledger knows.
    const all = await ledgerEvents();
    acpSession = fresh.find((id) => all.some((event) => event.conversationId === id)) ?? "";
    expect(acpSession).not.toBe("");

    const events = await eventsFor(acpSession);
    firstEntry = lastAssistantEntry(openclawSession);
    equalsEvents(firstEntry, events);
    expect(firstEntry.usage.input + firstEntry.usage.cacheRead).toBeGreaterThan(0);
    expect(firstEntry.usage.output).toBeGreaterThan(0);
    firstLatest = Math.max(...events.map((event) => Number(event.timestamp)));
  }, LIVE_TIMEOUT_MS);

  it.skipIf(!KEY)("gives a second turn of the same OpenClaw session only its own numbers", async () => {
    expect(acpSession).not.toBe("");
    agentTurn(openclawSession, "Now one short sentence about the sun.");
    const events = await eventsFor(acpSession, firstLatest);
    expect(events.length).toBeGreaterThan(0);
    const second = lastAssistantEntry(openclawSession);
    equalsEvents(second, events);
    expect(second.usage).not.toEqual(firstEntry.usage);
  }, LIVE_TIMEOUT_MS);
});
