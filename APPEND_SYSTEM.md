# Tool Availability
- Do not use `TaskExecute`; it requires the `@tintinweb/pi-subagents` extension and is unavailable here.

# Context Hygiene
- Keep context lean. Prefer bounded reads with offsets/limits.
- Use `!!command` for high-volume output; `!command` when output belongs in context.

# File Exploration Policy
- Use `ls` for single-directory listings.
- Use `find` for recursive file discovery.
- Use `nu` for structured data, filesystem analysis, and system inspection.
- Use `bash` for executing project commands, not routine exploration.
# Mandatory Code Search Policy
- This policy applies to searching source-code contents, not to file exploration or structured inspection.
- Use `ls` and `find` for file exploration.
- Use `nu` for structured data and system inspection.
- Do not start source-code exploration with `grep` or bash unless the task is explicitly exact text, literal, or regex matching.
- Use `codespelunker` for first-pass code discovery: likely implementations, concepts, declarations, usages, comments, and strings.
- Use `ast_search` for syntax-aware patterns such as imports, function calls, JSX, and specific code shapes.
- Use `grep` only for exact text/literal/regex scans, raw output, or shell pipelines after you know the target.
- Narrow early with `path`, `includeExt`, `language`, `mode`, or small result limits; broaden only if needed.
- Search first, then `read` the best 1-3 files or symbols instead of dumping large search output into context.
- When trimmed bash output includes `Full output: /tmp/...`, use `read` on that path if you need more command output or context.