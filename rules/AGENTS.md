# agy-fast-nyeowsz Tool Routing & Latency Hygiene Rules

Batch work through `mcp_agy-fast-nyeowsz_fast_*` to amortize the ~1.8s MCP remote check and stay under the 8.8 KB inline cap; use built-in `read_file` (~7ms, 0 remote check, 46 KB/call) in parallel for fast reads.

| Situation | Preferred Tool |
| :--- | :--- |
| Trace a known code symbol (definition + body + callers/imports) | `batch_search` (`type: "symbol"`, or `def` + `refs` together) |
| Run `>=2` text/regex/glob/fuzzy/read-only `git` queries | `batch_search` (pack all queries into 1 call) |
| Inspect any `>300L` file or `>=2` unfamiliar multi-symbol files | `quick_outline` (or `read_slices` + `<=2` tiny slices) -> parallel `read_file` |
| Read `<=300L` files or known line ranges | Parallel built-in `read_file` (all targets in 1 turn) |
| Edit `>=2` blocks/files, `create`, `moveTo`/`delete`, or edit + `verify` | `apply_edits` (use built-in `edit_file` for 1 small hunk without `verify`) |
| Run `>=2` independent non-interactive shell commands | `run_checks` (`compact` for build/lint/test; `full` for diagnostics) |

## Core Rules

1. **Locate (`batch_search`) — never use `type: "text"` for a known symbol name.**
   - Use **`type: "symbol"`** for functions, classes, methods, types, interfaces, hooks, services, schemas, and exported constants (`parseConfig`, `AuthService.login`, `fcmTokens`): 1 query returns exact `Lstart-Lend` + auto-inlined `<=40L` body (`includeBody` defaults to `true`) + caller-tagged `refs` over a shared symbol cache. Use standalone `def` or `refs` only when you need just one side.
   - Reserve `text`/`regex` for string literals, routes, error messages, config keys, or unknown names. Pack all independent searches, `glob` (`*`/`{a,b}`, never regex `|`), `fuzzy`, and read-only `git` queries into ONE call.
   - Act on `(NL)` file line counts and `[next]` / `[tip]` hints returned by `batch_search`.

2. **Outline before reading large files (`quick_outline`, `read_slices`).**
   - Always call **`quick_outline`** (10–20 paths/batch, max 40) on any `>300L` file or `>=2` unfamiliar multi-symbol files before calling `read_file`. Never blind-read `1-800` or piecemeal slices (`L400-560`, `L535-640`) of a `>300L` file.
   - Use **`read_slices`** only when combining `outlines` with 1–2 tiny (`<=120L`) slices via `lineRanges` (never bulk-read `>150L` through `read_slices`).

3. **Read in parallel (`read_file`).**
   - Batch every known read into ONE parallel turn — never emit single sequential `read_file` calls when `>=2` files or line spans are known.
   - For any file reported as `<=300L`, read it whole in one `read_file(1, N)` call (never split a `<=300L` file across turns).

4. **Edit & Verify (`apply_edits`, `run_checks`).**
   - Use `apply_edits` across code, Vue/HTML/CSS, docs, and scripts; prefer `moveTo`/`delete` over shell `mv`/`rm`; attach `verify` in the same call.
   - For `>15`-line rewrites, use guarded range hunks (`startLine`, `endLine`, `anchorStart`, `anchorEnd`, `replacement`) instead of echoing the old block in `target`. Pass `bestEffort: true` for `>=3` files (batches `<=6-8`).
   - Use `run_checks` for `>=2` shell commands (`outputMode: "compact"` for build/typecheck/lint/test; `"full"` for diagnostics).

## Host & Session Hygiene

- **Eager invocation & explicit `cwd`**: Call `mcp_agy-fast-nyeowsz_fast_*` directly; always pass explicit workspace `cwd` (required on Desktop 2.0 Hub). Keep to **one MCP call per turn** — never fire 2 parallel calls to the same MCP tool.
- **Corruption circuit-breaker**: If `apply_edits` reports nested-arg corruption (`boolean`/`null`/`[]` on legacy lazy hosts), do **not** retry — fall back to parallel `edit_file`/`write_file`.
- **Snapshot & context**: Read the `SessionStart` snapshot before `ls`/`git status`. Keep subagent reports concise; run `git diff`/`show` with `--stat` or path filters first; delegate `.png`/`.jpg`/`.webp` inspection to a text-only subagent in `>150k`-token sessions; suggest `/compact` or a fresh session between major phases (`>200k` tokens).
- **Swarm workers**: Brief workers to batch read-only exploration into one compound command, read `<=300L` files whole in parallel using `(NL)` counts, and outline `>300L` files before ranged `read_file`.

> Tip: Add personal overrides in `rules/AGENTS.local.md` with `---\ntrigger: always_on\n---` frontmatter (gitignored and preserved across plugin updates/re-installs).
