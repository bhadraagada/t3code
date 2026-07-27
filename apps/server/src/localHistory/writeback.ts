// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";

import type { OrchestrationMessage, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  parseCursorTranscriptMessages,
  cursorLocalHistoryThreadId,
  type CursorLocalHistoryImportCandidate,
} from "../cursorLocalHistory/CursorLocalHistory.ts";
import {
  parseClaudeTranscriptContent,
  claudeLocalHistoryThreadId,
  type ClaudeLocalHistoryImportCandidate,
} from "../claudeLocalHistory/ClaudeLocalHistory.ts";
import {
  normalizeLocalHistoryText,
  selectNewLocalHistoryMessages,
  type LocalHistoryFingerprintMessage,
} from "./incrementalImport.ts";

/**
 * Append-only writeback of T3 thread messages into the same transcript JSONL
 * files the importers read (`~/.cursor/projects/.../agent-transcripts/*.jsonl`
 * and `~/.claude/projects/.../<uuid>.jsonl`). Only threads created by the
 * deterministic import path are touched — pure T3-native threads are never
 * written anywhere, and Cursor `store.db` / VSCode workspace DBs stay
 * strictly read-only.
 *
 * ponytail: outbound fidelity ceiling — plain user/assistant text turns only,
 * mirroring the minimal record shapes the import readers accept today. Tool
 * calls, thinking blocks, and the native `uuid`/`parentUuid` event graphs are
 * intentionally not reconstructed.
 */

export interface LocalHistoryWritebackError {
  readonly path: string;
  readonly message: string;
}

export interface LocalHistoryWritebackResult {
  /** Threads that received at least one appended line. */
  readonly threadCount: number;
  readonly appendedMessageCount: number;
  readonly errors: ReadonlyArray<LocalHistoryWritebackError>;
}

export const EMPTY_LOCAL_HISTORY_WRITEBACK_RESULT: LocalHistoryWritebackResult = {
  threadCount: 0,
  appendedMessageCount: 0,
  errors: [],
};

interface WritebackMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

interface WritebackTarget {
  readonly transcriptPath: string | null;
  readonly threadId: ThreadId;
  readonly parseSourceMessages: (text: string) => ReadonlyArray<LocalHistoryFingerprintMessage>;
  readonly encodeLine: (message: WritebackMessage) => string;
}

function writableThreadMessages(messages: ReadonlyArray<OrchestrationMessage>): WritebackMessage[] {
  return messages.flatMap((message) => {
    if (message.streaming) return [];
    if (message.role !== "user" && message.role !== "assistant") return [];
    if (normalizeLocalHistoryText(message.text).length === 0) return [];
    return [{ role: message.role, text: message.text, createdAt: message.createdAt }];
  });
}

async function appendMissingThreadMessages(input: {
  readonly transcriptPath: string;
  readonly threadMessages: ReadonlyArray<WritebackMessage>;
  readonly parseSourceMessages: (text: string) => ReadonlyArray<LocalHistoryFingerprintMessage>;
  readonly encodeLine: (message: WritebackMessage) => string;
}): Promise<number> {
  // Read the transcript fresh so the diff reflects the file as it is right
  // now, not as it was when the candidate scan ran.
  const text = await NodeFSP.readFile(input.transcriptPath, "utf8");
  const sourceMessages = input.parseSourceMessages(text);
  const delta = selectNewLocalHistoryMessages(sourceMessages, input.threadMessages);
  if (delta.length === 0) return 0;
  const payload =
    (text.length > 0 && !text.endsWith("\n") ? "\n" : "") +
    delta.map(({ message }) => input.encodeLine(message)).join("\n") +
    "\n";
  await NodeFSP.appendFile(input.transcriptPath, payload, "utf8");
  return delta.length;
}

function writebackTargets(input: {
  readonly targets: ReadonlyArray<WritebackTarget>;
  readonly projectionSnapshotQuery: ProjectionSnapshotQueryShape;
}): Effect.Effect<LocalHistoryWritebackResult> {
  return Effect.gen(function* () {
    let threadCount = 0;
    let appendedMessageCount = 0;
    const errors: LocalHistoryWritebackError[] = [];

    for (const target of input.targets) {
      const transcriptPath = target.transcriptPath;
      if (transcriptPath === null) continue;
      const thread = yield* input.projectionSnapshotQuery.getThreadDetailById(target.threadId).pipe(
        Effect.catch((error: unknown) =>
          Effect.sync(() => {
            errors.push({
              path: transcriptPath,
              message: error instanceof Error ? error.message : String(error),
            });
            return Option.none<never>();
          }),
        ),
      );
      // Never imported (or no longer active): leave the source file alone.
      if (Option.isNone(thread)) continue;
      const threadMessages = writableThreadMessages(thread.value.messages);
      if (threadMessages.length === 0) continue;

      const appended = yield* Effect.promise(async () => {
        try {
          return await appendMissingThreadMessages({
            transcriptPath,
            threadMessages,
            parseSourceMessages: target.parseSourceMessages,
            encodeLine: target.encodeLine,
          });
        } catch (cause) {
          // Missing or locked files are skipped, not fatal to the sync run.
          errors.push({
            path: transcriptPath,
            message: cause instanceof Error ? cause.message : String(cause),
          });
          return 0;
        }
      });
      if (appended > 0) {
        threadCount += 1;
        appendedMessageCount += appended;
      }
    }

    return { threadCount, appendedMessageCount, errors };
  });
}

function encodeCursorTranscriptLine(message: WritebackMessage): string {
  return JSON.stringify({
    role: message.role,
    message: { content: message.text },
    createdAt: message.createdAt,
  });
}

export function writebackCursorLocalHistory(input: {
  readonly candidates: ReadonlyArray<CursorLocalHistoryImportCandidate>;
  readonly projectionSnapshotQuery: ProjectionSnapshotQueryShape;
}): Effect.Effect<LocalHistoryWritebackResult> {
  return writebackTargets({
    targets: input.candidates.map((candidate) => ({
      transcriptPath:
        candidate.sources.find((source) => source.kind === "agent-transcripts")?.path ?? null,
      threadId: cursorLocalHistoryThreadId(candidate.workspaceKey, candidate.chatId),
      parseSourceMessages: parseCursorTranscriptMessages,
      encodeLine: encodeCursorTranscriptLine,
    })),
    projectionSnapshotQuery: input.projectionSnapshotQuery,
  });
}

function encodeClaudeTranscriptLine(workspacePath: string | null) {
  return (message: WritebackMessage): string =>
    JSON.stringify({
      type: message.role,
      message: { role: message.role, content: message.text },
      timestamp: message.createdAt,
      uuid: NodeCrypto.randomUUID(),
      ...(workspacePath === null ? {} : { cwd: workspacePath }),
    });
}

export function writebackClaudeLocalHistory(input: {
  readonly candidates: ReadonlyArray<ClaudeLocalHistoryImportCandidate>;
  readonly projectionSnapshotQuery: ProjectionSnapshotQueryShape;
}): Effect.Effect<LocalHistoryWritebackResult> {
  return writebackTargets({
    targets: input.candidates.map((candidate) => ({
      transcriptPath:
        candidate.sources.find((source) => source.kind === "claude-projects")?.path ?? null,
      threadId: claudeLocalHistoryThreadId(candidate.workspaceKey, candidate.chatId),
      parseSourceMessages: (text) => parseClaudeTranscriptContent(text).messages,
      encodeLine: encodeClaudeTranscriptLine(candidate.workspacePath),
    })),
    projectionSnapshotQuery: input.projectionSnapshotQuery,
  });
}
