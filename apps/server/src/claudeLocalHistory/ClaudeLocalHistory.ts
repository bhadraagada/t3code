// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import type * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

import type {
  ClaudeLocalHistoryChatSummary,
  ClaudeLocalHistoryDryRunResult,
  ClaudeLocalHistoryImportResult,
  ClaudeLocalHistoryImportThread,
  ClaudeLocalHistoryScanError,
  ClaudeLocalHistorySourceRef,
  ClaudeLocalHistoryWorkspaceSummary,
  MessageId,
  ModelSelection,
  OrchestrationMessageRole,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import {
  CommandId,
  MessageId as MessageIdSchema,
  ProjectId as ProjectIdSchema,
  ThreadId as ThreadIdSchema,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  localHistoryFingerprintHash,
  localHistoryImportWatermark,
  selectNewLocalHistoryMessages,
} from "../localHistory/incrementalImport.ts";

export interface ClaudeLocalHistoryRoots {
  readonly configDir: string;
  readonly projectsDir: string;
}

export interface ClaudeLocalHistoryShape {
  readonly dryRunScan: Effect.Effect<ClaudeLocalHistoryDryRunResult>;
}

export class ClaudeLocalHistory extends Context.Service<
  ClaudeLocalHistory,
  ClaudeLocalHistoryShape
>()("t3/claudeLocalHistory/ClaudeLocalHistory") {}

export interface ClaudeLocalHistoryImportMessage {
  readonly role: OrchestrationMessageRole;
  readonly text: string;
  readonly createdAt: string | null;
}

export interface ClaudeLocalHistoryImportCandidate {
  readonly chatId: string;
  readonly workspaceKey: string;
  readonly workspacePath: string | null;
  readonly title: string;
  readonly updatedAt: string | null;
  readonly sources: ReadonlyArray<ClaudeLocalHistorySourceRef>;
  readonly messages: ReadonlyArray<ClaudeLocalHistoryImportMessage>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IMPORT_MESSAGES_PER_CHAT = 2_000;

export function defaultClaudeLocalHistoryRoots(
  homeDir = NodeOS.homedir(),
): ClaudeLocalHistoryRoots {
  const configDir =
    typeof process.env.CLAUDE_CONFIG_DIR === "string" &&
    process.env.CLAUDE_CONFIG_DIR.trim().length > 0
      ? process.env.CLAUDE_CONFIG_DIR.trim()
      : NodePath.join(homeDir, ".claude");
  return {
    configDir,
    projectsDir: NodePath.join(configDir, "projects"),
  };
}

function toIsoFromMillis(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  return Option.match(DateTime.make(value), {
    onNone: () => null,
    onSome: DateTime.formatIso,
  });
}

function toError(path: string, cause: unknown): ClaudeLocalHistoryScanError {
  return {
    kind: "claude-projects",
    path,
    message: cause instanceof Error ? cause.message : String(cause),
  };
}

function sourceRef(path: string): ClaudeLocalHistorySourceRef {
  return { kind: "claude-projects", path };
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

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((part) => {
      if (typeof part !== "object" || part === null) return [];
      const record = part as Record<string, unknown>;
      if (record.type !== undefined && record.type !== "text") return [];
      const text = record.text;
      return typeof text === "string" && text.length > 0 ? [text] : [];
    })
    .join("\n")
    .trim();
}

function readMessageText(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const record = value as Record<string, unknown>;
  const message = record.message;
  if (typeof message === "object" && message !== null) {
    return textFromContent((message as Record<string, unknown>).content);
  }
  return textFromContent(record.content);
}

function normalizeMessageRole(value: unknown): OrchestrationMessageRole | null {
  return value === "user" || value === "assistant" ? value : null;
}

function readCreatedAt(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const timestamp = (value as Record<string, unknown>).timestamp;
  return typeof timestamp === "string" && timestamp.trim().length > 0 ? timestamp : null;
}

function readWorkspacePath(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const cwd = (value as Record<string, unknown>).cwd;
  return typeof cwd === "string" && cwd.trim().length > 0 ? cwd : null;
}

function readAiTitle(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const title = record.aiTitle ?? record.title;
  return typeof title === "string" && title.trim().length > 0 ? title.trim() : null;
}

function isSessionTranscriptFile(name: string): boolean {
  if (!name.endsWith(".jsonl")) return false;
  if (name.startsWith("agent-")) return false;
  return UUID_PATTERN.test(NodePath.basename(name, ".jsonl"));
}

function titleFromMessages(
  chatId: string,
  messages: ReadonlyArray<ClaudeLocalHistoryImportMessage>,
  aiTitle: string | null,
): string {
  if (aiTitle) return aiTitle.length > 80 ? `${aiTitle.slice(0, 77)}...` : aiTitle;
  const firstUserMessage = messages.find((message) => message.role === "user")?.text.trim();
  if (!firstUserMessage) return `Claude chat ${chatId.slice(0, 8)}`;
  const firstLine = firstUserMessage
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0)
    ?.trim();
  if (!firstLine) return `Claude chat ${chatId.slice(0, 8)}`;
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

interface TranscriptParseResult {
  readonly chatId: string;
  readonly workspacePath: string | null;
  readonly title: string | null;
  readonly messageCount: number;
  readonly sourceRecordCount: number;
  readonly parseErrorCount: number;
  readonly messages: ReadonlyArray<ClaudeLocalHistoryImportMessage>;
  readonly updatedAt: string | null;
}

export interface ClaudeTranscriptContent {
  readonly workspacePath: string | null;
  readonly title: string | null;
  readonly sourceRecordCount: number;
  readonly parseErrorCount: number;
  readonly messages: ReadonlyArray<ClaudeLocalHistoryImportMessage>;
}

export function parseClaudeTranscriptContent(text: string): ClaudeTranscriptContent {
  const messages: ClaudeLocalHistoryImportMessage[] = [];
  let sourceRecordCount = 0;
  let parseErrorCount = 0;
  let workspacePath: string | null = null;
  let aiTitle: string | null = null;

  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      parseErrorCount += 1;
      continue;
    }
    sourceRecordCount += 1;
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    if (!workspacePath) workspacePath = readWorkspacePath(record);
    if (record.type === "ai-title") {
      aiTitle = readAiTitle(record) ?? aiTitle;
      continue;
    }
    if (record.type !== "user" && record.type !== "assistant") continue;
    const role =
      normalizeMessageRole(record.type) ??
      (typeof record.message === "object" && record.message !== null
        ? normalizeMessageRole((record.message as Record<string, unknown>).role)
        : null);
    if (role === null) continue;
    const messageText = readMessageText(record);
    if (messageText.length === 0) continue;
    messages.push({
      role,
      text: messageText,
      createdAt: readCreatedAt(record),
    });
  }

  return {
    workspacePath,
    title: aiTitle,
    sourceRecordCount,
    parseErrorCount,
    messages,
  };
}

