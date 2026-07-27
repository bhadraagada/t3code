import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const ClaudeLocalHistorySourceKind = Schema.Literal("claude-projects");
export type ClaudeLocalHistorySourceKind = typeof ClaudeLocalHistorySourceKind.Type;

export const ClaudeLocalHistorySourceRef = Schema.Struct({
  kind: ClaudeLocalHistorySourceKind,
  path: TrimmedNonEmptyString,
});
export type ClaudeLocalHistorySourceRef = typeof ClaudeLocalHistorySourceRef.Type;

export const ClaudeLocalHistoryChatSummary = Schema.Struct({
  chatId: TrimmedNonEmptyString,
  workspaceKey: TrimmedNonEmptyString,
  workspacePath: Schema.NullOr(TrimmedNonEmptyString),
  title: TrimmedNonEmptyString,
  messageCount: NonNegativeInt,
  sourceRecordCount: NonNegativeInt,
  parseErrorCount: NonNegativeInt,
  createdAt: Schema.NullOr(IsoDateTime),
  updatedAt: Schema.NullOr(IsoDateTime),
  sources: Schema.Array(ClaudeLocalHistorySourceRef),
});
export type ClaudeLocalHistoryChatSummary = typeof ClaudeLocalHistoryChatSummary.Type;

export const ClaudeLocalHistoryWorkspaceSummary = Schema.Struct({
  workspaceKey: TrimmedNonEmptyString,
  workspacePath: Schema.NullOr(TrimmedNonEmptyString),
  chatCount: NonNegativeInt,
  messageCount: NonNegativeInt,
  transcriptFileCount: NonNegativeInt,
  latestActivityAt: Schema.NullOr(IsoDateTime),
  sources: Schema.Array(ClaudeLocalHistorySourceRef),
});
export type ClaudeLocalHistoryWorkspaceSummary = typeof ClaudeLocalHistoryWorkspaceSummary.Type;

export const ClaudeLocalHistoryScanError = Schema.Struct({
  kind: ClaudeLocalHistorySourceKind,
  path: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
});
export type ClaudeLocalHistoryScanError = typeof ClaudeLocalHistoryScanError.Type;

export const ClaudeLocalHistoryDryRunResult = Schema.Struct({
  scannedAt: IsoDateTime,
  roots: Schema.Struct({
    configDir: TrimmedNonEmptyString,
    projectsDir: TrimmedNonEmptyString,
  }),
  workspaceCount: NonNegativeInt,
  chatCount: NonNegativeInt,
  messageCount: NonNegativeInt,
  transcriptFileCount: NonNegativeInt,
  parseErrorCount: NonNegativeInt,
  errors: Schema.Array(ClaudeLocalHistoryScanError),
  workspaces: Schema.Array(ClaudeLocalHistoryWorkspaceSummary),
  chats: Schema.Array(ClaudeLocalHistoryChatSummary),
});
export type ClaudeLocalHistoryDryRunResult = typeof ClaudeLocalHistoryDryRunResult.Type;

export const ClaudeLocalHistoryImportThread = Schema.Struct({
  chatId: TrimmedNonEmptyString,
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  messageCount: NonNegativeInt,
});
export type ClaudeLocalHistoryImportThread = typeof ClaudeLocalHistoryImportThread.Type;

export const ClaudeLocalHistoryImportInput = Schema.Struct({
  offset: Schema.optional(NonNegativeInt),
  limit: Schema.optional(PositiveInt),
});
export type ClaudeLocalHistoryImportInput = typeof ClaudeLocalHistoryImportInput.Type;

export const ClaudeLocalHistoryImportResult = Schema.Struct({
  totalCandidateCount: NonNegativeInt,
  importedCandidateOffset: NonNegativeInt,
  importedCandidateLimit: NonNegativeInt,
  importedProjectCount: NonNegativeInt,
  importedThreadCount: NonNegativeInt,
  importedMessageCount: NonNegativeInt,
  skippedChatCount: NonNegativeInt,
  errors: Schema.Array(ClaudeLocalHistoryScanError),
  threads: Schema.Array(ClaudeLocalHistoryImportThread),
});
export type ClaudeLocalHistoryImportResult = typeof ClaudeLocalHistoryImportResult.Type;
