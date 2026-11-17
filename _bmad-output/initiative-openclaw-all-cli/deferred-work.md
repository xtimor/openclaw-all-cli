# Deferred work

- source_plan: `_bmad-output/initiative-openclaw-all-cli/plan-27-control-ui-credential-profile.md`
  summary: Measure whether the first `readStoredKey` (dynamic import of `openclaw/plugin-sdk/agent-runtime`) slows the first cursor-cli turn and the catalog listing inside a running Gateway.
  evidence: maybe-false (medium if true). Cold `--local` import took ~10 s on 2026.10.3 and ~4 s on 2026.11.3; inside the Gateway the host modules are likely already cached. Settle by timing `prepareExecution` and `catalog.run` on a fresh Gateway (debug timing line).
- source_plan: `_bmad-output/initiative-openclaw-all-cli/plan-27-control-ui-credential-profile.md`
  summary: Catalog listing, login probe, and the `login`/`remove` notes read only `cursor-cli:default`, while turns use the host-picked profile (e.g. a hand-made `cursor-cli:manual`).
  evidence: low; the plugin's own method always writes `:default`. A `:manual`-only setup gets keyed turns but a keyless model listing and no precedence/stays notes.
- source_plan: `_bmad-output/initiative-openclaw-all-cli/plan-sdk-provider-auth-barrel.md`
  summary: Check that the `provider-auth` store read inside a running Gateway stops returning a `cursor-cli` key right after a terminal `openclaw models auth logout cursor-cli:default`, and does not serve OpenClaw's in-memory store copy.
  evidence: maybe-false, medium if true. `ensureAuthProfileStore[Async]` prefers the runtime store snapshot, and the old `findPersistedAuthProfileCredential` read the persisted store. OpenClaw refreshes the Gateway after a logout (`models.authRefresh`). To settle it, run a live logout while the Gateway runs, then trigger a keyless sweep or turn.
