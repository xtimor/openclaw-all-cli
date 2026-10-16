# OpenClaw-All-CLI

OpenClaw plugin that exposes local coding CLIs as models. Chat, the agent, and `/model` treat a CLI reply the same as an API model. The CLI runs the turn's tool loop with OpenClaw's tools only; OpenClaw owns policy, transcript, and session. First provider is Cursor CLI (`cursor-agent`), registered as `cursor-cli/<model>`; the same contract is meant for other CLIs later.

## Rules

- Write short, without losing meaning.
- Edit `AGENTS.md` only with the user's permission.
- When something should be remembered, write it in `MEMORY.md`.
- Keep the project in English: code, comments, docs, commits, and names.
- In chat, answer in the user's language. If the user writes in russian, answer in Ukrainian.
- User docs live in `docs/` and are linked from `README.md`. Update them in the same change that alters setup, config, or behavior.
- Make all tactical and technical decisions yourself. Ask the user only about high-level and strategic ones.
- Run development under strict self-control: set up the process and enforce it yourself (plan, verify, review) for every change.
