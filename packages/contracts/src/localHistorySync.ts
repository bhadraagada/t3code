import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt } from "./baseSchemas.ts";

export const LocalHistorySyncSourceSummary = Schema.Struct({
  scannedChatCount: NonNegativeInt,
  importedThreadCount: NonNegativeInt,
  importedMessageCount: NonNegativeInt,
  skippedChatCount: NonNegativeInt,
  importErrorCount: NonNegativeInt,
  writebackThreadCount: NonNegativeInt,
  writebackMessageCount: NonNegativeInt,
  writebackErrorCount: NonNegativeInt,
});
export type LocalHistorySyncSourceSummary = typeof LocalHistorySyncSourceSummary.Type;

export const LocalHistorySyncResult = Schema.Struct({
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime,
  writebackEnabled: Schema.Boolean,
  cursor: LocalHistorySyncSourceSummary,
  claude: LocalHistorySyncSourceSummary,
});
export type LocalHistorySyncResult = typeof LocalHistorySyncResult.Type;

export const LocalHistorySyncNowInput = Schema.Struct({});
export type LocalHistorySyncNowInput = typeof LocalHistorySyncNowInput.Type;
