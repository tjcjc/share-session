# claude-session-share

Single-binary Bun app that:

- reads a local Claude Code session from `~/.claude/projects/.../*.jsonl`
- creates a random share URL
- serves a web page with full session history
- lets a remote viewer continue the same Claude session from the browser

## Build

```bash
source ~/.bash_profile
cd claude-session-share
bun run compile
```

Binary output:

```bash
./dist/claude-session-share
```

Claude plugin directory:

```bash
./plugin
```

## List sessions

```bash
./dist/claude-session-share list --claude-root /path/to/.claude
```

## Share a session

```bash
./dist/claude-session-share serve \
  --claude-root /path/to/.claude \
  --session <session-id> \
  --claude-bin /path/to/claude \
  --host 0.0.0.0 \
  --port 3939 \
  --dangerously-skip-permissions
```

If the Claude session belongs to another local user and you run the server as root:

```bash
./dist/claude-session-share serve \
  --claude-root /home/other-user/.claude \
  --session <session-id> \
  --claude-bin /usr/local/bin/claude-local \
  --run-as-user other-user \
  --owner-home /home/other-user \
  --host 0.0.0.0 \
  --port 3939 \
  --dangerously-skip-permissions
```

The server prints a random URL like:

```text
http://127.0.0.1:3939/s/<random-token>
```

## Public URLs

If you put the server behind a reverse proxy or tunnel, pass the public base URL so the printed share link is correct:

```bash
./dist/claude-session-share serve \
  --claude-root /path/to/.claude \
  --session <session-id> \
  --claude-bin /path/to/claude \
  --public-base-url https://example.com \
  --dangerously-skip-permissions
```

## Read-only mode

```bash
./dist/claude-session-share serve \
  --claude-root /path/to/.claude \
  --session <session-id> \
  --claude-bin /path/to/claude \
  --read-only
```

## Notes

- The app reads the Claude session JSONL file directly.
- To continue a session, it calls `claude -p --resume <sessionId> ...`.
- It does not modify session files directly.
- Only one browser message is processed at a time for a session.
- `--dangerously-skip-permissions` is the most reliable mode for remote continuation, but it is also the least safe.

## Claude plugin command

The bundled plugin adds a `/share-session` slash command inside Claude Code.

Run Claude with the plugin directory:

```bash
claude --plugin-dir /path/to/claude-session-share/plugin
```

Then, inside the Claude session:

```text
/share-session
/share-session --read-only
/share-session --local
```

The command:

- detects the current `session_id`
- starts `claude-session-share serve` in a background `tmux` session
- creates a Cloudflare quick tunnel by default
- returns the final share URL to the Claude session

Requirements for the slash command path:

- `tmux`
- `cloudflared` for public links
- the compiled binary at `dist/claude-session-share`

For local network links, use `--local` and optionally pass `--host 0.0.0.0`.
