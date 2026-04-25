---
name: to-prd
description: Turn the current conversation context into a PRD and write it to a local Markdown file. Use when user wants to create a PRD from the current context.
---

This skill takes the current conversation context and codebase understanding and produces a PRD. Do NOT interview the user broadly — just synthesize what you already know, except for the single checkpoint described below.

This skill is fully local/offline. Do NOT create GitHub issues, open browsers, call `gh`, use GitHub APIs, or require network access.

## Output Location

Write one Markdown file per PRD under:

```text
~/.pi/prds/
```

If the directory does not exist, create it before writing the PRD.

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
- Derive `slug` from the PRD title.
- Sanitize `slug` the same way.
- Use `.md` as the extension.

Example:

```text
~/.pi/prds/2026-04-25T14-32-08Z--Developer-pi-config--offline-prd-generation.md
```

After writing the PRD, report the exact created path to the user.

## Process

1. Explore the repo to understand the current state of the codebase, if you haven't already.

2. Sketch out the major modules you will need to build or modify to complete the implementation. Actively look for opportunities to extract deep modules that can be tested in isolation.

A deep module (as opposed to a shallow module) is one which encapsulates a lot of functionality in a simple, testable interface which rarely changes.

Check with the user that these modules match their expectations. Check with the user which modules they want tests written for. This is the only required checkpoint; do not conduct a broad interview.

3. Write the PRD using the template below to a local Markdown file in `~/.pi/prds/`.

## Frontmatter

Start the PRD with frontmatter:

```md
---
title: <PRD title>
created: <UTC ISO timestamp>
source: pi
working_directory: <absolute working directory>
---
```

## PRD Template

<prd-template>
## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A LONG, numbered list of user stories. Each user story should be in the format of:

1. As an <actor>, I want a <feature>, so that <benefit>

<user-story-example>
1. As a mobile bank customer, I want to see balance on my accounts, so that I can make better informed decisions about my spending
</user-story-example>

This list of user stories should be extremely extensive and cover all aspects of the feature.

## Implementation Decisions

A list of implementation decisions that were made. This can include:

- The modules that will be built/modified
- The interfaces of those modules that will be modified
- Technical clarifications from the developer
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions

Do NOT include specific file paths or code snippets. They may end up being outdated very quickly.

## Testing Decisions

A list of testing decisions that were made. Include:

- A description of what makes a good test (only test external behavior, not implementation details)
- Which modules will be tested
- Prior art for the tests (i.e. similar types of tests in the codebase)

## Out of Scope

A description of the things that are out of scope for this PRD.

## Further Notes

Any further notes about the feature.
</prd-template>
