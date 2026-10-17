# Can an npm package deliver skills to OpenCode?

**Answer: Yes, indirectly.** There is no npm-native skill channel (no manifest field, no `node_modules` scan), but a plugin published to npm can inject skills through the plugin API. The v2 mechanism is explicit; the v1 mechanism is a config-hook mutation that is inferred from source and not verified at runtime.

## Versions checked

Local clone of `https://github.com/sst/opencode` (full history and tags), checked out at `dev` commit `8f7b0120eb6b4aa3da1f82b1a9094a9fb4db2d06` (workspace version `2.0.32`, `packages/cli/package.json`). The 1.x line was read from tag `v1.19.3` (latest 1.x tag in the clone) with `git show v1.19.3:<path>`. Paths below are relative to the repo root. Docs were fetched from opencode.ai/docs/{skills,plugins,config} and `https://opencode.ai/config.json`.

## (1) Can plugin code register extra skill paths or skills?

**v2 (`dev`, 2.0.x): yes, explicitly.** The plugin context exposes `ctx.skill.transform` and `ctx.skill.reload()`.
- `packages/plugin/src/README.md:75` lists `ctx.skill.transform` among the namespaced transform hooks; `:172` lists `ctx.skill.reload()`.
- `packages/plugin/src/promise/skill.ts:6-17`: `SkillEditor` has `list/get/add/update/remove`; `SkillDomain` adds `transform` and `reload`.
- `packages/schema/src/skill.ts:26-34`: `Skill.Info` is `{id, name, description?, autoinvoke?, path (absolute), content}`. A plugin can therefore add a skill with its body inline, without a directory on disk. `path` is still required and is used as the "base directory" for the model output (`packages/core/src/skill.ts:36-53`, `:55-68`), so it should point at real files if the skill ships scripts.
- `packages/core/src/skill.ts:74-80,94-112`: `Editor.add` writes into the skill state.
- It adds skill *records*, not skill *paths*. There is no plugin call to add a search directory; use the config `skills` array (below) or `editor.add` per skill.

**v1 (1.x, `v1.19.3`): not by an explicit API; probably by mutating config.**
- `packages/plugin/src/index.ts:222-225` (at `v1.19.3`): `Hooks.config?: (input: Config) => Promise<void>`. `Config` (`:70-72`) is the SDK config type, which includes `skills`. There is no `skill` hook.
- `packages/opencode/src/plugin/index.ts:244-253`: after plugins load, every hook's `config(cfg)` is called with `cfg = yield* config.get()` (`:152`).
- `packages/opencode/src/config/config.ts:620-622`: `config.get()` returns `s.config` from cached instance state, so the plugin receives the shared cached object.
- `packages/opencode/src/skill/index.ts:210-227`: skill discovery reads `cfg.skills?.paths` and `cfg.skills?.urls` from `config.get()` inside a lazily built `InstanceState` (`:259-272`).
- Inference: a plugin doing `config.skills = { paths: [dir] }` in its `config` hook should be picked up if discovery runs after plugin init. This is **not documented and not verified by execution** (see unverified).

## (2) The config `skills` array

**Published schema** (`https://opencode.ai/config.json`, `properties.skills`): `anyOf` of
1. array of strings: "Additional paths or URLs to discover skills from";
2. object `{paths?: string[], urls?: string[]}`, `additionalProperties: false`, marked `deprecated: true`.

**v2 behaviour** (`dev`):
- `packages/schema/src/config.ts:88-90`: `skills: string[]`, "Additional paths or URLs to discover skills from".
- `packages/core/src/config/normalize.ts:233-247`: array is taken as is; the object form is flattened to `[...paths, ...urls]`.
- `packages/core/src/config/plugin/skill.ts:77-103`: each item becomes a source. `http(s):` URL becomes a URL source (fetched via `SkillDiscovery.pull`, `:105-116`); `~/` expands to home; relative paths resolve against `location.directory`; absolute paths used as is. Also, every config directory contributes `<dir>/skill` and `<dir>/skills` (`:85-88`).
- Directory scan pattern `{*.md,**/SKILL.md}` (`:121`): in v2 a bare `*.md` at the root of a source directory is also a skill. Skill id/name rules: `packages/core/src/config/plugin/skill-file.ts:39-62`.

