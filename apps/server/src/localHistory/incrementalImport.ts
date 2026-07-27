// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

/**
 * Shared fingerprint/delta helpers for incremental Cursor/Claude local
 * history imports. A message's identity across the source transcript and its
 * imported T3 thread is `role + "\0" + normalized text`; both sides of the
 * comparison must go through the same reader/normalization so the texts
 * round-trip (the importers store the reader-cleaned text verbatim).
 */

export interface LocalHistoryFingerprintMessage {
  readonly role: string;
  readonly text: string;
}

export function normalizeLocalHistoryText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

export function localHistoryMessageFingerprint(message: LocalHistoryFingerprintMessage): string {
  return `${message.role}\0${normalizeLocalHistoryText(message.text)}`;
}

/** Short stable digest of a fingerprint, safe to embed in id part lists. */
export function localHistoryFingerprintHash(fingerprint: string): string {
  return NodeCrypto.createHash("sha256").update(fingerprint).digest("hex").slice(0, 24);
}

function buildFingerprintCounts(
  messages: ReadonlyArray<LocalHistoryFingerprintMessage>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const fingerprint = localHistoryMessageFingerprint(message);
    counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1);
  }
  return counts;
}

export interface LocalHistoryDeltaMessage<M extends LocalHistoryFingerprintMessage> {
  readonly message: M;
  readonly fingerprint: string;
  /**
   * Occurrence index of this fingerprint within the candidate list. Repeated
   * identical messages ("yes", "continue") stay distinguishable, and the
   * (fingerprint, occurrence) pair is stable across runs so it can seed
   * deterministic message ids.
   */
  readonly occurrence: number;
}

/**
 * Candidate messages not yet present in `existingMessages`, compared as a
 * multiset: the first k occurrences of a fingerprint are treated as already
 * imported when the existing side holds k copies.
 */
export function selectNewLocalHistoryMessages<M extends LocalHistoryFingerprintMessage>(
  existingMessages: ReadonlyArray<LocalHistoryFingerprintMessage>,
  candidateMessages: ReadonlyArray<M>,
): ReadonlyArray<LocalHistoryDeltaMessage<M>> {
  const existingCounts = buildFingerprintCounts(existingMessages);
  const seenCounts = new Map<string, number>();
  const delta: LocalHistoryDeltaMessage<M>[] = [];
  for (const message of candidateMessages) {
    const fingerprint = localHistoryMessageFingerprint(message);
    const occurrence = seenCounts.get(fingerprint) ?? 0;
    seenCounts.set(fingerprint, occurrence + 1);
    if (occurrence < (existingCounts.get(fingerprint) ?? 0)) continue;
    delta.push({ message, fingerprint, occurrence });
  }
  return delta;
}

/**
 * Watermark over the full candidate message list. Embedding it in the
 * `thread.messages.import` commandId makes re-imports of an unchanged source
 * deduplicate via orchestration receipts while a grown source produces a new
 * commandId that actually dispatches.
 */
export function localHistoryImportWatermark(
  messages: ReadonlyArray<LocalHistoryFingerprintMessage>,
): string {
  const digest = NodeCrypto.createHash("sha256");
  for (const message of messages) {
    digest.update(localHistoryMessageFingerprint(message));
    digest.update("\u001e");
  }
  return `${messages.length}-${digest.digest("hex").slice(0, 24)}`;
}
