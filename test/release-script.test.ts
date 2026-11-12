import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * scripts/release.sh against stub `npm`, `gh`, `git`, and `clawhub` and a stub check script, in a throwaway
 * copy of the project layout. Covers every row of the release matrix (ticket 3.4) and of the ClawHub matrix
 * (ticket 3.31). Nothing here touches the network, the real npm registry, ClawHub, or the real repository.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "npm_STAGE_SECRET_0123456789";
const CLAWHUB_SECRET = "clh_CLAWHUB_SECRET_9876543210";
const ORIGINAL_PACKAGE_JSON = '{"name":"openclaw-all-cli","version":"0.0.0"}\n';

const STUBS: Record<string, string> = {
  // Logs every call with the token it would send; npm view/pack/version/publish/stage behave per STUB_* env.
  npm: `#!/usr/bin/env bash
echo "npm $* | token=\${NODE_AUTH_TOKEN:-}" >>"$STUB_LOG"
case "$1" in
  version) printf '{"name":"openclaw-all-cli","version":"%s"}\\n' "$2" >package.json ;;
  view)
    case "$2" in
      openclaw-all-cli@*)
        if [ "\${STUB_VERSION_EXISTS:-0}" = 1 ]; then echo "\${2#*@}"; exit 0; fi
        case "\${STUB_PACKAGE:-exists}" in
          missing) echo "npm error code E404" >&2; exit 1 ;;
          broken) echo "npm error code ENOTFOUND getaddrinfo" >&2; exit 1 ;;
          *) exit 0 ;;
        esac ;;
      openclaw-all-cli)
        case "\${STUB_PACKAGE:-exists}" in
          exists) echo openclaw-all-cli ;;
          missing) echo "npm error code E404" >&2; exit 1 ;;
          *) echo "npm error code ENOTFOUND getaddrinfo" >&2; exit 1 ;;
        esac ;;
    esac ;;
  pack)
    dest=out; [ "$2" = "--pack-destination" ] && dest="$3"
    printf 'tarball of %s' "$(cat package.json)" >"$dest/openclaw-all-cli-stub.tgz" ;;
  publish) [ "\${STUB_PUBLISH_FAIL:-0}" = 1 ] && { echo "npm error 404 OIDC token exchange failed" >&2; exit 1; }; exit 0 ;;
  stage) exit 0 ;;
  install)
    # The pinned clawhub CLI: a bin that runs the clawhub stub under node, as the real one runs under node.
    echo "npm-install-env | gh=\${GH_TOKEN:-} oidc=\${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-} clawhub=\${CLAWHUB_TOKEN:-} config=\${CLAWHUB_CONFIG_PATH:-}" >>"$STUB_LOG"
    [ "\${STUB_CLAWHUB_INSTALL_FAIL:-0}" = 1 ] && { echo "npm error code ETARGET" >&2; exit 1; }
    prefix=""; prev=""
    for a in "$@"; do [ "$prev" = --prefix ] && prefix="$a"; prev="$a"; done
    mkdir -p "$prefix/node_modules/clawhub/bin"
    echo '{"type":"commonjs"}' >"$prefix/node_modules/clawhub/package.json"
    cat >"$prefix/node_modules/clawhub/bin/clawdhub.js" <<'JS'
require("node:fs").appendFileSync(process.env.STUB_LOG, "clawdhub.js under node\\n");
const run = require("node:child_process").spawnSync(process.env.STUB_CLAWHUB_BIN, process.argv.slice(2), { stdio: "inherit" });
process.exit(run.status ?? 1);
JS
    ;;
esac
`,
  // Logs every call with the config file it reads (content and mode) and the credentials in its env.
  clawhub: `#!/usr/bin/env bash
cfg="\${CLAWHUB_CONFIG_PATH:-}"
conf=none
if [ -n "$cfg" ] && [ -f "$cfg" ]; then conf="$(cat "$cfg") mode=$(stat -c %a "$cfg" 2>/dev/null || stat -f %Lp "$cfg")"; fi
echo "clawhub $* | config=$conf gh=\${GH_TOKEN:-} oidc=\${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-} env=\${CLAWHUB_TOKEN:-}" >>"$STUB_LOG"
case "$1 $2" in
  "package publish")
    version="$(sed -n 's/.*"version":"\\([^"]*\\)".*/\\1/p' "$3")"
    sha="$(sha256sum "$3" | cut -d' ' -f1)"
    if [[ " $* " == *" --dry-run "* ]]; then
      [ "\${STUB_CLAWHUB_DRY_FAIL:-0}" = 1 ] && { echo "Error: openclaw.build.openclawVersion is required" >&2; exit 1; }
      printf '{\n  "source": "%s",\n  "name": "openclaw-all-cli",\n  "family": "code-plugin",\n  "version": "%s"\n}\n' "$3" "$version"
      exit 0
    fi
    echo "Waiting for security checks on openclaw-all-cli@$version" >&2
    publication=published
    case "\${STUB_CLAWHUB_PUBLISH:-ok}" in
      fail) echo "Error: Unauthorized (401): invalid or expired token" >&2; exit 1 ;;
      blocked) echo "Error: ClawHub publication blocked for openclaw-all-cli@$version: static scan flagged dist/plugin.js" >&2; exit 1 ;;
      timeout) echo "Error: Timed out after 1800s waiting for ClawHub to publish openclaw-all-cli@$version. Attempt att_1 is still pending." >&2; exit 1 ;;
      sha) sha=0000000000000000000000000000000000000000000000000000000000000000 ;;
      nosha) sha="" ;;
      pending) publication=pending ;;
    esac
    printf '{\n  "name": "openclaw-all-cli",\n  "version": "%s",\n  "status": "%s",\n  "releaseId": "rel_1",\n  "artifactSha256": "%s",\n  "publicationStatus": "%s",\n  "attemptId": "att_1"\n}\n' "$version" "$publication" "$sha" "$publication"
    ;;
  "package trusted-publisher")
    [ "\${STUB_CLAWHUB_TP_FAIL:-0}" = 1 ] && { echo "Error: Forbidden (403): not a package owner" >&2; exit 1; }
    echo '{"trustedPublisher":{"repository":"xtimor/openclaw-all-cli","workflowFilename":"release.yml"}}'
    ;;
esac
`,
  gh: `#!/usr/bin/env bash
echo "gh $* | token=\${NODE_AUTH_TOKEN:-}" >>"$STUB_LOG"
[ "\${STUB_GH_FAIL:-0}" = 1 ] && [ "$1 $2" = "release create" ] && { echo "HTTP 422: Validation Failed" >&2; exit 1; }
# Keep the notes file's content: the script removes its work directory on exit.
while [ $# -gt 0 ]; do
  if [ "$1" = "--notes-file" ]; then cat "$2" >"$STUB_LOG.notes"; fi
  shift
done
`,
  git: `#!/usr/bin/env bash
echo "git $*" >>"$STUB_LOG"
case "$1" in
  rev-parse)
    case "$*" in
      *refs/tags/*) [ "\${STUB_TAG_MISSING:-0}" = 1 ] && exit 1; echo "\${STUB_TAG_COMMIT:-aaa}" ;;
      *HEAD*) echo "\${STUB_HEAD:-aaa}" ;;
      *origin/main*) echo "\${STUB_MAIN_HEAD:-\${STUB_HEAD:-aaa}}" ;;
    esac ;;
  merge-base) [ "\${STUB_ON_MAIN:-1}" = 1 ] ;;
  ls-remote)
    [ "\${STUB_LS_REMOTE_FAIL:-0}" = 1 ] && exit 128
    case "$*" in
      *'refs/tags/v*'*)
        for t in \${STUB_REMOTE_TAGS:-}; do printf 'bbb\trefs/tags/%s\n' "$t"; done ;;
      *) [ "\${STUB_REMOTE_TAG:-0}" = 1 ] && echo "bbb	refs/tags/v9.9.9" ;;
    esac
    exit 0 ;;
esac
`,
  "ci-check.sh": `#!/usr/bin/env bash
echo "ci-check | token=\${NODE_AUTH_TOKEN:-} gh=\${GH_TOKEN:-} oidc=\${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" >>"$STUB_LOG"
[ "\${STUB_CI_FAIL:-0}" = 1 ] && { echo "ci-check failed" >&2; exit 1; }
exit 0
`,
};

