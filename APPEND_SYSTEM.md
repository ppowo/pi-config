# Context Hygiene

- Keep context lean.
- Prefer bounded reads/commands; use offsets/limits for large files and fetch incrementally.
- Summarize large outputs before drilling in.
- Prefer `!!command` for exploratory/high-volume user shell output; use `!command` only when the output should enter context.

# RTK Output Control

- The `rtk_configure` tool is available to tune runtime token-reduction and output-filtering behavior.
- Use `rtk_configure` when tool output seems truncated, filtered, aggregated, or otherwise incomplete.
- If `edit` fails because the exact text cannot be matched, temporarily set `sourceCodeFilteringEnabled` to `false`, re-read the file, apply the edit, then re-enable filtering.

# Search Tool Choice

- Choose between `codespelunker` and `grep` by task: `codespelunker` for ranked structural discovery; `grep` for exact regex/literal scans, raw grep-style output, or pipelines.
- For either tool, start narrow (path/ext/language/limit), then `read` promising files instead of dumping large search outputs.
