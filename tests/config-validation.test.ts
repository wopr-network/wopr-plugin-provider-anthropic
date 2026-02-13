import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the SDK
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  unstable_v2_createSession: vi.fn(),
  unstable_v2_resumeSession: vi.fn(),
}));

// Mock fs to control credential detection
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => "{}"),
  };
});

describe("config validation", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    // Stub fetch to prevent real network calls from discoverModels()
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network disabled in tests"));
    // Clear env vars that could affect auth detection
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.CLAUDE_CODE_USE_VERTEX;
    delete process.env.CLAUDE_CODE_USE_FOUNDRY;
    delete process.env.AWS_REGION;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.CLOUD_ML_REGION;
    delete process.env.ANTHROPIC_VERTEX_PROJECT_ID;
    delete process.env.ANTHROPIC_FOUNDRY_RESOURCE;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("API key format validation", () => {
    it("rejects keys that do not start with sk-ant-", async () => {
      const { default: plugin } = await import("../index.js");

      const ctx = {
        log: { info: vi.fn(), warn: vi.fn() },
        registerProvider: vi.fn(),
        registerConfigSchema: vi.fn(),
      };
      await plugin.init(ctx);

      const provider = ctx.registerProvider.mock.calls[0][0] as {
        validateCredentials: (cred: string) => Promise<boolean>;
      };

      // Invalid prefixes
      expect(await provider.validateCredentials("sk-invalid-key")).toBe(false);
      expect(await provider.validateCredentials("Bearer token123")).toBe(false);
      expect(await provider.validateCredentials("random-string")).toBe(false);
    });

    it("accepts empty credential when OAuth/env auth is available", async () => {
      // Simulate OAuth credentials being present
      const fs = await import("fs");
      (fs.existsSync as ReturnType<typeof vi.fn>).mockImplementation(
        (path: string) => path.includes(".credentials.json")
      );
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "test-token",
            refreshToken: "test-refresh",
            expiresAt: Date.now() + 3600000,
            email: "test@example.com",
          },
        })
      );

      // Re-import to pick up new mock behavior
      vi.resetModules();
      vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
        query: vi.fn(),
        unstable_v2_createSession: vi.fn(),
        unstable_v2_resumeSession: vi.fn(),
      }));

      const { default: plugin } = await import("../index.js");
      const ctx = {
        log: { info: vi.fn(), warn: vi.fn() },
        registerProvider: vi.fn(),
        registerConfigSchema: vi.fn(),
      };
      await plugin.init(ctx);

      const provider = ctx.registerProvider.mock.calls[0][0] as {
        validateCredentials: (cred: string) => Promise<boolean>;
      };

      // Empty credential should be valid when OAuth is available
      expect(await provider.validateCredentials("")).toBe(true);
    });
  });

  describe("model selection", () => {
    it("has fallback model list with expected models", async () => {
      const { default: plugin } = await import("../index.js");

      const ctx = {
        log: { info: vi.fn(), warn: vi.fn() },
        registerProvider: vi.fn(),
        registerConfigSchema: vi.fn(),
      };
      await plugin.init(ctx);

      const provider = ctx.registerProvider.mock.calls[0][0] as {
        defaultModel: string;
        supportedModels: string[];
      };

      // Default model should be set
      expect(provider.defaultModel).toBeTypeOf("string");
      expect(provider.defaultModel.length).toBeGreaterThan(0);

      // Supported models should include known model IDs
      expect(provider.supportedModels).toBeInstanceOf(Array);
      expect(provider.supportedModels.length).toBeGreaterThan(0);

      // All model IDs should be strings starting with "claude-"
      for (const modelId of provider.supportedModels) {
        expect(modelId).toMatch(/^claude-/);
      }
    });

    it("includes opus, sonnet, and haiku variants", async () => {
      const { default: plugin } = await import("../index.js");

      const ctx = {
        log: { info: vi.fn(), warn: vi.fn() },
        registerProvider: vi.fn(),
        registerConfigSchema: vi.fn(),
      };
      await plugin.init(ctx);

      const provider = ctx.registerProvider.mock.calls[0][0] as {
        supportedModels: string[];
      };

      const models = provider.supportedModels;
      expect(models.some((m: string) => m.includes("opus"))).toBe(true);
      expect(models.some((m: string) => m.includes("sonnet"))).toBe(true);
      expect(models.some((m: string) => m.includes("haiku"))).toBe(true);
    });
  });

  describe("config schema", () => {
    it("registers config schema with auth method and API key fields", async () => {
      const { default: plugin } = await import("../index.js");

      const ctx = {
        log: { info: vi.fn(), warn: vi.fn() },
        registerProvider: vi.fn(),
        registerConfigSchema: vi.fn(),
      };
      await plugin.init(ctx);

      expect(ctx.registerConfigSchema).toHaveBeenCalledWith(
        "provider-anthropic",
        expect.objectContaining({
          title: "Anthropic Claude",
          description: expect.any(String),
          fields: expect.arrayContaining([
            expect.objectContaining({
              name: "authMethod",
              type: "select",
            }),
            expect.objectContaining({
              name: "apiKey",
              type: "password",
            }),
          ]),
        })
      );
    });

    it("auth method options include oauth and api-key", async () => {
      const { default: plugin } = await import("../index.js");

      const ctx = {
        log: { info: vi.fn(), warn: vi.fn() },
        registerProvider: vi.fn(),
        registerConfigSchema: vi.fn(),
      };
      await plugin.init(ctx);

      const schema = ctx.registerConfigSchema.mock.calls[0][1] as {
        fields: Array<{
          name: string;
          options?: Array<{ value: string; label: string }>;
        }>;
      };

      const authMethodField = schema.fields.find(
        (f) => f.name === "authMethod"
      );
      expect(authMethodField).toBeDefined();
      expect(authMethodField!.options).toBeDefined();

      const optionValues = authMethodField!.options!.map((o) => o.value);
      expect(optionValues).toContain("oauth");
      expect(optionValues).toContain("api-key");
    });
  });

  describe("credential type detection", () => {
    it("returns oauth when Claude Code credentials exist", async () => {
      const fs = await import("fs");
      (fs.existsSync as ReturnType<typeof vi.fn>).mockImplementation(
        (path: string) => path.includes(".credentials.json")
      );
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "test-token",
            refreshToken: "test-refresh",
            expiresAt: Date.now() + 3600000,
          },
        })
      );

      vi.resetModules();
      vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
        query: vi.fn(),
        unstable_v2_createSession: vi.fn(),
        unstable_v2_resumeSession: vi.fn(),
      }));

      const { default: plugin } = await import("../index.js");
      const ctx = {
        log: { info: vi.fn(), warn: vi.fn() },
        registerProvider: vi.fn(),
        registerConfigSchema: vi.fn(),
      };
      await plugin.init(ctx);

      const provider = ctx.registerProvider.mock.calls[0][0] as {
        getCredentialType: () => string;
      };

      expect(provider.getCredentialType()).toBe("oauth");
    });

    it("getActiveAuthMethod returns none when no credentials exist", async () => {
      const fs = await import("fs");
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

      vi.resetModules();
      vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
        query: vi.fn(),
        unstable_v2_createSession: vi.fn(),
        unstable_v2_resumeSession: vi.fn(),
      }));

      const { default: plugin } = await import("../index.js");
      const ctx = {
        log: { info: vi.fn(), warn: vi.fn() },
        registerProvider: vi.fn(),
        registerConfigSchema: vi.fn(),
      };
      await plugin.init(ctx);

      const provider = ctx.registerProvider.mock.calls[0][0] as {
        getActiveAuthMethod: () => string;
      };

      expect(provider.getActiveAuthMethod()).toBe("none");
    });
  });
});
