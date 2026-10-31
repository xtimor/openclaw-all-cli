import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * scripts/sync-labels.mjs against a local stub of the GitHub labels API (ticket 3.6). Covers every
 * row of the matrix; nothing here reaches the real GitHub API.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "sync-labels.mjs");
const LABELS_FILE = join(ROOT, ".github", "labels.yml");
const ISSUE_FLOW = join(ROOT, "_bmad-output", "initiative-openclaw-all-cli", "epic-distribution", "issue-flow.md");
const REPO = "owner/repo";
const TOKEN = "ghs_STUB_TOKEN_0123456789";

interface StubLabel {
  name: string;
  color: string;
  description: string | null;
}
interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  auth: string | undefined;
}

let server: Server;
let base = "";
let labels: StubLabel[] = [];
let calls: Call[] = [];
/** Label names whose create/patch the stub refuses with 422. */
let failNames = new Set<string>();

const stripVitest = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST") && !key.startsWith("GITHUB_")));

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : null;
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const body = await readBody(req);
    const method = req.method ?? "GET";
    calls.push({ method, path: url.pathname + url.search, body, auth: req.headers.authorization });
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const collection = `/repos/${REPO}/labels`;
    if (method === "GET" && url.pathname === collection) {
      const perPage = Number(url.searchParams.get("per_page") ?? "30");
      const page = Number(url.searchParams.get("page") ?? "1");
      return send(200, labels.slice((page - 1) * perPage, page * perPage));
    }
    if (method === "POST" && url.pathname === collection) {
      const name = String(body?.name);
      if (failNames.has(name)) return send(422, { message: "Validation Failed" });
      if (labels.some((label) => label.name.toLowerCase() === name.toLowerCase())) return send(422, { message: "already_exists" });
      labels.push({ name, color: String(body?.color), description: (body?.description as string) ?? null });
      return send(201, labels[labels.length - 1]);
    }
    if (method === "PATCH" && url.pathname.startsWith(`${collection}/`)) {
      const current = decodeURIComponent(url.pathname.slice(collection.length + 1));
      const label = labels.find((entry) => entry.name.toLowerCase() === current.toLowerCase());
      if (!label) return send(404, { message: "Not Found" });
      if (failNames.has(label.name)) return send(422, { message: "Validation Failed" });
      if (typeof body?.new_name === "string") label.name = body.new_name;
      if (typeof body?.color === "string") label.color = body.color;
      if (typeof body?.description === "string") label.description = body.description;
      return send(200, label);
    }
    return send(405, { message: "stub: not supported" });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
});

beforeEach(() => {
  labels = [];
  calls = [];
  failNames = new Set();
});

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[] = [], env: Record<string, string> = {}): Promise<Run> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { env: { ...stripVitest(), GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: TOKEN, SYNC_LABELS_API: base, ...env }, timeout: 20_000 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        done({ code, stdout, stderr });
      },
    );
  });
}

const writes = () => calls.filter((call) => call.method !== "GET");

function tempLabelsFile(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sync-labels-"));
  dirs.push(dir);
  const file = join(dir, "labels.yml");
  writeFileSync(file, text);
  return file;
}

/** The entries of the real labels file, read with the same restricted format. */
function fileLabels(): { name: string; color: string; description: string }[] {
  const entries: { name: string; color: string; description: string }[] = [];
  for (const line of readFileSync(LABELS_FILE, "utf8").split("\n")) {
    const match = /^(- |  )(name|color|description): (".*")\s*$/.exec(line);
    if (!match) continue;
    const value = JSON.parse(match[3] as string) as string;
    if (match[2] === "name") entries.push({ name: value, color: "", description: "" });
    else (entries[entries.length - 1] as Record<string, string>)[match[2] as string] = value;
  }
  return entries;
}

