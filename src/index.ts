import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { discoverSessions, formatSessionList, getDefaultClaudeRoot, loadSession, resolveSessionFile, SessionTailer } from './session';
import type { ClientEvent, ParsedSession, ServerConfig } from './types';
import { renderHtml } from './ui';

function parseArgs(argv: string[]): { command: string; flags: Map<string, string | boolean> } {
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'serve';
  const args = command === 'serve' ? argv : argv.slice(1);
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < args.length; i += 1) {
    const part = args[i];
    if (!part.startsWith('--')) continue;
    const key = part.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith('--')) {
      flags.set(key, true);
      continue;
    }
    flags.set(key, next);
    i += 1;
  }
  return { command, flags };
}

function getFlag(flags: Map<string, string | boolean>, name: string, fallback?: string): string | undefined {
  const value = flags.get(name);
  if (typeof value === 'string') return value;
  return fallback;
}

function hasFlag(flags: Map<string, string | boolean>, name: string): boolean {
  return flags.get(name) === true;
}

function usage(): string {
  return [
    'claude-session-share',
    '',
    'Commands:',
    '  list --claude-root <path>',
    '  serve --session <id> [--project <projectId>]',
    '        [--session-file <path>] [--claude-root <path>]',
    '        [--claude-bin <path>] [--run-as-user <user>] [--owner-home <path>]',
    '        [--host <host>] [--port <port>] [--public-base-url <url>]',
    '        [--read-only] [--dangerously-skip-permissions]',
    '',
    'Examples:',
    '  claude-session-share list --claude-root /home/cc/.claude',
    '  claude-session-share serve --claude-root /home/cc/.claude --session 7d9e... --run-as-user cc --owner-home /home/cc --claude-bin /usr/local/bin/claude-local --dangerously-skip-permissions'
  ].join('\n');
}

function localAddresses(host: string, port: number): string[] {
  const urls = new Set<string>();
  if (host === '0.0.0.0' || host === '::') {
    const interfaces = os.networkInterfaces();
    for (const entries of Object.values(interfaces)) {
      for (const entry of entries ?? []) {
        if (entry.internal) continue;
        urls.add(`http://${entry.address}:${port}`);
      }
    }
  } else {
    urls.add(`http://${host}:${port}`);
  }
  return [...urls];
}

function buildConfig(flags: Map<string, string | boolean>, resolved: Awaited<ReturnType<typeof resolveSessionFile>>): ServerConfig {
  const claudeRoot = path.resolve(getFlag(flags, 'claude-root', getDefaultClaudeRoot())!);
  const port = Number.parseInt(getFlag(flags, 'port', '3939')!, 10);
  if (Number.isNaN(port) || port <= 0) {
    throw new Error(`Invalid --port value: ${getFlag(flags, 'port')}`);
  }
  const host = getFlag(flags, 'host', '0.0.0.0')!;
  const publicBaseUrl = getFlag(flags, 'public-base-url');
  const claudeBin = getFlag(flags, 'claude-bin', 'claude')!;
  const runAsUser = getFlag(flags, 'run-as-user') ?? null;
  const ownerHome = getFlag(flags, 'owner-home') ?? null;
  const allowInput = !hasFlag(flags, 'read-only');
  const allowDangerousMode = hasFlag(flags, 'dangerously-skip-permissions');
  return {
    claudeRoot,
    projectId: resolved.projectId,
    sessionId: resolved.sessionId,
    filePath: resolved.filePath,
    port,
    host,
    publicBaseUrl: publicBaseUrl ?? null,
    claudeBin,
    runAsUser,
    ownerHome,
    allowDangerousMode,
    allowInput
  };
}

class ShareServer {
  private readonly config: ServerConfig;
  private readonly token: string;
  private session!: ParsedSession;
  private tailer!: SessionTailer;
  private busy = false;
  private readonly sockets = new Set<ServerWebSocket<{ token: string }>>();
  private server!: Bun.Server;

  constructor(config: ServerConfig) {
    this.config = config;
    this.token = randomBytes(16).toString('hex');
  }

