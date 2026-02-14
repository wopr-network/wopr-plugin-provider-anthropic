import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// We test the AnthropicClient constructor's env var behavior by importing
// the class and checking process.env after construction.

// Mock the @anthropic-ai/claude-agent-sdk module before importing our code
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  unstable_v2_createSession: vi.fn(),
  unstable_v2_resumeSession: vi.fn(),
}));

// Mock winston to suppress log output
vi.mock("winston", () => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    default: {
      createLogger: () => mockLogger,
      format: {
        combine: vi.fn(),
        timestamp: vi.fn(),
        errors: vi.fn(),
        json: vi.fn(),
      },
      transports: {
        Console: vi.fn(),
      },
    },
  };
});

// Mock fs to prevent real file reads
vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => "{}"),
}));

// Import after mocks are set up
const { AnthropicClient } = await import("../index.js");

describe("AnthropicClient hosted mode", () => {
  let savedBaseUrl: string | undefined;
  let savedApiKey: string | undefined;

  beforeEach(() => {
    // Save original env
    savedBaseUrl = process.env.ANTHROPIC_BASE_URL;
    savedApiKey = process.env.ANTHROPIC_API_KEY;
    // Clear env
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    // Restore original env
    if (savedBaseUrl !== undefined) {
      process.env.ANTHROPIC_BASE_URL = savedBaseUrl;
    } else {
      delete process.env.ANTHROPIC_BASE_URL;
    }
    if (savedApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = savedApiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("sets ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY when baseUrl and tenantToken are provided", () => {
    const gatewayUrl = "https://api.wopr.bot/v1/anthropic";
    const token = "wopr-tenant-token-abc123";

    new AnthropicClient("", {
      baseUrl: gatewayUrl,
      tenantToken: token,
    });

    expect(process.env.ANTHROPIC_BASE_URL).toBe(gatewayUrl);
    expect(process.env.ANTHROPIC_API_KEY).toBe(token);
  });

  it("does NOT set ANTHROPIC_BASE_URL when baseUrl is not provided (BYOK)", () => {
    const apiKey = "sk-ant-test-key-123";

    new AnthropicClient(apiKey);

    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBe(apiKey);
  });

  it("uses tenantToken as apiKey in hosted mode, not the credential", () => {
    const gatewayUrl = "https://api.wopr.bot/v1/anthropic";
    const tenantToken = "wopr-tenant-token-xyz";
    const byokKey = "sk-ant-should-not-be-used";

    new AnthropicClient(byokKey, {
      baseUrl: gatewayUrl,
      tenantToken: tenantToken,
    });

    // tenantToken should be used, not the credential
    expect(process.env.ANTHROPIC_API_KEY).toBe(tenantToken);
    expect(process.env.ANTHROPIC_BASE_URL).toBe(gatewayUrl);
  });

  it("clears ANTHROPIC_BASE_URL when switching from hosted to BYOK", () => {
    // First, create a hosted client
    new AnthropicClient("", {
      baseUrl: "https://api.wopr.bot/v1/anthropic",
      tenantToken: "token",
    });
    expect(process.env.ANTHROPIC_BASE_URL).toBe("https://api.wopr.bot/v1/anthropic");

    // Then create a BYOK client - should clear the base URL
    new AnthropicClient("sk-ant-byok-key");
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-byok-key");
  });

  it("requires both baseUrl and tenantToken for hosted mode", () => {
    // baseUrl without tenantToken -> falls through to normal auth
    new AnthropicClient("", { baseUrl: "https://api.wopr.bot/v1/anthropic" });
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();

    // tenantToken without baseUrl -> falls through to normal auth
    delete process.env.ANTHROPIC_API_KEY;
    new AnthropicClient("", { tenantToken: "token-only" });
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
  });
});
