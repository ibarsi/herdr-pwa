# Agent notes

Releases are cut from commit subjects on `main`. A push to `main` runs `.github/workflows/cut-release.yml`, which uses `tools/release.js --ci` to bump `package.json`, write `CHANGELOG.md`, tag, and push with the release deploy key. The tag workflow then publishes `ghcr.io/ibarsi/herdr-pwa` and the GitHub Release notes. The human walkthrough is in the Releases section of `README.md`.

## Pull requests

- Squash-merge only. The pull request title becomes the commit on `main`, and that subject is what the changelog and the version bump read.
- Titles must match the grammar `tools/release.js` enforces: `type: description` or `type(scope)!: description`. CI rejects anything else.
- Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `revert`.
- `feat` bumps the minor. `fix` bumps the patch. `feat!:` or a `BREAKING CHANGE:` / `BREAKING-CHANGE:` footer is breaking. At `0.x` a breaking change bumps the minor and must not move the package to `1.0.0`. The other types do not cut a release on their own, but they appear in the next changelog.
- A subject the parser rejects is left out of the changelog. Do not use `wip`, `update`, or a free-form title.

## Version and image

- `package.json` `"version"` is the running version. The server reads it once at startup, and the image copies that file. Do not hardcode a version in the client or in `static/sw.js`.
- Do not edit the version or `CHANGELOG.md` by hand. `.github/workflows/cut-release.yml` owns both. `tools/release.js` also writes the `version` line of `herdr-plugin.toml`, and a test fails if it drifts from `package.json`. `0.0.0` is the unreleased baseline. The first real tag comes from that workflow.
- Reaching `1.0.0` is a deliberate edit of `package.json`, never a side effect of a breaking commit.
- `compose.yaml` pulls `ghcr.io/ibarsi/herdr-pwa:${HERDR_PWA_VERSION:-latest}`. Do not add a `build:` key. Test a Dockerfile change with `mise build`.
- The Dockerfile `COPY` list is hand-maintained. A new file the running server needs has to be added there. `tools/release.js` stays out of the image. It runs on the maintainer's machine and in GitHub Actions.

## What must stay true

- No npm dependencies, including devDependencies. The release parser is hand-rolled on purpose. Do not add `semver`, a linter, or a formatter.
- Node 26, ES modules, and `import.meta.main` as the CLI entry guard.
- `.github/workflows/ci.yml` triggers on `pull_request`, never `pull_request_target`. The pull request title is passed through `env`, never interpolated into `run`.
- `.github/workflows/cut-release.yml` is the only workflow that writes to `main`. It pushes with the `RELEASE_DEPLOY_KEY` deploy key, which is on the ruleset bypass list. Do not switch that push to `GITHUB_TOKEN`: a token push is rejected by the ruleset and does not start the tag workflow.
- `.github/workflows/release.yml` only reacts to `v*` tags.
- Every `uses:` is pinned to a full commit SHA with a `# vX.Y.Z` comment. Dependabot bumps both. `cut-release.yml` holds the deploy key that bypasses the ruleset, so a moved tag there could push to `main`.
- Do not run `node tools/release.js` without `--dry-run` unless the user asks. A push to `main` already cuts the release.

## Herdr plugin

- `herdr-plugin.toml` lists the repo in the Herdr plugin marketplace. The marketplace indexes the `herdr-plugin` GitHub topic and the manifest on `main`.
- The plugin is a launcher. `tools/plugin.sh` drives compose and Tailscale Serve, and reads `.env` from `HERDR_PLUGIN_CONFIG_DIR`. Do not route it through mise: Herdr launches without a login shell, and a fresh checkout's `mise.toml` is untrusted.
- `[[build]]` runs `tools/plugin.sh refresh`. Herdr re-runs builds on every `herdr plugin update` that moves the commit, with `HERDR_PLUGIN_*` scrubbed from the environment, so the script resolves its config with `herdr plugin config-dir`. A failed build aborts the install or update, so `refresh` exits 0 when there is no `.env`, when the adapter is stopped, or when the pull fails.
- No `[[startup]]` hook. Herdr runs startup hooks one-shot, not as daemons, and compose's restart policy already brings the adapter back.

## Code owners

`.github/CODEOWNERS` assigns the whole tree to `@ibarsi`. The `main` ruleset requires that review. Leave the file in place.
