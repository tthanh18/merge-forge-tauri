# Contributing to Merge Forge

Report bugs, suggest improvements, or submit a focused pull request. Follow the
[Code of Conduct](CODE_OF_CONDUCT.md). For vulnerabilities, use the private reporting route in
[SECURITY.md](SECURITY.md).

## Setup

Install Node.js 20 or later, pnpm 9.12.3, Git, and VS Code or Cursor. CI uses Node.js 20 and
pnpm 9.12.3.

Fork the repository for external contributions, clone your fork, and create a branch from `main`.
Run commands from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm run check
```

Git fixture tests create temporary repositories. Configure your normal Git name and email locally
if they are not already set. Never use real credentials or private repositories as test fixtures.

## Project layout

- `src/`: extension activation, Git operations, merge logic, AI integration, panels, and UI commands.
- `webview/`: the three-pane merge editor.
- `webview-conflicts/`: the conflicts dialog.
- `test/`: unit, Git-parity, bundled activation, and end-to-end tests.
- `dev/`: browser harness and optional AI replay evaluation tools.
- `media/`: README and extension artwork.
- `esbuild.mjs`: extension host and webview bundles, written to `dist/`.

## Debugging the extension

Open the repository in VS Code or Cursor and select **Run Extension** in Run and Debug. Press
**F5** to compile and launch an Extension Development Host using the committed launch configuration.
Use a disposable repository with merge conflicts to exercise the extension there.

For rebuilding as you edit:

```sh
pnpm run watch
```

Reload the Extension Development Host after changing extension code. The optional browser harness
is documented in the README's [Development section](README.md#development). AI replay tooling has
its own [guide](dev/eval/README.md); external model calls are not required for the standard checks.

## Checks

```sh
pnpm run check     # format, lint, typecheck, build, then all tests
pnpm run package   # build and package a local .vsix; does not publish it
```

The activation tests load `dist/extension.js`. A fresh build is therefore required before direct
test commands, including after changing source code:

```sh
pnpm run build
pnpm test
pnpm exec vitest run test/activation.test.ts
```

Use `pnpm run format` to format changes. Add behavioral regression coverage when fixing a bug.
Keep the activation tests and Git-parity checks enabled. Do not commit `dist/`, `.vsix` packages,
credentials, or local editor state.

## Pull requests

- Keep the change focused and describe the problem, resulting behavior, and checks you ran.
- Include reproduction steps for fixes and screenshots for visible UI changes.
- Preserve existing behavior unless the change explicitly requires otherwise.
- Link the relevant issue when one exists. Discuss large changes before implementing them.
- Use a clear commit message, such as `fix: preserve result line endings`.
- Open a draft PR while work or validation remains incomplete.

The repository owner merges manually after checks pass. Agents and bots may prepare branches and
PRs, but must not merge, approve on the owner's behalf, enable automatic merging, or bypass checks.

Publishing remains a maintainer action. See [PUBLISHING.md](PUBLISHING.md) for release QA and
marketplace steps; a contribution does not need a version bump unless the maintainer requests one.
