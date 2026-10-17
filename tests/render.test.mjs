// The single test seam: render the template, then judge the rendered repo only
// through its own check and its files. The one exception is the guard that the
// template itself ships no generated output.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const templateRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workDirs = [];
const FIVE_MINUTES = 5 * 60 * 1000;

// Environment for every subprocess that touches a scratch repository. Git's
// repository-location variables (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, ...)
// are inherited when the tests run from a Git hook, and would point `git reset
// --hard`, `git clean` and `git commit` at the invoking repository instead of
// the scratch directory.
const scratchEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));

function scratchDir() {
  const dir = mkdtempSync(join(tmpdir(), "copier-skill-repo-"));
  workDirs.push(dir);
  return dir;
}

// Render from a plain copy of the working tree so the result never depends on
// git tags, HEAD or uncommitted changes in this checkout.
function render(data, destName, extraArgs = []) {
  const source = scratchDir();
  cpSync(join(templateRoot, "copier.yml"), join(source, "copier.yml"));
  cpSync(join(templateRoot, "template"), join(source, "template"), { recursive: true });
  // The destination folder name is the default repo_name, so a test can pick it.
  const dest = destName ? join(scratchDir(), destName) : scratchDir();
  // A data file (JSON is valid YAML) delivers answers exactly as written, so
  // control characters reach the template's validators instead of failing in
  // the command-line parser first.
  const dataFile = join(scratchDir(), "answers.json");
  writeFileSync(dataFile, JSON.stringify(data));
  execFileSync("copier", ["copy", "--defaults", "--trust", "--quiet", ...extraArgs, "--data-file", dataFile, source, dest], {
    env: scratchEnv(),
    stdio: extraArgs.length ? ["ignore", "ignore", "pipe"] : "inherit",
    timeout: FIVE_MINUTES,
  });
  return dest;
}

// Renders with tasks skipped, so only Copier's own prompt-time validation can
// reject the answers, never the later `npm run generate`, and checks that the
// rejection names the expected question.
function assertRejected(question, overrides) {
  const answers = { repo_name: "demo-skills", description: "Demo.", ...overrides };
  assert.throws(
    () => render(answers, undefined, ["--skip-tasks"]),
    (error) => String(error.stderr).includes(`Validation error for question '${question}'`),
  );
}

// What CI will run in a fresh checkout: a clean install from the committed
// lockfile, then the repo's own check.
function installAndCheck(repo) {
  const options = { cwd: repo, stdio: "inherit", timeout: FIVE_MINUTES };
  execFileSync("npm", ["ci"], options);
  execFileSync("npm", ["run", "check"], options);
}

const readJson = (dir, path) => JSON.parse(readFileSync(join(dir, path), "utf8"));

// True when the lower bound of `declared` is at least that of `needed`, so the
// declared range admits no Node release the dependency rejects. Both are
// `>=x[.y[.z]]` ranges, compared on the complete version; anything else throws
// rather than passing silently.
function nodeFloorCovers(declared, needed) {
  const floor = (range) => {
    const match = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range.trim());
    if (!match) throw new Error(`unsupported Node range ${JSON.stringify(range)}: expected >=x[.y[.z]]`);
    return [match[1], match[2] ?? 0, match[3] ?? 0].map(Number);
  };
  const [d, n] = [floor(declared), floor(needed)];
  for (let i = 0; i < 3; i++) if (d[i] !== n[i]) return d[i] > n[i];
  return true;
}

