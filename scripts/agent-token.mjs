#!/usr/bin/env node
// Mints a short-lived installation token of the issue agents' GitHub App, so the agents write to GitHub as the app
// (`<app-slug>[bot]`) and not as the owner. Agent-neutral and dependency-free (Node standard library, global `fetch`).
// Design: _bmad-output/.../epic-distribution/issue-flow.md; how the agents use it: docs/agents/identity.md.
//
//   AGENT_APP_ID=... AGENT_APP_PRIVATE_KEY=... node scripts/agent-token.mjs            # prints the token
//   AGENT_APP_ID=... AGENT_APP_PRIVATE_KEY=... node scripts/agent-token.mjs --login    # prints <app-slug>[bot] (GET /app, else the installation's app_slug)
//
// Environment:
//   AGENT_APP_ID               the app's ID (or client ID). Required.
//   AGENT_APP_PRIVATE_KEY      the app's private key as the PEM file's text (the `Agent write` workflow's repository secret). One of the
//   AGENT_APP_PRIVATE_KEY_B64  two keys is required: this one is the same PEM as one base64 string. Both set: the _B64 one wins.
//   AGENT_APP_REPO             `owner/repo` the app is installed on (default xtimor/openclaw-all-cli).
//   GITHUB_API_URL             API base (default https://api.github.com); tests point it at a local server.
//
// stdout holds only the token (or the login). Messages go to stderr and never contain the key, the JWT, or a token.
// Exit 0 ok, 1 the key or the GitHub API failed, 2 a variable is missing or malformed.
// Proxy: Node's `fetch` ignores the proxy variables by default. The script switches them on when one is set, through
// `http.setGlobalProxyFromEnv` where Node has it (verified on the repo's Node 24.22; not checked on other versions).
import { createPrivateKey, sign } from "node:crypto";
import { realpathSync } from "node:fs";
import * as http from "node:http";
import { pathToFileURL } from "node:url";

const DEFAULT_REPO = "xtimor/openclaw-all-cli";
const DEFAULT_API = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_MESSAGE = 300;

/** A failure with an exit code and a message that is safe to print. */
class AgentTokenError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

const b64url = (input) => Buffer.from(input).toString("base64url");

/** The private key from the PEM text or the base64 of the PEM file (either works in either variable). The message never contains the value. */
function readKey(value, name) {
  const pem = value.startsWith("-----BEGIN") ? value : Buffer.from(value, "base64").toString("utf8");
  let key;
  try {
    key = createPrivateKey(pem);
  } catch {
    const hint = name === "AGENT_APP_PRIVATE_KEY" ? "the app's PEM file" : "the base64 of the app's PEM file (base64 -w0 key.pem)";
    throw new AgentTokenError(`${name} is not a valid private key: it must be ${hint}`);
  }
  if (key.asymmetricKeyType !== "rsa") throw new AgentTokenError(`${name} is not an RSA private key`);
  return key;
}

/** An RS256 JWT for the app: issued 60 s in the past (clock drift), valid 10 minutes from then. */
function appJwt(appId, key, nowSeconds) {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }));
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), key).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

const isSet = (value) => typeof value === "string" && value.trim() !== "";

function readConfig(env) {
  const keyName = isSet(env.AGENT_APP_PRIVATE_KEY_B64) ? "AGENT_APP_PRIVATE_KEY_B64" : "AGENT_APP_PRIVATE_KEY";
  const missing = [];
  if (!isSet(env.AGENT_APP_ID)) missing.push("AGENT_APP_ID");
  if (!isSet(env[keyName])) missing.push("AGENT_APP_PRIVATE_KEY_B64 (or AGENT_APP_PRIVATE_KEY)");
  if (missing.length > 0) throw new AgentTokenError(`missing environment variable: ${missing.join(", ")}`, 2);
  const appId = env.AGENT_APP_ID.trim();
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(appId)) throw new AgentTokenError("AGENT_APP_ID is not an app ID or client ID", 2);
  const repo = (env.AGENT_APP_REPO ?? "").trim() || DEFAULT_REPO;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new AgentTokenError("AGENT_APP_REPO must look like owner/repo", 2);
  const api = ((env.GITHUB_API_URL ?? "").trim() || DEFAULT_API).replace(/\/+$/, "");
  return { appId, repo, api, keyName, keyValue: env[keyName].trim() };
}

