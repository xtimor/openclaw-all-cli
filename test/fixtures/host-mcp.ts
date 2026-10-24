import { MCP_CONFIG_FLAG } from "../../src/core/mcp-target.ts";

/**
 * A test names the MCP config file the host would write in `env[MCP_CONFIG_TEST_KEY]`. The host
 * (`bundleMcpMode: "claude-config-file"`) puts it into the launch args instead, as
 * `--strict-mcp-config --mcp-config <file>`; `withHostMcp` moves it there.
 */
export const MCP_CONFIG_TEST_KEY = "OAC_TEST_MCP_CONFIG";

/** `args` and `env` as `execute` receives them: the test key becomes the host's flags. */
export function withHostMcp<E extends Record<string, string | undefined>>(args: readonly string[], env: E): { args: string[]; env: Omit<E, typeof MCP_CONFIG_TEST_KEY> } {
  const { [MCP_CONFIG_TEST_KEY]: file, ...rest } = env;
  return { args: [...args, ...(file ? ["--strict-mcp-config", MCP_CONFIG_FLAG, file] : [])], env: rest };
}
