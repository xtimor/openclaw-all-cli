---
title: 'Images and compaction'
type: 'feature'
ticket: '14'
created: '2026-10-20'
status: 'ready-for-dev'
baseline_revision: '550dfd70e7c4821f8a979e1679e5e7d06c96c2fc'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'thorough'
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/initiative-openclaw-all-cli/architecture-openclaw-all-cli/architecture-openclaw-all-cli.md'
  - '{project-root}/_bmad-output/initiative-openclaw-all-cli/spec-cursor-cli-provider/claude-cli-parity.md'
  - '{project-root}/MEMORY.md'
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** An image a user attaches to a `cursor-cli` turn reaches Cursor only as a file path line at the end of the prompt text. OpenClaw 2026.10.3 writes the image to its own cache and appends the path, because the backend declares no `imageArg`. The model never gets the pixels. The catalog also declares Cursor models text-only, so the Gateway treats images for them as offloaded files. Compaction (P14) has not been researched.

**Approach:** When P13 is decided, the core takes the host's image paths off the end of `ctx.prompt`. It reads those files from the host's image cache under strict rules and sends them as ACP `image` content blocks after the text block. The plugin writes no image file. Probes showed Cursor's ACP agent has no compaction control, so P14 becomes a `gap` with its reason. The backend declares neither `ownsNativeCompaction` nor `manualCompaction`. OpenClaw's own transcript compaction then works as for any CLI backend. A live test proves it, and the docs say to set an API compaction model.

## Boundaries & Constraints