  async start(): Promise<void> {
    this.session = await loadSession(this.config.projectId, this.config.sessionId, this.config.filePath);
    this.tailer = new SessionTailer(this.config.projectId, this.config.sessionId, this.config.filePath, {
      onAppend: (entries) => this.broadcast({ type: 'append', entries }),
      onReload: (session) => {
        this.session = session;
        this.broadcast({ type: 'reload', session: this.session, busy: this.busy });
      },
      onError: (error) => this.broadcast({ type: 'error', message: error.message })
    });
    await this.tailer.start();

    this.server = Bun.serve<{ token: string }>({
      hostname: this.config.host,
      port: this.config.port,
      fetch: (request, server) => this.handleRequest(request, server),
      websocket: {
        open: (ws) => {
          if (ws.data.token !== this.token) {
            ws.close(1008, 'invalid token');
            return;
          }
          this.sockets.add(ws);
          ws.send(JSON.stringify(this.bootstrapEvent(requestUrl(ws))));
        },
        close: (ws) => {
          this.sockets.delete(ws);
        }
      }
    });

    const shareUrl = this.shareUrl();
    console.log(`Session file: ${this.config.filePath}`);
    console.log(`Share URL: ${shareUrl}`);
    const alternatives = localAddresses(this.config.host, this.config.port)
      .map((base) => `${base}/s/${this.token}`)
      .filter((url) => url !== shareUrl);
    for (const url of alternatives) {
      console.log(`Reachable URL: ${url}`);
    }
    console.log(`Input mode: ${this.config.allowInput ? 'enabled' : 'read-only'}`);
    console.log(`Claude binary: ${this.config.claudeBin}`);
    if (this.config.allowInput && !this.config.allowDangerousMode) {
      console.log('Warning: input is enabled without --dangerously-skip-permissions; Claude may stop on tool approvals.');
    }
  }

  stop(): void {
    this.tailer.close();
    this.server?.stop();
  }

  private bootstrapEvent(origin?: string): ClientEvent {
    return {
      type: 'bootstrap',
      session: this.session,
      busy: this.busy,
      shareUrl: origin ?? this.shareUrl(),
      allowInput: this.config.allowInput
    };
  }

  private shareUrl(): string {
    if (this.config.publicBaseUrl) {
      return `${this.config.publicBaseUrl.replace(/\/$/, '')}/s/${this.token}`;
    }
    const host = this.config.host === '0.0.0.0' ? '127.0.0.1' : this.config.host;
    return `http://${host}:${this.config.port}/s/${this.token}`;
  }

  private externalShareUrl(request?: Request): string {
    if (this.config.publicBaseUrl) {
      return this.shareUrl();
    }
    if (!request) {
      return this.shareUrl();
    }
    const forwardedProto = request.headers.get('x-forwarded-proto');
    const forwardedHost = request.headers.get('x-forwarded-host');
    if (forwardedProto && forwardedHost) {
      return `${forwardedProto}://${forwardedHost}/s/${this.token}`;
    }
    return this.shareUrl();
  }

  private broadcast(event: ClientEvent): void {
    const payload = JSON.stringify(event);
    for (const socket of this.sockets) {
      socket.send(payload);
    }
  }

