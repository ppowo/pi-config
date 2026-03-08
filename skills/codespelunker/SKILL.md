---
name: codespelunker
description: Ranked structural code search with codespelunker; use grep for exact regex/literal scans.
compatibility: Requires the codespelunker extension plus cs available in PATH.
---

# Codespelunker

Use the `codespelunker` tool alongside `grep` when you want **better-ranked and more structurally aware results** than plain grep.

## When to Use It

Use `codespelunker` when you need to:

- find the most relevant implementation, not just every text hit
- search by concept or intent using normal code terms
- jump to declarations or call sites
- search only in code, comments, or strings
- narrow by extension, language, or path before reading files
- explore a subsystem without dumping a massive grep result into context

Use plain `grep` when you specifically need:

- exact raw regex or literal matching
- shell pipelines or command-line post-processing
- a very fast broad text scan where ranking does not matter
- output that must exactly match grep behavior

## Default Search Budget

The extension already keeps output small. Keep your own searches disciplined too:

1. Start with the default result limit.
2. Narrow with `path`, `includeExt`, `language`, or `mode` before increasing breadth.
3. Only raise `resultLimit` when exploring broadly or when the first pass is clearly insufficient.
4. Read promising files after search instead of asking for huge snippets.
5. Switch to `grep` if exact text/regex behavior is the better fit for the task.

## Parameter Guide

### Core

- `query` — required search query
- `path` — optional file or directory scope
- `resultLimit` — small by default; only increase when needed
- `snippetLength` — keep small unless the user asks for broader context

### Structural filters

- `mode: "code"` — code only
- `mode: "comments"` — comments only
- `mode: "strings"` — string literals only
- `mode: "declarations"` — definitions / declarations
- `mode: "usages"` — call sites / references

### Ranking and narrowing

- `gravity: "brain"` — favor more complex implementation files
- `gravity: "logic"` — mild implementation bias
- `gravity: "off"` — pure text relevance
- `includeExt` — comma-separated extensions such as `ts,tsx,md`
- `language` — comma-separated language names such as `TypeScript,Go`
- `caseSensitive` — enable only when exact case matters
- `dedup` — collapse repeated identical matches

## Good First Searches

### Find the implementation

Use when the user describes behavior or a subsystem:

```text
codespelunker({
  query: "theme selection and bootstrap settings",
  includeExt: "ts,json"
})
```

### Jump to definitions

```text
codespelunker({
  query: "permission gate",
  mode: "declarations",
  includeExt: "ts"
})
```

### Find call sites / usages

```text
codespelunker({
  query: "reload runtime",
  mode: "usages",
  includeExt: "ts"
})
```

### Search only comments or strings

```text
codespelunker({
  query: "TODO OR FIXME OR HACK",
  mode: "comments",
  resultLimit: 4
})
```

```text
codespelunker({
  query: "error",
  mode: "strings",
  resultLimit: 4
})
```

### Focus on a subdirectory first

```text
codespelunker({
  query: "tool registration and prompt guidelines",
  path: "extensions",
  includeExt: "ts"
})
```

### Bias toward the real implementation

```text
codespelunker({
  query: "authentication",
  gravity: "brain"
})
```

## Workflow

1. Search with `codespelunker`.
2. Pick 1-3 promising results.
3. Use `read` on those files.
4. Refine with `path`, `mode`, or `includeExt` if results are noisy.
5. Fall back to `grep` only if exact text/regex behavior is the real need.

## Fallback

If the extension is unavailable but `cs` exists, you may use bash as a last resort with similar constraints:

```bash
cs "query" --dir . --format json --snippet-mode lines --snippet-count 1 --result-limit 6 --snippet-length 180
```

Prefer the dedicated tool when it is available because it already formats and truncates output for the model.
