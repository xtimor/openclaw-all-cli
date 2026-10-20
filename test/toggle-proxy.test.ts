import { once } from "node:events";
import { createServer, connect, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startToggleProxy, type ToggleProxy } from "./live/harness.ts";

// The live error row (test/live/errors.live.test.ts) trusts this proxy; check it without a login.
describe("toggleable CONNECT proxy", () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) await step();
  });

  async function setup(): Promise<{ proxy: ToggleProxy; port: number }> {
    const sockets = new Set<Socket>();
    const echo = createServer((socket: Socket) => {
      sockets.add(socket);
      socket.pipe(socket);
    });
    echo.listen(0, "127.0.0.1");
    await once(echo, "listening");
    cleanup.push(
      () => {
        for (const socket of sockets) socket.destroy();
      },
      () => new Promise<void>((resolve) => echo.close(() => resolve())),
    );
    // The proxy reads the environment's own proxy when it starts; none, so it connects direct.
    const saved = { upper: process.env.HTTPS_PROXY, lower: process.env.https_proxy };
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    const proxy = await startToggleProxy(/^127\.0\.0\.1$/);
    for (const [key, value] of [["HTTPS_PROXY", saved.upper], ["https_proxy", saved.lower]] as const) {
      if (value !== undefined) process.env[key] = value;
    }
    cleanup.push(() => proxy.close());
    const address = echo.address();
    return { proxy, port: typeof address === "object" && address ? address.port : 0 };
  }

  /** Sends CONNECT and returns the status line, plus what an echo through the tunnel gave back. */
  async function viaProxy(proxy: ToggleProxy, port: number): Promise<{ status: string; echoed: string }> {
    const url = new URL(proxy.url);
    const socket = connect(Number(url.port), url.hostname);
    cleanup.push(() => void socket.destroy());
    socket.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
    let received = "";
    socket.on("data", (chunk) => (received += chunk.toString("utf8")));
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (received.includes("\r\n\r\n")) {
          clearInterval(check);
          resolve();
        }
      }, 10);
    });
    const status = received.split("\r\n")[0]!;
    let echoed = "";
    if (status.includes(" 200 ")) {
      socket.write("ping");
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (received.endsWith("ping")) {
            clearInterval(check);
            resolve();
          }
        }, 10);
      });
      echoed = "ping";
    }
    return { status, echoed };
  }

  it("tunnels while allowed, refuses with 403 once blocked, and tunnels again after allow()", async () => {
    const { proxy, port } = await setup();
    expect(await viaProxy(proxy, port)).toEqual({ status: "HTTP/1.1 200 Connection Established", echoed: "ping" });
    proxy.block();
    expect((await viaProxy(proxy, port)).status).toBe("HTTP/1.1 403 Forbidden");
    proxy.allow();
    expect((await viaProxy(proxy, port)).echoed).toBe("ping");
    expect(proxy.seen.map((entry) => entry.blocked)).toEqual([false, true, false]);
  });
});
