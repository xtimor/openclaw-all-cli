import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * scripts/release.sh against stub `npm`, `gh`, and `git` and a stub check script, in a throwaway
 * copy of the project layout. Covers every row of the release matrix (ticket 3.4). Nothing here
 * touches the network, the real npm registry, or the real repository.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "npm_STAGE_SECRET_0123456789";
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
esac
`,
  gh: `#!/usr/bin/env bash
echo "gh $* | token=\${NODE_AUTH_TOKEN:-}" >>"$STUB_LOG"
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
    [ "\${STUB_REMOTE_TAG:-0}" = 1 ] && echo "bbb	refs/tags/v9.9.9"
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

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "release-script-"));
  stubBin = join(work, "stub-bin");
  mkdirSync(stubBin);
  for (const name of ["npm", "gh", "git"]) {
    writeFileSync(join(stubBin, name), STUBS[name]!);
    chmodSync(join(stubBin, name), 0o755);
  }
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
}

let counter = 0;

/** Run the real script from a fresh project copy with the given env. */
function release(env: Record<string, string>): Outcome {
  const root = join(work, `case-${counter++}`);
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(join(ROOT, "scripts", "release.sh"), join(root, "scripts", "release.sh"));
  chmodSync(join(root, "scripts", "release.sh"), 0o755);
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

  describe("BAD_TAG", () => {
    for (const tag of ["v1.2", "1.2.3", "v1.2.3.4", "v01.2.3", "v1.2.3-", "vX.Y.Z", "v1.2.3+build", ""]) {
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
