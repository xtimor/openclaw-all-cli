import { backendIdFor } from "./backend.ts";
import { readBackendConfig } from "./config.ts";
import { withoutKeys } from "./env.ts";
import type { CliAdapter } from "./ports.ts";

/** The ID of the method that reuses the CLI's own login. */
export const LOGIN_METHOD_ID = "login";
/**
 * The ID of the method that keeps an API key in the plugin config. Not `api-key`: OpenClaw gives
 * that ID a quick-entry path that stores the key in its auth store instead (checked against
 * OpenClaw 2026.10.3, `models.authSetApiKey`), and this method must not.
 */
export const API_KEY_METHOD_ID = "api-key-env";

type Env = Record<string, string | undefined>;
type PluginConfig = Record<string, unknown> | undefined;

/** What a method's `run` reads from OpenClaw's auth context. */
type AuthContext = {
  config?: { plugins?: { entries?: Record<string, { config?: Record<string, unknown> } | undefined> } };
  env?: Env;
  signal?: AbortSignal;
  prompter: {
    text(params: {
      message: string;
      placeholder?: string;
      sensitive?: boolean;
      validate?: (value: string) => string | undefined;
    }): Promise<string>;
  };
};

/** The shape of OpenClaw's auth result that these methods use. */
type AuthResult = { profiles: never[]; notes: string[]; configPatch?: Record<string, unknown> };

type AuthMethod = {
  id: string;
  label: string;
  hint: string;
  kind: "custom";
  run(context: AuthContext): Promise<AuthResult>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The key the user typed, or the reason it is not usable. The reason never holds the key. */
function checkKey(value: string): string | undefined {
  const key = value.trim();
  if (!key) return "Enter the key.";
  if (/\s/.test(key)) return "A key has no spaces or line breaks.";
  return undefined;
}

/**
 * The auth methods of one CLI provider, for OpenClaw's provider list and `models auth login`.
 * Neither method stores anything in OpenClaw's auth store, so the native login path
 * (`prepareSyntheticAuth`) stays as it is:
 *
 * - `login` has no fields. It runs the adapter's login probe and reports whether the CLI is
 *   logged in; it throws when it is not, so the caller shows the fix.
 * - `api-key-env` (only for a CLI that has an API key variable) asks for the key and writes it to
 *   the plugin config `env` of the backend, where the CLI process, the probes, and the usage
 *   reader already look for it. The key goes nowhere else and is never logged or echoed.
 */
export function createAuthMethods(adapter: CliAdapter, pluginId: string): AuthMethod[] {
  const backendId = backendIdFor(adapter);
  const settingsOf = (context: AuthContext) => {
    const pluginConfig = context.config?.plugins?.entries?.[pluginId]?.config;
    return readBackendConfig(pluginConfig, backendId, () => {});
  };
  const methods: AuthMethod[] = [
    {
      id: LOGIN_METHOD_ID,
      label: `Use the ${adapter.command} login`,
      hint: `Reuse the login of the local ${adapter.displayName}`,
      kind: "custom",
      async run(context) {
        context.signal?.throwIfAborted();
        const settings = settingsOf(context);
        // The probe counts an API key as a login; this method reports the CLI's own login, so the key is left out.
        const keyVar = adapter.apiKeyEnvVar;
        const probeEnv = { ...withoutKeys(context.env ?? process.env, adapter.clearEnv), ...settings.env };
        const keyed = keyVar !== undefined && Boolean(probeEnv[keyVar]?.trim());
        const env = withoutKeys(probeEnv, keyVar ? [keyVar] : []);
        const status = await adapter.probeAuth({
          command: settings.command ?? adapter.command,
          env,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        context.signal?.throwIfAborted();
        const loginCommand = adapter.loginCommand ?? `${adapter.command} login`;
        if (status === "missing") {
          throw new Error(
            `${adapter.displayName} is not logged in. Run \`${loginCommand}\` on the machine that runs OpenClaw, then connect again.`,
          );
        }
        if (status === "unreadable") {
          throw new Error(
            `Could not tell whether ${adapter.displayName} is logged in (\`${settings.command ?? adapter.command}\` gave no clear answer). Check its login on the machine that runs OpenClaw, or run \`${loginCommand}\` there.`,
          );
        }
        const notes = [`${adapter.displayName} is logged in. OpenClaw uses that login; nothing is stored.`];
        if (keyed) notes.push(`A ${adapter.apiKeyEnvVar} is set too and takes precedence over the login.`);
        return { profiles: [], notes };
      },
    },
  ];
  const keyVar = adapter.apiKeyEnvVar;
  if (keyVar) {
    methods.push({
      id: API_KEY_METHOD_ID,
      label: `${adapter.displayName} API key (${keyVar})`,
      hint: `Keep an API key in the plugin config; only the ${adapter.displayName} process sees it`,
      kind: "custom",
      async run(context) {
        context.signal?.throwIfAborted();
        const entered = await context.prompter.text({
          message: `${adapter.displayName} API key (${keyVar})`,
          sensitive: true,
          validate: checkKey,
        });
        context.signal?.throwIfAborted();
        const problem = checkKey(entered);
        if (problem) throw new Error(problem);
        // Built from the current config, so a patch that replaces a level instead of merging it keeps the rest.
        const entry = context.config?.plugins?.entries?.[pluginId];
        const pluginConfig: PluginConfig = isRecord(entry?.config) ? entry.config : undefined;
        const backendConfig = isRecord(pluginConfig?.[backendId]) ? (pluginConfig[backendId] as Record<string, unknown>) : {};
        const env = isRecord(backendConfig.env) ? backendConfig.env : {};
        return {
          profiles: [],
          notes: [
            `The key is saved in the plugin config (plugins.entries.${pluginId}.config.${backendId}.env.${keyVar}) and given to the ${adapter.displayName} process only.`,
          ],
          configPatch: {
            plugins: {
              entries: {
                [pluginId]: {
                  ...entry,
                  config: { ...pluginConfig, [backendId]: { ...backendConfig, env: { ...env, [keyVar]: entered.trim() } } },
                },
              },
            },
          },
        };
      },
    });
  }
  return methods;
}

/**
 * The provider OpenClaw's login flows read (`registerProvider`). It carries only the auth
 * methods: the catalog and the native-login auth stay with the provider-catalog entry.
 */
export function createAuthProvider(adapter: CliAdapter, pluginId: string) {
  return {
    id: backendIdFor(adapter),
    label: adapter.providerLabel ?? adapter.displayName,
    docsPath: "/providers/models",
    auth: createAuthMethods(adapter, pluginId),
  };
}
