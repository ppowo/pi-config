# Tool Availability
- Do not use `TaskExecute`; it requires the `@tintinweb/pi-subagents` extension and is unavailable here.

# Context Hygiene
- Keep context lean. Prefer bounded reads with offsets/limits.
- Search first, then `read` the best 1-3 files or symbols.
- If you are repeating similar searches or commands, stop and try a different approach.

# Tool Routing
- Use `ls` for single-directory listings, `find` for recursive discovery, `nu` for structured inspection, and `bash` for execution.
- For source-code discovery, start with `codespelunker`; use `ast_search` for syntax-aware patterns; use `grep` only for exact text or regex after you know the target.
- Narrow early with tool filters (`path`, `includeExt`, `language`, `mode`, `glob`) and keep reads bounded.
- When bash output points to `Full output: /tmp/...`, use `read` on that path only if you need more detail.
