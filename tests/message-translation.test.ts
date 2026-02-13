import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture query calls to verify how messages are translated
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
    readFileSync: vi.fn(() => "{}"),
  };
});

describe("message translation (WOPR -> Anthropic SDK)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("translates a basic prompt into the SDK query format", async () => {
    // Mock query to yield a single assistant response
    mockQuery.mockImplementation(({ prompt, options }: { prompt: string; options: Record<string, unknown> }) => {
      // Return an async iterable
      return (async function* () {
        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Hello from Claude" }],
          },
        };
      })();
    });

    const { AnthropicClient } = await import("../index.js");
    const client = new AnthropicClient("sk-ant-test-key-12345");

    const chunks: unknown[] = [];
    for await (const chunk of client.query({ prompt: "Hello" })) {
      chunks.push(chunk);
    }

    // Verify query was called with correct SDK format
    expect(mockQuery).toHaveBeenCalledOnce();
    const call = mockQuery.mock.calls[0][0];
    expect(call.prompt).toBe("Hello");
    expect(call.options).toMatchObject({
      max_tokens: 4096, // default
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    });

    // Verify response was yielded through
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Hello from Claude" }],
      },
    });
  });

  it("passes system prompt to SDK options", async () => {
    mockQuery.mockImplementation(() => {
      return (async function* () {
        yield { type: "assistant", message: { content: [{ type: "text", text: "OK" }] } };
      })();
    });

    const { AnthropicClient } = await import("../index.js");
    const client = new AnthropicClient("sk-ant-test-key-12345");

    for await (const _ of client.query({
      prompt: "Test",
      systemPrompt: "You are a helpful assistant",
    })) {
      // consume
    }

    const call = mockQuery.mock.calls[0][0];
    expect(call.options.systemPrompt).toBe("You are a helpful assistant");
  });

  it("passes model selection to SDK options", async () => {
    mockQuery.mockImplementation(() => {
      return (async function* () {
        yield { type: "assistant", message: { content: [{ type: "text", text: "OK" }] } };
      })();
    });

    const { AnthropicClient } = await import("../index.js");
    const client = new AnthropicClient("sk-ant-test-key-12345");

    for await (const _ of client.query({
      prompt: "Test",
      model: "claude-haiku-4-5-20251001",
    })) {
      // consume
    }

    const call = mockQuery.mock.calls[0][0];
    expect(call.options.model).toBe("claude-haiku-4-5-20251001");
  });

  it("passes temperature and topP to SDK options", async () => {
    mockQuery.mockImplementation(() => {
      return (async function* () {
        yield { type: "assistant", message: { content: [{ type: "text", text: "OK" }] } };
      })();
    });

    const { AnthropicClient } = await import("../index.js");
    const client = new AnthropicClient("sk-ant-test-key-12345");

    for await (const _ of client.query({
      prompt: "Test",
      temperature: 0.7,
      topP: 0.9,
    })) {
      // consume
    }

    const call = mockQuery.mock.calls[0][0];
    expect(call.options.temperature).toBe(0.7);
    expect(call.options.topP).toBe(0.9);
  });

  it("passes maxTokens to SDK options", async () => {
    mockQuery.mockImplementation(() => {
      return (async function* () {
        yield { type: "assistant", message: { content: [{ type: "text", text: "OK" }] } };
      })();
    });

    const { AnthropicClient } = await import("../index.js");
    const client = new AnthropicClient("sk-ant-test-key-12345");

    for await (const _ of client.query({
      prompt: "Test",
      maxTokens: 8192,
    })) {
      // consume
    }

    const call = mockQuery.mock.calls[0][0];
    expect(call.options.max_tokens).toBe(8192);
  });

  it("passes resume session ID to SDK options", async () => {
    mockQuery.mockImplementation(() => {
      return (async function* () {
        yield {
          type: "assistant",
          session_id: "sess_abc123",
          message: { content: [{ type: "text", text: "Resumed" }] },
        };
      })();
    });

    const { AnthropicClient } = await import("../index.js");
    const client = new AnthropicClient("sk-ant-test-key-12345");

    for await (const _ of client.query({
      prompt: "Continue",
      resume: "sess_abc123",
    })) {
      // consume
    }

    const call = mockQuery.mock.calls[0][0];
    expect(call.options.resume).toBe("sess_abc123");
  });

  it("wraps SDK errors in a descriptive error", async () => {
    mockQuery.mockImplementation(() => {
      return (async function* () {
        throw new Error("Rate limit exceeded");
      })();
    });

    const { AnthropicClient } = await import("../index.js");
    const client = new AnthropicClient("sk-ant-test-key-12345");

    await expect(async () => {
      for await (const _ of client.query({ prompt: "Test" })) {
        // consume
      }
    }).rejects.toThrow("Anthropic query failed: Rate limit exceeded");
  });

  it("passes MCP servers config to SDK options", async () => {
    mockQuery.mockImplementation(() => {
      return (async function* () {
        yield { type: "assistant", message: { content: [{ type: "text", text: "OK" }] } };
      })();
    });

    const { AnthropicClient } = await import("../index.js");
    const client = new AnthropicClient("sk-ant-test-key-12345");

    const mcpServers = { "test-server": { command: "npx", args: ["test"] } };
    for await (const _ of client.query({
      prompt: "Test",
      mcpServers,
    })) {
      // consume
    }

    const call = mockQuery.mock.calls[0][0];
    expect(call.options.mcpServers).toEqual(mcpServers);
  });

  it("passes structured output responseFormat as outputFormat to SDK", async () => {
    mockQuery.mockImplementation(() => {
      return (async function* () {
        yield { type: "assistant", message: { content: [{ type: "text", text: '{"name":"test"}' }] } };
      })();
    });

    const { AnthropicClient } = await import("../index.js");
    const client = new AnthropicClient("sk-ant-test-key-12345");

    const responseFormat = {
      type: "json_schema" as const,
      schema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    };

    for await (const _ of client.query({
      prompt: "Test",
      responseFormat,
    })) {
      // consume
    }

    const call = mockQuery.mock.calls[0][0];
    // responseFormat maps to outputFormat in the SDK
    expect(call.options.outputFormat).toEqual(responseFormat);
  });
});
