# Tool Availability
- Do not use `TaskExecute`; it requires the `@tintinweb/pi-subagents` extension and is unavailable here.

# Context Hygiene
- Keep context lean. Prefer bounded reads with offsets/limits.
- Use `!!command` for high-volume output; `!command` when output belongs in context.

# Search Tools
- `codespelunker` — ranked, structural search (implementations, declarations, concepts)
- `grep` — exact regex, raw output, pipelines
