import { CliError } from "./ports.ts";

/** Defaults per backend, under the host's own global cap of 16 live sessions. */
export const DEFAULT_MAX_TURNS = 4;
export const DEFAULT_MAX_PROCESSES = 8;
/** `closeAll` waits this long for the processes to exit: the transport's SIGKILL grace plus a margin. */
export const POOL_CLOSE_WAIT_MS = 3_000;

export type PoolOptions = {
  /** Turns that run at once. Later turns wait in FIFO order. */
  maxTurns: number;
  /** Live processes, idle ones included. At least `maxTurns`, so a turn always finds an idle one to evict. */
  maxProcesses: number;
  /** Longest `closeAll` waits for the exits. */
  closeWaitMs?: number;
};

/** A live process as the pool sees it. */
export type PoolMember = {
  /** True when no turn runs in it and it can be closed without losing work. */
  isIdle(): boolean;
  /** When it last served a turn, in ms. The least recently used idle process is evicted first. */
  lastUsed: number;
  /** Starts closing it. It leaves the pool by calling `pool.remove` itself. Safe to call twice. */
  close(): void;
  /** Resolves when the process has exited (or at once when it never started). */
  exited(): Promise<void>;
};

export type TurnSlot = { release(): void };

type Waiter = { resolve: (slot: TurnSlot) => void; reject: (reason: unknown) => void; cleanup: () => void };

function shuttingDown(): CliError {
  return new CliError({ code: "server_error", message: "The plugin is shutting down.", retryable: true });
}

/**
 * The limits of one backend (AD-14): a turn semaphore and a process registry. It starts no timer
 * of its own (AD-11): a turn waits for a slot until one frees or its own signal aborts.
 */
export class ProcessPool {
  private running = 0;
  private readonly waiters: Waiter[] = [];
  private readonly members = new Set<PoolMember>();
  private readonly checked = new Set<string>();
  private closing: Promise<void> | undefined;

  constructor(private readonly options: PoolOptions) {}

  get turns(): number {
    return this.running;
  }

  get queued(): number {
    return this.waiters.length;
  }

  get processes(): number {
    return this.members.size;
  }

  get isClosed(): boolean {
    return this.closing !== undefined;
  }

  /**
   * Takes a turn slot. Waits in FIFO order when `maxTurns` turns run; leaves the queue and throws
   * the signal's reason when `signal` aborts. The slot must be released on every exit path.
   */
  async acquireTurn(signal?: AbortSignal): Promise<TurnSlot> {
    if (this.closing) throw shuttingDown();
    signal?.throwIfAborted();
    if (this.running < this.options.maxTurns) {
      this.running += 1;
      return this.slot();
    }
    return new Promise<TurnSlot>((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal?.reason);
      };
      const waiter: Waiter = {
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private slot(): TurnSlot {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const next = this.waiters.shift();
        if (next) {
          // The slot passes straight to the first waiter: the count does not move.
          next.cleanup();
          next.resolve(this.slot());
        } else {
          this.running -= 1;
        }
      },
    };
  }

  /**
   * Counts a new process. At the cap, the least recently used idle process is closed to make room.
   * With none idle (a broken invariant: busy processes are bounded by running turns) it throws a
   * retryable `overloaded`.
   */
  add(member: PoolMember): void {
    if (this.closing) throw shuttingDown();
    if (this.members.size >= this.options.maxProcesses) {
      const victim = [...this.members].filter((m) => m.isIdle()).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!victim) {
        throw new CliError({
          code: "overloaded",
          message: `All ${this.options.maxProcesses} CLI processes are busy.`,
          retryable: true,
        });
      }
      this.members.delete(victim);
      victim.close();
    }
    this.members.add(member);
  }

  remove(member: PoolMember): void {
    this.members.delete(member);
  }

  /** True when the version check already passed for `key` (a command). Only success is kept. */
  versionChecked(key: string): boolean {
    return this.checked.has(key);
  }

  markVersionChecked(key: string): void {
    this.checked.add(key);
  }

  /**
   * Refuses new turns, stops the waiting ones, and closes every process. Resolves when they have
   * exited or the wait runs out. Safe to call twice: the second call shares the first.
   */
  closeAll(): Promise<void> {
    return (this.closing ??= this.shutDown());
  }

  private async shutDown(): Promise<void> {
    for (const waiter of this.waiters.splice(0)) {
      waiter.cleanup();
      waiter.reject(shuttingDown());
    }
    const all = [...this.members];
    this.members.clear();
    for (const member of all) {
      try {
        member.close();
      } catch {
        // One failing close must not leave the others running.
      }
    }
    let timer: NodeJS.Timeout | undefined;
    const gaveUp = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.options.closeWaitMs ?? POOL_CLOSE_WAIT_MS);
    });
    await Promise.race([Promise.allSettled(all.map((member) => member.exited())), gaveUp]);
    clearTimeout(timer);
  }
}