describe("labels file", () => {
  it("has exactly the labels issue-flow.md names plus the owner's upstream:post, each with a color and a description", () => {
    const flow = readFileSync(ISSUE_FLOW, "utf8");
    const named = [...new Set([...flow.matchAll(/`((?:status|type|priority|source):[a-z0-9-]+)`/g)].map((match) => match[1] as string))].sort();
    const entries = fileLabels();
    // `upstream:post` (ticket 3.25) is the owner's approval to publish an agent's upstream draft; it is not part of the issue-flow design.
    expect(entries.map((entry) => entry.name).sort()).toEqual([...named, "upstream:post"].sort());
    // The design lists 11 states, 2 types, 4 priorities, and the agent source.
    expect(named).toHaveLength(18);
    for (const entry of entries) {
      expect(entry.color).toMatch(/^[0-9a-f]{6}$/);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeLessThanOrEqual(100);
    }
  });

  it("passes the script's own validation (dry run)", async () => {
    const result = await run(["--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("19 to create");
  });
});

describe("issue forms", () => {
  for (const [file, type] of [
    ["bug.yml", "type:bug"],
    ["idea.yml", "type:idea"],
  ] as const) {
    it(`${file} sets ${type} and status:new and has the agent checkbox`, () => {
      const text = readFileSync(join(ROOT, ".github", "ISSUE_TEMPLATE", file), "utf8");
      expect(text).toContain(`labels: ["${type}", "status:new"]`);
      expect(text).toContain("type: checkboxes");
      expect(text).toContain("label: Filed by an agent");
    });
  }

  it("config.yml turns blank issues off and links the private advisory", () => {
    const text = readFileSync(join(ROOT, ".github", "ISSUE_TEMPLATE", "config.yml"), "utf8");
    expect(text).toContain("blank_issues_enabled: false");
    expect(text).toContain("https://github.com/xtimor/openclaw-all-cli/security/advisories/new");
  });
});

describe("sync-labels.mjs", () => {
  it("FIRST_SYNC: creates every label with color and description", async () => {
    const wanted = fileLabels();
    const result = await run();
    expect(result.code, result.stderr).toBe(0);
    const posts = writes();
    expect(posts).toHaveLength(wanted.length);
    expect(posts.every((call) => call.method === "POST")).toBe(true);
    expect(posts.map((call) => call.body)).toEqual(wanted.map((entry) => ({ name: entry.name, color: entry.color, description: entry.description })));
    expect(labels).toHaveLength(wanted.length);
    expect(calls.every((call) => call.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(result.stdout + result.stderr).not.toContain(TOKEN);
  });

  it("FIRST_SYNC: an API error exits non-zero and names the label, the others still sync", async () => {
    failNames.add("priority:p1");
    const result = await run();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("priority:p1");
    expect(result.stderr).toContain("422");
    expect(labels).toHaveLength(fileLabels().length - 1);
    expect(labels.some((label) => label.name === "priority:p1")).toBe(false);
  });

  it("SECOND_SYNC: writes nothing when every label is present and equal", async () => {
    expect((await run()).code).toBe(0);
    calls = [];
    const second = await run();
    expect(second.code, second.stderr).toBe(0);
    expect(writes()).toEqual([]);
    expect(second.stdout).toContain("0 to create, 0 to update, 19 unchanged");
  });

  it("SECOND_SYNC: a label GitHub reports with an upper-case color is still equal", async () => {
    expect((await run()).code).toBe(0);
    for (const label of labels) label.color = label.color.toUpperCase();
    calls = [];
    expect((await run()).code).toBe(0);
    expect(writes()).toEqual([]);
  });

  it("DRIFT: updates a label with another color or description in place", async () => {
    expect((await run()).code).toBe(0);
    const bug = labels.find((label) => label.name === "type:bug") as StubLabel;
    const idea = labels.find((label) => label.name === "type:idea") as StubLabel;
    const wantedBug = fileLabels().find((entry) => entry.name === "type:bug");
    bug.color = "000000";
    idea.description = null;
    calls = [];
    const result = await run();
    expect(result.code, result.stderr).toBe(0);
    const patches = writes();
    expect(patches.map((call) => call.method)).toEqual(["PATCH", "PATCH"]);
    expect(patches.map((call) => call.path)).toEqual(["/repos/owner/repo/labels/type%3Abug", "/repos/owner/repo/labels/type%3Aidea"]);
    expect(bug.color).toBe(wantedBug?.color);
    expect(idea.description).toBe(fileLabels().find((entry) => entry.name === "type:idea")?.description);
    expect(labels).toHaveLength(fileLabels().length);
  });

  it("DRIFT: fixes a name that differs only in case", async () => {
    labels.push({ name: "Type:Bug", color: "000000", description: "x" });
    const result = await run();
    expect(result.code, result.stderr).toBe(0);
    expect(labels.filter((label) => label.name.toLowerCase() === "type:bug")).toHaveLength(1);
    expect(labels.find((label) => label.name.toLowerCase() === "type:bug")?.name).toBe("type:bug");
    expect(calls.some((call) => call.method === "POST" && call.body?.name === "type:bug")).toBe(false);
  });

  it("EXTRA_LABEL: leaves a label that is not in the file as is", async () => {
    const extra = { name: "good first issue", color: "7057ff", description: "Good for newcomers" };
    labels.push({ ...extra });
    const result = await run();
    expect(result.code, result.stderr).toBe(0);
    expect(labels.find((label) => label.name === extra.name)).toEqual(extra);
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(writes().every((call) => call.method === "POST")).toBe(true);
  });

  it("reads every page of the repository's labels", async () => {
    // 150 other labels, the wanted label sits on page 2 and must not be created again.
    for (let i = 0; i < 100; i += 1) labels.push({ name: `other-${i}`, color: "ffffff", description: null });
    const wanted = fileLabels();
    const present = wanted[3] as { name: string; color: string; description: string };
    labels.push({ name: present.name, color: present.color, description: present.description });
    for (let i = 100; i < 150; i += 1) labels.push({ name: `other-${i}`, color: "ffffff", description: null });
    const result = await run();
    expect(result.code, result.stderr).toBe(0);
    expect(calls.filter((call) => call.method === "GET").length).toBeGreaterThanOrEqual(2);
    expect(writes().some((call) => call.body?.name === present.name)).toBe(false);
    expect(writes()).toHaveLength(wanted.length - 1);
  });

  it("--dry-run prints the plan and writes nothing", async () => {
    labels.push({ name: "type:bug", color: "000000", description: "old" });
    const result = await run(["--dry-run"]);
    expect(result.code, result.stderr).toBe(0);
    expect(writes()).toEqual([]);
    expect(result.stdout).toContain("would update (color, description): type:bug");
    expect(result.stdout).toContain("would create: type:idea");
    expect(result.stdout).toContain(`${fileLabels().length - 1} to create, 1 to update`);
  });

  describe("BAD_FILE: fails before any API call and names the entry", () => {
    const cases: [string, string, RegExp][] = [
      ["a missing color", '- name: "type:bug"\n  description: "d"\n', /type:bug.*missing "color"/],
      ["a missing description", '- name: "type:bug"\n  color: "d73a4a"\n', /type:bug.*missing "description"/],
      ["a missing name", '- color: "d73a4a"\n  description: "d"\n', /line 1.*missing "name"/],
      ["a bad color", '- name: "type:bug"\n  color: "#d73a4a"\n  description: "d"\n', /type:bug.*color must be six hex/],
      [
        "a duplicate name",
        '- name: "type:bug"\n  color: "d73a4a"\n  description: "d"\n- name: "Type:Bug"\n  color: "d73a4a"\n  description: "e"\n',
        /duplicate label "Type:Bug"/,
      ],
      ["an unquoted value", "- name: type:bug\n  color: d73a4a\n  description: d\n", /double-quoted string/],
      ["an unknown key", '- name: "type:bug"\n  color: "d73a4a"\n  description: "d"\n  emoji: "x"\n', /unknown key "emoji"/],
      ["no entries", "# only a comment\n", /no entries/],
    ];
    for (const [title, text, message] of cases) {
      it(title, async () => {
        const result = await run(["--file", tempLabelsFile(text)]);
        expect(result.code).not.toBe(0);
        expect(result.stderr).toMatch(message);
        expect(calls).toEqual([]);
      });
    }
  });

  it("refuses to run without GITHUB_TOKEN (outside a dry run) or a valid GITHUB_REPOSITORY", async () => {
    const noToken = await run([], { GITHUB_TOKEN: "" });
    expect(noToken.code).not.toBe(0);
    expect(noToken.stderr).toContain("GITHUB_TOKEN");
    const badRepo = await run([], { GITHUB_REPOSITORY: "nope" });
    expect(badRepo.code).not.toBe(0);
    expect(badRepo.stderr).toContain("GITHUB_REPOSITORY");
    expect(calls).toEqual([]);
  });
});