let work: string;
let stubBin: string;
let failingNode: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "release-script-"));
  stubBin = join(work, "stub-bin");
  mkdirSync(stubBin);
  for (const name of ["npm", "gh", "git", "clawhub"]) {
    writeFileSync(join(stubBin, name), STUBS[name]!);
    chmodSync(join(stubBin, name), 0o755);
  }
  // A `node` that fails, to show the release notes step cannot fail a release; it logs what it could see.
  failingNode = join(work, "failing-node");
  mkdirSync(failingNode);
  writeFileSync(
    join(failingNode, "node"),
    `#!/usr/bin/env bash
# Only the changelog step gets the failing node; anything else (the ClawHub result parse) runs the real one.
[ "$(basename "$1")" = changelog.mjs ] || exec ${JSON.stringify(process.execPath)} "$@"
echo "node $(basename "$1") $2" >>"$STUB_LOG"
echo "node-env | gh=\${GH_TOKEN:-} oidc=\${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-} token=\${NODE_AUTH_TOKEN:-}" >>"$STUB_LOG"
echo "node: simulated failure" >&2
exit 1
`,
  );
  chmodSync(join(failingNode, "node"), 0o755);
  writeFileSync(join(work, "ci-check.sh"), STUBS["ci-check.sh"]!);
  chmodSync(join(work, "ci-check.sh"), 0o755);
});

afterAll(() => rmSync(work, { recursive: true, force: true }));

interface Outcome {
  status: number | null;
  stdout: string;
  stderr: string;
  calls: string[];
  summary: string;
  out: string[];
  packageJson: string;
  /** What `gh release create --notes-file` was given; empty when the notes were generated. */
  notes: string;
}

let counter = 0;

/** Run the real script from a fresh project copy with the given env. */
function release(env: Record<string, string>, changelog?: string): Outcome {
  const root = join(work, `case-${counter++}`);
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(join(ROOT, "scripts", "release.sh"), join(root, "scripts", "release.sh"));
  chmodSync(join(root, "scripts", "release.sh"), 0o755);
  copyFileSync(join(ROOT, "scripts", "changelog.mjs"), join(root, "scripts", "changelog.mjs"));
  if (changelog !== undefined) writeFileSync(join(root, "CHANGELOG.md"), changelog);
  writeFileSync(join(root, "package.json"), ORIGINAL_PACKAGE_JSON);
  const log = join(root, "calls.log");
  const summaryFile = join(root, "summary.md");
  writeFileSync(log, "");
  const run = spawnSync("bash", [join(root, "scripts", "release.sh")], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: `${stubBin}:${process.env.PATH ?? ""}`,
      HOME: root,
      STUB_LOG: log,
      GITHUB_STEP_SUMMARY: summaryFile,
      RELEASE_CI_CHECK: join(work, "ci-check.sh"),
      RELEASE_NODE_BIN: "",
      RELEASE_STAGE_NPM: "npm",
      RELEASE_CLAWHUB: join(stubBin, "clawhub"),
      STUB_CLAWHUB_BIN: join(stubBin, "clawhub"),
      // What a runner sets; the dry run takes ClawHub's --source-commit from GITHUB_SHA.
      GITHUB_REPOSITORY: "xtimor/openclaw-all-cli",
      GITHUB_SHA: "aaa",
      GH_TOKEN: "gh_JOB_TOKEN",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc_REQUEST_TOKEN",
      ...env,
    },
  });
  const outDir = join(root, "out");
  return {
    status: run.status,
    stdout: run.stdout,
    stderr: run.stderr,
    calls: readFileSync(log, "utf8").split("\n").filter(Boolean),
    summary: existsSync(summaryFile) ? readFileSync(summaryFile, "utf8") : "",
    out: existsSync(outDir) ? readdirSync(outDir) : [],
    packageJson: readFileSync(join(root, "package.json"), "utf8"),
    notes: existsSync(`${log}.notes`) ? readFileSync(`${log}.notes`, "utf8") : "",
  };
}

const called = (o: Outcome, prefix: string) => o.calls.filter((c) => c.startsWith(prefix));
const published = (o: Outcome) => o.calls.filter((c) => /^npm (publish|stage publish) /.test(c));

