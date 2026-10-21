import { randomUUID } from "node:crypto";
import { BroadcastChannel, threadId } from "node:worker_threads";

/**
 * The model listings in flight in this Node process (AD-14), so the plugin's unload can stop them.
 *
 * OpenClaw runs the provider catalog (`provider-discovery.ts`) in a worker thread, and the plugin
 * (`plugin.ts`) in the main thread. Within one thread the set hangs on `globalThis` under a shared
 * symbol, because the two entries may load this module twice. Across threads a `BroadcastChannel`
 * carries the unload: the closing thread asks every thread that has listings to abort them, and
 * waits for each to report that its listings have settled (process gone, lock released).
 */

/** A listing in flight: `abort` stops its process; `done` settles once the process is gone and its lock released. */
export type Listing = { abort(): void; done: Promise<void> };

type Holder = { listings: Set<Listing>; channel?: BroadcastChannel; replies: number };
type Message =
  | { type: "close"; id: string }
  | { type: "closing"; id: string; thread: number }
  | { type: "closed"; id: string; thread: number };

const HOLDER_KEY = Symbol.for("openclaw-all-cli.listings");
const CHANNEL_NAME = "openclaw-all-cli.listings";
/** A thread with listings answers a close request at once; this is how long the closer waits for those answers. */
const ANSWER_WINDOW_MS = 150;
const POLL_MS = 20;

function holder(): Holder {
  const place = globalThis as unknown as Record<symbol, Holder | undefined>;
  return (place[HOLDER_KEY] ??= { listings: new Set<Listing>(), replies: 0 });
}

function abortAll(all: readonly Listing[]): void {
  for (const listing of all) {
    try {
      listing.abort();
    } catch {
      // Nothing more to do for this one.
    }
  }
}

/** Closes the thread's channel once no listing and no pending answer needs it. */
function closeIdleChannel(state: Holder): void {
  if (state.listings.size > 0 || state.replies > 0 || !state.channel) return;
  state.channel.close();
  state.channel = undefined;
}

/** Answers another thread's close request for the listings of this thread. */
function listen(state: Holder): BroadcastChannel {
  const channel = new BroadcastChannel(CHANNEL_NAME);
  // The channel must not keep a thread alive.
  channel.unref();
  channel.onmessage = (event: MessageEvent) => {
    const message = event.data as Message | undefined;
    if (message?.type !== "close" || typeof message.id !== "string") return;
    const all = [...state.listings];
    if (all.length === 0) return;
    state.replies += 1;
    channel.postMessage({ type: "closing", id: message.id, thread: threadId } satisfies Message);
    abortAll(all);
    void Promise.allSettled(all.map((listing) => listing.done)).then(() => {
      // The channel stays open until this answer is out.
      try {
        channel.postMessage({ type: "closed", id: message.id, thread: threadId } satisfies Message);
      } catch {
        // The closer gives up after its wait.
      }
      state.replies -= 1;
      closeIdleChannel(state);
    });
  };
  return channel;
}

/** Registers a listing for the unload; the returned function removes it once the listing has settled. */
export function trackListing(listing: Listing): () => void {
  const state = holder();
  state.listings.add(listing);
  try {
    state.channel ??= listen(state);
  } catch {
    // No channel: the other threads' unload cannot reach this listing, this thread's still can.
  }
  return () => {
    state.listings.delete(listing);
    closeIdleChannel(state);
  };
}

/**
 * Aborts every model listing in flight, in this thread and in the other threads of the process, and
 * waits for their processes to exit and their locks to be released, at most `waitMs`. Never throws.
 */
export async function closeListings(waitMs: number): Promise<void> {
  const local = [...holder().listings];
  abortAll(local);
  const id = randomUUID();
  const closing = new Set<number>();
  const closed = new Set<number>();
  let channel: BroadcastChannel | undefined;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.unref();
    channel.onmessage = (event: MessageEvent) => {
      const message = event.data as Message | undefined;
      if (!message || message.id !== id || message.type === "close" || message.thread === threadId) return;
      (message.type === "closing" ? closing : closed).add(message.thread);
    };
    channel.postMessage({ type: "close", id } satisfies Message);
  } catch {
    // This thread's listings are still waited for below.
  }
  let timer: NodeJS.Timeout | undefined;
  const gaveUp = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, waitMs);
  });
  const settled = (async () => {
    await Promise.allSettled(local.map((listing) => listing.done));
    await new Promise((resolve) => setTimeout(resolve, ANSWER_WINDOW_MS));
    while ([...closing].some((thread) => !closed.has(thread))) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  })();
  await Promise.race([settled, gaveUp]);
  clearTimeout(timer);
  channel?.close();
}
