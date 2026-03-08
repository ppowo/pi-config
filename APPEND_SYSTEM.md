# Context Hygiene

- Keep context lean.
- Prefer bounded reads/commands; use offsets/limits for large files and fetch incrementally.
- Summarize large outputs before drilling in.
- Prefer `!!command` for exploratory/high-volume user shell output; use `!command` only when the output should enter context.

# Search Tool Choice

- Choose between `codespelunker` and `grep` by task: `codespelunker` for ranked structural discovery; `grep` for exact regex/literal scans, raw grep-style output, or pipelines.
- For either tool, start narrow (path/ext/language/limit), then `read` promising files instead of dumping large search outputs.
