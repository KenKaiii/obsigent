import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  Modal: class Modal {},
  Notice: class Notice {},
}));

import { LocalAgentRuntime } from "./local-agent";
import { DEFAULT_SETTINGS } from "./settings";

class TestRuntime extends LocalAgentRuntime {
  public calls = 0;

  protected override async runPrompt(): Promise<string> {
    this.calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return "ok";
  }
}

describe("LocalAgentRuntime", () => {
  it("deduplicates concurrent prompts", async () => {
    const runtime = new TestRuntime();
    const options = {
      app: {} as never,
      settings: { ...DEFAULT_SETTINGS, debug: true },
      onUpdate: () => undefined,
      runId: "test-run",
    };

    const [first, second, third] = await Promise.all([
      runtime.prompt("hi", options),
      runtime.prompt("hi", options),
      runtime.prompt("hi", options),
    ]);

    expect(first).toBe("ok");
    expect(second).toBe("ok");
    expect(third).toBe("ok");
    expect(runtime.calls).toBe(1);
  });
});
