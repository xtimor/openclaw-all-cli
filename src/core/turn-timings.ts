import type { OpenPhase } from "./ports.ts";

/** The order the open phases appear in the line. */
const OPEN_ORDER: readonly OpenPhase[] = ["spawn", "initialize", "login", "new_session", "load_session", "set_mode", "set_model"];

const atLeastOneMs = (from: number, to: number) => Math.max(1, Math.ceil(to - from));

/** How a turn ended: `ok` (a result), `error` (an error event or a failed open), `aborted` (the host stopped it, or it was superseded). */
export type TurnOutcome = "ok" | "error" | "aborted";

/**
 * The phases of one turn, for one debug-log line (issue #44). Open phases are durations; the
 * marks are read in the order a turn reaches them: `prompt_sent` counts from the start of the
 * turn (the slot wait, the version check, the proxy, and the open are before it), and the first
 * thought, the first text, and the end count from the prompt sent. A phase that did not happen is
 * absent from the line, never `0`. The line holds no prompt text, key, or path.
 */
export class TurnTimings {
  private readonly open = new Map<OpenPhase, number>();
  private promptSentAt: number | undefined;
  private firstThoughtAt: number | undefined;
  private firstTextAt: number | undefined;
  private endAt: number | undefined;
  private reused = false;
  private outcome: TurnOutcome = "aborted";
  private errorCode: string | undefined;

  constructor(
    /** A `performance.now()` reading from the start of the turn. */
    private readonly startedAt: number = performance.now(),
  ) {}

  /** Records an open phase (a phase that ran twice keeps the last). */
  recordOpen(phase: OpenPhase, ms: number): void {
    this.open.set(phase, ms);
  }

  /** The turn ran on a process an earlier turn opened: it has no open phases. */
  markReused(): void {
    this.reused = true;
  }

  markPromptSent(): void {
    this.promptSentAt = performance.now();
  }

  /** Notes an event of the turn; only the first thought and the first text count. */
  markEvent(kind: string): void {
    if (this.promptSentAt === undefined) return;
    if (kind === "thinking") this.firstThoughtAt ??= performance.now();
    else if (kind === "text") this.firstTextAt ??= performance.now();
  }

  /** The turn's closing event arrived (a result or an error). */
  markEnd(outcome: "ok" | "error", errorCode?: string): void {
    this.endAt ??= performance.now();
    this.outcome = outcome;
    this.errorCode = errorCode;
  }

  /** A failure that is not a closing event (a failed open, a thrown error). */
  markFailed(errorCode?: string): void {
    if (this.endAt === undefined) {
      this.outcome = "error";
      this.errorCode = errorCode;
    }
  }

  /** `key=value` pairs separated by spaces; durations end in `ms`. */
  line(backend: string, modelId: string): string {
    // The host names the model; keep the line one token per value whatever it holds.
    const model = modelId.replace(/[^\w.:/\-[\],=]/g, "_").slice(0, 80);
    const parts = [`turn timings (${backend}): model=${model}`, `process=${this.reused ? "reused" : "new"}`, `outcome=${this.outcome}`];
    if (this.errorCode) parts.push(`code=${this.errorCode}`);
    for (const phase of OPEN_ORDER) {
      const ms = this.open.get(phase);
      if (ms !== undefined) parts.push(`${phase}=${ms}ms`);
    }
    const sent = this.promptSentAt;
    if (sent !== undefined) {
      parts.push(`prompt_sent=${atLeastOneMs(this.startedAt, sent)}ms`);
      if (this.firstThoughtAt !== undefined) parts.push(`first_thought=${atLeastOneMs(sent, this.firstThoughtAt)}ms`);
      if (this.firstTextAt !== undefined) parts.push(`first_text=${atLeastOneMs(sent, this.firstTextAt)}ms`);
      if (this.endAt !== undefined) parts.push(`end=${atLeastOneMs(sent, this.endAt)}ms`);
    }
    return parts.join(" ");
  }
}
