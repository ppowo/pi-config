# Plan Mode Extension

Read-only planning workflow with explicit execution handoff.

## Safety model

When plan mode is enabled:

- Only plan-mode tools are allowed (`read`, `grep`, `find`, `ls`, `bash`, `questionnaire`, `question` when available)
- `edit` and `write` are always blocked
- `bash` tool calls are filtered by `isSafeCommand()`
- User shell commands (`!` / `!!`) are also filtered by `isSafeCommand()`

## Planning behavior

### Output style

Plan mode uses a single output style: **freeform markdown**.

- Goal/Scope/Assumptions/Plan/Risks/Validation headings are optional
- The model can choose the best structure for the task
- Plans should still include a clearly identifiable numbered or bulleted action list for execution tracking

### Clarifications (before and during)

Clarification behavior is fixed:

- Ask focused clarifying questions **before drafting** when critical information is missing
- Ask follow-up clarifications **during exploration** if ambiguity blocks progress
- Prefer `questionnaire` / `question` tools when available

If clarification is not possible, the model should state assumptions briefly and continue.

### Execution tracking

Execution tracking requires identifiable numbered or bulleted steps.

Todo extraction order:

1. `Plan:` section list items (numbered first, then bullets)
2. Numbered list fallback anywhere in response
3. Step-like list fallback from plan/steps-style headings
4. Final bullet fallback (needs enough items)

If no trackable steps are found, plan markdown still saves, but tracked execution may not be offered.

## Plan artifact writes

Plan mode is read-only for repository changes, with one intentional write path:

- Plan markdown files under `~/Plans/*.md`
- Plan filenames prefer `Scope`/`Goal`, then heading/content fallbacks, and are capped to 4 words
- Prompt text is used as a fallback naming hint when section-based naming is unavailable

Refinement updates are restricted to previously saved plan files in that same directory.

## File layout

- `index.ts` — extension lifecycle hooks and UI flow
- `utils.ts` — bash safety checks and todo extraction helpers
- `validation.ts` — plan validation (step analysis)
- `storage.ts` — safe plan file path handling, save/load/open helpers
