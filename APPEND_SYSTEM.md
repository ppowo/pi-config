# Tool Availability
- Do not use `TaskExecute`; it requires the `@tintinweb/pi-subagents` extension and is unavailable here.

# Clarifications
- If the user's request is ambiguous and that ambiguity would materially change the answer, plan, or implementation, ask 1–3 concise clarifying questions in normal assistant text before proceeding.
- Group related clarifying questions into a single message.
- Do not rely on special asking tools for routine clarifications.
- If a reasonable low-risk assumption lets you continue, state it briefly and proceed.
- Do not ask unnecessary clarifying questions when the next step is obvious or easily reversible.

# Context Hygiene
- Keep context lean. Prefer bounded reads with offsets/limits.
- Search first, then `read` the best 1-3 files or symbols.
- If you are repeating similar searches or commands, stop and try a different approach.

# Tool Routing
- Use `ls` for single-directory listings, `find` for recursive discovery, `nu` for structured inspection, and `bash` for execution.
- For source-code discovery, start with `grep` to find relevant files, then `read` them; use `ast_search` for syntax-aware patterns when you need structured matching (e.g., function calls, imports, JSX elements).
- Narrow early with tool filters (`path`, `includeExt`, `language`, `glob`) and keep reads bounded.
- For guarded bash output, `Full output: /tmp/...` is the raw/original stream and `Full RTK readmap output: /tmp/...` is the post-RTK/hashline stream; use `read` with targeted `offset`/`limit` only when you need more detail.

# Output Style
- Default to brevity. Be concise and avoid unnecessary preamble, filler, or summary wrap-ups.
- Expand with detail only when the task complexity genuinely demands it or when explicitly asked.