  private async handleRequest(request: Request, server: Bun.Server): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === '/') {
      return new Response(
        `Claude Session Share\n\nShare URL:\n${this.shareUrl()}\n\nSession: ${this.config.sessionId}\nProject: ${this.config.projectId}\nFile: ${this.config.filePath}\n`,
        { headers: { 'content-type': 'text/plain; charset=utf-8' } }
      );
    }

    if (pathname === `/s/${this.token}`) {
      return new Response(renderHtml(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    if (pathname === `/ws/${this.token}`) {
      const upgraded = server.upgrade(request, { data: { token: this.token } });
      return upgraded ? new Response(null) : new Response('Upgrade failed', { status: 500 });
    }

    if (pathname === `/api/share/${this.token}/history`) {
      return Response.json(this.bootstrapEvent(this.externalShareUrl(request)));
    }

    if (pathname === `/api/share/${this.token}/message` && request.method === 'POST') {
      if (!this.config.allowInput) {
        return new Response('Session is read-only.', { status: 403 });
      }
      if (this.busy) {
        return new Response('Claude is already processing another message.', { status: 409 });
      }
      const body = (await request.json()) as { message?: string };
      const message = body.message?.trim();
      if (!message) {
        return new Response('Missing message.', { status: 400 });
      }
      void this.resume(message);
      return Response.json({ ok: true });
    }

    return new Response('Not found', { status: 404 });
  }

  private async resume(message: string): Promise<void> {
    this.busy = true;
    this.broadcast({ type: 'status', busy: true, message: 'Running Claude for this session...' });
    try {
      const result = await this.runClaudeResume(message);
      this.broadcast({ type: 'status', busy: true, message: result });
      await Bun.sleep(300);
      this.session = await loadSession(this.config.projectId, this.config.sessionId, this.config.filePath);
      this.broadcast({ type: 'reload', session: this.session, busy: false });
      this.broadcast({ type: 'status', busy: false, message: 'Claude finished.' });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      this.broadcast({ type: 'error', message: messageText });
    } finally {
      this.busy = false;
    }
  }

  private async runClaudeResume(message: string): Promise<string> {
    const cwd = this.session.cwd ?? path.dirname(this.config.filePath);
    const ownerHome = this.config.ownerHome ?? (this.config.runAsUser ? `/home/${this.config.runAsUser}` : process.env.HOME ?? os.homedir());
    const envVars = {
      HOME: ownerHome,
      XDG_CONFIG_HOME: path.join(ownerHome, '.config')
    };

    const claudeArgs = [
      this.config.claudeBin,
      '-p',
      '--resume',
      this.config.sessionId,
      '--output-format',
      'json'
    ];

    if (this.config.allowDangerousMode) {
      claudeArgs.push('--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions');
    }

    claudeArgs.push(message);

    const command = this.config.runAsUser && process.getuid?.() === 0
      ? ['runuser', '-u', this.config.runAsUser, '--', 'env', ...Object.entries(envVars).map(([k, v]) => `${k}=${v}`), ...claudeArgs]
      : claudeArgs;

    const child = spawn(command[0]!, command.slice(1), {
      cwd,
      env: { ...process.env, ...envVars },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code ?? 0));
    });

    if (exitCode !== 0) {
      throw new Error((stderr || stdout || `Claude exited with code ${exitCode}`).trim());
    }

    try {
      const parsed = JSON.parse(stdout.trim()) as { result?: string; is_error?: boolean; subtype?: string; error?: string };
      if (parsed.is_error) {
        throw new Error(parsed.error ?? 'Claude returned an error response.');
      }
      return parsed.result?.trim() || parsed.subtype || 'Claude completed.';
    } catch {
      return stdout.trim() || 'Claude completed.';
    }
  }
}

function requestUrl(ws: ServerWebSocket<{ token: string }>): string | undefined {
  const request = (ws as unknown as { data?: { requestUrl?: string } }).data?.requestUrl;
  return request;
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(Bun.argv.slice(2));

  if (command === 'help' || hasFlag(flags, 'help')) {
    console.log(usage());
    return;
  }

  const claudeRoot = path.resolve(getFlag(flags, 'claude-root', getDefaultClaudeRoot())!);

  if (command === 'list') {
    const sessions = await discoverSessions(claudeRoot);
    console.log(formatSessionList(sessions));
    return;
  }

  if (command !== 'serve') {
    console.error(`Unknown command: ${command}`);
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  const resolved = await resolveSessionFile(claudeRoot, {
    sessionId: getFlag(flags, 'session'),
    projectId: getFlag(flags, 'project'),
    filePath: getFlag(flags, 'session-file')
  });
  const config = buildConfig(flags, resolved);
  const server = new ShareServer(config);
  await server.start();

  const shutdown = () => {
    server.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
