import { execFile } from "node:child_process";
import { generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import * as http from "node:http";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * scripts/agent-token.mjs against a local stub of the GitHub App endpoints (ticket 3.14): the JWT is checked with the
 * public key, and neither the key nor the JWT nor the token may reach a stream that is not the token line.
 * Nothing here reaches the real GitHub API.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "agent-token.mjs");
const REPO = "xtimor/openclaw-all-cli";
const APP_ID = "123456";
const INSTALLATION = 7654321;
const TOKEN = "ghs_STUB_INSTALLATION_TOKEN_0123456789";

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKey: KeyObject = pair.publicKey;
const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const KEY_B64 = Buffer.from(pem).toString("base64");

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  auth: string | undefined;
}

let server: Server;
let base = "";
let calls: Call[] = [];
/** Per-test answer overrides: `"METHOD path"` to `[status, payload]`. */
let answers = new Map<string, [number, unknown]>();

const stripped = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST") && !key.startsWith("GITHUB_") && !key.startsWith("AGENT_") && !/proxy/i.test(key)),
  );

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
    calls.push({ method, path: url.pathname, body, auth: req.headers.authorization });
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const override = answers.get(`${method} ${url.pathname}`);
    if (override) return send(override[0], override[1]);
    if (method === "GET" && url.pathname === `/repos/${REPO}/installation`) return send(200, { id: INSTALLATION, app_slug: "oac-issue-agents" });
    if (method === "POST" && url.pathname === `/app/installations/${INSTALLATION}/access_tokens`) return send(201, { token: TOKEN, expires_at: "2026-10-23T13:00:00Z" });
    if (method === "GET" && url.pathname === "/app") return send(200, { slug: "oac-issue-agents", id: Number(APP_ID) });
    return send(404, { message: "Not Found" });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
});

