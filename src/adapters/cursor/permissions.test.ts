import { describe, expect, it } from "vitest";
import type { AcpPermissionRequest } from "../../transports/acp/session.ts";
import { toCanonicalRequest } from "./permissions.ts";

// The request shapes below were captured from `cursor-agent acp` 2026.10.16.
const OPTIONS = ["allow-once", "allow-always", "reject-once"];

function request(overrides: Partial<AcpPermissionRequest>): AcpPermissionRequest {
  return { toolCallId: "call-1", title: "x", paths: [], content: [], optionIds: OPTIONS, ...overrides };
}

describe("toCanonicalRequest", () => {
  it("names a shell request exec, with the command from the call's raw input", () => {
    expect(
      toCanonicalRequest(
        request({
          kind: "execute",
          title: "`echo hello-probe`",
          rawInput: { command: "echo hello-probe" },
          content: [{ type: "content", content: { type: "text", text: "Not in allowlist: echo" } }],
        }),
      ),
    ).toEqual({
      title: "`echo hello-probe`",
      kind: "execute",
      toolCallId: "call-1",
      toolName: "exec",
      toolInput: { command: "echo hello-probe" },
    });
  });

  it("reads the shell command from the title when the raw input never arrived", () => {
    expect(toCanonicalRequest(request({ kind: "execute", title: "`echo \\`date\\``" }))).toMatchObject({
      toolName: "exec",
      toolInput: { command: "echo `date`" },
    });
  });

  it("names an edit of an existing file edit, with the diff as the replacement", () => {
    expect(
      toCanonicalRequest(
        request({
          kind: "edit",
          title: "Edit `/w/a.txt`",
          content: [{ type: "diff", path: "/w/a.txt", oldText: "old\n", newText: "new\n" }],
        }),
      ),
    ).toMatchObject({
      toolName: "edit",
      toolInput: { path: "/w/a.txt", edits: [{ oldText: "old\n", newText: "new\n" }] },
    });
  });

  it("names the creation of a file write", () => {
    expect(
      toCanonicalRequest(
        request({
          kind: "edit",
          title: "Write /w/new.txt",
          content: [{ type: "diff", path: "/w/new.txt", newText: "hello\n" }],
        }),
      ),
    ).toMatchObject({ toolName: "write", toolInput: { path: "/w/new.txt", content: "hello\n" } });
  });

  it("names a deletion delete", () => {
    expect(toCanonicalRequest(request({ kind: "edit", title: "Delete `/w/a.txt`" }))).toMatchObject({
      toolName: "delete",
      toolInput: { path: "/w/a.txt" },
    });
  });

  it("rejects an edit with no path anywhere rather than guessing", () => {
    expect(toCanonicalRequest(request({ kind: "edit", title: "Edit File" }))).toBeUndefined();
    expect(toCanonicalRequest(request({ kind: "edit", title: "Delete `" }))).toBeUndefined();
  });

  it("falls back to the call's locations for the path", () => {
    expect(toCanonicalRequest(request({ kind: "edit", title: "Edit File", paths: ["/w/b.txt"] }))).toMatchObject({
      toolName: "edit",
      toolInput: { path: "/w/b.txt" },
    });
  });

  it("names a read read", () => {
    expect(toCanonicalRequest(request({ kind: "read", title: "Read `/etc/hosts`" }))).toMatchObject({
      toolName: "read",
      toolInput: { path: "/etc/hosts" },
    });
  });

  it("names a search grep or glob", () => {
    expect(toCanonicalRequest(request({ kind: "search", title: "grep", rawInput: { pattern: "needle" } }))).toMatchObject({
      toolName: "grep",
      toolInput: { pattern: "needle" },
    });
    expect(toCanonicalRequest(request({ kind: "search", title: "Find `*.txt`", rawInput: { pattern: "*.txt" } }))).toMatchObject({
      toolName: "glob",
      toolInput: { pattern: "*.txt" },
    });
  });

  it("names web requests by their call ID", () => {
    expect(
      toCanonicalRequest(request({ kind: "fetch", toolCallId: "web_fetch_q1", title: "https://example.com/a" })),
    ).toMatchObject({ toolName: "web_fetch", toolInput: { url: "https://example.com/a" } });
    expect(
      toCanonicalRequest(request({ kind: "search", toolCallId: "web_search_q2", title: "cursor acp" })),
    ).toMatchObject({ toolName: "web_search", toolInput: { query: "cursor acp" } });
  });

  it("names an MCP request by its server and tool, with the JSON arguments", () => {
    expect(
      toCanonicalRequest(
        request({
          kind: "other",
          title: "files: list_dir",
          content: [{ type: "content", content: { type: "text", text: '```json\n{\n  "path": "/w"\n}\n```' } }],
        }),
      ),
    ).toMatchObject({ toolName: "mcp__files__list_dir", toolInput: { path: "/w" } });
  });

  it("does not name a question prompt, whose allow options are answers", () => {
    expect(
      toCanonicalRequest(
        request({
          kind: "other",
          title: "Which one: a or b",
          optionIds: ["opt-a", "opt-b", "__ask_question_skip__"],
          content: [{ type: "content", content: { type: "text", text: "```json\n{}\n```" } }],
        }),
      ),
    ).toBeUndefined();
  });

  it("does not name what it does not recognize", () => {
    expect(toCanonicalRequest(request({ kind: "other", title: "Unknown operation" }))).toBeUndefined();
    expect(toCanonicalRequest(request({ title: "no kind" }))).toBeUndefined();
    expect(toCanonicalRequest(request({ kind: "execute", title: "no backticks" }))).toBeUndefined();
    expect(
      toCanonicalRequest(
        request({
          kind: "other",
          title: "files: list_dir",
          content: [{ type: "content", content: { type: "text", text: "```json\nnot json\n```" } }],
        }),
      ),
    ).toBeUndefined();
  });
});
