# Adopting the template into an existing skill repo

The recipe from adopting scoop-bucket-skills, ghost-library-skills and homebrew-tap-skills, and from the first `copier update` (scoop, v0.1.2 to v0.2.0). It is for the template maintainer and is not shipped to rendered repos. ADR 0003 records why it is a document and not a skill.

Each adoption is one PR in the adopting repo, pinned at a release tag, with an ADR (`docs/decisions/NNNN-adopt-the-copier-skill-repo-template.md`) that lists every remaining difference and its reason.

## Recipe

1. **Branch** off the repo's default branch (`feature/adopt-copier-skill-repo-template`).
2. **Derive the answers** from the files the repo already has: `repo_name` and `description` from `.ai-rulez/config.toml` or `package.json`, `keywords` from the same (include `pi-package` only if the existing manifests carry it, so the generated manifests do not change), `publish_to_npm: false` unless the repo publishes, `license` from its `LICENSE`. Put them in a JSON file.
3. **Render over the repo, tasks skipped, at a release tag:**
   `copier copy --trust --overwrite --defaults --skip-tasks --vcs-ref vX.Y.Z --data-file answers.json https://github.com/hasansezertasan/copier-skill-repo .`
4. **Undo what the render clobbers.**
   - Restore `README.md` (`git checkout README.md`), then change only its development commands.
   - Delete the placeholder skill (`.ai-rulez/skills/<placeholder_skill>/`).
   - Set `package.json`'s `version` and `.release-please-manifest.json` back to the released version. A repo with no release yet keeps the template's `0.0.0` and gets `0.1.0` through `initial-version`; say so in the ADR, because the generated manifests then read `0.0.0`.
5. **Reconcile `.ai-rulez/config.toml`.** Start from the repo's own file. Keep its custom preset, rule opt-outs and `shared_resources`. Set `version_from = "package.json"`. Add `AR9T0 = "off"` with the template's comment inside the existing `[lint.severity]` table, never a second table. Keep an existing marketplace name when install commands use it. Name the npm commands in comments and in the context note that generates `AGENTS.md`.
6. **Swap the old plumbing.** Move the version carrier (`pyproject.toml`) to `package.json`; delete the old release guard and its test; move `.config/release-please-*` to the repo root; replace Makefile or mise tasks with npm scripts, keeping only tool pins in `.config/mise.toml`.
7. **Keep what the template does not ship.** A root `hooks/`, `agents/`, `commands/` or other host-loaded component the repo ships on purpose goes in `.config/root-components.json` as `{"<component>": "<reason>"}`, and the ADR repeats the reasons. The repo's own unit tests run through `npm test` and one extra step in `check.yml`; an eval task becomes `npm run eval`. Keep `check.yml` otherwise as rendered, with every action pinned by SHA.
8. **Layer repo content** onto `CONTRIBUTING.md` (a "<Repo> development" section before "Skill layout") and `docs/installation.md` (the install prompt and "Then use it" table). Both are template-owned and merge on `copier update`.
9. **Fix stale references:** `grep` for the old commands (`mise run`, `make`, `pyproject.toml`, the old guard) outside the skills, which may legitimately cite the commands of the repo they operate on. Update `docs/host-support.md` to list Pi and Antigravity as not evaluated.
10. **Run the install and generate tasks**, then `npm run generate`, `npm run check` and `npm test`. Check again on the committed tree: `AR961` plugin-version drift fails the check while generated output differs from `HEAD`, and clears once committed.
11. **Write the ADR**, commit, push and open the PR. Review the diff before it is pushed; bots flag claims in docs that outrun the evidence recorded in `docs/host-support.md`.
12. **After the merge:** change the required status check from `validate` to `check` in branch protection, close the repo's old Renovate PRs for tools that moved into `package.json`, and close the adoption ticket here.

## Updating an adopted repo

`copier update --trust --skip-tasks --vcs-ref vX.Y.Z` in a fresh branch. Expect conflicts in `README.md` (keep the repo's), `.ai-rulez/config.toml` (merge into the existing `[lint.severity]` table), `CONTRIBUTING.md` and `docs/installation.md` (keep both sides).

Skip the tasks. The template's `_tasks` run `npm install` and `npm run generate` inside the update, before you can resolve the conflicts, and generating without the repo's `shared_resources` rewrites every skill: each `SKILL.md` changes and the per-skill `references/` copies are deleted (seen in scoop-bucket-skills#24, where the links in six skill files changed). So resolve `.ai-rulez/config.toml` first, keeping the repo's `shared_resources`, then run `npm install` and `npm run generate` yourself and check that `skills/` and the manifests do not change unless the template meant them to. If `skills/` drifts, restore the setting and run `npm run generate` again before committing.

## Known gaps

- The template renders a README skeleton, so `copier update` conflicts on every adopter's own README whenever the skeleton changes.
- Nothing automates steps 2 to 9.
