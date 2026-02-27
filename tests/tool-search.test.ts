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
        ? JSON.stringify({ name: "@wopr-network/wopr-plugin-provider-anthropic", version: "2.4.0" })
        : "{}",
    ),
  };
});

describe("tool search configuration", () => {
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

  it("passes regex tool search config to SDK options", async () => {
    const { AnthropicClient } = await import("../src/index.js");
    const client = new AnthropicClient("sk-ant-test-key-12345");

    for await (const _ of client.query({
      prompt: "Find weather tools",
      toolSearch: { variant: "regex" },
    })) {
      // consume
    }

    const call = mockQuery.mock.calls[0][0];
    expect(call.options.toolSearch).toEqual({ variant: "regex" });
  });

  it("passes bm25 tool search config to SDK options", async () => {
    const { AnthropicClient } = await import("../src/index.js");
    const client = new AnthropicClient("sk-ant-test-key-12345");

    for await (const _ of client.query({
      prompt: "Find database tools",
      toolSearch: { variant: "bm25" },
    })) {
      // consume
    }

    const call = mockQuery.mock.calls[0][0];
    expect(call.options.toolSearch).toEqual({ variant: "bm25" });
  });

  it("does not include toolSearch in SDK options when not specified", async () => {
    const { AnthropicClient } = await import("../src/index.js");
    const client = new AnthropicClient("sk-ant-test-key-12345");

    for await (const _ of client.query({ prompt: "Hello" })) {
      // consume
    }

    const call = mockQuery.mock.calls[0][0];
    expect(call.options.toolSearch).toBeUndefined();
  });
});
