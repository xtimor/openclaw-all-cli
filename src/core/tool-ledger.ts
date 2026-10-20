import { toRecord, type CoreRecord } from "./events.ts";
import type { NormalizedEvent } from "./ports.ts";

/**
 * The turn's native tool calls as the host sees them: one start and at most one result per call.
 * Whatever is still open when the turn closes gets an aborted result, so the host shows nothing
 * pending whatever the adapter did.
 */
export class ToolLedger {
  private readonly calls = new Map<string, { name: string; open: boolean }>();

  /** Whether the event may go to the host. A second start, and a result without an open start, are dropped. */
  admit(event: NormalizedEvent): boolean {
    if (event.kind === "toolStart") {
      if (this.calls.has(event.toolCallId)) return false;
      this.calls.set(event.toolCallId, { name: event.name, open: true });
    } else if (event.kind === "toolResult") {
      const call = this.calls.get(event.toolCallId);
      if (!call?.open) return false;
      call.open = false;
    }
    return true;
  }

  closeOpen(): CoreRecord[] {
    const records: CoreRecord[] = [];
    for (const [toolCallId, call] of this.calls) {
      if (!call.open) continue;
      call.open = false;
      records.push(
        toRecord({ kind: "toolResult", toolCallId, name: call.name, isError: true, result: { aborted: true } }),
      );
    }
    return records;
  }
}
