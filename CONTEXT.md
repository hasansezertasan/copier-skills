# copier-skill-repo

A Copier template that generates the shared scaffold of skill repos: repositories that publish agent skills as plugins to several runtimes. It owns the scaffold, never the skills' content.

## Language

**Skill repo**:
A repository whose product is a set of agent skills, published as a plugin to every supported runtime. Examples: scoop-bucket-skills, ghost-library-skills, infra-copilot.
_Avoid_: Plugin repo, skills package

**Scaffold**:
The repo-level files every skill repo shares: source-of-truth config, plugin and marketplace manifests, CI, release, Renovate and community docs. Excludes skill content.
_Avoid_: Boilerplate, base

**Skill content**:
What makes one skill repo different from another: `SKILL.md`, `references/`, `evals/` and `scripts/` of its skills. The template never owns it.

**Placeholder skill**:
The single example skill the template ships so generation has something to bundle. Replaced by the repo's real skills.

**Source of truth**:
The authored `.ai-rulez/` directory. Everything else a runtime reads is derived from it.
_Avoid_: Canonical source

**Generated output**:
Files committed to the repo but produced from the source of truth (`AGENTS.md`, root `skills/`, plugin and marketplace manifests). Never edited by hand; CI fails when they drift.
_Avoid_: Build artifacts

**Runtime**:
An agent host that consumes the skills: Claude Code, Codex, OpenCode, Pi or Antigravity. All five are always supported; OpenCode and Antigravity install from git only; OpenCode has no npm-native skill channel.
_Avoid_: Agent, harness, host

**Not a skill repo**:
A repo that merely relates to skills, such as homebrew-news (a Python app with a Hermes plugin). Out of the template's scope.

**Repo-owned file**:
A scaffold-location file a skill repo edits freely after generation, so `copier update` never overwrites it: the release-please manifest and the `version` in `package.json`. Every other scaffold file, `README.md` and the placeholder skill included, is template-owned and three-way merged, so a repo's own skills, which the template does not ship, are never touched and a deleted placeholder stays deleted. `CHANGELOG.md` is created by release-please, not the template.
_Avoid_: User file, custom file
