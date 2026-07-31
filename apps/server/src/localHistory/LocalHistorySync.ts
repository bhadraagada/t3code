import type { LocalHistorySyncResult, LocalHistorySyncSourceSummary } from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import {
  importClaudeLocalHistoryCandidates,
  scanClaudeLocalHistoryImportCandidates,
  type ClaudeLocalHistoryRoots,
} from "../claudeLocalHistory/ClaudeLocalHistory.ts";
import {
  importCursorLocalHistoryCandidates,
  scanCursorLocalHistoryImportCandidates,
  type CursorLocalHistoryRoots,
} from "../cursorLocalHistory/CursorLocalHistory.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  EMPTY_LOCAL_HISTORY_WRITEBACK_RESULT,
  writebackClaudeLocalHistory,
  writebackCursorLocalHistory,
  type LocalHistoryWritebackResult,
} from "./writeback.ts";

export interface LocalHistorySyncShape {
  /** Run one incremental sync (both sources) now. Single-flight guarded. */
  readonly syncNow: Effect.Effect<LocalHistorySyncResult>;

  /** Start the settings-driven background sync loop within the provided scope. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class LocalHistorySync extends Context.Service<LocalHistorySync, LocalHistorySyncShape>()(
  "t3/localHistory/LocalHistorySync",
) {}

// Let the server finish booting before the first enabled sync scans transcripts.
const INITIAL_SYNC_DELAY = Duration.minutes(1);
// While the interval setting is zero the loop only re-reads settings, cheaply.
const DISABLED_RECHECK_INTERVAL = Duration.minutes(5);

interface ImportCounts {
  readonly importedThreadCount: number;
  readonly importedMessageCount: number;
  readonly skippedChatCount: number;
  readonly errors: ReadonlyArray<unknown>;
}

function toSourceSummary(
  scannedChatCount: number,
  importResult: ImportCounts,
  writeback: LocalHistoryWritebackResult,
): LocalHistorySyncSourceSummary {
  return {
    scannedChatCount,
    importedThreadCount: importResult.importedThreadCount,
    importedMessageCount: importResult.importedMessageCount,
    skippedChatCount: importResult.skippedChatCount,
    importErrorCount: importResult.errors.length,
    writebackThreadCount: writeback.threadCount,
    writebackMessageCount: writeback.appendedMessageCount,
    writebackErrorCount: writeback.errors.length,
  };
}

export function runLocalHistorySyncOnce(input: {
  readonly writebackEnabled: boolean;
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly projectionSnapshotQuery: ProjectionSnapshotQueryShape;
  readonly cursorRoots?: CursorLocalHistoryRoots;
  readonly claudeRoots?: ClaudeLocalHistoryRoots;
}): Effect.Effect<LocalHistorySyncResult> {
  return Effect.gen(function* () {
    const startedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);

    const cursorCandidates = yield* scanCursorLocalHistoryImportCandidates(input.cursorRoots);
    const cursorImport = yield* importCursorLocalHistoryCandidates({
      candidates: cursorCandidates,
      orchestrationEngine: input.orchestrationEngine,
      projectionSnapshotQuery: input.projectionSnapshotQuery,
    });
    const cursorWriteback = input.writebackEnabled
      ? yield* writebackCursorLocalHistory({
          candidates: cursorCandidates,
          projectionSnapshotQuery: input.projectionSnapshotQuery,
        })
      : EMPTY_LOCAL_HISTORY_WRITEBACK_RESULT;

    const claudeCandidates = yield* scanClaudeLocalHistoryImportCandidates(input.claudeRoots);
    const claudeImport = yield* importClaudeLocalHistoryCandidates({
      candidates: claudeCandidates,
      orchestrationEngine: input.orchestrationEngine,
      projectionSnapshotQuery: input.projectionSnapshotQuery,
    });
    const claudeWriteback = input.writebackEnabled
      ? yield* writebackClaudeLocalHistory({
          candidates: claudeCandidates,
          projectionSnapshotQuery: input.projectionSnapshotQuery,
        })
      : EMPTY_LOCAL_HISTORY_WRITEBACK_RESULT;

    const finishedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    return {
      startedAt,
      finishedAt,
      writebackEnabled: input.writebackEnabled,
      cursor: toSourceSummary(cursorCandidates.length, cursorImport, cursorWriteback),
      claude: toSourceSummary(claudeCandidates.length, claudeImport, claudeWriteback),
    };
  });
}

export const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const syncSemaphore = yield* Semaphore.make(1);

  const readSettings = serverSettings.getSettings.pipe(
    Effect.catch((error) =>
      Effect.logWarning("Failed to read settings for local history sync", {
        detail: error.message,
      }).pipe(Effect.as(DEFAULT_SERVER_SETTINGS)),
    ),
  );

  const syncNow: LocalHistorySyncShape["syncNow"] = syncSemaphore.withPermit(
    Effect.gen(function* () {
      const settings = yield* readSettings;
      return yield* runLocalHistorySyncOnce({
        writebackEnabled: settings.localHistorySyncWriteback,
        orchestrationEngine,
        projectionSnapshotQuery,
      });
    }),
  );

  const tick = Effect.gen(function* () {
    const settings = yield* readSettings;
    const interval = settings.localHistorySyncInterval;
    if (Duration.isZero(interval)) return DISABLED_RECHECK_INTERVAL;

    const result = yield* syncNow;
    yield* Effect.logInfo("local history sync completed", {
      cursorImportedThreadCount: result.cursor.importedThreadCount,
      cursorImportedMessageCount: result.cursor.importedMessageCount,
      claudeImportedThreadCount: result.claude.importedThreadCount,
      claudeImportedMessageCount: result.claude.importedMessageCount,
      writebackEnabled: result.writebackEnabled,
      writebackMessageCount:
        result.cursor.writebackMessageCount + result.claude.writebackMessageCount,
      errorCount:
        result.cursor.importErrorCount +
        result.cursor.writebackErrorCount +
        result.claude.importErrorCount +
        result.claude.writebackErrorCount,
    });
    return interval;
  }).pipe(
    Effect.catchDefect((defect: unknown) =>
      Effect.logWarning("local history sync failed", { defect }).pipe(
        Effect.as(DISABLED_RECHECK_INTERVAL),
      ),
    ),
  );

  const start: LocalHistorySyncShape["start"] = () =>
    Effect.forkScoped(
      Effect.sleep(INITIAL_SYNC_DELAY).pipe(
        Effect.andThen(
          // Each tick re-reads the live settings and returns the next delay,
          // so interval changes apply without a restart and a zero interval
          // parks the loop on a cheap recheck cadence.
          tick.pipe(
            Effect.repeat(
              Schedule.identity<Duration.Duration>().pipe(
                Schedule.addDelay((delay) => Effect.succeed(delay)),
              ),
            ),
          ),
        ),
      ),
    ).pipe(Effect.asVoid);

  return {
    syncNow,
    start,
  } satisfies LocalHistorySyncShape;
});

export const layer = Layer.effect(LocalHistorySync, make);
