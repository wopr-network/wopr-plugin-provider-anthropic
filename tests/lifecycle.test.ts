import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the SDK before importing plugin
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  unstable_v2_createSession: vi.fn(),
  unstable_v2_resumeSession: vi.fn(),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
  };
});

describe("plugin lifecycle hooks", () => {
  let plugin: any;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../src/index.js");
    plugin = mod.default;
  });

  it("exports onActivate", () => {
    expect(typeof plugin.onActivate).toBe("function");
  });

  it("exports onDeactivate", () => {
    expect(typeof plugin.onDeactivate).toBe("function");
  });

  it("exports onDrain", () => {
    expect(typeof plugin.onDrain).toBe("function");
  });

  it("onDeactivate does not throw", async () => {
    await expect(plugin.onDeactivate()).resolves.not.toThrow();
  });

  it("onDrain completes when no active sessions", async () => {
    await expect(plugin.onDrain()).resolves.not.toThrow();
  });
});
