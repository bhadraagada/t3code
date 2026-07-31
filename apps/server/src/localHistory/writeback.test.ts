// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { describe, expect, it } from "vite-plus/test";

import {
  importClaudeLocalHistoryCandidates,
  scanClaudeLocalHistoryImportCandidates,
} from "../claudeLocalHistory/ClaudeLocalHistory.ts";
import {
  importCursorLocalHistoryCandidates,
  scanCursorLocalHistoryImportCandidates,
} from "../cursorLocalHistory/CursorLocalHistory.ts";
import { makeLocalHistoryImportHarness } from "./importTestHarness.ts";
import { runLocalHistorySyncOnce } from "./LocalHistorySync.ts";
import { writebackClaudeLocalHistory, writebackCursorLocalHistory } from "./writeback.ts";

const CHAT_ID = "11111111-1111-4111-8111-111111111111";

async function makeCursorFixture(root: string) {
  const projectsDir = NodePath.join(root, ".cursor", "projects");
  const chatsDir = NodePath.join(root, ".cursor", "chats");
  const workspaceStorageDir = NodePath.join(root, "workspaceStorage");
  const transcriptPath = NodePath.join(
    projectsDir,
    "c-Users-example-project",
    "agent-transcripts",
    CHAT_ID,
    `${CHAT_ID}.jsonl`,
  );
  const workspaceJsonPath = NodePath.join(workspaceStorageDir, "hash-1", "workspace.json");
  await NodeFSP.mkdir(NodePath.dirname(transcriptPath), { recursive: true });
  await NodeFSP.writeFile(
    transcriptPath,
    [
      '{"role":"user","message":{"content":[{"type":"text","text":"<user_query>\\nfirst question\\n</user_query>"}]}}',
      '{"role":"assistant","message":{"content":[{"type":"text","text":"First answer."}]}}',
      "",
    ].join("\n"),
  );
  await NodeFSP.mkdir(NodePath.dirname(workspaceJsonPath), { recursive: true });
  await NodeFSP.writeFile(workspaceJsonPath, '{"folder":"file:///c%3A/Users/example/project"}');
  return { roots: { projectsDir, chatsDir, workspaceStorageDir }, transcriptPath };
}

function lastJsonLine(text: string): Record<string, unknown> {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return JSON.parse(lines.at(-1)!) as Record<string, unknown>;
}

