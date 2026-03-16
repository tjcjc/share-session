export type RawContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id?: string; name?: string; input?: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id?: string; content?: unknown; is_error?: boolean }
  | { type: 'image'; source?: { media_type?: string } };

export type RawEntry = {
  type?: string;
  timestamp?: string;
  uuid?: string;
  sessionId?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  isMeta?: boolean;
  cwd?: string;
  gitBranch?: string;
  userType?: string;
  sourceToolUseID?: string;
  sourceToolAssistantUUID?: string;
  toolUseResult?: unknown;
  operation?: string;
  content?: string;
  message?: {
    role?: string;
    content?: string | RawContentBlock[];
    model?: string;
    usage?: Record<string, unknown>;
  };
  lastPrompt?: string;
};

export type SessionListItem = {
  projectId: string;
  sessionId: string;
  filePath: string;
  cwd: string | null;
  firstUserText: string | null;
  updatedAt: string | null;
  createdAt: string | null;
};

export type SessionEntry = {
  id: string;
  rawType: string;
  kind:
    | 'user'
    | 'assistant'
    | 'thinking'
    | 'tool_use'
    | 'tool_result'
    | 'summary'
    | 'system'
    | 'queue'
    | 'error';
  text: string;
  timestamp: string | null;
  parentUuid?: string | null;
  meta?: Record<string, unknown>;
};

export type ParsedSession = {
  sessionId: string;
  projectId: string;
  filePath: string;
  cwd: string | null;
  entries: SessionEntry[];
  rawCount: number;
  updatedAt: string | null;
};

export type ShareConfig = {
  token: string;
  sessionId: string;
  projectId: string;
  allowInput: boolean;
};

export type ServerConfig = {
  claudeRoot: string;
  projectId: string;
  sessionId: string;
  filePath: string;
  port: number;
  host: string;
  publicBaseUrl: string | null;
  claudeBin: string;
  runAsUser: string | null;
  ownerHome: string | null;
  allowDangerousMode: boolean;
  allowInput: boolean;
};

export type ClientEvent =
  | { type: 'bootstrap'; session: ParsedSession; busy: boolean; shareUrl: string; allowInput: boolean }
  | { type: 'append'; entries: SessionEntry[] }
  | { type: 'reload'; session: ParsedSession; busy: boolean }
  | { type: 'status'; busy: boolean; message: string }
  | { type: 'error'; message: string };
