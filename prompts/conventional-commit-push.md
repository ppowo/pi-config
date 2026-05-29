---
description: Inspect current work only as needed, create a conventional commit, and push the current branch
argument-hint: "[extra instructions]"
---

You are helping me finish the current git work with a conventional commit and push.

Goal:
- Create a high-quality Conventional Commit for the current changes.
- Commit the changes.
- Push the current branch to its upstream remote.

Workflow:
1. First, use any relevant context already available in this conversation.
2. Inspect the current git state only if needed to understand what changed, verify staged/unstaged files, or avoid committing the wrong work.
3. If changes are not staged, stage the appropriate files for this task.
4. Generate a Conventional Commit message that accurately summarizes the change.
5. Commit using that message.
6. Push to the current branch's upstream remote.

Commit message requirements:
- Use Conventional Commits format: `type(scope): summary`.
- Use a concise, imperative summary.
- Add a body only if it materially improves clarity.
- Prefer common types such as `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `build`, or `ci`.
- Choose a scope only when it is helpful and obvious.

Safety requirements:
- Treat this command as a one-shot action only: create at most one commit and one push, then stop. Do not continue auto-committing or auto-pushing later in the session unless I explicitly invoke this prompt again.
- Do not include unrelated changes if they are clearly outside the current task.
- If the working tree contains changes that seem outside the current task but may be pre-existing completed work, stop and ask me whether those changes should be included, excluded, or left for later. Do not silently exclude them.
- If the working tree contains ambiguous or risky changes, stop and ask me before staging, committing, or pushing.
- If there is nothing to commit, say so and do not create an empty commit.
- If pushing fails, explain why and what I should do next.

Extra instructions from me:
$ARGUMENTS
