import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

/** Types derived from the OpenClaw SDK, so the core never reaches into its internals. */
export type CliBackendPlugin = Parameters<OpenClawPluginApi["registerCliBackend"]>[0];
export type PrepareExecutionContext = Parameters<NonNullable<CliBackendPlugin["prepareExecution"]>>[0];
type PreparedExecution = NonNullable<Awaited<ReturnType<NonNullable<CliBackendPlugin["prepareExecution"]>>>>;
export type CliBackendExecute = NonNullable<PreparedExecution["execute"]>;
export type ExecuteContext = Parameters<CliBackendExecute>[0];
export type LiveSessionCapability = NonNullable<ExecuteContext["liveSession"]>;
export type LiveSessionHandle = NonNullable<ReturnType<LiveSessionCapability["current"]>>;
export type { OpenClawPluginApi };
