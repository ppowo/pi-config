---
name: improve-codebase-architecture
description: Find deepening opportunities in a codebase. Use when the user wants to improve architecture, find refactoring opportunities, consolidate tightly-coupled modules, or make a codebase more AI-navigable.
---

# Improve Codebase Architecture

Surface architectural friction and propose **deepening opportunities** — refactors that turn shallow modules into deep ones. The aim is clarity, locality, leverage, maintainability, and AI-navigability.

This vendored version is fully local/offline. Do NOT create HTML files, open browsers, use CDN assets, or require network access. Present the output directly in the chat session. Do NOT write .md files unless the user explicitly asks you to save the report to a file.

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

## Output
Present the architecture review directly in the chat session using the structure defined below. Do NOT write a .md file to disk unless the user explicitly asks you to save the report.

## Process

### 1. Explore

Explore the codebase directly and note where you experience architectural friction:

- Where does understanding one concept require bouncing between many small modules?
- Where are modules **shallow** — interface nearly as complex as the implementation?
- Where have functions been extracted in a way that scatters the real concept across call sites, losing **locality**?
- Where do tightly-coupled modules leak across their seams?
- Which parts of the codebase are hard to understand, change, or navigate through their current interface?

Apply the **deletion test** to anything you suspect is shallow.

### 2. Present the Report in Chat

Present the report directly in the chat session using the structure below. Do NOT write a file to disk unless the user explicitly asks you to save it.


Use this structure in your chat response:

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

Do NOT propose detailed interfaces yet. After presenting the review, ask the user: "Which of these would you like to explore?"

Stop there. This skill only produces the architecture review report and a short follow-up question.

