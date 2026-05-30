---
name: to-issues
description: Break a plan, spec, or PRD into independently-grabbable issues using tracer-bullet vertical slices, and present the breakdown as an HTML report in /tmp. Use when user wants to convert a plan into issues, break down work into slices, or see a vertical-slice breakdown.
---

# To Issues

Break a plan into independently-grabbable issues using vertical slices (tracer bullets).

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the user passes an issue reference (issue number, URL, or path) as an argument, fetch it and read its full body and comments.

### 2. Explore the codebase (optional)

If you have not already explored the codebase, do so to understand the current state of the code. Issue titles and descriptions should use the project's domain glossary vocabulary, and respect ADRs in the area you're touching.

### 3. Draft vertical slices

Break the plan into **tracer bullet** issues. Each issue is a thin vertical slice that cuts through ALL integration layers end-to-end, NOT a horizontal slice of one layer.


<vertical-slice-rules>
- Each slice delivers a narrow but COMPLETE path through every layer (schema, API, UI, tests)
- A completed slice is demoable or verifiable on its own
- Prefer many thin slices over few thick ones
</vertical-slice-rules>

### 4. Quiz the user

Present the proposed breakdown as a numbered list. For each slice, show:

- **Title**: short descriptive name
- **Blocked by**: which other slices (if any) must complete first
- **User stories covered**: which user stories this addresses (if the source material has them)

Ask the user:

- Does the granularity feel right? (too coarse / too fine)
- Are the dependency relationships correct?
- Should any slices be merged or split further?

Iterate until the user approves the breakdown.

### 5. Generate HTML report

Write a self-contained HTML file to the OS temp directory. Resolve the temp dir from `$TMPDIR`, falling back to `/tmp` (or `%TEMP%` on Windows), and write to `<tmpdir>/vertical-slice-breakdown-<timestamp>.html` so each run gets a fresh file. Open it for the user — `xdg-open <path>` on Linux, `open <path>` on macOS, `start <path>` on Windows — and tell them the absolute path.

The report uses **Tailwind via CDN** for layout and styling, and **Mermaid via CDN** for dependency graphs. For styling guidance, patterns, and tone, read the [HTML-REPORT.md](~/.pi/agent/git/github.com/mattpocock/skills/skills/engineering/improve-codebase-architecture/HTML-REPORT.md) from the improve-codebase-architecture skill — reuse the same scaffold, colour palette, and diagram conventions.

<report-structure>

#### Header

Title: "Vertical Slice Breakdown — {project/plan name}", date, and a legend: solid box = slice, dashed arrow = blocked-by dependency.

#### Dependency graph

A Mermaid `flowchart` showing all slices as nodes, with arrows for blocked-by relationships.

#### Slice cards

Each approved slice is an `<article>` card:

- **Title** — short descriptive name
- **Badge row** — blocked-by references as inline links to other cards
- **User stories covered** — bullet list (if applicable)
- **Description** — end-to-end behavior, not layer-by-layer implementation
- **Acceptance criteria** — checklist (display only, not interactive)

#### Summary section

Total slices and a suggested execution order (respecting dependencies).

</report-structure>

No paragraphs of explanation. If a diagram needs a paragraph to be understood, redraw the diagram.
