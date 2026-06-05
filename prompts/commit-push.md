---
description: Inspect current work only as needed, create a scoped commit, and push the current branch
argument-hint: "[extra instructions]"
---

You are helping me finish the current git work with a commit and push.

Goal:
- Create a high-quality Scoped Commit for the current changes.
- Commit the changes.
- Push the current branch to its upstream remote.

Workflow:
1. First, use any relevant context already available in this conversation.
2. Inspect the current git state only if needed to understand what changed, verify staged/unstaged files, or avoid committing the wrong work.
3. If changes are not staged, stage the appropriate files for this task.
4. Generate a Scoped Commit message that accurately summarizes the change.
5. Commit using that message.
6. Push to the current branch's upstream remote.

Commit message requirements:
- Use Scoped Commits format: `<scope>: <description>`.
- Put the subsystem, area, module, package, feature, or concern touched by the change first as the scope.
- Do not use Conventional Commit types such as `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `build`, or `ci` unless that word is genuinely the code area being changed.
- Choose the most specific useful scope that helps someone scanning the log find changes relevant to an area of the codebase.
- Use a concise, imperative description after the colon.
- Add a body only if it materially improves clarity.

Scope selection guidance:
- Prefer real project language from paths, modules, packages, features, commands, config names, docs sections, or domain terms.
- Good examples: `auth: reject expired sessions`, `prompts: switch commit helper to scoped commits`, `net/http: add request timeout`, `gitlab-ci: update macOS image`.
- Avoid vague scopes like `misc`, `changes`, `update`, or `stuff`.
- If the change spans multiple related areas, use a broader parent scope that honestly covers them.
- If there is no honest parent scope, list scopes separated by commas, e.g. `api,docs: document pagination limits`.
- If the change touches the whole tree, use a scope such as `treewide`, `global`, or the project name.
- Reverts, merges, and other special commits may use the default Git format when that is clearer.

Safety requirements:
- Treat this command as a one-shot action only: create at most one commit and one push, then stop. Do not continue auto-committing or auto-pushing later in the session unless I explicitly invoke this prompt again.
- Do not include unrelated changes if they are clearly outside the current task.
- If the working tree contains changes that seem outside the current task but may be pre-existing completed work, stop and ask me whether those changes should be included, excluded, or left for later. Do not silently exclude them.
- If the working tree contains ambiguous or risky changes, stop and ask me before staging, committing, or pushing.
- If there is nothing to commit, say so and do not create an empty commit.
- If pushing fails, explain why and what I should do next.

Extra instructions from me:
$ARGUMENTS
