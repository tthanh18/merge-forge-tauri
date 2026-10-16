# Publishing MergeForge 1.0.0

The 1.0.0 `.vsix` is built and versioned; this file is the gate between it and the
marketplace. Run the QA checklist on real repos first — publishing is one command
once it passes.

## Live QA checklist

Editor + workflow:

- [ ] Resolve a real multi-conflict file end to end; Apply stages it (`git status` shows resolved).
- [ ] Rebase case: mid-`git rebase`, the left pane, blame chips, and timeline all show _your_ work on the left.
- [ ] Kill the window mid-merge, reopen the file → "Restore / Discard" banner; Restore is byte-exact.
- [ ] `mergeForge.autoAdvance` walks a 3-file merge without stopping.
- [ ] A conflicted binary file (e.g. an image) refuses with the friendly message.
- [ ] Editor font: change `editor.fontSize` → panes match it on next open.

AI (each backend you can reach):

- [ ] VS Code + Copilot: ✦ Explain streams; watch for ⚙ tool activity (needs recent VS Code).
- [ ] Cursor + your API key: ✦ Resolve fills the result pane; Cmd+Z undoes per conflict.
- [ ] ▶ Fix all on a mixed file: safe changes instant, conflicts AI-resolved, combined report.
- [ ] Wrong API key → the drawer shows the invalid-key message with the setup command.

Authorship + history:

- [ ] GitHub-hosted repo: avatars load; "Open commit on GitHub" lands on the right commit.
- [ ] Repo with no GitHub remote: initials chips, no dead links.
- [ ] ⟲ timeline: lanes match the branches; Esc returns with chunk state intact.

First-run:

- [ ] Fresh profile (`code --profile mf-test`): the walkthrough appears under Welcome → Walkthroughs.

## Publish

1. **Push the repo to GitHub** (`github.com/ognjenmarcheta/merge-forge`, matching
   package.json's `repository`). The marketplace serves README images from the repo —
   without the push, the listing shows broken images.
2. **VS Code Marketplace** — needs publisher **ByteForge Software** (`byte-forge`) at
   [marketplace manage](https://marketplace.visualstudio.com/manage) and an Azure DevOps
   PAT with Marketplace→Manage scope:
   ```sh
   npx vsce login byte-forge
   npx vsce publish --no-dependencies          # or: npx vsce publish -i merge-forge-1.0.0.vsix
   ```
3. **Open VSX** (how Cursor/VSCodium users install without a vsix) — needs an
   [open-vsx.org](https://open-vsx.org) account + token:
   ```sh
   npx ovsx publish merge-forge-1.0.0.vsix -p <token>
   ```
4. Tag the release: `git tag v1.0.0 && git push --tags` (CI attaches the vsix artifact).

If QA finds an issue: fix, `pnpm run check`, rebuild the same 1.0.0 — nothing has
shipped until step 2.
