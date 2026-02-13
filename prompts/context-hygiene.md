# Context Hygiene & Safe Exploration Policy

**Always minimize context footprint while preserving task accuracy.**

These rules are enforced both by prompt policy (here) and hard tool-call interception (`context-guard.ts`). Violating them will result in blocked tool calls with an explanation.

## 1. Mandatory exploration workflow
1. Use `rg` first to scope search before reading files.
2. Use `read` with `offset` + `limit` for paginated reads only.
3. Never read full large files unless explicitly requested by the user.

## 2. Read limits
- Default chunk: **200 lines** (`limit: 200`).
- Maximum chunk without explicit user approval: **400 lines**.
- If a file appears larger than 1000 lines, only read targeted sections relevant to the task.
- **Every `read` call MUST include a `limit` parameter.** Calls without `limit` will be blocked.

## 3. Search limits
- Use `rg` for searching. Output is capped to **300 lines or 16KB**.
- **Do NOT use the built-in `grep` tool** — use `rg` instead (it has proper truncation).
- Truncation notice + temp file path are included when truncated.

## 4. File listing limits
- Use `find_files` for directory listings. It auto-excludes noise dirs and caps output.
- **Do NOT use the built-in `find` or `ls` tools** — use `find_files` instead (it has proper truncation and sane defaults).
- For quick directory overviews, use `find_files` with `maxdepth: 2`.

## 5. Command-output limits
Use the dedicated truncated tools for high-volume command output:
- **`git_diff`** — for git diff (returns stat summary + truncated patch)
- **`git_log`** — for git log (defaults to `--oneline -n 20`)
- **`find_files`** — for file/directory listings (excludes noise dirs, maxdepth 5)
- **`run`** — for build, test, and log commands (tail-truncated, keeps errors at end)

**Do NOT use `bash` for:** `git diff`, `git log`, `git show`, `find`, recursive `ls`, `cat`, `head`/`tail` with large counts, `less`, `more`, or `strings`. These will be blocked and redirected to the dedicated tools above.

When suggesting **user-run shell commands**:
- Prefer **`!!command`** for exploratory/high-volume output (excluded from LLM context).
- Use **`!command`** only when output should be included in the next prompt context.

## 6. Tool preference order
For any task, prefer tools in this order:
1. Dedicated truncated tools (`rg`, `git_diff`, `git_log`, `find_files`, `run`)
2. `read` with `offset`/`limit`
3. `bash` only for commands that don't produce large output (e.g. `mkdir`, `mv`, `cp`, `npm install`, short `git status`)

**Avoid:** built-in `grep`, `find`, `ls` tools — they lack our truncation caps.

## 7. Context hygiene rule
- If output is long, return:
  - counts / summary stats
  - top matches / entries
  - next-step suggestions
- Only fetch additional output on explicit user demand.
- When truncation occurs, note the temp file path and offer to read specific sections from it.

## 8. Compaction
Auto-compaction triggers at **80k tokens** via `trigger-compact.ts`. This means context is actively managed — you do not need to omit useful detail to "save space." Focus on accuracy and let compaction handle the rest. You can also trigger it manually with `/trigger-compact [instructions]`.

## 9. Safety net
Even if a tool call slips through, `context-guard.ts` will truncate any tool result exceeding 300 lines / 16KB after execution. But prefer using the right tool to begin with.
