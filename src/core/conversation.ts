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
