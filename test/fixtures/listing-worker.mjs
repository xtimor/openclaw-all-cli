// A worker thread that runs a model listing through the plugin's catalog, the way OpenClaw runs the provider
// catalog in a worker. The listing hangs until aborted, then takes `exitMs` to "exit". `workerData.flags`
// is a shared Int32Array: [0] = the listing started, [1] = it was aborted, [2] = its process has exited.
import { parentPort, workerData } from "node:worker_threads";
import { createModelCatalog } from "../../src/core/catalog.ts";

const flags = new Int32Array(workerData.flags);
const adapter = {
  id: "acme",
  displayName: "Acme",
  command: "acme",
  launchArgs: [],
  defaultModel: "acme-cli/auto",
  manifest: { rows: {} },
  alwaysOnNativeTools: [],
  clearEnv: [],
  listModels: (params) =>
    new Promise((_resolve, reject) => {
      // A real listing has a child process whose pipes keep the thread alive; this timer stands in for them.
      const keepAlive = setInterval(() => {}, 1000);
      Atomics.store(flags, 0, 1);
      params.signal.addEventListener("abort", () => {
        Atomics.store(flags, 1, 1);
        setTimeout(() => {
          Atomics.store(flags, 2, 1);
          clearInterval(keepAlive);
          reject(params.signal.reason);
        }, workerData.exitMs);
      });
    }),
};
const catalog = createModelCatalog(adapter, { warn: () => {} });
const rows = await catalog.list({ command: "acme", env: {}, lockDir: workerData.lockDir });
parentPort.postMessage({ rows });
