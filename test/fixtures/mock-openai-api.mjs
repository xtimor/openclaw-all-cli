#!/usr/bin/env node
// A local OpenAI-compatible API stand-in for live tests that need an API model beside `cursor-cli`.
//
//   node mock-openai-api.mjs <request-log-file> [port]
//
// Serves `GET /v1/models` and `POST /v1/chat/completions` (plain or streamed) with one fixed reply,
// and appends each request body to the log file as one JSON line. Prints `listening <port>` on stdout.
// Reply text: `mock-reply`, or the value of MOCK_API_REPLY.
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const [logFile, portArg] = process.argv.slice(2);
if (!logFile) {
  console.error("usage: mock-openai-api.mjs <request-log-file> [port]");
  process.exit(2);
}
writeFileSync(logFile, "", { flag: "a" });
const REPLY = process.env.MOCK_API_REPLY ?? "mock-reply";

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const url = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ object: "list", data: [{ id: "echo", object: "model", owned_by: "mock" }] }));
      return;
    }
    if (req.method === "POST" && url === "/v1/chat/completions") {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        // Log the request anyway.
      }
      appendFileSync(logFile, `${JSON.stringify(body)}\n`);
      const base = { id: "chatcmpl-mock", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model ?? "echo" };
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: REPLY }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          ...base,
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: REPLY }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
});

server.listen(Number(portArg ?? 0), "127.0.0.1", () => {
  console.log(`listening ${server.address().port}`);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
