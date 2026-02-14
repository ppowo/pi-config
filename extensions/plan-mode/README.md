# Plan Mode Extension

Read-only planning workflow with explicit execution handoff.

## Safety model

When plan mode is enabled:

- Only plan-mode tools are allowed (`read`, `grep`, `find`, `ls`, `bash`, `questionnaire`, `question` when available)
- `edit` and `write` are always blocked
- `bash` tool calls are filtered by `isSafeCommand()`
- User shell commands (`!` / `!!`) are also filtered by `isSafeCommand()`

## Plan artifact writes

Plan mode is read-only for repository changes, with one intentional write path:

- Plan markdown files under `~/Plans/*.md`
- Plan filenames are derived from the plan's `Scope` section (preferring `In scope`) and capped to 4 words.

Refinement updates are restricted to previously saved plan files in that same directory.

## File layout

- `index.ts` — extension lifecycle hooks and UI flow
- `utils.ts` — bash safety checks and todo extraction helpers
- `validation.ts` — lenient plan validation (sections + steps analysis)
- `storage.ts` — safe plan file path handling, save/load/open helpers
