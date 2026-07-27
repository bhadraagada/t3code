// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { describe, expect, it } from "vitest";

import {
  scanCursorLocalHistoryDryRun,
  scanCursorLocalHistoryImportCandidates,
} from "./CursorLocalHistory.ts";

describe("CursorLocalHistory", () => {
  it("discovers local Cursor transcripts and workspace storage without reading subagents", async () => {
    await Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3code-cursor-local-history-test-",
      });
      const projectsDir = NodePath.join(root, ".cursor", "projects");
      const chatsDir = NodePath.join(root, ".cursor", "chats");
      const workspaceStorageDir = NodePath.join(root, "workspaceStorage");
      const workspaceSlug = "c-Users-example-project";
      const chatId = "11111111-1111-4111-8111-111111111111";
      const transcriptPath = NodePath.join(
        projectsDir,
        workspaceSlug,
        "agent-transcripts",
        chatId,
        `${chatId}.jsonl`,
      );
      const subagentTranscriptPath = NodePath.join(
        projectsDir,
        workspaceSlug,
        "agent-transcripts",
        "subagents",
        "22222222-2222-4222-8222-222222222222.jsonl",
      );
      const workspaceJsonPath = NodePath.join(workspaceStorageDir, "hash-1", "workspace.json");
      const storeDbPath = NodePath.join(chatsDir, "hash-1", chatId, "store.db");

      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.dirname(transcriptPath), { recursive: true });
        await NodeFSP.writeFile(
          transcriptPath,
          [
            '{"role":"user","message":{"content":[{"type":"text","text":"<timestamp>Thursday</timestamp>\\n<user_query>\\nepisodic.db\\nvector_index.db\\n\\nget these too and put into db yea\\n</user_query>"}]}}',
            '{"role":"assistant","message":{"content":[{"type":"text","text":"Copying the five new wiki table files and merging the `_summaries.json` entries into this repo.\\n\\n[REDACTED]"},{"type":"tool_use","name":"Read","input":{"path":"ignored"}}]}}',
            '{"role":"assistant","message":{"content":[{"type":"text","text":"[REDACTED]"}]}}',
            '{"role":"system","message":{"content":[{"type":"text","text":"hidden prompt"}]}}',
            '{"role":"user","message":{"content":[{"type":"text","text":"[Image]\\n<image_files>ignored</image_files>\\n<timestamp>Thursday</timestamp>\\n<user_query>\\n\\n</user_query>"}]}}',
            "not-json",
            "",
          ].join("\n"),
        );
        await NodeFSP.mkdir(NodePath.dirname(subagentTranscriptPath), { recursive: true });
        await NodeFSP.writeFile(
          subagentTranscriptPath,
          '{"role":"assistant","message":{"content":[{"type":"text","text":"ignored"}]}}',
        );
        await NodeFSP.mkdir(NodePath.dirname(workspaceJsonPath), { recursive: true });
        await NodeFSP.writeFile(
          workspaceJsonPath,
          '{"folder":"file:///c%3A/Users/example/project"}',
        );
        await NodeFSP.mkdir(NodePath.dirname(storeDbPath), { recursive: true });
        await NodeFSP.writeFile(storeDbPath, "");
      });

      const result = yield* scanCursorLocalHistoryDryRun({
        projectsDir,
        chatsDir,
        workspaceStorageDir,
      });

      expect(result.transcriptFileCount).toBe(1);
      expect(result.chatStoreCount).toBe(1);
      expect(result.workspaceStorageCount).toBe(1);
      expect(result.messageCount).toBe(2);
      expect(result.parseErrorCount).toBe(1);
      expect(result.chats.some((chat) => chat.chatId === chatId)).toBe(true);

      const candidates = yield* scanCursorLocalHistoryImportCandidates({
        projectsDir,
        chatsDir,
        workspaceStorageDir,
      });

      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.title).toBe("episodic.db");
      expect(candidates[0]?.messages).toEqual([
        {
          role: "user",
          text: "episodic.db\nvector_index.db\n\nget these too and put into db yea",
          createdAt: expect.any(String),
        },
        {
          role: "assistant",
          text: "Copying the five new wiki table files and merging the `_summaries.json` entries into this repo.",
          createdAt: expect.any(String),
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise);
  });
});
