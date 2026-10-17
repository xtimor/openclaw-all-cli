import { isDeepStrictEqual } from "node:util";
import type { PermissionDecision, PermissionRequest } from "./ports.ts";
import type { ExecuteContext } from "./sdk-types.ts";

/**
 * Tool-permission routing (AD-9, AD-11). The CLI asks; the host decides. The core forwards the
 * adapter's canonical request to `ctx.requestToolPermission` and obeys the answer. It never
 * allows on failure and starts no timer (the host owns timers).
 */

/** The turn a permission request belongs to. It lives from the turn's start to its end. */
export type PermissionTurn = {
  ctx: Pick<
    ExecuteContext,
    "requestToolPermission" | "toolAvailability" | "cwd" | "abortSignal" | "assertCurrent"
  >;
  /** Set when the turn ends; a request after that is answered `cancelled`. */
  ended: boolean;
};

const MAX_LOGGED_ERROR_CHARS = 200;

/** A request the turn can no longer answer: it ended, was aborted, or a newer run took over. */
function turnIsOver(turn: PermissionTurn): boolean {
  if (turn.ended || turn.ctx.abortSignal?.aborted) return true;
  try {
    turn.ctx.assertCurrent?.();
    return false;
  } catch {
    return true;
  }
}

/** Resolves `"cancelled"` when the signal aborts; `dispose` removes the listener. */
function onAbort(signal: AbortSignal | undefined): { aborted: Promise<"cancelled">; dispose: () => void } {
  if (!signal) return { aborted: new Promise(() => {}), dispose: () => {} };
  let listener: (() => void) | undefined;
  const aborted = new Promise<"cancelled">((resolve) => {
    listener = () => resolve("cancelled");
    signal.addEventListener("abort", listener, { once: true });
  });
  return { aborted, dispose: () => listener && signal.removeEventListener("abort", listener) };
}

function describe(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.slice(0, MAX_LOGGED_ERROR_CHARS);
}

/**
 * Answers one CLI permission request.
 * - No turn, a finished turn, an aborted turn: `cancelled`, and the host is never asked.
 * - A call the adapter could not name, or a tool outside the run's native selection: rejected,
 *   and the host is never asked. The turn check comes first, so a late one is `cancelled`.
 * - Otherwise the host decides. An error, a malformed answer, or an answer that changes the
 *   input rejects: the CLI can run only what the host saw.
 */
export async function routePermission(
  turn: PermissionTurn | undefined,
  request: PermissionRequest,
  warn: (message: string) => void,
): Promise<PermissionDecision> {
  if (!turn || turnIsOver(turn)) return "cancelled";
  const { ctx } = turn;
  const { toolName, toolInput } = request;

  // A call the adapter could not name is one the host cannot approve.
  if (toolName === undefined || toolInput === undefined) return "reject_once";
  if (ctx.toolAvailability && !ctx.toolAvailability.native.includes(toolName)) return "reject_once";

  const abort = onAbort(ctx.abortSignal);
  try {
    const asked = ctx
      .requestToolPermission({
        toolName,
        toolInput,
        ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
        ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
        ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
      })
      .then<PermissionDecision>((result) => {
        if (turnIsOver(turn)) return "cancelled";
        if (result?.behavior !== "allow") return "reject_once";
        if (!isDeepStrictEqual(result.updatedInput, toolInput)) {
          warn(`The host changed the input of native tool "${toolName}"; the CLI cannot apply that, so the call is rejected.`);
          return "reject_once";
        }
        return "allow_once";
      });
    return await Promise.race([asked, abort.aborted]);
  } catch (error) {
    warn(`Asking the host to approve native tool "${toolName}" failed; the call is rejected. ${describe(error)}`);
    return turnIsOver(turn) ? "cancelled" : "reject_once";
  } finally {
    abort.dispose();
  }
}

/**
 * Whether the run's tool-availability contract can be enforced for this CLI (AD-9). The adapter
 * cannot switch off the native tools it keeps open, so the run must leave all of them selected.
 * Returns the names that block enforcement, empty when the run is enforceable.
 */
export function unenforceableNativeTools(
  availability: NonNullable<ExecuteContext["toolAvailability"]>,
  alwaysOn: readonly string[],
): string[] {
  return alwaysOn.filter((name) => !availability.native.includes(name));
}
