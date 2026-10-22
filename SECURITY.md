# Security policy

## Reporting a vulnerability

Report it privately: [open a security advisory](https://github.com/xtimor/openclaw-all-cli/security/advisories/new). Do not open a public issue, pull request, or discussion for a vulnerability.

Include:

- the plugin version (`openclaw plugins inspect openclaw-all-cli`), the OpenClaw version, and the `cursor-agent` version;
- what is affected and the impact (for example: a tool call that bypasses OpenClaw policy, a secret that reaches a log or a model);
- steps or a minimal setup to reproduce;
- a fix or mitigation, if you have one.

Do not include real API keys or tokens.

## Supported versions

The latest release on npm (`npm view openclaw-all-cli version`). Older versions get no fixes; update with `openclaw plugins update openclaw-all-cli`.
