# Tool Availability
- Do not use `TaskExecute`; it requires the `@tintinweb/pi-subagents` extension and is unavailable here.

# Context Hygiene
- Keep context lean. Prefer bounded reads with offsets/limits.
- Use `!!command` for high-volume output; `!command` when output belongs in context.

# Search Tools
- `codespelunker` — default for ranked structural discovery: likely implementations, declarations, usages, comments, or strings.
- `ast_search` — use for syntax-aware patterns when text search is brittle (imports, function calls, JSX, specific code shapes).
- `grep` — exact regex/literal scans, raw output, and shell pipelines.
- Narrow early with `path`, `includeExt`, `language`, `mode`, or small result limits; broaden only if needed.
- Search first, then `read` the most promising files or symbols instead of dumping large search output into context.
- When trimmed bash output includes `Full output: /tmp/...`, use `read` on that path if you need more command output or context.