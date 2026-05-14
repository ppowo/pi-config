---
name: pi-config-setup
description: Clone or update the ppowo/pi-config repository into $HOME/Developer/pi-config, run npm run setup, and reload pi configuration. Use when installing, updating, bootstrapping, or reloading the user's pi-config repository.
---

# pi-config Setup

## Quick start

1. Run a dry-run first:

   ```bash
   bash "$HOME/.pi/agent/skills/pi-config-setup/scripts/setup-pi-config.sh" --dry-run
   ```

2. If the plan is correct, run the setup:

   ```bash
   bash "$HOME/.pi/agent/skills/pi-config-setup/scripts/setup-pi-config.sh"
   ```

3. After the script succeeds, reload pi:
   - In interactive pi, type `/reload`.
   - If the agent cannot issue slash commands directly, tell the user: "Please run `/reload` in pi to load the updated configuration and skills."

## Workflow

- Target directory: `$HOME/Developer/pi-config`.
- Repository URL: `git@github.com:ppowo/pi-config.git`.
- The script creates `$HOME/Developer` if needed.
- If the target does not exist, it clones the repository there.
- If the target already exists and is a git repo with a matching `origin`, it updates using `git pull --ff-only`.
- If the target exists but is not the expected repo, stop and explain the conflict instead of overwriting user files.
- The script then runs `npm run setup` inside `$HOME/Developer/pi-config`.

## Options

```bash
# Preview actions only
bash "$HOME/.pi/agent/skills/pi-config-setup/scripts/setup-pi-config.sh" --dry-run

# Override the repository URL for forks or HTTPS clones
PI_CONFIG_REPO_URL="https://github.com/ppowo/pi-config.git" \
  bash "$HOME/.pi/agent/skills/pi-config-setup/scripts/setup-pi-config.sh"

# Override the target directory
PI_CONFIG_TARGET="$HOME/Developer/pi-config-test" \
  bash "$HOME/.pi/agent/skills/pi-config-setup/scripts/setup-pi-config.sh"
```

## Verify

After `/reload`, confirm the updated skills/extensions/settings are visible in the current pi session. If anything changed on disk but is not visible, run `/reload` again or restart pi.
