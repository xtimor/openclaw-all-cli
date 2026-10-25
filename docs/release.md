# Release

A release is a version tag. `.github/workflows/release.yml` runs `scripts/release.sh` when the workflow is dispatched on `main` (it creates the tag) or when a tag `vX.Y.Z` is pushed:

1. Validates the tag (`vMAJOR.MINOR.PATCH`, optional prerelease such as `-rc.1`) and, for a real release: on a tag push, that the tag's commit is on `origin/main` and is the checked-out commit; on a dispatch, that the checked-out commit is the head of `origin/main` and the tag is new.
2. Refuses a version that is already on npm.
3. Sets the version from the tag (`package.json` stays `0.0.0` in git; the script restores it).
4. Runs the same checks as CI (`scripts/ci-check.sh`).
5. Packs once, prints the sha256 of the `.tgz`, and writes it to the job summary and the release notes.
6. Takes the release notes from [`CHANGELOG.md`](../CHANGELOG.md) (see [Changelog](#changelog)): the version's section, else `Unreleased`, else GitHub's generated notes.
7. Publishes that tarball to npmjs.com with provenance (see below), then creates a GitHub release with the same `.tgz` and those notes.

A prerelease (`v1.2.3-rc.1`) publishes under the npm tag `next` and is marked as a prerelease on GitHub; `latest` moves only with a stable version. Nothing publishes on a pull request or a branch push. CI never pushes commits or moves tags; a dispatched release creates its new tag through the GitHub release.

## Cut a release

One action, whenever you like: tell an agent "release" (optionally "minor" or "major"; the default is a patch), or run it yourself: Actions, `Release`, `Run workflow` on `main`, `tag` empty, `bump` (`patch`, `minor`, or `major`), `dry_run` off. With the tag empty the script reads the stable `vX.Y.Z` tags on origin, takes the highest (none: `0.0.0`), raises it by `bump`, and prints the result (`release: no tag given; patch bump of v0.1.1 gives v0.1.2`). The run checks that the tag is new, releases `main`'s head, and the GitHub release creates the tag at that commit once publish or stage worked. A failed run creates no tag. A tag created this way starts no second run.

**For agents.** Only on the owner's explicit "release" in chat (optionally "minor" or "major"; the issue agents never release):

1. Compute the next version the way the script does (the highest stable `vX.Y.Z` tag on origin, raised by the bump; none means `0.0.0`) and tell the owner the version.
2. Stamp the changelog in a pull request. First check that `Unreleased` was not released already: an owner dispatch from the Actions UI can have used it as the notes of the latest release (`gh release view vA.B.C --json body,publishedAt`; the body then holds those lines). If so, stamp those lines as `A.B.C` with that release's date, and re-add by hand any line added since under `Unreleased`. Then, on a branch from `main`, `node scripts/changelog.mjs stamp X.Y.Z $(date -u +%F)`, `npm run ci`, commit `Changelog: X.Y.Z`, open the pull request, and merge it (the owner's "release" is the approval; if the merge is refused, tell the owner and wait for them to merge). With nothing under `Unreleased` the stamp refuses: skip this step, the release then uses GitHub's generated notes.
3. Dispatch `Release` on `main` with that explicit `tag` and `dry_run: false` (after the merge, `main`'s head is the stamped commit), watch the run, and report the npm version and the release link.

To pick the version yourself, fill `tag` (`vX.Y.Z`); `bump` is then ignored. Or push the tag:

```sh
git switch main && git pull
git tag vX.Y.Z
git push origin vX.Y.Z
```

Then:

1. Watch the `Release` run in GitHub Actions. The summary shows the version (the computed tag when `tag` was empty), the npm tag, and the sha256.
2. Check: `npm view openclaw-all-cli@X.Y.Z dist.shasum` matches the `.tgz` attached to the GitHub release (`sha1sum` of the file), and the package page shows the provenance badge.

A failed run before the publish step is safe to repeat. One case is not: if the publish worked but the GitHub release failed, no tag exists, so every later run with an empty `tag` computes the same version and stops with "already on npm". Finish that release by hand as described below (its `--target` creates the tag); the next empty-tag run then moves on. A dispatched run: fix the cause, then dispatch a new run on `main` (a re-run keeps its old commit, so it is refused once `main` moved). A tag-push run: the tag stays on origin, so delete it (`git push origin :refs/tags/vX.Y.Z`), fix, and push the tag again, or dispatch the same version on `main` after deleting it. If the publish succeeded and only the GitHub release failed, do not publish again: the log line `release commit: <sha>, tarball sha256: <sha256>` before the failure gives both values; take the tarball from npm (`npm pack openclaw-all-cli@X.Y.Z`, after approval on a first release), check its sha256, then `gh release create vX.Y.Z openclaw-all-cli-X.Y.Z.tgz --target <sha> --generate-notes --notes "sha256: <sha256>"` (add `--prerelease` for a prerelease; `--target` also creates the tag; for the changelog notes, run `node scripts/changelog.mjs section X.Y.Z > notes.md`, append the `sha256:` line, and pass `--notes-file notes.md` instead of `--generate-notes --notes ...`).

## Changelog

[`CHANGELOG.md`](../CHANGELOG.md) is the user-facing history, in [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) layout: `## Unreleased` first, then `## X.Y.Z - YYYY-MM-DD`, newest first, with `### Added`, `### Changed`, `### Deprecated`, `### Removed`, `### Fixed`, or `### Security` inside.

**Every change keeps it current.** A change that alters what a user of the plugin sees adds one line under `Unreleased`, in the same pull request: behavior, setup or configuration, docs a user follows, a fixed issue (link it, `([#12](https://github.com/xtimor/openclaw-all-cli/issues/12))`). Write what the user gets in plain words, not how it was built. Internal-only changes add nothing: CI, the agent flow, tests, tickets and plans, run logs, refactors. This binds the issue agents ([implementation agent](agents/implement.md)), the BMAD builds (`_bmad/custom/bmad-build.toml` and `bmad-build-auto.toml` carry the rule), and contributors. `npm test` checks the layout (`scripts/changelog.mjs check`).

**A release uses it.** `scripts/release.sh` runs `scripts/changelog.mjs section X.Y.Z` and gives the GitHub release that text plus the sha256 line:

| `CHANGELOG.md` has | Release notes | `main` afterwards |
| --- | --- | --- |
| lines under `## X.Y.Z - date` (the agent's flow stamped it) | that section | names the version and date |
| no such section, lines under `Unreleased` | `Unreleased` (the log and summary say so) | still lists the lines under `Unreleased`: stamp them in a pull request, or the next release repeats them |
| nothing usable (empty, missing, unreadable) | GitHub's generated notes, as before | unchanged |

The changelog never fails a release: an owner dispatch from the Actions UI works with any state of the file. CI never pushes to `main`, so naming the version in the file is a pull request: the agent's "release" flow does it first (step 2 above); by hand, `node scripts/changelog.mjs stamp X.Y.Z YYYY-MM-DD` in a pull request, before the dispatch or, after an owner dispatch that used `Unreleased`, with the released version and date. A dry run prints the notes it would use.

## Dry run

Run the workflow by hand: Actions, `Release`, `Run workflow`, a tag name such as `v0.0.1` (or empty, to see the computed next version), `dry_run` on (the default). It runs every step, including `npm publish --dry-run`, and stops before publishing; no GitHub release is created, and it needs no tag. A pushed tag that matches `v*-dryrun.*` (for example `v0.0.1-dryrun.1`) is always a dry run too. Delete such a tag afterwards (`git push origin :refs/tags/v0.0.1-dryrun.1`).

A dry run still fails on a bad tag name and on a version that is already on npm. A tag push needs its tag; only a dispatch may leave it empty.

`Run workflow` with `dry_run` off is a real release (see Cut a release): run it on `main` with `tag` empty (next version) or a new tag.

`Run workflow` appears only once `release.yml` is on `main`; before that, use a `v*-dryrun.*` tag.

## First release

npm can set a trust only on a package that exists, and `openclaw-all-cli` is not on npm yet. So the first release is staged by CI with a stage-only token, and you approve it once:

1. On npmjs.com create a granular access token that can write `openclaw-all-cli` and does **not** bypass 2FA (it can only stage). Store it as the repository secret `NPM_TOKEN` (Settings, Secrets and variables, Actions). If the package does not exist yet and npm will not issue a token for it, create the token with the narrowest scope npm allows.
2. Cut the release as above. The workflow runs `npm stage publish <tgz> --provenance` with npm 12.2.1 (npm 11's docs say staging needs an existing package; npm 12's say it creates one); the run summary says the version is staged, not published. The GitHub release is created at this point.
3. Approve the staged version with 2FA: on npmjs.com (the package, staged versions), or `npm stage list openclaw-all-cli` then `npm stage approve <id>`.
4. Set the trust, so later releases need no token:

   ```sh
   npm trust github openclaw-all-cli --file release.yml --repo xtimor/openclaw-all-cli --allow-publish
   ```

5. Delete the `NPM_TOKEN` secret and revoke the token on npmjs.com. Set the package access to "Require two-factor authentication and disallow tokens".
6. Check that `npm view openclaw-all-cli dist.shasum` matches the attached tarball.

If `NPM_TOKEN` is missing on the first release, the run fails before staging and names the secret.

If npm refuses to stage a package it has never seen, the run stops before the GitHub release, so no tag and no release exist. Publish the first version yourself, with 2FA, from the commit the run used (its head SHA in the Actions run):

```sh
git fetch origin && git switch --detach <sha>
npm ci && npm version X.Y.Z --no-git-tag-version && npm run build && npm pack
npm publish openclaw-all-cli-X.Y.Z.tgz          # asks for the 2FA code
gh release create vX.Y.Z openclaw-all-cli-X.Y.Z.tgz --target <sha> --generate-notes --notes "sha256: $(sha256sum openclaw-all-cli-X.Y.Z.tgz | cut -d' ' -f1)"
```

Then continue at step 4. That version has no provenance; later ones do.

`npm trust` and `npm stage` need npm 11.15 or later on your machine (`npm install -g npm@latest`).

Later releases (the package is on npm) run `npm publish <tgz> --provenance` through trusted publishing: the job asks GitHub for an OIDC token and npm accepts it because of the trust above. No token is used. If npm rejects the login, the trust is missing or points at another repository or workflow file: run `npm trust list openclaw-all-cli` and compare with step 4.

## Rollback

Never run `npm unpublish`: it breaks everyone who depends on the version and the registry does not allow reusing it. To retire a bad version:

```sh
npm deprecate openclaw-all-cli@X.Y.Z "<reason; use X.Y.(Z+1)>"
```

then release a fixed patch version from a new tag. Move the `latest` tag only by releasing (`npm dist-tag add openclaw-all-cli@X.Y.Z latest` is a manual repair with 2FA). Edit the GitHub release notes to point at the fix.

## Rotate the credential

- Trust (normal state): `npm trust list openclaw-all-cli` shows it; `npm trust revoke --id <id> openclaw-all-cli` removes it, and `npm trust github ...` from the first release sets a new one. The registry holds one trust per package.
- Token (only before the first release is approved): create a new stage-only token, replace the `NPM_TOKEN` secret, revoke the old token on npmjs.com. After the trust is set there is no token to rotate.

If a token may have leaked, revoke it first, then check `npm stage list openclaw-all-cli` for versions you did not stage and reject them.