describe("release.sh", () => {
  describe("DRY_RUN", () => {
    it("workflow_dispatch dry run: checks, pack, npm publish --dry-run, sha256; no publish, no release", () => {
      const o = release({ RELEASE_TAG: "v1.2.3", DRY_RUN: "true", STUB_PACKAGE: "exists" });
      expect(o.status, o.stderr).toBe(0);
      expect(called(o, "ci-check")).toHaveLength(1);
      expect(called(o, "npm version 1.2.3 --no-git-tag-version")).toHaveLength(1);
      const publishes = published(o);
      expect(publishes).toHaveLength(1);
      expect(publishes[0]).toMatch(/^npm publish .*\.tgz --dry-run /);
      expect(called(o, "gh ")).toEqual([]);
      expect(called(o, "npm stage")).toEqual([]);
      expect(o.stdout).toMatch(/sha256:\s+[0-9a-f]{64}/);
      expect(o.summary).toMatch(/sha256: `[0-9a-f]{64}`/);
      expect(o.out).toHaveLength(1);
    });

    it("DRY_RUN unset is a dry run", () => {
      const o = release({ RELEASE_TAG: "v1.2.3" });
      expect(o.status, o.stderr).toBe(0);
      expect(published(o)[0]).toContain("--dry-run");
      expect(called(o, "gh ")).toEqual([]);
    });

    it("a tag v*-dryrun.* is a dry run even with DRY_RUN=false, needs no main check and no token", () => {
      const o = release({
        RELEASE_TAG: "v0.0.1-dryrun.1",
        DRY_RUN: "false",
        STUB_PACKAGE: "missing",
        STUB_ON_MAIN: "0",
        STUB_TAG_MISSING: "1",
      });
      expect(o.status, o.stderr).toBe(0);
      expect(published(o)).toHaveLength(1);
      expect(published(o)[0]).toContain("--dry-run");
      expect(called(o, "gh ")).toEqual([]);
      expect(called(o, "git ")).toEqual([]);
    });

    it("restores package.json (the version stays 0.0.0 in git)", () => {
      const o = release({ RELEASE_TAG: "v1.2.3", DRY_RUN: "true" });
      expect(o.packageJson).toBe(ORIGINAL_PACKAGE_JSON);
    });
  });

  describe("FIRST_RELEASE", () => {
    const base = { RELEASE_TAG: "v1.0.0", DRY_RUN: "false", STUB_PACKAGE: "missing" };

    it("stages the tarball with provenance and the token, then creates the release with the same file", () => {
      const o = release({ ...base, NODE_AUTH_TOKEN: SECRET });
      expect(o.status, o.stderr).toBe(0);
      const publishes = published(o);
      expect(publishes).toHaveLength(1);
      expect(publishes[0]).toMatch(/^npm stage publish .*openclaw-all-cli-stub\.tgz --provenance \| token=npm_STAGE_SECRET/);
      expect(called(o, "npm publish ")).toEqual([]);
      const [gh] = called(o, "gh release create");
      expect(gh).toContain("v1.0.0");
      expect(gh).toContain("openclaw-all-cli-stub.tgz");
      expect(gh).toContain("--generate-notes");
      expect(gh).toMatch(/--notes sha256: [0-9a-f]{64}/);
      expect(gh).not.toContain("--prerelease");
      expect(o.summary).toContain("Staged, not published");
      expect(o.summary).toMatch(/sha256: `[0-9a-f]{64}`/);
    });

    it("the token is used only for npm stage publish and is never printed", () => {
      const o = release({ ...base, NODE_AUTH_TOKEN: SECRET });
      const withSecret = o.calls.filter((c) => c.includes(SECRET));
      expect(withSecret).toHaveLength(1);
      expect(withSecret[0]).toMatch(/^npm stage publish /);
      expect(o.stdout + o.stderr + o.summary).not.toContain(SECRET);
    });

    it("fails before checks and staging, naming NPM_TOKEN, when the secret is missing", () => {
      const o = release(base);
      expect(o.status).not.toBe(0);
      expect(o.stderr).toContain("NPM_TOKEN");
      expect(called(o, "ci-check")).toEqual([]);
      expect(published(o)).toEqual([]);
      expect(called(o, "gh ")).toEqual([]);
    });

    it("a prerelease is staged under dist-tag next and the GitHub release is a prerelease", () => {
      const o = release({ ...base, RELEASE_TAG: "v1.0.0-rc.1", NODE_AUTH_TOKEN: SECRET });
      expect(o.status, o.stderr).toBe(0);
      expect(published(o)[0]).toContain("--provenance --tag next");
      expect(called(o, "gh release create")[0]).toContain("--prerelease");
    });
  });

  describe("NEXT_RELEASE", () => {
    const base = { RELEASE_TAG: "v1.0.1", DRY_RUN: "false", STUB_PACKAGE: "exists" };

    it("publishes with provenance and no token, then creates the release", () => {
      const o = release({ ...base, NODE_AUTH_TOKEN: SECRET });
      expect(o.status, o.stderr).toBe(0);
      const publishes = published(o);
      expect(publishes).toHaveLength(1);
      expect(publishes[0]).toMatch(/^npm publish .*\.tgz --provenance \| token=XXXXX-XXXXX-XXXXX-XXXXX$/);
      expect(o.calls.join("\n")).not.toContain(SECRET);
      expect(called(o, "npm stage")).toEqual([]);
      expect(called(o, "gh release create")).toHaveLength(1);
      expect(o.summary).toContain("Published openclaw-all-cli@1.0.1");
    });

    it("a stable version passes no --tag, so npm keeps its guard against moving latest backwards", () => {
      const o = release(base);
      expect(o.status, o.stderr).toBe(0);
      expect(published(o)[0]).not.toContain("--tag");
    });

    it("the checks get no job credential (GitHub token, OIDC request token, npm token)", () => {
      const o = release({ ...base, NODE_AUTH_TOKEN: SECRET });
      expect(o.status, o.stderr).toBe(0);
      expect(called(o, "ci-check")).toEqual(["ci-check | token=XXXXX-XXXXX-XXXXX-XXXXX gh= oidc="]);
    });

    it("works without any token set", () => {
      const o = release(base);
      expect(o.status, o.stderr).toBe(0);
      expect(published(o)[0]).toContain("--provenance");
    });

    it("a prerelease publishes under dist-tag next", () => {
      const o = release({ ...base, RELEASE_TAG: "v1.1.0-rc.2" });
      expect(o.status, o.stderr).toBe(0);
      expect(published(o)[0]).toContain("--tag next");
      expect(called(o, "gh release create")[0]).toContain("--prerelease");
    });

    it("fails with a pointer to docs/release.md when npm rejects the OIDC login, and creates no release", () => {
      const o = release({ ...base, STUB_PUBLISH_FAIL: "1" });
      expect(o.status).not.toBe(0);
      expect(o.stderr).toContain("docs/release.md");
      expect(called(o, "gh ")).toEqual([]);
    });
  });

  describe("DISPATCHED_RELEASE (the owner approves, the agent dispatches on main)", () => {
    const base = {
      RELEASE_TAG: "v1.0.1",
      DRY_RUN: "false",
      RELEASE_EVENT: "workflow_dispatch",
      STUB_PACKAGE: "exists",
      STUB_TAG_MISSING: "1",
      STUB_HEAD: "ccc",
    };

    it("publishes, then the GitHub release creates the tag at HEAD", () => {
      const o = release(base);
      expect(o.status, o.stderr).toBe(0);
      expect(published(o)[0]).toMatch(/^npm publish .*--provenance/);
      const [gh] = called(o, "gh release create");
      expect(gh).toContain("--target ccc");
      expect(gh).not.toContain("--verify-tag");
      expect(called(o, "git ls-remote --tags origin refs/tags/v1.0.1")).toHaveLength(1);
    });

    it("first release: stages, then the release creates the tag", () => {
      const o = release({ ...base, STUB_PACKAGE: "missing", NODE_AUTH_TOKEN: SECRET });
      expect(o.status, o.stderr).toBe(0);
      expect(published(o)[0]).toMatch(/^npm stage publish /);
      expect(called(o, "gh release create")[0]).toContain("--target ccc");
    });

    it("fails before checks when the tag exists locally", () => {
      const o = release({ ...base, STUB_TAG_MISSING: "0" });
      expect(o.status).not.toBe(0);
      expect(o.stderr).toContain("already exists");
      expect(called(o, "ci-check")).toEqual([]);
      expect(published(o)).toEqual([]);
    });

    it("fails before checks when the tag exists on origin", () => {
      const o = release({ ...base, STUB_REMOTE_TAG: "1" });
      expect(o.status).not.toBe(0);
      expect(o.stderr).toContain("already exists on origin");
      expect(called(o, "ci-check")).toEqual([]);
    });

    it("fails before checks when origin cannot be read", () => {
      const o = release({ ...base, STUB_LS_REMOTE_FAIL: "1" });
      expect(o.status).not.toBe(0);
      expect(o.stderr).toContain("could not read tags from origin");
      expect(called(o, "ci-check")).toEqual([]);
    });

    it("fails before checks when HEAD is behind main's head (stale ref or re-run)", () => {
      const o = release({ ...base, STUB_MAIN_HEAD: "ddd" });
      expect(o.status).not.toBe(0);
      expect(o.stderr).toContain("head of origin/main");
      expect(called(o, "ci-check")).toEqual([]);
    });

    it("a dispatched dry run needs no new tag, no main head, and reads no remote", () => {
      const o = release({ ...base, DRY_RUN: "true", STUB_TAG_MISSING: "0", STUB_REMOTE_TAG: "1", STUB_MAIN_HEAD: "ddd" });
      expect(o.status, o.stderr).toBe(0);
      expect(published(o)[0]).toContain("--dry-run");
      expect(called(o, "git ")).toEqual([]);
      expect(called(o, "gh ")).toEqual([]);
    });

    it("a tag push still requires the tag and verifies it", () => {
      const o = release({ ...base, RELEASE_EVENT: "push", STUB_TAG_MISSING: "0", STUB_HEAD: "aaa" });
      expect(o.status, o.stderr).toBe(0);
      const [gh] = called(o, "gh release create");
      expect(gh).toContain("--verify-tag");
      expect(gh).not.toContain("--target");
      expect(called(o, "git ls-remote")).toEqual([]);
    });
  });

  describe("COMPUTED_TAG (a dispatch with an empty tag releases the next version)", () => {
    const tags = "v0.1.0 v0.1.1 v0.2.0-rc.1";
    const dispatch = { RELEASE_TAG: "", RELEASE_EVENT: "workflow_dispatch", STUB_REMOTE_TAGS: tags };
    const real = { ...dispatch, DRY_RUN: "false", STUB_PACKAGE: "exists", STUB_TAG_MISSING: "1", STUB_HEAD: "ccc" };

    it("next patch: prints v0.1.2 and releases it as if it was given", () => {
      const o = release({ ...real, RELEASE_BUMP: "patch" });
      expect(o.status, o.stderr).toBe(0);
      expect(o.stdout).toContain("release: no tag given; patch bump of v0.1.1 gives v0.1.2");
      expect(called(o, "npm version 0.1.2 --no-git-tag-version")).toHaveLength(1);
      expect(called(o, "git ls-remote --tags --refs origin refs/tags/v*")).toHaveLength(1);
      expect(published(o)[0]).toMatch(/^npm publish .*--provenance/);
      const [gh] = called(o, "gh release create");
      expect(gh).toMatch(/^gh release create v0\.1\.2 /);
      expect(gh).toContain("--target ccc");
      expect(o.summary).toContain("`v0.1.2`");
    });

    it("next minor and major", () => {
      const minor = release({ ...real, RELEASE_BUMP: "minor" });
      expect(minor.status, minor.stderr).toBe(0);
      expect(called(minor, "gh release create")[0]).toMatch(/^gh release create v0\.2\.0 /);
      const major = release({ ...real, RELEASE_BUMP: "major" });
      expect(major.status, major.stderr).toBe(0);
      expect(called(major, "gh release create")[0]).toMatch(/^gh release create v1\.0\.0 /);
    });

    it("sorts versions, not text (v0.1.10 is above v0.1.9)", () => {
      const o = release({ ...dispatch, STUB_REMOTE_TAGS: "v0.1.9 v0.1.10 v0.1.2" });
      expect(o.status, o.stderr).toBe(0);
      expect(o.stdout).toContain("v0.1.11");
    });

    it("ignores tags with leading zeros and non-semver tags", () => {
      const o = release({ ...dispatch, STUB_REMOTE_TAGS: "v0.1.1 v01.5.0 v0.08.0 v1.2.3.4", RELEASE_BUMP: "patch" });
      expect(o.status, o.stderr).toBe(0);
      expect(called(o, "npm version 0.1.2 --no-git-tag-version")).toHaveLength(1);
    });

    it("no stable tag (none, or only prereleases and -dryrun.): base 0.0.0, patch gives v0.0.1", () => {
      for (const remote of ["", "v0.1.0-rc.1 v0.0.1-dryrun.1 v2.0.0-beta.1"]) {
        const o = release({ ...dispatch, STUB_REMOTE_TAGS: remote });
        expect(o.status, o.stderr).toBe(0);
        expect(called(o, "npm version 0.0.1 --no-git-tag-version")).toHaveLength(1);
      }
    });

    it("bump unset is patch", () => {
      const o = release(dispatch);
      expect(o.status, o.stderr).toBe(0);
      expect(called(o, "npm version 0.1.2 --no-git-tag-version")).toHaveLength(1);
    });

    it("a dispatched dry run computes the tag too, and still publishes nothing", () => {
      const o = release({ ...dispatch, DRY_RUN: "true", RELEASE_BUMP: "minor" });
      expect(o.status, o.stderr).toBe(0);
      expect(called(o, "npm version 0.2.0 --no-git-tag-version")).toHaveLength(1);
      expect(published(o)[0]).toContain("--dry-run");
      expect(called(o, "gh ")).toEqual([]);
    });

    it("a bad bump fails before any check and names the allowed values", () => {
      const o = release({ ...real, RELEASE_BUMP: "huge" });
      expect(o.status).not.toBe(0);
      expect(o.stderr).toMatch(/patch, minor, or major/);
      expect(o.calls).toEqual([]);
    });

    it("an empty tag on a tag push fails", () => {
      for (const env of [{ RELEASE_EVENT: "push" }, {}] as Record<string, string>[]) {
        const o = release({ RELEASE_TAG: "", DRY_RUN: "false", STUB_REMOTE_TAGS: tags, ...env });
        expect(o.status).not.toBe(0);
        expect(o.stderr).toContain("a tag push needs a tag");
        expect(o.calls).toEqual([]);
      }
    });

    it("fails before checks when origin cannot be read, and releases nothing", () => {
      const o = release({ ...real, STUB_LS_REMOTE_FAIL: "1" });
      expect(o.status).not.toBe(0);
      expect(o.stderr).toContain("could not read tags from origin");
      expect(called(o, "ci-check")).toEqual([]);
      expect(published(o)).toEqual([]);
      expect(called(o, "gh ")).toEqual([]);
    });

    it("an explicit tag ignores the bump and reads no tag list", () => {
      const o = release({ ...real, RELEASE_TAG: "v1.0.1", RELEASE_BUMP: "major" });
      expect(o.status, o.stderr).toBe(0);
      expect(called(o, "npm version 1.0.1 --no-git-tag-version")).toHaveLength(1);
      expect(called(o, "git ls-remote --tags --refs")).toEqual([]);
      const bad = release({ ...real, RELEASE_TAG: "v1.0.1", RELEASE_BUMP: "huge" });
      expect(bad.status, bad.stderr).toBe(0);
    });
  });

  describe("RELEASE_NOTES (CHANGELOG.md feeds the GitHub release)", () => {
    const changelog = [
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "### Added",
      "",
      "- Pending line.",
      "",
      "## 1.0.1 - 2026-02-02",
      "",
      "### Fixed",
      "",
      "- Named line.",
      "",
    ].join("\n");
    const emptyUnreleased = "# Changelog\n\n## Unreleased\n\n### Added\n\n## 1.0.0 - 2026-01-01\n\n- Old.\n";
    const real = { RELEASE_TAG: "v1.0.1", DRY_RUN: "false", RELEASE_EVENT: "workflow_dispatch", STUB_PACKAGE: "exists", STUB_TAG_MISSING: "1", STUB_HEAD: "ccc" };

    it("the section named for the version is the notes, with the sha256 line and no generated notes", () => {
      const o = release(real, changelog);
      expect(o.status, o.stderr).toBe(0);
      const [gh] = called(o, "gh release create");
      expect(gh).toContain("--notes-file");
      expect(gh).not.toContain("--generate-notes");
      expect(o.notes).toMatch(/^### Fixed\n\n- Named line\.\n\nsha256: [0-9a-f]{64} \(openclaw-all-cli-stub\.tgz\)\n$/);
      expect(o.notes).not.toContain("Pending line");
      expect(o.stdout).toContain("release notes: CHANGELOG.md, section 1.0.1");
      expect(o.summary).toContain("Release notes: CHANGELOG.md, section 1.0.1");
      expect(o.summary).not.toContain("still lists");
    });

    it("an empty tag computes the version and finds its section", () => {
      const o = release({ ...real, RELEASE_TAG: "", STUB_REMOTE_TAGS: "v1.0.0" }, changelog);
      expect(o.status, o.stderr).toBe(0);
      expect(called(o, "gh release create")[0]).toMatch(/^gh release create v1\.0\.1 /);
      expect(o.notes).toContain("- Named line.");
    });

    it("with no section for the version, Unreleased is the notes and the summary asks for a stamp", () => {
      const o = release({ ...real, RELEASE_TAG: "v1.0.2" }, changelog);
      expect(o.status, o.stderr).toBe(0);
      expect(o.notes).toMatch(/^### Added\n\n- Pending line\.\n\nsha256: /);
      expect(o.stdout).toContain("release notes: CHANGELOG.md, Unreleased");
      expect(o.stdout).toContain("stamp them as 1.0.2");
      expect(o.summary).toContain("still lists these lines under Unreleased");
    });

    it("an empty Unreleased, or no changelog, or no lines at all: generated notes and the release still runs", () => {
      const cases: Array<[string, string | undefined]> = [
        ["empty Unreleased", emptyUnreleased],
        ["no file", undefined],
        ["an empty file", ""],
        ["not a changelog", "just text\n"],
      ];
      for (const [name, text] of cases) {
        const o = release({ ...real, RELEASE_TAG: "v1.0.2" }, text);
        expect(o.status, `${name}: ${o.stderr}`).toBe(0);
        const [gh] = called(o, "gh release create");
        expect(gh, name).toContain("--generate-notes");
        expect(gh, name).toMatch(/--notes sha256: [0-9a-f]{64}/);
        expect(gh, name).not.toContain("--notes-file");
        expect(o.notes, name).toBe("");
        expect(o.stdout, name).toContain("release notes: generated by GitHub");
        expect(o.summary, name).toContain("Release notes: generated by GitHub");
      }
    });

    it("a first release, a prerelease, and a tag push use the changelog the same way", () => {
      const first = release({ ...real, STUB_PACKAGE: "missing", NODE_AUTH_TOKEN: SECRET }, changelog);
      expect(first.status, first.stderr).toBe(0);
      expect(first.notes).toContain("- Named line.");
      const rc = release({ ...real, RELEASE_TAG: "v1.1.0-rc.1" }, changelog);
      expect(rc.status, rc.stderr).toBe(0);
      expect(rc.notes).toContain("- Pending line.");
      expect(called(rc, "gh release create")[0]).toContain("--prerelease");
      const push = release({ ...real, RELEASE_EVENT: "push", STUB_TAG_MISSING: "0", STUB_HEAD: "aaa" }, changelog);
      expect(push.status, push.stderr).toBe(0);
      expect(called(push, "gh release create")[0]).toContain("--verify-tag");
      expect(push.notes).toContain("- Named line.");
    });

    it("a dry run prints the notes it would use and creates no release", () => {
      const o = release({ RELEASE_TAG: "v1.0.2", DRY_RUN: "true" }, changelog);
      expect(o.status, o.stderr).toBe(0);
      expect(o.stdout).toContain("release notes: CHANGELOG.md, Unreleased");
      expect(o.stdout).toContain("- Pending line.");
      expect(called(o, "gh ")).toEqual([]);
    });

    it("a node that fails never fails the release, and the changelog step gets no job credential", () => {
      const o = release({ ...real, RELEASE_TAG: "v1.0.2", NODE_AUTH_TOKEN: SECRET, PATH: `${failingNode}:${stubBin}:${process.env.PATH ?? ""}` }, changelog);
      expect(o.status, o.stderr).toBe(0);
      expect(called(o, "gh release create")[0]).toContain("--generate-notes");
      expect(o.stdout).toContain("release notes: generated by GitHub");
      expect(called(o, "node ")).toEqual(["node changelog.mjs section"]);
      expect(called(o, "node-env")).toEqual(["node-env | gh= oidc= token=XXXXX-XXXXX-XXXXX-XXXXX"]);
      expect(o.calls.join("\n")).not.toContain(SECRET);
    });
  });

  describe("CLAWHUB (each release also publishes to ClawHub, ticket 3.31)", () => {
    const real = { RELEASE_TAG: "v1.0.1", DRY_RUN: "false", RELEASE_EVENT: "workflow_dispatch", STUB_PACKAGE: "exists", STUB_TAG_MISSING: "1", STUB_HEAD: "ccc" };
    const clawhubCalls = (o: Outcome, sub: string) => called(o, `clawhub package ${sub}`);
    const indexOf = (o: Outcome, prefix: string) => o.calls.findIndex((c) => c.startsWith(prefix));
    const shaCount = (text: string) => (text.match(/[0-9a-f]{64}/g) ?? []).length;
    /** How often the tarball's own sha256 (the summary's `sha256:` line) appears in the summary. */
    const tarballShaCount = (summary: string) => {
      const sha = summary.match(/- sha256: `([0-9a-f]{64})`/)?.[1];
      return sha ? summary.split(sha).length - 1 : 0;
    };

    it("dry run: checks the tarball with clawhub --dry-run locally, prints the real command, publishes nothing", () => {
      const o = release({ RELEASE_TAG: "v1.2.3", DRY_RUN: "true", CLAWHUB_TOKEN: CLAWHUB_SECRET });
      expect(o.status, o.stderr).toBe(0);
      const publishes = clawhubCalls(o, "publish");
      expect(publishes).toHaveLength(1);
      expect(publishes[0]).toMatch(/^clawhub package publish \/\S+\/out\/openclaw-all-cli-stub\.tgz --family code-plugin --dry-run --json --tags latest --source-repo xtimor\/openclaw-all-cli --source-commit aaa \|/);
      expect(publishes[0]).not.toContain("--wait");
      // No token, no config, no OIDC: nothing reaches a registry.
      expect(publishes[0]).toMatch(/\| config=none gh= oidc= env=$/);
      expect(clawhubCalls(o, "trusted-publisher")).toEqual([]);
      expect(called(o, "gh ")).toEqual([]);
      expect(o.stdout).toMatch(/clawhub package publish \/\S+\.tgz --family code-plugin --wait --json --tags latest --source-repo xtimor\/openclaw-all-cli --source-commit aaa --source-ref refs\/tags\/v1\.2\.3 --manual-override-reason /);
      expect(o.summary).toContain("- ClawHub: dry run passed (no registry call); a real run publishes with the CLAWHUB_TOKEN secret");
      expect(o.summary).toContain("ClawHub: dry run only, nothing was published.");
      expect(o.stdout + o.stderr + o.summary).not.toContain(CLAWHUB_SECRET);
    });

    it("dry run without a token: the real command uses OIDC and gives no override reason; GITHUB_REF is the source ref", () => {
      const o = release({ RELEASE_TAG: "v1.2.3", DRY_RUN: "true", GITHUB_REF: "refs/heads/main" });
      expect(o.status, o.stderr).toBe(0);
      expect(clawhubCalls(o, "publish")[0]).toContain("--source-commit aaa --source-ref refs/heads/main |");
      expect(o.summary).toContain("a real run publishes through trusted publishing (OIDC, no token)");
      expect(o.summary).not.toContain("--manual-override-reason");
    });

    it("a dry run that ClawHub refuses fails the run, after the summary", () => {
      const o = release({ RELEASE_TAG: "v1.2.3", DRY_RUN: "true", STUB_CLAWHUB_DRY_FAIL: "1" });
      expect(o.status).toBe(1);
      expect(o.summary).toContain("- ClawHub: failed (see below)");
      expect(o.summary).toContain("ClawHub dry run failed: Error: openclaw.build.openclawVersion is required");
      expect(o.summary.split("openclaw.build.openclawVersion is required")).toHaveLength(2);
      expect(o.stderr).toContain("ClawHub dry run failed");
    });

    it("real, token set: publishes after npm and the GitHub release, then sets the trusted publisher", () => {
      const o = release({ ...real, CLAWHUB_TOKEN: CLAWHUB_SECRET });
      expect(o.status, o.stderr).toBe(0);
      const [publish] = clawhubCalls(o, "publish");
      expect(publish).toMatch(/^clawhub package publish \/\S+\/out\/openclaw-all-cli-stub\.tgz --family code-plugin --wait --json --tags latest --source-repo xtimor\/openclaw-all-cli --source-commit ccc --source-ref refs\/tags\/v1\.0\.1 --manual-override-reason Release v1\.0\.1 from xtimor\/openclaw-all-cli release\.yml with the CLAWHUB_TOKEN secret/);
      // A token publish never uses OIDC, so the CLI gets no OIDC request variables.
      expect(publish).toContain(`| config={"registry":"https://clawhub.ai","token":"${CLAWHUB_SECRET}"} mode=600 gh= oidc= env=`);
      const [trusted] = clawhubCalls(o, "trusted-publisher");
      expect(trusted).toMatch(/^clawhub package trusted-publisher set openclaw-all-cli --repository xtimor\/openclaw-all-cli --workflow-filename release\.yml \| config=\{.*\} mode=600 gh= oidc= env=$/);
      // Order: npm, then the GitHub release, then ClawHub, then the trusted publisher.
      const order = ["npm publish ", "gh release create", "clawhub package publish", "clawhub package trusted-publisher"].map((p) => indexOf(o, p));
      expect(order.every((i) => i >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(o.summary).toContain("- npm: `openclaw-all-cli@1.0.1` published (tag `latest`)");
      expect(o.summary).toContain("- ClawHub: `openclaw-all-cli@1.0.1` published (status `published`, tag `latest`, via the CLAWHUB_TOKEN secret), same sha256");
      expect(o.summary).toContain("Delete the CLAWHUB_TOKEN secret");
      expect(shaCount(o.summary)).toBe(1);
    });

    it("the ClawHub token reaches only the clawhub commands, never the checks, notes, install, npm, gh, or the output", () => {
      const o = release({ ...real, RELEASE_TAG: "v1.0.2", CLAWHUB_TOKEN: CLAWHUB_SECRET, RELEASE_CLAWHUB: "", PATH: `${failingNode}:${stubBin}:${process.env.PATH ?? ""}` }, "# Changelog\n\n## Unreleased\n\n- Line.\n");
      expect(o.status, o.stderr).toBe(0);
      const withSecret = o.calls.filter((c) => c.includes(CLAWHUB_SECRET));
      expect(withSecret.length).toBe(2);
      for (const c of withSecret) expect(c).toMatch(/^clawhub package (publish|trusted-publisher) /);
      for (const c of called(o, "clawhub ")) expect(c).toMatch(/ env=$/);
      expect(called(o, "npm-install-env")).toEqual(["npm-install-env | gh= oidc= clawhub= config="]);
      expect(called(o, "ci-check")).toEqual(["ci-check | token=XXXXX-XXXXX-XXXXX-XXXXX gh= oidc="]);
      expect(called(o, "node-env")).toEqual(["node-env | gh= oidc= token=XXXXX-XXXXX-XXXXX-XXXXX"]);
      expect(o.stdout + o.stderr + o.summary + o.notes).not.toContain(CLAWHUB_SECRET);
    });

    it("real, no token: the same publish without config or override reason (OIDC), no trusted publisher call", () => {
      const o = release(real);
      expect(o.status, o.stderr).toBe(0);
      const [publish] = clawhubCalls(o, "publish");
      expect(publish).toMatch(/--source-ref refs\/tags\/v1\.0\.1 \| config=none gh= oidc=oidc_REQUEST_TOKEN env=$/);
      expect(publish).not.toContain("--manual-override-reason");
      expect(clawhubCalls(o, "trusted-publisher")).toEqual([]);
      expect(o.summary).toContain("via trusted publishing (OIDC)), same sha256");
      expect(shaCount(o.summary)).toBe(1);
    });

    it("the default CLI is clawhub@CLAWHUB_VERSION installed without scripts or credentials, run under node", () => {
      const o = release({ ...real, RELEASE_CLAWHUB: "" });
      expect(o.status, o.stderr).toBe(0);
      const [install] = called(o, "npm install ");
      expect(install).toMatch(/^npm install clawhub@0\.25\.1 --ignore-scripts --no-audit --no-fund --prefix \/\S+\/clawhub \|/);
      expect(called(o, "npm-install-env")).toEqual(["npm-install-env | gh= oidc= clawhub= config="]);
      expect(called(o, "clawdhub.js under node")).toHaveLength(1);
      expect(clawhubCalls(o, "publish")).toHaveLength(1);
      expect(indexOf(o, "gh release create")).toBeLessThan(indexOf(o, "npm install "));
      const pinned = release({ ...real, RELEASE_CLAWHUB: "", CLAWHUB_VERSION: "9.9.9" });
      expect(called(pinned, "npm install ")[0]).toMatch(/^npm install clawhub@9\.9\.9 /);
    });

    it("an install failure is a ClawHub failure: summary first, exit 1", () => {
      const o = release({ ...real, RELEASE_CLAWHUB: "", STUB_CLAWHUB_INSTALL_FAIL: "1" });
      expect(o.status).toBe(1);
      expect(called(o, "gh release create")).toHaveLength(1);
      expect(o.summary).toContain("ClawHub failed: could not install clawhub@0.25.1");
    });

    for (const [mode, error] of [
      ["fail", "Unauthorized (401)"],
      ["blocked", "ClawHub publication blocked for openclaw-all-cli@1.0.1"],
      ["timeout", "Timed out after 1800s"],
    ] as const) {
      it(`ClawHub ${mode}: npm and the GitHub release stay, the summary names the error and the recovery, exit 1`, () => {
        const o = release({ ...real, CLAWHUB_TOKEN: CLAWHUB_SECRET, STUB_CLAWHUB_PUBLISH: mode });
        expect(o.status).toBe(1);
        expect(published(o)).toHaveLength(1);
        expect(called(o, "gh release create")).toHaveLength(1);
        expect(clawhubCalls(o, "trusted-publisher")).toEqual([]);
        expect(o.calls.some((c) => /unpublish|delete/.test(c.split(" | ")[0]!))).toBe(false);
        expect(o.summary).toContain("- npm: `openclaw-all-cli@1.0.1` published");
        expect(o.summary).toContain("- ClawHub: failed (see below)");
        expect(o.summary).toContain(`npm and the GitHub release are done; ClawHub failed: Error: ${error}`);
        expect(o.summary.split(error)).toHaveLength(2);
        expect(o.stdout).not.toContain("ClawHub failed");
        expect(o.summary).toContain('Recovery: docs/release.md, "ClawHub"');
        expect(o.stderr).toContain("ClawHub failed");
        expect(shaCount(o.summary)).toBe(1);
        expect(o.stdout + o.stderr + o.summary).not.toContain(CLAWHUB_SECRET);
      });
    }

    it("a ClawHub sha256 that differs from the tarball fails the run like a refused publish", () => {
      const o = release({ ...real, STUB_CLAWHUB_PUBLISH: "sha" });
      expect(o.status).toBe(1);
      expect(o.summary).toContain("ClawHub reports sha256 0000000000000000000000000000000000000000000000000000000000000000");
      expect(o.summary).toContain("npm and the GitHub release are done; ClawHub failed:");
      expect(tarballShaCount(o.summary)).toBe(1);
    });

    it("a published package whose sha256 ClawHub does not report passes, with the command to check it", () => {
      const o = release({ ...real, STUB_CLAWHUB_PUBLISH: "nosha" });
      expect(o.status, o.stderr).toBe(0);
      expect(o.summary).toContain("ClawHub reported no sha256: check it with `clawhub package verify openclaw-all-cli-stub.tgz --package openclaw-all-cli --version 1.0.1`");
      expect(shaCount(o.summary)).toBe(1);
    });

    it("a pasted token with surrounding whitespace or a trailing CR/LF is trimmed, so the config stays valid JSON", () => {
      const o = release({ ...real, CLAWHUB_TOKEN: ` ${CLAWHUB_SECRET}\r\n` });
      expect(o.status, o.stderr).toBe(0);
      expect(clawhubCalls(o, "publish")[0]).toContain(`| config={"registry":"https://clawhub.ai","token":"${CLAWHUB_SECRET}"} mode=600 `);
    });

    it("a publish that ends without publicationStatus published fails the run", () => {
      const o = release({ ...real, STUB_CLAWHUB_PUBLISH: "pending" });
      expect(o.status).toBe(1);
      expect(o.summary).toContain('is "pending" on ClawHub, not published');
    });

    it("a trusted publisher failure is a warning with the manual command; the run stays green", () => {
      const o = release({ ...real, CLAWHUB_TOKEN: CLAWHUB_SECRET, STUB_CLAWHUB_TP_FAIL: "1" });
      expect(o.status, o.stderr).toBe(0);
      expect(o.stdout).toContain("::warning title=ClawHub trusted publisher::");
      expect(o.summary).toContain("Warning: the ClawHub trusted publisher was not set (Error: Forbidden (403): not a package owner)");
      expect(o.summary).toContain("`clawhub package trusted-publisher set openclaw-all-cli --repository xtimor/openclaw-all-cli --workflow-filename release.yml`");
      expect(o.summary).toContain("- ClawHub: `openclaw-all-cli@1.0.1` published");
    });

    it("a prerelease publishes under the ClawHub tag next", () => {
      const o = release({ ...real, RELEASE_TAG: "v1.1.0-rc.1" });
      expect(o.status, o.stderr).toBe(0);
      expect(clawhubCalls(o, "publish")[0]).toContain("--tags next ");
      const dry = release({ RELEASE_TAG: "v1.1.0-rc.1", DRY_RUN: "true" });
      expect(clawhubCalls(dry, "publish")[0]).toContain("--tags next ");
    });

    it("the first (staged) npm release skips ClawHub, and the summary says so", () => {
      const o = release({ ...real, STUB_PACKAGE: "missing", NODE_AUTH_TOKEN: SECRET, CLAWHUB_TOKEN: CLAWHUB_SECRET });
      expect(o.status, o.stderr).toBe(0);
      expect(called(o, "clawhub ")).toEqual([]);
      expect(called(o, "npm install ")).toEqual([]);
      expect(o.summary).toContain("- ClawHub: skipped: the first npm release is only staged");
      expect(shaCount(o.summary)).toBe(1);
    });

    it("an npm or GitHub release failure stops before ClawHub", () => {
      const npm = release({ ...real, STUB_PUBLISH_FAIL: "1", CLAWHUB_TOKEN: CLAWHUB_SECRET });
      expect(npm.status).not.toBe(0);
      expect(called(npm, "clawhub ")).toEqual([]);
      const gh = release({ ...real, STUB_GH_FAIL: "1", CLAWHUB_TOKEN: CLAWHUB_SECRET });
      expect(gh.status).not.toBe(0);
      expect(called(gh, "gh release create")).toHaveLength(1);
      expect(called(gh, "clawhub ")).toEqual([]);
    });
  });

  describe("BAD_TAG", () => {
    for (const tag of ["v1.2", "1.2.3", "v1.2.3.4", "v01.2.3", "v1.2.3-", "vX.Y.Z", "v1.2.3+build"]) {
      it(`rejects "${tag}" before any check`, () => {
        const o = release({ RELEASE_TAG: tag, DRY_RUN: "false", NODE_AUTH_TOKEN: SECRET });
        expect(o.status).not.toBe(0);
        expect(o.stderr).toContain("vMAJOR.MINOR.PATCH");
        expect(o.calls).toEqual([]);
      });
    }

    it("rejects a real release whose commit is not on origin/main", () => {
      const o = release({ RELEASE_TAG: "v1.2.3", DRY_RUN: "false", STUB_ON_MAIN: "0", NODE_AUTH_TOKEN: SECRET });
      expect(o.status).not.toBe(0);
      expect(o.stderr).toContain("origin/main");
      expect(called(o, "ci-check")).toEqual([]);
      expect(published(o)).toEqual([]);
      expect(called(o, "gh ")).toEqual([]);
    });

    it("rejects a real release when the checkout is not the tagged commit", () => {
      const o = release({ RELEASE_TAG: "v1.2.3", DRY_RUN: "false", STUB_HEAD: "bbb", STUB_TAG_COMMIT: "aaa" });
      expect(o.status).not.toBe(0);
      expect(o.stderr).toContain("v1.2.3");
      expect(called(o, "ci-check")).toEqual([]);
    });

    it("rejects a real release for a tag that does not exist", () => {
      const o = release({ RELEASE_TAG: "v1.2.3", DRY_RUN: "false", STUB_TAG_MISSING: "1" });
      expect(o.status).not.toBe(0);
      expect(called(o, "ci-check")).toEqual([]);
    });

    it("rejects an invalid DRY_RUN value", () => {
      const o = release({ RELEASE_TAG: "v1.2.3", DRY_RUN: "yes" });
      expect(o.status).not.toBe(0);
      expect(o.stderr).toContain("DRY_RUN");
    });
  });

  describe("VERSION_EXISTS", () => {
    for (const dry of ["true", "false"]) {
      it(`fails before checks and publish, naming the version (DRY_RUN=${dry})`, () => {
        const o = release({ RELEASE_TAG: "v1.2.3", DRY_RUN: dry, STUB_VERSION_EXISTS: "1", NODE_AUTH_TOKEN: SECRET });
        expect(o.status).not.toBe(0);
        expect(o.stderr).toContain("openclaw-all-cli@1.2.3");
        expect(called(o, "ci-check")).toEqual([]);
        expect(published(o)).toEqual([]);
        expect(called(o, "gh ")).toEqual([]);
      });
    }
  });

  describe("failures and guards", () => {
    it("a failing check stops the release before pack and publish", () => {
      const o = release({ RELEASE_TAG: "v1.0.1", DRY_RUN: "false", STUB_CI_FAIL: "1" });
      expect(o.status).not.toBe(0);
      expect(called(o, "npm pack")).toEqual([]);
      expect(published(o)).toEqual([]);
      expect(called(o, "gh ")).toEqual([]);
      expect(o.packageJson).toBe(ORIGINAL_PACKAGE_JSON);
    });

    it("an npm error that is not a 404 is not read as a first release", () => {
      const o = release({ RELEASE_TAG: "v1.0.1", DRY_RUN: "false", STUB_PACKAGE: "broken", NODE_AUTH_TOKEN: SECRET });
      expect(o.status).not.toBe(0);
      expect(published(o)).toEqual([]);
    });

    it("never calls npm unpublish, and every real publish carries --provenance", () => {
      const runs = [
        release({ RELEASE_TAG: "v1.0.0", DRY_RUN: "false", STUB_PACKAGE: "missing", NODE_AUTH_TOKEN: SECRET }),
        release({ RELEASE_TAG: "v1.0.1", DRY_RUN: "false", STUB_PACKAGE: "exists" }),
        release({ RELEASE_TAG: "v1.0.2-rc.1", DRY_RUN: "false", STUB_PACKAGE: "exists" }),
      ];
      for (const o of runs) {
        expect(o.status, o.stderr).toBe(0);
        expect(o.calls.some((c) => c.includes("unpublish"))).toBe(false);
        expect(o.calls.some((c) => /^clawhub .*\b(delete|unpublish)\b/.test(c.split(" | ")[0]!))).toBe(false);
        const real = published(o).filter((c) => !c.includes("--dry-run"));
        expect(real).toHaveLength(1);
        expect(real[0]).toContain("--provenance");
      }
    });

    it("publishes and attaches the same file (one tarball in out/)", () => {
      const o = release({ RELEASE_TAG: "v1.0.1", DRY_RUN: "false" });
      const file = /(\S*openclaw-all-cli-stub\.tgz)/;
      expect(published(o)[0]!.match(file)?.[1]).toBe(called(o, "gh release create")[0]!.match(file)?.[1]);
      expect(o.out).toEqual(["openclaw-all-cli-stub.tgz"]);
    });
  });
});

describe("release.sh syntax", () => {
  it("parses with bash -n", () => {
    const run = spawnSync("bash", ["-n", join(ROOT, "scripts", "release.sh")], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
  });
});
