# Merge-replay eval

Measures the quality of merge-forge's **Resolve with AI** pipeline by replaying
merges a human already resolved. For each of the last N merge commits in a repo:

1. Check out parent 1 in a temporary worktree and re-run the merge, reproducing
   the exact conflicts the human faced.
2. Build the same `ExplainRequest` the merge editor would send (same chunker,
   same rich-baseline prompt with branch intent, same tools, same streaming code
   as the extension — `src/ai/*` is imported directly).
3. Let the configured model resolve the conflicts (tools enabled: readFile,
   searchCode, gitContext; findSymbol degrades gracefully outside the editor).
4. Apply the resolutions and diff against what the human actually committed.

## Run

```sh
# From the merge-forge repo root; costs real API tokens.
ANTHROPIC_API_KEY=sk-… pnpm run eval -- --repo /path/to/some-repo --merges 10

# Other providers:
DEEPSEEK_API_KEY=… pnpm run eval -- --repo … --provider deepseek
MERGE_FORGE_EVAL_KEY=… pnpm run eval -- --repo … --provider custom --base-url http://localhost:11434/v1 --model qwen2.5-coder
```

Flags: `--repo <path>` (required), `--merges N` (default 10), `--provider`
(default `anthropic`), `--model` (default: provider's default), `--base-url`
(custom provider only), `--out <dir>` (default `dev/eval/out`).

## Output

Per-case verdicts on stdout, plus `dev/eval/out/`:

- `results.json` — every case with `exact` / `whitespace` / `different` / `error`
- `<merge>-<file>.diff` — human-vs-AI unified diff for every `different` case

## What the verdicts mean

- **exact** — the AI produced byte-for-byte what the human committed.
- **whitespace** — identical modulo trailing whitespace.
- **different** — a real divergence. Not automatically wrong (humans sometimes
  resolve poorly, or make unrelated edits in the same commit) — read the diff.

## Use as a regression check

Run once against a familiar repo and keep `results.json`. After any change to
`src/ai/prompt.ts`, the tool set, or step budgets, re-run with the same repo and
compare the exact/different counts — a prompt "improvement" that drops the exact
count is a regression, caught before it ships.

Notes: temp worktrees are cleaned up on every path (merge aborted, worktree
removed). Octopus merges and delete/modify conflicts are skipped. The eval never
ships in the `.vsix` — `dev/` is excluded from packaging.
