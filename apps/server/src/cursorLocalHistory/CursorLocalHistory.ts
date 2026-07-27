// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import type * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

import type {
  CursorLocalHistoryImportResult,
  CursorLocalHistoryImportThread,
  CursorLocalHistoryChatSummary,
  CursorLocalHistoryDryRunResult,
  CursorLocalHistoryScanError,
  CursorLocalHistorySourceKind,
  CursorLocalHistorySourceRef,
  CursorLocalHistoryWorkspaceSummary,
  MessageId,
  ModelSelection,
  OrchestrationMessageRole,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import {
  CommandId,
  ProjectId as ProjectIdSchema,
  ThreadId as ThreadIdSchema,
  MessageId as MessageIdSchema,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

interface CursorLocalHistoryRoots {
  readonly projectsDir: string;
  readonly chatsDir: string;
  readonly workspaceStorageDir: string;
}

export interface CursorLocalHistoryShape {
  readonly dryRunScan: Effect.Effect<CursorLocalHistoryDryRunResult>;
}

export class CursorLocalHistory extends Context.Service<
  CursorLocalHistory,
  CursorLocalHistoryShape
>()("t3/cursorLocalHistory/CursorLocalHistory") {}

interface MutableWorkspaceSummary {
  workspaceKey: string;
  workspaceSlug: string | null;
  workspaceHash: string | null;
  workspacePath: string | null;
  chatCount: number;
  messageCount: number;
  transcriptFileCount: number;
  chatStoreCount: number;
  workspaceStorageCount: number;
  latestActivityAt: string | null;
  sources: CursorLocalHistorySourceRef[];
}

interface MutableChatSummary {
  chatId: string;
  workspaceKey: string;
  workspacePath: string | null;
  messageCount: number;
  sourceRecordCount: number;
  parseErrorCount: number;
  createdAt: string | null;
  updatedAt: string | null;
  sources: CursorLocalHistorySourceRef[];
}

interface ScanState {
  readonly roots: CursorLocalHistoryRoots;
  readonly workspacesByKey: Map<string, MutableWorkspaceSummary>;
  readonly chatsByKey: Map<string, MutableChatSummary>;
  readonly errors: CursorLocalHistoryScanError[];
}

interface TranscriptStats {
  readonly chatId: string;
  readonly messageCount: number;
  readonly sourceRecordCount: number;
  readonly parseErrorCount: number;
  readonly updatedAt: string | null;
}

export interface CursorLocalHistoryImportMessage {
  readonly role: OrchestrationMessageRole;
  readonly text: string;
  readonly createdAt: string | null;
}

export interface CursorLocalHistoryImportCandidate {
  readonly chatId: string;
  readonly workspaceKey: string;
  readonly workspacePath: string | null;
  readonly title: string;
  readonly updatedAt: string | null;
  readonly sources: ReadonlyArray<CursorLocalHistorySourceRef>;
  readonly messages: ReadonlyArray<CursorLocalHistoryImportMessage>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IMPORT_MESSAGES_PER_CHAT = 2_000;

function defaultWorkspaceStorageDir(homeDir: string, platform: NodeJS.Platform): string {
  if (process.env.APPDATA) {
    return NodePath.join(process.env.APPDATA, "Cursor", "User", "workspaceStorage");
  }
  switch (platform) {
    case "darwin":
      return NodePath.join(
        homeDir,
        "Library",
        "Application Support",
        "Cursor",
        "User",
        "workspaceStorage",
      );
    case "win32":
      return NodePath.join(homeDir, "AppData", "Roaming", "Cursor", "User", "workspaceStorage");
    default:
      return NodePath.join(homeDir, ".config", "Cursor", "User", "workspaceStorage");
  }
}

export function defaultCursorLocalHistoryRoots(
  homeDir = NodeOS.homedir(),
  platform: NodeJS.Platform = "linux",
): CursorLocalHistoryRoots {
  return {
    projectsDir: NodePath.join(homeDir, ".cursor", "projects"),
    chatsDir: NodePath.join(homeDir, ".cursor", "chats"),
    workspaceStorageDir: defaultWorkspaceStorageDir(homeDir, platform),
  };
}

function toIsoFromMillis(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  return Option.match(DateTime.make(value), {
    onNone: () => null,
    onSome: DateTime.formatIso,
  });
}

function toError(
  kind: CursorLocalHistorySourceKind,
  path: string,
  cause: unknown,
): CursorLocalHistoryScanError {
  return {
    kind,
    path,
    message: cause instanceof Error ? cause.message : String(cause),
  };
}

function isNotFoundCause(cause: unknown): boolean {
  return (
    typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "ENOENT"
  );
}

function sourceRef(kind: CursorLocalHistorySourceKind, path: string): CursorLocalHistorySourceRef {
  return { kind, path };
}

async function safeReadDirectory(path: string): Promise<NodeFS.Dirent[]> {
  try {
    return await NodeFSP.readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function safeStatMtimeIso(path: string): Promise<string | null> {
  try {
    const stat = await NodeFSP.stat(path);
    return toIsoFromMillis(stat.mtimeMs);
  } catch {
    return null;
  }
}

async function collectFiles(
  root: string,
  predicate: (path: string, dirent: NodeFS.Dirent) => boolean,
  options: { readonly skipDirectory?: (path: string, dirent: NodeFS.Dirent) => boolean } = {},
): Promise<string[]> {
  const pending = [root];
  const files: string[] = [];
  while (pending.length > 0) {
    const current = pending.shift()!;
    const dirents = await safeReadDirectory(current);
    for (const dirent of dirents) {
      const child = NodePath.join(current, dirent.name);
      if (dirent.isDirectory()) {
        if (!options.skipDirectory?.(child, dirent)) pending.push(child);
      } else if (dirent.isFile() && predicate(child, dirent)) {
        files.push(child);
      }
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function messageContentExists(role: OrchestrationMessageRole, value: unknown): boolean {
  if (typeof value === "string") return cleanTranscriptText(role, value).length > 0;
  if (!Array.isArray(value)) return false;
  return value.some((part) => {
    if (typeof part !== "object" || part === null) return false;
    const text = (part as Record<string, unknown>).text;
    return typeof text === "string" && cleanTranscriptText(role, text).length > 0;
  });
}

function isChatMessageRecord(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const role = record.role;
  const normalizedRole = normalizeMessageRole(role);
  if (normalizedRole === null) return false;
  const message = record.message;
  if (typeof message === "object" && message !== null) {
    return messageContentExists(normalizedRole, (message as Record<string, unknown>).content);
  }
  return messageContentExists(normalizedRole, record.content);
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((part) => {
      if (typeof part !== "object" || part === null) return [];
      const text = (part as Record<string, unknown>).text;
      return typeof text === "string" && text.length > 0 ? [text] : [];
    })
    .join("\n");
}

function extractUserQueryText(value: string): string {
  const matches = [...value.matchAll(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/g)];
  const lastMatch = matches.at(-1);
  return lastMatch?.[1]?.trim() ?? value.trim();
}

function cleanTranscriptText(role: OrchestrationMessageRole, value: string): string {
  const unwrapped = role === "user" ? extractUserQueryText(value) : value.trim();
  return unwrapped
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "[REDACTED]")
    .join("\n")
    .trim();
}

function readMessageText(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const record = value as Record<string, unknown>;
  const role = normalizeMessageRole(record.role);
  const message = record.message;
  const rawText =
    typeof message === "object" && message !== null
      ? textFromContent((message as Record<string, unknown>).content)
      : textFromContent(record.content);
  if (role === null) return rawText.trim();
  return cleanTranscriptText(role, rawText);
}

function normalizeMessageRole(value: unknown): OrchestrationMessageRole | null {
  return value === "user" || value === "assistant" ? value : null;
}

function readCreatedAt(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const createdAt = record.createdAt ?? record.timestamp ?? record.time;
  return typeof createdAt === "string" && createdAt.trim().length > 0 ? createdAt : null;
}

function deriveCursorWorkspaceSlug(workspacePath: string): string {
  return workspacePath
    .replace(/^([A-Za-z]):/, (match) => match.toLowerCase())
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function inferHomeDirFromProjectsDir(projectsDir: string): string {
  const cursorDir = NodePath.dirname(projectsDir);
  return NodePath.dirname(cursorDir);
}

async function collectLikelyWorkspacePaths(projectsDir: string): Promise<Map<string, string>> {
  const homeDir = inferHomeDirFromProjectsDir(projectsDir);
  const candidateRoots = [
    homeDir,
    NodePath.join(homeDir, "Desktop"),
    NodePath.join(homeDir, "Documents"),
    NodePath.join(homeDir, "Downloads"),
  ];
  const slugToPath = new Map<string, string>();
  for (const root of candidateRoots) {
    const entries = await safeReadDirectory(root);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const absolutePath = NodePath.join(root, entry.name);
      slugToPath.set(deriveCursorWorkspaceSlug(absolutePath), absolutePath);
    }
  }
  return slugToPath;
}

async function readTranscriptStats(path: string): Promise<TranscriptStats> {
  const chatId = UUID_PATTERN.test(NodePath.basename(path, ".jsonl"))
    ? NodePath.basename(path, ".jsonl")
    : NodePath.basename(NodePath.dirname(path));
  const text = await NodeFSP.readFile(path, "utf8");
  let messageCount = 0;
  let sourceRecordCount = 0;
  let parseErrorCount = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      sourceRecordCount += 1;
      if (isChatMessageRecord(parsed)) messageCount += 1;
    } catch {
      parseErrorCount += 1;
    }
  }
  return {
    chatId,
    messageCount,
    sourceRecordCount,
    parseErrorCount,
    updatedAt: await safeStatMtimeIso(path),
  };
}

async function readTranscriptMessages(path: string): Promise<CursorLocalHistoryImportMessage[]> {
  const text = await NodeFSP.readFile(path, "utf8");
  const messages: CursorLocalHistoryImportMessage[] = [];
  const fallbackCreatedAt = await safeStatMtimeIso(path);
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!isChatMessageRecord(parsed)) continue;
    const role = normalizeMessageRole((parsed as Record<string, unknown>).role);
    if (role === null) continue;
    const messageText = readMessageText(parsed).trim();
    if (messageText.length === 0) continue;
    messages.push({
      role,
      text: messageText,
      createdAt: readCreatedAt(parsed) ?? fallbackCreatedAt,
    });
  }
  return messages;
}

function parseWorkspaceJson(raw: string): { readonly workspacePath: string | null } {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null) return { workspacePath: null };
  const folder = (parsed as Record<string, unknown>).folder;
  if (typeof folder !== "string" || folder.trim().length === 0) return { workspacePath: null };
  if (folder.startsWith("file://")) {
    try {
      return { workspacePath: NodeURL.fileURLToPath(folder) };
    } catch {
      return { workspacePath: null };
    }
  }
  return { workspacePath: folder };
}

function ensureWorkspace(
  state: ScanState,
  input: {
    readonly workspaceKey: string;
    readonly workspaceSlug?: string | null;
    readonly workspaceHash?: string | null;
    readonly workspacePath?: string | null;
  },
): MutableWorkspaceSummary {
  const existing = state.workspacesByKey.get(input.workspaceKey);
  if (existing) {
    if (existing.workspaceSlug === null && input.workspaceSlug)
      existing.workspaceSlug = input.workspaceSlug;
    if (existing.workspaceHash === null && input.workspaceHash)
      existing.workspaceHash = input.workspaceHash;
    if (existing.workspacePath === null && input.workspacePath)
      existing.workspacePath = input.workspacePath;
    return existing;
  }
  const workspace: MutableWorkspaceSummary = {
    workspaceKey: input.workspaceKey,
    workspaceSlug: input.workspaceSlug ?? null,
    workspaceHash: input.workspaceHash ?? null,
    workspacePath: input.workspacePath ?? null,
    chatCount: 0,
    messageCount: 0,
    transcriptFileCount: 0,
    chatStoreCount: 0,
    workspaceStorageCount: 0,
    latestActivityAt: null,
    sources: [],
  };
  state.workspacesByKey.set(input.workspaceKey, workspace);
  return workspace;
}

function upsertChat(
  state: ScanState,
  input: {
    readonly chatId: string;
    readonly workspaceKey: string;
    readonly workspacePath: string | null;
    readonly messageCount: number;
    readonly sourceRecordCount: number;
    readonly parseErrorCount: number;
    readonly updatedAt: string | null;
    readonly source: CursorLocalHistorySourceRef;
  },
): void {
  const key = `${input.workspaceKey}:${input.chatId}`;
  const existing = state.chatsByKey.get(key);
  if (existing) {
    existing.messageCount = Math.max(existing.messageCount, input.messageCount);
    existing.sourceRecordCount += input.sourceRecordCount;
    existing.parseErrorCount += input.parseErrorCount;
    if (existing.workspacePath === null) existing.workspacePath = input.workspacePath;
    if (input.updatedAt && (!existing.updatedAt || input.updatedAt > existing.updatedAt)) {
      existing.updatedAt = input.updatedAt;
    }
    existing.sources.push(input.source);
    return;
  }
  state.chatsByKey.set(key, {
    chatId: input.chatId,
    workspaceKey: input.workspaceKey,
    workspacePath: input.workspacePath,
    messageCount: input.messageCount,
    sourceRecordCount: input.sourceRecordCount,
    parseErrorCount: input.parseErrorCount,
    createdAt: input.updatedAt,
    updatedAt: input.updatedAt,
    sources: [input.source],
  });
}

async function scanWorkspaceStorage(state: ScanState): Promise<{
  readonly hashToWorkspaceKey: Map<string, string>;
  readonly slugToWorkspacePath: Map<string, string>;
}> {
  const hashToWorkspaceKey = new Map<string, string>();
  const slugToWorkspacePath = new Map<string, string>();
  const entries = await safeReadDirectory(state.roots.workspaceStorageDir);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workspaceHash = entry.name;
    const workspaceJsonPath = NodePath.join(
      state.roots.workspaceStorageDir,
      workspaceHash,
      "workspace.json",
    );
    try {
      const raw = await NodeFSP.readFile(workspaceJsonPath, "utf8");
      const { workspacePath } = parseWorkspaceJson(raw);
      const workspaceKey = workspacePath ?? `cursor-workspace-hash:${workspaceHash}`;
      const workspaceSlug = workspacePath ? deriveCursorWorkspaceSlug(workspacePath) : null;
      const workspace = ensureWorkspace(state, {
        workspaceKey,
        workspaceSlug,
        workspaceHash,
        workspacePath,
      });
      workspace.workspaceStorageCount += 1;
      workspace.sources.push(sourceRef("workspace-storage", workspaceJsonPath));
      hashToWorkspaceKey.set(workspaceHash, workspaceKey);
      if (workspacePath && workspaceSlug) slugToWorkspacePath.set(workspaceSlug, workspacePath);
    } catch (cause) {
      if (isNotFoundCause(cause)) continue;
      state.errors.push(toError("workspace-storage", workspaceJsonPath, cause));
    }
  }
  return { hashToWorkspaceKey, slugToWorkspacePath };
}

async function scanProjectTranscripts(
  state: ScanState,
  slugToWorkspacePath: ReadonlyMap<string, string>,
): Promise<void> {
  const fallbackSlugToWorkspacePath = await collectLikelyWorkspacePaths(state.roots.projectsDir);
  const entries = await safeReadDirectory(state.roots.projectsDir);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workspaceSlug = entry.name;
    const workspacePath =
      slugToWorkspacePath.get(workspaceSlug) ??
      fallbackSlugToWorkspacePath.get(workspaceSlug) ??
      null;
    const workspaceKey = workspacePath ?? `cursor-project:${workspaceSlug}`;
    const workspaceRoot = NodePath.join(state.roots.projectsDir, workspaceSlug);
    const workspace = ensureWorkspace(state, { workspaceKey, workspaceSlug, workspacePath });
    const transcriptRoot = NodePath.join(workspaceRoot, "agent-transcripts");
    const transcriptFiles = await collectFiles(transcriptRoot, (path) => path.endsWith(".jsonl"), {
      skipDirectory: (_path, dirent) => dirent.name === "subagents",
    });
    for (const transcriptPath of transcriptFiles) {
      try {
        const stats = await readTranscriptStats(transcriptPath);
        const source = sourceRef("agent-transcripts", transcriptPath);
        workspace.transcriptFileCount += 1;
        workspace.messageCount += stats.messageCount;
        workspace.sources.push(source);
        if (
          stats.updatedAt &&
          (!workspace.latestActivityAt || stats.updatedAt > workspace.latestActivityAt)
        ) {
          workspace.latestActivityAt = stats.updatedAt;
        }
        upsertChat(state, {
          chatId: stats.chatId,
          workspaceKey,
          workspacePath: workspace.workspacePath,
          messageCount: stats.messageCount,
          sourceRecordCount: stats.sourceRecordCount,
          parseErrorCount: stats.parseErrorCount,
          updatedAt: stats.updatedAt,
          source,
        });
      } catch (cause) {
        state.errors.push(toError("agent-transcripts", transcriptPath, cause));
      }
    }
  }
}

