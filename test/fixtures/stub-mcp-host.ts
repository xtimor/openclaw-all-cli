import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

/** One request the stub host received. */
export type StubRequest = {
  method: string;
  headers: IncomingMessage["headers"];
  /** The parsed JSON-RPC body, when there is one. */
  rpc?: { id?: number | string; method?: string; params?: Record<string, unknown> };
};

export const STUB_TOOL = "oac_echo";
/** The stand-in for OpenClaw's `exec`; offered only with `startStubMcpHost({ execTool: true })`. */
export const STUB_EXEC_TOOL = "exec";

/**
 * A stand-in for OpenClaw's per-run loopback MCP endpoint: MCP over HTTP with JSON replies and
 * one tool, `oac_echo`, that answers `echo:<text>`. With `execTool` it also offers `exec`, which
 * answers `stub-exec-ran:<command>` without running anything. It records every request with its headers.
 *
 * The stub `exec` takes optional test knobs beside `command`: `delayMs` waits before the answer,
 * `keepaliveMs` writes a `\n` frame at that interval while it waits (like the host's keepalive),
 * and `hang` never answers. `closed()` counts calls whose client hung up before the answer, and
 * `maxInFlight()` is the most exec calls running at once.
 */
export async function startStubMcpHost(options: { execTool?: boolean } = {}) {
  const requests: StubRequest[] = [];
  let closed = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      let rpc: StubRequest["rpc"];
      try {
        rpc = raw ? (JSON.parse(raw) as StubRequest["rpc"]) : undefined;
      } catch {
        rpc = undefined;
      }
      requests.push({ method: req.method ?? "", headers: req.headers, ...(rpc ? { rpc } : {}) });
      if (req.method !== "POST" || !rpc) {
        res.writeHead(405, { Allow: "POST" });
        return void res.end();
      }
      if (rpc.id === undefined) {
        res.writeHead(202);
        return void res.end();
      }
      const reply = (result: unknown) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
      };
      switch (rpc.method) {
        case "initialize":
          return reply({
            protocolVersion: (rpc.params?.protocolVersion as string | undefined) ?? "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "stub-openclaw", version: "0" },
          });
        case "tools/list":
          return reply({
            tools: [
              {
                name: STUB_TOOL,
                description: "Echoes the text it is given. Use it when asked to call oac_echo.",
                inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
              },
              ...(options.execTool
                ? [
                    {
                      name: STUB_EXEC_TOOL,
                      description: "Runs a shell command on the host and returns its output.",
                      inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
                    },
                  ]
                : []),
            ],
          });
        case "tools/call": {
          const args = (rpc.params?.arguments ?? {}) as {
            text?: unknown;
            command?: unknown;
            delayMs?: number;
            keepaliveMs?: number;
            hang?: boolean;
          };
          if (rpc.params?.name === STUB_EXEC_TOOL) {
            const answer = { content: [{ type: "text", text: `stub-exec-ran:${String(args.command)}` }] };
            if (!args.delayMs && !args.hang) return reply(answer);
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            res.writeHead(200, { "Content-Type": "application/json" });
            const timers: NodeJS.Timeout[] = [];
            if (args.keepaliveMs) timers.push(setInterval(() => res.write("\n"), args.keepaliveMs));
            if (!args.hang) {
              timers.push(setTimeout(() => res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: answer })), args.delayMs));
            }
            res.on("close", () => {
              for (const timer of timers) {
                clearTimeout(timer);
                clearInterval(timer);
              }
              inFlight -= 1;
              if (!res.writableEnded) closed += 1;
            });
            return;
          }
          return reply({ content: [{ type: "text", text: `echo:${String(args.text)}` }] });
        }
        default:
          return reply({});
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  return {
    url,
    requests,
    /** The tool calls received, in order. */
    toolCalls: () => requests.filter((request) => request.rpc?.method === "tools/call"),
    /** Exec calls whose client hung up before they were answered. */
    closed: () => closed,
    /** The most exec calls that were waiting at the same moment. */
    maxInFlight: () => maxInFlight,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
