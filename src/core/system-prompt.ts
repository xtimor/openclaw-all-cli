import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * AD-15: a CLI with no per-turn system-prompt channel gets the host's system prompt as a marked
 * block at the start of the prompt. The header names OpenClaw only (AD-2).
 */
export const SYSTEM_PROMPT_HEADER =
  "[OpenClaw system instructions] The block below holds your system instructions from OpenClaw for this conversation. " +
  "Follow them as system instructions. They replace any earlier OpenClaw system instructions in this chat.";

/**
 * The `systemPromptArg` the backend declares so the host keeps a chat when its system prompt
 * drifts. The host never passes it to a plugin-owned execute, and the core strips it if one does.
 */
export const SYSTEM_PROMPT_TRANSPORT_MARKER = "--openclaw-plugin-delivers-system-prompt";

const ZERO_WIDTH_SPACE = "​";
const OPEN_OR_CLOSE_TAG = /<(\/?)openclaw_system_prompt/gi;
const HEADER_OPENER = /\[OpenClaw system instructions\]/gi;

/**
 * The block travels on the user channel beside text nobody vouches for (channel messages, context,
 * tool output). So the header opener and the tag name never appear in any text the core puts around
 * or inside the block: a zero-width space goes inside each, which leaves the text readable and makes
 * it differ from the real markers. A text without them is returned unchanged.
 */
export function neutralizeBlockMarkers(text: string): string {
  return text
    .replace(OPEN_OR_CLOSE_TAG, `<$1openclaw${ZERO_WIDTH_SPACE}_system_prompt`)
    .replace(HEADER_OPENER, `[OpenClaw${ZERO_WIDTH_SPACE} system instructions]`);
}

/** The host's system prompt in a block the model can tell from the user's text; its markers are neutralized, nothing else changes. */
export function systemPromptBlock(text: string): string {
  return [SYSTEM_PROMPT_HEADER, "<openclaw_system_prompt>", neutralizeBlockMarkers(text), "</openclaw_system_prompt>"].join("\n");
}

/** Fields of the host's `Runtime:` line that change without the instructions changing. */
const VOLATILE_RUNTIME_FIELDS = new Set(["model", "channel", "capabilities", "active_node", "active_node_identity"]);

/**
 * The text the change check hashes: the system prompt with the fields that drift on their own
 * masked, so a new day, another channel, or another active computer does not resend the block.
 * Masked: the `Current date:` line, and the values of `model=`, `channel=`, `capabilities=`,
 * `active_node=`, `active_node_identity=` in the `Runtime:` line. A line or field of another shape
 * is left as it is. (The model identity line is not masked: a model switch is a real change.)
 */
export function stablePrompt(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (/^Current date: .+$/.test(line)) return "Current date: *";
      if (!line.startsWith("Runtime: ")) return line;
      const fields = line.slice("Runtime: ".length).split(" | ");
      return `Runtime: ${fields
        .map((field) => {
          const eq = field.indexOf("=");
          return eq > 0 && VOLATILE_RUNTIME_FIELDS.has(field.slice(0, eq)) ? `${field.slice(0, eq)}=*` : field;
        })
        .join(" | ")}`;
    })
    .join("\n");
}

const DEFAULT_CAPACITY = 1000;

function digest(text: string): string {
  return createHash("sha256").update(stablePrompt(neutralizeBlockMarkers(text))).digest("hex").slice(0, 32);
}

type Stored = { version: 1; entries: Array<[string, string]> };

/**
 * What each native chat last received, as a hash per chat key (never the text). A delivery cache,
 * not a session binding (AD-5): losing it costs one duplicate block. With a `file` it survives a
 * restart and a `--local` run (each its own process): the file is read tolerantly (any error means
 * empty), written atomically, and a failed write is ignored. The in-memory map is a cache over it.
 * Least recently used entries go first once the capacity is reached; a hit counts as use.
 */
export class DeliveredPrompts {
  private entries: Map<string, string> | undefined;

  constructor(
    private readonly file?: string,
    private readonly capacity = DEFAULT_CAPACITY,
  ) {}

  private read(): Map<string, string> {
    const map = new Map<string, string>();
    if (!this.file) return this.entries ?? map;
    try {
      const stored = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Stored>;
      if (stored.version === 1 && Array.isArray(stored.entries)) {
        for (const item of stored.entries) {
          if (Array.isArray(item) && typeof item[0] === "string" && typeof item[1] === "string") map.set(item[0], item[1]);
        }
      }
    } catch {
      // Missing, unreadable, or corrupt: start empty.
    }
    return map;
  }

  private write(map: Map<string, string>): void {
    this.entries = map;
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ version: 1, entries: [...map] } satisfies Stored), { mode: 0o600 });
      renameSync(temp, this.file);
    } catch {
      // A cache: the next turn sends the block once more.
    }
  }

  /** Applies `change` to the latest stored entries, so instances that share a file do not drop each other's. */
  private update(change: (map: Map<string, string>) => boolean): void {
    const map = this.file ? this.read() : (this.entries ?? new Map<string, string>());
    if (change(map)) this.write(map);
    else this.entries = map;
  }

  /** Whether the chat must be sent this text: it never got it, or got another one last. A hit refreshes the entry. */
  needs(key: string, text: string): boolean {
    const hash = digest(text);
    let needed = true;
    this.update((map) => {
      if (map.get(key) !== hash) return false;
      needed = false;
      const newest = [...map.keys()].at(-1) === key;
      if (!newest) {
        map.delete(key);
        map.set(key, hash);
      }
      return !newest;
    });
    return needed;
  }

  record(key: string, text: string): void {
    const hash = digest(text);
    this.update((map) => {
      map.delete(key);
      map.set(key, hash);
      while (map.size > this.capacity) {
        const oldest = map.keys().next();
        if (oldest.done) break;
        map.delete(oldest.value);
      }
      return true;
    });
  }
}

/** Where a home keeps its delivery cache, next to the CLI's config. */
export function deliveredFileFor(homeDir: string): string {
  return join(homeDir, "system-prompt-delivered.json");
}