describe("localHistory writeback", () => {
  it("appends only missing T3 messages to the Cursor transcript, append-only and idempotent", async () => {
    await Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3code-local-history-writeback-cursor-test-",
      });
      const { roots, transcriptPath } = yield* Effect.promise(() => makeCursorFixture(root));

      const harness = makeLocalHistoryImportHarness();
      const candidates = yield* scanCursorLocalHistoryImportCandidates(roots);
      const imported = yield* importCursorLocalHistoryCandidates({
        candidates,
        orchestrationEngine: harness.orchestrationEngine,
        projectionSnapshotQuery: harness.projectionSnapshotQuery,
      });
      const threadId = imported.threads[0]!.threadId;
      harness.threadMessages.get(threadId)!.push({
        id: "t3-only-1",
        role: "assistant",
        text: "T3-only reply.",
        streaming: false,
        createdAt: "2026-06-11T00:00:00.000Z",
      });

      const before = yield* Effect.promise(() => NodeFSP.readFile(transcriptPath, "utf8"));
      const first = yield* writebackCursorLocalHistory({
        candidates,
        projectionSnapshotQuery: harness.projectionSnapshotQuery,
      });
      expect(first.errors).toEqual([]);
      expect(first.threadCount).toBe(1);
      expect(first.appendedMessageCount).toBe(1);

      const after = yield* Effect.promise(() => NodeFSP.readFile(transcriptPath, "utf8"));
      expect(after.startsWith(before)).toBe(true);
      const appended = lastJsonLine(after);
      expect(appended.role).toBe("assistant");
      expect((appended.message as Record<string, unknown>).content).toBe("T3-only reply.");
      expect(appended.createdAt).toBe("2026-06-11T00:00:00.000Z");

      // Re-running against the grown file appends nothing.
      const second = yield* writebackCursorLocalHistory({
        candidates: yield* scanCursorLocalHistoryImportCandidates(roots),
        projectionSnapshotQuery: harness.projectionSnapshotQuery,
      });
      expect(second.appendedMessageCount).toBe(0);
      expect(yield* Effect.promise(() => NodeFSP.readFile(transcriptPath, "utf8"))).toBe(after);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise);
  });

  it("appends Claude session lines in the minimal accepted shape", async () => {
    await Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3code-local-history-writeback-claude-test-",
      });
      const configDir = NodePath.join(root, ".claude");
      const projectsDir = NodePath.join(configDir, "projects");
      const roots = { configDir, projectsDir };
      const transcriptPath = NodePath.join(
        projectsDir,
        "C--Users-example-project",
        `${CHAT_ID}.jsonl`,
      );
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.dirname(transcriptPath), { recursive: true });
        await NodeFSP.writeFile(
          transcriptPath,
          '{"type":"user","message":{"role":"user","content":"first question"},"cwd":"C:\\\\Users\\\\example\\\\project","timestamp":"2026-06-10T10:00:00.000Z"}\n',
        );
      });

      const harness = makeLocalHistoryImportHarness();
      const candidates = yield* scanClaudeLocalHistoryImportCandidates(roots);
      const imported = yield* importClaudeLocalHistoryCandidates({
        candidates,
        orchestrationEngine: harness.orchestrationEngine,
        projectionSnapshotQuery: harness.projectionSnapshotQuery,
      });
      const threadId = imported.threads[0]!.threadId;
      harness.threadMessages.get(threadId)!.push({
        id: "t3-only-1",
        role: "assistant",
        text: "T3-only reply.",
        streaming: false,
        createdAt: "2026-06-11T00:00:00.000Z",
      });

      const result = yield* writebackClaudeLocalHistory({
        candidates,
        projectionSnapshotQuery: harness.projectionSnapshotQuery,
      });
      expect(result.errors).toEqual([]);
      expect(result.appendedMessageCount).toBe(1);

      const after = yield* Effect.promise(() => NodeFSP.readFile(transcriptPath, "utf8"));
      const appended = lastJsonLine(after);
      expect(appended.type).toBe("assistant");
      expect(appended.message).toEqual({ role: "assistant", content: "T3-only reply." });
      expect(appended.timestamp).toBe("2026-06-11T00:00:00.000Z");
      expect(appended.cwd).toBe("C:\\Users\\example\\project");
      expect(typeof appended.uuid).toBe("string");
      expect((appended.uuid as string).length).toBeGreaterThan(0);

      // The written line round-trips through the import reader, so the next
      // inbound sync treats it as already present.
      const rescanned = yield* scanClaudeLocalHistoryImportCandidates(roots);
      expect(rescanned[0]?.messages.at(-1)).toMatchObject({
        role: "assistant",
        text: "T3-only reply.",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise);
  });

  it("sync runs writeback only when the flag is enabled", async () => {
    await Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3code-local-history-sync-flag-test-",
      });
      const { roots: cursorRoots, transcriptPath } = yield* Effect.promise(() =>
        makeCursorFixture(root),
      );
      const claudeRoots = {
        configDir: NodePath.join(root, ".claude"),
        projectsDir: NodePath.join(root, ".claude", "projects"),
      };

      const harness = makeLocalHistoryImportHarness();
      const syncArgs = {
        orchestrationEngine: harness.orchestrationEngine,
        projectionSnapshotQuery: harness.projectionSnapshotQuery,
        cursorRoots,
        claudeRoots,
      };

      const first = yield* runLocalHistorySyncOnce({ ...syncArgs, writebackEnabled: false });
      expect(first.writebackEnabled).toBe(false);
      expect(first.cursor.importedMessageCount).toBe(2);
      expect(first.cursor.writebackMessageCount).toBe(0);

      const threadId = [...harness.threadMessages.keys()][0]!;
      harness.threadMessages.get(threadId)!.push({
        id: "t3-only-1",
        role: "assistant",
        text: "T3-only reply.",
        streaming: false,
        createdAt: "2026-06-11T00:00:00.000Z",
      });
      const before = yield* Effect.promise(() => NodeFSP.readFile(transcriptPath, "utf8"));

      const second = yield* runLocalHistorySyncOnce({ ...syncArgs, writebackEnabled: false });
      expect(second.cursor.writebackMessageCount).toBe(0);
      expect(yield* Effect.promise(() => NodeFSP.readFile(transcriptPath, "utf8"))).toBe(before);

      const third = yield* runLocalHistorySyncOnce({ ...syncArgs, writebackEnabled: true });
      expect(third.cursor.writebackMessageCount).toBe(1);
      const after = yield* Effect.promise(() => NodeFSP.readFile(transcriptPath, "utf8"));
      expect(after.startsWith(before)).toBe(true);
      expect(after).not.toBe(before);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise);
  });
});
