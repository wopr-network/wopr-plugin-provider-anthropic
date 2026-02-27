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

describe("programmatic tool calling configuration", () => {
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

  it("passes programmatic tool calling config to SDK options", async () => {
    const { AnthropicClient } = await import("../src/index.js");
    const client = new AnthropicClient("sk-ant-test-key-12345");

    for await (const _ of client.query({
      prompt: "Query all regions",
      programmaticToolCalling: {},
    })) {
      // consume
    }

    const call = mockQuery.mock.calls[0][0];
    expect(call.options.programmaticToolCalling).toEqual({});
  });

  it("passes container ID for container reuse", async () => {
    const { AnthropicClient } = await import("../src/index.js");
    const client = new AnthropicClient("sk-ant-test-key-12345");

    for await (const _ of client.query({
      prompt: "Continue processing",
      programmaticToolCalling: { containerId: "container_xyz789" },
    })) {
      // consume
    }

    const call = mockQuery.mock.calls[0][0];
    expect(call.options.programmaticToolCalling).toEqual({
      containerId: "container_xyz789",
    });
    expect(call.options.container).toBe("container_xyz789");
  });

  it("does not include programmaticToolCalling in SDK options when not specified", async () => {
    const { AnthropicClient } = await import("../src/index.js");
    const client = new AnthropicClient("sk-ant-test-key-12345");

    for await (const _ of client.query({ prompt: "Hello" })) {
      // consume
    }

    const call = mockQuery.mock.calls[0][0];
    expect(call.options.programmaticToolCalling).toBeUndefined();
    expect(call.options.container).toBeUndefined();
  });

  it("combines tool search and programmatic tool calling", async () => {
    const { AnthropicClient } = await import("../src/index.js");
    const client = new AnthropicClient("sk-ant-test-key-12345");

    for await (const _ of client.query({
      prompt: "Complex multi-tool workflow",
      toolSearch: { variant: "regex" },
      programmaticToolCalling: { containerId: "container_abc123" },
    })) {
      // consume
    }

    const call = mockQuery.mock.calls[0][0];
    expect(call.options.toolSearch).toEqual({ variant: "regex" });
    expect(call.options.programmaticToolCalling).toEqual({
      containerId: "container_abc123",
    });
    expect(call.options.container).toBe("container_abc123");
  });

  it("combines with existing options (thinking, effort, betas)", async () => {
    const { AnthropicClient } = await import("../src/index.js");
    const client = new AnthropicClient("sk-ant-test-key-12345");

    for await (const _ of client.query({
      prompt: "Full options test",
      thinking: { type: "adaptive" },
      effort: "high",
      betas: ["context-1m-2025-08-07"],
      toolSearch: { variant: "bm25" },
      programmaticToolCalling: {},
    })) {
      // consume
    }

    const call = mockQuery.mock.calls[0][0];
    expect(call.options.thinking).toEqual({ type: "adaptive" });
    expect(call.options.effort).toBe("high");
    expect(call.options.betas).toEqual(["context-1m-2025-08-07"]);
    expect(call.options.toolSearch).toEqual({ variant: "bm25" });
    expect(call.options.programmaticToolCalling).toEqual({});
  });
});