beforeEach(() => {
  calls = [];
  answers = new Map();
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

// A child process, never spawnSync: the stub serves from this process.
function run(args: string[] = [], env: Record<string, string | undefined> = {}, script = SCRIPT): Promise<Run> {
  const merged: Record<string, string | undefined> = { ...stripped(), AGENT_APP_ID: APP_ID, AGENT_APP_PRIVATE_KEY_B64: KEY_B64, GITHUB_API_URL: base, ...env };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return new Promise((done) => {
    execFile(process.execPath, [script, ...args], { env: merged as NodeJS.ProcessEnv, timeout: 20_000 }, (error, stdout, stderr) => {
      done({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

function decodeJwt(header: string | undefined) {
  const jwt = (header ?? "").replace(/^Bearer /, "");
  const [h, p, s] = jwt.split(".");
  return {
    jwt,
    header: JSON.parse(Buffer.from(h as string, "base64url").toString()) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(p as string, "base64url").toString()) as Record<string, number | string>,
    signed: verify("sha256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s as string, "base64url")),
  };
}

/** The secrets that must never appear on a stream. */
function secretsIn(result: Run, extra: string[] = []): string[] {
  const text = `${result.stdout}\n${result.stderr}`;
  const jwts = calls.map((call) => decodeJwt(call.auth).jwt).filter((jwt) => jwt !== "");
  return [pem, KEY_B64, pem.split("\n")[1] as string, ...jwts, ...extra].filter((secret) => secret !== "" && text.includes(secret));
}

describe("agent-token", () => {
  it("TOKEN: prints only the installation token, after a signed JWT lookup of the installation", async () => {
    const result = await run();
    expect(result).toMatchObject({ code: 0, stdout: `${TOKEN}\n`, stderr: "" });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([`GET /repos/${REPO}/installation`, `POST /app/installations/${INSTALLATION}/access_tokens`]);
    expect(calls[1]?.body).toEqual({ repositories: ["openclaw-all-cli"] });
    const jwts = calls.map((call) => decodeJwt(call.auth));
    for (const { header, claims, signed } of jwts) {
      expect(header).toEqual({ alg: "RS256", typ: "JWT" });
      expect(signed).toBe(true);
      expect(claims.iss).toBe(APP_ID);
      const now = Date.now() / 1000;
      expect(Math.abs(Number(claims.iat) - (now - 60))).toBeLessThan(30);
      expect(Number(claims.exp) - Number(claims.iat)).toBe(600);
    }
    expect(secretsIn(result)).toEqual([]);
  });

  it("TOKEN: AGENT_APP_REPO picks the repository, and the token is scoped to it", async () => {
    answers.set("GET /repos/acme/widgets/installation", [200, { id: INSTALLATION }]);
    const result = await run([], { AGENT_APP_REPO: "acme/widgets" });
    expect(result).toMatchObject({ code: 0, stdout: `${TOKEN}\n` });
    expect(calls[0]?.path).toBe("/repos/acme/widgets/installation");
    expect(calls[1]?.body).toEqual({ repositories: ["widgets"] });
  });

  it("LOGIN: --login prints <app-slug>[bot] and mints no token", async () => {
    const result = await run(["--login"]);
    expect(result).toMatchObject({ code: 0, stdout: "oac-issue-agents[bot]\n", stderr: "" });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["GET /app"]);
    expect(decodeJwt(calls[0]?.auth).signed).toBe(true);
    expect(secretsIn(result)).toEqual([]);
  });

  it("LOGIN: where GET /app is refused, the installation's app_slug gives the same login", async () => {
    answers.set("GET /app", [403, { message: "Access to this GitHub API path is not permitted through this proxy." }]);
    const result = await run(["--login"]);
    expect(result).toMatchObject({ code: 0, stdout: "oac-issue-agents[bot]\n", stderr: "" });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["GET /app", `GET /repos/${REPO}/installation`]);
    // Both routes failing reports the first one.
    answers.set(`GET /repos/${REPO}/installation`, [200, { id: INSTALLATION }]);
    const none = await run(["--login"]);
    expect(none).toMatchObject({ code: 1, stdout: "" });
    expect(none.stderr).toContain("GET /app: GitHub answered 403");
  });

  it("MISSING_VARS: either variable unset exits 2 naming it, with nothing on stdout and no request", async () => {
    for (const [name, other] of [
      ["AGENT_APP_ID", "AGENT_APP_PRIVATE_KEY_B64"],
      ["AGENT_APP_PRIVATE_KEY_B64", "AGENT_APP_ID"],
    ] as const) {
      for (const args of [[], ["--login"]]) {
        const result = await run(args, { [name]: undefined });
        expect(result.code).toBe(2);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(name);
        expect(result.stderr).not.toContain(other);
      }
    }
    const empty = await run([], { AGENT_APP_ID: "  " });
    expect(empty).toMatchObject({ code: 2, stdout: "" });
    const both = await run([], { AGENT_APP_ID: undefined, AGENT_APP_PRIVATE_KEY_B64: undefined });
    expect(both.stderr).toContain("AGENT_APP_ID, AGENT_APP_PRIVATE_KEY_B64");
    expect(calls).toEqual([]);
  });

  it("malformed settings exit 2 before any request", async () => {
    for (const env of [{ AGENT_APP_REPO: "not-a-repo" }, { AGENT_APP_ID: "12 34" }]) {
      const result = await run([], env);
      expect(result).toMatchObject({ code: 2, stdout: "" });
    }
    expect(await run(["--bogus"])).toMatchObject({ code: 2, stdout: "" });
    expect(calls).toEqual([]);
  });

  it("BAD_KEY: a value that is not the base64 of a PEM key exits 1 without the value", async () => {
    const garbage = Buffer.from("this is not a key at all").toString("base64");
    const publicOnly = Buffer.from(pair.publicKey.export({ type: "spki", format: "pem" }) as string).toString("base64");
    for (const value of [garbage, "%%%", publicOnly, "-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----"]) {
      const result = await run([], { AGENT_APP_PRIVATE_KEY_B64: value });
      expect(result).toMatchObject({ code: 1, stdout: "" });
      expect(result.stderr).toContain("AGENT_APP_PRIVATE_KEY_B64 is not a valid private key");
      expect(result.stderr).not.toContain(value.trim());
      expect(secretsIn(result, [garbage])).toEqual([]);
    }
    const notRsa = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    expect(await run([], { AGENT_APP_PRIVATE_KEY_B64: Buffer.from(notRsa).toString("base64") })).toMatchObject({ code: 1, stdout: "" });
    expect(calls).toEqual([]);
  });

  it("a PEM pasted as is (not base64) works too", async () => {
    const result = await run([], { AGENT_APP_PRIVATE_KEY_B64: pem });
    expect(result).toMatchObject({ code: 0, stdout: `${TOKEN}\n`, stderr: "" });
    expect(decodeJwt(calls[0]?.auth).signed).toBe(true);
  });

  it("runs when invoked through a symlink", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-token-"));
    dirs.push(dir);
    const link = join(dir, "token.mjs");
    symlinkSync(SCRIPT, link);
    expect(await run([], {}, link)).toMatchObject({ code: 0, stdout: `${TOKEN}\n`, stderr: "" });
    expect(await run(["--login"], {}, link)).toMatchObject({ code: 0, stdout: "oac-issue-agents[bot]\n" });
    expect(await run([], { AGENT_APP_ID: undefined }, link)).toMatchObject({ code: 2, stdout: "" });
  });

  it("connects directly, never through a proxy (the session proxy swaps in the owner's GitHub credentials)", async () => {
    const seen: string[] = [];
    const proxy = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.writeHead(502).end();
    });
    proxy.on("connect", (req, socket) => {
      seen.push(`CONNECT ${req.url}`);
      socket.destroy();
    });
    await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
    try {
      const url = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
      const env = { HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url, NO_PROXY: "", no_proxy: "" };
      expect(await run([], env)).toMatchObject({ code: 0, stdout: `${TOKEN}\n`, stderr: "" });
      expect(await run([], { ...env, NODE_USE_ENV_PROXY: "1" })).toMatchObject({ code: 0, stdout: `${TOKEN}\n`, stderr: "" });
      expect(seen).toEqual([]);
    } finally {
      proxy.closeAllConnections();
      await new Promise((done) => proxy.close(done));
    }
  });

  it("API_ERROR: a 401 or 404 exits 1 with the status and message, and no key, JWT, or token", async () => {
    answers.set(`GET /repos/${REPO}/installation`, [401, { message: "A JSON web token could not be decoded" }]);
    const unauthorized = await run();
    expect(unauthorized).toMatchObject({ code: 1, stdout: "" });
    expect(unauthorized.stderr).toContain("401");
    expect(unauthorized.stderr).toContain("A JSON web token could not be decoded");
    expect(secretsIn(unauthorized)).toEqual([]);

    answers.set(`GET /repos/${REPO}/installation`, [404, { message: "Not Found" }]);
    const missing = await run();
    expect(missing).toMatchObject({ code: 1, stdout: "" });
    expect(missing.stderr).toContain("404");

    answers.delete(`GET /repos/${REPO}/installation`);
    answers.set(`POST /app/installations/${INSTALLATION}/access_tokens`, [403, { message: "Resource not accessible" }]);
    expect(await run()).toMatchObject({ code: 1, stdout: "" });

    answers.set("GET /app", [401, { message: "bad" }]);
    answers.set(`GET /repos/${REPO}/installation`, [401, { message: "bad" }]);
    expect(await run(["--login"])).toMatchObject({ code: 1, stdout: "" });
  });

  it("API_ERROR: an echoed JWT in the API message is redacted", async () => {
    // This stub echoes whatever Authorization it got into the message.
    const echo = createServer(async (req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: `bad credentials ${req.headers.authorization}` }));
    });
    await new Promise<void>((done) => echo.listen(0, "127.0.0.1", done));
    try {
      const result = await run([], { GITHUB_API_URL: `http://127.0.0.1:${(echo.address() as AddressInfo).port}` });
      expect(result).toMatchObject({ code: 1, stdout: "" });
      expect(result.stderr).toContain("[redacted]");
      expect(result.stderr).not.toMatch(/eyJ/);
      expect(secretsIn(result)).toEqual([]);
    } finally {
      await new Promise((done) => echo.close(done));
    }
  });

  it("answers without the expected fields, and a refused connection, exit 1", async () => {
    answers.set(`GET /repos/${REPO}/installation`, [200, {}]);
    expect(await run()).toMatchObject({ code: 1, stdout: "" });
    answers.delete(`GET /repos/${REPO}/installation`);
    answers.set(`POST /app/installations/${INSTALLATION}/access_tokens`, [201, { token: "" }]);
    expect(await run()).toMatchObject({ code: 1, stdout: "" });
    answers.set("GET /app", [200, { slug: "bad slug!" }]);
    answers.set(`GET /repos/${REPO}/installation`, [200, { id: INSTALLATION, app_slug: "bad slug!" }]);
    expect(await run(["--login"])).toMatchObject({ code: 1, stdout: "" });
    const down = await run([], { GITHUB_API_URL: "http://127.0.0.1:1" });
    expect(down).toMatchObject({ code: 1, stdout: "" });
    expect(secretsIn(down)).toEqual([]);
  });

  it("a redirect is not followed (the JWT stays with the API host)", async () => {
    const moved = createServer((req, res) => {
      calls.push({ method: req.method ?? "GET", path: req.url ?? "", body: null, auth: req.headers.authorization });
      res.writeHead(302, { location: req.url ?? "/" }); // to its own path: a followed redirect would be a second request
      res.end();
    });
    await new Promise<void>((done) => moved.listen(0, "127.0.0.1", done));
    try {
      const result = await run([], { GITHUB_API_URL: `http://127.0.0.1:${(moved.address() as AddressInfo).port}` });
      expect(result).toMatchObject({ code: 1, stdout: "" });
      expect(calls).toHaveLength(1);
      expect(secretsIn(result)).toEqual([]);
    } finally {
      await new Promise((done) => moved.close(done));
    }
  });
});
