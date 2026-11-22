# agy-fast-nyeowsz Tool Routing & Latency Hygiene Rules

Use `agy-fast-nyeowsz_fast` MCP tools where batching amortizes the fixed per-call remote check (~1.8s) and keeps context lean, and use built-in `read_file` for allowlisted fast reads (~7ms, 46 KB inline cap per call):

| Task | Preferred Tool | Reason |
| :--- | :--- | :--- |
| Outline unknown large files (>300 lines; 10-20 files/batch, max 40) | `quick_outline({ paths })` (or `read_slices` to piggyback 1-2 tiny slices) | 1 call maps exact symbol/section line ranges without blind dumps |
| Read small files (<300 lines) OR any known line ranges after outlining | Built-in `read_file` (parallel in 1 turn, `StartLine`/`EndLine` <=200 lines) | ~7ms, **0 remote check**, **46 KB/call** vs MCP's 8.8 KB cap |
| Run >=2 text/regex/def/refs/glob/fuzzy/read-only `git` queries | `batch_search` (pack ALL queries into 1 call) | 1 remote check + concurrent local execution (<70ms), <=8.8 KB |
| Edit >=2 blocks, edit/create/move/delete >=2 files, OR edit + verify | `apply_edits` (`bestEffort: true` for >=3 files; `moveTo` + `hunks`; optional `verify`) | Replaces N serial checks + `mv`/`rm` + verify turn |
| Run >=2 independent non-interactive shell commands | `run_checks` (`compact` for build/lint/test; `full` for diagnostics) | 1 remote check + concurrent execution instead of N serial calls |

## Rules

1. **Direct invocation (no schema read turn)**: Call `mcp_agy-fast-nyeowsz_fast_*` directly when eagerly loaded; on older lazy hosts call `call_mcp_tool` with `ServerName: "agy-fast-nyeowsz_fast"` using Quick Schemas below—never spend a turn reading `mcp/agy-fast-nyeowsz_fast/*.json`.
2. **Symbol tracing (`def`/`refs`) & parallel `read_file`**: Always use `batch_search` `type: "def"` for definitions (`includeBody: true` for small defs <=40 lines to skip a follow-up read) and `type: "refs"` for callers/usages/imports—reserve `text`/`regex` for literals, routes, or unknown names. After locating targets, batch all `read_file(StartLine, EndLine)` calls in parallel in ONE turn—never ping-pong serial 1-file loops.
3. **Outline first, read via parallel `read_file`**: On unknown files >300 lines, call `quick_outline` (or `read_slices` with <=2 tiny <=120-line slices), then read needed <=200-line sections with parallel `read_file`. Never bulk-read >150 lines across files via `read_slices` (8.8 KB cap) or blind-read `1-800`.
4. **Keep images out of long coding sessions**: Loading `.png`/`.jpg`/`.webp` into a long (>150k-token) session can trigger prompt-cache invalidation (40-97s TTFT). Delegate image inspection to a subagent returning a **text-only** summary unless strictly unavoidable.
5. **Prevent context bloat**: Keep subagent reports concise (no raw dumps). For large `git diff`/`git show`, run `--stat` or path-scoped diffs first. Batch aggressively and recommend `/compact` or a fresh session between major phases (>200k tokens).
6. **Guarded range edits, `moveTo`/`delete`, `bestEffort` & circuit-breaker**: Use `apply_edits` across code, Vue/HTML/CSS, docs, and scripts; prefer `moveTo`/`delete` over shell `mv`/`rm`. For >15-line block rewrites, use guarded range hunks `{ startLine, endLine, anchorStart, anchorEnd, replacement }` instead of echoing the full old block in `target` (cuts output tokens ~50%; keep `target` for small edits). Pass `bestEffort: true` for >=3 files (batches <=6-8). If `apply_edits` reports nested-arg corruption (`boolean`/`null`/`[]`), do **not** retry—fall back to parallel `edit_file`/`write_file`.
7. **ONE MCP call per turn, explicit `cwd`, snapshot & swarm workers**: Combine cross-repo searches into one `batch_search` and edits + verify into one `apply_edits`; always pass explicit `cwd` (Desktop 2.0/Hub); read the `SessionStart` snapshot before `ls`/`git status`; avoid 2 parallel calls to the same `agy-fast-nyeowsz_fast` tool in one turn. Brief swarm workers to batch read-only exploration into one compound command and use parallel ranged `read_file` (<=200 lines).

## Quick Schemas (`ServerName: "agy-fast-nyeowsz_fast"`)

- **`batch_search`**: `{ cwd?, queries: [{ type: "text"|"regex"|"def"|"refs"|"glob"|"fuzzy"|"git", pattern, path?, glob?, fileType?, multiline?, outputMode?: "content"|"files_with_matches"|"count", sortBy?: "path"|"mtime", caseSensitive?, contextLines?: 0..5, maxResults?: 1..200, includeBody?: boolean }], maxChars?: 500..8800 }` (1-20 queries; `def` returns verified `Lstart-Lend`; `refs` keeps imports, skips comments/defs, tags callers; glob uses `*`/`{a,b}`).
- **`apply_edits`**: `{ cwd?, edits: [{ path, hunks?: [{ target?, replacement, startLine?, endLine?, anchorStart?, anchorEnd?, replaceAll? }], create?: string, overwrite?: boolean, delete?: boolean, moveTo?: string }], dryRun?, bestEffort?, verify?: string, verifyTimeoutSec?, maxVerifyChars?: 300..7500 }` (1-50 files; `delete`/`create` mutually exclusive; `moveTo` combines with `hunks`/`overwrite`; lazy hosts also accept JSON array string).
- **`quick_outline`**: `{ cwd?, paths: string[], maxChars?: 1000..8800 }` (flat outline-only; 10-20 files/batch, max 40).
- **`read_slices`**: `{ cwd?, outlines?: string[], slices?: [{ path, ranges: [[startLine, endLine], ...] }], lineRanges?: string[], maxChars?: 1000..8800 }` (`lineRanges` accepts `"path:start-end,start2-end2"`).
- **`run_checks`**: `{ cwd?, commands: [{ name?, command, cwd?, timeoutSec? }], concurrency?: 1..8, timeoutSec?, outputMode?: "compact"|"full", maxChars?: 500..8800 }` (1-12 commands).

> Tip: Add personal overrides in `rules/AGENTS.local.md` with `---\ntrigger: always_on\n---` frontmatter (gitignored and preserved across plugin updates/re-installs).