async function scanChatStores(
  state: ScanState,
  hashToWorkspaceKey: ReadonlyMap<string, string>,
): Promise<void> {
  const storeDbs = await collectFiles(
    state.roots.chatsDir,
    (path, dirent) => dirent.name === "store.db",
  );
  for (const storePath of storeDbs) {
    const chatId = NodePath.basename(NodePath.dirname(storePath));
    const workspaceHash = NodePath.basename(NodePath.dirname(NodePath.dirname(storePath)));
    const workspaceKey =
      hashToWorkspaceKey.get(workspaceHash) ?? `cursor-chat-store:${workspaceHash}`;
    const workspace = ensureWorkspace(state, { workspaceKey, workspaceHash });
    const updatedAt = await safeStatMtimeIso(storePath);
    const source = sourceRef("chat-store", storePath);
    workspace.chatStoreCount += 1;
    workspace.sources.push(source);
    if (updatedAt && (!workspace.latestActivityAt || updatedAt > workspace.latestActivityAt)) {
      workspace.latestActivityAt = updatedAt;
    }
    upsertChat(state, {
      chatId,
      workspaceKey,
      workspacePath: workspace.workspacePath,
      messageCount: 0,
      sourceRecordCount: 0,
      parseErrorCount: 0,
      updatedAt,
      source,
    });
  }
}

