import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A loopback MCP URL that answers every request with an empty tool list, for tests whose turns need a usable OpenClaw
 * target but no tool. The core reads the list itself (`tools/list`), and a no-exec process whose list cannot be read is
 * never reused (#102: it opened in the read-only mode without knowing whether a writer was offered), so a target that
 * refuses connections would make every such process single-use. The server does not keep the test process alive.
 */
export async function startEmptyToolList(): Promise<{ url: string; close: () => void }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}
