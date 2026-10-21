import type { UsageClock } from "../../src/adapters/cursor/usage.ts";

/**
 * Three event-loop turns. With no real I/O in flight, every pending promise chain has run by then,
 * so a promise still pending afterwards is waiting on a timer (or stuck).
 */
export async function idle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

export type VirtualClock = UsageClock & {
  /** Moves time forward by `ms`, firing the timers that fall due in order. Synchronous. */
  advance(ms: number): void;
  /**
   * Drives `promise` to its end: lets the microtasks settle, and while it is pending fires the
   * earliest due batch of timers. Throws at once when nothing can wake it, or past `maxMs`.
   */
  run<T>(promise: Promise<T>, options?: { maxMs?: number }): Promise<T>;
};

type Timer = { at: number; seq: number; fire: () => void; passive: boolean };

/**
 * A clock whose time moves only through `advance` and `run`. Timers due at one time fire as one
 * batch in registration order. A `timeout` signal is passive: it fires when time passes it, but
 * does not count as pending work (a request timeout alone cannot wake a stuck promise).
 */
export function createVirtualClock(start = Date.UTC(2026, 0, 1)): VirtualClock {
  let time = start;
  let seq = 0;
  const timers = new Set<Timer>();

  const add = (ms: number, fire: () => void, passive = false): Timer => {
    const timer = { at: time + Math.max(0, ms), seq: (seq += 1), fire, passive };
    timers.add(timer);
    return timer;
  };
  const earliest = (): number | undefined => {
    let at: number | undefined;
    for (const timer of timers) if (at === undefined || timer.at < at) at = timer.at;
    return at;
  };
  /** Fires every timer due at `at`, in registration order, with time set to `at`. */
  const fireBatch = (at: number) => {
    time = Math.max(time, at);
    const batch = [...timers].filter((timer) => timer.at === at).sort((a, b) => a.seq - b.seq);
    for (const timer of batch) {
      if (!timers.delete(timer)) continue;
      timer.fire();
    }
  };

  return {
    now: () => time,
    sleep(ms, signal) {
      return new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        const done = () => {
          timers.delete(timer);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const timer = add(ms, done);
        signal?.addEventListener("abort", done, { once: true });
      });
    },
    timeout(ms) {
      const controller = new AbortController();
      add(ms, () => controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")), true);
      return controller.signal;
    },
    advance(ms) {
      const target = time + ms;
      for (let at = earliest(); at !== undefined && at <= target; at = earliest()) fireBatch(at);
      time = target;
    },
    async run(promise, options = {}) {
      const limit = time + (options.maxMs ?? 3_600_000);
      let outcome: { ok: true; value: unknown } | { ok: false; error: unknown } | undefined;
      promise.then(
        (value) => { outcome = { ok: true, value }; },
        (error: unknown) => { outcome = { ok: false, error }; },
      );
      for (;;) {
        await idle();
        if (outcome) {
          if (outcome.ok) return outcome.value as never;
          throw outcome.error;
        }
        const at = earliest();
        if (at === undefined || ![...timers].some((timer) => !timer.passive)) {
          throw new Error("virtual clock: the promise is pending and no timer left");
        }
        if (at > limit) throw new Error(`virtual clock: the promise is still pending past the ${options.maxMs ?? 3_600_000} ms limit`);
        fireBatch(at);
      }
    },
  };
}