function finalize(state: ScanState, scannedAt: string): CursorLocalHistoryDryRunResult {
  const chats = [...state.chatsByKey.values()]
    .sort((left, right) => {
      const leftTime = left.updatedAt ?? "";
      const rightTime = right.updatedAt ?? "";
      return rightTime.localeCompare(leftTime) || left.chatId.localeCompare(right.chatId);
    })
    .map((chat): CursorLocalHistoryChatSummary => ({ ...chat }));
  for (const workspace of state.workspacesByKey.values()) {
    workspace.chatCount = chats.filter(
      (chat) => chat.workspaceKey === workspace.workspaceKey,
    ).length;
  }
  const workspaces = [...state.workspacesByKey.values()]
    .filter(
      (workspace) =>
        workspace.chatCount > 0 ||
        workspace.workspaceStorageCount > 0 ||
        workspace.chatStoreCount > 0,
    )
    .sort(
      (left, right) =>
        (right.latestActivityAt ?? "").localeCompare(left.latestActivityAt ?? "") ||
        left.workspaceKey.localeCompare(right.workspaceKey),
    )
    .map((workspace): CursorLocalHistoryWorkspaceSummary => ({ ...workspace }));
  return {
    scannedAt,
    roots: state.roots,
    workspaceCount: workspaces.length,
    chatCount: chats.length,
    messageCount: chats.reduce((total, chat) => total + chat.messageCount, 0),
    transcriptFileCount: workspaces.reduce(
      (total, workspace) => total + workspace.transcriptFileCount,
      0,
    ),
    chatStoreCount: workspaces.reduce((total, workspace) => total + workspace.chatStoreCount, 0),
    workspaceStorageCount: workspaces.reduce(
      (total, workspace) => total + workspace.workspaceStorageCount,
      0,
    ),
    parseErrorCount:
      chats.reduce((total, chat) => total + chat.parseErrorCount, 0) + state.errors.length,
    errors: state.errors,
    workspaces,
    chats,
  };
}

