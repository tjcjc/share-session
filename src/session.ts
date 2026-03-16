import { createReadStream, existsSync, readdirSync, statSync, watch } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import type { ParsedSession, RawContentBlock, RawEntry, SessionEntry, SessionListItem } from './types';

function sanitizeText(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeText(item)).filter(Boolean).join('\n').trim();
  }
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return value == null ? '' : String(value).trim();
}

function toIsoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function contentText(content: string | RawContentBlock[] | undefined): string {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((block) => {
      switch (block.type) {
        case 'text':
          return block.text?.trim() ?? '';
        case 'thinking':
          return block.thinking?.trim() ?? '';
        case 'tool_use':
          return block.name ? `[tool:${block.name}]` : '[tool]';
        case 'tool_result':
          return sanitizeText(block.content);
        case 'image':
          return '[image]';
        default:
          return '';
      }
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function encodeProjectId(projectId: string): string {
  return projectId.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

export function getDefaultClaudeRoot(): string {
  return path.join(os.homedir(), '.claude');
}

export function getProjectsDir(claudeRoot: string): string {
  return path.join(claudeRoot, 'projects');
}

export function ensureInsideProjectsDir(claudeRoot: string, filePath: string): void {
  const projectsDir = path.resolve(getProjectsDir(claudeRoot));
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(projectsDir + path.sep) && resolved !== projectsDir) {
    throw new Error(`Session file must be inside ${projectsDir}`);
  }
}

export async function discoverSessions(claudeRoot: string): Promise<SessionListItem[]> {
  const projectsDir = getProjectsDir(claudeRoot);
  if (!existsSync(projectsDir)) {
    return [];
  }

  const results: SessionListItem[] = [];
  for (const projectDir of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!projectDir.isDirectory()) continue;
    const projectId = projectDir.name;
    const projectPath = path.join(projectsDir, projectId);
    for (const file of readdirSync(projectPath, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.jsonl') || file.name.startsWith('agent-')) {
        continue;
      }
      const filePath = path.join(projectPath, file.name);
      try {
        const meta = await extractSessionListMetadata(projectId, filePath);
        results.push(meta);
      } catch {
        // skip unreadable files
      }
    }
  }

  results.sort((a, b) => {
    const at = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const bt = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return bt - at;
  });
  return results;
}

async function extractSessionListMetadata(projectId: string, filePath: string): Promise<SessionListItem> {
  let cwd: string | null = null;
  let firstUserText: string | null = null;
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: RawEntry;
      try {
        entry = JSON.parse(trimmed) as RawEntry;
      } catch {
        continue;
      }
      cwd ??= typeof entry.cwd === 'string' ? entry.cwd : null;
      if (!firstUserText && entry.type === 'user' && entry.isMeta !== true) {
        const text = contentText(entry.message?.content);
        if (text) {
          firstUserText = text.replace(/\s+/g, ' ').slice(0, 140);
        }
      }
      if (cwd && firstUserText) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  const fileStat = await stat(filePath);
  return {
    projectId,
    sessionId: path.basename(filePath, '.jsonl'),
    filePath,
    cwd,
    firstUserText,
    updatedAt: fileStat.mtime.toISOString(),
    createdAt: fileStat.birthtime.toISOString()
  };
}

export async function resolveSessionFile(
  claudeRoot: string,
  options: { projectId?: string; sessionId?: string; filePath?: string }
): Promise<{ projectId: string; sessionId: string; filePath: string }> {
  if (options.filePath) {
    ensureInsideProjectsDir(claudeRoot, options.filePath);
    const filePath = path.resolve(options.filePath);
    const sessionId = path.basename(filePath, '.jsonl');
    const projectId = path.basename(path.dirname(filePath));
    return { projectId, sessionId, filePath };
  }

  if (!options.sessionId) {
    throw new Error('Missing --session or --session-file');
  }

  if (options.projectId) {
    const filePath = path.join(getProjectsDir(claudeRoot), options.projectId, `${options.sessionId}.jsonl`);
    return { projectId: options.projectId, sessionId: options.sessionId, filePath };
  }

  const sessions = await discoverSessions(claudeRoot);
  const match = sessions.find((item) => item.sessionId === options.sessionId);
  if (!match) {
    throw new Error(`Unable to locate session ${options.sessionId}`);
  }
  return { projectId: match.projectId, sessionId: match.sessionId, filePath: match.filePath };
}

export function parseRawEntry(entry: RawEntry, fallbackIndex: number): SessionEntry[] {
  const timestamp = toIsoOrNull(entry.timestamp);
  const idBase = entry.uuid ?? `${entry.type ?? 'entry'}-${fallbackIndex}`;
  const parentUuid = entry.parentUuid ?? null;
  const rawType = entry.type ?? 'unknown';

  if (rawType === 'queue-operation') {
    const op = entry.operation ?? 'queue';
    const text = entry.content ? `${op}: ${entry.content}` : op;
    return [{
      id: `${idBase}-queue`,
      rawType,
      kind: 'queue',
      text,
      timestamp,
      parentUuid
    }];
  }

  if (rawType === 'last-prompt') {
    return [];
  }

  if (rawType === 'summary') {
    return [{
      id: `${idBase}-summary`,
      rawType,
      kind: 'summary',
      text: sanitizeText(entry.message?.content ?? entry.content),
      timestamp,
      parentUuid
    }];
  }

  if (rawType === 'user') {
    if (entry.isMeta === true || entry.sourceToolUseID || entry.toolUseResult) {
      const resultText = sanitizeText(entry.toolUseResult ?? entry.message?.content ?? entry.content);
      return [{
        id: `${idBase}-tool-result`,
        rawType,
        kind: 'tool_result',
        text: resultText || '[tool result]',
        timestamp,
        parentUuid,
        meta: {
          sourceToolUseID: entry.sourceToolUseID ?? null,
          sourceToolAssistantUUID: entry.sourceToolAssistantUUID ?? null
        }
      }];
    }
    const text = sanitizeText(entry.message?.content ?? entry.content);
    return [{
      id: `${idBase}-user`,
      rawType,
      kind: 'user',
      text,
      timestamp,
      parentUuid,
      meta: {
        cwd: entry.cwd ?? null,
        gitBranch: entry.gitBranch ?? null
      }
    }];
  }

  if (rawType === 'assistant') {
    const content = entry.message?.content;
    if (!Array.isArray(content)) {
      return [{
        id: `${idBase}-assistant`,
        rawType,
        kind: 'assistant',
        text: sanitizeText(content),
        timestamp,
        parentUuid
      }];
    }

    const entries: SessionEntry[] = [];
    let blockIndex = 0;
    for (const block of content) {
      if (block.type === 'text') {
        entries.push({
          id: `${idBase}-text-${blockIndex++}`,
          rawType,
          kind: 'assistant',
          text: block.text.trim(),
          timestamp,
          parentUuid,
          meta: {
            model: entry.message?.model ?? null
          }
        });
      } else if (block.type === 'thinking') {
        entries.push({
          id: `${idBase}-thinking-${blockIndex++}`,
          rawType,
          kind: 'thinking',
          text: block.thinking.trim(),
          timestamp,
          parentUuid
        });
      } else if (block.type === 'tool_use') {
        entries.push({
          id: `${idBase}-tool-${blockIndex++}`,
          rawType,
          kind: 'tool_use',
          text: `${block.name ?? 'Tool'}\n${sanitizeText(block.input ?? {})}`.trim(),
          timestamp,
          parentUuid,
          meta: {
            toolId: block.id ?? null,
            name: block.name ?? null
          }
        });
      } else if (block.type === 'tool_result') {
        entries.push({
          id: `${idBase}-tool-result-${blockIndex++}`,
          rawType,
          kind: 'tool_result',
          text: sanitizeText(block.content ?? '[tool result]'),
          timestamp,
          parentUuid,
          meta: {
            toolUseId: block.tool_use_id ?? null,
            isError: block.is_error ?? false
          }
        });
      }
    }

    return entries;
  }

  return [{
    id: `${idBase}-system`,
    rawType,
    kind: 'system',
    text: sanitizeText(entry.content ?? entry.message?.content ?? rawType),
    timestamp,
    parentUuid
  }];
}

export async function loadSession(
  projectId: string,
  sessionId: string,
  filePath: string
): Promise<ParsedSession> {
  const entries: SessionEntry[] = [];
  let cwd: string | null = null;
  let rawCount = 0;
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      rawCount += 1;
      let entry: RawEntry;
      try {
        entry = JSON.parse(trimmed) as RawEntry;
      } catch {
        entries.push({
          id: `parse-error-${rawCount}`,
          rawType: 'parse-error',
          kind: 'error',
          text: trimmed,
          timestamp: null
        });
        continue;
      }
      cwd ??= typeof entry.cwd === 'string' ? entry.cwd : null;
      entries.push(...parseRawEntry(entry, rawCount));
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  const fileStat = await stat(filePath);
  return {
    projectId,
    sessionId,
    filePath,
    cwd,
    entries,
    rawCount,
    updatedAt: fileStat.mtime.toISOString()
  };
}

export type SessionTailerCallbacks = {
  onAppend: (entries: SessionEntry[]) => void;
  onReload: (session: ParsedSession) => void;
  onError: (error: Error) => void;
};

export class SessionTailer {
  private readonly projectId: string;
  private readonly sessionId: string;
  private readonly filePath: string;
  private readonly callbacks: SessionTailerCallbacks;
  private offset = 0;
  private buffer = '';
  private closed = false;
  private watcher: ReturnType<typeof watch> | null = null;
  private reloading = false;
  private debounce: Timer | null = null;
  private rawCount = 0;

  constructor(projectId: string, sessionId: string, filePath: string, callbacks: SessionTailerCallbacks) {
    this.projectId = projectId;
    this.sessionId = sessionId;
    this.filePath = filePath;
    this.callbacks = callbacks;
  }

  async start(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const fileStat = await stat(this.filePath);
    this.offset = fileStat.size;
    this.rawCount = (await readFile(this.filePath, 'utf8'))
      .split('\n')
      .filter((line) => line.trim()).length;

    this.watcher = watch(this.filePath, () => {
      if (this.closed) return;
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => {
        void this.handleChange();
      }, 150);
    });
    this.watcher.on('error', (error) => this.callbacks.onError(error));
  }

  close(): void {
    this.closed = true;
    if (this.debounce) clearTimeout(this.debounce);
    this.watcher?.close();
    this.watcher = null;
  }

  private async handleChange(): Promise<void> {
    if (this.reloading || this.closed) return;
    this.reloading = true;
    try {
      const fileStat = await stat(this.filePath);
      if (fileStat.size < this.offset) {
        this.offset = 0;
        this.buffer = '';
        this.rawCount = 0;
        const session = await loadSession(this.projectId, this.sessionId, this.filePath);
        this.offset = fileStat.size;
        this.rawCount = session.rawCount;
        this.callbacks.onReload(session);
        return;
      }
      if (fileStat.size === this.offset) {
        return;
      }

      const stream = createReadStream(this.filePath, {
        encoding: 'utf8',
        start: this.offset,
        end: fileStat.size - 1
      });
      let chunkText = '';
      for await (const chunk of stream) {
        chunkText += chunk;
      }
      this.offset = fileStat.size;
      this.buffer += chunkText;
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';
      const appended: SessionEntry[] = [];
      for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        this.rawCount += 1;
        try {
          const rawEntry = JSON.parse(trimmed) as RawEntry;
          appended.push(...parseRawEntry(rawEntry, this.rawCount));
        } catch (error) {
          this.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
        }
      }
      if (appended.length > 0) {
        this.callbacks.onAppend(appended);
      }
    } catch (error) {
      this.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.reloading = false;
    }
  }
}

export function formatSessionList(items: SessionListItem[]): string {
  if (items.length === 0) {
    return 'No sessions found.';
  }
  const rows = items.slice(0, 50).map((item) => {
    const updated = item.updatedAt ? item.updatedAt.replace('T', ' ').replace('.000Z', 'Z') : '-';
    const preview = item.firstUserText ?? '(no user text)';
    return `${item.sessionId} | ${item.projectId} | ${updated} | ${preview}`;
  });
  return rows.join('\n');
}

export function suggestedProjectIdFromCwd(cwd: string): string {
  return encodeProjectId(cwd);
}