**Always:**
- AD-2: the core names no CLI. The image reader lives in the core, and the ACP mapping lives in the transport.
- AD-6/AD-7: the plugin creates, changes, or deletes no file for images, in the workspace, a home, or the temp dir. The cache files belong to the host, which sweeps them after 7 days. They are content-addressed and may serve a concurrent turn or a host retry, so the plugin never deletes them.
- Two levels of checks:
  - **Block membership** (path shape only; no file is opened, and only the temp root's realpath is resolved). The block is the trailing run of lines the host appends. It must follow an empty line or make up the whole prompt, and every line in it must pass:
    - an absolute path with no `.` or `..` segment (it equals its `path.normalize`)
    - parent directory named `openclaw-cli-images`
    - grandparent named `openclaw` or `openclaw-<uid>`
    - that grandparent's parent resolving (realpath) to `/tmp` or `os.tmpdir()`
    - file name matching `^[0-9a-f]{64}\.[a-z0-9]+$`

    If any line fails, nothing is taken and the prompt is unchanged.
  - **Delivery** (per member):
    - `lstat`: a regular file, no symlink
    - owner is the process uid (`process.getuid`, injectable)
    - realpath of its directory equals the checked directory
    - within the size caps
    - an allowed type by magic bytes

    A member that fails is removed from the text and becomes a note.
- Take the MIME type from magic bytes, never from the extension. The allow-list is png, jpeg, gif, webp, and bmp (all five probed live).
- Never log or put in an error: base64, image bytes, or the cache path.
- Every image that cannot be sent becomes a one-line note in the prompt. Never drop one silently.
- Gate everything on `flags.images` (P13). With P13 undecided, the prompt goes through unchanged.
- Keep `execute.ts` edits small and put the logic in a new module, as 1.13 did.

**Never:**
- Declare `imageArg`, `imageMode`, or `imagePathScope`. `workspace` scope makes the host write `.openclaw-cli-images` into the workspace.
- Copy images into a plugin temp dir.
- Send the cache path to Cursor, where its native read could open it.
- Declare `ownsNativeCompaction`: it makes `/compact` answer "does not support manual compaction" and switches off the host's compaction, the only one that works.
- Declare `manualCompaction` with a fake summary prompt: over ACP, `/summarize` is plain model text (probed).
- Use `cursor-agent -p` to compact (AD-4).
- Resend the images of earlier turns.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| One image | `ctx.prompt` ends `\n\n/tmp/openclaw/openclaw-cli-images/<sha>.png` | prompt = [text without the path line and separator, image{image/png, base64}] | No error expected |
| Many images | 3 trailing path lines | 3 image blocks in path order, all paths removed | No error expected |
| Only an image | prompt is just the path block | image blocks only; text block omitted when the composed text is empty | No error expected |
| With the system block and continuity note | fresh chat, P12 and P15 on | one text block: block, note, prependContext, prompt (paths removed), appendContext; then the images | No error expected |
| Resumed chat | turn 2 with an image, `session/load` | image delivered in turn 2; earlier turns' images are not resent (Cursor keeps them: live recall after load) | No error expected |
| Side question | `executionMode: "side-question"` with a trailing image | delivered to the throwaway chat; ledger untouched | No error expected |
| No image support | P13 decided, `promptCapabilities.image` false | `capability_mismatch` right after open, before any prompt (1.12 path) | existing |
| P13 undecided | manifest `spike` | prompt untouched, paths stay in text, no image blocks, catalog text-only | No error expected |
| Wrong MIME | `.png` that is JPEG bytes | sent as image/jpeg | No error expected |
| Unsupported type | heic, avif, svg, tiff, or unknown bytes | not sent; note `[OpenClaw] An attached image was not passed to the model: unsupported type.` | warn log without the path |
| Huge image | file over 10 MiB | not sent; note "too large" | warn |
| Too many | more than 10 images, or over 20 MiB in total | the first that fit are sent; note names how many were left out and why | warn |
| Missing or unreadable | cache swept or file gone | not sent; note "no longer available" | warn |
| Foreign path in the block | `..` segment, relative path, another dir, a workspace `.openclaw-cli-images`, a bad name | not a host block: prompt unchanged, nothing read | No error expected |
| Planted file | a member that is a symlink, owned by another uid, or whose dir resolves elsewhere | not sent; path removed; note "could not be read" | warn |
| Path not at the end | user text names a cache path mid-prompt | untouched | No error expected |
| Abort mid-read | `ctx.abortSignal` fires while files are read | abort propagates, no `session/prompt` sent | existing abort path |
| Base64 in logs | any image turn | no warn line, error, or fake-agent log line contains base64 or the path | No error expected |
| `/compact` with an API compaction model | `agents.defaults.compaction.model` = API model | the host compacts the transcript and drops the Cursor binding; the next turn opens a fresh Cursor chat (block + note), and the model can read the compacted history via `sessions_history` | No error expected |
| `/compact` without an API model | no usable model | the host's error (for example `No route-compatible authentication source ...`); the Cursor chat stays | host reports |

</intent-contract>

## Code Map

- `src/core/images.ts` (new): `takeHostImages(prompt, { signal?, warn?, roots?, uid?, limits? }) -> Promise<{ text, images: PromptImage[] }>`.
  - `text` is the prompt without the block and its separator. One note line per undelivered image (or one summary line for a count overflow) is appended after a blank line.
  - Parse the trailing non-empty lines bottom-up up to the first empty line, and apply the membership rule to all of them.
  - `roots` is the allowed set of `openclaw-cli-images` directories, injectable for tests. The default is derived from `/tmp` and `os.tmpdir()` as in Boundaries. `uid` defaults to `process.getuid?.()`.
  - Limits: 10 MiB per image, 10 images, 20 MiB in total.
  - `sniffImageMime(buf)` covers PNG `89 50 4E 47`, JPEG `FF D8 FF`, GIF `GIF8`, WEBP `RIFF....WEBP`, and BMP `BM`.
  - Read with `fs.promises.readFile(path, { signal })` after `lstat`, and call `signal.throwIfAborted()` after each file.
  - The note text names OpenClaw only (AD-2) and holds no path. Warnings go through a caller-supplied `warn`.
- Host facts (OpenClaw 2026.10.3):
  - `helpers-*.mjs` `prepareCliPromptImagePayload` + `writeCliImages`. With no `imageArg` and `input: "stdin"` the host writes `<resolvePreferredOpenClawTmpDir()>/openclaw-cli-images/<sha256(mime\0b64)><ext>`, dir 0700, file 0600. It then appends the paths, one per line, after `\n\n`, to the prompt the plugin's `execute` gets as `ctx.prompt`, before `promptContext`.
  - The temp root is `/tmp/openclaw`, or `<os.tmpdir()>/openclaw-<uid>` as the fallback (`@openclaw/fs-safe` `secure-temp-dir`).
  - The host's own recognizer is `isOpenClawCliImageCachePath` (`images.media-refs-*.mjs`).
  - The host also attaches local images that the user's text names (`detectImageReferences`, agent-scoped local roots), the same way.
  - The sweep TTL is 7 days. `MAX_IMAGE_BYTES` is 6 MiB.
  - `CliBackendExecuteContext` has no images field.
- `src/core/ports.ts`: add `PromptImage = { mimeType: string; data: string }` (base64). `CliSession.prompt(text: string, images?: readonly PromptImage[])`. Existing stubs keep compiling.
- `src/transports/acp/session.ts` 442/476: `prompt(text, images = [])` sends `[...(text ? [{type:"text", text}] : []), ...images.map((i) => ({ type: "image", mimeType: i.mimeType, data: i.data }))]`. It never logs them.
- `src/core/execute.ts`: add `images?: boolean` to `ExecuteOptions` (P13, default false). In `run`, before `composePrompt` (~660-675): when on, `const host = await takeHostImages(ctx.prompt, { signal: ctx.abortSignal, warn })`. Give `composePrompt` an optional last parameter `promptText` (default `ctx.prompt`) and pass `host.text`, so the neutralization guard still covers it. Pass `host.images` to `active.session.prompt(text, host.images)`. Nothing else changes: the ledger, the note order, and side questions stay as they are.
- `src/core/backend.ts` `createExecute` options (~135-146): `images: flags.images`. No new config fields. Assert in tests that no `ownsNativeCompaction`, `manualCompaction`, or `image*` field exists.
- `src/core/manifest.ts`: in `NO_FLAG_ROWS.P14`, the reason becomes "the CLI offers no compaction the plugin can drive; a backend that does not own native compaction gets OpenClaw's transcript compaction, so P14 sets no flag". Update the header comment's P14 sentence.
- `src/adapters/cursor/manifest.ts`: P13 `approx` (keeps `requires: ["imagePrompts"]`) and P14 `gap`, with the notes in Design Notes.
- `src/core/synthetic-auth.ts` 87: already gives `input: ["text","image"]` when `flags.images`. No code change, but the docs line in `cursor.md` changes.
- `test/fixtures/fake-cursor-agent.mjs`:
  - The `session/prompt` log line replaces each image block's `data` with `{bytes, sha256}`.
  - New prompt steer `[[images]]` replies `images:<n>:<mime>/<bytes>,...`.
  - The history keeps text only.
  - Update the header comment.
- Reuse: `test/backend.test.ts` fake helpers (`turn`, `withRow`, `FAKE_CURSOR_LOG`) and the table-driven flag test; `test/system-prompt.test.ts` patterns for fresh and resumed chats and side questions; `test/live/skills-system-prompt.live.test.ts` agent setup and fake shim; `test/live/history-continuity.live.test.ts` mock API registration; `harness.ts` `startGateway`, `openclaw`, `describeLive`, `replyLines`.

## Tasks & Acceptance

**Execution:**
- [ ] `src/core/images.ts`, `src/core/images.test.ts`: reader per the Code Map. One unit test per matrix row it owns:
  - one, many, and only-image prompts
  - the separator rule
  - not at the end
  - each membership failure (`..`, relative path, other dir, workspace `.openclaw-cli-images`, bad name) leaves the prompt unchanged
  - each delivery failure (symlink, injected different `uid`, a directory symlinked elsewhere) gives a note
  - magic bytes for all five types and a mismatched extension
  - unsupported type, huge, too many, and total cap
  - missing file
  - abort
  - notes and warns hold no path and no base64
- [ ] `src/core/ports.ts`, `src/transports/acp/session.ts`, `src/transports/acp/session.test.ts`: optional images on `prompt` and the ACP block mapping. Test: blocks sent in order, and the text block is omitted when empty.
- [ ] `src/core/execute.ts`, `src/core/backend.ts`: wiring per the Code Map.
- [ ] `src/core/manifest.ts`, `src/adapters/cursor/manifest.ts`, `src/core/manifest.test.ts`: P13 approx, P14 gap, the new P14 reason. Keep "leaves the rows the core has no mechanism for undecided" (P6 and P14 are both `gap`). The gap-reason test checks that the matrix cell matches.
- [ ] `test/fixtures/fake-cursor-agent.mjs`: image summary logging and `[[images]]`.
- [ ] `test/images.test.ts` (new), through `buildCliBackend` → `prepareExecution` → `execute` with the fake and an injected image root:
  - image turn: the log shows a text block without the path, and an image block with the right MIME and byte count
  - fresh chat: block, then note, then prompt in the text block, images after it
  - resumed chat (`session/load`) image
  - side question image
  - P13 undecided: prompt unchanged, no image block
  - capability `image:false` with P13 decided: `capability_mismatch` and only `initialize` logged (extend the existing 1.12 test)
  - abort while reading: no `session/prompt` logged
  - no log line holds base64
  - backend has no compaction or `image*` fields
  - catalog rows include `image` for the Cursor adapter
  - Plus the toggled-row table: P13 adds no config field, only the execute option
- [ ] `test/live/png-word.ts` (new helper): pure-Node PNG (zlib `deflateSync`, CRC32) that draws a word in a 5x7 bitmap font scaled about 12x, black on white. Random 6-letter consonant-vowel word from `BDFGHKLMNPRSTVZ` and `AEIOU`.
- [ ] `test/live/images-compaction.live.test.ts` (gated; P13, P14). Agent `oac-images` with a temp workspace; Gateway on port 18941 for row (e). Rows:
  - (a) `--local --json`: "What word is written in the image `<abs png in workspace>`? Reply with the word only. Do not use any tools." The reply holds the word and `meta.toolSummary` has no `read`, `glob`, or `grep`. Retry twice.
  - (b) Same session: "What word was in the image I sent before? Reply with the word only. Do not use any tools." The reply holds the word, and no read.
  - (c) The workspace holds only the files the test wrote: no `.openclaw-cli-images`, no `.cursor`.
  - (d) Fake shim as `cursor-cli.command` with `FAKE_CURSOR_LOG`, the same `--local` message. The log's `session/prompt` has a text block without `openclaw-cli-images` and one `image/png` block whose `bytes` equal the PNG size. This pins the host path contract.
  - (e) Gateway setup: mock API (`test/fixtures/mock-openai-api.mjs`) as `models.providers.mockapi`, plus `agents.defaults.compaction.model mockapi/echo`. Then:
    - turn 1: "Remember the code word KW-<stamp>. Reply ok."
    - `openclaw sessions compact agent:oac-images:explicit:<id> --json` gives `compacted: true`
    - turn 2: "What code word did I ask you to remember? Reply with it only."
    - The reply holds `KW-<stamp>`, and `<state>/agents/oac-images/agent/openclaw-all-cli/cursor-cli/acp-sessions` gained exactly one new chat directory.
  - `afterAll`: delete the agent, unset `cursor-cli.command`, `models.providers.mockapi`, and `agents.defaults.compaction` (unset the parent if `{}` is left), stop the Gateway and the mock.
- [ ] Docs:
  - `docs/providers/cursor.md`:
    - new sections "Images" (delivery, limits, allow-list, notes, nothing written, earlier images lost after a fresh chat or compaction) and "Compaction" (no Cursor control, what `/compact` and budget compaction do, the API compaction model)
    - Models paragraph (line 181): rows now declare image input
    - capability table P13 now checked; line 204 sentence
    - parity rows P13/P14
    - Known limits: HEIC/AVIF not sent; chat replaced by compaction; Cursor's own summarization not visible
  - `docs/setup.md` "Configure": a short paragraph recommending `agents.defaults.compaction.model` set to an API model for `cursor-cli` agents, with what fails without it.
  - Matrix cells P13/P14.
  - Architecture: AD-16 (Design Notes); the Open Questions row answered; CAP-11 map row adds AD-16.
  - MEMORY entry 14 with the probe facts below.

**Acceptance Criteria:**
- Given a `cursor-cli` turn whose message names a PNG with a random word, when it runs against real Cursor, then the reply contains the word without any native file read.
- Given that chat, when a later turn asks about the image, then Cursor answers from its own chat and no image is resent.
- Given an API compaction model, when `openclaw sessions compact` runs on a `cursor-cli` session, then it reports `compacted: true`, the next turn starts a new Cursor chat, and the reply still knows the earlier fact.
- Given the Cursor manifest, when the backend is built, then it declares no `ownsNativeCompaction`, `manualCompaction`, or `image*` field, P14 is `gap` with its reason in the manifest, the matrix, and the docs, and no image file appears in the workspace or the agent home.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

- **Probes** (2026-10-20, cursor-agent 2026.10.16, temp `CURSOR_CONFIG_DIR`, API key; OpenClaw 2026.10.3 in a copied state with the fake shim):
  - ACP `image` blocks work. A PNG with the random word HURODA and a red circle got the reply `HURODA red circle`. After `session/load` a text-only turn recalled `HURODA`.
  - Mismatched MIME (JPEG labeled png), gif, webp, bmp, and two images in one prompt all worked. A 5.9 MB PNG worked (17 s).
  - Garbage bytes labeled png were dropped silently: the model answered `NONE`. That is why the core checks magic bytes.
  - Cursor's ACP agent (bundle `6136.index.js` `processPrompt`) joins all text blocks with `\n` and attaches images as `selectedImages`, so block order does not matter. It handles only `/copy-request-id` plus command and skill names.
  - `available_commands_update` lists no summarize or compress. `/summarize` and `/compress` sent over ACP came back as ordinary model replies, and the session store did not change.
  - The TUI's `/summarize` (alts compress, compact) sends a `ConversationAction{summarizeAction}`, which the ACP agent never sends.
  - Cursor's chat state has summarization fields, so its server may summarize a full chat on its own. That is not visible or triggerable over ACP.
  - Host: the plugin's `execute` got `...user text\n\n/tmp/openclaw/openclaw-cli-images/<sha>.png`, then `appendContext`, from a workspace image the message named.
  - Host: `sessions compact` on a `cursor-cli` session failed with `No route-compatible authentication source is configured for openai` (the agent's default model). With `agents.defaults.compaction.model mockapi/echo` it gave `compacted: true`. The next turn sent `session/new` with the block and note, and the turn after it `session/load`.
  - `/compact` cannot be sent through `openclaw agent --message` ("Slash commands cannot be executed via --message"). Use `openclaw sessions compact <key>` against a Gateway.
- **Why blocks, not files:** the host already owns a private, swept, content-addressed cache. Reading it and sending base64 writes nothing, so AD-6/AD-7 hold trivially and there is no cleanup race. A per-agent temp copy would add a writer, a cleanup path, and an abort window, and would gain nothing. The path rule mirrors the host's own recognizer and fs-safe's naming. The uid, realpath, and no-symlink checks keep a planted or user-typed path from making the plugin read any other file. A typed path into the real cache still needs the image's content hash, so it reveals nothing new.
- **Why not `ownsNativeCompaction`:** Cursor's self-summarization is unverified and invisible over ACP. Declaring it would turn off the only compaction that works today. Revisit if a later probe shows Cursor compacting an ACP chat: that would also stop `cli_budget` failures for users without an API model.
- **AD-16 (new):** "Images reach a CLI as its protocol's image blocks. The core reads them from the host's own image cache (the trailing path block OpenClaw appends to the prompt for a backend without `imageArg`). It checks the directory, owner, type by magic bytes, and size, and drops the paths from the text. The plugin writes, copies, and deletes no image file (AD-6, AD-7). An image it cannot pass becomes a one-line note, never a silent drop. A CLI without native compaction leaves compaction to the host's transcript compaction; P14 sets no flag."
- **P13 note:** "the host writes each image to its private cache (`<OpenClaw temp>/openclaw-cli-images`, swept after 7 days) and appends the paths to the prompt; the core takes that trailing block off, reads each file (cache dir, owner, regular file, ≤10 MiB, ≤10 images, ≤20 MiB total, png/jpeg/gif/webp/bmp by magic bytes) and sends ACP image blocks after the text; an image it cannot send becomes a one-line note; nothing is written; catalog rows declare image input; Cursor keeps earlier images in its chat (no resend); requires promptCapabilities.image; live test test/live/images-compaction.live.test.ts"
- **P14 note:** "gap: cursor-agent acp offers no compaction (available_commands_update lists none; /summarize and /compress sent over ACP are plain model text and leave the chat store unchanged; the TUI's /summarize uses a conversation action the ACP agent never sends), so the backend declares neither ownsNativeCompaction nor manualCompaction; OpenClaw 2026.10.3 then compacts its own transcript as for any CLI backend: /compact (sessions.compact) and the pre-turn cli_budget compaction summarize with an API model (agents.defaults.compaction.model, else the agent's model) and drop the Cursor chat binding, the next turn starts a fresh Cursor chat with the system block and the continuity note (P15), and the model reads the compacted conversation through sessions_history; without a usable API model compaction fails with the host's reason and the chat stays; Cursor may summarize its own chat server-side, invisible over ACP; live test test/live/images-compaction.live.test.ts"
- **MEMORY entry 14:** the probes above; the host image contract (cache path, trailing block, root names, TTL, no image field in `execute`); compaction behavior and the `sessions compact` method; the warning not to `pkill -f` a name that is on your own command line (this planning run killed its own shell that way).

## Verification

**Commands:**
- `npm run typecheck && npm run build && npx vitest run`: all pass, live tests skipped.
- `npm run dev:install && NODE_USE_ENV_PROXY=1 OPENCLAW_ALL_CLI_LIVE=1 npx vitest run test/live/images-compaction.live.test.ts`: passes with real `cursor-agent` (`CURSOR_API_KEY` is set on this host). Do not run it while other live tests use `.spike/state`.
- `npm run test:live`: the suite still passes.
- `pgrep -fa "cursor-agent|fake-cursor-agent|mock-openai-api"` after the run: nothing left by the tests.
- `git status --short` after the live run: no file under the repo or a workspace was created by the plugin.

## Auto Run Result

- Status: ready-for-dev (halted after planning, as the invocation asked). Planning wrote only this file and committed nothing.
- Route full (about 600 lines across core, transport, fake, tests, live test, docs). Risk medium: every turn's prompt goes through a parser that reads local files and sends them to Cursor's server.
- Recommended review: thorough. The file-read rule, which paths count as the host's, and the port change all need adversarial and edge-case review.
- Live probes were run against real cursor-agent 2026.10.16 in a scratchpad home, and against a copied OpenClaw state with the fake shim. `.spike/state` was not touched.
