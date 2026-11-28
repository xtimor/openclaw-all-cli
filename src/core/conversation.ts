import { processGlobal } from "./process-global.ts";

/**
 * Which OpenClaw conversation a process serves. `execute` sees neither the host's session id nor
 * its session key, but a normal CLI turn's system prompt carries the key in the host's Runtime
 * line (`Runtime: agent=main | session=agent:main:explicit:x | host=...`), and the host's
 * `session_end` event names the same key. A host that words the line differently only costs the
 * early release: the idle close still ends the process.
 */
const RUNTIME_SESSION = /^Runtime: .*?\| session=([^\s|]+)/m;

/** The session key the host's Runtime line names, or undefined when the prompt has none. */
export function conversationOf(systemPrompt: string): string | undefined {
  return RUNTIME_SESSION.exec(systemPrompt)?.[1];
}

/**
 * The `session_end` reasons after which no later turn continues the ended conversation's CLI chat.
 * `shutdown` and `restart` stay with the close-all path, `compaction` keeps the chat going, and
 * `unknown` proves nothing.
 */
export const RELEASING_REASONS: ReadonlySet<string> = new Set(["new", "reset", "deleted", "idle", "daily"]);

/** What a conversation end needs of a process pool. Kept this small: copies of other plugin versions share the registry. */
export type ConversationPool = { releaseConversation(conversation: string): number };

const POOLS_KEY = Symbol.for("openclaw-all-cli.conversation-pools");

/**
 * The process pools of every loaded copy of the plugin in this thread (issue #105). OpenClaw can load the plugin
 * more than once in one Gateway: on 2026.10.3 with a second agent in the config, a turn runs in a copy of its own,
 * whose pool holds the turn's process, while the host's `session_end` runs in the Gateway's copy. Held weakly: a
 * pool that serves turns is held by its copy's registered backend, and a copy the host drops leaves nothing here.
 */
function pools(): Set<WeakRef<ConversationPool>> {
  return processGlobal(POOLS_KEY, () => new Set<WeakRef<ConversationPool>>());
}

/** Lets every copy's conversation end reach `pool`. The returned function takes it out again (its copy's unload). */
export function shareConversationPool(pool: ConversationPool): () => void {
  const shared = pools();
  // A Gateway that reloads the plugin often but rarely ends a conversation must not grow the set: drop dead entries here too.
  for (const ref of [...shared]) if (!ref.deref()) shared.delete(ref);
  const ref = new WeakRef(pool);
  shared.add(ref);
  return () => void pools().delete(ref);
}

/**
 * Starts closing the idle processes of an ended conversation in the pools of every loaded copy (see
 * `ProcessPool.releaseConversation`) and returns how many. One failing pool does not stop the others.
 */
export function releaseConversationEverywhere(conversation: string): number {
  let released = 0;
  for (const ref of [...pools()]) {
    const pool = ref.deref();
    if (!pool) {
      pools().delete(ref);
      continue;
    }
    try {
      released += pool.releaseConversation(conversation);
    } catch {
      // That copy's idle close still ends its process.
    }
  }
  return released;
}
