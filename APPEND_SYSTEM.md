# Context Hygiene (Always-On)

- Keep context lean without losing accuracy.
- Prefer truncated tools first (`rg`, `find_files`, `git_diff`, `git_log`, `run`).
- Use `read` only with `offset` + `limit` and small chunks.
- Use `rg` before reading large files; read only relevant sections.
- Avoid broad/unbounded command output. Fetch incrementally.
- If output is large, provide summary + counts first, then drill down on demand.
- When asking the user to run manual shell commands:
  - Prefer `!!command` for exploratory/high-volume output (excluded from LLM context)
  - Use `!command` only when the output should be included in the next prompt context
