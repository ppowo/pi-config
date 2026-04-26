---
name: to-issues
description: Break the current conversation context, plan, spec, or PRD into independently-grabbable local issue drafts using tracer-bullet vertical slices. Use when user wants to convert a plan into local implementation tickets or break down work into issues without GitHub/network access.
---

# To Issues

Break a plan, spec, PRD, or current conversation context into independently-grabbable local issue drafts using vertical slices (tracer bullets).

This skill is fully local/offline. Do NOT create GitHub issues, open browsers, call `gh`, use GitHub APIs, use network access, or require any external service.

## Output Location

Write one Markdown file containing all drafted issues under:

```text
~/.pi/issues/
```

If the directory does not exist, create it before writing the issue draft file.

Use this filename format:

```text
YYYY-MM-DDTHH-mm-ssZ--home-relative-working-directory--slug.md
```

Rules:

- Use the current UTC timestamp.
- Derive `home-relative-working-directory` from the current working directory relative to `$HOME`.
- Sanitize `home-relative-working-directory` for filenames:
  - Remove any leading `/`, `./`, `../`, or `~` markers.
  - Replace path separators with `-`.
  - Replace characters unsafe for filenames with `-`.
  - Collapse repeated `-` characters.
  - Keep it reasonably bounded so filenames do not become excessively long.
- Derive `slug` from the issue-breakdown title or source topic.
- Sanitize `slug` the same way.
- Use `.md` as the extension.

Example:

```text
~/.pi/issues/2026-04-25T14-32-08Z--Developer-pi-config--offline-issue-drafts.md
```

After writing the issue draft file, report the exact created path to the user.

## Process

### 1. Gather context

Work from whatever is already in the conversation context, including a pasted plan, spec, PRD, or design discussion.

If the user refers to a local file, read that local file. Do not fetch remote URLs or GitHub issues.

### 2. Explore the codebase if needed

If needed, explore the codebase enough to understand the current state, existing modules, tests, and integration points before drafting issues.

Keep exploration bounded. Do not inspect unrelated parts of the repo.

### 3. Draft vertical slices

Break the plan into **tracer bullet** issues. Each issue is a thin vertical slice that cuts through all relevant integration layers end-to-end, NOT a horizontal slice of one layer.

<vertical-slice-rules>
- Each slice delivers a narrow but complete path through every relevant layer.
- A completed slice is demoable or verifiable on its own.
- Prefer many thin slices over few thick ones.
- Avoid splitting by layer, such as separate backend-only, frontend-only, or tests-only issues, unless there is a strong reason.
</vertical-slice-rules>

### 4. Quiz the user before writing

Present the proposed breakdown as a numbered list. For each slice, show:

- **Title**: short descriptive name
- **Blocked by**: which other slices, if any, must complete first
- **User stories covered**: which user stories this addresses, if the source material has them

Ask the user:

- Does the granularity feel right? Too coarse or too fine?
- Are the dependency relationships correct?
- Should any slices be merged or split further?

Iterate until the user approves the breakdown.

### 5. Write the local issue draft file

After approval, write one Markdown file containing all drafted issues to `~/.pi/issues/` using the filename rules above.

Do not create pi task tracker entries with `TaskCreate`. The output of this skill is the local Markdown issue draft file only.

## Frontmatter

Start the issue draft file with frontmatter:

```md
---
title: <Issue breakdown title>
created: <UTC ISO timestamp>
source: pi
working_directory: <absolute working directory>
---
```

## Issue Draft Template

Use this template for the generated Markdown file:

```md
## Summary

A short summary of the source plan/spec/PRD and the issue breakdown strategy.

## Issues
### Issue 1: <Title>

**Blocked by:** None / Issue N: <Title>

**User stories covered:** <List, or "Not specified">

#### What to build

A concise description of this vertical slice. Describe the end-to-end behavior, not layer-by-layer implementation.

#### Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

### Issue 2: <Title>

...
```

Keep issue descriptions implementation-oriented enough to be actionable, but avoid brittle code snippets or file paths unless they are essential for clarity.
