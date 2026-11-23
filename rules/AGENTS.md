# agy-fast-nyeowsz Tool Routing & Latency Hygiene Rules

Batch work through `mcp_agy-fast-nyeowsz_fast_*` to amortize the ~1.8s MCP remote check and stay under the 8.8 KB inline cap; use built-in `read_file` (~7ms, 0 remote check, 46 KB/call) for fast parallel reads.

| Situation | Preferred Tool |
| :--- | :--- |
| Trace a symbol (definition + callers/usages/imports) | `batch_search` (`def` + `refs` together in 1 call) |
| Run `>=2` text/regex/glob/fuzzy/read-only `git` queries | `batch_search` (pack all queries into 1 call) |
| Map symbols across `>=2` unfamiliar files or any `>300L` file | `quick_outline` -> then parallel `read_file` |
| Read `<=300L` files or known line ranges | Parallel built-in `read_file` (all targets in 1 turn) |
| Edit `>=2` blocks/files, `moveTo`/`delete`, or edit + `verify` | `apply_edits` (use built-in `edit_file` for 1 small hunk without `verify`) |
| Run `>=2` independent non-interactive shell commands | `run_checks` (`compact` for build/lint/test; `full` for diagnostics) |

## Workflow Rules

1. **Locate (`batch_search`)**: When tracing a symbol, pair `type: "def"` with `includeBody: true` AND `type: "refs"` in the **same** call (shared symbol cache; `includeBody: true` auto-inlines `<=40`-line defs and previews larger ones with exact `Lstart-Lend`). Reserve `text`/`regex` for literals, routes, or unknown names. Pack all independent searches and read-only `git` queries into one call (glob uses `*`/`{a,b}`, not regex `|`).
2. **Read (`quick_outline` + parallel `read_file`)**: Never emit 1 `read_file` when `>=2` target files or ranges are already known—batch all `read_file` calls in parallel in ONE turn. Use `batch_search`'s `(NL)` file lengths: read `<=300L` files in a single `read_file(1, N)` call (never split a `<=300L` file into two reads); for `>300L` files or `>=2` unfamiliar multi-symbol files, call `quick_outline` first (10-20 files/batch, max 40; use `read_slices` only to piggyback 1-2 tiny `<=120L` slices), then parallel `read_file` on the needed spans. Never blind-read `1-800` or bulk-read `>150L` via `read_slices`.
3. **Edit & Verify (`apply_edits`, `run_checks`)**: Use `apply_edits` across code, Vue/HTML/CSS, docs, and scripts; prefer `moveTo`/`delete` over shell `mv`/`rm`, and combine edits + `verify` in one call. For `>15`-line rewrites, use guarded range hunks (`startLine`, `endLine`, `anchorStart`, `anchorEnd`, `replacement`) instead of echoing the old block in `target`. Pass `bestEffort: true` for `>=3` files (batches `<=6-8`).

## Host & Session Hygiene

- **Eager invocation & explicit `cwd`**: Call `mcp_agy-fast-nyeowsz_fast_*` directly; always pass explicit workspace `cwd` (required on Desktop 2.0 Hub). Keep to one MCP call per turn—never fire 2 parallel calls to the same MCP tool.
- **Corruption circuit-breaker**: If `apply_edits` reports nested-arg corruption (`boolean`/`null`/`[]` on legacy lazy hosts), do **not** retry—fall back to parallel `edit_file`/`write_file`.
- **Snapshot & context**: Read the `SessionStart` snapshot before `ls`/`git status`. Keep subagent reports concise; run `git diff`/`show` with `--stat` or path filters first; delegate `.png`/`.jpg`/`.webp` inspection to a text-only subagent in `>150k`-token sessions (avoids 40-97s prompt-cache invalidation); suggest `/compact` or a fresh session between major phases (`>200k` tokens).
- **Swarm workers**: Brief workers to batch read-only exploration into one compound command and use parallel ranged `read_file` (`<=200` lines).

> Tip: Add personal overrides in `rules/AGENTS.local.md` with `---\ntrigger: always_on\n---` frontmatter (gitignored and preserved across plugin updates/re-installs).
