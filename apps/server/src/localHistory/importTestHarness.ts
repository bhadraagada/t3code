import type {
  ModelSelection,
  OrchestrationMessageRole,
  OrchestrationProject,
  OrchestrationThread,
} from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

/**
 * Test-only in-memory stand-in for the orchestration engine and projection
 * query used by the local history import/writeback unit tests: dedupes
 * dispatches by commandId (receipts) and projects imported messages per
 * thread, deduped by messageId like the real projector.
 */

export interface LocalHistoryHarnessMessage {
  readonly id: string;
  readonly role: OrchestrationMessageRole;
  readonly text: string;
  readonly streaming: boolean;
  readonly createdAt: string;
}

export function makeLocalHistoryImportHarness() {
  const receipts = new Set<string>();
  const threadMessages = new Map<string, LocalHistoryHarnessMessage[]>();
  const projectIdsByRoot = new Map<string, string>();

  const orchestrationEngine = {
    dispatch: (command: {
      readonly type: string;
      readonly commandId: string;
      readonly [key: string]: unknown;
    }) =>
      Effect.sync(() => {
        if (receipts.has(command.commandId)) return { sequence: receipts.size };
        receipts.add(command.commandId);
        switch (command.type) {
          case "project.create":
            projectIdsByRoot.set(command.workspaceRoot as string, command.projectId as string);
            break;
          case "thread.create":
            if (!threadMessages.has(command.threadId as string)) {
              threadMessages.set(command.threadId as string, []);
            }
            break;
          case "thread.messages.import": {
            const messages = threadMessages.get(command.threadId as string);
            if (!messages) throw new Error(`thread not found: ${String(command.threadId)}`);
            for (const message of command.messages as ReadonlyArray<{
              readonly messageId: string;
              readonly role: OrchestrationMessageRole;
              readonly text: string;
              readonly createdAt: string;
            }>) {
              if (messages.some((existing) => existing.id === message.messageId)) continue;
              messages.push({
                id: message.messageId,
                role: message.role,
                text: message.text,
                streaming: false,
                createdAt: message.createdAt,
              });
            }
            break;
          }
          default:
            break;
        }
        return { sequence: receipts.size };
      }),
  } as unknown as OrchestrationEngineShape;

  const projectionSnapshotQuery = {
    getActiveProjectByWorkspaceRoot: (workspaceRoot: string) =>
      Effect.succeed(
        Option.map(
          Option.fromUndefinedOr(projectIdsByRoot.get(workspaceRoot)),
          (id) => ({ id }) as unknown as OrchestrationProject,
        ),
      ),
    getThreadDetailById: (threadId: string) =>
      Effect.succeed(
        Option.map(
          Option.fromUndefinedOr(threadMessages.get(threadId)),
          (messages) => ({ messages }) as unknown as OrchestrationThread,
        ),
      ),
  } as unknown as ProjectionSnapshotQueryShape;

  return { orchestrationEngine, projectionSnapshotQuery, threadMessages };
}

export const testLocalHistoryModelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "test-model",
};
