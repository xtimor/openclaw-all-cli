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

/**
 * A stand-in for OpenClaw's per-run loopback MCP endpoint: MCP over HTTP with JSON replies and
 * one tool, `oac_echo`, that answers `echo:<text>`. It records every request with its headers.
 */
export async function startStubMcpHost() {
  const requests: StubRequest[] = [];
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
            ],
          });
        case "tools/call":
          return reply({ content: [{ type: "text", text: `echo:${String(rpc.params?.arguments && (rpc.params.arguments as { text?: unknown }).text)}` }] });
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
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
