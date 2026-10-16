# Setup

How to run `cursor-cli/<model>` in your OpenClaw.

> **Status:** the plugin is not built yet. Sections marked *planned* describe the intended setup and change as the code lands.

## Requirements

| Component | Version | Check |
| --- | --- | --- |
| OpenClaw | 2026.10.3 or later | `openclaw --version` |
| Cursor CLI (`cursor-agent`) | 2026.07.06 or later | `cursor-agent --version` |
| Cursor plan | Headless CLI allowed (admins can disable it) | `cursor-agent status` |

Older OpenClaw builds treat CLI backends as text-only, with no tools and no streaming. Older `cursor-agent` builds can corrupt `cli-config.json` when several agents run at once.

## 1. Sign in to Cursor

```sh
cursor-agent login
cursor-agent models
```

`models` must list at least one model. On macOS the login is stored in the Keychain and is shared by every agent.

**Optional: Cursor API key.** Create a user API key in the Cursor Dashboard. Add it as an OpenClaw `api_key` auth profile if you want OpenClaw to replay chat history into a fresh Cursor session.

## 2. Install the plugin *(planned)*

```sh
git clone <repo-url> openclaw-all-cli
openclaw plugins install ./openclaw-all-cli
openclaw plugins enable cursor-cli
```

## 3. Configure *(planned)*

Plugin settings (isolation, transport, API-key profile) are documented here once they exist.

## 4. Verify

```sh
openclaw plugins inspect cursor-cli --runtime --json
openclaw agent --model cursor-cli/<model> --message "Say hi"
```

In `/model`, Cursor models must show as available, not "Sign-in needed".

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Models show "Sign-in needed" | OpenClaw sees no Cursor auth | Run `cursor-agent login`, then restart the Gateway |
| "No models available for this account." | Old `cursor-agent` build, or the plan restricts models | Run `cursor-agent update` and check the plan |
| A turn hangs with no output | Known `cursor-agent -p` transport stalls | Update `cursor-agent`; the plugin watchdog ends the turn |
