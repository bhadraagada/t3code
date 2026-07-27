// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { describe, expect, it } from "vitest";

import {
  scanClaudeLocalHistoryDryRun,
  scanClaudeLocalHistoryImportCandidates,
} from "./ClaudeLocalHistory.ts";

describe("ClaudeLocalHistory", () => {
  it("discovers Claude Code session transcripts and skips agent sidechains", async () => {
    await Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3code-claude-local-history-test-",
      });
      const configDir = NodePath.join(root, ".claude");
      const projectsDir = NodePath.join(configDir, "projects");
      const encodedProject = "C--Users-example-project";
      const chatId = "11111111-1111-4111-8111-111111111111";
      const transcriptPath = NodePath.join(projectsDir, encodedProject, `${chatId}.jsonl`);
      const agentTranscriptPath = NodePath.join(
        projectsDir,
        encodedProject,
        "agent-22222222-2222-4222-8222-222222222222.jsonl",
      );

      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.dirname(transcriptPath), { recursive: true });
        await NodeFSP.writeFile(
          transcriptPath,
          [
            '{"type":"mode","mode":"default","sessionId":"11111111-1111-4111-8111-111111111111"}',
            '{"type":"ai-title","aiTitle":"Review n8n workflows","sessionId":"11111111-1111-4111-8111-111111111111"}',
            '{"type":"user","message":{"role":"user","content":"can you check the workflows?"},"cwd":"C:\\\\Users\\\\example\\\\project","timestamp":"2026-06-10T10:00:00.000Z"}',
            '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Sure, looking now."},{"type":"tool_use","name":"Read","input":{"path":"x"}}]},"cwd":"C:\\\\Users\\\\example\\\\project","timestamp":"2026-06-10T10:00:01.000Z"}',
            '{"type":"attachment","cwd":"C:\\\\Users\\\\example\\\\project"}',
            "not-json",
            "",
          ].join("\n"),
        );
        await NodeFSP.writeFile(
          agentTranscriptPath,
          '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ignored"}]}}',
        );
      });

      const result = yield* scanClaudeLocalHistoryDryRun({
        configDir,
        projectsDir,
      });

      expect(result.transcriptFileCount).toBe(1);
      expect(result.chatCount).toBe(1);
      expect(result.messageCount).toBe(2);
      expect(result.parseErrorCount).toBe(1);
      expect(result.chats[0]?.title).toBe("Review n8n workflows");
      expect(result.chats[0]?.workspacePath).toBe("C:\\Users\\example\\project");

      const candidates = yield* scanClaudeLocalHistoryImportCandidates({
        configDir,
        projectsDir,
      });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.title).toBe("Review n8n workflows");
      expect(candidates[0]?.messages).toEqual([
        {
          role: "user",
          text: "can you check the workflows?",
          createdAt: "2026-06-10T10:00:00.000Z",
        },
        {
          role: "assistant",
          text: "Sure, looking now.",
          createdAt: "2026-06-10T10:00:01.000Z",
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise);
  });
});
