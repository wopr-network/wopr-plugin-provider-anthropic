import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the SDK before importing the plugin
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  unstable_v2_createSession: vi.fn(),
  unstable_v2_resumeSession: vi.fn(),
}));

// Mock fs to avoid reading real credential files
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

describe("plugin registration smoke test", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    // Stub fetch to prevent real network calls from discoverModels()
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network disabled in tests"));
    // Clear env vars that could trigger cloud auth detection
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

  it("exports a valid WOPR plugin object", async () => {
    const { default: plugin } = await import("../src/index.js");

    expect(plugin).toBeDefined();
    expect(plugin.name).toBe("provider-anthropic");
    // Assert semver format rather than hardcoding a version
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(plugin.description).toBeTypeOf("string");
    expect(plugin.description.length).toBeGreaterThan(0);
    expect(plugin.init).toBeTypeOf("function");
    expect(plugin.shutdown).toBeTypeOf("function");
  });

  it("includes a valid PluginManifest", async () => {
    const { default: plugin } = await import("../src/index.js");

    expect(plugin.manifest).toBeDefined();
    const m = plugin.manifest!;
    expect(m.name).toBe("@wopr-network/wopr-plugin-provider-anthropic");
    expect(m.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(m.description).toBeTypeOf("string");
    expect(m.capabilities).toContain("provider");
    expect(m.category).toBe("ai-provider");
    expect(m.requires?.network?.outbound).toBe(true);
    expect(m.configSchema).toBeDefined();
    expect(m.configSchema!.fields.length).toBeGreaterThan(0);
    expect(m.lifecycle?.shutdownBehavior).toBe("graceful");
  });

  it("init registers a provider and config schema", async () => {
    const { default: plugin } = await import("../src/index.js");

    const registeredProviders: unknown[] = [];
    const registeredSchemas: Array<{ name: string; schema: unknown }> = [];

    const ctx = {
      log: { info: vi.fn(), warn: vi.fn() },
      registerProvider: vi.fn((p: unknown) => registeredProviders.push(p)),
      unregisterProvider: vi.fn(),
      unregisterExtension: vi.fn(),
      unregisterConfigSchema: vi.fn(),
      registerConfigSchema: vi.fn((name: string, schema: unknown) => registeredSchemas.push({ name, schema })),
    };

    await plugin.init(ctx);

    // Provider was registered
    expect(ctx.registerProvider).toHaveBeenCalledOnce();
    expect(registeredProviders).toHaveLength(1);

    const provider = registeredProviders[0] as Record<string, unknown>;
    expect(provider.id).toBe("anthropic");
    expect(provider.name).toBe("Anthropic Claude");
    expect(provider.defaultModel).toBeTypeOf("string");
    expect(Array.isArray(provider.supportedModels)).toBe(true);

    // Config schema was registered
    expect(ctx.registerConfigSchema).toHaveBeenCalledOnce();
    expect(registeredSchemas[0].name).toBe("provider-anthropic");
  });

  it("shutdown completes without errors", async () => {
    const { default: plugin } = await import("../src/index.js");

    await expect(plugin.shutdown()).resolves.toBeUndefined();
  });

  it("exports AnthropicClient and model discovery utilities", async () => {
    const mod = await import("../src/index.js");

    expect(mod.AnthropicClient).toBeTypeOf("function");
    expect(mod.discoverModels).toBeTypeOf("function");
    expect(mod.getModelInfo).toBeTypeOf("function");
  });
});