export function scanCursorLocalHistoryDryRun(
  roots?: CursorLocalHistoryRoots,
): Effect.Effect<CursorLocalHistoryDryRunResult, never, HostProcessPlatform> {
  return Effect.gen(function* () {
    const scannedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const resolvedRoots =
      roots ?? defaultCursorLocalHistoryRoots(NodeOS.homedir(), yield* HostProcessPlatform);
    const state: ScanState = {
      roots: resolvedRoots,
      workspacesByKey: new Map(),
      chatsByKey: new Map(),
      errors: [],
    };
    yield* Effect.promise(async () => {
      const { hashToWorkspaceKey, slugToWorkspacePath } = await scanWorkspaceStorage(state);
      await scanProjectTranscripts(state, slugToWorkspacePath);
      await scanChatStores(state, hashToWorkspaceKey);
    });
    return finalize(state, scannedAt);
  });
}

function titleFromMessages(
  chatId: string,
  messages: ReadonlyArray<CursorLocalHistoryImportMessage>,
): string {
  const firstUserMessage = messages.find((message) => message.role === "user")?.text.trim();
  if (!firstUserMessage) return `Cursor chat ${chatId.slice(0, 8)}`;
  const firstLine = firstUserMessage
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0)
    ?.trim();
  if (!firstLine) return `Cursor chat ${chatId.slice(0, 8)}`;
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

