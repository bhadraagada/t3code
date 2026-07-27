import { describe, expect, it } from "vite-plus/test";

import {
  localHistoryImportWatermark,
  localHistoryMessageFingerprint,
  selectNewLocalHistoryMessages,
} from "./incrementalImport.ts";

describe("incrementalImport", () => {
  it("normalizes CRLF and surrounding whitespace when fingerprinting", () => {
    expect(localHistoryMessageFingerprint({ role: "user", text: "  hello\r\nworld \n" })).toBe(
      localHistoryMessageFingerprint({ role: "user", text: "hello\nworld" }),
    );
    expect(localHistoryMessageFingerprint({ role: "user", text: "hello" })).not.toBe(
      localHistoryMessageFingerprint({ role: "assistant", text: "hello" }),
    );
  });

  it("selects only candidate messages beyond the existing multiset", () => {
    const existing = [
      { role: "user", text: "first question" },
      { role: "assistant", text: "First answer." },
    ];
    const candidates = [
      { role: "user", text: "first question" },
      { role: "assistant", text: "First answer." },
      { role: "user", text: "second question" },
    ];

    const delta = selectNewLocalHistoryMessages(existing, candidates);
    expect(delta).toHaveLength(1);
    expect(delta[0]?.message.text).toBe("second question");
    expect(delta[0]?.occurrence).toBe(0);

    expect(selectNewLocalHistoryMessages(candidates, candidates)).toHaveLength(0);
  });

  it("keeps repeated identical messages distinguishable by occurrence", () => {
    const existing = [
      { role: "user", text: "yes" },
      { role: "assistant", text: "Done." },
    ];
    const candidates = [
      { role: "user", text: "yes" },
      { role: "assistant", text: "Done." },
      { role: "user", text: "yes" },
      { role: "user", text: "yes" },
    ];

    const delta = selectNewLocalHistoryMessages(existing, candidates);
    expect(delta).toHaveLength(2);
    expect(delta.map((entry) => entry.occurrence)).toEqual([1, 2]);
    expect(delta.every((entry) => entry.message.text === "yes")).toBe(true);
  });

  it("watermark is stable for unchanged sources and moves when the source grows", () => {
    const messages = [
      { role: "user", text: "first question" },
      { role: "assistant", text: "First answer." },
    ];
    expect(localHistoryImportWatermark(messages)).toBe(localHistoryImportWatermark([...messages]));
    expect(localHistoryImportWatermark(messages)).not.toBe(
      localHistoryImportWatermark([...messages, { role: "user", text: "second question" }]),
    );
    // Boundary shifts between adjacent messages must not collide.
    expect(
      localHistoryImportWatermark([
        { role: "user", text: "ab" },
        { role: "user", text: "c" },
      ]),
    ).not.toBe(
      localHistoryImportWatermark([
        { role: "user", text: "a" },
        { role: "user", text: "bc" },
      ]),
    );
  });
});