**v1 behaviour** (`v1.19.3`):
- Object form only in the v1 schema: `packages/core/src/v1/config/skills.ts:5-12` (`paths`, `urls`); `packages/core/src/v1/config/config.ts:44`.
- Array form is lowered to the object form: `packages/opencode/src/config/v2-compat.ts:154-162` (URLs split by `^https?://`). Config load runs this lowering (`config.ts` ~`:665` calls `ConfigV2Compat.lower`).
- Consumed at `packages/opencode/src/skill/index.ts:210-227` (paths: `~/` expand, relative to project `directory`, missing dir logs a warning and is skipped; urls via `discovery.pull`).

**Since which version** (from git history; tag dates are as recorded in the clone):
- Object form `skills.paths`: commit `45ec3105b1` "feat: support config skill registration (#9640)", first in `v1.1.43` (2026-01-30).
- `skills.urls` (well-known RFC discovery): commit `266de27a0b`, first in `v1.1.54` (2026-02-10).
- Array form: first tag where `packages/opencode/src/config` contains `Array.isArray(input.skills)` is `v1.18.24` (2026-08-28); native in 2.0.x (`packages/core/src/config/normalize.ts:233`). Tag/commit containment in this repo is irregular (e.g. `git tag --contains` on the introducing commit lists `v2.0.0` and unrelated tags), so treat `v1.18.24` as "first 1.x tag I could confirm", not a guarantee.

**Docs gap confirmed:** `opencode.ai/docs/skills` and `/docs/config` contain no mention of the `skills` config key (the skills page lists only `.opencode/skills`, `~/.config/opencode/skills`, `.claude/skills`, `.agents/skills`, and their global forms).

## (3) Any way for an npm-installed plugin or package to contribute skills?

- **No automatic path:** nothing scans `node_modules` for skills, and no `package.json` field maps to skills (searched `packages/core/src` and `packages/opencode/src` for skill sources: only config entries, config directories, `.claude/.agents` roots (`packages/core/src/config/plugin/compatibility.ts:40`), and URLs).
- **Plugin install:** docs (opencode.ai/docs/plugins, "From npm") say npm plugins named in the config `plugin` array are installed with Bun at startup and cached in `~/.cache/opencode/node_modules/`. Once loaded, the plugin runs with the hooks above.
- **Via plugin code:** v2 `ctx.skill.transform(editor => editor.add({...}))` (explicit); v1 `config` hook mutation (inferred). A plugin can ship `SKILL.md` files inside its package and point `path` or `skills.paths` at its own install directory (resolve with `import.meta.url`).
- **Via config only:** a user can add an absolute path into `node_modules` (or an https URL) to the `skills` array; this needs no plugin but is manual and brittle (cache path is not stable API).
- `~/.config/opencode/skills` and `.opencode/skills` are discovered, so a package postinstall/CLI that copies or symlinks skills there also works, but that is file placement, not npm delivery.

## Still unverified

- No OpenCode binary was run. The v1 `config`-hook mutation trick (mutating `cfg.skills`) rests on reading source: it needs discovery to run after the hook and `config.get()` to return the same object on later calls. Not tested.
- Whether v2 skills added with `editor.add` and a synthetic `path` render and load resources correctly in the TUI/skill tool was not exercised.
- v2.0.0 release status: tag `v2.0.0` exists and `dev` is `2.0.32`, but which npm release channel (`opencode-ai@latest`) ships v2 was not checked. The v2 plugin package is named `@opencode/plugin` here, whereas v1 plugins use `@opencode-ai/plugin`; compatibility of an npm plugin across both was not examined.
- The exact first release shipping the array form was not pinned beyond `v1.18.24` (see tag caveat).
- Plugin-loaded v1 hooks order vs. first skill discovery (`InstanceState` laziness) was not traced to a call site.