export function scanCursorLocalHistoryImportCandidates(
  roots?: CursorLocalHistoryRoots,
): Effect.Effect<ReadonlyArray<CursorLocalHistoryImportCandidate>, never, HostProcessPlatform> {
  return Effect.gen(function* () {
    const resolvedRoots =
      roots ?? defaultCursorLocalHistoryRoots(NodeOS.homedir(), yield* HostProcessPlatform);
    return yield* Effect.promise(async () => {
      const state: ScanState = {
        roots: resolvedRoots,
        workspacesByKey: new Map(),
        chatsByKey: new Map(),
        errors: [],
      };
      const { hashToWorkspaceKey, slugToWorkspacePath } = await scanWorkspaceStorage(state);
      await scanProjectTranscripts(state, slugToWorkspacePath);
      await scanChatStores(state, hashToWorkspaceKey);

      const candidates: CursorLocalHistoryImportCandidate[] = [];
      for (const chat of state.chatsByKey.values()) {
        const transcriptSources = chat.sources.filter(
          (source) => source.kind === "agent-transcripts",
        );
        if (transcriptSources.length === 0) continue;
        const messagesBySource = await Promise.all(
          transcriptSources.map((source) => readTranscriptMessages(source.path)),
        );
        const messages = messagesBySource.flat();
        if (messages.length === 0) continue;
        candidates.push({
          chatId: chat.chatId,
          workspaceKey: chat.workspaceKey,
          workspacePath: chat.workspacePath,
          title: titleFromMessages(chat.chatId, messages),
          updatedAt: chat.updatedAt,
          sources: chat.sources,
          messages,
        });
      }
      return candidates.sort(
        (left, right) =>
          (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") ||
          left.chatId.localeCompare(right.chatId),
      );
    });
  });
}

function stableImportId(prefix: string, parts: ReadonlyArray<string>): string {
  const digest = NodeCrypto.createHash("sha256")
    .update(parts.join("\0"))
    .digest("hex")
    .slice(0, 24);
  return `${prefix}-${digest}`;
}

function firstSourcePath(candidate: CursorLocalHistoryImportCandidate): string {
  return candidate.sources[0]?.path ?? candidate.workspaceKey;
}

function projectTitle(candidate: CursorLocalHistoryImportCandidate): string {
  if (candidate.workspacePath)
    return NodePath.basename(candidate.workspacePath) || candidate.workspacePath;
  return candidate.workspaceKey.replace(/^cursor-project:/, "");
}

function projectIdForCandidate(candidate: CursorLocalHistoryImportCandidate): ProjectId {
  return ProjectIdSchema.make(stableImportId("cursor-import-project", [candidate.workspaceKey]));
}

function threadIdForCandidate(candidate: CursorLocalHistoryImportCandidate): ThreadId {
  return ThreadIdSchema.make(
    stableImportId("cursor-import-thread", [candidate.workspaceKey, candidate.chatId]),
  );
}

function commandIdForImport(parts: ReadonlyArray<string>): CommandId {
  return CommandId.make(stableImportId("cursor-import-command", parts));
}

function messageIdForImport(
  candidate: CursorLocalHistoryImportCandidate,
  index: number,
): MessageId {
  return MessageIdSchema.make(
    stableImportId("cursor-import-message", [
      candidate.workspaceKey,
      candidate.chatId,
      String(index),
    ]),
  );
}

export function importCursorLocalHistoryCandidates(input: {
  readonly candidates: ReadonlyArray<CursorLocalHistoryImportCandidate>;
  readonly offset?: number;
  readonly limit?: number;
  readonly modelSelection: ModelSelection;
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly projectionSnapshotQuery: ProjectionSnapshotQueryShape;
}): Effect.Effect<CursorLocalHistoryImportResult> {
  return Effect.gen(function* () {
    const totalCandidateCount = input.candidates.length;
    const importedCandidateOffset = input.offset ?? 0;
    const candidates =
      input.limit === undefined
        ? input.candidates.slice(importedCandidateOffset)
        : input.candidates.slice(importedCandidateOffset, importedCandidateOffset + input.limit);
    const importedCandidateLimit = input.limit ?? candidates.length;
    let importedProjectCount = 0;
    let importedThreadCount = 0;
    let importedMessageCount = 0;
    let skippedChatCount = 0;
    const errors: CursorLocalHistoryScanError[] = [];
    const threads: CursorLocalHistoryImportThread[] = [];

    for (const candidate of candidates) {
      yield* Effect.gen(function* () {
        if (!candidate.workspacePath) {
          skippedChatCount += 1;
          errors.push({
            kind: "agent-transcripts",
            path: firstSourcePath(candidate),
            message:
              "Cannot import this Cursor chat because its original workspace path is unknown.",
          });
          return;
        }

        const createdAt =
          candidate.updatedAt ?? (yield* Effect.map(DateTime.now, DateTime.formatIso));
        const existingProject =
          yield* input.projectionSnapshotQuery.getActiveProjectByWorkspaceRoot(
            candidate.workspacePath,
          );
        const projectId = Option.match(existingProject, {
          onNone: () => projectIdForCandidate(candidate),
          onSome: (project) => project.id,
        });
        if (Option.isNone(existingProject)) {
          yield* input.orchestrationEngine.dispatch({
            type: "project.create",
            commandId: commandIdForImport(["project", candidate.workspaceKey]),
            projectId,
            title: projectTitle(candidate),
            workspaceRoot: candidate.workspacePath,
            defaultModelSelection: input.modelSelection,
            createdAt,
          });
          importedProjectCount += 1;
        }

        const threadId = threadIdForCandidate(candidate);
        yield* input.orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: commandIdForImport(["thread", candidate.workspaceKey, candidate.chatId]),
          threadId,
          projectId,
          title: candidate.title,
          modelSelection: input.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        importedThreadCount += 1;

        const messages = candidate.messages.slice(-MAX_IMPORT_MESSAGES_PER_CHAT);
        yield* input.orchestrationEngine.dispatch({
          type: "thread.messages.import",
          commandId: commandIdForImport(["messages", candidate.workspaceKey, candidate.chatId]),
          threadId,
          messages: messages.map((message, index) => ({
            messageId: messageIdForImport(candidate, index),
            role: message.role,
            text: message.text,
            createdAt: message.createdAt ?? createdAt,
          })),
          createdAt,
        });
        importedMessageCount += messages.length;
        threads.push({
          chatId: candidate.chatId,
          threadId,
          title: candidate.title,
          messageCount: messages.length,
        });
      }).pipe(
        Effect.catch((error: unknown) =>
          Effect.sync(() => {
            skippedChatCount += 1;
            errors.push({
              kind: "agent-transcripts",
              path: firstSourcePath(candidate),
              message: error instanceof Error ? error.message : String(error),
            });
          }),
        ),
      );
    }

    return {
      totalCandidateCount,
      importedCandidateOffset,
      importedCandidateLimit,
      importedProjectCount,
      importedThreadCount,
      importedMessageCount,
      skippedChatCount,
      errors,
      threads,
    };
  });
}

export const layer = Layer.succeed(CursorLocalHistory, {
  dryRunScan: scanCursorLocalHistoryDryRun(),
});
