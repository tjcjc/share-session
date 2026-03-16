# session-share Claude plugin

This plugin adds a `/share-session` slash command to Claude Code.

It expects the compiled binary to exist at:

```text
../dist/claude-session-share
```

relative to the plugin directory.

## Local development

```bash
claude --plugin-dir /path/to/claude-session-share/plugin
```

Then, inside Claude Code:

```text
/share-session
/share-session --read-only
/share-session --local
```
