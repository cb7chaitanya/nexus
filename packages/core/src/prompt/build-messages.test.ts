import { describe, expect, it } from "vitest";

import { buildChatMessages } from "./build-messages.js";

describe("buildChatMessages", () => {
  it("builds a system + user message with no history", () => {
    const messages = buildChatMessages("[[chunk:c1]] some context", "What is X?");

    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("system");
    expect(messages[1]!.role).toBe("user");
    expect(messages[1]!.content).toContain("<context>\n[[chunk:c1]] some context\n</context>");
    expect(messages[1]!.content).toContain("<question>\nWhat is X?\n</question>");
  });

  it("never interpolates context or question into the system prompt", () => {
    const messages = buildChatMessages("malicious context text", "malicious question text");
    expect(messages[0]!.content).not.toContain("malicious context text");
    expect(messages[0]!.content).not.toContain("malicious question text");
  });

  it("inserts prior turns between the system prompt and the final user message, in order", () => {
    const history = [
      { role: "user" as const, content: "first question" },
      { role: "assistant" as const, content: "first answer" },
    ];

    const messages = buildChatMessages("context", "second question", history);

    expect(messages).toHaveLength(4);
    expect(messages[1]).toEqual(history[0]);
    expect(messages[2]).toEqual(history[1]);
    expect(messages[3]!.role).toBe("user");
    expect(messages[3]!.content).toContain("second question");
  });

  it("defaults to no history when omitted", () => {
    const withDefault = buildChatMessages("c", "q");
    const withExplicitEmpty = buildChatMessages("c", "q", []);
    expect(withDefault).toEqual(withExplicitEmpty);
  });
});
