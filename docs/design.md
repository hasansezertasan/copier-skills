# copier-skill-repo design

Decisions from the design grilling session (2026-10-15). Terms are defined in `CONTEXT.md`; the generator choice is in `docs/adr/0001-ai-rulez-as-the-generator.md`. Surveyed repos: scoop-bucket-skills, ghost-library-skills, infra-copilot (skill repos) and homebrew-news (not one).

## Scope

- The template owns the scaffold only. It never owns skill content.
- It ships one placeholder skill: a minimal `SKILL.md` named from the `placeholder_skill` answer.
- Out of scope: Hermes packaging and repos like homebrew-news.
- Runtimes: Claude Code, Codex, OpenCode, Pi and Antigravity are always on. Antigravity installs from the Git URL, so its only artifact is a root `plugin.json` adapter (name and description from the answers); `check-repo.mjs` fails when it drifts from the generated Claude manifest.
- OpenCode install is git-only (copy or symlink `skills/` into `.agents/skills/`). OpenCode has no npm-native skill channel; a plugin published to npm could inject skills through OpenCode's plugin API, but the template does not generate one (`docs/research/opencode-npm-skills.md`).

## Tooling

- Source of truth is `.ai-rulez/`; ai-rulez v5 is pinned in `devDependencies`.
- Generated output is committed and checked for drift in CI. A Copier `_tasks` entry runs `npm install && npm run generate` after rendering; nothing generated is stored in the template.
- Task runner is `package.json` scripts only (`npm run check`, `npm run generate`). Node comes from `.node-version`. No mise, no Makefile.
- The version source is `package.json`, the one file release-please bumps. Pi installs from npm and needs the `pi-package` keyword and a `pi.skills` entry. ai-rulez owns those and the `files` allowlist (`[plugin.pi]` with `package_json = "merge"`), derived from the skills on disk, and the merge keeps the authored fields. ai-rulez rewrites the whole file (sorted keys, `"prompts": []`, `README.md` in `files`), so `package.json.jinja` is written in that exact form, with the placeholder skill's derived values, and a test proves generation leaves a fresh render unchanged; otherwise `copier update` conflicts with the generated file.
- Helper scripts (release guard, repository check) are dependency-free `.mjs` files.
- All ai-rulez lint rules are on by default, except `AR9T0` (below). A repo opts out per rule with a stated reason (scoop turns off `AR401` and `AR402` because its skills cite files of the bucket they operate on). The template itself turns off `AR9T0` (root-component-shipped), because the Antigravity adapter has to be the root `plugin.json`. With codex-cli 0.162.1 that file is ignored when it declares the Antigravity `$schema` (Codex uses `.codex-plugin/plugin.json`), but a root `plugin.json` declaring the portable agent-plugins.org `$schema` is adopted as Codex's manifest, so the adapter must keep the Antigravity one. The same rule also flags `.mcp.json`, `hooks/` and the other host-loaded root paths, so `scripts/check-repo.mjs` rejects those itself (ai-rulez 5.3.0's list, plus `agents/` and `commands/` from Claude's standard plugin layout, which it does not flag). A repo that ships one on purpose (infra-copilot's SessionStart hook, subagent and slash commands) lists it with a reason in the repo-owned `.config/root-components.json`; the template ships no such file, and an unknown name or empty reason fails the check.

## CI and release

- CI takes scoop's hardening level: every action pinned by SHA, `permissions: {}` with per-job scopes, `check.yml` unfiltered and reusable from `release.yml`.
- Release uses release-please on conventional commits.
- `publish_to_npm` (default yes) controls publishing with trusted publishing and provenance. When off, the publish job is dropped and `package.json` is `"private": true`; Pi users then install from git.
- Renovate extends `local>hasansezertasan/renovate-config`. Template updates arrive as `copier update` PRs through `.copier-answers.yml`, as in copier-pyproject.
- copier-skill-repo versions itself with release-please and git tags, which `copier update` resolves against.

## Questions the template asks

`repo_name`, `description`, `keywords`, `author_name` and `author_url` (default to Hasan Sezer Tasan), `github_owner` (default `hasansezertasan`), `license`, `placeholder_skill`, `publish_to_npm`. Derived: repository URL, marketplace name, display name.

## Docs and ownership

- Template-owned and three-way merged: `CONTRIBUTING.md` (includes the manual one-time setup checklist and a note on `references/` and `evals/` layouts) and `docs/installation.md` (per-runtime install steps).
- Repo-owned (never overwritten): the release-please manifest and `version` in `package.json`. Skills are not in `_skip_if_exists`: a skip pattern makes Copier recreate a deleted placeholder on every update, while the three-way merge keeps a deleted placeholder deleted and never touches skills the template does not ship. `README.md` is a three-way merged skeleton; `CHANGELOG.md` is created by release-please.
- Not owned: maintainers docs and per-repo ADRs.

## Rollout

- Template CI renders with defaults and runs `npm ci && npm run check`. Diffing against real repos belongs to each adoption PR.
- Adoption order: scoop-bucket-skills, then ghost-library-skills, then infra-copilot (ai-rulez v4, shell checks, no `package.json`).
- v1 ships no `setup` or `adopt` skills. After two repos are adopted, decide whether to add ones modeled on copier-pyproject's. Decided in `docs/adr/0003-no-setup-or-adopt-skills-yet.md`: not yet; `docs/adopting.md` holds the recipe.
