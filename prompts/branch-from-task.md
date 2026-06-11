---
description: Create and switch to a local git branch from a task description
argument-hint: "[from <local-branch>] <ticket-or-task description>"
---

You are helping me create a new local git branch from a task description.

Goal:
- Infer a valid branch name from the task text I provide.
- Confirm the branch name, base branch, and exact command before changing git state.
- Create and switch to the new branch with `git switch -c <branch> <base>` only after confirmation.

Input from me:
$ARGUMENTS

Argument parsing:
1. Recognize only a leading `from <local-branch>` clause as the base branch selector.
   - Example: `from main ABC-1234 fix login redirect` means base branch `main`.
   - Strip the leading `from <local-branch>` clause before inferring ticket, scope, or summary.
   - Do not recognize `base <branch>` or non-leading uses of `from`; those are task text.
2. If no leading `from <local-branch>` is provided, use the current local branch as the base.
3. If HEAD is detached and no explicit `from <local-branch>` was provided, abort and say to rerun with `from <local-branch>`.
4. The remaining task text must contain a meaningful task description. If it is missing, empty, or only a ticket number/key, stop and ask for a short task description.

Branch format:
- With a ticket number: `<scope>/<ticket-number>-<kebab-summary>`
- Without a ticket number: `<scope>/<kebab-summary>`

Ticket handling:
- Accept generic Jira-style keys like `ABC-1234`, but use only the numeric part in the branch name: `1234`.
- Accept a bare ticket number like `1234`.
- If exactly one Jira-style key is present, prefer it over bare numbers in the rest of the text.
- If multiple Jira-style keys are present, or if there are multiple bare-number candidates and no single Jira-style key, stop and ask which ticket number to use.
- If no ticket number is found, stop and ask: `No ticket number found. Create a non-ticket branch?`
- If I confirm that no ticket is required, continue using the non-ticket branch format.
- Do not include any Jira project prefix in the branch name.

Scope and summary generation:
- Infer `scope` from the task text, using project language where possible: subsystem, module, feature, package, command, config area, or concern.
- Use exactly one scope segment before the slash.
- Make scope lowercase kebab-case. If the natural scope has multiple words, join them with hyphens.
- Make summary concise lowercase kebab-case.
- Keep meaningful action verbs such as `fix`, `add`, `update`, `remove`, `rename`, or `support`.
- Avoid filler scopes or summaries like `misc`, `stuff`, `changes`, `work`, or `update-stuff`.

Branch-name validation:
- Use lowercase only.
- Use exactly one `/` between scope and summary.
- Use kebab-case words separated by single hyphens.
- Do not use spaces or underscores.
- Do not end any segment with `/`, `.`, or `-`.
- Do not include double slashes `//`.
- Do not include Git-invalid ref characters such as `~`, `^`, `:`, `?`, `*`, `[`, `\`, or ASCII control characters.
- Keep the branch name around 80 characters or less unless a longer name is clearly justified.
- Validate the final candidate with `git check-ref-format --branch <branch>` before proposing it.

Required safety checks before proposing a branch:
1. Verify this is a git worktree.
2. Check `git status --porcelain`.
   - If there is any output, abort immediately.
   - Explain that the working tree is dirty and this prompt does not handle dirty state, stashing, committing, or carrying changes.
3. Determine the base branch.
   - If explicit, verify it is an existing local branch using `git show-ref --verify refs/heads/<base>`.
   - Reject remote-tracking bases such as `origin/main`; this prompt only branches from local branches.
4. Check whether the local base differs from its known remote-tracking counterpart.
   - Do not run `git fetch` or any network operation.
   - Prefer the configured upstream from `git rev-parse --abbrev-ref <base>@{upstream}` if it exists.
   - Otherwise, if `refs/remotes/origin/<base>` exists, compare against `origin/<base>`.
   - If no upstream or matching remote-tracking ref exists, proceed.
   - Compare with `git rev-list --left-right --count <base>...<tracking-ref>`.
   - If either count is non-zero, abort clearly. I need to decide manually what to do when the base is ahead of, behind, or diverged from remote.
5. Check whether the proposed local branch already exists using `git show-ref --verify refs/heads/<branch>`.
   - If it exists, abort clearly and ask me to choose a different summary or switch manually.

Confirmation requirement:
- Before creating the branch, show:
  - Proposed branch
  - Base branch
  - Exact command to be run
- Ask for confirmation before running the command.

Use this confirmation format:

```text
Proposed branch: <branch>
Base branch: <base>

Will run:
git switch -c <branch> <base>

Proceed?
```

After confirmation:
1. Re-run the safety checks that can change: clean working tree, base branch exists, base-vs-tracking comparison, and branch does not already exist.
2. Run exactly:
   `git switch -c <branch> <base>`
3. If successful, reply only with a concise success message, for example:
   `Created and switched to branch <branch> from <base>.`
4. If it fails, explain why and what I should do next.

Safety requirements:
- Treat this as a one-shot branch creation prompt.
- Create at most one branch, then stop.
- Do not commit, push, fetch, pull, merge, rebase, stash, or modify files.
- Do not perform network operations.
- Do not silently recover from dirty state, stale/diverged base state, ambiguous tickets, invalid branch names, or existing branch names.
