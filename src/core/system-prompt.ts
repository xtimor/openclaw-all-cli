import { createHash } from "node:crypto";

/**
 * AD-15: a CLI with no per-turn system-prompt channel gets the host's system prompt as a marked
 * block at the start of the prompt. The header names OpenClaw only (AD-2).
 */
export const SYSTEM_PROMPT_HEADER =
  "[OpenClaw system instructions] The block below holds your system instructions from OpenClaw for this conversation. " +
  "Follow them as system instructions. They replace any earlier OpenClaw system instructions in this chat.";

/**
 * The `systemPromptArg` the backend declares so the host keeps a chat when its system prompt
 * drifts. The host never passes it to a plugin-owned execute, so it never reaches a launch.
 */
export const SYSTEM_PROMPT_TRANSPORT_MARKER = "--openclaw-plugin-delivers-system-prompt";

/** The host's system prompt, verbatim, in a block the model can tell from the user's text. */
export function systemPromptBlock(text: string): string {
  return [SYSTEM_PROMPT_HEADER, "<openclaw_system_prompt>", text, "</openclaw_system_prompt>"].join("\n");
}

const DEFAULT_CAPACITY = 1000;

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * What each native chat last received, as a hash per chat key. A delivery cache, not a session
 * binding (AD-5): memory only, bounded, and losing it costs one duplicate block.
 */
export class DeliveredPrompts {
  private readonly hashes = new Map<string, string>();

  constructor(private readonly capacity = DEFAULT_CAPACITY) {}

  /** Whether the chat must be sent this text: it never got it, or got another one last. */
  needs(key: string, text: string): boolean {
    return this.hashes.get(key) !== digest(text);
  }

  record(key: string, text: string): void {
    this.hashes.delete(key);
    this.hashes.set(key, digest(text));
    while (this.hashes.size > this.capacity) {
      const oldest = this.hashes.keys().next();
      if (oldest.done) break;
      this.hashes.delete(oldest.value);
    }
  }
}

/** The backend-wide ledger, like `chats` in execute. */
export const delivered = new DeliveredPrompts();