after(() => workDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("rendered with default answers", () => {
  let repo;
  before(() => {
    repo = render({ repo_name: "demo-skills", description: "Demo skills for testing." });
  });

  test("passes its own check with no generated-output drift", () => {
    installAndCheck(repo);
  });

  test("ships the placeholder skill under its default name", () => {
    assert.ok(existsSync(join(repo, ".ai-rulez/skills/hello/SKILL.md")));
    assert.ok(existsSync(join(repo, "skills/hello/SKILL.md")));
  });

  test("derives repository URL, marketplace name and display name from the answers", () => {
    const plugin = readJson(repo, ".claude-plugin/plugin.json");
    assert.equal(plugin.name, "demo-skills");
    assert.equal(plugin.repository, "https://github.com/hasansezertasan/demo-skills");
    assert.equal(readJson(repo, ".claude-plugin/marketplace.json").name, "demo-skills");
    assert.equal(
      readJson(repo, ".codex-plugin/plugin.json").interface.displayName,
      "Demo Skills",
    );
  });

  test("declares a Node range its locked dependencies support", () => {
    // `npm run generate` and `npm run check` run the locked ai-rulez binary, so
    // the advertised minimum must not be lower than the one ai-rulez needs.
    const lock = readJson(repo, "package-lock.json");
    const needed = lock.packages["node_modules/ai-rulez"].engines.node;
    const declared = readJson(repo, "package.json").engines.node;
    assert.ok(nodeFloorCovers(declared, needed), `engines.node ${declared} admits Node versions below ai-rulez's ${needed}`);
  });

  test("uses package.json as the version source", () => {
    const pkg = readJson(repo, "package.json");
    assert.equal(pkg.version, "0.0.0");
    assert.equal(readJson(repo, ".claude-plugin/plugin.json").version, pkg.version);
    assert.match(pkg.devDependencies["ai-rulez"], /^5\.\d+\.\d+$/);
    assert.ok(pkg.scripts.check && pkg.scripts.generate);
  });

  test("commits an answers file holding exactly the agreed questions", () => {
    const answers = readFileSync(join(repo, ".copier-answers.yml"), "utf8");
    const keys = [...answers.matchAll(/^([a-z_]+):/gm)]
      .map((m) => m[1])
      .filter((key) => !key.startsWith("_"))
      .sort();
    assert.deepEqual(keys, [
      "author_name",
      "author_url",
      "description",
      "github_owner",
      "keywords",
      "license",
      "placeholder_skill",
      "publish_to_npm",
      "repo_name",
    ]);
  });
});

describe("hardened CI", () => {
  let repo;
  const checkFile = ".github/workflows/check.yml";
  const workflow = () => readFileSync(join(repo, checkFile), "utf8");
  const runRepoCheck = () =>
    execFileSync("node", ["scripts/check-repo.mjs"], { cwd: repo, stdio: "pipe", timeout: FIVE_MINUTES });
  // A clean failure: exit status 1, the expected message, and no crash. A thrown
  // error would print the source line holding the message, so stack traces are
  // rejected explicitly.
  const failsWith = (pattern) => (error) =>
    error.status === 1 && !/\n\s+at .*:\d+:\d+/.test(String(error.stderr)) && pattern.test(String(error.stderr));
  before(() => {
    repo = render({ repo_name: "demo-skills", description: "Demo." });
    execFileSync("npm", ["ci"], { cwd: repo, stdio: "inherit", timeout: FIVE_MINUTES });
  });

  // Runs the repository check against the rendered repo with `files` written
  // into it (path -> content, `null` leaves the file alone), then restores it.
  // `pattern: null` expects the check to pass.
  const checkRepo = (files, pattern) => {
    const originals = new Map();
    for (const [path, content] of Object.entries(files)) {
      const full = join(repo, path);
      originals.set(full, existsSync(full) ? readFileSync(full, "utf8") : null);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    try {
      if (pattern) assert.throws(runRepoCheck, failsWith(pattern));
      else runRepoCheck();
    } finally {
      for (const [full, original] of originals) {
        if (original === null) rmSync(full, { force: true });
        else writeFileSync(full, original);
      }
    }
  };
  // Mutates the rendered check workflow; the mutation must change it.
  const mutate = (transform, pattern) => {
    const original = workflow();
    const mutated = transform(original);
    assert.notEqual(mutated, original, "the mutation did not change the workflow");
    checkRepo({ [checkFile]: mutated }, pattern);
  };
  const rejects = (label, transform, pattern) => test(`rejects ${label}`, () => mutate(transform, pattern));
  const accepts = (label, transform) => test(`accepts ${label}`, () => mutate(transform, null));

  const NOT_PINNED = /not pinned by commit SHA/;
  const FLOW = /flow style is not supported/;
  const UNSUPPORTED = /anchors, aliases and tags are not supported|unsupported line|unexpected sequence item|nested block/;
  const UNSCOPED = /unscoped permissions/;
  const SHA = "a".repeat(40);
  const checkout = /- uses: actions\/checkout@[0-9a-f]{40}/;
  const jobPermissions = /^ {4}permissions:\n {6}contents: read$/m;
  const withJobPermissions = (replacement) => (text) => text.replace(jobPermissions, replacement);
  const withStep = (step) => (text) => text.replace("      - run: npm ci\n", `      - run: npm ci\n${step}`);
  const withJob = (job) => (text) => text.replace(/^jobs:\n/m, `jobs:\n${job}`);
  const reusableJob = (ref) => withJob(`  extra:\n    permissions: {}\n    uses: ${ref}\n`);

  describe("the rendered workflow", () => {
    test("pins every action reference by commit SHA", () => {
      const uses = [...workflow().matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map((m) => m[1]);
      assert.ok(uses.length > 0);
      for (const ref of uses) assert.match(ref, /^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40}$/, ref);
    });

    test("denies permissions at the top level and scopes them per job", () => {
      assert.match(workflow(), /^permissions: \{\}$/m);
      assert.match(workflow(), jobPermissions);
    });

    test("runs unfiltered and is callable from another workflow", () => {
      const text = workflow();
      assert.match(text, /^ {2}workflow_call:/m);
      assert.match(text, /^ {2}pull_request:/m);
      // A `push` trigger would run every job twice per pull-request commit, and
      // again on `main`, where release.yml already calls this workflow.
      assert.doesNotMatch(text, /^ {2}push:/m);
      assert.doesNotMatch(text, /^\s*(paths|paths-ignore|branches|branches-ignore|tags):/m);
    });

    test("runs the repository's own check", () => {
      assert.match(workflow(), /run: npm run check$/m);
      assert.match(workflow(), /run: npm ci$/m);
    });

    test("fails when generated output is stale", () => {
      const file = join(repo, "skills/hello/SKILL.md");
      const original = readFileSync(file, "utf8");
      writeFileSync(file, `${original}\nhand edit\n`);
      try {
        assert.throws(
          () => execFileSync("npm", ["run", "check"], { cwd: repo, stdio: "pipe", timeout: FIVE_MINUTES }),
          (error) => /drift|out of date|stale|differ|generate/i.test(String(error.stderr) + String(error.stdout)),
        );
      } finally {
        writeFileSync(file, original);
      }
    });

    test("has a repository check with no dependencies", () => {
      const script = readFileSync(join(repo, "scripts/check-repo.mjs"), "utf8");
      for (const [, specifier] of script.matchAll(/(?:\bfrom|\bimport\s*\(?|\brequire\()\s*["']([^"']+)["']/g)) {
        assert.match(specifier, /^node:/, specifier);
      }
    });

    test("passes its own check", () => runRepoCheck());
  });

  describe("action pinning", () => {
    rejects("an unpinned step", (t) => t.replace(checkout, "- uses: actions/checkout@v4"), NOT_PINNED);
    rejects("an unpinned step behind other keys", (t) => t.replace(checkout, "- name: checkout\n        uses: actions/checkout@v4"), NOT_PINNED);
    rejects("an unpinned step after a short first key", (t) => t.replace(checkout, "- env:\n          X: y\n        uses: actions/checkout@v4"), NOT_PINNED);
    rejects("an unpinned step after a with: first key", (t) => t.replace(checkout, "- with:\n          a: b\n        uses: actions/checkout@v4"), NOT_PINNED);
    rejects("an unpinned step after a folded first key", (t) => t.replace(checkout, "- name: >-\n          Check out\n        uses: actions/checkout@v4"), NOT_PINNED);
    rejects("an unpinned step after a literal first key", (t) => t.replace(checkout, "- if: |\n          true\n        uses: actions/checkout@v4"), NOT_PINNED);
    rejects("an unpinned step whose dash is on its own line", (t) => t.replace(checkout, "-\n        uses: actions/checkout@v4"), NOT_PINNED);
    rejects("an unpinned step with a quoted uses key", (t) => t.replace(checkout, '- "uses": actions/checkout@v4'), NOT_PINNED);
    rejects("an unpinned step under a quoted steps key", (t) => t.replace("    steps:\n", '    "steps":\n').replace(checkout, "- uses: actions/checkout@v4"), NOT_PINNED);
    rejects("a uses value on the next line", (t) => t.replace(checkout, "- uses:\n          actions/checkout@v4"), UNSUPPORTED);
    rejects("a docker image ending in 40 hex characters", (t) => t.replace(checkout, `- uses: docker://evil/img:latest@${SHA}`), NOT_PINNED);
    rejects("a docker image with a short digest", (t) => t.replace(checkout, `- uses: docker://alpine@sha256:${"b".repeat(63)}`), NOT_PINNED);
    rejects("a reference with a second @ revision", (t) => t.replace(checkout, `- uses: actions/checkout@v4@${SHA}`), NOT_PINNED);
    rejects("an unpinned reusable workflow on a job", reusableJob("owner/repo/.github/workflows/build.yml@v1"), NOT_PINNED);
    rejects("an unpinned reusable workflow behind a quoted key", withJob('  extra:\n    permissions: {}\n    "uses": owner/repo/.github/workflows/b.yml@v1\n'), NOT_PINNED);
    rejects("an empty uses value", (t) => t.replace(checkout, "- uses:"), /`uses:` has no value|unsupported|nested block/);
    accepts("a pinned reusable workflow on a job", reusableJob(`owner/repo/.github/workflows/build.yml@${SHA}`));
    accepts("a local reusable workflow on a job", reusableJob("./.github/workflows/build.yml"));
    accepts("a local action", (t) => t.replace(checkout, "- uses: ./.github/actions/setup"));
    accepts("a quoted pinned reference", (t) => t.replace(checkout, `- uses: "actions/checkout@${SHA}"`));
    accepts("a pinned docker image", (t) => t.replace(checkout, `- uses: docker://alpine@sha256:${"c".repeat(64)}`));
    accepts("a pinned reference followed by a comment", (t) => t.replace(checkout, `- uses: actions/checkout@${SHA} # v4`));
    accepts("a uses key that is not a step key", withStep("        env:\n          uses: harmless\n"));
    accepts("a uses key in a matrix entry", (t) => t.replace("    steps:\n", "    strategy:\n      matrix:\n        include:\n          - os: ubuntu-latest\n            uses: ordinary\n    steps:\n"));
    accepts("uses text inside a run block", withStep("      - run: |-\n          echo uses: actions/checkout@v4\n          - uses: actions/checkout@v4\n"));
    accepts("uses text inside a single-line run command", withStep('      - run: echo "uses: actions/checkout@v4"\n'));
    accepts("a commented-out step", withStep("      # - uses: actions/checkout@v4\n"));

    test("rejects an unpinned step in a local composite action", () => {
      checkRepo({ ".github/actions/setup/action.yml": "name: setup\nruns:\n  using: composite\n  steps:\n    - uses: actions/checkout@v4\n" }, NOT_PINNED);
    });

    test("accepts a pinned step in a local composite action", () => {
      checkRepo({ ".github/actions/setup/action.yml": `name: setup\nruns:\n  using: composite\n  steps:\n    - uses: actions/checkout@${SHA}\n` }, null);
    });

    test("ignores YAML under .github/actions that is not an action", () => {
      checkRepo({ ".github/actions/setup/fixtures/data.yml": "steps:\n  - uses: actions/checkout@v4\n" }, null);
    });

    test("scans a workflow in a nested directory and with the .yaml extension", () => {
      checkRepo({ ".github/workflows/nested/extra.yaml": `permissions: {}\njobs:\n  a:\n    permissions: {}\n    steps:\n      - uses: actions/checkout@v4\n` }, NOT_PINNED);
    });
  });

  describe("permissions", () => {
    rejects("missing top-level permissions", (t) => t.replace(/^permissions: \{\}\n/m, ""), /top-level `permissions: \{\}` is required/);
    rejects("a top-level write-all", (t) => t.replace(/^permissions: \{\}$/m, "permissions: write-all"), /top-level `permissions: \{\}` is required/);
    rejects("a top-level block of scopes", (t) => t.replace(/^permissions: \{\}$/m, "permissions:\n  contents: read"), /top-level `permissions: \{\}` is required/);
    rejects("a job without permissions", withJob("  extra:\n    runs-on: ubuntu-latest\n    steps: []\n"), /job `extra` has no permissions block/);
    rejects("a quoted job id without permissions", withJob('  "extra":\n    runs-on: ubuntu-latest\n    steps: []\n'), /job `extra` has no permissions block/);
    rejects("a last job without permissions", (t) => `${t.trimEnd()}\n  last:\n    runs-on: ubuntu-latest\n    steps: []\n`, /job `last` has no permissions block/);
    rejects("a middle job without permissions", (t) => `${t.trimEnd()}\n  middle:\n    runs-on: ubuntu-latest\n    steps: []\n  tail:\n    permissions: {}\n    steps: []\n`, /job `middle` has no permissions block/);
    for (const [label, value] of [
      ["write-all", "write-all"],
      ["quoted write-all", '"write-all"'],
      ["read-all", "read-all"],
      ["an expression", "${{ inputs.permissions }}"],
      ["write-all with a trailing comment", "write-all # why not"],
    ]) {
      rejects(`job permissions set to ${label}`, withJobPermissions(`    permissions: ${value}`), UNSCOPED);
    }
    rejects("an empty permissions block", withJobPermissions("    permissions:"), UNSCOPED);
    rejects("a permission level that is not read, write or none", withJobPermissions("    permissions:\n      contents: admin"), UNSCOPED);
    rejects("a valid scope next to an invalid one", withJobPermissions("    permissions:\n      contents: read\n      id-token: admin"), UNSCOPED);
    rejects("an inline permissions mapping", withJobPermissions("    permissions: { contents: read }"), FLOW);
    accepts("an empty permissions mapping", withJobPermissions("    permissions: {}"));
    accepts("an empty permissions mapping with a space", withJobPermissions("    permissions: { }"));
    accepts("a top-level empty mapping with a space", (t) => t.replace(/^permissions: \{\}$/m, "permissions: { }"));
    accepts("a block of several scopes", withJobPermissions("    permissions:\n      contents: read\n      id-token: write # publish"));
    accepts("quoted permission levels", withJobPermissions('    permissions:\n      contents: "read"\n      id-token: \'write\''));
    accepts("a comment between scopes", withJobPermissions("    permissions:\n      contents: read\n      # for the release\n      id-token: write"));
    accepts("permission scopes indented four spaces", withJobPermissions("    permissions:\n        contents: read"));
  });

  describe("fails closed on YAML it cannot read", () => {
    rejects("a flow-mapping step", (t) => t.replace(checkout, "- { name: x, with: { a: b }, uses: actions/checkout@v4 }"), FLOW);
    rejects("a minimal flow-mapping step", (t) => t.replace(checkout, "- { uses: actions/checkout@v4 }"), FLOW);
    rejects("a flow node on its own line", (t) => t.replace(/ {4}steps:\n[^]*$/, "    steps:\n      [{uses: actions/checkout@v4}]\n"), FLOW);
    rejects("a flow-style job", withJob("  extra: { runs-on: ubuntu-latest, steps: [{ uses: actions/checkout@v4 }] }\n"), FLOW);
    rejects("a multi-line flow sequence", withStep("        with: [\n          a\n        ]\n"), FLOW);
    rejects("a flow sequence of steps", (t) => t.replace("    steps:\n", "    steps: [{ uses: actions/checkout@v4 }]\n    old:\n"), FLOW);
    rejects("steps written as a flow list of words", (t) => t.replace(/ {4}steps:\n[^]*$/, "    steps: [a, b]\n"), FLOW);
    rejects("an anchor on a job", withJob("  extra: &anchor\n    runs-on: ubuntu-latest\n    steps: []\n"), UNSUPPORTED);
    rejects("an alias value", withStep("        env: *shared\n"), UNSUPPORTED);
    rejects("a merge key", (t) => t.replace("    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    <<: *defaults\n"), UNSUPPORTED);
    rejects("a tag on steps", (t) => t.replace("    steps:\n", "    steps: !!seq\n"), UNSUPPORTED);
    rejects("a tag on a job", withJob("  extra: !!map\n    runs-on: ubuntu-latest\n    steps: []\n"), UNSUPPORTED);
    rejects("an explicit key", (t) => t.replace("    steps:\n", "    ? steps\n    :\n"), UNSUPPORTED);
    rejects("an escaped quoted key", (t) => t.replace(checkout, '- "u\\u0073es": actions/checkout@v4'), UNSUPPORTED);
    rejects("a compact JSON-style steps value", (t) => t.replace(/ {4}steps:\n[^]*$/, '    "steps":[{"uses":"actions/checkout@v4"}]\n'), UNSUPPORTED);
    rejects("a multi-line plain scalar", withStep("        name: first\n          second\n"), /nested block/);
    rejects("a multi-line quoted scalar", withStep('        name: "first\n          second"\n'), /quoted scalars|nested block|unsupported/);
    rejects("a duplicate key", withJobPermissions("    permissions: {}\n    permissions: write-all"), /duplicate key `permissions`/);
    rejects("a duplicate uses key", (t) => t.replace(checkout, `- uses: actions/checkout@${SHA}\n        uses: actions/checkout@v4`), /duplicate key `uses`/);
    rejects("an upper-case protected key", (t) => t.replace(checkout, "- USES: actions/checkout@v4"), /must be lowercase/);
    rejects("a second document", (t) => `${t}---\njobs:\n`, /multiple documents/);
    rejects("a tab indent", withStep("\tname: x\n"), /tabs are not supported/);
    rejects("a lone carriage return", withStep("        name: a\r        uses: actions/checkout@v4\n"), /unsupported line break characters/);
    rejects("inconsistent job indentation", withJob("    extra:\n        runs-on: ubuntu-latest\n        steps: []\n"), /inconsistent indentation/);
    rejects("a jobs mapping without jobs", (t) => t.replace(/^jobs:\n[^]*$/m, "jobs:\nenv:\n  A: b\n"), /`jobs:` has no jobs/);
    rejects("a workflow with no jobs mapping", (t) => t.replace(/^jobs:/m, "tasks:"), /no `jobs:` mapping found/);
    accepts("an empty flow collection and expressions", withStep('      - run: echo "${{ github.sha }} [a] {b}"\n        env: {}\n'));
    accepts("quoted text holding brackets and colons", withStep('      - name: "result: [ok]"\n        run: true\n'));
    accepts("a flow list of plain words", (t) => t.replace("  pull_request:\n", "  pull_request:\n    branches: [main, release-1.0]\n"));
    accepts("a matrix of flow lists", (t) => t.replace("    steps:\n", "    strategy:\n      matrix:\n        node: [18, 20]\n    steps:\n"));
    accepts("a dash and an asterisk inside a command", withStep("      - name: Deploy - *prod* only\n        run: rm -rf -- *tmp\n"));
    accepts("a folded scalar", withStep("      - run: >-\n          npm ci &&\n          npm test\n"));
    accepts("a block scalar on the first key of a step", withStep("      - name: |\n          multi\n          line\n        run: echo ok\n"));
    accepts("a document start marker", (t) => `---\n${t}`);
    accepts("a byte order mark", (t) => `\uFEFF${t}`);
    accepts("CRLF line endings", (t) => t.replace(/\n/g, "\r\n"));

    test("accepts jobs indented four spaces consistently", () => {
      checkRepo({ ".github/workflows/four.yml": "permissions: {}\njobs:\n    a:\n        permissions: {}\n        steps:\n            - run: true\n" }, null);
    });

    test("rejects a job indented four spaces without permissions", () => {
      checkRepo({ ".github/workflows/four.yml": "permissions: {}\njobs:\n    a:\n        runs-on: x\n" }, /job `a` has no permissions block/);
    });

    test("reports a missing workflows directory", () => {
      const empty = scratchDir();
      assert.throws(
        () => execFileSync("node", [join(repo, "scripts/check-repo.mjs")], { cwd: empty, stdio: "pipe" }),
        failsWith(/no workflows found/),
      );
    });

    test("reports a directory named like a workflow", () => {
      const dir = join(repo, ".github/workflows/dir.yml");
      mkdirSync(dir);
      try {
        assert.throws(runRepoCheck, failsWith(/dir\.yml: not a readable file/));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe("release", () => {
  const runIn = (repo, script, ...args) =>
    execFileSync("node", [`scripts/${script}`, ...args], { cwd: repo, stdio: "pipe", timeout: FIVE_MINUTES });
  const guardFailsWith = (pattern) => (error) =>
    error.status === 1 && !/\n\s+at .*:\d+:\d+/.test(String(error.stderr)) && pattern.test(String(error.stderr));
  const releaseWorkflow = (repo) => readFileSync(join(repo, ".github/workflows/release.yml"), "utf8");

  describe("publishing to npm (the default)", () => {
    let repo;
    before(() => {
      repo = render({ repo_name: "demo-skills", description: "Demo." });
    });

    test("lets release-please own the version, changelog and manifest", () => {
      assert.deepEqual(readJson(repo, ".release-please-manifest.json"), { ".": "0.0.0" });
      assert.ok(!existsSync(join(repo, "CHANGELOG.md")), "release-please creates the changelog itself");
      const config = readJson(repo, "release-please-config.json").packages["."];
      assert.equal(config["release-type"], "node");
      // Without a release tag release-please starts at 1.0.0 whatever the seeded
      // manifest says; `initial-version` is what makes the first release 0.1.0.
      assert.equal(config["initial-version"], "0.1.0");
      // Tags are plain `vX.Y.Z`. With the default, release-please adds the package
      // name to the tag, no longer matches an earlier `v0.3.0`, and cannot find the
      // last release (scoop-bucket-skills tagged `scoop-bucket-skills-v0.2.0`).
      assert.equal(config["include-component-in-tag"], false);
      assert.equal(readJson(repo, "release-please-config.json")["bump-minor-pre-major"], true);
      // The default grouped title omits the version, so release-please cannot
      // recognise the merged release PR and silently creates no tag
      // (googleapis/release-please#2712).
      assert.match(readJson(repo, "release-please-config.json")["group-pull-request-title-pattern"], /\$\{version\}/);
      assert.deepEqual(config["extra-files"].map((file) => file.path).sort(), [
        ".claude-plugin/marketplace.json",
        ".claude-plugin/plugin.json",
        ".codex-plugin/plugin.json",
      ]);
    });

    test("has a publish job with trusted publishing and provenance", () => {
      const workflow = releaseWorkflow(repo);
      assert.match(workflow, /^  publish:$/m);
      assert.match(workflow, /id-token: write/);
      assert.match(workflow, /npm publish --provenance/);
      assert.match(workflow, /release-guard\.mjs --publish/);
      assert.match(workflow, /issues: write/);
    });

    test("keeps the release workflow within the hardened CI rules", () => {
      runIn(repo, "check-repo.mjs");
    });

    test("passes its own release guard", () => {
      runIn(repo, "release-guard.mjs", "--publish");
    });

    test("stops the release when a plugin manifest drifts from package.json", () => {
      const path = join(repo, ".codex-plugin/plugin.json");
      const original = readFileSync(path, "utf8");
      writeFileSync(path, original.replace('"version": "0.0.0"', '"version": "9.9.9"'));
      try {
        assert.throws(() => runIn(repo, "release-guard.mjs", "--publish"), guardFailsWith(/\.codex-plugin\/plugin\.json: version "9\.9\.9"/));
      } finally {
        writeFileSync(path, original);
      }
    });

    test("stops the release when a publishing repo is private", () => {
      assert.throws(() => runIn(repo, "release-guard.mjs", "--private"), guardFailsWith(/must be "private": true/));
    });

    test("rejects a missing or unknown mode", () => {
      assert.throws(() => runIn(repo, "release-guard.mjs"), guardFailsWith(/usage/));
      assert.throws(() => runIn(repo, "release-guard.mjs", "--bogus"), guardFailsWith(/usage/));
    });
  });

  describe("not publishing to npm", () => {
    let repo;
    before(() => {
      repo = render({ repo_name: "demo-skills", description: "Demo.", publish_to_npm: false });
    });

    test("has no publish job, no provenance and no id-token permission", () => {
      const workflow = releaseWorkflow(repo);
      assert.doesNotMatch(workflow, /^  publish:$/m);
      assert.doesNotMatch(workflow, /provenance|id-token|npm publish/);
      assert.match(workflow, /release-guard\.mjs --private/);
    });

    test("is private, keeps the release workflow hardened and passes its guard", () => {
      assert.equal(readJson(repo, "package.json").private, true);
      runIn(repo, "check-repo.mjs");
      runIn(repo, "release-guard.mjs", "--private");
    });

    test("stops the release when the package is not private", () => {
      assert.throws(() => runIn(repo, "release-guard.mjs", "--publish"), guardFailsWith(/"private": true, but the repo publishes/));
    });
  });
});

describe("release safeguards", () => {
  let repo;
  const releaseMerge = (pulls, sha) => {
    const file = join(scratchDir(), "pulls.json");
    writeFileSync(file, typeof pulls === "string" ? pulls : JSON.stringify(pulls));
    return execFileSync("node", ["scripts/release-merge.mjs", "--pulls", file, "--sha", sha], {
      cwd: repo,
      stdio: "pipe",
      timeout: FIVE_MINUTES,
    })
      .toString()
      .trim();
  };
  const pr = (sha, overrides = {}) => ({
    merged_at: "2026-10-16T00:00:00Z",
    base: { ref: "main" },
    labels: [{ name: "autorelease: pending" }],
    merge_commit_sha: sha,
    ...overrides,
  });
  const failsCleanly = (pattern) => (error) =>
    error.status === 1 && !/\n\s+at .*:\d+:\d+/.test(String(error.stderr)) && pattern.test(String(error.stderr));

  before(() => {
    repo = render({ repo_name: "demo-skills", description: "Demo." });
  });

  test("allows the sole pending release merged as the validated commit", () => {
    assert.equal(releaseMerge([[pr("abc")]], "abc"), "is-release-merge=true");
    assert.equal(releaseMerge([[pr("old", { labels: [{ name: "autorelease: tagged" }] })], [pr("abc")]], "abc"), "is-release-merge=true");
  });

  test("refuses a stale pending merge on a later commit", () => {
    assert.equal(releaseMerge([[pr("abc")]], "later"), "is-release-merge=false");
  });

  test("refuses two pending merges, even when one matches", () => {
    assert.equal(releaseMerge([[pr("abc")], [pr("def")]], "abc"), "is-release-merge=false");
  });

  test("ignores unmerged, other-branch and unlabelled pull requests", () => {
    const noise = [pr("abc", { merged_at: null }), pr("abc", { base: { ref: "dev" } }), pr("abc", { labels: [] })];
    assert.equal(releaseMerge([noise], "abc"), "is-release-merge=false");
    assert.equal(releaseMerge([[...noise, pr("abc")]], "abc"), "is-release-merge=true");
  });

  test("refuses when there is no pending release at all", () => {
    assert.equal(releaseMerge([[]], "abc"), "is-release-merge=false");
  });

  test("fails cleanly on unreadable input and bad usage", () => {
    assert.throws(() => releaseMerge("not json", "abc"), failsCleanly(/cannot read as JSON/));
    assert.throws(() => releaseMerge({ not: "pages" }, "abc"), failsCleanly(/expected an array of pages/));
    assert.throws(
      () => execFileSync("node", ["scripts/release-merge.mjs"], { cwd: repo, stdio: "pipe" }),
      failsCleanly(/usage/),
    );
  });

  test("wires the guard, a non-cancelling concurrency group and the dispatch check", () => {
    const release = readFileSync(join(repo, ".github/workflows/release.yml"), "utf8");
    assert.match(release, /^concurrency:\n  group: release\n  cancel-in-progress: false$/m);
    assert.match(release, /node scripts\/release-merge\.mjs/);
    assert.match(release, /skip-github-release: \$\{\{ steps\.release-merge\.outputs\.is-release-merge != 'true' \}\}/);
    const check = readFileSync(join(repo, ".github/workflows/check.yml"), "utf8");
    // No `ref` input: it would let a run report on a commit other than the one
    // the check is bound to, so the check could pass a head it never validated.
    assert.match(check, /^  workflow_dispatch:$/m);
    assert.doesNotMatch(check, /inputs/);
    assert.match(readFileSync(join(repo, "CONTRIBUTING.md"), "utf8"), /gh workflow run check\.yml --ref release-please--branches--main/);
    const contributing = readFileSync(join(repo, "CONTRIBUTING.md"), "utf8");
    assert.match(contributing, /^## Release flow$/m);
    assert.match(contributing, /^## Recovery$/m);
    assert.match(contributing, /sole pending release/);
    assert.match(contributing, /`publish` job then publishes the package to npm/);
    assert.doesNotMatch(contributing, /scoop/i);
  });

  test("regenerates the plugin output without running dependency code next to a write token", () => {
    const release = readFileSync(join(repo, ".github/workflows/release.yml"), "utf8");
    // Job bodies, keyed by job id.
    const withoutComments = release
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    const jobs = Object.fromEntries(
      [...withoutComments.split(/^jobs:\n/m)[1].matchAll(/^  ([a-z-]+):\n([\s\S]*?)(?=^  [a-z-]+:\n|(?![\s\S]))/gm)].map((m) => [m[1], m[2]]),
    );
    assert.ok(jobs.regenerate && jobs.push, "regenerate and push jobs exist");
    // release-please and push hold write tokens: neither installs packages or
    // runs an npm script. release-please runs only its own dependency-free node
    // script; push runs no node at all.
    for (const id of ["release-please", "push"]) {
      assert.match(jobs[id], /contents: write/, `${id} holds the write token`);
      assert.doesNotMatch(jobs[id], /\bnpm\b/, `${id} runs no npm`);
    }
    assert.doesNotMatch(jobs.push, /setup-node|\bnode\b/, "push runs no node");
    // regenerate runs npm with read-only access and no stored credentials.
    assert.match(jobs.regenerate, /permissions:\n      contents: read\n/);
    assert.doesNotMatch(jobs.regenerate, /write/);
    assert.match(jobs.regenerate, /persist-credentials: false/);
    assert.match(jobs.regenerate, /npm ci\n\s+npm run generate/);
    // Commit, then check the committed tree, then hand over: strict validation
    // fails on uncommitted generated output.
    assert.match(jobs.regenerate, /git commit -m "chore: regenerate plugin output for the release"[\s\S]*npm run check\n\s+git diff --binary HEAD~1 HEAD/);
    // Whatever the allowlist did not stage is discarded before that check, so it
    // reads the committed tree and not leftover generated files.
    assert.match(jobs.regenerate, /git commit -m "chore: regenerate plugin output for the release"\n\s+git restore --worktree -- \.\n\s+git clean -fdq\n\s+npm run check\n\s+git diff --binary HEAD~1 HEAD/);
    assert.match(jobs.regenerate, /if: \$\{\{ steps\.regenerate\.outputs\.changed == 'true' \}\}\n\s+uses: actions\/upload-artifact@[0-9a-f]{40}/);
    // push applies only generated paths, from the artifact, and pushes the branch.
    assert.match(jobs.push, /needs: \[release-please, regenerate\]/);
    assert.match(jobs.push, /actions\/download-artifact@[0-9a-f]{40}/);
    assert.match(jobs.push, /Refusing to push: \$path is not generated output/);
    assert.match(jobs.push, /git apply --index "\$patch"/);
    assert.match(jobs.push, /git push origin "HEAD:\$BRANCH"/);
    assert.match(readFileSync(join(repo, "CONTRIBUTING.md"), "utf8"), /read-only job runs `npm run generate`/);
  });

  describe("the push job's patch allowlist", () => {
    // The push job's own shell, run for real in a scratch git repo with the
    // final `git push` stubbed out.
    const git = (cwd, ...args) =>
      execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, env: scratchEnv(), stdio: "pipe" });
    const pushScript = () => {
      const release = readFileSync(join(repo, ".github/workflows/release.yml"), "utf8");
      // `\n  push:\n    needs` is the job; a bare `push:` also starts the `on:` trigger.
      const job = release.slice(release.indexOf("\n  push:\n    needs"));
      const body = job.slice(job.indexOf("run: |\n") + "run: |\n".length).split(/\n(?=  [a-z-]+:\n)/)[0];
      const script = body.split("\n").map((line) => line.replace(/^ {10}/, "")).join("\n");
      assert.match(script, /git push origin "HEAD:\$BRANCH"/);
      return script.replace('git push origin "HEAD:$BRANCH"', "true");
    };
    // Applies a patch that writes `files` over a baseline commit; reports the
    // script's exit status, stderr and whether it made a commit.
    const run = (files) => {
      const dir = scratchDir();
      git(dir, "init", "-q", "-b", "main");
      writeFileSync(join(dir, ".ai-rulez-generated.json"), "{}\n");
      writeFileSync(join(dir, "AGENTS.md"), "old\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "base");
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
      }
      git(dir, "add", "-A");
      const patchPath = join(scratchDir(), "regenerate.patch");
      writeFileSync(patchPath, git(dir, "diff", "--cached", "--binary"));
      git(dir, "reset", "-q", "--hard");
      git(dir, "clean", "-qfd");
      const before = git(dir, "rev-parse", "HEAD").toString();
      try {
        execFileSync("bash", ["-ec", pushScript()], {
          cwd: dir,
          stdio: "pipe",
          env: { ...scratchEnv(), RUNNER_TEMP: dirname(patchPath), BRANCH: "release-please--branches--main" },
        });
        return { ok: true, committed: git(dir, "rev-parse", "HEAD").toString() !== before, stderr: "" };
      } catch (error) {
        return { ok: false, committed: git(dir, "rev-parse", "HEAD").toString() !== before, stderr: String(error.stderr) };
      }
    };

    test("pushes generated commands and Pi prompts too", () => {
      const result = run({ "commands/a.md": "x\n", ".pi/prompts/a.md": "x\n" });
      assert.deepEqual([result.ok, result.committed], [true, true], result.stderr);
    });

    test("pushes generated output, including an exact AGENTS.md", () => {
      const result = run({ ".ai-rulez-generated.json": '{"a":1}\n', "AGENTS.md": "new\n", "skills/new/SKILL.md": "x\n" });
      assert.deepEqual([result.ok, result.committed], [true, true], result.stderr);
    });

    for (const path of [
      "AGENTS.md.evil",
      ".github/workflows/evil.yml",
      "skills-evil/x",
      ".agents-evil/x",
      "commands-evil/x",
      ".pi-evil/x",
      ".ai-rulez-generated.json.evil",
      "package.json",
    ]) {
      test(`refuses ${path}`, () => {
        const result = run({ [path]: "x\n" });
        assert.equal(result.ok, false);
        assert.equal(result.committed, false);
        assert.match(result.stderr, /Refusing to push: .* is not generated output/);
      });
    }
  });

  test("starts the regenerate job's staging from a clean index", () => {
    const release = readFileSync(join(repo, ".github/workflows/release.yml"), "utf8");
    // Dependency code from `npm ci` may stage files; only the listed paths may
    // enter the commit.
    assert.match(release, /npm run generate\n(\s+#[^\n]*\n)+\s+git reset -q\n(\s+#[^\n]*\n)+\s+for path in /);
  });

  test("a release bump fails the check until the output is regenerated", () => {
    // release-please bumps these files and cannot touch the hash ledger.
    const bumped = render({ repo_name: "bump-skills", description: "Demo." });
    const options = { cwd: bumped, stdio: "pipe", timeout: FIVE_MINUTES };
    execFileSync("npm", ["ci"], options);
    const bump = (path, update) => {
      const data = readJson(bumped, path);
      update(data);
      writeFileSync(join(bumped, path), `${JSON.stringify(data, null, 2)}\n`);
    };
    bump("package.json", (d) => (d.version = "0.2.0"));
    bump(".release-please-manifest.json", (d) => (d["."] = "0.2.0"));
    bump(".claude-plugin/plugin.json", (d) => (d.version = "0.2.0"));
    bump(".claude-plugin/marketplace.json", (d) => (d.plugins[0].version = "0.2.0"));
    bump(".codex-plugin/plugin.json", (d) => (d.version = "0.2.0"));
    // The release guard is satisfied: every version moved together.
    execFileSync("node", ["scripts/release-guard.mjs", "--publish"], options);
    assert.throws(
      () => execFileSync("npm", ["run", "check"], options),
      (error) => /Drifted plugin outputs/.test(String(error.stdout) + String(error.stderr)) && /\.ai-rulez-generated\.json/.test(String(error.stdout) + String(error.stderr)),
    );
    execFileSync("npm", ["run", "generate"], options);
    execFileSync("npm", ["run", "check"], options);
  });

  test("keeps both workflows within the hardened CI rules", () => {
    execFileSync("node", ["scripts/check-repo.mjs"], { cwd: repo, stdio: "pipe" });
  });
});

describe("rendered with no answers at all", () => {
  test("takes repo_name from the destination folder and passes its own check", () => {
    const repo = render({}, "bare-skills");
    assert.equal(readJson(repo, ".claude-plugin/plugin.json").name, "bare-skills");
    assert.ok(readJson(repo, "package.json").description.length > 0);
    installAndCheck(repo);
  });
});

describe("rendered with non-default answers", () => {
  let repo;
  before(() => {
    repo = render({
      repo_name: "acme-widget-skills",
      description: 'Skills for widgets 😀 with "quotes" and a \\ backslash.',
      placeholder_skill: "widget-check",
      github_owner: "acme",
      author_name: "Acme Dev",
      author_url: "https://github.com/acme-dev",
    });
  });

  test("names the placeholder skill from the answer and still passes check", () => {
    assert.ok(existsSync(join(repo, "skills/widget-check/SKILL.md")));
    assert.ok(!existsSync(join(repo, "skills/hello")));
    installAndCheck(repo);
  });

  test("threads owner and author answers into the manifests", () => {
    const plugin = readJson(repo, ".claude-plugin/plugin.json");
    assert.equal(plugin.repository, "https://github.com/acme/acme-widget-skills");
    assert.equal(plugin.description, 'Skills for widgets 😀 with "quotes" and a \\ backslash.');
    assert.equal(readJson(repo, "package.json").description, plugin.description);
    assert.deepEqual(plugin.author, { name: "Acme Dev", url: "https://github.com/acme-dev" });
  });
});

describe("publish_to_npm", () => {
  test("is publishable by default", () => {
    const repo = render({ repo_name: "demo-skills", description: "Demo." });
    assert.equal(readJson(repo, "package.json").private, undefined);
  });

  test("marks the package private when turned off", () => {
    const repo = render({ repo_name: "demo-skills", description: "Demo.", publish_to_npm: false });
    assert.equal(readJson(repo, "package.json").private, true);
  });
});

describe("contributing doc", () => {
  const contributing = (repo) => readFileSync(join(repo, "CONTRIBUTING.md"), "utf8");

  test("carries the setup checklist, layouts and conventions, with npm setup when publishing", () => {
    const doc = contributing(render({ repo_name: "demo-skills", description: "Demo.", github_owner: "acme" }));
    assert.match(doc, /^# Contributing to Demo Skills$/m);
    assert.match(doc, /create and approve pull requests/);
    assert.match(doc, /`check` status check/);
    assert.match(doc, /close and reopen/i);
    assert.match(doc, /after each update/);
    assert.match(doc, /Publish the `0\.0\.0` placeholder once by hand/);
    assert.match(doc, /trusted publisher: .*owner `acme`, repository `demo-skills`, workflow `release\.yml`/);
    assert.match(doc, /references\//);
    assert.match(doc, /evals\//);
    assert.match(doc, /Conventional Commits/);
    assert.ok(!doc.includes("{{") && !doc.includes("{%"), "no unrendered template syntax");
  });

  test("drops the npm step when not publishing", () => {
    const doc = contributing(render({ repo_name: "demo-skills", description: "Demo.", publish_to_npm: false }));
    assert.doesNotMatch(doc, /trusted publisher/i);
    assert.match(doc, /no npm setup is needed/);
    assert.match(doc, /nothing is published to a registry/);
    assert.doesNotMatch(doc, /publishes the package to npm|failed `publish` job/);
  });

  test("is template-owned: copier update is free to merge it", () => {
    const copier = readFileSync(join(templateRoot, "copier.yml"), "utf8");
    assert.doesNotMatch(copier, /CONTRIBUTING/);
  });
});

describe("renovate", () => {
  test("extends the shared preset with no custom manager", () => {
    const repo = render({ repo_name: "demo-skills", description: "Demo." });
    const config = readJson(repo, ".github/renovate.json");
    assert.deepEqual(config.extends, ["local>hasansezertasan/renovate-config"]);
    assert.equal(config.customManagers, undefined);
  });
});

describe("copier update", () => {
  const git = (cwd, ...args) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      env: scratchEnv(),
      stdio: "pipe",
    });
  const read = (dir, path) => readFileSync(join(dir, path), "utf8");
  const edit = (dir, path, from, to) => {
    const before = read(dir, path);
    assert.ok(before.includes(from), `${path} lacks ${JSON.stringify(from)}`);
    writeFileSync(join(dir, path), before.replace(from, to));
  };
  let repo;
  let gone;

  before(() => {
    // The earlier template state: a git repo of the working tree, tagged.
    const source = scratchDir();
    cpSync(join(templateRoot, "copier.yml"), join(source, "copier.yml"));
    cpSync(join(templateRoot, "template"), join(source, "template"), { recursive: true });
    git(source, "init", "-q", "-b", "main");
    git(source, "add", "-A");
    git(source, "commit", "-q", "-m", "earlier state");
    git(source, "tag", "v1.0.0");

    repo = join(scratchDir(), "demo-skills");
    const dataFile = join(scratchDir(), "answers.json");
    writeFileSync(dataFile, JSON.stringify({ repo_name: "demo-skills", description: "Demo." }));
    const copier = (args, cwd) =>
      execFileSync("copier", [...args, "--defaults", "--trust", "--skip-tasks"], {
        cwd,
        env: scratchEnv(),
        stdio: "pipe",
        timeout: FIVE_MINUTES,
      });
    gone = join(scratchDir(), "demo-skills");
    for (const dest of [repo, gone]) {
      copier(["copy", "--vcs-ref", "v1.0.0", "--data-file", dataFile, source, dest]);
      git(dest, "init", "-q", "-b", "main");
      git(dest, "add", "-A");
      git(dest, "commit", "-q", "-m", "chore: generate");
    }

    // A second repo replaced the placeholder with its own skill and deleted it.
    rmSync(join(gone, ".ai-rulez/skills/hello"), { recursive: true });
    mkdirSync(join(gone, ".ai-rulez/skills/real"), { recursive: true });
    writeFileSync(join(gone, ".ai-rulez/skills/real/SKILL.md"), "---\nname: real\ndescription: Real.\n---\n");
    git(gone, "add", "-A");
    git(gone, "commit", "-q", "-m", "chore: replace placeholder");

    // Local edits: repo-owned files, and a local edit inside template-owned ones.
    writeFileSync(join(repo, "README.md"), "# My own README\n");
    writeFileSync(join(repo, ".ai-rulez/skills/hello/SKILL.md"), `${read(repo, ".ai-rulez/skills/hello/SKILL.md")}\nLocal addition.\n`);
    mkdirSync(join(repo, ".ai-rulez/skills/real"), { recursive: true });
    writeFileSync(join(repo, ".ai-rulez/skills/real/SKILL.md"), "---\nname: real\ndescription: Real.\n---\n");
    writeFileSync(join(repo, "CHANGELOG.md"), "# Changelog\n\n## 0.3.0\n");
    writeFileSync(join(repo, ".release-please-manifest.json"), '{ ".": "0.3.0" }\n');
    edit(repo, "package.json", '"version": "0.0.0"', '"version": "0.3.0"');
    edit(repo, "CONTRIBUTING.md", "- Node comes from `.node-version`.", "- Node comes from `.node-version`.\n- Local rule: ask before merging.");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "chore: local edits");

    // The template moves on: it changes template-owned and repo-owned files alike.
    edit(source, "template/CONTRIBUTING.md.jinja", "## Commits and pull requests", "## Commits and pull requests\n\n> Template note.");
    edit(source, "template/package.json.jinja", '"node": ">=22"', '"node": ">=24"');
    edit(source, "template/package.json.jinja", '"ai-rulez": "5.3.0"', '"ai-rulez": "5.4.0"');
    edit(source, "template/.ai-rulez/skills/{{ placeholder_skill }}/SKILL.md.jinja", "Placeholder skill", "Template placeholder");
    edit(source, "template/.release-please-manifest.json", '"0.0.0"', '"0.0.1"');
    git(source, "add", "-A");
    git(source, "commit", "-q", "-m", "later state");
    git(source, "tag", "v1.1.0");

    for (const dest of [repo, gone]) {
      try {
        copier(["update", "--vcs-ref", "v1.1.0"], dest);
      } catch (error) {
        throw new Error(`copier update failed: ${error.stderr}${error.stdout}`);
      }
    }
  });

  test("leaves repo-owned files untouched", () => {
    assert.equal(read(repo, "README.md"), "# My own README\n");
    assert.ok(existsSync(join(repo, ".ai-rulez/skills/real/SKILL.md")));
    assert.ok(existsSync(join(gone, ".ai-rulez/skills/real/SKILL.md")));
    assert.equal(read(repo, "CHANGELOG.md"), "# Changelog\n\n## 0.3.0\n");
    assert.deepEqual(readJson(repo, ".release-please-manifest.json"), { ".": "0.3.0" });
    assert.equal(readJson(repo, "package.json").version, "0.3.0");
  });

  test("does not bring back a placeholder skill the repo deleted", () => {
    assert.ok(!existsSync(join(gone, ".ai-rulez/skills/hello")));
  });

  test("merges a template change to the placeholder beside a local addition", () => {
    const skill = read(repo, ".ai-rulez/skills/hello/SKILL.md");
    assert.match(skill, /Template placeholder/);
    assert.match(skill, /Local addition\./);
    assert.ok(!/<<<<<<<|>>>>>>>/.test(skill), "no conflict markers");
  });

  test("merges template changes into template-owned files and keeps local edits", () => {
    const contributing = read(repo, "CONTRIBUTING.md");
    assert.match(contributing, /Template note\./);
    assert.match(contributing, /Local rule: ask before merging\./);
    const pkg = readJson(repo, "package.json");
    assert.equal(pkg.engines.node, ">=24");
    assert.equal(pkg.devDependencies["ai-rulez"], "5.4.0");
    assert.ok(!/<<<<<<<|>>>>>>>/.test(read(repo, "package.json")), "no conflict markers in package.json");
    assert.ok(!/<<<<<<<|>>>>>>>/.test(contributing), "no conflict markers");
  });

  test("moves the answers file to the new template version", () => {
    assert.match(read(repo, ".copier-answers.yml"), /_commit: v1\.1\.0/);
  });
});

describe("package.json layout", () => {
  // `copier update` three-way merges package.json, so a fresh render must
  // already have the layout `npm run generate` leaves, or every template edit
  // to the file conflicts with the committed, generated one.
  for (const answers of [
    { keywords: "beta, alpha" },
    { keywords: "pi-package, alpha" },
    { publish_to_npm: false },
    // Characters tojson would escape and ai-rulez writes literally.
    { description: "Rock & roll <b> \"quoted\" back\\slash \u00e9 \u{1F600}", author_name: "A & B \u{1F600}", keywords: "r&b, \u{1F600}" },
  ]) {
    test(`is unchanged by generation for ${JSON.stringify(answers)}`, () => {
      const data = { repo_name: "demo-skills", description: "Demo.", ...answers };
      const unGenerated = readFileSync(join(render(data, "demo-skills", ["--skip-tasks"]), "package.json"), "utf8");
      const generated = readFileSync(join(render(data, "demo-skills"), "package.json"), "utf8");
      assert.equal(unGenerated, generated);
    });
  }
});

describe("runtimes", () => {
  const read = (repo, path) => readFileSync(join(repo, path), "utf8");

  describe("by default", () => {
    let repo;
    before(() => {
      repo = render({ repo_name: "demo-skills", description: "Demo.", github_owner: "acme", keywords: "alpha, beta" });
    });

    test("generates and verifies the Claude Code and Codex manifests", () => {
      for (const path of [
        ".claude-plugin/plugin.json",
        ".claude-plugin/marketplace.json",
        ".codex-plugin/plugin.json",
        ".agents/plugins/marketplace.json",
      ]) {
        assert.equal(readJson(repo, path).name ?? readJson(repo, path).interface?.displayName, "demo-skills", path);
      }
      installAndCheck(repo);
    });

    test("derives the Pi keyword, skills entry and files allowlist from the skills on disk", () => {
      const pkg = readJson(repo, "package.json");
      assert.deepEqual(pkg.keywords, ["alpha", "beta", "pi-package"]);
      assert.deepEqual(pkg.pi.skills, ["./skills/hello"]);
      assert.ok(pkg.files.includes("skills/hello/SKILL.md"), "the published files list the skill");
      assert.ok(!pkg.files.includes("docs/installation.md"), "the published files exclude unrelated repository files");
      assert.ok(existsSync(join(repo, "skills/hello/SKILL.md")), "the Pi skills path exists");
      assert.equal(pkg.scripts.check.startsWith("node scripts/check-repo.mjs"), true, "authored scripts survive the merge");
      assert.ok(pkg.devDependencies["ai-rulez"], "authored devDependencies survive the merge");
    });

    test("documents all five runtimes and the open OpenCode question", () => {
      const doc = read(repo, "docs/installation.md");
      assert.match(doc, /claude plugin marketplace add acme\/demo-skills/);
      assert.match(doc, /codex plugin marketplace add/);
      assert.match(doc, /\.agents\/skills\//);
      // OpenCode deprecates the object form `skills: { paths: [...] }`.
      assert.match(doc, /"skills": \["\/absolute\/path\/to\/demo-skills\/skills"\]/);
      assert.doesNotMatch(doc, /"paths"/);
      assert.match(doc, /published config schema/);
      assert.match(doc, /Reading a clone is not an install/);
      assert.match(doc, /Report the install as done only after the route's confirm step succeeds/);
      assert.doesNotMatch(doc, /or read a `SKILL\.md`/);
      // The manual route's confirm step must not be satisfiable by a clone alone.
      const manual = doc.split("\n").find((line) => line.startsWith("| Manual |"));
      assert.match(manual, /it is not an install/);
      assert.doesNotMatch(manual, /rev-parse/);
      assert.match(doc, /pi install npm:demo-skills/);
      assert.match(doc, /pi install git:github\.com\/acme\/demo-skills/);
      // The agent-facing page: a prompt, instructions for the reading agent and a
      // route table with install, update and confirm columns.
      assert.match(doc, /Install the demo-skills skills: pick the best installation method for\nyou from https:\/\/github\.com\/acme\/demo-skills\/blob\/main\/docs\/installation\.md/);
      assert.match(doc, /^## For agents reading this page$/m);
      assert.match(doc, /^\| Runtime \| Install \| Update \| Confirm \|$/m);
      for (const runtime of ["Claude Code", "Codex", "OpenCode", "Pi", "Antigravity", "Manual"]) {
        assert.match(doc, new RegExp(`^\\| ${runtime} \\|`, "m"), `${runtime} row`);
      }
      assert.doesNotMatch(doc, /scoop/i, "no text borrowed from another repo");
      assert.match(doc, /five runtimes/);
      assert.match(doc, /agy plugin install https:\/\/github\.com\/acme\/demo-skills/);
      assert.match(doc, /> \*\*Unverified\.\*\* Installing from a Git URL has not been exercised/);
      // Confirm the installed plugin, not a clone: `agy plugin validate` checks a source directory.
      assert.match(doc, /\| Antigravity \|[^\n]*`agy plugin list` shows the plugin as installed and enabled/);
      // Caveats that must survive: copied skills are verified, not just the
      // clone, and the Codex update route is flagged as unverified.
      // Per skill: a plain `diff -r` of the two directories would also report
      // destination-only skills that came from other sources.
      assert.match(doc, /for d in <clone>\/skills\/\*\/; do diff -r "\$d" "<destination>\/\$\(basename "\$d"\)"; done` prints nothing/);
      assert.doesNotMatch(doc, /`diff -r <clone>\/skills <destination>`/);
      assert.match(doc, /`marketplace upgrade` applies to Git marketplaces, not a local path; this update route has not been verified/);
      // A bare `pi update` updates Pi itself; a package needs its source.
      assert.match(doc, /`pi update npm:demo-skills`/);
      assert.match(doc, /`pi update git:github\.com\/acme\/demo-skills`/);
      assert.doesNotMatch(doc, /`pi update`, then/);
      assert.match(doc, /No npm route/);
      assert.doesNotMatch(doc, /Open question/);
      assert.ok(!doc.includes("{{") && !doc.includes("{%"), "no unrendered template syntax");
    });

    test("ships a README skeleton that points at the install doc", () => {
      const readme = read(repo, "README.md");
      assert.match(readme, /^# Demo Skills$/m);
      assert.match(readme, /docs\/installation\.md/);
    });
  });

  describe("the Antigravity adapter", () => {
    const adapter = "plugin.json";
    const check = (dir) => execFileSync("node", ["scripts/check-repo.mjs"], { cwd: dir, stdio: "pipe", timeout: FIVE_MINUTES });
    const failsWith = (pattern) => (error) =>
      error.status === 1 && !/\n\s+at .*:\d+:\d+/.test(String(error.stderr)) && pattern.test(String(error.stderr));
    let repo;
    before(() => {
      repo = render({ repo_name: "demo-skills", description: 'Skills "quoted" with 😀 and a \\ backslash.' });
    });
    // Runs `change` on the adapter, expects the check to fail, then restores it.
    const drift = (change, pattern) => {
      const original = readFileSync(join(repo, adapter), "utf8");
      try {
        writeFileSync(join(repo, adapter), change(original));
        assert.throws(() => check(repo), failsWith(pattern));
      } finally {
        writeFileSync(join(repo, adapter), original);
      }
    };

    test("is a root plugin.json built from the answers", () => {
      assert.deepEqual(readJson(repo, adapter), {
        $schema: "https://antigravity.google/schemas/v1/plugin.json",
        name: "demo-skills",
        description: 'Skills "quoted" with 😀 and a \\ backslash.',
      });
      check(repo);
    });

    test("fails the check when the description drifts from the generated manifest", () => {
      drift((text) => text.replace("quoted", "changed"), /plugin\.json: description .* does not match \.claude-plugin\/plugin\.json/);
    });

    test("fails the check when the name drifts", () => {
      drift((text) => text.replace('"demo-skills"', '"other-skills"'), /plugin\.json: name "other-skills" does not match/);
    });

    test("fails the check when the adapter file is missing", () => {
      const original = readFileSync(join(repo, adapter), "utf8");
      rmSync(join(repo, adapter));
      try {
        assert.throws(() => check(repo), failsWith(/plugin\.json: cannot read as JSON \(ENOENT\)/));
      } finally {
        writeFileSync(join(repo, adapter), original);
      }
    });

    // Both catalogs install the repository root, so a path Claude or Codex loads
    // from an installed plugin by default would ship. ai-rulez reports these as
    // AR9T0, but the template turns that rule off for the adapter above.
    describe("host-loaded root components", () => {
      const files = [".mcp.json", ".app.json", ".lsp.json", "settings.json"];
      const directories = ["hooks", "agents", "commands", "bin", "output-styles", "workflows", "themes", "monitors"];
      // Creates `path` in the rendered repo, expects the check to name it, then removes it.
      const shipping = (path, make) => {
        const full = join(repo, path);
        make(full);
        try {
          assert.throws(() => check(repo), failsWith(new RegExp(`root component: ${path.replaceAll(".", "\\.")}`)));
        } finally {
          rmSync(full, { recursive: true, force: true });
        }
      };
      for (const path of files) {
        test(`fails the check when ${path} exists at the root`, () => shipping(path, (full) => writeFileSync(full, "{}\n")));
      }
      for (const path of directories) {
        test(`fails the check when ${path}/ exists at the root, even empty`, () => shipping(path, (full) => mkdirSync(full)));
      }

      test("fails the check on a dangling symlink at a root component path", () => {
        shipping("hooks", (full) => symlinkSync(join(full, "..", "no-such-target"), full));
      });

      test("names every offending path in one run", () => {
        writeFileSync(join(repo, ".mcp.json"), "{}\n");
        mkdirSync(join(repo, "hooks"));
        try {
          assert.throws(
            () => check(repo),
            (error) => /root component: \.mcp\.json/.test(String(error.stderr)) && /root component: hooks/.test(String(error.stderr)),
          );
        } finally {
          rmSync(join(repo, ".mcp.json"), { force: true });
          rmSync(join(repo, "hooks"), { recursive: true, force: true });
        }
      });

      describe("allowlist", () => {
        const withAllowlist = (content, run) => {
          const allowlist = join(repo, ".config", "root-components.json");
          mkdirSync(dirname(allowlist), { recursive: true });
          writeFileSync(allowlist, content);
          mkdirSync(join(repo, "hooks"));
          try {
            run();
          } finally {
            rmSync(join(repo, "hooks"), { recursive: true, force: true });
            rmSync(allowlist, { force: true });
          }
        };

        test("passes a component listed with a reason", () => {
          withAllowlist(JSON.stringify({ hooks: "Claude SessionStart hook" }), () => check(repo));
        });

        test("still fails a component that is not listed", () => {
          withAllowlist(JSON.stringify({ agents: "subagent" }), () => {
            assert.throws(() => check(repo), failsWith(/root component: hooks/));
          });
        });

        test("rejects an empty reason", () => {
          withAllowlist(JSON.stringify({ hooks: " " }), () => {
            assert.throws(() => check(repo), failsWith(/root-components\.json: hooks needs a non-empty reason/));
          });
        });

        test("rejects an unknown name", () => {
          withAllowlist(JSON.stringify({ hook: "typo" }), () => {
            assert.throws(() => check(repo), failsWith(/"hook" is not a root component/));
          });
        });
      });

      test("still passes with the adapter and the generated skills at the root", () => {
        check(repo);
      });
    });

    // CI runs this very command on the template repository, which has no
    // generated output and therefore no adapter to compare.
    test("leaves the template repository's own check passing", () => {
      const output = execFileSync("node", ["template/scripts/check-repo.mjs"], {
        cwd: templateRoot,
        env: scratchEnv(),
        stdio: "pipe",
        timeout: FIVE_MINUTES,
      });
      assert.match(String(output), /check-repo: \d+ workflow\(s\) ok/);
    });

    // Valid JSON that is not an object must not slip past a truthiness guard.
    for (const value of ["null", "false", "0", '""', "[]"]) {
      test(`fails the check when the adapter is ${value}`, () => {
        drift(() => `${value}\n`, /plugin\.json: must be a JSON object/);
      });
    }

    // Codex adopts a root plugin.json that declares the portable schema as its
    // manifest, so the check must hold the adapter to the Antigravity one.
    for (const schema of ["https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", "", "https://example.com/other.json"]) {
      test(`fails the check when the adapter declares $schema ${JSON.stringify(schema)}`, () => {
        drift(
          (text) => text.replace("https://antigravity.google/schemas/v1/plugin.json", schema),
          /plugin\.json: \$schema .* must be https:\/\/antigravity\.google\/schemas\/v1\/plugin\.json/,
        );
      });
    }

    test("fails the check when the adapter has no $schema", () => {
      drift(
        (text) => text.replace(/\s*"\$schema": "[^"]*",/, ""),
        /plugin\.json: \$schema undefined must be https:\/\/antigravity\.google\/schemas\/v1\/plugin\.json/,
      );
    });

    test("fails the check when the adapter is not readable JSON", () => {
      drift(() => "{ not json", /plugin\.json: cannot read as JSON/);
    });
  });

  test("keeps the Pi keyword once when the answer already has it", () => {
    const repo = render({ repo_name: "demo-skills", description: "Demo.", keywords: "pi-package, alpha" });
    assert.deepEqual(readJson(repo, "package.json").keywords, ["pi-package", "alpha"]);
  });

  test("offers Pi from git only when not publishing to npm", () => {
    const doc = read(render({ repo_name: "demo-skills", description: "Demo.", publish_to_npm: false }), "docs/installation.md");
    assert.doesNotMatch(doc, /pi install npm:/);
    assert.doesNotMatch(doc, /pi update npm:/);
    assert.match(doc, /`pi update git:/);
    assert.match(doc, /pi install git:/);
  });
});

describe("invalid answers", () => {
  for (const question of ["description", "author_name", "author_url"]) {
    for (const [label, value] of [["empty", ""], ["whitespace-only", "   "]]) {
      test(`${question} that is ${label} is rejected`, () => {
        assertRejected(question, { [question]: value });
      });
    }
  }

  for (const question of ["description", "author_name", "author_url", "keywords"]) {
    for (const [label, value] of [["escape", "bad\u001bvalue"], ["backspace", "bad\bvalue"], ["newline", "bad\nvalue"]]) {
      test(`${question} containing ${label} is rejected`, () => {
        assertRejected(question, { [question]: value });
      });
    }
  }

  const name64 = "a".repeat(64);
  for (const [question, value] of [
    ["repo_name", `${name64}b`],
    ["repo_name", "Demo_Skills"],
    ["placeholder_skill", `${name64}b`],
    ["placeholder_skill", "Hello World"],
  ]) {
    test(`${question} ${JSON.stringify(value).slice(0, 20)} is rejected`, () => {
      assertRejected(question, { [question]: value });
    });
  }

  for (const github_owner of ['bad"owner', "acme--tools", "-acme", "acme-", "a".repeat(40)]) {
    test(`github_owner ${JSON.stringify(github_owner).slice(0, 20)} is rejected`, () => {
      assertRejected("github_owner", { github_owner });
    });
  }
});

test("compares the complete Node floor, not just the major", () => {
  assert.equal(nodeFloorCovers(">=22", ">=22.0.0"), true);
  assert.equal(nodeFloorCovers(">=22.12", ">=22.0.0"), true);
  assert.equal(nodeFloorCovers(">=24", ">=22.5.0"), true);
  assert.equal(nodeFloorCovers(">=22", ">=22.5.0"), false, "a minor bump in the dependency must be noticed");
  assert.equal(nodeFloorCovers(">=22.5", ">=22.5.1"), false, "a patch bump must be noticed");
  assert.equal(nodeFloorCovers(">=20", ">=22.0.0"), false);
  assert.throws(() => nodeFloorCovers("^22", ">=22.0.0"), /unsupported Node range/);
});

test("the template stores no generated output", () => {
  const generated = new Set(["skills", ".claude-plugin", ".codex-plugin", ".agents", "AGENTS.md"]);
  const found = readdirSync(join(templateRoot, "template"), { recursive: true }).filter((path) =>
    generated.has(path.split("/")[0]),
  );
  assert.deepEqual(found, []);
});