/** One GitHub API call as the app. Returns the parsed JSON; a failure carries the status and the API's message only. */
async function call(api, jwt, method, path, body) {
  const label = `${method} ${path}`;
  let response;
  try {
    response = await fetch(`${api}${path}`, {
      method,
      redirect: "error", // never send the JWT anywhere else
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "openclaw-all-cli-agent-token",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    const reason = error?.name === "TimeoutError" ? "timed out" : (error?.cause?.code ?? error?.code ?? "request failed");
    throw new AgentTokenError(`${label}: ${reason}`);
  }
  let text = "";
  try {
    text = await response.text();
  } catch {
    // an unreadable body is reported by status below
  }
  let data = null;
  try {
    data = text === "" ? null : JSON.parse(text);
  } catch {
    // not JSON
  }
  if (!response.ok) {
    const message = typeof data?.message === "string" ? data.message : "";
    const shown = message.replaceAll(jwt, "[redacted]").slice(0, MAX_MESSAGE);
    throw new AgentTokenError(`${label}: GitHub answered ${response.status}${shown === "" ? "" : ` (${shown})`}`);
  }
  if (data === null || typeof data !== "object") throw new AgentTokenError(`${label}: GitHub answered ${response.status} without JSON`);
  return data;
}

/** The installation token, scoped to the one repository. */
async function mintToken(config, jwt) {
  const installation = await call(config.api, jwt, "GET", `/repos/${config.repo}/installation`);
  if (!Number.isSafeInteger(installation.id) || installation.id < 1) throw new AgentTokenError(`GET /repos/${config.repo}/installation: no installation id in the answer`);
  const name = config.repo.split("/")[1];
  const access = await call(config.api, jwt, "POST", `/app/installations/${installation.id}/access_tokens`, { repositories: [name] });
  if (typeof access.token !== "string" || access.token === "") throw new AgentTokenError("POST access_tokens: no token in the answer");
  return access.token;
}

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/**
 * `<app-slug>[bot]`, the login GitHub shows for the app's comments, labels, and pull requests. The slug comes from
 * `GET /app`; where that path is not reachable (a restricted proxy), from the installation of the repository.
 */
async function readLogin(config, jwt) {
  let first;
  try {
    const app = await call(config.api, jwt, "GET", "/app");
    if (typeof app.slug === "string" && SLUG_RE.test(app.slug)) return `${app.slug}[bot]`;
    first = new AgentTokenError("GET /app: no app slug in the answer");
  } catch (error) {
    if (!(error instanceof AgentTokenError)) throw error;
    first = error;
  }
  try {
    const installation = await call(config.api, jwt, "GET", `/repos/${config.repo}/installation`);
    if (typeof installation.app_slug === "string" && SLUG_RE.test(installation.app_slug)) return `${installation.app_slug}[bot]`;
  } catch (error) {
    if (!(error instanceof AgentTokenError)) throw error;
  }
  throw first;
}

/** Runs the script; returns `{code, out}` and writes nothing itself. `out` is the one line for stdout. */
export async function run(argv, env, nowMs = Date.now()) {
  const flags = argv.filter((arg) => arg !== "--login");
  if (flags.length > 0) throw new AgentTokenError("usage: node scripts/agent-token.mjs [--login]", 2);
  const config = readConfig(env);
  const key = readKey(config.keyValue, config.keyName);
  const jwt = appJwt(config.appId, key, Math.floor(nowMs / 1000));
  return argv.includes("--login") ? readLogin(config, jwt) : mintToken(config, jwt);
}

async function main() {
  // Node's fetch ignores HTTPS_PROXY unless asked; honor the environment's proxy when this Node can.
  const wantsProxy = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"].some((name) => process.env[name]);
  if (wantsProxy && typeof http.setGlobalProxyFromEnv === "function") http.setGlobalProxyFromEnv(process.env);
  try {
    const out = await run(process.argv.slice(2), process.env);
    process.stdout.write(`${out}\n`);
  } catch (error) {
    // Only our own errors carry a safe message; anything else is reported without its text.
    const safe = error instanceof AgentTokenError;
    process.stderr.write(`agent-token: ${safe ? error.message : "unexpected error"}\n`);
    process.exitCode = safe ? error.code : 1;
  }
}

// Run when invoked as the script, also through a symlink (compare real paths).
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return true;
  }
}

if (invokedDirectly()) await main();
