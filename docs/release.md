# Release

A release is a tag. Pushing `vX.Y.Z` runs `.github/workflows/release.yml`, which calls `scripts/release.sh`:

1. Validates the tag (`vMAJOR.MINOR.PATCH`, optional prerelease such as `-rc.1`) and, for a real release, that the tag's commit is on `origin/main` and is the checked-out commit.
2. Refuses a version that is already on npm.
3. Sets the version from the tag (`package.json` stays `0.0.0` in git; the script restores it).
4. Runs the same checks as CI (`scripts/ci-check.sh`).
5. Packs once, prints the sha256 of the `.tgz`, and writes it to the job summary and the release notes.
6. Publishes that tarball to npmjs.com with provenance (see below), then creates a GitHub release with the same `.tgz` and generated notes.

A prerelease (`v1.2.3-rc.1`) publishes under the npm tag `next` and is marked as a prerelease on GitHub; `latest` moves only with a stable version. Nothing publishes on a pull request or a branch push, and CI never pushes commits or moves tags.

## Cut a release

1. Make sure `main` is green and holds what you want to ship.
2. Tag the commit and push the tag:

   ```sh
   git switch main && git pull
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

3. Watch the `Release` run in GitHub Actions. The summary shows the version, the npm tag, and the sha256.
4. Check: `npm view openclaw-all-cli@X.Y.Z dist.shasum` matches the `.tgz` attached to the GitHub release (`sha1sum` of the file), and the package page shows the provenance badge.

A failed run before the publish step is safe to repeat: fix the cause and re-run it (or delete and re-push the tag if the tag itself was wrong). If the publish succeeded and only the GitHub release failed, create the release by hand from the same tag; do not publish again.

## Dry run

Run the workflow by hand: Actions, `Release`, `Run workflow`, a tag name such as `v0.0.1`, `dry_run` on (the default). It runs every step, including `npm publish --dry-run`, and stops before publishing; no GitHub release is created, and it needs no tag. A pushed tag that matches `v*-dryrun.*` (for example `v0.0.1-dryrun.1`) is always a dry run too. Delete such a tag afterwards (`git push origin :refs/tags/v0.0.1-dryrun.1`).

A dry run still fails on a bad tag name and on a version that is already on npm.

## First release

npm can set a trust only on a package that exists, and `openclaw-all-cli` is not on npm yet. So the first release is staged by CI with a stage-only token, and you approve it once:

1. On npmjs.com create a granular access token that can write `openclaw-all-cli` and does **not** bypass 2FA (it can only stage). Store it as the repository secret `NPM_TOKEN` (Settings, Secrets and variables, Actions). If the package does not exist yet and npm will not issue a token for it, create the token with the narrowest scope npm allows.
2. Cut the release as above. The workflow runs `npm stage publish <tgz> --provenance`; the run summary says the version is staged, not published. The GitHub release is created at this point.
3. Approve the staged version with 2FA: on npmjs.com (the package, staged versions), or `npm stage list openclaw-all-cli` then `npm stage approve <id>`.
4. Set the trust, so later releases need no token:

   ```sh
   npm trust github openclaw-all-cli --file release.yml --repo xtimor/openclaw-all-cli --allow-publish
   ```

5. Delete the `NPM_TOKEN` secret and revoke the token on npmjs.com. Set the package access to "Require two-factor authentication and disallow tokens".
6. Check that `npm view openclaw-all-cli dist.shasum` matches the attached tarball.

If `NPM_TOKEN` is missing on the first release, the run fails before staging and names the secret.

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
