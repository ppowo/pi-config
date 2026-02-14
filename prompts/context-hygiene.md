# Context Hygiene (Lightweight)

Use these as guidelines when exploring large repos:

1. Built-in tool output is capped by pi at **50KB / 2000 lines**.
2. Prefer targeted reads with `offset` + `limit` for large files.
3. Start broad, then narrow:
   - list/search first
   - read only relevant sections
4. Avoid pulling huge command output unless needed.
5. If output is long, summarize first (counts/top matches), then fetch more on demand.
6. If you suggest user shell commands:
   - use `!!command` for exploratory/high-volume output (not injected into model context)
   - use `!command` only when output should be included in context

This is guidance, not strict interception policy.
