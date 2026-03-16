---
name: share-session
description: Generate a share link for the current Claude Code session
argument-hint: "[--local] [--read-only] [--port N] [--public-base-url URL]"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/share-current-session.sh:*)"]
---

# Share Current Session

Run the session share launcher for the current Claude Code session:

```!
"${CLAUDE_PLUGIN_ROOT}/scripts/share-current-session.sh" --local $ARGUMENTS
```

Return the resulting URL to the user. If the launcher reports an existing share
link, return that link instead of creating a new one.
