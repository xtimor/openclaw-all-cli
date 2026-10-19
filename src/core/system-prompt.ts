import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

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

const ZERO_WIDTH_SPACE = "\u200b";
const ZERO_WIDTH = "\\u200b-\\u200d\\u2060\\ufeff";
const HAS_ZERO_WIDTH = new RegExp(`[${ZERO_WIDTH}]`);
/** A word with a zero-width character allowed between any two letters. */
const spaced = (word: string) => [...word].join(`[${ZERO_WIDTH}]*`);
/** Between words: spaces, newlines, `_`, `-`, or zero-width characters. */
const SEP = `[\\s_\\-${ZERO_WIDTH}]+`;
const GAP = `[\\s${ZERO_WIDTH}]*`;
const OPENCLAW = spaced("openclaw");
/** The block's tag in any spelling a model would read as it: `<`, `</`, fullwidth brackets, any case, spaces, `-`, `_`, zero-width characters. */
const MARKER_SPELLINGS = new RegExp(
  [
    `[<\uff1c]${GAP}[/\uff0f]?${GAP}${OPENCLAW}${SEP}${spaced("system")}${SEP}${spaced("prompt")}`,
    // The header opener, and the runtime update note's: `[OpenClaw system instructions]`, `[OpenClaw runtime update]`.
    `[\\[\uff3b]${GAP}${OPENCLAW}${SEP}(?:${spaced("system")}${SEP}${spaced("instructions")}|${spaced("runtime")}${SEP}${spaced("update")})${GAP}[\\]\uff3d]`,
  ].join("|"),
  "gi",
);

/**
 * The block travels on the user channel beside text nobody vouches for (channel messages, context,
 * tool output). So no text the core puts around or inside the block holds the block's tag, the
 * header opener, or the update note's opener in any spelling above. Each match keeps its own
 * characters and case and gets one zero-width space after its first character; a match that already
 * holds a zero-width character is left as it is (the real markers hold none). The result is
 * idempotent, and a text without the markers is returned unchanged.
 */
export function neutralizeBlockMarkers(text: string): string {
  return text.replace(MARKER_SPELLINGS, (match) => (HAS_ZERO_WIDTH.test(match) ? match : `${match[0]}${ZERO_WIDTH_SPACE}${match.slice(1)}`));
}

/** The host's system prompt in a block the model can tell from the user's text; the markers in the text are neutralized, nothing else changes. */
export function systemPromptBlock(text: string): string {
  return [SYSTEM_PROMPT_HEADER, "<openclaw_system_prompt>", neutralizeBlockMarkers(text), "</openclaw_system_prompt>"].join("\n");
}

/** Fields of the host's `Runtime:` line that change without the instructions changing. */
const VOLATILE_RUNTIME_FIELDS = new Set(["model", "channel", "capabilities", "active_node", "active_node_identity"]);

const DATE_LINE = /^Current date: (.+)$/;

/** The runtime fields of a `Runtime:` line, as `[key, value]` pairs in order; other fields are `[field, undefined]`. */
function runtimeFields(line: string): Array<[string, string | undefined]> {
  return line
    .slice("Runtime: ".length)
    .split(" | ")
    .map((field) => {
      const eq = field.indexOf("=");
      return eq > 0 && VOLATILE_RUNTIME_FIELDS.has(field.slice(0, eq)) ? [field.slice(0, eq), field.slice(eq + 1)] : [field, undefined];
    });
}

/**
 * The text the change check hashes: the system prompt with the fields that drift on their own
 * masked. Masked: the `Current date:` line, and the values of `model=`, `channel=`, `capabilities=`,
 * `active_node=`, `active_node_identity=` in the `Runtime:` line. A line or field of another shape
 * is left as it is. (The model identity line is not masked: a model switch is a real change.)
 */
export function stablePrompt(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (DATE_LINE.test(line)) return "Current date: *";
      if (!line.startsWith("Runtime: ")) return line;
      return `Runtime: ${runtimeFields(line)
        .map(([field, value]) => (value === undefined ? field : `${field}=*`))
        .join(" | ")}`;
    })
    .join("\n");
}

/** The masked fields with their current values, as `Current date: ...` and `key=value` items, in prompt order. */
export function volatileFields(text: string): string[] {
  const items: string[] = [];
  for (const line of text.split("\n")) {
    const date = DATE_LINE.exec(line);
    if (date) items.push(`Current date: ${date[1]}`);
    else if (line.startsWith("Runtime: ")) {
      for (const [field, value] of runtimeFields(line)) if (value !== undefined) items.push(`${field}=${value}`);
    }
  }
  return items;
}

/**
 * A short update for a chat whose instructions did not change but whose date, model, channel,
 * capabilities, or active computer did: the current values, in the block's place.
 */
