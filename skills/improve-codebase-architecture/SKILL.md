---
name: improve-codebase-architecture
description: Find deepening opportunities in a codebase. Use when the user wants to improve architecture, find refactoring opportunities, consolidate tightly-coupled modules, or make a codebase more AI-navigable.
---

# Improve Codebase Architecture

Surface architectural friction and propose **deepening opportunities** — refactors that turn shallow modules into deep ones. The aim is clarity, locality, leverage, maintainability, and AI-navigability.

This vendored version is fully local/offline. Do NOT create or open HTML files, open browsers, use CDN assets, or require network access. Reports must be Markdown files.

## Architecture Vocabulary

Use these terms consistently in every suggestion.

**Module**: Anything with an interface and an implementation. Applies equally to a function, class, package, or tier-spanning slice. Avoid: unit, component, service.

**Interface**: Everything a caller must know to use the module correctly: type signature, invariants, ordering constraints, error modes, required configuration, and performance characteristics. Avoid: API, signature.

**Implementation**: What's inside a module — its body of code.

**Depth**: Leverage at the interface. A module is **deep** when a large amount of behaviour sits behind a small interface. A module is **shallow** when the interface is nearly as complex as the implementation.

**Seam**: A place where behaviour can vary without editing the caller; where a module's interface lives. Avoid: boundary.

**Adapter**: A concrete thing that satisfies an interface at a seam.

**Leverage**: What callers get from depth: more capability per unit of interface they must learn.

**Locality**: What maintainers get from depth: change, bugs, and knowledge concentrated in one place rather than spread across callers.

## Principles

- **Depth is a property of the interface, not the implementation.**
- **The deletion test:** imagine deleting the module. If complexity vanishes, it was a pass-through. If complexity reappears across callers, it was earning its keep.
- **Prefer real seams over hypothetical seams.** A seam is useful when behaviour genuinely varies across it or when it concentrates an important concept.

## Output Location

Write one Markdown architecture review under:

```text
~/.pi-markdown/architecture-reviews/
```

If the directory does not exist, create it before writing the review.

Use this filename format:

```text
YYYY-MM-DDTHH-mm-ssZ--home-relative-working-directory--architecture-review.md
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
- Use `.md` as the extension.

After writing the review, report the exact created path to the user.

## Process

### 1. Explore

Explore the codebase directly and note where you experience architectural friction:

- Where does understanding one concept require bouncing between many small modules?
- Where are modules **shallow** — interface nearly as complex as the implementation?
- Where have functions been extracted in a way that scatters the real concept across call sites, losing **locality**?
- Where do tightly-coupled modules leak across their seams?
- Which parts of the codebase are hard to understand, change, or navigate through their current interface?

Apply the **deletion test** to anything you suspect is shallow.

### 2. Write A Markdown Report

Write a local Markdown file to `~/.pi-markdown/architecture-reviews/` using the output-location rules above. Do NOT write HTML. Do NOT open the file in a browser or app.

Start the review with frontmatter:

```md
---
title: <Architecture review title>
created: <UTC ISO timestamp>
source: pi
working_directory: <absolute working directory>
---
```

Use this structure:

```md
## Summary

A short summary of the review scope and the architectural friction found.

## Candidates

### Candidate 1: <Title>

**Files:** <which files/modules are involved>

**Recommendation strength:** Strong / Worth exploring / Speculative

#### Problem

Why the current architecture is causing friction.

#### Solution

Plain English description of what would change. Do NOT propose detailed interfaces yet.

#### Benefits

Explain in terms of **locality**, **leverage**, comprehension, and maintainability.

#### Before

A concise text description of the current shape.

#### After

A concise text description of the proposed deepened shape.

## Top recommendation

Which candidate to tackle first and why.
```

For each candidate include files/modules involved, problem, solution, benefits, before/after shape, and recommendation strength.

End the report with a **Top recommendation** section.

Do NOT propose detailed interfaces yet. After the file is written, ask the user: "Which of these would you like to explore?"

Stop there. This skill only produces the architecture review report and a short follow-up question.
