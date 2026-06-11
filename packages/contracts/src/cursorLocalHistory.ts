import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const CursorLocalHistorySourceKind = Schema.Literals([
  "agent-transcripts",
  "chat-store",
  "workspace-storage",
]);
export type CursorLocalHistorySourceKind = typeof CursorLocalHistorySourceKind.Type;

export const CursorLocalHistorySourceRef = Schema.Struct({
  kind: CursorLocalHistorySourceKind,
  path: TrimmedNonEmptyString,
});
export type CursorLocalHistorySourceRef = typeof CursorLocalHistorySourceRef.Type;

export const CursorLocalHistoryChatSummary = Schema.Struct({
  chatId: TrimmedNonEmptyString,
  workspaceKey: TrimmedNonEmptyString,
  workspacePath: Schema.NullOr(TrimmedNonEmptyString),
  messageCount: NonNegativeInt,
  sourceRecordCount: NonNegativeInt,
  parseErrorCount: NonNegativeInt,
  createdAt: Schema.NullOr(IsoDateTime),
  updatedAt: Schema.NullOr(IsoDateTime),
  sources: Schema.Array(CursorLocalHistorySourceRef),
});
export type CursorLocalHistoryChatSummary = typeof CursorLocalHistoryChatSummary.Type;

export const CursorLocalHistoryWorkspaceSummary = Schema.Struct({
  workspaceKey: TrimmedNonEmptyString,
  workspaceSlug: Schema.NullOr(TrimmedNonEmptyString),
  workspaceHash: Schema.NullOr(TrimmedNonEmptyString),
  workspacePath: Schema.NullOr(TrimmedNonEmptyString),
  chatCount: NonNegativeInt,
  messageCount: NonNegativeInt,
  transcriptFileCount: NonNegativeInt,
  chatStoreCount: NonNegativeInt,
  workspaceStorageCount: NonNegativeInt,
  latestActivityAt: Schema.NullOr(IsoDateTime),
  sources: Schema.Array(CursorLocalHistorySourceRef),
});
export type CursorLocalHistoryWorkspaceSummary = typeof CursorLocalHistoryWorkspaceSummary.Type;

export const CursorLocalHistoryScanError = Schema.Struct({
  kind: CursorLocalHistorySourceKind,
  path: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
});
export type CursorLocalHistoryScanError = typeof CursorLocalHistoryScanError.Type;

export const CursorLocalHistoryDryRunResult = Schema.Struct({
  scannedAt: IsoDateTime,
  roots: Schema.Struct({
    projectsDir: TrimmedNonEmptyString,
    chatsDir: TrimmedNonEmptyString,
    workspaceStorageDir: TrimmedNonEmptyString,
  }),
  workspaceCount: NonNegativeInt,
  chatCount: NonNegativeInt,
  messageCount: NonNegativeInt,
  transcriptFileCount: NonNegativeInt,
  chatStoreCount: NonNegativeInt,
  workspaceStorageCount: NonNegativeInt,
  parseErrorCount: NonNegativeInt,
  errors: Schema.Array(CursorLocalHistoryScanError),
  workspaces: Schema.Array(CursorLocalHistoryWorkspaceSummary),
  chats: Schema.Array(CursorLocalHistoryChatSummary),
});
export type CursorLocalHistoryDryRunResult = typeof CursorLocalHistoryDryRunResult.Type;

export const CursorLocalHistoryImportThread = Schema.Struct({
  chatId: TrimmedNonEmptyString,
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  messageCount: NonNegativeInt,
});
export type CursorLocalHistoryImportThread = typeof CursorLocalHistoryImportThread.Type;

export const CursorLocalHistoryImportInput = Schema.Struct({
  offset: Schema.optional(NonNegativeInt),
  limit: Schema.optional(PositiveInt),
});
export type CursorLocalHistoryImportInput = typeof CursorLocalHistoryImportInput.Type;

export const CursorLocalHistoryImportResult = Schema.Struct({
  totalCandidateCount: NonNegativeInt,
  importedCandidateOffset: NonNegativeInt,
  importedCandidateLimit: NonNegativeInt,
  importedProjectCount: NonNegativeInt,
  importedThreadCount: NonNegativeInt,
  importedMessageCount: NonNegativeInt,
  skippedChatCount: NonNegativeInt,
  errors: Schema.Array(CursorLocalHistoryScanError),
  threads: Schema.Array(CursorLocalHistoryImportThread),
});
export type CursorLocalHistoryImportResult = typeof CursorLocalHistoryImportResult.Type;
