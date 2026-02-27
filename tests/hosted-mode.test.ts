import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We test the AnthropicClient constructor's env override behavior by importing
// the class and checking that process.env is NOT mutated, and that the
// instance-level env overrides are correct.

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
  readFileSync: vi.fn((path: unknown) =>
    path && String(path).endsWith("package.json")
      ? JSON.stringify({ name: "@wopr-network/wopr-plugin-provider-anthropic", version: "2.3.0" })
      : "{}",
  ),
}));

// Import after mocks are set up
const { AnthropicClient } = await import("../src/index.js");

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

  it("stores env overrides for hosted mode without mutating process.env", () => {
    const gatewayUrl = "https://api.wopr.bot/v1/anthropic";
    const token = "wopr-tenant-token-abc123";

    const client = new AnthropicClient("", {
      baseUrl: gatewayUrl,
      tenantToken: token,
    });

    // process.env should NOT be mutated
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();

    // buildEnv() should return merged env with overrides
    const env = (client as any).buildEnv();
    expect(env.ANTHROPIC_BASE_URL).toBe(gatewayUrl);
    expect(env.ANTHROPIC_API_KEY).toBe(token);
  });

  it("stores env overrides for BYOK without mutating process.env", () => {
    const apiKey = "sk-ant-test-key-123";

    const client = new AnthropicClient(apiKey);

    // process.env should NOT be mutated
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();

    // buildEnv() should return merged env with overrides
    const env = (client as any).buildEnv();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe(apiKey);
  });

  it("uses tenantToken as apiKey in hosted mode, not the credential", () => {
    const gatewayUrl = "https://api.wopr.bot/v1/anthropic";
    const tenantToken = "wopr-tenant-token-xyz";
    const byokKey = "sk-ant-should-not-be-used";

    const client = new AnthropicClient(byokKey, {
      baseUrl: gatewayUrl,
      tenantToken: tenantToken,
    });

    // tenantToken should be used, not the credential
    const env = (client as any).buildEnv();
    expect(env.ANTHROPIC_API_KEY).toBe(tenantToken);
    expect(env.ANTHROPIC_BASE_URL).toBe(gatewayUrl);
  });

  it("multiple instances do not clobber each other's env overrides", () => {
    const hostedClient = new AnthropicClient("", {
      baseUrl: "https://api.wopr.bot/v1/anthropic",
      tenantToken: "hosted-token",
    });

    const byokClient = new AnthropicClient("sk-ant-byok-key");

    // Each instance should have its own env overrides
    const hostedEnv = (hostedClient as any).buildEnv();
    expect(hostedEnv.ANTHROPIC_BASE_URL).toBe("https://api.wopr.bot/v1/anthropic");
    expect(hostedEnv.ANTHROPIC_API_KEY).toBe("hosted-token");

    const byokEnv = (byokClient as any).buildEnv();
    expect(byokEnv.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(byokEnv.ANTHROPIC_API_KEY).toBe("sk-ant-byok-key");

    // process.env should NOT be mutated by either
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("requires both baseUrl and tenantToken for hosted mode", () => {
    // baseUrl without tenantToken -> falls through to normal auth
    const client1 = new AnthropicClient("", {
      baseUrl: "https://api.wopr.bot/v1/anthropic",
    });
    const env1 = (client1 as any).buildEnv();
    expect(env1.ANTHROPIC_BASE_URL).toBeUndefined();

    // tenantToken without baseUrl -> falls through to normal auth
    const client2 = new AnthropicClient("", { tenantToken: "token-only" });
    const env2 = (client2 as any).buildEnv();
    expect(env2.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("rejects non-HTTPS baseUrl", () => {
    expect(
      () =>
        new AnthropicClient("", {
          baseUrl: "http://evil.example.com/v1",
          tenantToken: "token",
        }),
    ).toThrow("Hosted mode baseUrl must use HTTPS");
  });

  it("rejects invalid baseUrl", () => {
    expect(
      () =>
        new AnthropicClient("", {
          baseUrl: "not-a-url",
          tenantToken: "token",
        }),
    ).toThrow("Invalid hosted mode baseUrl");
  });
});