async function parseTranscript(path: string): Promise<TranscriptParseResult> {
  const chatId = NodePath.basename(path, ".jsonl");
  const text = await NodeFSP.readFile(path, "utf8");
  const fallbackCreatedAt = await safeStatMtimeIso(path);
  const content = parseClaudeTranscriptContent(text);
  const messages = content.messages.map((message) =>
    message.createdAt === null ? { ...message, createdAt: fallbackCreatedAt } : message,
  );

  return {
    chatId,
    workspacePath: content.workspacePath,
    title: content.title,
    messageCount: messages.length,
    sourceRecordCount: content.sourceRecordCount,
    parseErrorCount: content.parseErrorCount,
    messages,
    updatedAt: fallbackCreatedAt,
  };
}

function workspaceKeyFor(workspacePath: string | null, encodedSlug: string): string {
  return workspacePath ? `claude-project:${workspacePath}` : `claude-project:${encodedSlug}`;
}

export function scanClaudeLocalHistoryDryRun(
  roots: ClaudeLocalHistoryRoots = defaultClaudeLocalHistoryRoots(),
): Effect.Effect<ClaudeLocalHistoryDryRunResult> {
  return Effect.gen(function* () {
    const scannedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const workspacesByKey = new Map<string, ClaudeLocalHistoryWorkspaceSummary>();
    const chats: ClaudeLocalHistoryChatSummary[] = [];
    const errors: ClaudeLocalHistoryScanError[] = [];
    let transcriptFileCount = 0;

    yield* Effect.promise(async () => {
      const projectDirs = await safeReadDirectory(roots.projectsDir);
      for (const projectDir of projectDirs) {
        if (!projectDir.isDirectory()) continue;
        const projectPath = NodePath.join(roots.projectsDir, projectDir.name);
        const files = await safeReadDirectory(projectPath);
        for (const file of files) {
          if (!file.isFile() || !isSessionTranscriptFile(file.name)) continue;
          const transcriptPath = NodePath.join(projectPath, file.name);
          transcriptFileCount += 1;
          try {
            const parsed = await parseTranscript(transcriptPath);
            const workspaceKey = workspaceKeyFor(parsed.workspacePath, projectDir.name);
            const source = sourceRef(transcriptPath);
            const existing = workspacesByKey.get(workspaceKey);
            if (existing) {
              workspacesByKey.set(workspaceKey, {
                ...existing,
                chatCount: existing.chatCount + 1,
                messageCount: existing.messageCount + parsed.messageCount,
                transcriptFileCount: existing.transcriptFileCount + 1,
                latestActivityAt:
                  (parsed.updatedAt ?? "") > (existing.latestActivityAt ?? "")
                    ? parsed.updatedAt
                    : existing.latestActivityAt,
                sources: [...existing.sources, source],
                workspacePath: existing.workspacePath ?? parsed.workspacePath,
              });
            } else {
              workspacesByKey.set(workspaceKey, {
                workspaceKey,
                workspacePath: parsed.workspacePath,
                chatCount: 1,
                messageCount: parsed.messageCount,
                transcriptFileCount: 1,
                latestActivityAt: parsed.updatedAt,
                sources: [source],
              });
            }
            chats.push({
              chatId: parsed.chatId,
              workspaceKey,
              workspacePath: parsed.workspacePath,
              title: titleFromMessages(parsed.chatId, parsed.messages, parsed.title),
              messageCount: parsed.messageCount,
              sourceRecordCount: parsed.sourceRecordCount,
              parseErrorCount: parsed.parseErrorCount,
              createdAt: parsed.messages[0]?.createdAt ?? parsed.updatedAt,
              updatedAt: parsed.updatedAt,
              sources: [source],
            });
          } catch (cause) {
            errors.push(toError(transcriptPath, cause));
          }
        }
      }
    });

    const sortedChats = chats.sort(
      (left, right) =>
        (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") ||
        left.chatId.localeCompare(right.chatId),
    );
    const workspaces = [...workspacesByKey.values()].sort(
      (left, right) =>
        (right.latestActivityAt ?? "").localeCompare(left.latestActivityAt ?? "") ||
        left.workspaceKey.localeCompare(right.workspaceKey),
    );

    return {
      scannedAt,
      roots,
      workspaceCount: workspaces.length,
      chatCount: sortedChats.length,
      messageCount: sortedChats.reduce((total, chat) => total + chat.messageCount, 0),
      transcriptFileCount,
      parseErrorCount:
        sortedChats.reduce((total, chat) => total + chat.parseErrorCount, 0) + errors.length,
      errors,
      workspaces,
      chats: sortedChats,
    };
  });
}

export function scanClaudeLocalHistoryImportCandidates(
  roots: ClaudeLocalHistoryRoots = defaultClaudeLocalHistoryRoots(),
): Effect.Effect<ReadonlyArray<ClaudeLocalHistoryImportCandidate>> {
  return Effect.promise(async () => {
    const candidates: ClaudeLocalHistoryImportCandidate[] = [];
    const projectDirs = await safeReadDirectory(roots.projectsDir);
    for (const projectDir of projectDirs) {
      if (!projectDir.isDirectory()) continue;
      const projectPath = NodePath.join(roots.projectsDir, projectDir.name);
      const files = await safeReadDirectory(projectPath);
      for (const file of files) {
        if (!file.isFile() || !isSessionTranscriptFile(file.name)) continue;
        const transcriptPath = NodePath.join(projectPath, file.name);
        try {
          const parsed = await parseTranscript(transcriptPath);
          if (parsed.messages.length === 0) continue;
          const workspaceKey = workspaceKeyFor(parsed.workspacePath, projectDir.name);
          candidates.push({
            chatId: parsed.chatId,
            workspaceKey,
            workspacePath: parsed.workspacePath,
            title: titleFromMessages(parsed.chatId, parsed.messages, parsed.title),
            updatedAt: parsed.updatedAt,
            sources: [sourceRef(transcriptPath)],
            messages: parsed.messages,
          });
        } catch {
          // Dry-run surfaces parse failures; import skips broken transcripts.
        }
      }
    }
    return candidates.sort(
      (left, right) =>
        (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") ||
        left.chatId.localeCompare(right.chatId),
    );
  });
}

function stableImportId(prefix: string, parts: ReadonlyArray<string>): string {
  const digest = NodeCrypto.createHash("sha256")
    .update(parts.join("\0"))
    .digest("hex")
    .slice(0, 24);
  return `${prefix}-${digest}`;
}

function firstSourcePath(candidate: ClaudeLocalHistoryImportCandidate): string {
  return candidate.sources[0]?.path ?? candidate.workspaceKey;
}

function projectTitle(candidate: ClaudeLocalHistoryImportCandidate): string {
  if (candidate.workspacePath)
    return NodePath.basename(candidate.workspacePath) || candidate.workspacePath;
  return candidate.workspaceKey.replace(/^claude-project:/, "");
}

function projectIdForCandidate(candidate: ClaudeLocalHistoryImportCandidate): ProjectId {
  return ProjectIdSchema.make(stableImportId("claude-import-project", [candidate.workspaceKey]));
}

export function claudeLocalHistoryThreadId(workspaceKey: string, chatId: string): ThreadId {
  return ThreadIdSchema.make(stableImportId("claude-import-thread", [workspaceKey, chatId]));
}

function threadIdForCandidate(candidate: ClaudeLocalHistoryImportCandidate): ThreadId {
  return claudeLocalHistoryThreadId(candidate.workspaceKey, candidate.chatId);
}

function commandIdForImport(parts: ReadonlyArray<string>): CommandId {
  return CommandId.make(stableImportId("claude-import-command", parts));
}

function messageIdForImport(
  candidate: ClaudeLocalHistoryImportCandidate,
  index: number,
): MessageId {
  return MessageIdSchema.make(
    stableImportId("claude-import-message", [
      candidate.workspaceKey,
      candidate.chatId,
      String(index),
    ]),
  );
}

// Content-addressed ids for delta-appended messages: unlike list indexes,
// these stay stable when the capped source window slides.
function messageIdForDeltaImport(
  candidate: ClaudeLocalHistoryImportCandidate,
  fingerprint: string,
  occurrence: number,
): MessageId {
  return MessageIdSchema.make(
    stableImportId("claude-import-message", [
      candidate.workspaceKey,
      candidate.chatId,
      "fp",
      localHistoryFingerprintHash(fingerprint),
      String(occurrence),
    ]),
  );
}

export function importClaudeLocalHistoryCandidates(input: {
  readonly candidates: ReadonlyArray<ClaudeLocalHistoryImportCandidate>;
  readonly offset?: number;
  readonly limit?: number;
  readonly modelSelection: ModelSelection;
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly projectionSnapshotQuery: ProjectionSnapshotQueryShape;
}): Effect.Effect<ClaudeLocalHistoryImportResult> {
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
    const errors: ClaudeLocalHistoryScanError[] = [];
    const threads: ClaudeLocalHistoryImportThread[] = [];

    for (const candidate of candidates) {
      yield* Effect.gen(function* () {
        if (!candidate.workspacePath) {
          skippedChatCount += 1;
          errors.push({
            kind: "claude-projects",
            path: firstSourcePath(candidate),
            message:
              "Cannot import this Claude chat because its original workspace path is unknown.",
          });
          return;
        }

        const createdAt =
          candidate.updatedAt ?? (yield* Effect.map(DateTime.now, DateTime.formatIso));
        const threadId = threadIdForCandidate(candidate);
        const messages = candidate.messages.slice(-MAX_IMPORT_MESSAGES_PER_CHAT);
        const watermark = localHistoryImportWatermark(messages);
        const messagesCommandId = commandIdForImport([
          "messages",
          candidate.workspaceKey,
          candidate.chatId,
          watermark,
        ]);

        const existingThread = yield* input.projectionSnapshotQuery.getThreadDetailById(threadId);
        if (Option.isSome(existingThread)) {
          // Already imported: append only the source messages missing from the
          // T3 thread. An unchanged source dispatches nothing at all.
          const delta = selectNewLocalHistoryMessages(existingThread.value.messages, messages);
          if (delta.length === 0) return;
          yield* input.orchestrationEngine.dispatch({
            type: "thread.messages.import",
            commandId: messagesCommandId,
            threadId,
            messages: delta.map(({ message, fingerprint, occurrence }) => ({
              messageId: messageIdForDeltaImport(candidate, fingerprint, occurrence),
              role: message.role,
              text: message.text,
              createdAt: message.createdAt ?? createdAt,
            })),
            createdAt,
          });
          importedThreadCount += 1;
          importedMessageCount += delta.length;
          threads.push({
            chatId: candidate.chatId,
            threadId,
            title: candidate.title,
            messageCount: delta.length,
          });
          return;
        }

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

        yield* input.orchestrationEngine.dispatch({
          type: "thread.messages.import",
          commandId: messagesCommandId,
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
              kind: "claude-projects",
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

export const layer = Layer.succeed(ClaudeLocalHistory, {
  dryRunScan: scanClaudeLocalHistoryDryRun(),
});
