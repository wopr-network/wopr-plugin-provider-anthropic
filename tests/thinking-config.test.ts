import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.fn();

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQuery,
  unstable_v2_createSession: vi.fn(),
  unstable_v2_resumeSession: vi.fn(),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn((path: unknown) =>
      path && String(path).endsWith("package.json")
        ? JSON.stringify({ name: "@wopr-network/wopr-plugin-provider-anthropic", version: "2.3.0" })
        : "{}",
    ),
  };
});

describe("extended thinking configuration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ANTHROPIC_API_KEY;
    mockQuery.mockImplementation(() => {
      return (async function* () {
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "OK" }] },
        };
      })();
    });
  });

  it("passes adaptive thinking config to SDK", async () => {
    const { AnthropicClient } = await import("../src/index.js");
    const client = new AnthropicClient("sk-ant-test-key-12345");

    for await (const _ of client.query({
      prompt: "Solve this complex problem",
      thinking: { type: "adaptive" },
    })) {
      // consume
    }

    const call = mockQuery.mock.calls[0][0];
    expect(call.options.thinking).toEqual({ type: "adaptive" });
  });

  it("passes enabled thinking with budget tokens to SDK", async () => {
    const { AnthropicClient } = await import("../src/index.js");
    const client = new AnthropicClient("sk-ant-test-key-12345");

    for await (const _ of client.query({
      prompt: "Deep analysis needed",
      thinking: { type: "enabled", budgetTokens: 10000 },
    })) {
      // consume
    }

    const call = mockQuery.mock.calls[0][0];
    expect(call.options.thinking).toEqual({
      type: "enabled",
      budgetTokens: 10000,
    });
  });

  it("passes disabled thinking config to SDK", async () => {
    const { AnthropicClient } = await import("../src/index.js");
    const client = new AnthropicClient("sk-ant-test-key-12345");

    for await (const _ of client.query({
      prompt: "Quick response please",
      thinking: { type: "disabled" },
    })) {
      // consume
    }

    const call = mockQuery.mock.calls[0][0];
    expect(call.options.thinking).toEqual({ type: "disabled" });
  });

  it("does not include thinking in SDK options when not specified", async () => {
    const { AnthropicClient } = await import("../src/index.js");
    const client = new AnthropicClient("sk-ant-test-key-12345");

    for await (const _ of client.query({ prompt: "Hello" })) {
      // consume
    }

    const call = mockQuery.mock.calls[0][0];
    expect(call.options.thinking).toBeUndefined();
  });

  it("passes effort level to SDK options", async () => {
    const { AnthropicClient } = await import("../src/index.js");
    const client = new AnthropicClient("sk-ant-test-key-12345");

    for await (const _ of client.query({
      prompt: "Complex task",
      effort: "high",
    })) {
      // consume
    }

    const call = mockQuery.mock.calls[0][0];
    expect(call.options.effort).toBe("high");
  });

  it("passes effort + adaptive thinking together", async () => {
    const { AnthropicClient } = await import("../src/index.js");
    const client = new AnthropicClient("sk-ant-test-key-12345");

    for await (const _ of client.query({
      prompt: "Very complex task",
      thinking: { type: "adaptive" },
      effort: "max",
    })) {
      // consume
    }

    const call = mockQuery.mock.calls[0][0];
    expect(call.options.thinking).toEqual({ type: "adaptive" });
    expect(call.options.effort).toBe("max");
  });

  it("passes betas array to SDK options", async () => {
    const { AnthropicClient } = await import("../src/index.js");
    const client = new AnthropicClient("sk-ant-test-key-12345");

    for await (const _ of client.query({
      prompt: "Large context test",
      betas: ["context-1m-2025-08-07"],
    })) {
      // consume
    }

    const call = mockQuery.mock.calls[0][0];
    expect(call.options.betas).toEqual(["context-1m-2025-08-07"]);
  });

  it("combines thinking, effort, betas, and responseFormat options", async () => {
    const { AnthropicClient } = await import("../src/index.js");
    const client = new AnthropicClient("sk-ant-test-key-12345");

    const responseFormat = {
      type: "json_schema" as const,
      schema: { type: "object", properties: { answer: { type: "string" } } },
    };

    for await (const _ of client.query({
      prompt: "Full options test",
      thinking: { type: "enabled", budgetTokens: 5000 },
      effort: "high",
      betas: ["context-1m-2025-08-07"],
      responseFormat,
      model: "claude-opus-4-6",
      maxTokens: 16384,
      temperature: 0.5,
    })) {
      // consume
    }

    const call = mockQuery.mock.calls[0][0];
    expect(call.options.thinking).toEqual({
      type: "enabled",
      budgetTokens: 5000,
    });
    expect(call.options.effort).toBe("high");
    expect(call.options.betas).toEqual(["context-1m-2025-08-07"]);
    expect(call.options.outputFormat).toEqual(responseFormat);
    expect(call.options.model).toBe("claude-opus-4-6");
    expect(call.options.max_tokens).toBe(16384);
    expect(call.options.temperature).toBe(0.5);
  });
});