export function runtimeUpdateNote(text: string): string {
  return `[OpenClaw runtime update] These values replace the earlier ones in your OpenClaw system instructions: ${neutralizeBlockMarkers(volatileFields(text).join(" | "))}`;
}

const DEFAULT_CAPACITY = 1000;
/** A temp file older than this is left from a crashed write. */
const STALE_TEMP_MS = 10 * 60_000;

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

/** What a chat last received: the hash of the masked prompt, and of its masked fields' values. */
type Delivery = { full: string; volatile: string };
type Stored = { version: 2; entries: Array<[string, string, string]> };

/** What to send a chat: the full block, a one-line runtime update, or nothing. */
export type Delivering = "block" | "note" | "none";
const SEVERITY: Record<Delivering, number> = { none: 0, note: 1, block: 2 };

/**
 * What each native chat last received, as hashes (never the text). A delivery cache, not a session
 * binding (AD-5): losing it costs one duplicate block. With a `file` it survives a restart and a
 * `--local` run (each its own process): the file is read tolerantly (any error means empty) and
 * written atomically, and a write that fails is kept in memory for this process instead. Each change
 * is merged into the file's latest content per chat right before the write, so two processes on one
 * home lose each other's chats only inside that read-to-rename window (last writer wins per chat).
 * Least recently used chats go first at the capacity; a hit counts as use.
 */
export class DeliveredPrompts {
  /** Changes that could not be written, newest last; they overlay the file until a write succeeds. */
  private readonly unsaved = new Map<string, Delivery>();

  constructor(
    private readonly file?: string,
    private readonly capacity = DEFAULT_CAPACITY,
  ) {}

  private load(): Map<string, Delivery> {
    const map = new Map<string, Delivery>();
    if (this.file) {
      try {
        const stored = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Stored>;
        if (stored.version === 2 && Array.isArray(stored.entries)) {
          for (const item of stored.entries) {
            if (Array.isArray(item) && item.every((part) => typeof part === "string") && item.length === 3) {
              map.set(item[0]!, { full: item[1]!, volatile: item[2]! });
            }
          }
        }
      } catch {
        // Missing, unreadable, or corrupt: start empty.
      }
    }
    for (const [key, value] of this.unsaved) {
      map.delete(key);
      map.set(key, value);
    }
    return map;
  }

  private save(map: Map<string, Delivery>, changed: string[]): void {
    for (const key of changed) {
      this.unsaved.delete(key);
      this.unsaved.set(key, map.get(key)!);
    }
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ version: 2, entries: [...map].map(([key, d]) => [key, d.full, d.volatile]) } satisfies Stored), { mode: 0o600 });
      renameSync(temp, this.file);
      this.unsaved.clear();
    } catch {
      // A cache: the change stays in memory, and a failed write never fails a turn.
    }
    this.removeStaleTemps();
  }

  private removeStaleTemps(): void {
    if (!this.file) return;
    try {
      const prefix = `${basename(this.file)}.`;
      for (const name of readdirSync(dirname(this.file))) {
        if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
        const path = join(dirname(this.file), name);
        try {
          if (Date.now() - statSync(path).mtimeMs > STALE_TEMP_MS) unlinkSync(path);
        } catch {
          // Another process may have just renamed it.
        }
      }
    } catch {
      // No directory to clean.
    }
  }

  private static deliveryOf(text: string): Delivery {
    return { full: digest(stablePrompt(neutralizeBlockMarkers(text))), volatile: digest(volatileFields(text).join("\n")) };
  }

  /**
   * What the chats (one chat, or the id a turn resumed and the id it ended on) need for this text: the
   * lightest need among them, since any one of them having it means the chat has it. A hit refreshes.
   */
  decide(keys: string[], text: string): Delivering {
    const now = DeliveredPrompts.deliveryOf(text);
    const map = this.load();
    let result: Delivering = "block";
    let hit: string | undefined;
    for (const key of keys) {
      const have = map.get(key);
      const need: Delivering = !have || have.full !== now.full ? "block" : have.volatile !== now.volatile ? "note" : "none";
      if (SEVERITY[need] < SEVERITY[result]) result = need;
      if (need === "none") hit = key;
    }
    if (hit && [...map.keys()].at(-1) !== hit) {
      const value = map.get(hit)!;
      map.delete(hit);
      map.set(hit, value);
      this.save(map, [hit]);
    }
    return result;
  }

  record(key: string, text: string): void {
    const map = this.load();
    map.delete(key);
    map.set(key, DeliveredPrompts.deliveryOf(text));
    const changed = [key];
    while (map.size > this.capacity) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
      this.unsaved.delete(oldest.value);
    }
    this.save(map, changed);
  }
}

/** Where a home keeps its delivery cache, next to the CLI's config. */
export function deliveredFileFor(homeDir: string): string {
  return join(homeDir, "system-prompt-delivered.json");
}
