import { join } from "node:path";
import { backendIdFor } from "./backend.ts";
import { readBackendConfig, type BackendConfig } from "./config.ts";
import { withoutKeys } from "./env.ts";
import {
  diskNeed,
  formatBytes,
  hostFacts,
  hostSupport,
  installManaged,
  isInside,
  ManagedInstallError,
  managedRoot,
  readManaged,
  removeManaged,
  type HostFacts,
  type InstallProgress,
} from "./managed-install.ts";
import { CliError, type CliAdapter } from "./ports.ts";

/** The ID of the method that reuses the CLI's own login. */
export const LOGIN_METHOD_ID = "login";
/**
 * The ID of the method that keeps an API key in the plugin config. Not `api-key`: OpenClaw gives
 * that ID a quick-entry path that stores the key in its auth store instead (checked against
 * OpenClaw 2026.10.3, `models.authSetApiKey`), and this method must not.
 */
export const API_KEY_METHOD_ID = "api-key-env";
/** The ID of the method that removes the saved key and the managed CLI, each after a yes. */
export const REMOVE_METHOD_ID = "remove";

/** The plugin's setup guide: the manual install, and the full key removal steps. */
const SETUP_DOCS = "https://github.com/xtimor/openclaw-all-cli/blob/main/docs/setup.md";
const MANUAL_INSTALL_DOCS = `${SETUP_DOCS}#install-the-requirements`;
const REMOVAL_DOCS = `${SETUP_DOCS}#remove-the-key-and-the-managed-cli`;

type Env = Record<string, string | undefined>;
type PluginConfig = Record<string, unknown> | undefined;

