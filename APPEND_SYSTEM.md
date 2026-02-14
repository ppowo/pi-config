# Context Hygiene (Lightweight)

- Keep context lean without losing accuracy.
- Built-in `read`/`bash` tool output is capped by pi (**50KB / 2000 lines**).
- For large files, prefer `read` with `offset` + `limit` in smaller chunks.
- Avoid broad/unbounded command output; fetch incrementally.
- If output is large, summarize counts first, then drill down only where needed.
- When asking the user to run shell commands:
  - Prefer `!!command` for exploratory/high-volume output (excluded from model context)
  - Use `!command` only when output should be included in the next prompt context
