# Cursor provider card on OpenClaw latest

What the Control UI Model Providers card shows for `cursor-cli`, measured on a current OpenClaw. Background and the upstream issue: [Cursor provider](cursor.md#provider-list-and-sign-in-methods) and [Setup](../setup.md#sign-in-from-the-control-ui-or-the-cli).

- Date: 2026-11-05.
- OpenClaw: npm `latest`, 2026.10.10 (7dc3350), installed into a fresh directory.
- Plugin: this repository packed with `npm pack` (0.0.0 build) and installed from the tarball, not bundled.
- `cursor-agent` 2026.10.22. Headless Chromium (Playwright) read `/model-providers` after each reload. Models came from the Gateway call `models.list`, turns from `openclaw agent --message "Reply with exactly: pong"`.

## What the host had

This host has no `cursor-agent` browser login: `cursor-agent status` prints `Not logged in`, and the only credential is an API key. So the requested state (a), "valid login", was **not run**. The key was measured in its place, through the plugin config (`cursor-cli.env`, the documented way) and through the Gateway environment. The state "login lost" was measured two ways: `~/.cursor/cli-config.json` moved aside, and the key removed. Moving `cli-config.json` aside takes away no credential (it holds settings, not tokens), so the first changed nothing; the second is the closest this host can come to a lost credential.

## Results

| State | Credentials line (verbatim) | Connect provider | Models | Turn |
| --- | --- | --- | --- | --- |
| Key in plugin config, Gateway env without key | `Credentials for main` / `Not configured` | Shown, enabled (card and page header) | 47 listed, none unavailable | Ok (`pong`) |
| Key in Gateway env (plugin config without key) | `Credentials for main` / `Not configured` | Shown, enabled | 47 listed | Ok |
| `cli-config.json` moved aside, Gateway running, page reloaded | `Not configured` | Shown, enabled | 47 listed | Ok |
| No credential (key removed from plugin config, no login), page reloaded | `Not configured` | Shown, enabled | 1 listed (`auto`) after about 10 s; 0 in the first seconds | Fails: `The CLI rejected its login: Invalid params: Failed to open browser for login.` followed by a Cursor login URL |
| Key put back, no Gateway restart | `Not configured` | Shown, enabled | 0 for about 7 s, then 47 (back by 14 s) | Ok |

`models.authStatus` has no `cursor-cli` row in any state; its `providerCapabilities` entry lists the two login options. The card never reflects a state change, in either direction.

- A lost credential does not show on the card: the line reads `Not configured` with and without it. It shows in the model list (47 rows shrink to `auto`) and in a failed turn.
- The card recovers without a restart: after the key is back the Gateway reloads the plugin config and the 47 models return within seconds. The card needed no recovery, since it never changed.
- A key in the Gateway environment does **not** turn the line into "API key from environment" on 2026.10.10: the line stays `Not configured`. The environment lookup knows provider environment variables from OpenClaw's own mapping, and the plugin declares none.

## Control: a provider that is not configured

A provider `acme-control` was added to `models.providers` with a base URL and one model and no key. Its card read `Credentials for main` / `Not configured`, the same line as `cursor-cli` in every state, and its button was **Set API key**, not **Connect provider**. So the line cannot tell a working Cursor login from a missing one, and `cursor-cli` differs from an ordinary unconfigured provider only by the button: its card offers **Connect provider**, which opens the dialog with "No connected accounts for this provider." and the two Cursor methods (**Use the cursor-agent login**, **Cursor CLI API key (CURSOR_API_KEY)**).

## Not run

- Valid `cursor-agent` login (state a): no login on this host, see above. The login-only card, and whether a lost login recovers, remain unmeasured; the key states stand in and give the same card.
- Screenshots were taken for the check and are not kept in the repository.

## Short upstream comment (for openclaw/openclaw#184700)

On OpenClaw 2026.10.10 (npm `latest`, plugin installed from a tarball, headless Control UI): the `cursor-cli` provider card reads `Credentials for main` / `Not configured` and offers **Connect provider** in every state tried: key in plugin config, key in the Gateway environment, CLI settings file moved aside, and no credential at all. With no credential the model list shrinks from 47 to 1 and a turn fails with the CLI's login error; with the credential back the models return within seconds and no restart is needed, while the card stays `Not configured`. A control provider with no key (`models.providers`, base URL only) reads the same line but shows **Set API key** instead of **Connect provider**. So the card's credential line is independent of whether the provider can run, for a plugin provider whose credential is kept by a CLI. A login-only state was not measured (no login on the test host).
