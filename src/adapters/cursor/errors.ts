import type { CliErrorCode, CliErrorInfo } from "../../core/ports.ts";

/**
 * Cursor reports a failed turn (network, auth, rate limit, plan) as one final reply chunk, then
 * `end_turn` (cursor-agent 2026.10.19). This is the only place that knows its wording. The shapes:
 *
 * - `\n\nError: <Name>: [<connect code>] <detail>` (`RetriableError`, `NonRetriableError`, ...),
 * - `\n\nError: [<connect code>] <detail>`,
 * - one of four bare action phrases (`ActionRequiredError`), with or without the leading blank line.
 *
 * The host picks its failover reason from the message text alone, so each message names the failure
 * in words the host reads ("rate limit", "payment required", "unauthorized", ...) and then quotes
 * Cursor's own text.
 */

type Failure = { code: CliErrorCode; label: string };

const AUTH: Failure = { code: "auth", label: "authentication failed (unauthorized)" };
const RATE_LIMIT: Failure = { code: "rate_limit", label: "rate limit reached (usage limit)" };
const SERVER_ERROR: Failure = { code: "server_error", label: "internal server error" };

/** Connect error codes (https://connectrpc.com/docs/protocol#error-codes) that Cursor passes through. */
const CONNECT_CODES: Readonly<Record<string, Failure>> = {
  unauthenticated: AUTH,
  permission_denied: AUTH,
  resource_exhausted: RATE_LIMIT,
  unavailable: { code: "overloaded", label: "is overloaded (service unavailable)" },
  deadline_exceeded: { code: "timeout", label: "timed out (deadline exceeded)" },
  invalid_argument: { code: "format", label: "rejected the request (invalid request format)" },
  failed_precondition: { code: "format", label: "rejected the request (invalid request format)" },
  internal: SERVER_ERROR,
  unknown: SERVER_ERROR,
};

/** Cursor's `ActionRequiredError` texts, by the action they ask for. */
const ACTION_PHRASES: Readonly<Record<string, Failure>> = {
  "upgrade your plan to continue": RATE_LIMIT,
  "please sign in to continue": AUTH,
  "add a payment method to continue": { code: "billing", label: "payment required" },
  "check your settings to continue": {
    code: "auth_permanent",
    label: "refused the request, check the API key and settings (API key revoked or not allowed for this organization)",
  },
};

const ERROR_HEAD = /^\n\nError: /;
/** After `Error: `: an error name and a colon (`RetriableError: `), then maybe a code, or a code at once. */
const NAMED = /^([A-Za-z_$][\w$]*): /;
const CODED = /^\[([a-z_]+)\]/;

function message(failure: Failure, original: string): string {
  return `Cursor ${failure.label}: ${original}`;
}

/**
 * Recognises a reply chunk that is really a Cursor failure. Returns the error to raise, or
 * `undefined` for ordinary text. `RetriableError` makes it retryable; the transport clears that
 * once a tool call started.
 */
export function classifyCursorReplyError(text: string): CliErrorInfo | undefined {
  const original = text.trim();
  const action = ACTION_PHRASES[original.toLowerCase()];
  if (action) return { code: action.code, retryable: false, message: message(action, original) };

  const head = ERROR_HEAD.exec(text);
  if (!head) return undefined;
  let rest = text.slice(head[0].length);
  const name = NAMED.exec(rest);
  if (name) rest = rest.slice(name[0].length);
  const coded = CODED.exec(rest);
  // A bare `Error: something` is not enough: Cursor always names the error or its code.
  if (!name && !coded) return undefined;
  const failure = (coded && CONNECT_CODES[coded[1]!]) || SERVER_ERROR;
  return { code: failure.code, retryable: name?.[1] === "RetriableError", message: message(failure, original) };
}