/** What a method's `run` reads from OpenClaw's auth context. */
type AuthContext = {
  config?: { plugins?: { entries?: Record<string, { config?: Record<string, unknown> } | undefined> } };
  env?: Env;
  signal?: AbortSignal;
  /** Rechecks the caller's authority; called right before a download or a removal. */
  assertCurrent?: () => void;
  prompter: {
    text(params: {
      message: string;
      placeholder?: string;
      sensitive?: boolean;
      validate?: (value: string) => string | undefined;
    }): Promise<string>;
    /** Absent (or failing) means the run cannot ask for a yes, so nothing is installed or removed. */
    confirm?(params: { message: string; initialValue?: boolean }): Promise<boolean>;
    progress?(label: string): { update(message: string): void; stop(message?: string): void };
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

/** What the remove method needs of a backend's process pool. */
export type PoolControl = { readonly turns: number; readonly queued: number; closeIdle(): number };

/** What the methods take from the plugin besides the adapter. */
export type AuthDeps = {
  /** OpenClaw's state directory; managed installs live under `<stateDir>/tools/`. Absent: no install is offered. */
  stateDir?: () => string;
  /** Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** The live process pool of a backend, when this module instance has one. */
  pools?: (backendId: string) => PoolControl | undefined;
  /** Host facts (tests). Default: the running host's. */
  host?: (env: Env) => HostFacts;
  /** Free disk bytes for a folder (tests). */
  freeBytes?: (dir: string) => Promise<number>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The key the user typed, or the reason it is not usable. The reason never holds the key. */
function checkKeyText(value: string): string | undefined {
  const key = value.trim();
  if (!key) return "Enter the key.";
  if (/\s/.test(key)) return "A key has no spaces or line breaks.";
  return undefined;
}

const quoted = (command: string) => (/\s/.test(command) ? `"${command}"` : command);

/** The CLI as the methods found it: it runs, or it is missing or too old. */
type CliState =
  | { kind: "present"; command: string; warning?: string }
  | { kind: "absent"; command: string; detail: string };

/**
 * The auth methods of one CLI provider, for OpenClaw's provider list and `models auth login`.
 * None stores anything in OpenClaw's auth store, so the native login path (`prepareSyntheticAuth`)
 * stays as it is:
 *
 * - `login` has no fields. It runs the adapter's login probe and reports whether the CLI is
 *   logged in; it throws when it is not, so the caller shows the fix.
 * - `api-key-env` (only for a CLI that has an API key variable) asks for the key, checks it with
 *   the CLI when the adapter can, and writes it to the plugin config `env` of the backend, where
 *   the CLI process, the probes, and the usage reader already look for it. The key goes nowhere
 *   else and is never logged or echoed.
 * - `remove` asks, separately, whether to remove the saved key and the CLI the plugin installed.
 *
 * When the CLI is missing or too old, `login` and `api-key-env` offer the adapter's pinned
 * managed install (AD-17), and only install after a yes.
 */
export function createAuthMethods(adapter: CliAdapter, pluginId: string, deps: AuthDeps = {}): AuthMethod[] {
  const backendId = backendIdFor(adapter);
  const keyVar = adapter.apiKeyEnvVar;
  const spec = adapter.managedInstall;
  const settingsOf = (context: AuthContext): BackendConfig => {
    const pluginConfig = context.config?.plugins?.entries?.[pluginId]?.config;
    return readBackendConfig(pluginConfig, backendId, () => {});
  };
  /** The env every probe runs with: the Gateway's without the cleared keys, plus the plugin config's. */
  const probeEnvOf = (context: AuthContext, settings: BackendConfig): Env => ({
    ...withoutKeys(context.env ?? process.env, adapter.clearEnv),
    ...settings.env,
  });
  const rootOf = (): string | undefined => {
    if (!deps.stateDir) return undefined;
    try {
      return managedRoot(deps.stateDir(), adapter.command);
    } catch {
      return undefined;
    }
  };

  /**
   * A patch of the backend's config, built from the current config, so a patch that replaces a
   * level instead of merging it keeps the rest. A value `undefined` removes that key (OpenClaw's
   * config patch merge deletes it).
   */
  const backendPatch = (context: AuthContext, change: (backend: Record<string, unknown>) => Record<string, unknown>) => {
    const entry = context.config?.plugins?.entries?.[pluginId];
    const pluginConfig: PluginConfig = isRecord(entry?.config) ? entry.config : undefined;
    const backendConfig = isRecord(pluginConfig?.[backendId]) ? (pluginConfig[backendId] as Record<string, unknown>) : {};
    return {
      plugins: { entries: { [pluginId]: { ...entry, config: { ...pluginConfig, [backendId]: change(backendConfig) } } } },
    };
  };
  const envOfBackend = (backend: Record<string, unknown>) => (isRecord(backend.env) ? backend.env : {});

  /** Runs the CLI's version check (AD-14): a missing binary or a build below the floor counts as absent. */
  const detectCli = async (context: AuthContext, settings: BackendConfig): Promise<CliState> => {
    const command = settings.command ?? adapter.command;
    const env = withoutKeys(probeEnvOf(context, settings), keyVar ? [keyVar] : []);
    try {
      const checked = await adapter.checkVersion({ command, env, ...(context.signal ? { signal: context.signal } : {}) });
      // A warning (the CLI did not run, or its version is unreadable) keeps it counted as there, unchecked.
      return checked === "ok" ? { kind: "present", command } : { kind: "present", command, warning: checked.warning };
    } catch (error) {
      context.signal?.throwIfAborted();
      if (error instanceof CliError && error.code === "cli_not_found") {
        return { kind: "absent", command, detail: `\`${command}\` was not found` };
      }
      if (error instanceof CliError && error.code === "unsupported_version") {
        return { kind: "absent", command, detail: `\`${command}\` is older than ${adapter.manifest.minVersion}, the oldest build the plugin supports` };
      }
      // Anything else (an unreadable version) keeps today's behavior: the CLI counts as there.
      return { kind: "present", command };
    }
  };

  type Offer = { installed: true; command: string; notes: string[] } | { installed: false; notes: string[] };

  /**
   * Offers the pinned install for an absent CLI and runs it after a yes. Declined, unsupported, or
   * unaskable: nothing is downloaded or written, and the notes name why and link the manual install.
   * A failed install throws, naming the cause and the manual path; the config is not changed.
   */
  const offerInstall = async (context: AuthContext, settings: BackendConfig, state: CliState & { kind: "absent" }, methodId: string): Promise<Offer> => {
    const docs = spec?.docsUrl ?? MANUAL_INSTALL_DOCS;
    const manual = (why: string) => ({
      installed: false as const,
      notes: [`${adapter.displayName} is not ready: ${state.detail}. ${why} Install it by hand: ${docs}`],
    });
    if (!spec) return manual("The plugin has no install for it.");
    const env = context.env ?? process.env;
    const support = hostSupport(spec, (deps.host ?? hostFacts)(env));
    if ("reason" in support) return manual(`The plugin cannot install it here: ${support.reason}.`);
    const root = rootOf();
    if (!root) return manual("The plugin cannot install it here: the OpenClaw state directory is not known.");
    if (typeof context.prompter.confirm !== "function") {
      return manual("This run cannot ask for a yes, so nothing was downloaded.");
    }
    const pkg = spec.platforms[support.platform]!;
    const target = join(root, spec.version);
    const message = [
      `${adapter.displayName} is not ready: ${state.detail}.`,
      `Install ${adapter.displayName} ${spec.version} for the plugin now?`,
      `- From: ${new URL(spec.origin).host} (${formatBytes(pkg.bytes)} download, checked against the sha256 pinned in the plugin)`,
      `- Disk space needed: ${formatBytes(diskNeed(pkg))}`,
      `- Into: ${target} (${backendId}.command will point there; PATH, shell profiles, and any other ${adapter.command} stay as they are)`,
      `If this dialog times out during the download, run \`openclaw models auth login --provider ${backendId} --method ${methodId}\` in a terminal on the Gateway host instead.`,
    ].join("\n");
    let yes = false;
    try {
      yes = await context.prompter.confirm({ message, initialValue: false });
    } catch {
      yes = false;
    }
    context.signal?.throwIfAborted();
    if (!yes) return manual("Nothing was downloaded.");
    context.assertCurrent?.();
    const progress = context.prompter.progress?.(`Installing ${adapter.displayName} ${spec.version}`);
    const report = (step: InstallProgress) => {
      if (!progress) return;
      if (step.phase === "download") progress.update(`Downloading ${formatBytes(step.done)} of ${formatBytes(step.total)}`);
      else if (step.phase === "unpack") progress.update("Unpacking");
      else progress.update(`Checking that ${adapter.command} runs`);
    };
    try {
      const result = await installManaged({
        spec,
        platform: support.platform,
        root,
        fetch: deps.fetch ?? globalThis.fetch,
        onProgress: report,
        env: withoutKeys(probeEnvOf(context, settings), keyVar ? [keyVar] : []),
        ...(deps.freeBytes ? { freeBytes: deps.freeBytes } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      });
      progress?.stop(`Installed ${adapter.displayName} ${spec.version}`);
      const notes = [`Installed ${adapter.displayName} ${spec.version} into ${result.dir}; ${backendId}.command now points at ${result.launcher}.`];
      if (result.removed.length > 0) notes.push(`Removed the older installs of the plugin: ${result.removed.join(", ")}.`);
      return { installed: true, command: result.launcher, notes };
    } catch (error) {
      progress?.stop("Install stopped");
      context.signal?.throwIfAborted();
      const cause = error instanceof ManagedInstallError ? error.message : `Unexpected error (${(error as Error).message}).`;
      throw new Error(
        `Could not install ${adapter.displayName} ${spec.version}: ${cause} Nothing was changed: no config was written, and an earlier install is as it was. Install it by hand: ${docs}`,
        { cause: error },
      );
    }
  };

  const commandPatch = (context: AuthContext, command: string) => backendPatch(context, (backend) => ({ ...backend, command }));

  const methods: AuthMethod[] = [
    {
      id: LOGIN_METHOD_ID,
      label: `Use the ${adapter.command} login`,
      hint: `Reuse the login of the local ${adapter.displayName}`,
      kind: "custom",
      async run(context) {
        context.signal?.throwIfAborted();
        const settings = settingsOf(context);
        let command = settings.command ?? adapter.command;
        let installNotes: string[] = [];
        let configPatch: Record<string, unknown> | undefined;
        const state = await detectCli(context, settings);
        if (state.kind === "absent") {
          const offer = await offerInstall(context, settings, state, LOGIN_METHOD_ID);
          if (!offer.installed) throw new Error(offer.notes.join(" "));
          command = offer.command;
          installNotes = offer.notes;
          configPatch = commandPatch(context, command);
        }
        // The probe counts an API key as a login; this method reports the CLI's own login, so the key is left out.
        const probeEnv = probeEnvOf(context, settings);
        const keyed = keyVar !== undefined && Boolean(probeEnv[keyVar]?.trim());
        const env = withoutKeys(probeEnv, keyVar ? [keyVar] : []);
        const status = await adapter.probeAuth({ command, env, ...(context.signal ? { signal: context.signal } : {}) });
        context.signal?.throwIfAborted();
        const defaultLogin = adapter.loginCommand ?? `${adapter.command} login`;
        // A managed CLI is not on PATH: the fix names its absolute launcher.
        const root = rootOf();
        const loginCommand =
          root && isInside(root, command) && defaultLogin.startsWith(`${adapter.command} `)
            ? `${quoted(command)}${defaultLogin.slice(adapter.command.length)}`
            : defaultLogin;
        let problem: string | undefined;
        if (status === "missing") {
          problem = `${adapter.displayName} is not logged in. Run \`${loginCommand}\` on the machine that runs OpenClaw, then connect again.`;
        } else if (status === "unreadable") {
          problem = `Could not tell whether ${adapter.displayName} is logged in (\`${command}\` gave no clear answer). Check its login on the machine that runs OpenClaw, or run \`${loginCommand}\` there.`;
        }
        if (problem) {
          // A CLI installed in this run is kept: the patch still points the config at it.
          if (configPatch) return { profiles: [], notes: [...installNotes, problem], configPatch };
          throw new Error(problem);
        }
        const notes = [...installNotes, `${adapter.displayName} is logged in. OpenClaw uses that login; nothing is stored.`];
        if (keyed) notes.push(`A ${adapter.apiKeyEnvVar} is set too and takes precedence over the login.`);
        return { profiles: [], notes, ...(configPatch ? { configPatch } : {}) };
      },
    },
  ];
  if (keyVar) {
    methods.push({
      id: API_KEY_METHOD_ID,
      label: `${adapter.displayName} API key (${keyVar})`,
      hint: `Keep an API key in the plugin config; only the ${adapter.displayName} process sees it`,
      kind: "custom",
      async run(context) {
        context.signal?.throwIfAborted();
        const settings = settingsOf(context);
        const state = await detectCli(context, settings);
        let command = state.command;
        // A CLI whose version check only warned may not run at all: its key is saved unchecked.
        const warning = state.kind === "present" ? state.warning : undefined;
        let ready = state.kind === "present" && warning === undefined;
        let installed = false;
        let installNotes: string[] = [];
        if (state.kind === "absent") {
          const offer = await offerInstall(context, settings, state, API_KEY_METHOD_ID);
          installNotes = offer.notes;
          if (offer.installed) {
            command = offer.command;
            ready = true;
            installed = true;
          }
        }
        const entered = await context.prompter.text({
          message: `${adapter.displayName} API key (${keyVar})`,
          sensitive: true,
          validate: checkKeyText,
        });
        context.signal?.throwIfAborted();
        const problem = checkKeyText(entered);
        if (problem) throw new Error(problem);
        const key = entered.trim();
        const withCommand = (backend: Record<string, unknown>) => (installed ? { ...backend, command } : backend);
        const notes = [...installNotes];
        if (ready && adapter.checkKey) {
          // The key reaches the CLI through its env only, never an argument.
          const env = { ...probeEnvOf(context, settings), [keyVar]: key };
          const check = async () => {
            try {
              return await adapter.checkKey!({ command, env, ...(context.signal ? { signal: context.signal } : {}) });
            } catch {
              return "unknown" as const;
            }
          };
          let verdict = await check();
          context.signal?.throwIfAborted();
          // A first run right after an install can answer neither way: one more try.
          if (verdict === "unknown") verdict = await check();
          context.signal?.throwIfAborted();
          const refusal =
            verdict === "invalid"
              ? `${adapter.displayName} says the key is invalid. It was not saved; check it and connect again.`
              : verdict === "unknown"
                ? `The key could not be checked: ${adapter.displayName} did not confirm it, asked twice. It may be invalid, or ${adapter.displayName} could not reach its service. It was not saved; check the key and the network, then connect again.`
                : undefined;
          if (refusal) {
            // A CLI installed in this run is kept: the patch still points the config at it.
            if (installed) return { profiles: [], notes: [...notes, refusal], configPatch: backendPatch(context, withCommand) };
            throw new Error(refusal);
          }
          notes.push(`${adapter.displayName} accepted the key.`);
        } else if (warning !== undefined) {
          notes.push(`${warning} The key was saved without a check.`);
        } else if (!ready) {
          notes.push(`No working ${adapter.displayName} was found, so the key was saved without a check.`);
        }
        notes.push(
          `The key is saved in the plugin config (plugins.entries.${pluginId}.config.${backendId}.env.${keyVar}) and given to the ${adapter.displayName} process only.`,
        );
        return {
          profiles: [],
          notes,
          configPatch: backendPatch(context, (backend) => withCommand({ ...backend, env: { ...envOfBackend(backend), [keyVar]: key } })),
        };
      },
    });
  }
  if (keyVar || spec) {
    methods.push({
      id: REMOVE_METHOD_ID,
      label: `Remove the saved key or the installed ${adapter.displayName}`,
      hint: `Asks before it removes the key in the plugin config and the ${adapter.displayName} the plugin installed`,
      kind: "custom",
      async run(context) {
        context.signal?.throwIfAborted();
        const settings = settingsOf(context);
        const hasKey = keyVar !== undefined && settings.env?.[keyVar] !== undefined;
        const root = spec ? rootOf() : undefined;
        const managed = root ? await readManaged(root) : undefined;
        if (!hasKey && !managed?.present) {
          const what = keyVar ? `no ${keyVar} is saved in the plugin config` : "no key is saved";
          return { profiles: [], notes: [`Nothing to remove: ${what}, and the plugin has not installed ${adapter.displayName}.`] };
        }
        const confirm = context.prompter.confirm;
        if (typeof confirm !== "function") {
          throw new Error(
            `This run cannot ask for a yes, so nothing was removed. Run \`openclaw models auth login --provider ${backendId} --method ${REMOVE_METHOD_ID}\` in a terminal on the Gateway host.`,
          );
        }
        const ask = async (message: string) => {
          try {
            return await confirm.call(context.prompter, { message, initialValue: false });
          } catch {
            return false;
          } finally {
            context.signal?.throwIfAborted();
          }
        };
        const notes: string[] = [];
        let removeKey = false;
        let unsetCommand = false;
        if (hasKey) {
          removeKey = await ask(`Remove the saved ${keyVar} from the plugin config (plugins.entries.${pluginId}.config.${backendId}.env)?`);
          if (removeKey) {
            const copies = [
              ...(adapter.keyCopyPath ? [`${adapter.displayName}'s own copy in ${adapter.keyCopyPath}`] : []),
              "OpenClaw's rotated config copies next to openclaw.json",
            ].join(" and ");
            notes.push(`${keyVar} is removed from the plugin config; the other ${backendId} settings stay. ${copies} remain: see ${REMOVAL_DOCS}`);
          } else {
            notes.push(`The saved ${keyVar} stays.`);
          }
        }
        if (root && managed?.present) {
          const pool = deps.pools?.(backendId);
          const blind = pool
            ? ""
            : ` This process cannot see turns running in the Gateway; a turn still using it may fail.`;
          const removeCli = await ask(`Also remove the ${adapter.displayName} the plugin installed? Folder: ${root} (${formatBytes(managed.bytes)}).${blind}`);
          if (!removeCli) {
            notes.push(`The ${adapter.displayName} in ${root} stays.`);
          } else {
            if (pool && (pool.turns > 0 || pool.queued > 0)) {
              notes.push(`A ${backendId} turn is running or waiting, so ${root} was not removed. Run this method again when it has ended.`);
            } else {
              context.assertCurrent?.();
              pool?.closeIdle();
              let removed = true;
              try {
                await removeManaged(deps.stateDir!(), root);
              } catch (error) {
                removed = false;
                notes.push(
                  `Could not remove ${root} (${(error as Error).message}); ${backendId}.command is unchanged. Remove it by hand: see ${REMOVAL_DOCS}`,
                );
              }
              const command = settings.command;
              if (removed) notes.push(`Removed ${root}.`);
              if (removed && command !== undefined && isInside(root, command)) {
                unsetCommand = true;
                notes.push(`${backendId}.command pointed there and is unset; the plugin looks for ${adapter.command} on the Gateway's PATH again.`);
              }
            }
          }
        }
        if (!removeKey && !unsetCommand) return { profiles: [], notes };
        return {
          profiles: [],
          notes,
          configPatch: backendPatch(context, (backend) => ({
            ...backend,
            ...(unsetCommand ? { command: undefined } : {}),
            ...(removeKey ? { env: { ...envOfBackend(backend), [keyVar!]: undefined } } : {}),
          })),
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
export function createAuthProvider(adapter: CliAdapter, pluginId: string, deps: AuthDeps = {}) {
  return {
    id: backendIdFor(adapter),
    label: adapter.providerLabel ?? adapter.displayName,
    docsPath: "/providers/models",
    auth: createAuthMethods(adapter, pluginId, deps),
  };
}
